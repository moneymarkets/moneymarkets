import type { Address } from 'viem';
import { WIRE_PRICE_SCALE } from '../math/fixed.js';
import type { MarketParams } from './params.js';

/**
 * The order book model and its invariants (spec §4.4).
 *
 * Prices in a normalized `Book` are always human-price * 1e18. Sizes are always
 * base-asset base units. Everything that enters this module declares where it came
 * from, because the scale depends on the source and getting it wrong silently
 * misprices the whole screen.
 */

export const HEARTBEAT_MS = 3000;

/**
 * Where a raw book payload came from. There is no default: a caller that cannot say
 * which of these applies does not know the scale either, and I3 requires a throw
 * rather than a guess.
 */
export type BookSource =
  /** `<marketAddr>@monadDepth` websocket frames. Prices 1e18, sizes in sizePrecision. */
  | 'ws-monadDepth'
  /** REST `depth` for a real market. Prices raw 1e18, sizes in sizePrecision. */
  | 'rest-depth'
  /** `bestBidAsk()` on chain. Prices 1e18. Verified against MON/AUSD 2026-09-02. */
  | 'bestBidAsk'
  /**
   * `getL2Book()` on chain, decoded by `l2book.ts`. Prices in `pricePrecision`
   * units, sizes in `sizePrecision` units — measured against a live `@monadDepth`
   * frame for the same market, 2026-09-02. This is the only source whose prices are
   * not already 1e18.
   */
  | 'contract-getL2Book'
  /** V3/V4 pseudo-symbol feeds, which return human decimals and human sizes. */
  | 'pseudo-symbol-human';

export type BookConsensusState = 'proposed' | 'voted' | 'finalized' | 'committed';

export interface Level {
  /** human price * 1e18 */
  readonly price: bigint;
  /** base-asset base units */
  readonly size: bigint;
}

export interface Book {
  readonly market: Address;
  readonly state: BookConsensusState;
  readonly source: BookSource;
  /** Descending: bids[0] is the best bid. */
  readonly bids: readonly Level[];
  /** Ascending: asks[0] is the best ask. The SDK hands these back descending. */
  readonly asks: readonly Level[];
  /** 0n means "no bid". */
  readonly bestBid: bigint;
  /** 0n means "no ask". */
  readonly bestAsk: bigint;
  readonly blockNumber?: bigint;
  readonly receivedAt: number;
  readonly validity: 'ok' | 'INVALID';
  readonly invalidReason?: string;
}

export interface RawLevel {
  /** Price in whatever scale `source` implies. Accepts the string form wires use. */
  readonly price: bigint | string;
  /** Size in whatever scale `source` implies. */
  readonly size: bigint | string;
}

export interface NormalizeInput {
  readonly market: Address;
  readonly source: BookSource;
  readonly state: BookConsensusState;
  readonly params: MarketParams;
  readonly bids: readonly RawLevel[];
  readonly asks: readonly RawLevel[];
  /** From `bestBidAsk()` when available; otherwise derived from the arrays. */
  readonly bestBid?: bigint;
  readonly bestAsk?: bigint;
  readonly blockNumber?: bigint;
  readonly receivedAt?: number;
}

const KNOWN_SOURCES: readonly BookSource[] = [
  'ws-monadDepth',
  'rest-depth',
  'bestBidAsk',
  'contract-getL2Book',
  'pseudo-symbol-human',
];

export class UnknownBookSourceError extends Error {
  constructor(source: string) {
    super(
      `unknown book source ${JSON.stringify(source)}: refusing to guess the price ` +
        `scale. Known sources: ${KNOWN_SOURCES.join(', ')}`,
    );
    this.name = 'UnknownBookSourceError';
  }
}

/**
 * I3 — price scale by source. Returns human price * 1e18.
 *
 * Real markets put 1e18-scaled prices on the wire; the V3/V4 pseudo-symbols return
 * human decimals (framework §4.1, error 4). An unrecognised source throws.
 */
export function normalizePrice(
  raw: bigint | string,
  source: BookSource,
  params: MarketParams,
): bigint {
  switch (source) {
    case 'ws-monadDepth':
    case 'rest-depth':
    case 'bestBidAsk':
      return toBigInt(raw);
    case 'contract-getL2Book':
      // pricePrecision units -> human * 1e18
      return (toBigInt(raw) * WIRE_PRICE_SCALE) / params.pricePrecision;
    case 'pseudo-symbol-human':
      return humanDecimalTo1e18(raw);
    default:
      throw new UnknownBookSourceError(source as string);
  }
}

/**
 * I4 — sizes from the wire are in `sizePrecision` units, not 1e18. Returns base-asset
 * base units.
 */
export function normalizeSize(
  raw: bigint | string,
  source: BookSource,
  params: MarketParams,
): bigint {
  const value = source === 'pseudo-symbol-human' ? humanDecimalTo1e18(raw) : toBigInt(raw);
  switch (source) {
    case 'ws-monadDepth':
    case 'rest-depth':
    case 'contract-getL2Book':
      // sizePrecision units -> base units
      return (value * 10n ** BigInt(params.baseDecimals)) / params.sizePrecision;
    case 'pseudo-symbol-human':
      // human * 1e18 -> base units
      return (value * 10n ** BigInt(params.baseDecimals)) / WIRE_PRICE_SCALE;
    case 'bestBidAsk':
      throw new Error('bestBidAsk carries no sizes');
    default:
      throw new UnknownBookSourceError(source as string);
  }
}

/**
 * Normalize a raw book into the canonical model and apply I1–I4.
 *
 * A crossed book is not repaired and not thrown away: it is returned with
 * `validity: 'INVALID'` so the UI can say "market data unavailable" and the ticket
 * can refuse orders, which is what I1 asks for.
 */
export function normalizeBook(input: NormalizeInput): Book {
  if (!KNOWN_SOURCES.includes(input.source)) {
    throw new UnknownBookSourceError(input.source as string);
  }

  const toLevels = (raw: readonly RawLevel[]): Level[] =>
    raw
      .map((l) => ({
        price: normalizePrice(l.price, input.source, input.params),
        size: normalizeSize(l.size, input.source, input.params),
      }))
      .filter((l) => l.size > 0n);

  // I2 — sort regardless of the order the source used. The SDK hands `asks` back
  // descending while `manualOrders.asks` is ascending (framework §4.1, error 1), so
  // input order is never trusted.
  const bids = toLevels(input.bids).sort((a, b) => cmpDesc(a.price, b.price));
  const asks = toLevels(input.asks).sort((a, b) => cmpAsc(a.price, b.price));

  const bestBid = input.bestBid ?? bids[0]?.price ?? 0n;
  const bestAsk = input.bestAsk ?? asks[0]?.price ?? 0n;

  const invalidReason = crossedReason(bestBid, bestAsk);

  return {
    market: input.market,
    state: input.state,
    source: input.source,
    bids,
    asks,
    bestBid,
    bestAsk,
    ...(input.blockNumber === undefined ? {} : { blockNumber: input.blockNumber }),
    receivedAt: input.receivedAt ?? Date.now(),
    validity: invalidReason ? 'INVALID' : 'ok',
    ...(invalidReason ? { invalidReason } : {}),
  };
}

/**
 * `bestBidAsk()` reports "no side" with sentinels, not with zero.
 *
 * The verified `OrderBook` returns **`2^256-1` for a missing bid** and **`0` for a
 * missing ask** — measured on the empty MON/AUSD book, chain 143 block 103,110,791.
 * Zero is this repo's own convention for "no side" everywhere else, so the sentinel
 * has to be folded exactly once, at the boundary where the contract's convention is
 * read.
 *
 * It was not folded, and the raw sentinel reached the order ticket: `bestBid` of
 * `115792089237316195423570985008687907853269984665640564039457584007913129639935` is greater than zero, so the ticket happily used it as a reference price and
 * computed a minimum-order notional from it. Anything that treats "greater than
 * zero" as "there is a bid" is wrong until this has run.
 */
export function normalizeBestBidAsk(
  bestBid: bigint,
  bestAsk: bigint,
): { readonly bestBid: bigint; readonly bestAsk: bigint } {
  return {
    bestBid: bestBid === NO_BID_SENTINEL ? 0n : bestBid,
    bestAsk: bestAsk === NO_ASK_SENTINEL ? 0n : bestAsk,
  };
}

/** `bestBidAsk()`'s "there is no bid" value. */
export const NO_BID_SENTINEL = 2n ** 256n - 1n;
/** `bestBidAsk()`'s "there is no ask" value, which is also a plain zero. */
export const NO_ASK_SENTINEL = 0n;

/**
 * I1 — `bestBid < bestAsk`. A one-sided book is not crossed, it is just one-sided;
 * only two live sides that overlap are invalid.
 */
/**
 * Why the book is unusable, named with the numbers that made it so.
 *
 * The values are in the sentence on purpose. "Market data invalid" alone gave the
 * reader nothing to check, so a false positive looked exactly like a real one — which
 * is precisely what happened on 2026-09-10, when a preview control fed this function
 * swapped values and the resulting refusal was indistinguishable from a genuine
 * crossed book. A reason carrying its own evidence can be disproved at a glance.
 *
 * Printed at the 1e18 wire scale the comparison actually uses, not a rounded human
 * price: two prices that differ below display precision are the interesting case.
 */
function crossedReason(bestBid: bigint, bestAsk: bigint): string | undefined {
  if (bestBid === 0n || bestAsk === 0n) return undefined;
  if (bestBid >= bestAsk) {
    return `crossed book: best bid ${bestBid} is at or above best ask ${bestAsk} (wire scale, 1e18)`;
  }
  return undefined;
}

/** I6 — a book older than the heartbeat, with a live socket, is stale. */
export function isStale(book: Book, now = Date.now(), heartbeatMs = HEARTBEAT_MS): boolean {
  return now - book.receivedAt > heartbeatMs;
}

/** The one question the order ticket asks before enabling itself. */
export function isTradable(book: Book, now = Date.now()): boolean {
  return book.validity === 'ok' && !isStale(book, now) && book.bestBid > 0n && book.bestAsk > 0n;
}

/** Mid price, human * 1e18. Undefined when either side is missing or the book is bad. */
export function midPrice(book: Book): bigint | undefined {
  if (book.validity !== 'ok') return undefined;
  if (book.bestBid === 0n || book.bestAsk === 0n) return undefined;
  return (book.bestBid + book.bestAsk) / 2n;
}

/** Spread in parts-per-million of the mid. Undefined when the book is not two-sided. */
export function spreadPps(book: Book): bigint | undefined {
  const mid = midPrice(book);
  if (mid === undefined || mid === 0n) return undefined;
  return ((book.bestAsk - book.bestBid) * 1_000_000n) / mid;
}

function cmpAsc(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function cmpDesc(a: bigint, b: bigint): number {
  return -cmpAsc(a, b);
}

function toBigInt(v: bigint | string): bigint {
  if (typeof v === 'bigint') return v;
  const s = v.trim();
  if (!/^-?\d+$/.test(s)) {
    throw new Error(`expected an integer string for this source, got ${JSON.stringify(v)}`);
  }
  return BigInt(s);
}

function humanDecimalTo1e18(v: bigint | string): bigint {
  if (typeof v === 'bigint') return v * WIRE_PRICE_SCALE;
  const s = v.trim();
  if (!/^-?\d*(\.\d*)?$/.test(s) || s === '' || s === '.' || s === '-') {
    throw new Error(`expected a human decimal for this source, got ${JSON.stringify(v)}`);
  }
  const negative = s.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? s.slice(1) : s).split('.');
  if (fraction.length > 18) {
    throw new Error(`human price ${s} has more than 18 decimal places`);
  }
  const magnitude = BigInt((whole === '' ? '0' : whole) + fraction.padEnd(18, '0'));
  return negative ? -magnitude : magnitude;
}
