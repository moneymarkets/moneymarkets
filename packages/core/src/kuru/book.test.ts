import { describe, expect, it } from 'vitest';
import {
  HEARTBEAT_MS,
  isStale,
  isTradable,
  midPrice,
  normalizeBestBidAsk,
  normalizeBook,
  normalizePrice,
  normalizeSize,
  spreadPps,
  UnknownBookSourceError,
  type BookSource,
} from './book.js';
import {
  MONAD_DEPTH_FRAME,
  MON_AUSD_BEST_ASK,
  MON_AUSD_BEST_BID,
  MON_AUSD_MARKET,
  MON_AUSD_PARAMS,
  MON_AUSD_V4_5_CROSSED,
  SDK_DESCENDING_ASKS,
} from './__fixtures__/books.js';

const base = {
  market: MON_AUSD_MARKET,
  params: MON_AUSD_PARAMS,
  state: 'finalized' as const,
};

describe('I1 — bestBid must be below bestAsk', () => {
  it('marks the MON_AUSD_V4_5 crossed book INVALID', () => {
    const book = normalizeBook({
      ...base,
      source: MON_AUSD_V4_5_CROSSED.source,
      bids: MON_AUSD_V4_5_CROSSED.bids,
      asks: MON_AUSD_V4_5_CROSSED.asks,
    });
    expect(book.validity).toBe('INVALID');
    expect(book.invalidReason).toMatch(/crossed book/);
    // 0.0291 bid, 0.0041 ask, both lifted to the 1e18 wire scale.
    expect(book.bestBid).toBe(29_100_000_000_000_000n);
    expect(book.bestAsk).toBe(4_100_000_000_000_000n);
  });

  it('refuses to trade on a crossed book', () => {
    const book = normalizeBook({
      ...base,
      source: MON_AUSD_V4_5_CROSSED.source,
      bids: MON_AUSD_V4_5_CROSSED.bids,
      asks: MON_AUSD_V4_5_CROSSED.asks,
    });
    expect(isTradable(book)).toBe(false);
    expect(midPrice(book)).toBeUndefined();
    expect(spreadPps(book)).toBeUndefined();
  });

  it('treats bid == ask as crossed, not as a zero spread', () => {
    const book = normalizeBook({
      ...base,
      source: 'bestBidAsk',
      bids: [],
      asks: [],
      bestBid: 26_473_000_000_000_000n,
      bestAsk: 26_473_000_000_000_000n,
    });
    expect(book.validity).toBe('INVALID');
  });

  it('accepts the real MON/AUSD book read from the chain', () => {
    const book = normalizeBook({
      ...base,
      source: 'bestBidAsk',
      bids: [],
      asks: [],
      bestBid: MON_AUSD_BEST_BID,
      bestAsk: MON_AUSD_BEST_ASK,
    });
    expect(book.validity).toBe('ok');
    expect(midPrice(book)).toBe(26_212_500_000_000_000n);
    // (0.026473 - 0.025952) / 0.0262125 = 0.019876 = 19876 pps = 198.8 bps. The
    // AUSD book really is this wide (framework §4.1).
    expect(spreadPps(book)).toBe(19876n);
  });

  it('does not call a one-sided book crossed', () => {
    const oneSided = normalizeBook({
      ...base,
      source: 'bestBidAsk',
      bids: [],
      asks: [],
      bestBid: 0n,
      bestAsk: MON_AUSD_BEST_ASK,
    });
    expect(oneSided.validity).toBe('ok');
    expect(isTradable(oneSided)).toBe(false); // still not tradable: no bid
  });
});

describe('I2 — ordering is imposed, never inherited', () => {
  it('sorts asks ascending even when the source sorted them descending', () => {
    const book = normalizeBook({
      ...base,
      source: 'ws-monadDepth',
      bids: [],
      asks: SDK_DESCENDING_ASKS,
    });
    expect(book.asks.map((l) => l.price)).toEqual([
      26_473_000_000_000_000n,
      26_500_000_000_000_000n,
    ]);
    expect(book.bestAsk).toBe(26_473_000_000_000_000n);
  });

  it('produces the same book from ascending and descending ask input', () => {
    const asc = [...SDK_DESCENDING_ASKS].reverse();
    const a = normalizeBook({ ...base, source: 'ws-monadDepth', bids: [], asks: asc });
    const b = normalizeBook({
      ...base,
      source: 'ws-monadDepth',
      bids: [],
      asks: SDK_DESCENDING_ASKS,
    });
    expect(a.asks).toEqual(b.asks);
  });

  it('sorts bids descending', () => {
    const book = normalizeBook({
      ...base,
      source: 'ws-monadDepth',
      bids: [
        { price: 25_900_000_000_000_000n, size: 90_000_000_000n },
        { price: 25_952_000_000_000_000n, size: 150_000_000_000n },
      ],
      asks: [],
    });
    expect(book.bids.map((l) => l.price)).toEqual([
      25_952_000_000_000_000n,
      25_900_000_000_000_000n,
    ]);
  });
});

describe('I3 — price scale depends on the source', () => {
  it('passes 1e18 wire prices through unchanged', () => {
    for (const source of ['ws-monadDepth', 'rest-depth', 'bestBidAsk'] as BookSource[]) {
      expect(normalizePrice('26473000000000000', source, MON_AUSD_PARAMS)).toBe(
        26_473_000_000_000_000n,
      );
    }
  });

  it('lifts pseudo-symbol human decimals to the wire scale', () => {
    expect(normalizePrice('0.026473', 'pseudo-symbol-human', MON_AUSD_PARAMS)).toBe(
      26_473_000_000_000_000n,
    );
  });

  it('throws on an unknown source instead of guessing', () => {
    expect(() => normalizePrice('1', 'v5-something' as BookSource, MON_AUSD_PARAMS)).toThrow(
      UnknownBookSourceError,
    );
    expect(() =>
      normalizeBook({ ...base, source: 'v5-something' as BookSource, bids: [], asks: [] }),
    ).toThrow(UnknownBookSourceError);
  });

  it('rejects a human decimal arriving on a 1e18 source', () => {
    expect(() => normalizePrice('0.026473', 'ws-monadDepth', MON_AUSD_PARAMS)).toThrow(
      /integer string/,
    );
  });
});

describe('I4 — wire sizes are sizePrecision units, not 1e18', () => {
  it('converts a sizePrecision size to base units', () => {
    // sizePrecision 1e10, base decimals 18. 150000000000 units = 15 MON = 15e18 wei.
    expect(normalizeSize('150000000000', 'ws-monadDepth', MON_AUSD_PARAMS)).toBe(
      15_000_000_000_000_000_000n,
    );
  });

  it('does not treat a wire size as 1e18-scaled', () => {
    const wrong = 150_000_000_000n; // what a 1e18 reading would leave it at
    expect(normalizeSize('150000000000', 'ws-monadDepth', MON_AUSD_PARAMS)).not.toBe(wrong);
  });

  it('has no size to normalize for bestBidAsk', () => {
    expect(() => normalizeSize('1', 'bestBidAsk', MON_AUSD_PARAMS)).toThrow(/no sizes/);
  });
});

describe('I5 — @monadDepth frames are keyed by market address', () => {
  it('carries the market address in `s`, not a symbol', () => {
    expect(MONAD_DEPTH_FRAME.s).toBe(MON_AUSD_MARKET);
    expect(MONAD_DEPTH_FRAME.s.startsWith('0x')).toBe(true);
    expect(MONAD_DEPTH_FRAME.s).not.toMatch(/MON|AUSD/i);
  });

  it('normalizes a whole frame into the canonical book', () => {
    const book = normalizeBook({
      ...base,
      source: 'ws-monadDepth',
      state: MONAD_DEPTH_FRAME.state as 'finalized',
      bids: MONAD_DEPTH_FRAME.bids.map(([price, size]) => ({ price: price!, size: size! })),
      asks: MONAD_DEPTH_FRAME.asks.map(([price, size]) => ({ price: price!, size: size! })),
    });
    expect(book.validity).toBe('ok');
    expect(book.bestBid).toBe(MON_AUSD_BEST_BID);
    expect(book.bestAsk).toBe(MON_AUSD_BEST_ASK);
    expect(book.bids[0]?.size).toBe(15_000_000_000_000_000_000n);
  });
});

describe('I6 — staleness', () => {
  const fresh = () =>
    normalizeBook({
      ...base,
      source: 'bestBidAsk',
      bids: [],
      asks: [],
      bestBid: MON_AUSD_BEST_BID,
      bestAsk: MON_AUSD_BEST_ASK,
      receivedAt: 1_000_000,
    });

  it('is not stale inside the heartbeat', () => {
    expect(isStale(fresh(), 1_000_000 + HEARTBEAT_MS)).toBe(false);
    expect(isTradable(fresh(), 1_000_000 + HEARTBEAT_MS)).toBe(true);
  });

  it('is stale one millisecond past it', () => {
    expect(isStale(fresh(), 1_000_000 + HEARTBEAT_MS + 1)).toBe(true);
    expect(isTradable(fresh(), 1_000_000 + HEARTBEAT_MS + 1)).toBe(false);
  });
});

describe('empty levels', () => {
  it('drops zero-size levels rather than showing phantom depth', () => {
    const book = normalizeBook({
      ...base,
      source: 'ws-monadDepth',
      bids: [{ price: 25_952_000_000_000_000n, size: 0n }],
      asks: [],
    });
    expect(book.bids).toHaveLength(0);
    expect(book.bestBid).toBe(0n);
  });
});

describe('the no-side sentinels are folded exactly once, at the boundary', () => {
  /**
   * Measured on the empty MON/AUSD book, chain 143 block 103,110,791: `bestBidAsk()`
   * returns `2^256-1` for a missing bid and `0` for a missing ask. The raw sentinel
   * was reaching the order ticket, where `bestBid > 0n` reads as "there is a bid" and
   * a reference price of 1.157e77 was used to compute a minimum-order notional.
   */
  const MAX = 2n ** 256n - 1n;

  it('folds a missing bid to zero', () => {
    expect(normalizeBestBidAsk(MAX, 0n)).toEqual({ bestBid: 0n, bestAsk: 0n });
  });

  it('leaves a real two-sided book untouched', () => {
    // MON/USDC, read live at the same block.
    expect(normalizeBestBidAsk(25_826_000_000_000_000n, 25_834_000_000_000_000n)).toEqual({
      bestBid: 25_826_000_000_000_000n,
      bestAsk: 25_834_000_000_000_000n,
    });
  });

  it('folds a one-sided book to a zero on the missing side only', () => {
    expect(normalizeBestBidAsk(MAX, 1_000_000n)).toEqual({ bestBid: 0n, bestAsk: 1_000_000n });
    expect(normalizeBestBidAsk(1_000_000n, 0n)).toEqual({ bestBid: 1_000_000n, bestAsk: 0n });
  });

  it('makes an empty book untradable rather than absurdly bid', () => {
    // The bug: without folding, `isTradable` still says false (the ask is 0) but every
    // "is there a bid" test elsewhere says yes, and the price is 1.157e77.
    const raw = normalizeBook({
      market: MON_AUSD_MARKET,
      source: 'contract-getL2Book',
      state: 'finalized',
      params: MON_AUSD_PARAMS,
      bids: [],
      asks: [],
      ...normalizeBestBidAsk(MAX, 0n),
      receivedAt: Date.now(),
    });
    expect(raw.bestBid).toBe(0n);
    expect(isTradable(raw)).toBe(false);
    expect(midPrice(raw)).toBeUndefined();
  });
});
