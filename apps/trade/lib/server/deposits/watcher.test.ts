import { describe, expect, it } from 'vitest';
import { destinationTxFrom, refundTxFrom } from './watcher.js';

/**
 * `refundTxFrom` was extracted after a real bug: a still-`PROCESSING` deposit
 * (`0xAeef0976A19cFF37f4f0C402AFE0802378C63f4C`, investigated 2026-09-04) showed a
 * `refundTxHash` even though nothing had been refunded, because the old code read
 * `originChainTxHashes`'s last entry unconditionally. That array's one entry on a
 * non-refunded deposit is the deposit's own transaction, not a refund.
 *
 * The two-entry fixture below mirrors a real refunded payload
 * (`Cz8YGBvhH2m9Js55mWY1Q4AYYqH8FgW2mXG2mLLP9AoJ`): deposit tx first, refund tx
 * second.
 */

const depositTx = { hash: 'deposit-tx-hash', explorerUrl: 'https://example/deposit' };
const refundTx = { hash: 'refund-tx-hash', explorerUrl: 'https://example/refund' };

describe('refundTxFrom', () => {
  it('is undefined for a non-terminal status, even with a tx hash present', () => {
    expect(refundTxFrom('PROCESSING', { originChainTxHashes: [depositTx] })).toBeUndefined();
  });

  it('is undefined for SUCCESS — the one entry present is the deposit, not a refund', () => {
    expect(refundTxFrom('SUCCESS', { originChainTxHashes: [depositTx] })).toBeUndefined();
  });

  it('is undefined for FAILED with only a deposit tx recorded', () => {
    expect(refundTxFrom('FAILED', { originChainTxHashes: [depositTx] })).toBeUndefined();
  });

  it('is the second entry for REFUNDED once a genuine refund tx has been appended', () => {
    expect(refundTxFrom('REFUNDED', { originChainTxHashes: [depositTx, refundTx] })).toEqual(
      refundTx,
    );
  });

  it('is undefined when swapDetails is missing entirely', () => {
    expect(refundTxFrom('REFUNDED', undefined)).toBeUndefined();
  });

  it('is undefined when originChainTxHashes is absent', () => {
    expect(refundTxFrom('REFUNDED', {})).toBeUndefined();
  });
});

/**
 * `destinationTxFrom` — item 5b's "Delivered" rows need the Monad transaction that
 * actually credited the recipient, which `deposit_attempts` never stored before
 * this pass. Same discipline as `refundTxFrom`: the hash is real only once the
 * status it belongs to is real.
 */
const destinationTx = { hash: 'destination-tx-hash', explorerUrl: 'https://example/destination' };

describe('destinationTxFrom', () => {
  it('is undefined for a non-terminal status, even with a tx hash present', () => {
    expect(
      destinationTxFrom('PROCESSING', { destinationChainTxHashes: [destinationTx] }),
    ).toBeUndefined();
  });

  it('is undefined for REFUNDED — nothing was delivered on Monad', () => {
    expect(
      destinationTxFrom('REFUNDED', { destinationChainTxHashes: [destinationTx] }),
    ).toBeUndefined();
  });

  it('is the entry for SUCCESS', () => {
    expect(destinationTxFrom('SUCCESS', { destinationChainTxHashes: [destinationTx] })).toEqual(
      destinationTx,
    );
  });

  it('is undefined when swapDetails is missing entirely', () => {
    expect(destinationTxFrom('SUCCESS', undefined)).toBeUndefined();
  });

  it('is undefined when destinationChainTxHashes is absent', () => {
    expect(destinationTxFrom('SUCCESS', {})).toBeUndefined();
  });
});
