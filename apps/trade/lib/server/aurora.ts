import { z } from 'zod';
import { MONAD_DELIVERABLE_ASSETS } from '@tradepro/core';
import { FUND_SOURCES, type FundSource, type SourceKey } from '../fund/sources';

/**
 * The solver network's own view of what it can move, read at runtime.
 *
 * Asset ids are not written down anywhere in this app. `nep141:tron-d28a2659….omft.near`
 * is not something to remember and re-type; it is an identifier the network owns and
 * can change, and a stale copy of it would quote a route that no longer exists. So
 * the list is fetched, cached for five minutes, and matched on (symbol, chain).
 *
 * Rule A2.5 applies here even though there is no ABI: the ids come from the primary
 * source or the source is reported as unavailable. Nothing is guessed.
 */

const ONE_CLICK_TOKENS_URL = 'https://1click.chaindefuser.com/v0/tokens';
const CACHE_MS = 5 * 60_000;

/** The destination is fixed: USDC on Monad, from `@tradepro/core`'s measured list. */
const USDC_ON_MONAD = MONAD_DELIVERABLE_ASSETS.find((a) => a.symbol === 'USDC');

const tokenSchema = z.object({
  assetId: z.string(),
  symbol: z.string(),
  decimals: z.number(),
  blockchain: z.string(),
  contractAddress: z.string().optional(),
});

const tokenListSchema = z.array(tokenSchema);

/** How the token list names each source's chain. */
const CHAIN_ID_FOR: Record<SourceKey, string> = {
  'usdt-tron': 'tron',
  'usdc-base': 'base',
  'sol-solana': 'sol',
  'ausd-base': 'base',
};

export interface ResolvedSource extends FundSource {
  /** Present only when the network currently lists this asset. */
  readonly assetId?: string;
  readonly decimals?: number;
  /** The origin-chain token contract, when the asset is a token rather than the native coin. */
  readonly contractAddress?: string;
  /** Why it cannot be quoted, in the user's words. */
  readonly unavailable?: string;
  /**
   * True when a **real** deposit address can be issued for this source.
   *
   * It is not the same question as "can this be priced". A price can be taken
   * against any valid origin-chain address; an address that money is sent to can
   * only ever be issued against one the user controls, because `refundTo` is where
   * their money goes if the swap fails.
   */
  readonly canIssueAddress: boolean;
  /** What kind of address that would have to be, when the app cannot supply it. */
  readonly needsRefundAddress: boolean;
}

interface Cached {
  readonly at: number;
  readonly tokens: z.infer<typeof tokenListSchema>;
}

let cache: Cached | undefined;

export class RouteListUnavailable extends Error {
  constructor(cause: string) {
    super(cause);
    this.name = 'RouteListUnavailable';
  }
}

async function tokens(): Promise<Cached['tokens']> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.tokens;
  let res: Response;
  try {
    res = await fetch(ONE_CLICK_TOKENS_URL, { signal: AbortSignal.timeout(10_000) });
  } catch (caught) {
    throw new RouteListUnavailable(caught instanceof Error ? caught.message : 'network');
  }
  if (!res.ok) throw new RouteListUnavailable(`token list returned ${res.status}`);
  const parsed = tokenListSchema.parse(await res.json());
  cache = { at: Date.now(), tokens: parsed };
  return parsed;
}

/**
 * The four design sources, each either resolved to a live asset id or carrying the
 * reason it cannot be quoted.
 *
 * AUSD is the interesting one: the network lists it on **no** chain at all, so the
 * "AUSD on Base" tile can never be an Intents route. It exists because AUSD has its
 * own LayerZero bridge, and this says so rather than dropping the tile or, worse,
 * quoting it through a route that would not carry it.
 */
export async function resolveSources(): Promise<readonly ResolvedSource[]> {
  const list = await tokens();
  return FUND_SOURCES.map<ResolvedSource>((source) => {
    if (source.route === 'oft') {
      // Not an Intents route and never will be: the solver network lists AUSD on no
      // chain at all. It has its own LayerZero bridge, which `/api/fund/oft` quotes
      // live against Base. The tile is offered; it just answers a different question.
      return {
        ...source,
        canIssueAddress: false,
        needsRefundAddress: false,
      };
    }
    const chain = CHAIN_ID_FOR[source.key];
    const match = list.find((t) => t.symbol === source.symbol && t.blockchain === chain);
    if (!match) {
      return {
        ...source,
        canIssueAddress: false,
        needsRefundAddress: false,
        unavailable: `The solver network is not currently listing ${source.symbol} on ${source.chain}.`,
      };
    }
    // An EVM origin is the one case where the app already holds the answer: the
    // account that signs on Monad owns the same address on Base. Everywhere else the
    // user has to supply it before an address can be issued.
    const evm = source.refund === 'evm';
    return {
      ...source,
      assetId: match.assetId,
      decimals: match.decimals,
      ...(match.contractAddress ? { contractAddress: match.contractAddress } : {}),
      canIssueAddress: evm,
      needsRefundAddress: !evm,
    };
  });
}

export function destinationAsset(): { assetId: string; symbol: string; decimals: number } {
  if (!USDC_ON_MONAD) {
    // Cannot happen: the list is a const in core. Throwing beats returning a guess.
    throw new Error('no USDC entry in the deliverable asset list');
  }
  return {
    assetId: USDC_ON_MONAD.assetId,
    symbol: USDC_ON_MONAD.symbol,
    decimals: USDC_ON_MONAD.decimals,
  };
}

/**
 * A Tron address used **only** to satisfy the origin-chain check on a priced **dry**
 * quote, and never shown to anyone.
 *
 * 1Click validates `refundTo` before it validates anything else — a Tron-origin quote
 * with an EVM address is refused for the address even when the amount is one base
 * unit (measured 2026-09-03) — so without a Tron address the route cannot be priced
 * at all, and the user cannot even be told what the minimum is.
 *
 * The refund address does not enter the pricing, so a dry quote made with this one
 * carries the network's real price for the route.
 *
 * It may **never** reach a real quote. `dry: true` allocates nothing, so no funds can
 * ever arrive anywhere; `dry: false` allocates an address money is sent to, and
 * issuing one against an address nobody here controls would point a user's refunds at
 * a stranger. `/api/fund/quote` refuses to commit unless the refund address is the
 * user's own, and `assertIssuable` below is that refusal.
 */
export const PRICING_REFUND_REFERENCE = 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE';

/**
 * The Solana counterpart, for the same pricing-only purpose — the route-availability
 * probe (`lib/server/probe.ts`) needs to *price* a dry Solana quote to learn the
 * route's live state and minimum, and 1Click checks `refundTo`'s chain before
 * anything else. This is Solana's incinerator address: well-known, unowned, and
 * syntactically valid. The same rule applies as above — `dry: true` allocates
 * nothing, and `refundIsIssuable` refuses to let it near a real quote.
 */
export const PRICING_REFUND_REFERENCE_SOLANA = '1nc1nerator11111111111111111111111111111111';

/** Whether a refund address may be carried onto a real, address-issuing quote. */
export function refundIsIssuable(refundTo: string, refundIsUsers: boolean): boolean {
  return (
    refundIsUsers &&
    refundTo !== PRICING_REFUND_REFERENCE &&
    refundTo !== PRICING_REFUND_REFERENCE_SOLANA
  );
}
