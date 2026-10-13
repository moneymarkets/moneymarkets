import { getAddress, isAddress, type Address } from 'viem';
import {
  DISABLED_MARKET_CANDIDATES,
  MAINNET,
  MARKET_CANDIDATES,
  TRADING_MARKET_CANDIDATES,
  type MarketCandidate,
} from '@tradepro/core';

/**
 * The market catalogue.
 *
 * No screen names a market. Screens take one from here or from the route parameter.
 *
 * ## Where the five tradable markets and the two shown-but-disabled ones come from
 *
 * `TRADING_MARKET_CANDIDATES` and `DISABLED_MARKET_CANDIDATES`, both in
 * `@tradepro/core`'s `kuru/liveMarkets.ts` — the addresses and params verified on
 * chain 143 this session (`reports/MARKETS-VERIFIED.md`). This file used to carry its
 * own hand-typed address table, and it drifted: it named WBTC/AUSD, which is not one
 * of the markets this app trades or shows, and it was missing WETH/USDC, cbBTC/USDC
 * and XAUt0/USDC entirely. Building the two lists below from core's verified
 * candidates instead of retyping addresses is what keeps that from happening again.
 *
 * **WBTC/AUSD is not a candidate of either kind and does not appear here.** Nothing in
 * this file, or in any screen that reads it, can make it selectable. emo/MON is a
 * trading candidate since 2026-09-23: it is quoted in native MON, and the order cap now
 * values MON at the live MON/USDC mid (`chain/quoteValuation.ts` in core).
 *
 * `role` is what a screen uses to decide how to draw a market:
 *
 *   - `trading`  — one of the five books this app actually trades.
 *   - `disabled` — MON/AUSD and AUSD/USDC. Kuru still lists both, so nothing here
 *     calls them "not listed" — MON/AUSD's book is empty and AUSD/USDC reverts
 *     `MarketStateError`. Shown, never offered as a plain option: a picker renders
 *     them disabled, with the live reason from `readDisabledMarkets()`
 *     (`lib/server/venueState.ts`) rather than a guess.
 *   - `not-deployed` — USDT0/AUSD, which does not exist on Kuru at all. Kept because
 *     the product promises it; gets no address, no book and no route to the market
 *     handler.
 *
 * The addresses below are a discovery hint only. Everything the ticket relies on —
 * params, tick, min size, best bid/ask — is read from the chain by the market route
 * handler, never from this file.
 */

export type MarketRole = 'trading' | 'disabled' | 'not-deployed';
export type MarketStatus = 'live' | 'not-deployed';

export interface MarketConfig {
  /** Absent for a market that has not been deployed. */
  readonly address?: Address;
  /** Stable route key. The address for a live market, a slug for one that is not. */
  readonly key: string;
  /** Display name, e.g. "MON / USDC". */
  readonly symbol: string;
  readonly base: string;
  readonly quote: string;
  /** The base and quote token contracts, for their icons. Absent when not known. */
  readonly baseAddress?: Address;
  readonly quoteAddress?: Address;
  /** Coin chip colour (design §3). */
  readonly color: string;
  readonly status: MarketStatus;
  readonly role: MarketRole;
  /** Why it is not deployed, in the user's words. Only for `not-deployed`. */
  readonly note?: string;
}

/** Chip colour by base asset. Decorative only — never the only signal (design §7). */
const COIN_COLOR: Record<string, string> = {
  MON: '#7C5CFF',
  WETH: '#627EEA',
  cbBTC: '#F7931A',
  XAUt0: '#D4AF37',
  AUSD: '#2775CA',
};

function fromCandidate(c: MarketCandidate, role: 'trading' | 'disabled'): MarketConfig {
  return {
    address: c.address,
    key: c.address,
    symbol: `${c.base} / ${c.quote}`,
    base: c.base,
    quote: c.quote,
    baseAddress: c.params.baseAsset,
    quoteAddress: c.params.quoteAsset,
    color: COIN_COLOR[c.base] ?? '#7C5CFF',
    status: 'live',
    role,
  };
}

const NOT_DEPLOYED_MARKETS: readonly MarketConfig[] = [
  {
    key: 'usdt0-ausd',
    symbol: 'USDT0 / AUSD',
    base: 'USDT0',
    quote: 'AUSD',
    baseAddress: MAINNET.tokens.USDT0.address,
    quoteAddress: MAINNET.tokens.AUSD.address,
    color: '#26A17B',
    status: 'not-deployed',
    role: 'not-deployed',
    note:
      'This market has not been created on Kuru yet. There is no order book to show ' +
      'and nothing to trade against until it is deployed and seeded.',
  },
];

const DEFAULT_MARKETS: readonly MarketConfig[] = [
  ...TRADING_MARKET_CANDIDATES.map((c) => fromCandidate(c, 'trading')),
  ...DISABLED_MARKET_CANDIDATES.map((c) => fromCandidate(c, 'disabled')),
  ...NOT_DEPLOYED_MARKETS,
];

function envLive(address: string, symbol: string, base: string, quote: string): MarketConfig {
  const checksummed = getAddress(address);
  const known = MARKET_CANDIDATES.find((c) => c.address.toLowerCase() === checksummed.toLowerCase());
  return {
    address: checksummed,
    key: checksummed,
    symbol,
    base,
    quote,
    ...(known ? { baseAddress: known.params.baseAsset, quoteAddress: known.params.quoteAsset } : {}),
    color: COIN_COLOR[base] ?? '#7C5CFF',
    status: 'live',
    role: 'trading',
  };
}

/** `NEXT_PUBLIC_MARKETS=MON/USDC@0x065c…,MON/AUSD@0x131a…` */
function parseEnvMarkets(raw: string | undefined): readonly MarketConfig[] | undefined {
  if (!raw) return undefined;
  const parsed: MarketConfig[] = [];
  for (const entry of raw.split(',')) {
    const [symbol, address] = entry.trim().split('@');
    if (!symbol || !address || !isAddress(address)) continue;
    const [base = symbol, quote = ''] = symbol.split('/').map((s) => s.trim());
    parsed.push(envLive(address, `${base} / ${quote}`, base, quote));
  }
  return parsed.length > 0 ? parsed : undefined;
}

export const MARKETS: readonly MarketConfig[] =
  parseEnvMarkets(process.env.NEXT_PUBLIC_MARKETS) ?? DEFAULT_MARKETS;

/** The markets with a book — trading and disabled both. Anything server-side only ever sees these. */
export const LIVE_MARKETS: readonly MarketConfig[] = MARKETS.filter((m) => m.status === 'live');

/** The five this app actually trades. */
export const TRADING_MARKETS: readonly MarketConfig[] = MARKETS.filter((m) => m.role === 'trading');

/** MON/AUSD and AUSD/USDC — shown, never traded. */
export const DISABLED_MARKETS: readonly MarketConfig[] = MARKETS.filter((m) => m.role === 'disabled');

/**
 * The market a screen opens on when the user has not chosen one.
 *
 * MON/USDC by default because it is the only book on the venue with real depth; the
 * AUSD books are empty until they are seeded. This is a default, not a hardcoding —
 * every other market in `MARKETS` is reachable from the picker and from the URL. A
 * market with no book can never be the default, and a disabled one is never the
 * default either — `TRADING_MARKETS` is the pool this picks from.
 */
export const DEFAULT_MARKET: MarketConfig =
  TRADING_MARKETS.find(
    (m) => m.key.toLowerCase() === (process.env.NEXT_PUBLIC_DEFAULT_MARKET ?? '').toLowerCase(),
  ) ??
  TRADING_MARKETS[0] ??
  LIVE_MARKETS[0] ??
  DEFAULT_MARKETS[0]!;

const compact = (value: string) => value.trim().toLowerCase().replace(/\s+/g, '');

export function marketFor(keyOrSymbol: string): MarketConfig | undefined {
  const needle = compact(keyOrSymbol);
  return MARKETS.find((m) => m.key.toLowerCase() === needle || compact(m.symbol) === needle);
}

/**
 * Anything with a book in `MARKETS` is readable; anything else is refused, not
 * guessed. The route handlers use this, so a market with no address can never reach
 * an RPC call. Both trading and disabled markets are known — MON/AUSD and AUSD/USDC
 * are real books, read live, and shown disabled rather than hidden.
 */
export function isKnownMarket(address: string): boolean {
  const market = marketFor(address);
  return market !== undefined && market.status === 'live';
}
