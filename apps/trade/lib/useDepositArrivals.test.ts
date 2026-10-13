import { describe, expect, it } from 'vitest';
import { resolution, summaryFor, type WireDeposit } from './useDepositArrivals';

/**
 * The toast's "is this done, and how" used to be its own judgment — the vendor's
 * `terminalStatus` word, read nowhere else. `DepositProgress`'s stepper read a
 * different one, `deriveTrackerState`'s chain-evidence-first derivation. The two
 * disagreeing is exactly what happened in production on 2026-10-08: the toast fired
 * off a vendor SUCCESS while the open stepper sat on step 1, waiting on a push that
 * never arrived. This file tests that the toast now reads the state the stepper
 * reads — `resolution()`/`summaryFor()`, extracted from `useDepositArrivals` for
 * exactly this (D202).
 */

const BASE: WireDeposit = {
  depositAddress: 'AmRKSc6fbvA6YSsrVRVHkDgEW2xiD7qxSu14wrstUaFR',
  amountIn: '1150000000',
  chain: 'Solana',
  createdAt: Date.now() - 10 * 60_000,
  expiresAt: Date.now() + 3 * 24 * 60 * 60 * 1000,
  lastStatus: 'PROCESSING',
  terminalStatus: null,
  terminalAt: null,
  sourceLandedAt: null,
  sourceTxHash: null,
  sourceEvidenceSource: null,
  sourceTxAt: null,
  etaSeconds: 24,
  landsIn: 'wallet',
  destinationTxHash: null,
  destinationTxBlock: null,
  destinationEvidenceSource: null,
  destinationDetectedAt: null,
  amountOut: null,
  refundTxHash: null,
  refundExplorerUrl: null,
  refundReason: null,
  refundAmount: null,
  refundTo: 'SomeDeclaredSolanaAddressXXXXXXXXXXXXXXXXXX',
  originSymbol: 'USDC',
  originDecimals: 6,
};

describe('useDepositArrivals: one definition of "resolved", shared with the stepper', () => {
  it('vendor still says PROCESSING, but the chain proved delivery: the toast fires, from the same evidence the stepper would show "done" from', () => {
    const d: WireDeposit = {
      ...BASE,
      lastStatus: 'PROCESSING',
      terminalStatus: null,
      destinationTxHash: '0xeed957cadbce5288dbdc9397b2628e7a045736160a4b127955ff479482843160',
      destinationEvidenceSource: 'balance-poll',
      destinationDetectedAt: Date.now(),
      amountOut: '1146807',
    };
    const { done, state } = resolution(d);
    expect(done).toBe(true);
    expect(state.terminal).toBeUndefined();
    expect(state.steps.find((s) => s.id === 4)?.status).toBe('done');
    expect(summaryFor(d, state)).toBe('Received 1.146807 USDC from Solana');
  });

  it('nothing has landed yet, and the vendor has not finished: not resolved, no toast', () => {
    const { done } = resolution(BASE);
    expect(done).toBe(false);
  });

  it('a second read of the identical row — the second-tab/reload case — derives the same answer', () => {
    const d: WireDeposit = {
      ...BASE,
      destinationTxHash: '0xabc',
      destinationEvidenceSource: 'eth_getTransactionReceipt',
      destinationDetectedAt: Date.now(),
      amountOut: '500000',
    };
    const first = resolution(d);
    const second = resolution(d);
    expect(second.done).toBe(first.done);
    expect(summaryFor(d, second.state)).toBe(summaryFor(d, first.state));
  });

  it('a refund seen on chain resolves as refunded, not as received, even if the vendor word is stale', () => {
    const d: WireDeposit = {
      ...BASE,
      terminalStatus: 'REFUNDED',
      refundTxHash: '0xrefund',
      refundReason: 'minimum swap amount not met',
    };
    const { done, state } = resolution(d);
    expect(done).toBe(true);
    expect(state.terminal?.kind).toBe('REFUNDED');
    expect(summaryFor(d, state)).toBe('Deposit from Solana refunded');
  });

  it('chain evidence of delivery outranks a stale vendor FAILED — still resolves as received', () => {
    const d: WireDeposit = {
      ...BASE,
      terminalStatus: 'FAILED',
      destinationTxHash: '0xdelivered-anyway',
      destinationEvidenceSource: 'balance-poll',
      destinationDetectedAt: Date.now(),
      amountOut: '500000',
    };
    const { done, state } = resolution(d);
    expect(done).toBe(true);
    expect(state.terminal).toBeUndefined();
    expect(summaryFor(d, state)).toBe('Received 0.500000 USDC from Solana');
  });
});
