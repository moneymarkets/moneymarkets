import type { WalletTokenEntry } from '../useAccountBalances';

/**
 * Pure Wallet Home logic: which rows show under a segment, how they sort, what the
 * hero and the two cells beneath it total, and which token (if any) is "waiting"
 * (wallet spec §4.1, §5.4).
 *
 * Kept free of React and of `fetch` so every rule here is a plain function over the
 * same `tokens[]` shape `/api/account/balances` already returns
 * (`apps/trade/lib/server/walletTokens.ts`), tested directly rather than by
 * rendering a screen — this repo's vitest config has no JSX transform on purpose.
 * `WalletTokenEntry` has one definition, in `useAccountBalances.ts` (the single
 * balance source, per that file's own doc comment) — re-exported here so this
 * module's own callers and tests need only one import.
 *
 * Every figure here comes from what the caller hands in. Nothing is guessed: a
 * token with no price source (`usd.total === null`) contributes nothing to a total
 * and sorts after every priced token, rather than being treated as zero.
 */

export type { WalletTokenEntry };

export type HoldingsSegment = 'all' | 'trading' | 'wallet';

/** The quantity (base units) shown for `token` under `segment`. */
export function segmentQuantity(token: WalletTokenEntry, segment: HoldingsSegment): bigint {
  if (segment === 'trading') return token.margin.value;
  if (segment === 'wallet') return token.wallet.value;
  return token.wallet.value + token.margin.value;
}

/** The USD value (six-decimal base units) for `token` under `segment`, or `undefined`
 *  when this token has no price source — never a fabricated zero. */
export function segmentUsd(token: WalletTokenEntry, segment: HoldingsSegment): bigint | undefined {
  const usd = segment === 'trading' ? token.usd.margin : segment === 'wallet' ? token.usd.wallet : token.usd.total;
  return usd ? usd.value : undefined;
}

/** Six-decimal dollars: $1.00. "Hide small" (spec §4.1, §4.6) compares against this. */
const DUST_USD_MICROS = 1_000_000n;

/**
 * Rows with something under `segment`, with "Hide small" applied.
 *
 * A token with no price is never hidden by "Hide small": there is no dollar figure
 * to compare it against, and hiding an unpriced holding would be one more place it
 * silently disappears (spec §3: "a token with no price source shows its quantity
 * and no dollar value" — never omitted).
 */
export function visibleHoldings(
  tokens: readonly WalletTokenEntry[],
  segment: HoldingsSegment,
  hideSmall: boolean,
): readonly WalletTokenEntry[] {
  return tokens.filter((t) => {
    if (segmentQuantity(t, segment) <= 0n) return false;
    if (hideSmall) {
      const usd = segmentUsd(t, segment);
      if (usd !== undefined && usd < DUST_USD_MICROS) return false;
    }
    return true;
  });
}

/** Sorted by USD value under `segment`, descending. Unpriced tokens sort after every
 *  priced one (spec §4.1: "rows sorted by USD value"). */
export function sortHoldings(
  tokens: readonly WalletTokenEntry[],
  segment: HoldingsSegment,
): readonly WalletTokenEntry[] {
  return [...tokens].sort((a, b) => {
    const av = segmentUsd(a, segment);
    const bv = segmentUsd(b, segment);
    if (av === undefined && bv === undefined) return 0;
    if (av === undefined) return 1;
    if (bv === undefined) return -1;
    if (av === bv) return 0;
    return av > bv ? -1 : 1;
  });
}

/** Sum of every token's USD value under `segment` that has one. A token with no price
 *  contributes nothing — see `allPriced` for whether that makes the total partial. */
export function totalUsd(tokens: readonly WalletTokenEntry[], segment: HoldingsSegment = 'all'): bigint {
  return tokens.reduce((sum, t) => {
    const usd = segmentUsd(t, segment);
    return usd === undefined ? sum : sum + usd;
  }, 0n);
}

/** False when some token holds a real balance under `segment` but has no price — the
 *  hero total is then a partial sum, and the caller should say so rather than present
 *  it as complete. */
export function allPriced(tokens: readonly WalletTokenEntry[], segment: HoldingsSegment = 'all'): boolean {
  return tokens.every((t) => segmentQuantity(t, segment) <= 0n || segmentUsd(t, segment) !== undefined);
}

/**
 * The Waiting card's token (spec §4.1, §5.4): rendered only when some token's wallet
 * balance is greater than zero. When more than one qualifies, the largest by USD
 * value waits at the top; ties or all-unpriced fall back to array order.
 */
export function waitingToken(
  tokens: readonly WalletTokenEntry[],
  /** v2.1 spec 1.3: the card shows only for a MOVABLE token — one Kuru's
   *  MarginAccount accepts (permit or the D2 approve triple). The caller supplies
   *  the predicate from the live registry; omitted keeps every positive balance. */
  movable: (t: WalletTokenEntry) => boolean = () => true,
): WalletTokenEntry | undefined {
  const waiting = tokens.filter((t) => t.wallet.value > 0n && movable(t));
  return sortHoldings(waiting, 'wallet')[0];
}

/**
 * No token's Move-out is disabled any more (D3, 2026-09-25): native MON withdraws
 * as `withdraw(amount, MON)` + `WMON.deposit{value: amount}` in one batch — the
 * policy line that used to be pending (`assertWmonWrap` in
 * `packages/core/src/gas/policy.ts`) now exists — and arrives as WMON, which the
 * Move sheet says plainly. The function stays so the sheet keeps one named place
 * to ask the question, and its tests keep the fact pinned.
 */
export function isMoveOutDisabled(_symbol: string): boolean {
  return false;
}
