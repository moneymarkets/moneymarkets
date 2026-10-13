import { describe, expect, it } from 'vitest';
import { amountToSend, fillExact, formatAmountForInput, onEdit } from './amountField';

/**
 * Item 2 (2026-09-29): Max and the percentage buttons must send the exact bigint
 * balance, never a figure re-parsed from the rounded-down display string (D176's
 * regression). Covers Move in both directions and Send, for emo and WMON (18
 * on-chain decimals, 6 shown) and USDC (6 on-chain decimals, nothing to floor).
 */

const EMO_DECIMALS = 18;
const WMON_DECIMALS = 18;
const USDC_DECIMALS = 6;

describe('fillExact / amountToSend', () => {
  it('Max sends the exact full balance for emo (18 decimals), even though the display floors to 6dp', () => {
    const balance = 1_234_567_891_234_567_891_234n; // more precision than the 6dp display cap
    const state = fillExact(balance, EMO_DECIMALS, 'emo');
    expect(state.exact).toBe(balance);
    expect(state.text).toBe('1234.567891');
    expect(amountToSend(state, EMO_DECIMALS)).toBe(balance);
  });

  it('Max sends the exact full balance for WMON (18 decimals)', () => {
    const balance = 3_732_318_142_700_000_000n; // 3.7323181427 WMON
    const state = fillExact(balance, WMON_DECIMALS, 'WMON');
    expect(state.exact).toBe(balance);
    expect(state.text).toBe('3.732318');
    expect(amountToSend(state, WMON_DECIMALS)).toBe(balance);
  });

  it('Max sends the exact full balance for USDC (6 decimals, nothing to floor)', () => {
    const balance = 2_216_000n; // 2.216 USDC
    const state = fillExact(balance, USDC_DECIMALS, 'USDC');
    expect(state.exact).toBe(balance);
    expect(state.text).toBe('2.216');
    expect(amountToSend(state, USDC_DECIMALS)).toBe(balance);
  });

  it('Max on Move in (wallet balance) and Move out (trading balance) both send the exact full balance', () => {
    const walletBalance = 1_234_567_891_234_567_891_234n;
    const tradingBalance = 9_876_543_210_987_654_321_987n;
    const moveIn = fillExact(walletBalance, EMO_DECIMALS, 'emo');
    const moveOut = fillExact(tradingBalance, EMO_DECIMALS, 'emo');
    expect(amountToSend(moveIn, EMO_DECIMALS)).toBe(walletBalance);
    expect(amountToSend(moveOut, EMO_DECIMALS)).toBe(tradingBalance);
  });

  it('Max on Send sends the exact full balance', () => {
    const balance = 5_000_000_000_000_000_001n; // one wei of dust past a round number
    const state = fillExact(balance, WMON_DECIMALS, 'WMON');
    expect(amountToSend(state, WMON_DECIMALS)).toBe(balance);
  });

  it('a percentage fill computes the exact bigint share in bigint math, not from the display string', () => {
    const balance = 1_000_000_000_000_000_000n; // 1.0, 18 decimals
    const state = fillExact(balance, 18, 'MON', 2_500); // 25%, in bps
    expect(state.exact).toBe(250_000_000_000_000_000n);
    expect(amountToSend(state, 18)).toBe(250_000_000_000_000_000n);
  });

  it('never inserts a thousands separator into the input text, however large the balance', () => {
    const state = fillExact(1_234_567_891_234_567_891_234n, 18, 'emo');
    expect(state.text).not.toContain(',');
    expect(formatAmountForInput(1_234_567n, 6, 6)).not.toContain(',');
  });

  it('floors the display, never rounds up', () => {
    // 1.9999999 at 18 decimals, floored to 6dp must read 1.999999, not 2.000000.
    const balance = 1_999_999_900_000_000_000n;
    const state = fillExact(balance, 18, 'emo');
    expect(state.text).toBe('1.999999');
  });

  it('editing the text clears the exact value, so the amount re-parses from what is on screen', () => {
    const max = fillExact(1_234_567_891_234_567_891_234n, 18, 'emo');
    const edited = onEdit('5');
    expect(edited.exact).toBeUndefined();
    expect(amountToSend(edited, 18)).toBe(5_000_000_000_000_000_000n);
    // Editing must not mutate the state it was derived from.
    expect(max.exact).toBe(1_234_567_891_234_567_891_234n);
  });

  it('amountToSend falls back to parsing the text when there is no exact value at all', () => {
    const typed = onEdit('12.5');
    expect(amountToSend(typed, USDC_DECIMALS)).toBe(12_500_000n);
  });
});
