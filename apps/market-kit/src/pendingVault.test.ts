import { describe, expect, it } from 'vitest';
import { parseUnitsFloor } from './pendingVault.js';

/**
 * High #15: `kit vault --pending` used viem's own `parseUnits`, which rounds
 * half-away-from-zero on excess fractional digits — for `--min-quote-consumed`, a
 * slippage floor, that silently changed the number the operator actually typed.
 */
describe('parseUnitsFloor never invents a unit the operator did not type', () => {
  it('truncates rather than rounding up on excess precision', () => {
    // viem's parseUnits('99.9999995', 6) rounds the 7th digit up to 100.000000.
    expect(parseUnitsFloor('99.9999995', 6)).toBe(99_999_999n);
  });

  it('matches viem exactly when there is nothing to round', () => {
    expect(parseUnitsFloor('420', 9)).toBe(420_000_000_000n);
    expect(parseUnitsFloor('1.5', 6)).toBe(1_500_000n);
  });

  it('pads a short fraction rather than truncating it', () => {
    expect(parseUnitsFloor('1.5', 6)).toBe(1_500_000n);
  });

  it('handles a bare integer and a bare fraction', () => {
    expect(parseUnitsFloor('10', 6)).toBe(10_000_000n);
    expect(parseUnitsFloor('.5', 6)).toBe(500_000n);
  });

  it('refuses a malformed amount rather than guessing at it', () => {
    expect(() => parseUnitsFloor('1.2.3', 6)).toThrow(/not a valid amount/);
    expect(() => parseUnitsFloor('', 6)).toThrow(/not a valid amount/);
    expect(() => parseUnitsFloor('abc', 6)).toThrow(/not a valid amount/);
  });
});
