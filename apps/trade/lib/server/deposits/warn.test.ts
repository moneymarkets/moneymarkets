import { describe, expect, it, vi } from 'vitest';

/**
 * "Update the threshold from real outcomes, not a hardcoded guess" (D105 item 4, as
 * amended by the 2026-09-08 error-handling rule: the $5 starting default was itself
 * a hardcoded guess and is gone — no refund evidence means no threshold at all).
 *
 * `depositDb()` is a module-level singleton, so it is mocked here rather than
 * exercised through a real file — this file is about the threshold *logic*, not the
 * database, which `db.test.ts` already covers directly.
 */

const recentRefundedUsdAmounts = vi.fn<(sourceKey: string, sampleSize?: number) => bigint[]>();
vi.mock('./db.js', () => ({
  depositDb: () => ({ recentRefundedUsdAmounts }),
}));

const { warningThreshold, formatUsd } = await import('./warn.js');

describe('warningThreshold', () => {
  it('has NO threshold when there is no refund history — no invented $5 default', () => {
    // The old default warned about amounts under $5 on the strength of nothing.
    // A threshold either comes from real refund outcomes or does not exist.
    recentRefundedUsdAmounts.mockReturnValue([]);
    expect(warningThreshold('sol-solana')).toBeUndefined();
  });

  it('is the largest recently-refunded amount once there is real history', () => {
    recentRefundedUsdAmounts.mockReturnValue([1_013_200n, 1_014_700n]);
    const t = warningThreshold('sol-solana');
    expect(t).toEqual({ usd: 1_014_700n, sampleSize: 2 });
  });

  it('is never smaller than the true worst case among the sample', () => {
    recentRefundedUsdAmounts.mockReturnValue([9_000_000n, 1_000n, 3_000_000n]);
    expect(warningThreshold('usdc-base')?.usd).toBe(9_000_000n);
  });
});

describe('formatUsd', () => {
  it('renders whole-dollar and cents correctly', () => {
    expect(formatUsd(5_000_000n)).toBe('$5.00');
    expect(formatUsd(1_013_200n)).toBe('$1.01');
    expect(formatUsd(0n)).toBe('$0.00');
  });
});
