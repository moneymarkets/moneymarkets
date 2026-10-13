import {
  CAP_UNIT_DECIMALS,
  rescaleWithRounding,
  TRADING_MARKET_CANDIDATES,
  WIRE_PRICE_SCALE,
  type MarketCandidate,
  type MarketParams,
} from '@tradepro/core';
import type { Address } from 'viem';

/**
 * Wallet tab data layer — pure decision and math, pulled out of
 * `app/api/account/balances/route.ts` so it can be unit tested without mocking a
 * chain client or the network (WALLET-IMPLEMENTATION.md section 3, section 9's
 * pending item: dynamic token enumeration; the owner's cbBTC, WETH and XAUt0 in
 * margin were invisible under the old hand-picked AUSD/USDC/USDT0/MON list).
 *
 * Everything here is deterministic given its inputs. The route does the I/O
 * (multicall legs, the Kuru REST reads, the Flow quote) and hands the results in.
 */

export const NATIVE_MON: Address = '0x0000000000000000000000000000000000000000';

/** The cap's dollar unit, six decimals — reused so this module has one definition of "a dollar". */
export const USD_DECIMALS = CAP_UNIT_DECIMALS;

export type LegacyToken = 'AUSD' | 'USDC' | 'USDT0' | 'MON';

export interface TokenSpec {
  readonly symbol: string;
  readonly address: Address;
  /** `-1` means "unknown, read `decimals()` live" — never guessed. */
  readonly decimals: number;
  /** Set only for the four tokens `/api/account/balances` already had fixed legs for. */
  readonly legacy?: LegacyToken;
}

export interface AddressBookTokens {
  readonly AUSD: { readonly address: Address; readonly decimals: number };
  readonly USDC: { readonly address: Address; readonly decimals: number };
  readonly USDT0: { readonly address: Address; readonly decimals: number };
  readonly MON: { readonly address: Address; readonly decimals: number };
  readonly WMON: { readonly address: Address; readonly decimals: number };
}

/**
 * Every token this account's balances should be checked for.
 *
 * Dedup'd by address, first occurrence wins — the address-book entries are listed
 * first, so a market whose base or quote happens to be AUSD/USDC/USDT0/MON keeps
 * its `legacy` tag rather than being planned as a second, redundant leg.
 *
 * `candidates` defaults to the real, live `TRADING_MARKET_CANDIDATES` — passing a
 * different list is a test seam only; production code never overrides it, which is
 * what makes this "dynamic": a new market added to that list needs no change here.
 */
/** A registry entry, or a stored contract read: enough to plan a balance leg without a live decimals read. */
export interface KnownToken {
  readonly address: Address;
  readonly symbol: string;
  readonly decimals: number;
}

export function enumerateTokenSpecs(
  addressBook: AddressBookTokens,
  extraTokenAddresses: readonly Address[] = [],
  candidates: readonly MarketCandidate[] = TRADING_MARKET_CANDIDATES,
  /**
   * Any-token wallet (spec A2a): every registry token, and every token the account's
   * own set names with metadata already read, gets a leg with its known decimals.
   * Listed after the candidates so an address both name keeps the candidate's
   * pinned figures; before `extraTokenAddresses` so a known address is never
   * planned as an unknown one.
   */
  knownTokens: readonly KnownToken[] = [],
): TokenSpec[] {
  const specs: TokenSpec[] = [];
  const seen = new Set<string>();

  function add(spec: TokenSpec): void {
    const key = spec.address.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    specs.push(spec);
  }

  add({ symbol: 'AUSD', address: addressBook.AUSD.address, decimals: addressBook.AUSD.decimals, legacy: 'AUSD' });
  add({ symbol: 'USDC', address: addressBook.USDC.address, decimals: addressBook.USDC.decimals, legacy: 'USDC' });
  add({
    symbol: 'USDT0',
    address: addressBook.USDT0.address,
    decimals: addressBook.USDT0.decimals,
    legacy: 'USDT0',
  });
  add({ symbol: 'MON', address: NATIVE_MON, decimals: addressBook.MON.decimals, legacy: 'MON' });
  add({ symbol: 'WMON', address: addressBook.WMON.address, decimals: addressBook.WMON.decimals });

  for (const candidate of candidates) {
    add({ symbol: candidate.base, address: candidate.params.baseAsset, decimals: candidate.params.baseDecimals });
    add({ symbol: candidate.quote, address: candidate.params.quoteAsset, decimals: candidate.params.quoteDecimals });
  }

  for (const known of knownTokens) {
    add({ symbol: known.symbol, address: known.address, decimals: known.decimals });
  }

  for (const address of extraTokenAddresses) {
    add({ symbol: '', address, decimals: -1 });
  }

  return specs;
}

/** Trading candidates whose quote asset is USDC — the set with a live dollar book. */
export function usdcQuotedMarkets(
  usdcAddress: Address,
  candidates: readonly MarketCandidate[] = TRADING_MARKET_CANDIDATES,
): MarketCandidate[] {
  return candidates.filter((c) => c.params.quoteAsset.toLowerCase() === usdcAddress.toLowerCase());
}

export type PriceSource = 'par' | 'market-mid' | 'flow-quote' | 'none';

export interface PriceDecision {
  readonly source: PriceSource;
  /** Human price * 1e18. Present only when `source === 'market-mid'`. */
  readonly priceWire?: bigint;
}

/**
 * Which on-chain price source applies to `token`, and its live mid when there is
 * one. Never reaches a network or a chain itself — `bookMids` is the caller's own
 * already-read `bestBidAsk` results, keyed by market address (lowercased).
 *
 *   - AUSD, USDC: `'par'`.
 *   - Native MON, WMON: the MON/USDC book's mid, if that market is in
 *     `usdcQuoted` and its mid is known — the same book
 *     `chain/quoteValuation.ts`'s `MON_USDC_PRICING_BOOK` names, not rebuilt here.
 *   - Any other token that is itself the base of a USDC-quoted market (cbBTC,
 *     WETH, XAUt0 today; whatever ships next automatically): that market's mid.
 *   - Everything else (USDT0, emo — quoted in MON, not a dollar — and any token
 *     from `extraTokenAddresses`): `'none'`. The caller tries a Flow quote next;
 *     this function only knows the two on-chain sources.
 */
export function classifyMarketPrice(
  token: Address,
  addressBook: Pick<AddressBookTokens, 'AUSD' | 'USDC' | 'WMON'>,
  usdcQuoted: readonly Pick<MarketCandidate, 'address' | 'params'>[],
  bookMids: ReadonlyMap<string, bigint | null>,
): PriceDecision {
  const key = token.toLowerCase();
  if (key === addressBook.AUSD.address.toLowerCase() || key === addressBook.USDC.address.toLowerCase()) {
    return { source: 'par' };
  }

  const isMonOrWmon = key === NATIVE_MON.toLowerCase() || key === addressBook.WMON.address.toLowerCase();
  const baseKey = isMonOrWmon ? NATIVE_MON.toLowerCase() : key;
  const book = usdcQuoted.find((m) => m.params.baseAsset.toLowerCase() === baseKey);
  if (book) {
    const mid = bookMids.get(book.address.toLowerCase());
    if (mid !== undefined && mid !== null) return { source: 'market-mid', priceWire: mid };
  }
  return { source: 'none' };
}

/** `amount` base units of a token priced at `priceWire` (human USD * 1e18) -> six-decimal dollars, floored. */
export function toUsd(amount: bigint, tokenDecimals: number, priceWire: bigint): bigint {
  return rescaleWithRounding(
    amount * priceWire,
    10n ** BigInt(tokenDecimals) * WIRE_PRICE_SCALE,
    10n ** BigInt(USD_DECIMALS),
    'floor',
  );
}

/** A dollar-par token (AUSD, USDC): its own base units rescaled to six-decimal dollars. */
export function toUsdPar(amount: bigint, tokenDecimals: number): bigint {
  return rescaleWithRounding(amount, 10n ** BigInt(tokenDecimals), 10n ** BigInt(USD_DECIMALS), 'floor');
}

/** A Kuru Flow quote's implied price (USDC out for one whole token in, six decimals) applied to `amount`. */
export function usdFromFlow(amount: bigint, tokenDecimals: number, usdPerWhole: bigint): bigint {
  return (amount * usdPerWhole) / 10n ** BigInt(tokenDecimals);
}

/** Only a market quoted in USDC carries a dollar-denominated `priceChange24h`. */
export function isUsdDenominated(params: Pick<MarketParams, 'quoteAsset'>, usdcAddress: Address): boolean {
  return params.quoteAsset.toLowerCase() === usdcAddress.toLowerCase();
}

/**
 * The planned tokens to answer with: every plan, except a token this app found on its
 * own (the Transfer-log scan, outside the registry) whose balance or decimals read
 * failed. Such a token is left out rather than failing the whole wallet read (owner,
 * 2026-09-30: an address-poisoning token whose balanceOf reverts blanked a proof
 * account's wallet). Every other plan is kept, so its own failed read still fails the
 * request and a real balance never reads as zero.
 */
export function readableTokenPlans<
  P extends { address: string; legacy?: unknown; walletIdx?: number; marginIdx?: number; decimalsIdx?: number },
>(
  plans: readonly P[],
  results: readonly ({ status: 'success' | 'failure' } | undefined)[],
  scannedOnly: ReadonlySet<string>,
): { kept: P[]; dropped: P[] } {
  const failed = (i: number | undefined) => i !== undefined && results[i]?.status !== 'success';
  const kept: P[] = [];
  const dropped: P[] = [];
  for (const plan of plans) {
    const discovered = !plan.legacy && scannedOnly.has(plan.address.toLowerCase());
    if (discovered && (failed(plan.walletIdx) || failed(plan.marginIdx) || failed(plan.decimalsIdx))) dropped.push(plan);
    else kept.push(plan);
  }
  return { kept, dropped };
}
