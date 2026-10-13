import { describe, expect, it } from 'vitest';
import { isStuck, STUCK_FALLBACK_ETA_SECONDS, stuckThresholdMs } from './stuck.js';

const base = { sourceConfirmed: true, etaSeconds: 24, lastChangeAt: 0, delivered: false, refunded: false };

describe('isStuck: the owner rule', () => {
  it('fires at 3 times the quoted ETA with no change, and not a millisecond before', () => {
    expect(isStuck({ ...base, now: 72_000 - 1 })).toBe(false);
    expect(isStuck({ ...base, now: 72_000 })).toBe(true);
  });

  it('needs the funds confirmed on the source chain', () => {
    expect(isStuck({ ...base, sourceConfirmed: false, now: 10_000_000 })).toBe(false);
  });

  it('is never stuck once either chain shows the outcome', () => {
    expect(isStuck({ ...base, delivered: true, now: 10_000_000 })).toBe(false);
    expect(isStuck({ ...base, refunded: true, now: 10_000_000 })).toBe(false);
  });

  it('a vendor that quoted no ETA is judged against the recorded fallback', () => {
    expect(stuckThresholdMs(null)).toBe(STUCK_FALLBACK_ETA_SECONDS * 3 * 1000);
    expect(isStuck({ ...base, etaSeconds: null, now: stuckThresholdMs(null) })).toBe(true);
  });
});
