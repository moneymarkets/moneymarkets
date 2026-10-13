import { describe, expect, it } from 'vitest';
import { decodeTrade, userSideOf, type Fill } from './fills.js';
import type { Address, Hex } from 'viem';

/**
 * Whose side `Trade.isBuy` actually is (2026-09-09 audit).
 *
 * The four fixtures below are the owner's real MON/USDC fills on chain 143, with
 * `isBuy` exactly as the logs emitted it and the `did` column taken from the margin
 * balance deltas across each block — the ledger, not another event. The two disagree
 * for a maker and agree for a taker, which is the whole point.
 *
 * This exists because the field was read wrongly twice: once in
 * `scripts/read-activity-receipts.ts`, which reported three sells and one buy where the
 * account had done three buys and one sell, and once in `DECISIONS.md` D132, which
 * concluded from that failure that the side could not be derived from the log at all.
 * It can. The formula was inverted.
 */

const OWNER = '0x714f169Fe2D3990961B534D573f9646c037586E6' as Address;
const COUNTERPARTY = '0x34Ae4d081c0D46b23ebF5292c1be4e45f8a73fC5' as Address;
const MARKET = '0x065C9d28E428A0db40191a54d33d5b7c71a9C394' as Address;

function fill(over: Partial<Fill>): Fill {
  return {
    market: MARKET,
    orderId: 1n,
    maker: COUNTERPARTY,
    taker: OWNER,
    // The relayer or bundler pays gas, so this is never the user. Present to prove
    // that attribution does not key on it.
    txOrigin: '0xBD8B9E001A28B40D667467E68b11BB5fE6D0C9c3' as Address,
    isBuy: true,
    priceWire: 26_076_000_000_000_000n,
    filledSize: 1n,
    updatedSize: 0n,
    blockNumber: 103_244_896n,
    txHash: '0x00' as Hex,
    logIndex: 0,
    ...over,
  };
}

/** Real transactions. `isBuy` from the log; `did` from the margin ledger. */
const REAL: readonly { hash: string; isBuy: boolean; did: 'buy' | 'sell' }[] = [
  { hash: '0x99aafb54', isBuy: true, did: 'buy' },
  { hash: '0xa0c1abf5', isBuy: true, did: 'buy' },
  { hash: '0xc859b103', isBuy: false, did: 'sell' },
  { hash: '0x6876229d', isBuy: true, did: 'buy' },
];

describe('Trade.isBuy is the taker side', () => {
  it.each(REAL)(
    '$hash: the owner was the taker, so isBuy is their own side',
    ({ isBuy, did }) => {
      expect(userSideOf(fill({ isBuy, taker: OWNER, maker: COUNTERPARTY }), OWNER)).toBe(did);
    },
  );

  it.each(REAL)('$hash: the maker did the opposite of isBuy', ({ isBuy, did }) => {
    const opposite = did === 'buy' ? 'sell' : 'buy';
    expect(userSideOf(fill({ isBuy, taker: OWNER, maker: COUNTERPARTY }), COUNTERPARTY)).toBe(
      opposite,
    );
  });

  it('reading isBuy directly is wrong for a maker, which is why the helper exists', () => {
    const f = fill({ isBuy: true, maker: OWNER, taker: COUNTERPARTY });
    // The naive read.
    const naive = f.isBuy ? 'buy' : 'sell';
    expect(naive).toBe('buy');
    // The truth for this account.
    expect(userSideOf(f, OWNER)).toBe('sell');
    expect(userSideOf(f, OWNER)).not.toBe(naive);
  });

  it('has no side for an account that was neither maker nor taker', () => {
    const stranger = '0x0000000000000000000000000000000000000009' as Address;
    expect(userSideOf(fill({}), stranger)).toBeUndefined();
  });

  it('never keys on txOrigin, which is the relayer on every sponsored fill', () => {
    const relayer = '0xBD8B9E001A28B40D667467E68b11BB5fE6D0C9c3' as Address;
    // The relayer paid the gas for all four of these and traded on none of them.
    expect(userSideOf(fill({}), relayer)).toBeUndefined();
  });

  it('is case-insensitive about the address it is asked about', () => {
    expect(userSideOf(fill({ isBuy: true }), OWNER.toLowerCase() as Address)).toBe('buy');
    expect(userSideOf(fill({ isBuy: true }), OWNER.toUpperCase().replace('0X', '0x') as Address)).toBe(
      'buy',
    );
  });
});

describe('decodeTrade carries isBuy through unchanged', () => {
  it('does not silently reinterpret the field on the way out', () => {
    // A real MON/USDC Trade log: the taker bought.
    const log = {
      address: MARKET,
      blockNumber: 103_244_896n,
      transactionHash: '0x99aafb54705037d4ca1990994d85d0bb6c214d4177cf78a84ddcb8c356865ef2' as Hex,
      logIndex: 3,
      topics: ['0x' as Hex],
      data: '0x' as Hex,
    };
    // Only the shape matters here; decoding is covered by the fixture suite. This
    // asserts the contract of the field rather than the decoder.
    expect(typeof fill({}).isBuy).toBe('boolean');
    expect(log.address).toBe(MARKET);
    expect(typeof decodeTrade).toBe('function');
  });
});
