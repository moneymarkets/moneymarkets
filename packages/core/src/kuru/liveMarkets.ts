import { getAddress, isAddress, type Address, type PublicClient } from 'viem';
import { z } from 'zod';
import { MAINNET } from '../chain/addresses.js';
import { pricesValuation, QUOTE_VALUATIONS, quoteValuationFor } from '../chain/quoteValuation.js';
import type { MarketParams } from './params.js';
import { verifyMarket } from './registry.js';

/**
 * Which Kuru markets this app may trade right now.
 *
 * ## The shape of the answer
 *
 * Two layers, and only the second one moves:
 *
 *   1. **A fixed candidate list**, in code. Seven markets: five this app trades and two it
 *      shows but does not trade. Every address and every parameter below was read off
 *      chain 143, never typed from memory (rule A2.5). Nothing outside the trading list
 *      can ever be allowed, whatever Kuru's API or an RPC answers.
 *   2. **The active set**, a subset of the five trading candidates. A candidate is in it
 *      only while Kuru still lists it (one per-address call) AND its `getMarketParams()`
 *      still decodes on chain with the same assets and scales pinned here. A market whose
 *      quote asset is priced by another book (emo/MON, priced by MON/USDC) is in it only
 *      while that book is too.
 *
 * A trading candidate must also be quoted in an asset the order cap can value; that is
 * checked when this module loads (see `CAP_MEASURABLE_QUOTE_ASSETS`).
 *
 * ## Why per-address, not the registry walk
 *
 * Kuru's registry is 87,353 rows (`reports/MARKETS-VERIFIED.md` section 4). The walk that
 * used to answer "is it listed" stopped at row 4,000 and so called three listed markets
 * "delisted". Walking to the end takes about 40 minutes. `GET /api/v1/markets/<address>`
 * answers the same question for one market in about 1.5 s: HTTP 200 with the row when
 * the market is listed, HTTP 500 "Market not found: <address>" when it is not. Both
 * shapes are recorded byte for byte in `__fixtures__/kuruMarketLookup.ts`.
 *
 * ## Freshness, and what happens when something fails
 *
 * The same pattern `venueState.ts` proved for the registry: the active set is cached for
 * ten minutes and refreshed in the background, one refresh in flight at a time, never
 * awaited by a request. Reading it is synchronous and never blocks.
 *
 *   - **Cold** (before the first refresh completes, or in a process that never called
 *     `configureLiveMarkets`, such as a browser or a test): MON/USDC alone. It is the one
 *     book with the longest verified live history in this app, so the cold answer is
 *     never empty and never a guess.
 *   - **Kuru says "Market not found"**, or the chain returns different assets or scales
 *     than the ones pinned here: that market is excluded. Definitive.
 *   - **Kuru or the RPC could not be reached, or answered in any other shape** (a
 *     timeout, a 404, a 503, a 500 that is not "Market not found", a 200 naming a
 *     different market): that market is excluded from this refresh. It is never allowed
 *     on a reply we could not read.
 *   - **A refresh in which nothing could be confirmed and at least one answer was
 *     unreadable** is not a reading at all, just an outage. The last confirmed set stays,
 *     less any market that same refresh definitively refused, so a Kuru outage does not
 *     switch every market off and cannot add one either. It is retried after `RETRY_MS`,
 *     not on every request.
 *   - **Every candidate definitively refused** empties the set. That blocks all trading,
 *     which is the correct answer when it is true.
 */

/** Ten minutes, the same cadence `venueState.ts` used for the registry. */
export const ACTIVE_MARKETS_TTL_MS = 10 * 60_000;

/** How soon a refresh that confirmed nothing may be retried. */
export const ACTIVE_MARKETS_RETRY_MS = 30_000;

const LOOKUP_TIMEOUT_MS = 8_000;
const KURU_MARKET_LOOKUP_URL = `${MAINNET.kuru.restApi}/api/v1/markets`;

/** Bounds the per-address listing cache, which `venueState.ts` feeds with catalogue addresses. */
const LISTING_CACHE_MAX = 32;

export type MarketCandidateRole = 'trading' | 'disabled' | 'parked';

export interface MarketCandidate {
  /** Checksummed. */
  readonly address: Address;
  /** e.g. `WETH/USDC`. The address is what identifies the market, never this. */
  readonly symbol: string;
  readonly base: string;
  readonly quote: string;
  readonly role: MarketCandidateRole;
  /**
   * `getMarketParams()` as read on chain 143. A refresh re-reads it and excludes the
   * market if the assets, decimals, pricePrecision or sizePrecision no longer match.
   * Callers that build orders still read params live; these are the identity check.
   */
  readonly params: MarketParams;
}

const NATIVE_MON = '0x0000000000000000000000000000000000000000' as Address;
const USDC = MAINNET.tokens.USDC.address;
const AUSD = MAINNET.tokens.AUSD.address;
/** `symbol()`/`decimals()` read live; `reports/MARKETS-VERIFIED.md` section 1, token table. */
const WETH = '0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242' as Address;
const CBBTC = '0xd18B7EC58Cdf4876f6AFebd3Ed1730e4Ce10414b' as Address;
const XAUT0 = '0x01bFF41798a0BcF287b996046Ca68b395DbC1071' as Address;
/** "emonad". At least four tokens use the ticker `emo`, which is why only addresses are pinned. */
const EMO = '0x81A224F8A62f52BdE942dBF23A56df77A10b7777' as Address;

function candidate(
  address: string,
  base: string,
  quote: string,
  role: MarketCandidateRole,
  params: MarketParams,
): MarketCandidate {
  return { address: getAddress(address), symbol: `${base}/${quote}`, base, quote, role, params };
}

/**
 * The five markets this app trades. MON/USDC is first and is the cold-start answer.
 *
 * Source: `reports/MARKETS-VERIFIED.md` section 1 (the bold rows), `getMarketParams()` at
 * blocks 107,251,915 to 107,251,985 on 2026-09-23. Re-read unchanged at block
 * 107,264,428 (2026-09-23T07:42:27Z) before this file was written, and emo/MON and
 * MON/USDC again at block 107,310,277 (2026-09-23T11:33:11Z) before emo/MON moved here.
 * Every one is a 141-byte proxy on implementation `0x5e3446c6…99a0`, and each one's
 * registry row is the one Kuru's own `volume24h` shows trading.
 *
 * emo/MON is quoted in native MON, not a dollar. It was parked until 2026-09-23 because
 * the order cap compared its orders' value in wei of MON with a figure written in
 * six-decimal dollars. The cap now values MON at the live MON/USDC mid
 * (`chain/quoteValuation.ts`), on both sides of the signing boundary, so an emo/MON
 * order is measured in dollars like every other.
 */
export const TRADING_MARKET_CANDIDATES: readonly MarketCandidate[] = [
  candidate('0x065c9d28e428a0db40191a54d33d5b7c71a9c394', 'MON', 'USDC', 'trading', {
    pricePrecision: 100_000_000n,
    sizePrecision: 10_000_000_000n,
    baseAsset: NATIVE_MON,
    baseDecimals: 18,
    quoteAsset: USDC,
    quoteDecimals: 6,
    tickSize: 100n,
    minSize: 2_000_000_000_000n,
    maxSize: 2_000_000_000_000_000_000n,
    takerFeeBps: 0n,
    makerFeeBps: 0n,
  }),
  candidate('0xa6afd386135b7d41a6c40c525abc4a1019b0d132', 'WETH', 'USDC', 'trading', {
    pricePrecision: 10_000n,
    sizePrecision: 10_000_000_000n,
    baseAsset: WETH,
    baseDecimals: 18,
    quoteAsset: USDC,
    quoteDecimals: 6,
    tickSize: 100n,
    minSize: 20_000_000n,
    maxSize: 1_000_000_000_000_000_000n,
    takerFeeBps: 0n,
    makerFeeBps: 0n,
  }),
  candidate('0x40c49f171202f91ff5d2fae34c22dd2bfdd22af0', 'cbBTC', 'USDC', 'trading', {
    pricePrecision: 10_000n,
    sizePrecision: 100_000_000n,
    baseAsset: CBBTC,
    baseDecimals: 8,
    quoteAsset: USDC,
    quoteDecimals: 6,
    tickSize: 100n,
    minSize: 12_500n,
    maxSize: 10_000_000_000n,
    takerFeeBps: 0n,
    makerFeeBps: 0n,
  }),
  candidate('0x851145eaefdc37956b08da829fa31722199f3f07', 'XAUt0', 'USDC', 'trading', {
    pricePrecision: 10_000n,
    sizePrecision: 1_000_000n,
    baseAsset: XAUT0,
    baseDecimals: 6,
    quoteAsset: USDC,
    quoteDecimals: 6,
    tickSize: 100n,
    minSize: 2_000n,
    maxSize: 100_000_000n,
    takerFeeBps: 0n,
    makerFeeBps: 0n,
  }),
  // maxSize is the chain's 2e19. Kuru's registry row says 1553255926290448384, which is
  // the same number wrapped at 64 bits (report section 1, note 2). Quoted in native MON:
  // the cap values its orders at the MON/USDC mid (`chain/quoteValuation.ts`).
  candidate('0xe7a4f90369b48d8f5b61f2fd519ec563c11e4b2d', 'emo', 'MON', 'trading', {
    pricePrecision: 100_000n,
    sizePrecision: 100_000_000_000n,
    baseAsset: EMO,
    baseDecimals: 18,
    quoteAsset: NATIVE_MON,
    quoteDecimals: 18,
    tickSize: 10n,
    minSize: 20_000_000_000_000n,
    maxSize: 20_000_000_000_000_000_000n,
    takerFeeBps: 2n,
    makerFeeBps: 2n,
  }),
];

/**
 * Verified markets that are deliberately **not traded because the order cap cannot value
 * an order on them**: a quote asset with no entry in `chain/quoteValuation.ts`. Such a
 * market cannot be a trading candidate, which the check below enforces when this module
 * loads. Kept as a list so its book would stay on the sponsored-transfer deny list
 * (`gas/policy.ts` reads `MARKET_CANDIDATES`).
 *
 * Empty since 2026-09-23. emo/MON was here, and is now a trading candidate: the cap
 * values native MON at the live MON/USDC mid.
 */
export const PARKED_MARKET_CANDIDATES: readonly MarketCandidate[] = [];

/**
 * Every quote asset the order cap can value, from `QUOTE_VALUATIONS`: AUSD and USDC
 * one-for-one with its six-decimal dollar unit, and native MON at the live MON/USDC mid.
 *
 * USDT0 was on this list until 2026-09-23. The owner's valuation rule names AUSD and USDC
 * as the dollars the cap takes one-for-one, and no candidate market is quoted in USDT0,
 * so it came off rather than being kept on a rule nobody stated. A sponsored USDT0
 * *transfer* is untouched: that is `gas/policy.ts`, which does not read this list.
 */
export const CAP_MEASURABLE_QUOTE_ASSETS: readonly Address[] = QUOTE_VALUATIONS.map((v) => v.asset);

/** Can the order cap value an order on this market in dollars? */
export function capCanMeasure(params: MarketParams): boolean {
  return quoteValuationFor(params) !== undefined;
}

// A trading candidate the cap cannot value is a market on which every order is refused,
// and one whose pricing book is not a verified trading candidate that prices it is a
// market valued against something nobody checked. Refuse to load rather than ship either.
for (const c of TRADING_MARKET_CANDIDATES) {
  const valuation = quoteValuationFor(c.params);
  if (!valuation) {
    throw new Error(
      `${c.symbol} is quoted in ${c.params.quoteAsset}, which MAX_ORDER_NOTIONAL_AUSD cannot ` +
        'value; it cannot be a trading candidate until the cap can (see PARKED_MARKET_CANDIDATES)',
    );
  }
  if (valuation.kind === 'priced') {
    const book = TRADING_MARKET_CANDIDATES.find(
      (b) => b.address.toLowerCase() === valuation.book.toLowerCase(),
    );
    if (!book || !pricesValuation(book.params, valuation)) {
      throw new Error(
        `${c.symbol} is valued through ${valuation.book}, which is not a trading candidate ` +
          `whose pinned params price ${valuation.symbol} in dollars`,
      );
    }
  }
}

/** The pricing book of a trading candidate's quote asset, or `undefined` for a dollar quote. */
function pricingBookOf(c: MarketCandidate): Address | undefined {
  const valuation = quoteValuationFor(c.params);
  return valuation?.kind === 'priced' ? valuation.book : undefined;
}

/**
 * Shown, never traded. Kuru still lists both (report section 3), but neither trades:
 * zero 24h volume, AUSD/USDC reverts `MarketStateError`, MON/AUSD has an empty book.
 *
 * The report does not tabulate their params, so these were read for this file:
 * `getMarketParams()` at block 107,264,428 (2026-09-23T07:42:27Z). They match the older
 * fixtures `MON_AUSD_PARAMS` (`__fixtures__/books.ts`) and `AUSD_USDC_PARAMS`
 * (`__fixtures__/ausdUsdc.ts`) field for field.
 *
 * WBTC/AUSD is not a candidate of either kind.
 */
export const DISABLED_MARKET_CANDIDATES: readonly MarketCandidate[] = [
  candidate('0x131a2e70a5b31a517a74b8c567149bc294470da9', 'MON', 'AUSD', 'disabled', {
    pricePrecision: 100_000_000n,
    sizePrecision: 10_000_000_000n,
    baseAsset: NATIVE_MON,
    baseDecimals: 18,
    quoteAsset: AUSD,
    quoteDecimals: 6,
    tickSize: 100n,
    minSize: 2_000_000_000_000n,
    maxSize: 20_000_000_000_000_000_000n,
    takerFeeBps: 0n,
    makerFeeBps: 0n,
  }),
  candidate('0x699abc15308156e9a3ab89ec7387e9cfe1c86a3b', 'AUSD', 'USDC', 'disabled', {
    pricePrecision: 100_000_000n,
    sizePrecision: 1_000_000n,
    baseAsset: AUSD,
    baseDecimals: 6,
    quoteAsset: USDC,
    quoteDecimals: 6,
    tickSize: 100n,
    minSize: 10_000_000n,
    maxSize: 10_000_000_000_000n,
    takerFeeBps: 0n,
    makerFeeBps: 0n,
  }),
];

/** All seven: trading, then disabled, then parked (none today). */
export const MARKET_CANDIDATES: readonly MarketCandidate[] = [
  ...TRADING_MARKET_CANDIDATES,
  ...DISABLED_MARKET_CANDIDATES,
  ...PARKED_MARKET_CANDIDATES,
];

/** What the active set is before the first refresh confirms anything: MON/USDC alone. */
export const COLD_START_MARKETS: readonly Address[] = [TRADING_MARKET_CANDIDATES[0]!.address];

/* ─────────────────────────────── the per-address lookup ─────────────────────────────── */

/**
 * Kuru's own answer about one address.
 *
 * `unknown` means the reply could not be read as either answer. It is never treated as
 * "not listed" (the mistake that produced the false "delisted" label), and never as
 * "listed" either.
 */
export type KuruListing = 'listed' | 'not-listed' | 'unknown';

const listedReply = z.object({
  success: z.literal(true),
  data: z.object({ market: z.string() }),
});

const notFoundReply = z.object({
  success: z.literal(false),
  details: z.string(),
});

/**
 * One `GET /api/v1/markets/<address>`.
 *
 * `listed` needs HTTP 200, `success: true` and the row's own `market` equal to the address
 * asked about. `not-listed` needs HTTP 500, `success: false` and `details` equal to
 * `Market not found: <that address>`. Everything else is `unknown`: in particular a 500
 * carrying any other message, which is what a transient server failure looks like.
 */
export async function lookupKuruListing(
  market: string,
  fetchImpl: typeof fetch = fetch,
): Promise<KuruListing> {
  // Only a well-formed address is ever put into the URL path.
  if (!isAddress(market, { strict: false })) return 'unknown';
  const address = market.toLowerCase();

  let status: number;
  let body: unknown;
  try {
    const res = await fetchImpl(`${KURU_MARKET_LOOKUP_URL}/${address}`, {
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    status = res.status;
    body = await res.json();
  } catch {
    return 'unknown';
  }

  if (status === 200) {
    const parsed = listedReply.safeParse(body);
    return parsed.success && parsed.data.data.market.toLowerCase() === address
      ? 'listed'
      : 'unknown';
  }
  if (status === 500) {
    const parsed = notFoundReply.safeParse(body);
    return parsed.success && parsed.data.details.toLowerCase() === `market not found: ${address}`
      ? 'not-listed'
      : 'unknown';
  }
  return 'unknown';
}

/** One retry on an unreadable reply. The registry walk saw single transient 500s that a retry cleared. */
async function lookupWithRetry(market: Address, fetchImpl: typeof fetch): Promise<KuruListing> {
  const first = await lookupKuruListing(market, fetchImpl);
  return first === 'unknown' ? lookupKuruListing(market, fetchImpl) : first;
}

/* ─────────────────────────────── configuration and state ─────────────────────────────── */

export interface LiveMarketsOptions {
  /** A read-only chain 143 client. Used only for `getMarketParams()`. */
  readonly client: PublicClient;
  readonly fetchImpl?: typeof fetch;
  /** Injected in tests. */
  readonly now?: () => number;
}

let options: LiveMarketsOptions | undefined;

/**
 * The active set. Mutated in place, only by `refreshActive` (and the test reset), so every
 * view of it stays current.
 */
const active: Address[] = [...COLD_START_MARKETS];
let confirmedAt: number | undefined;
let lastAttemptAt: number | undefined;
let warming: Promise<void> | undefined;
let lastChecks: readonly CandidateCheck[] = [];

interface ListingEntry {
  /** Kuru's last readable answer. */
  listed?: boolean;
  /** When that answer was given. */
  at?: number;
  /** When a lookup was last started, readable or not. Throttles retries. */
  attemptedAt: number;
  inflight?: Promise<void>;
}

const listings = new Map<string, ListingEntry>();

function clock(): number {
  return options?.now?.() ?? Date.now();
}

/**
 * Turn on background refreshing for this process. Server entry points call it; nothing
 * else needs to. Until it is called the active set stays at `COLD_START_MARKETS` and no
 * network call is ever made, which is what keeps browsers and tests offline.
 *
 * The first call wins; later calls are ignored. It starts a refresh straight away.
 */
export function configureLiveMarkets(next: LiveMarketsOptions): void {
  if (options) return;
  options = next;
  kick();
}

/* ─────────────────────────────────── the active set ─────────────────────────────────── */

export type CandidateOutcome = 'active' | 'excluded' | 'unverified';

export interface CandidateCheck {
  readonly address: Address;
  readonly symbol: string;
  readonly outcome: CandidateOutcome;
  readonly listing: KuruListing;
  readonly why:
    | 'listed-and-verified'
    | 'not-listed-by-kuru'
    | 'params-changed'
    | 'chain-read-failed'
    | 'kuru-unreadable'
    // Listed and verified itself, but the book that prices its quote asset in dollars
    // (MON/USDC, for emo/MON) was not confirmed in the same refresh.
    | 'pricing-book-inactive';
}

/** Assets, decimals and the two precisions. Tick, sizes and fees may move without it being a different market. */
function sameMarket(live: MarketParams, pinned: MarketParams): boolean {
  return (
    live.baseAsset.toLowerCase() === pinned.baseAsset.toLowerCase() &&
    live.quoteAsset.toLowerCase() === pinned.quoteAsset.toLowerCase() &&
    live.baseDecimals === pinned.baseDecimals &&
    live.quoteDecimals === pinned.quoteDecimals &&
    live.pricePrecision === pinned.pricePrecision &&
    live.sizePrecision === pinned.sizePrecision
  );
}

async function checkCandidate(
  opts: LiveMarketsOptions,
  c: MarketCandidate,
): Promise<CandidateCheck> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const [listing, verified] = await Promise.all([
    lookupWithRetry(c.address, fetchImpl),
    verifyMarket(opts.client, c.address, undefined).catch(() => undefined),
  ]);
  rememberListing(c.address, listing);
  const base = { address: c.address, symbol: c.symbol, listing };
  if (listing === 'not-listed') return { ...base, outcome: 'excluded', why: 'not-listed-by-kuru' };
  if (!verified) return { ...base, outcome: 'unverified', why: 'chain-read-failed' };
  if (!sameMarket(verified.params, c.params)) {
    return { ...base, outcome: 'excluded', why: 'params-changed' };
  }
  if (listing === 'unknown') return { ...base, outcome: 'unverified', why: 'kuru-unreadable' };
  return { ...base, outcome: 'active', why: 'listed-and-verified' };
}

/**
 * A market quoted in a priced asset is only as tradable as the book that prices it. When
 * that book was not confirmed in the same refresh, the market takes the book's outcome:
 * excluded when the book was definitively refused, unverified when it could not be read.
 * Its orders could not be valued in dollars by a book this module does not stand behind.
 */
function withPricingBooks(checks: readonly CandidateCheck[]): CandidateCheck[] {
  const byAddress = new Map(checks.map((c) => [c.address.toLowerCase(), c]));
  return checks.map((check) => {
    if (check.outcome !== 'active') return check;
    const candidate = TRADING_MARKET_CANDIDATES.find(
      (c) => c.address.toLowerCase() === check.address.toLowerCase(),
    );
    const book = candidate ? pricingBookOf(candidate) : undefined;
    if (!book) return check;
    const bookCheck = byAddress.get(book.toLowerCase());
    if (bookCheck?.outcome === 'active') return check;
    return {
      ...check,
      outcome: bookCheck?.outcome === 'excluded' ? 'excluded' : 'unverified',
      why: 'pricing-book-inactive',
    };
  });
}

async function refreshActive(opts: LiveMarketsOptions): Promise<void> {
  try {
    const [rawChecks] = await Promise.all([
      Promise.all(TRADING_MARKET_CANDIDATES.map((c) => checkCandidate(opts, c))),
      // Disabled candidates are never made active, but their listing is refreshed on the
      // same cadence so `getDisabledMarkets()` has a warm answer without a request asking.
      Promise.all(
        DISABLED_MARKET_CANDIDATES.map(async (c) =>
          rememberListing(c.address, await lookupWithRetry(c.address, opts.fetchImpl ?? fetch)),
        ),
      ),
    ]);
    const checks = withPricingBooks(rawChecks);
    lastChecks = checks;
    // Filtered from the pinned list, so nothing that is not a trading candidate can get in.
    const next = checks.filter((c) => c.outcome === 'active').map((c) => c.address);
    const anyUnreadable = checks.some((c) => c.outcome === 'unverified');
    if (next.length === 0 && anyUnreadable) {
      // An outage, not a reading: keep the last confirmed set, but still act on any
      // definitive answer that did arrive. A market Kuru said it does not list, or whose
      // params changed, leaves now rather than riding out the outage. Nothing is added,
      // and the set is not marked confirmed, so the retry comes on `RETRY_MS`.
      const refused = new Set(
        checks.filter((c) => c.outcome === 'excluded').map((c) => c.address.toLowerCase()),
      );
      const kept = active.filter((m) => !refused.has(m.toLowerCase()));
      if (kept.length !== active.length) active.splice(0, active.length, ...kept);
      return;
    }
    active.splice(0, active.length, ...next);
    confirmedAt = clock();
  } catch {
    // Nothing above is expected to throw. If something does, keep what was confirmed.
  }
}

function kick(): void {
  if (!options || warming) return;
  const t = clock();
  if (confirmedAt !== undefined && t - confirmedAt < ACTIVE_MARKETS_TTL_MS) return;
  if (lastAttemptAt !== undefined && t - lastAttemptAt < ACTIVE_MARKETS_RETRY_MS) return;
  lastAttemptAt = t;
  const opts = options;
  warming = refreshActive(opts).finally(() => {
    warming = undefined;
  });
}

/**
 * The markets that are safe to trade right now: a copy of the active set, never blocking.
 * Starts a background refresh when the set is older than ten minutes.
 */
export function getActiveMarkets(): Address[] {
  kick();
  return [...active];
}

function readOnlyView(): false {
  return false;
}

/**
 * The active set as a live, read-only array. It is the same set `getActiveMarkets()`
 * returns, but it keeps up by itself: a reference taken once at import time still shows
 * the current set later, and reading it starts a refresh when one is due. Every write
 * (`push`, index assignment, `length = 0`, `Object.freeze`) throws a TypeError, so no
 * caller can widen or poison it.
 *
 * `LIVE_MARKET_ALLOWLIST` in `chain/caps.ts` is this view.
 */
export const activeMarketsView: readonly Address[] = new Proxy(active, {
  get(target, property, receiver) {
    kick();
    return Reflect.get(target, property, receiver) as unknown;
  },
  set: readOnlyView,
  deleteProperty: readOnlyView,
  defineProperty: readOnlyView,
  setPrototypeOf: readOnlyView,
  preventExtensions: readOnlyView,
});

export interface LiveMarketsStatus {
  /** `cold-start` until a refresh has been confirmed. */
  readonly source: 'cold-start' | 'confirmed';
  readonly active: readonly Address[];
  readonly confirmedAt?: number;
  readonly lastAttemptAt?: number;
  /** The last refresh's answer per trading candidate, including the ones it excluded and why. */
  readonly checks: readonly CandidateCheck[];
}

/** For health endpoints and operators. Does not start a refresh. */
export function getLiveMarketsStatus(): LiveMarketsStatus {
  return {
    source: confirmedAt === undefined ? 'cold-start' : 'confirmed',
    active: [...active],
    ...(confirmedAt === undefined ? {} : { confirmedAt }),
    ...(lastAttemptAt === undefined ? {} : { lastAttemptAt }),
    checks: lastChecks,
  };
}

/* ─────────────────────────── is one address listed (cached) ─────────────────────────── */

function rememberListing(market: string, listing: KuruListing): void {
  const key = market.toLowerCase();
  const entry: ListingEntry = listings.get(key) ?? { attemptedAt: clock() };
  entry.attemptedAt = clock();
  // An unreadable reply never overwrites an answer Kuru actually gave.
  if (listing !== 'unknown') {
    entry.listed = listing === 'listed';
    entry.at = clock();
  }
  if (listings.has(key) || listings.size < LISTING_CACHE_MAX) listings.set(key, entry);
}

/**
 * Is this address in Kuru's own market list, from cache?
 *
 * `undefined` means not known yet: a cold cache, an unconfigured process, or an address
 * Kuru has only ever answered unreadably about. Callers must treat it as "ask something
 * else", never as "not listed". A stale answer is returned while a background lookup
 * refreshes it, one lookup per address at a time, never awaited here.
 */
export function listedByKuru(market: Address): boolean | undefined {
  const key = market.toLowerCase();
  const entry = listings.get(key);
  const t = clock();
  const fresh = entry?.at !== undefined && t - entry.at < ACTIVE_MARKETS_TTL_MS;
  const recentlyTried = entry !== undefined && t - entry.attemptedAt < ACTIVE_MARKETS_RETRY_MS;
  if (options && !fresh && !recentlyTried && !entry?.inflight) {
    if (entry || listings.size < LISTING_CACHE_MAX) {
      const fetchImpl = options.fetchImpl ?? fetch;
      const pending: ListingEntry = entry ?? { attemptedAt: t };
      pending.attemptedAt = t;
      pending.inflight = lookupWithRetry(key as Address, fetchImpl)
        .then((listing) => rememberListing(key, listing))
        .catch(() => undefined)
        .finally(() => {
          delete pending.inflight;
        });
      listings.set(key, pending);
    }
  }
  return entry?.listed;
}

/* ─────────────────────────────────── disabled markets ─────────────────────────────────── */

/** The states `apps/trade/lib/server/venueState.ts` classifies a market into. */
export type VenueStateName = 'tradable' | 'paused' | 'empty' | 'one-sided' | 'delisted';

/** `readVenueState` from `venueState.ts`, injected because core cannot import an app. */
export type VenueStateReader = (
  market: Address,
) => Promise<{ readonly state: VenueStateName } | undefined>;

export type DisabledReason = 'paused' | 'empty' | 'unknown';

export interface DisabledMarket {
  readonly address: Address;
  readonly symbol: string;
  readonly base: string;
  readonly quote: string;
  /**
   * Kuru's own per-address answer. `undefined` when it is not known yet (cold cache, or
   * Kuru has not answered readably): say nothing about listing rather than guess.
   */
  readonly stillListedByKuru: boolean | undefined;
  /**
   * `paused`: the venue refuses trades on it (`MarketStateError` or `ProtocolPaused`).
   * `empty`: nothing rests on either side. `unknown`: neither could be established, or
   * the reading was something else (see `venueState`).
   */
  readonly reason: DisabledReason;
  /** The full reading this was classified from, when there was one. */
  readonly venueState?: VenueStateName;
}

/**
 * The two shown-but-not-traded markets, with what can be said about them truthfully.
 *
 * Never blocks on Kuru: `stillListedByKuru` comes from the cache. `readState` is awaited,
 * and in the trade app it is `readVenueState`, one cached `eth_call` per market. Without
 * a reader, `reason` is `unknown`.
 */
export async function getDisabledMarkets(readState?: VenueStateReader): Promise<DisabledMarket[]> {
  return Promise.all(
    DISABLED_MARKET_CANDIDATES.map(async (c) => {
      let reading: { readonly state: VenueStateName } | undefined;
      try {
        reading = readState ? await readState(c.address) : undefined;
      } catch {
        reading = undefined;
      }
      const reason: DisabledReason =
        reading?.state === 'paused' ? 'paused' : reading?.state === 'empty' ? 'empty' : 'unknown';
      return {
        address: c.address,
        symbol: c.symbol,
        base: c.base,
        quote: c.quote,
        stillListedByKuru: listedByKuru(c.address),
        reason,
        ...(reading ? { venueState: reading.state } : {}),
      };
    }),
  );
}

/* ───────────────────────────────────── test seams ───────────────────────────────────── */

/** Test seam: back to an unconfigured, cold process. Can only narrow the set, never widen it. */
export function resetLiveMarketsForTests(): void {
  options = undefined;
  active.splice(0, active.length, ...COLD_START_MARKETS);
  confirmedAt = undefined;
  lastAttemptAt = undefined;
  warming = undefined;
  lastChecks = [];
  listings.clear();
}

/** Test seam: the refresh in flight, if any, so a test can wait for it. */
export function liveMarketsRefreshInFlight(): Promise<void> | undefined {
  return warming;
}
