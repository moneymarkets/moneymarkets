import { describe, expect, it } from 'vitest';
import { isTradable, normalizeBook } from './book.js';
import type { MarketParams } from './params.js';
import type { Address } from 'viem';

/**
 * The book the owner was told was crossed, and was not (2026-09-10).
 *
 * Their screenshot showed bids topping out at 0.023356 against asks starting at
 * 0.023368 — a healthy 12-tick spread — while the ticket refused to enable with "bid
 * at or above the best ask". The cause was a `Normal / Stale / Crossed` preview control
 * shipped on the live trade screen, which swapped the two sides before normalisation;
 * I1 then did exactly what it should with the values it was handed.
 *
 * The control is gone. These tests pin the two halves of that so it cannot come back
 * quietly: a healthy book is never flagged, and a genuinely crossed one always is.
 * They also re-assert the ask-ordering assumption the owner asked about, because it is
 * the same class of bug as the descending-asks and no-bid-sentinel ones.
 */

const params: MarketParams = {
  pricePrecision: 100_000_000n,
  sizePrecision: 10_000_000_000n,
  baseAsset: '0x0000000000000000000000000000000000000000' as Address,
  baseDecimals: 18,
  quoteAsset: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603' as Address,
  quoteDecimals: 6,
  tickSize: 100n,
  minSize: 2_000_000_000_000n,
  maxSize: 2_000_000_000_000_000_000n,
  takerFeeBps: 0n,
  makerFeeBps: 0n,
  vault: '0x0000000000000000000000000000000000000000' as Address,
  vaultBestBid: 0n,
  vaultBestAsk: 0n,
  bidPartiallyFilledSize: 0n,
  askPartiallyFilledSize: 0n,
  vaultBidOrderSize: 0n,
  vaultAskOrderSize: 0n,
  spread: 0n,
};

const MARKET = '0x065C9d28E428A0db40191a54d33d5b7c71a9C394' as Address;

/** The owner's screenshot, in `pricePrecision` units as `getL2Book()` returns them. */
const BIDS: [string, string][] = [
  ['2335600', '1066470000000000'],
  ['2334000', '86753513544914'],
  ['2330000', '216883783862286'],
];
const ASKS: [string, string][] = [
  ['2336800', '1066470000000000'],
  ['2337400', '86753513544914'],
  ['2340000', '216883783862286'],
];

function book(over: { bids?: [string, string][]; asks?: [string, string][]; bestBid?: bigint; bestAsk?: bigint } = {}) {
  return normalizeBook({
    market: MARKET,
    source: 'contract-getL2Book',
    state: 'finalized',
    params,
    bids: (over.bids ?? BIDS).map(([price, size]) => ({ price, size })),
    asks: (over.asks ?? ASKS).map(([price, size]) => ({ price, size })),
    // 1e18 wire scale, as `bestBidAsk()` reports.
    bestBid: over.bestBid ?? 23_356_000_000_000_000n,
    bestAsk: over.bestAsk ?? 23_368_000_000_000_000n,
    blockNumber: 103_667_655n,
    receivedAt: Date.now(),
  });
}

describe('the book from the 2026-09-10 report', () => {
  it('is valid: 0.023356 bid under a 0.023368 ask is a spread, not a cross', () => {
    const b = book();
    expect(b.validity).toBe('ok');
    expect(b.invalidReason).toBeUndefined();
    expect(isTradable(b)).toBe(true);
  });

  it('is still valid when the asks arrive descending', () => {
    // I2: input order is never trusted. The SDK hands asks back descending while the
    // contract hands them ascending, and either must normalise to the same book.
    const b = book({ asks: [...ASKS].reverse() });
    expect(b.validity).toBe('ok');
    expect(b.asks[0]?.price).toBeLessThan(b.asks[1]?.price ?? 0n);
    expect(isTradable(b)).toBe(true);
  });

  it('is still valid when the bids arrive ascending', () => {
    const b = book({ bids: [...BIDS].reverse() });
    expect(b.validity).toBe('ok');
    expect(b.bids[0]?.price).toBeGreaterThan(b.bids[1]?.price ?? 0n);
  });

  it('takes best bid and ask from the payload, not from the level arrays', () => {
    // `bestBidAsk()` is the contract's own answer and outranks the depth snapshot,
    // which can be a block behind. Passing a deliberately different level set must
    // not move them.
    const b = book({ bids: [['2000000', '1']], asks: [['9000000', '1']] });
    expect(b.bestBid).toBe(23_356_000_000_000_000n);
    expect(b.bestAsk).toBe(23_368_000_000_000_000n);
  });
});

describe('a genuinely crossed book is still rejected', () => {
  it('flags bid above ask, and says so with the values', () => {
    const b = book({ bestBid: 23_368_000_000_000_000n, bestAsk: 23_356_000_000_000_000n });
    expect(b.validity).toBe('INVALID');
    expect(b.invalidReason).toContain('23368000000000000');
    expect(b.invalidReason).toContain('23356000000000000');
    expect(isTradable(b)).toBe(false);
  });

  it('flags bid exactly equal to ask', () => {
    const same = 23_360_000_000_000_000n;
    expect(book({ bestBid: same, bestAsk: same }).validity).toBe('INVALID');
  });

  it('carries the numbers so a false positive can be disproved by reading it', () => {
    // The whole point of item 1d: "Market data invalid" alone gave the reader nothing
    // to check, so a wrong refusal looked exactly like a right one.
    const reason = book({ bestBid: 2n, bestAsk: 1n }).invalidReason ?? '';
    expect(reason).toMatch(/best bid 2 .*best ask 1/);
  });
});

describe('a one-sided book is not a crossed book', () => {
  it('does not flag a missing ask as crossed', () => {
    const b = book({ bestAsk: 0n, asks: [] });
    expect(b.validity).toBe('ok');
    // Not crossed, but not tradable either — there is nothing to buy from.
    expect(isTradable(b)).toBe(false);
  });

  it('does not flag a missing bid as crossed', () => {
    const b = book({ bestBid: 0n, bids: [] });
    expect(b.validity).toBe('ok');
    expect(isTradable(b)).toBe(false);
  });
});
