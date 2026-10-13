import { describe, expect, it } from 'vitest';
import { basisFromActivity, changeFor, formatBps } from './costBasis';
import type { ActivityRow } from './activityStore';

/**
 * Cost basis, tested against the account's own real trades.
 *
 * The four MON/USDC fills below are the owner's, taken from their receipts and from
 * `DECISIONS.md`. Using them rather than round invented numbers is the point: a
 * weighted average over 0.387417 and 0.386713 exposes rounding that 1.0 and 2.0 would
 * hide, and these are the exact amounts the screen will be asked to price.
 *
 * (`lib/activityBackfill.ts` used to carry the same figures, to backfill this one
 * account's pre-launch history into every browser that loaded the app — which shipped
 * one real person's exact trade history, timestamps and a third party's wallet
 * address in the production bundle for every visitor. Deleted 2026-09-23 (audit High
 * #18); this file's fixture is independent of it and needed no change.)
 */

const fill = (
  id: string,
  side: 'buy' | 'sell',
  baseAmount: string,
  at: number,
  quoteAmount = '10000',
  quoteSymbol = 'USDC',
): ActivityRow => ({
  id,
  kind: 'order',
  summary: `${side} MON`,
  at,
  trade: {
    side,
    baseAmount,
    baseSymbol: 'MON',
    baseDecimals: 18,
    quoteAmount,
    quoteSymbol,
    quoteDecimals: 6,
  },
});

/** The owner's four real MON/USDC fills, in the order they happened. */
const REAL: readonly ActivityRow[] = [
  fill('a', 'buy', '387416705400000000', 1),
  fill('b', 'buy', '386712556500000000', 2),
  fill('c', 'sell', '387011881200000000', 3),
  fill('d', 'buy', '387056819900000000', 4),
];

describe('cost basis from an account own fills (ITEM 7)', () => {
  it('accumulates buys and draws a sell down at the running average', () => {
    const basis = basisFromActivity(REAL);
    const mon = basis.get('MON');
    expect(mon).toBeDefined();
    // Three buys of 0.010000 USDC each, one sell. Quantity is the net of all four.
    const net =
      387416705400000000n + 386712556500000000n - 387011881200000000n + 387056819900000000n;
    expect(mon?.quantity).toBe(net);
    // The sell removed cost at the average of the two buys before it, so what is left
    // is strictly less than the 0.030000 USDC that went out.
    expect(mon?.cost).toBeLessThan(30_000n);
    expect(mon?.cost).toBeGreaterThan(0n);
    expect(mon?.quoteSymbol).toBe('USDC');
  });

  it('reads rows in time order regardless of the order it is handed them', () => {
    const shuffled = [REAL[3]!, REAL[0]!, REAL[2]!, REAL[1]!];
    expect(basisFromActivity(shuffled).get('MON')).toEqual(basisFromActivity(REAL).get('MON'));
  });

  it('ignores rows with no trade block rather than guessing at them', () => {
    const withNoise: ActivityRow[] = [
      ...REAL,
      { id: 'dep', kind: 'direct-deposit', summary: 'Received 1 USDC', at: 5 },
      { id: 'w', kind: 'withdraw', summary: 'Withdrew', at: 6 },
    ];
    expect(basisFromActivity(withNoise).get('MON')).toEqual(basisFromActivity(REAL).get('MON'));
  });

  it('refuses a basis when the same token was bought against two different quotes', () => {
    // MON trades against both AUSD and USDC here. Adding one cost to the other would
    // be arithmetic on two units that are only near each other, so the basis is
    // dropped rather than converted at a rate nobody measured.
    const mixed = [...REAL, fill('e', 'buy', '100000000000000000', 5, '10000', 'AUSD')];
    expect(basisFromActivity(mixed).has('MON')).toBe(false);
  });

  it('does not start a basis from a sell — that token was acquired some other way', () => {
    expect(basisFromActivity([fill('s', 'sell', '100000000000000000', 1)]).has('MON')).toBe(false);
  });

  it('drops a basis that has been sold down to nothing', () => {
    const flat = [
      fill('b1', 'buy', '1000000000000000000', 1),
      fill('s1', 'sell', '1000000000000000000', 2),
    ];
    expect(basisFromActivity(flat).has('MON')).toBe(false);
  });
});

describe('valuing a holding against its basis', () => {
  const basis = basisFromActivity(REAL).get('MON')!;

  it('values what is held at the live price and reports the change', () => {
    // One MON at 0.026076 USDC is the real MON/USDC bid read at block 103,110,791.
    const priceWire = 26_076_000_000_000_000n;
    const change = changeFor(basis, basis.quantity, priceWire);
    expect(change).toBeDefined();
    expect(change!.value).toBeGreaterThan(0n);
    expect(change!.change).toBe(change!.value - change!.cost);
    expect(change!.quoteSymbol).toBe('USDC');
  });

  it('refuses to value a holding the fills do not fully account for', () => {
    // Twice what was ever bought: half of it arrived by deposit or transfer, and
    // pricing that half at zero would invent a profit.
    expect(changeFor(basis, basis.quantity * 2n, 26_076_000_000_000_000n)).toBeUndefined();
  });

  it('refuses to value anything without a live price', () => {
    expect(changeFor(basis, basis.quantity, undefined)).toBeUndefined();
    expect(changeFor(basis, basis.quantity, 0n)).toBeUndefined();
  });

  it('has no answer for a token with no basis at all', () => {
    expect(changeFor(undefined, 1n, 26_076_000_000_000_000n)).toBeUndefined();
  });

  it('prices a partial holding at the running average, never at the whole cost', () => {
    const half = basis.quantity / 2n;
    const whole = changeFor(basis, basis.quantity, 26_076_000_000_000_000n)!;
    const part = changeFor(basis, half, 26_076_000_000_000_000n)!;
    // Half the quantity carries half the cost, to within the integer division.
    expect(part.cost).toBeGreaterThan(whole.cost / 2n - 2n);
    expect(part.cost).toBeLessThan(whole.cost / 2n + 2n);
  });
});

describe('formatBps', () => {
  it('signs both directions and keeps two decimals', () => {
    expect(formatBps(250n)).toBe('+2.50%');
    expect(formatBps(-1234n)).toBe('-12.34%');
    expect(formatBps(0n)).toBe('+0.00%');
  });
});
