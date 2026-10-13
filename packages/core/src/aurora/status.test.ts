import { describe, expect, it } from 'vitest';
import {
  asSwapStatus,
  expiryFrom,
  isRequotable,
  isTerminalSwapStatus,
  oneClickStatusSchema,
  statusUrl,
  SWAP_STATUSES,
  swapStepIndex,
  UNKNOWN_SWAP_STATUS,
} from './status.js';

/**
 * The fixture is a verbatim `GET /v0/status` response, taken 2026-09-03 for the real
 * deposit address `0x3fE42be9…` that this build reserved for USDC on Base. It is
 * trimmed of nothing that the parser reads.
 */
const LIVE_PENDING = {
  status: 'PENDING_DEPOSIT',
  updatedAt: '2026-09-03T05:36:47.170Z',
  correlationId: 'fba38e8b-5668-4110-9d5a-348f587daa04',
  swapDetails: {
    depositedAmount: null,
    depositedAmountUsd: null,
    depositedAmountFormatted: null,
    intentHashes: [],
    nearTxHashes: [],
    amountIn: null,
    amountOut: null,
    refundedAmount: '0',
    refundedAmountFormatted: '0',
    refundReason: null,
    refundFee: '2400',
    withdrawFee: '668',
    originChainTxHashes: [],
    destinationChainTxHashes: [],
  },
};

describe('the live status payload', () => {
  it('parses the shape the network actually sent', () => {
    const parsed = oneClickStatusSchema.parse(LIVE_PENDING);
    expect(parsed.status).toBe('PENDING_DEPOSIT');
    expect(parsed.swapDetails?.depositedAmount).toBeNull();
  });

  it('addresses the status endpoint by deposit address', () => {
    expect(statusUrl('0x3fE42be94203712CE95d4fAdF83f83E0784e478e')).toBe(
      'https://1click.chaindefuser.com/v0/status?depositAddress=0x3fE42be94203712CE95d4fAdF83f83E0784e478e',
    );
  });
});

describe('a status this build has not seen is not a crash', () => {
  it('names it UNKNOWN rather than throwing', () => {
    expect(asSwapStatus('SOMETHING_NEW')).toBe(UNKNOWN_SWAP_STATUS);
  });

  it('treats it as in flight, not as finished', () => {
    // "We do not know" must never be drawn as "it is over".
    expect(isTerminalSwapStatus(UNKNOWN_SWAP_STATUS)).toBe(false);
    expect(swapStepIndex(UNKNOWN_SWAP_STATUS)).toBe(2);
  });

  it('keeps every documented status', () => {
    for (const s of [
      'PENDING_DEPOSIT',
      'KNOWN_DEPOSIT_TX',
      'INCOMPLETE_DEPOSIT',
      'PROCESSING',
      'SUCCESS',
      'REFUNDED',
      'FAILED',
    ] as const) {
      expect(SWAP_STATUSES).toContain(s);
      expect(asSwapStatus(s)).toBe(s);
    }
  });
});

describe('EXPIRED is not a dead end', () => {
  it('is non-terminal and recovers by re-quoting', () => {
    expect(isTerminalSwapStatus('EXPIRED')).toBe(false);
    expect(isRequotable('EXPIRED')).toBe(true);
  });

  it('is the only status that recovers by re-quoting', () => {
    for (const s of SWAP_STATUSES) {
      if (s !== 'EXPIRED') expect(isRequotable(s), s).toBe(false);
    }
  });

  it('sits at the first step, because nothing ever arrived', () => {
    expect(swapStepIndex('EXPIRED')).toBe(0);
  });

  it('is derived from the deadline rather than waited for', () => {
    // The published enum has no EXPIRED. The window still closes, so the app works
    // it out from the deadline the quote carried.
    expect(expiryFrom('PENDING_DEPOSIT', 1_000, 999)).toBe('PENDING_DEPOSIT');
    expect(expiryFrom('PENDING_DEPOSIT', 1_000, 1_000)).toBe('EXPIRED');
  });

  it('stops mattering once a deposit has been seen', () => {
    // Money is in flight; the deadline for *starting* is irrelevant now.
    expect(expiryFrom('KNOWN_DEPOSIT_TX', 1_000, 9_999)).toBe('KNOWN_DEPOSIT_TX');
    expect(expiryFrom('PROCESSING', 1_000, 9_999)).toBe('PROCESSING');
  });

  it('leaves the status alone when no deadline is known', () => {
    expect(expiryFrom('PENDING_DEPOSIT', undefined, 9_999)).toBe('PENDING_DEPOSIT');
  });
});

describe('the five steps of design 5.3', () => {
  it('only lights "ready to trade" on a delivered swap', () => {
    // SUCCESS means the solver network delivered into the WALLET. The last two steps
    // are claims about the margin account, and only a chain read can make them.
    expect(swapStepIndex('SUCCESS')).toBe(2);
    expect(swapStepIndex('SUCCESS', { moveConfirmed: true, marginIncreased: false })).toBe(3);
    expect(swapStepIndex('SUCCESS', { moveConfirmed: true, marginIncreased: true })).toBe(4);
    for (const s of SWAP_STATUSES) {
      // Nothing the swap alone reports may reach step 4; that needs settlement.
      expect(swapStepIndex(s), s).toBeLessThan(4);
    }
  });

  it('does not advance a refund or a failure past where it stopped', () => {
    expect(swapStepIndex('REFUNDED')).toBe(2);
    expect(swapStepIndex('FAILED')).toBe(2);
  });

  it('treats a short deposit as received, because it was', () => {
    expect(swapStepIndex('INCOMPLETE_DEPOSIT')).toBe(1);
  });

  it('marks only the three outcomes terminal', () => {
    const terminal = SWAP_STATUSES.filter(isTerminalSwapStatus);
    expect([...terminal].sort()).toEqual(['FAILED', 'REFUNDED', 'SUCCESS']);
  });
});

describe('the last two steps are chain facts, not swap facts', () => {
  it('never ticks "Landing in your Kuru balance" on a delivered swap alone', () => {
    // The regression this guards: a delivered swap leaves USDC in the wallet. Ticking
    // step 3 there told the user their money was in the Kuru balance while it sat
    // untouched in their wallet and they had not moved anything.
    expect(swapStepIndex('SUCCESS')).toBeLessThan(3);
  });

  it('ticks step 3 only once the move transaction is confirmed', () => {
    expect(swapStepIndex('SUCCESS', { moveConfirmed: false, marginIncreased: false })).toBe(2);
    expect(swapStepIndex('SUCCESS', { moveConfirmed: true, marginIncreased: false })).toBe(3);
  });

  it('ticks "Ready to trade" only once the margin balance has actually risen', () => {
    expect(swapStepIndex('SUCCESS', { moveConfirmed: true, marginIncreased: false })).toBe(3);
    expect(swapStepIndex('SUCCESS', { moveConfirmed: true, marginIncreased: true })).toBe(4);
  });

  it('lets settlement carry the steps even if the swap status is unknown', () => {
    // The money is where the chain says it is, whatever the solver network reports.
    expect(swapStepIndex(UNKNOWN_SWAP_STATUS, { moveConfirmed: true, marginIncreased: true })).toBe(
      4,
    );
  });
});
