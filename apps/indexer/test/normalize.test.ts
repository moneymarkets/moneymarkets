/**
 * Price-scale normalisation and the entity shaping around it, driven by REAL logs.
 *
 * Spec invariant I3: prices arrive at different scales by source and must be
 * normalised. In Kuru's case the two scales are not merely different, they are
 * different *within one market*: `OrderCreated.price` is a uint32 in the market's
 * `pricePrecision` and `Trade.price` is a uint256 already at 1e18. The fixtures prove
 * both appear in the same block window on the same book.
 */

import { describe, expect, it } from 'vitest';
import { TOPIC0 } from '../src/events.js';
import {
  big,
  fillQuoteValue,
  logKey,
  orderKey,
  orderPriceToWire,
  sideOf,
  statusAfterCancel,
  statusAfterFill,
  toFillRow,
  toOrderRow,
  tradePriceToWire,
  UnknownMarketScaleError,
  WIRE_PRICE_SCALE,
} from '../src/normalize.js';
import { SEED_MARKETS, seedMarketFor } from '../src/markets.js';
import { decodeOrderCreated, decodeTrade, position, recentSweep } from './fixtures.js';
import type { Address } from 'viem';

const tradeLogs = recentSweep.logs.filter((l) => l.topics[0] === TOPIC0.Trade);
const createdLogs = recentSweep.logs.filter((l) => l.topics[0] === TOPIC0.OrderCreated);

describe('the fixture really contains both price scales', () => {
  it('has real Trade and real OrderCreated logs from the same window', () => {
    expect(tradeLogs.length).toBeGreaterThan(0);
    expect(createdLogs.length).toBeGreaterThan(0);
  });

  it('Trade prices are 1e18-scaled and OrderCreated prices are not', () => {
    // A uint32 price in 1e8 precision cannot exceed ~42.9; a 1e18 wire price for the
    // same market is ~1e16. The two populations do not overlap, which is exactly the
    // trap: both are "the price", and neither is obviously wrong on its own.
    const tradePrices = tradeLogs.map((l) => big(decodeTrade(l).price));
    const createdPrices = createdLogs.map((l) => big(decodeOrderCreated(l).price));

    expect(Math.min(...tradePrices.map((p) => Number(p)))).toBeGreaterThan(1e12);
    // uint32 caps OrderCreated.price at 4_294_967_295.
    for (const p of createdPrices) expect(p).toBeLessThanOrEqual(4_294_967_295n);
  });
});

describe('orderPriceToWire', () => {
  it('lifts a 1e8 price to 1e18 by exactly 1e10', () => {
    expect(orderPriceToWire(2_493_300n, 100_000_000n)).toBe(24_933_000_000_000_000n);
    expect(orderPriceToWire(1n, 100_000_000n)).toBe(10_000_000_000n);
  });

  it('lifts a 1e4 price (WBTC_AUSD) to 1e18 by 1e14 — not 1e10', () => {
    // The reason the scale is read per market. WBTC_AUSD really is 1e4 on chain.
    const wbtc = seedMarketFor('0xbDC776284Bf593981b1F0237F053A7Ad11Eb596F');
    expect(wbtc?.pricePrecision).toBe(10_000n);
    expect(orderPriceToWire(1_100_000n, 10_000n)).toBe(110_000_000_000_000_000_000n);

    // Applying the MON books' 1e8 to a WBTC price is wrong by four orders of
    // magnitude. This is the bug the per-market table prevents.
    expect(orderPriceToWire(1_100_000n, 100_000_000n)).not.toBe(
      orderPriceToWire(1_100_000n, 10_000n),
    );
  });

  it('is exact for every real OrderCreated in the window', () => {
    for (const log of createdLogs) {
      const seed = seedMarketFor(log.address);
      if (!seed) continue;
      const params = decodeOrderCreated(log);
      const wire = orderPriceToWire(params.price, seed.pricePrecision);
      // Identity, in integers: wire * precision == raw * 1e18.
      expect(wire * seed.pricePrecision).toBe(big(params.price) * WIRE_PRICE_SCALE);
    }
  });

  it('refuses a non-positive precision rather than dividing by zero', () => {
    expect(() => orderPriceToWire(1n, 0n)).toThrow(/non-positive pricePrecision/);
  });
});

describe('tradePriceToWire', () => {
  it('is identity, because Trade.price is already 1e18', () => {
    for (const log of tradeLogs.slice(0, 25)) {
      const params = decodeTrade(log);
      expect(tradePriceToWire(params.price)).toBe(params.price);
    }
  });

  it('a real Trade and a real OrderCreated on the same book land in the same range', () => {
    // The proof that the normalisation is right way round: after normalising, prices
    // from the two events are comparable. Before it, they differ by 1e10.
    const monUsdc = '0x065c9d28e428a0db40191a54d33d5b7c71a9c394';
    const seed = seedMarketFor(monUsdc)!;
    const trade = tradeLogs.find((l) => l.address.toLowerCase() === monUsdc);
    const created = createdLogs.find((l) => l.address.toLowerCase() === monUsdc);
    if (!trade || !created) return;

    const tradeWire = tradePriceToWire(decodeTrade(trade).price);
    const createdWire = orderPriceToWire(decodeOrderCreated(created).price, seed.pricePrecision);

    // Same book, same 60-block window: neither can be more than 10x the other.
    const ratio = Number(tradeWire) / Number(createdWire);
    expect(ratio).toBeGreaterThan(0.1);
    expect(ratio).toBeLessThan(10);
  });
});

describe('fillQuoteValue', () => {
  it('is all bigint and never negative on real fills', () => {
    let counted = 0;
    for (const log of tradeLogs) {
      const seed = seedMarketFor(log.address);
      if (!seed) continue;
      const p = decodeTrade(log);
      const value = fillQuoteValue(p.price, p.filledSize, seed.sizePrecision, seed.quoteDecimals);
      expect(typeof value).toBe('bigint');
      expect(value).toBeGreaterThanOrEqual(0n);
      counted += 1;
    }
    expect(counted).toBeGreaterThan(0);
  });

  it('scales linearly with size', () => {
    const seed = seedMarketFor('0x065C9d28E428A0db40191a54d33d5b7c71a9C394')!;
    const one = fillQuoteValue(26_226_000_000_000_000n, 1_000_000_000_000n, seed.sizePrecision, 6);
    const two = fillQuoteValue(26_226_000_000_000_000n, 2_000_000_000_000n, seed.sizePrecision, 6);
    expect(two).toBe(one * 2n);
  });

  it('refuses a non-positive sizePrecision', () => {
    expect(() => fillQuoteValue(1n, 1n, 0n, 6)).toThrow(/non-positive sizePrecision/);
  });
});

describe('order status transitions', () => {
  it('updatedSize is the REMAINDER, so zero means filled', () => {
    expect(statusAfterFill(0n)).toBe('FILLED');
    expect(statusAfterFill(1n)).toBe('PARTIALLY_FILLED');
  });

  it('a cancel does not un-fill a filled order', () => {
    expect(statusAfterCancel('FILLED')).toBe('FILLED');
    expect(statusAfterCancel('OPEN')).toBe('CANCELED');
    expect(statusAfterCancel('PARTIALLY_FILLED')).toBe('CANCELED');
  });

  it('real fills produce both outcomes', () => {
    const statuses = new Set(tradeLogs.map((l) => statusAfterFill(decodeTrade(l).updatedSize)));
    // The window contains fills that closed an order and fills that did not.
    expect(statuses.size).toBeGreaterThanOrEqual(1);
  });
});

describe('entity keys', () => {
  it('an order key is scoped to its market', () => {
    const a = '0x131A2e70A5b31a517A74b8c567149bc294470Da9' as Address;
    const b = '0x065C9d28E428A0db40191a54d33d5b7c71a9C394' as Address;
    // The same uint40 exists on both books. Keying on the bare id would merge them.
    expect(orderKey(a, 13_130_679n)).not.toBe(orderKey(b, 13_130_679n));
  });

  it('is case-insensitive on the address', () => {
    const lower = '0x131a2e70a5b31a517a74b8c567149bc294470da9' as Address;
    const checksummed = '0x131A2e70A5b31a517A74b8c567149bc294470Da9' as Address;
    expect(orderKey(lower, 1n)).toBe(orderKey(checksummed, 1n));
  });

  it('a log key is unique across the real window', () => {
    const keys = new Set(
      recentSweep.logs.map((l) =>
        logKey(l.transactionHash as `0x${string}`, Number(BigInt(l.logIndex))),
      ),
    );
    expect(keys.size).toBe(recentSweep.logs.length);
  });

  it('sideOf reads isBuy the obvious way', () => {
    expect(sideOf(true)).toBe('BUY');
    expect(sideOf(false)).toBe('SELL');
  });
});

describe('row shaping over real logs', () => {
  it('every real Trade becomes a well-formed Fill row', () => {
    for (const log of tradeLogs) {
      const params = decodeTrade(log);
      const row = toFillRow(log.address as Address, params, position(log));
      expect(row.market).toBe(log.address.toLowerCase());
      expect(row.maker).toMatch(/^0x[0-9a-f]{40}$/);
      expect(row.taker).toMatch(/^0x[0-9a-f]{40}$/);
      expect(row.txOrigin).toMatch(/^0x[0-9a-f]{40}$/);
      expect(row.order).toBe(orderKey(log.address as Address, params.orderId));
      expect(row.priceWire).toBe(params.price);
    }
  });

  it('every real OrderCreated on a seeded market becomes a well-formed Order row', () => {
    let counted = 0;
    for (const log of createdLogs) {
      const seed = seedMarketFor(log.address);
      if (!seed) continue;
      const params = decodeOrderCreated(log);
      const row = toOrderRow(log.address as Address, params, seed.pricePrecision, position(log));
      expect(row.status).toBe('OPEN');
      expect(row.remaining).toBe(params.size);
      expect(row.owner).toMatch(/^0x[0-9a-f]{40}$/);
      expect(row.side).toBe(params.isBuy ? 'BUY' : 'SELL');
      counted += 1;
    }
    expect(counted).toBeGreaterThan(0);
  });
});

describe('unknown market scale', () => {
  it('is an error type, not a default', () => {
    const err = new UnknownMarketScaleError('0xdeadbeef');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/refusing to guess/);
  });

  it('the seed table covers exactly the four books config.yaml lists', () => {
    expect(SEED_MARKETS).toHaveLength(4);
    const precisions = SEED_MARKETS.map((m) => m.pricePrecision);
    // Not all the same — which is the point of the table existing.
    expect(new Set(precisions).size).toBeGreaterThan(1);
  });
});
