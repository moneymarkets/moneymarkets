import { describe, expect, it } from 'vitest';
import {
  HEARTBEAT_MS,
  isStale,
  isTradable,
  normalizeBook,
  type MarketParams,
} from '@tradepro/core';
import { getAddress } from 'viem';

/**
 * I6 is measured against the browser's own last successful read, never against the
 * block timestamp.
 *
 * That is not a style preference at Monad's measured numbers. Fifteen reads of
 * MON/AUSD against `https://rpc.monad.xyz` on 2026-09-02 gave a **block age at read**
 * of p50 2.7 s and p95 5.0 s — the app reads the finalized tip on purpose and says so
 * on the chip. Comparing that age to a 3 s heartbeat would grey out a perfectly
 * healthy book on most polls. These tests pin the clock so a future refactor cannot
 * quietly swap it.
 */

const MARKET = getAddress('0x131a2e70a5b31a517a74b8c567149bc294470da9');

/** MON/AUSD, read from `getMarketParams()` on 2026-09-02. */
const PARAMS: MarketParams = {
  pricePrecision: 100_000_000n,
  sizePrecision: 10_000_000_000n,
  baseAsset: '0x0000000000000000000000000000000000000000',
  baseDecimals: 18,
  quoteAsset: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a',
  quoteDecimals: 6,
  tickSize: 100n,
  minSize: 2_000_000_000_000n,
  maxSize: 20_000_000_000_000_000_000n,
  takerFeeBps: 0n,
  makerFeeBps: 0n,
};

/** A real reading of MON/AUSD, 2026-09-02. */
function book(receivedAt: number, { crossed = false } = {}) {
  const bestBid = 25_442_000_000_000_000n;
  const bestAsk = 25_952_000_000_000_000n;
  return normalizeBook({
    market: MARKET,
    source: 'contract-getL2Book',
    state: 'finalized',
    params: PARAMS,
    bids: [{ price: '2544200', size: '3760000000000' }],
    asks: [{ price: '2595200', size: '3695244139753' }],
    bestBid: crossed ? bestAsk : bestBid,
    bestAsk: crossed ? bestBid : bestAsk,
    blockNumber: 101_345_599n,
    receivedAt,
  });
}

describe('I6 — the staleness clock', () => {
  const now = 1_788_356_000_000;

  it('is fresh at the measured p95 finality lag of 5.0 s, because that is not our clock', () => {
    // A block five seconds old, fetched 200 ms ago, is a healthy feed.
    expect(isStale(book(now - 200), now)).toBe(false);
    expect(isTradable(book(now - 200), now)).toBe(true);
  });

  it('goes stale three missed polls after our own last read', () => {
    expect(isStale(book(now - (HEARTBEAT_MS - 1)), now)).toBe(false);
    expect(isStale(book(now - (HEARTBEAT_MS + 1)), now)).toBe(true);
    expect(isTradable(book(now - (HEARTBEAT_MS + 1)), now)).toBe(false);
  });

  it('does not read a block timestamp at all — the payload carries only a number', () => {
    const b = book(now);
    expect(b.blockNumber).toBe(101_345_599n);
    expect(Object.keys(b)).not.toContain('blockTimestamp');
  });
});

describe('I1 — a crossed book', () => {
  it('is INVALID and untradable however fresh it is', () => {
    const now = 1_788_356_000_000;
    const crossed = book(now, { crossed: true });
    expect(crossed.validity).toBe('INVALID');
    expect(isStale(crossed, now)).toBe(false);
    expect(isTradable(crossed, now)).toBe(false);
  });
});
