import { encodeFunctionData, type Address, type Hex } from 'viem';
import {
  configureLiveMarkets,
  decodeKuruError,
  decodeMarketParams,
  getDisabledMarkets,
  listedByKuru,
  normalizeBestBidAsk,
  orderBookAbi,
  PROTOCOL_PAUSED_SELECTOR,
  QUOTE_SENDER,
  type DisabledMarket,
  type MarketParams,
} from '@tradepro/core';
import { chainMode, readClient } from './chain';

/**
 * What state is one market actually in, read per market.
 *
 * The book's own invariants (I1, I6) answer "is this data usable". They cannot answer
 * "will this venue accept an order", and on this venue the two genuinely differ:
 *
 *   - **AUSD/USDC** quotes a healthy two-sided book and reverts `MarketStateError` on
 *     every trade path. It is paused, and nothing in the book data says so.
 *   - **MON/AUSD** accepts every call and has nothing resting on it. A market order
 *     there does not revert — it succeeds and fills **zero**.
 *
 * Both were measured on chain 143 at block 103,110,791. Before this, the ticket found
 * out at the passkey prompt, and `/api/status` reported one market's health as if it
 * were all four.
 *
 * The probe is a dry market buy of one whole quote unit from the zero sender:
 * `_isMargin = false`, so the verified OrderBook matches against real depth and skips
 * both the debit and the credit. It needs no balance and writes nothing, so its
 * refusal is the market's own state and never the caller's wallet. It is the same read
 * `quoteConversion()` already makes in production.
 */

export type VenueState = 'tradable' | 'paused' | 'empty' | 'one-sided' | 'delisted';

export interface VenueReading {
  readonly state: VenueState;
  /** The venue's own words, verbatim and source-named (D124). */
  readonly reason?: string;
  /**
   * Kuru's own fees for this book, in basis points, from `getMarketParams()`.
   *
   * Carried because Settings used to state "0%" as a fact in hardcoded copy. It happens
   * to be true on all four books today — measured, both zero — but a number typed into
   * a screen is a claim that stops being checked, and this one would have quietly become
   * a lie the day Kuru set a fee. Absent when the read failed, which the screen says
   * rather than falling back to zero.
   */
  readonly takerFeeBps?: string;
  readonly makerFeeBps?: string;
  /**
   * What the probe actually got back, so a screen can show Kuru's own answer rather
   * than only our reading of it. Present whenever the probe reverted with something
   * decodable, including the cases we deliberately do NOT call a pause.
   */
  readonly probeSelector?: string;
  readonly probeError?: string;
  /** The exact call the probe made, so the reading can be reproduced by hand. */
  readonly probeCall?: string;
}

/**
 * Short, because this is a liveness fact and a stale "tradable" is exactly the lie
 * this module exists to stop telling. Long enough that a footer poll from several
 * clients does not multiply into an RPC storm.
 */
const CACHE_MS = 30_000;

const cache = new Map<string, { at: number; reading: VenueReading | undefined }>();

/**
 * Is this market refusing orders?
 *
 * `undefined` means the probe itself did not answer — which is not the same as "it is
 * fine", and callers must not treat it as one.
 */
/**
 * The only two reverts that mean "this venue will not trade".
 *
 * Everything else a probe can hit is about **the probe**, not the market. Measured
 * 2026-09-10: with a funded sender the healthy MON/USDC book reverts
 * `TransferFromFailed` (0x7939f424), because the probe spends money the sender has
 * not approved — and the old code, which treated *any* decodable Kuru error as a
 * pause, would have reported the one market that actually trades as paused. It only
 * ever worked because the zero address happens to succeed on a healthy book, which is
 * a coincidence one probe-sender change away from mislabelling everything.
 */
/**
 * Markets Kuru itself still lists.
 *
 * ## Why a probe is not enough
 *
 * A probe cannot tell a paused book from one Kuru has dropped: both revert the same way.
 * Only Kuru's own list can, which is why there is a `'delisted'` state at all.
 *
 * ## Why this is a per-address lookup now
 *
 * This used to walk Kuru's paged registry and stopped at row 4,000. The registry is
 * 87,353 rows, and quiet books sort far past row 4,000, so on 2026-09-22 MON/AUSD,
 * AUSD/USDC and WBTC/AUSD all read "Not listed by Kuru" while Kuru listed all three
 * (`reports/MARKETS-VERIFIED.md` section 4). A walk to the end takes about 40 minutes, and
 * a single failed page inside it would still have labelled every later market delisted.
 *
 * `listedByKuru` in `@tradepro/core` asks `GET /api/v1/markets/<address>` instead, one
 * call per market, cached for ten minutes and refreshed in the background. Only Kuru's
 * explicit "Market not found" for that exact address reads as not listed. A timeout, any
 * other error or an unreadable reply leaves the answer unknown, and the state falls to the
 * probe rather than calling a live market delisted.
 *
 * It only runs on mainnet: the addresses it checks are chain 143's, and on testnet a
 * mainnet "not found" would label every testnet book delisted.
 */
const KURU_MARKET_LOOKUP_URL = 'https://api.kuru.io/api/v1/markets/<address>';

let liveMarketsStarted = false;

/** Turns on the background lookups, once per process, on mainnet only. Never awaits. */
function ensureLiveMarkets(): void {
  if (liveMarketsStarted) return;
  liveMarketsStarted = true;
  try {
    if (chainMode() !== 'mainnet') return;
    configureLiveMarkets({ client: readClient() });
  } catch {
    // A misconfigured CHAIN fails the caller's own read; this must not fail it first.
  }
}

const PAUSE_SELECTORS: readonly string[] = [
  '0x004b65ba', // MarketStateError
  PROTOCOL_PAUSED_SELECTOR, // 0x44279255
];

async function probeRefusal(
  market: Address,
  params: MarketParams,
): Promise<
  | { refused: true; reason: string; selector: string }
  | { refused: false; selector?: string }
  | undefined
> {
  // One whole quote unit on the wire: `amount * pricePrecision / 10^quoteDecimals`
  // with `amount = 10^quoteDecimals` is exactly `pricePrecision`.
  const data = encodeFunctionData({
    abi: orderBookAbi,
    functionName: 'placeAndExecuteMarketBuy',
    args: [params.pricePrecision, 0n, false, false],
  });
  try {
    await readClient().call({ account: QUOTE_SENDER, to: market, data });
    return { refused: false };
  } catch (error) {
    const raw = revertDataOf(error);
    const selector = raw?.slice(0, 10).toLowerCase();
    const known = raw ? decodeKuruError(raw as Hex) : undefined;

    if (selector && PAUSE_SELECTORS.includes(selector)) {
      return {
        refused: true,
        reason: `Kuru answered: ${known?.name ?? selector}`,
        selector,
      };
    }
    // A decodable error that is not one of the two pause errors tells us the probe
    // failed, which is not the same fact. Reported as "not refused", with the
    // selector carried so the screen can show what was actually said.
    if (known && selector) return { refused: false, selector };
    // A read that did not answer says nothing about the market at all.
    return undefined;
  }
}

/**
 * The market's state, classified. Pause is checked **first**, because a paused market
 * can still quote a full two-sided book, so a depth test alone would call it tradable.
 */
export async function readVenueState(market: Address): Promise<VenueReading | undefined> {
  ensureLiveMarkets();
  const key = market.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.reading;

  let reading: VenueReading | undefined;
  try {
    const [paramsTuple, bestBidAsk] = await Promise.all([
      readClient().readContract({
        address: market,
        abi: orderBookAbi,
        functionName: 'getMarketParams',
      }),
      readClient().readContract({ address: market, abi: orderBookAbi, functionName: 'bestBidAsk' }),
    ]);
    const params = decodeMarketParams(paramsTuple as never);
    const [rawBid, rawAsk] = bestBidAsk as readonly [bigint, bigint];
    const { bestBid, bestAsk } = normalizeBestBidAsk(rawBid, rawAsk);

    /**
     * Is this a market Kuru still lists? Asked first, because a delisted book can also
     * revert like a paused one, and only one of those two words is true.
     */
    const listed = listedByKuru(market);
    if (listed === false) {
      const reading: VenueReading = {
        state: 'delisted',
        reason: 'Kuru no longer lists this market',
        probeCall: `GET ${KURU_MARKET_LOOKUP_URL} — Kuru answered "Market not found" for this address`,
      };
      cache.set(market, { at: Date.now(), reading });
      return reading;
    }

    const refusal = await probeRefusal(market, params);
    if (refusal === undefined) {
      reading = undefined;
    } else if (refusal.refused) {
      reading = { state: 'paused', reason: refusal.reason };
    } else if (bestBid === 0n && bestAsk === 0n) {
      reading = { state: 'empty' };
    } else if (bestBid === 0n || bestAsk === 0n) {
      reading = { state: 'one-sided' };
    } else {
      reading = { state: 'tradable' };
    }
    if (reading) {
      const selector = refusal && 'selector' in refusal ? refusal.selector : undefined;
      const named = selector ? decodeKuruError(selector as Hex)?.name : undefined;
      reading = {
        ...reading,
        takerFeeBps: params.takerFeeBps.toString(),
        makerFeeBps: params.makerFeeBps.toString(),
        ...(selector ? { probeSelector: selector } : {}),
        ...(named ? { probeError: named } : {}),
        probeCall: `placeAndExecuteMarketBuy(${params.pricePrecision}, 0, false, false) from ${QUOTE_SENDER}`,
      };
    }
  } catch {
    reading = undefined;
  }

  cache.set(key, { at: Date.now(), reading });
  return reading;
}

/** Classify a market whose params and touch the caller has already read. */
export async function readVenueStateWith(
  market: Address,
  params: MarketParams,
  bestBid: bigint,
  bestAsk: bigint,
): Promise<VenueReading | undefined> {
  /**
   * The same registry check `readVenueState` does.
   *
   * This is the variant `/api/market/[market]` actually calls — it reuses params and a
   * book the caller already read. It was missed on the first pass, so the screen kept
   * saying "paused" for a delisted market while the other entry point said otherwise.
   * Two entry points to one question need the same answer.
   */
  ensureLiveMarkets();
  const listed = listedByKuru(market);
  if (listed === false) {
    return {
      state: 'delisted',
      reason: 'Kuru no longer lists this market',
      probeCall: `GET ${KURU_MARKET_LOOKUP_URL} — Kuru answered "Market not found" for this address`,
    };
  }

  const refusal = await probeRefusal(market, params);
  if (refusal === undefined) return undefined;
  const selector = 'selector' in refusal ? refusal.selector : undefined;
  const named = selector ? decodeKuruError(selector as Hex)?.name : undefined;
  const evidence = {
    ...(selector ? { probeSelector: selector } : {}),
    ...(named ? { probeError: named } : {}),
    probeCall: `placeAndExecuteMarketBuy(${params.pricePrecision}, 0, false, false) from ${QUOTE_SENDER}`,
  };
  if (refusal.refused) return { state: 'paused', reason: refusal.reason, ...evidence };
  if (bestBid === 0n && bestAsk === 0n) return { state: 'empty', ...evidence };
  if (bestBid === 0n || bestAsk === 0n) return { state: 'one-sided', ...evidence };
  return { state: 'tradable', ...evidence };
}

/**
 * MON/AUSD and AUSD/USDC: shown, not traded. Each with Kuru's cached listing answer and
 * this module's own paused/empty reading. See `getDisabledMarkets` in `@tradepro/core`.
 */
export async function readDisabledMarkets(): Promise<DisabledMarket[]> {
  ensureLiveMarkets();
  return getDisabledMarkets(readVenueState);
}

/** Test seam. */
export function clearVenueStateCache(): void {
  cache.clear();
}

/**
 * The raw revert data, wherever viem put it.
 *
 * viem nests revert data differently depending on how the node answered, and the
 * selector is not reliably in `error.message` — reading only the message classified
 * both genuinely paused books as "unknown" on the first deploy of this module, which
 * is precisely the silence it exists to end. So every shape is walked, and the
 * message is only the last resort.
 */
function revertDataOf(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  const walk = (node: unknown): string | undefined => {
    if (!node || typeof node !== 'object' || seen.has(node)) return undefined;
    seen.add(node);
    const o = node as Record<string, unknown>;
    for (const key of ['data', 'raw', 'signature']) {
      const v = o[key];
      if (typeof v === 'string' && /^0x[0-9a-fA-F]{8,}$/.test(v)) return v;
    }
    for (const key of ['cause', 'details', 'error', 'walk']) {
      const found = walk(o[key]);
      if (found) return found;
    }
    return undefined;
  };
  const direct = walk(error);
  if (direct) return direct;
  const text = error instanceof Error ? error.message : String(error);
  return /0x[0-9a-fA-F]{8}/.exec(text)?.[0];
}
