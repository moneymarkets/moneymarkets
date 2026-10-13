import { formatUnits } from '@tradepro/core';
import { displayDp, parseAmount } from '../format';

/**
 * The Max/percentage-fill model (owner item 2, 2026-09-29).
 *
 * D176 capped what a Max or percentage tap *displays* to the token's own display
 * precision (`displayDp`), so a screen never showed eighteen raw decimals from a Max
 * tap on MON or WETH. The bug that fix left behind: the amount FIELD held only that
 * rounded-down string, and every screen re-parsed the amount to send FROM that
 * string, so Max sent less than the full balance whenever a token's on-chain
 * decimals exceeded its display cap. The dust was real and it stayed behind.
 *
 * The fix is to stop treating the display string as the source of truth. A Max or
 * percentage tap now sets an exact bigint share alongside the display text; the
 * text is floored to the token's display precision, but the exact bigint is
 * computed straight from the balance in bigint math and never round-tripped
 * through that string. Editing the text clears the exact value, so a hand-typed
 * amount still re-parses from exactly what is on screen, the same as before.
 */

export interface AmountFieldState {
  readonly text: string;
  readonly exact?: bigint;
}

/**
 * `units` formatted for an editable field: no thousands separators (design copy
 * rules, those belong in read-only text only) and floored to `dp` fractional
 * digits, never rounded up. Flooring the display can only ever understate what a
 * Max/percentage tap set as the exact amount, never overstate it.
 */
export function formatAmountForInput(units: bigint, decimals: number, dp: number): string {
  const raw = formatUnits(units, decimals);
  const [whole = '0', fraction = ''] = raw.split('.');
  const truncated = fraction.slice(0, dp);
  return truncated.length > 0 ? `${whole}.${truncated}` : whole;
}

/**
 * A Max or percentage tap. `pctBps` is parts per 10,000 (2,500 = 25%); left out, or
 * 10,000 or higher, means Max, the exact bigint is `balance` itself, never a
 * 100%-share computed by multiplying and dividing, so Max can never lose a unit to
 * rounding a share computation might.
 */
export function fillExact(
  balance: bigint,
  decimals: number,
  symbol: string,
  pctBps?: number,
): AmountFieldState {
  const exact = pctBps === undefined || pctBps >= 10_000 ? balance : (balance * BigInt(pctBps)) / 10_000n;
  const text = formatAmountForInput(exact, decimals, displayDp(symbol, decimals));
  return { text, exact };
}

/** The user typed. The exact bigint from any earlier Max/percentage tap is gone , 
 *  `amountToSend` re-parses from `text`, exactly what is on screen. */
export function onEdit(text: string): AmountFieldState {
  return { text };
}

/** What actually gets sent: the exact bigint from the last Max/percentage tap when
 *  there is one, otherwise the text re-parsed at `decimals`. */
export function amountToSend(state: AmountFieldState, decimals: number): bigint | undefined {
  return state.exact ?? parseAmount(state.text, decimals);
}
