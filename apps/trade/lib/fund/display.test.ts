import { describe, expect, it } from 'vitest';
import { quoteEconomics, sameAssetFee } from '@tradepro/core';
import { feeLine, percent, routeStateLine } from './display.js';

const USDC = { symbol: 'USDC', decimals: 6 };

/** The live 5 USDC Base quote, captured 2026-09-03. */
const BASE_5_USDC = {
  quote: {
    amountIn: '5000000',
    amountInUsd: '4.999045000000',
    amountOut: '4993320',
    amountOutUsd: '4.992366275880',
    minAmountOut: '4943386',
    refundFee: '2400',
    withdrawFee: '667',
  },
};

describe('the fee is rendered as money', () => {
  it('shows the exact unit fee for a same-asset route', () => {
    const e = quoteEconomics(BASE_5_USDC);
    const feeExact = sameAssetFee(e, 6, 6, 'USDC', 'USDC') ?? null;
    expect(feeLine({ feeExact, feeUsd: e.feeUsd ?? null, destination: USDC })).toBe('0.0066 USDC');
  });

  it('falls back to dollars when the two sides are different assets', () => {
    const e = quoteEconomics(BASE_5_USDC);
    expect(feeLine({ feeExact: null, feeUsd: e.feeUsd ?? null, destination: USDC })).toBe(
      '$0.0066',
    );
  });

  it('says the fee is inside the amount rather than printing a number nobody computed', () => {
    expect(feeLine({ feeExact: null, feeUsd: null, destination: USDC })).toBe(
      'Included in the amount below',
    );
  });

  it('never renders a fee in basis points', () => {
    const e = quoteEconomics(BASE_5_USDC);
    for (const line of [
      feeLine({ feeExact: 6_680n, feeUsd: e.feeUsd ?? null, destination: USDC }),
      feeLine({ feeExact: null, feeUsd: e.feeUsd ?? null, destination: USDC }),
      feeLine({ feeExact: null, feeUsd: null, destination: USDC }),
    ]) {
      expect(line).not.toMatch(/bps/i);
    }
  });
});

describe('slippage reads as a percentage', () => {
  it('turns 100 bps into 1.0%, not 10.0% and not 100 bps', () => {
    expect(percent(100n)).toBe('1.0%');
  });

  it('keeps one decimal at every size', () => {
    expect(percent(0n)).toBe('0.0%');
    expect(percent(5n)).toBe('0.0%'); // half a basis point rounds down, not up
    expect(percent(10n)).toBe('0.1%');
    expect(percent(25n)).toBe('0.2%');
    expect(percent(9008n)).toBe('90.0%');
    expect(percent(10_000n)).toBe('100.0%');
  });
});

describe('routeStateLine — the tile never states a minimum', () => {
  /**
   * It used to render "Minimum right now: $1,000 — set by the solver network,
   * temporary" from a floor parsed out of one refusal and cached per route. That
   * pre-judged what the user was allowed to type, and blocked amounts 1Click would
   * have priced. Removed at the owner's instruction, 2026-09-09: the tile says only
   * whether the route is answering, and the network's own sentence is rendered
   * verbatim beneath the grid.
   */
  it('says a declined route is declined, without naming a floor', () => {
    const line = routeStateLine({
      state: 'unavailable',
      message: 'Temporary swap limits: minimum swap amount is $1,000',
    });
    expect(line).toBe('Declined by the solver network right now');
    expect(line).not.toMatch(/minimum|\$1,000/i);
  });

  it('says nothing at all for an available, unprobed or unknown route', () => {
    expect(routeStateLine({ state: 'available' })).toBeUndefined();
    expect(routeStateLine({ state: 'unprobed', message: 'timeout' })).toBeUndefined();
    expect(routeStateLine(undefined)).toBeUndefined();
  });
});
