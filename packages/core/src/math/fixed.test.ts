import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  bpsToPps,
  formatAusd,
  formatUnits,
  parseUnits,
  ppsToBps,
  rescale,
  roundDownToTick,
  roundNearestTick,
  roundToTickForSide,
  roundUpToTick,
} from './fixed.js';

describe('pps conversion (venue pitfall 2)', () => {
  it('treats minFeesPps as parts-per-million, not basis points', () => {
    // 100 pps = 1 bp. Kuru's own example passes bps here and lands the ladder 100x
    // too tight. framework §4.1 error 2.
    expect(bpsToPps(1n)).toBe(100n);
    expect(bpsToPps(30n)).toBe(3000n);
    expect(bpsToPps(0n)).toBe(0n);
  });

  it('encodes 0.30% as 3000 pps, not 30', () => {
    // 0.30% = 30 bps
    expect(bpsToPps(30n)).toBe(3000n);
    expect(bpsToPps(30n)).not.toBe(30n);
  });

  it('round-trips whole basis points and rejects fractional ones', () => {
    expect(ppsToBps(3000n)).toBe(30n);
    expect(() => ppsToBps(3050n)).toThrow(/whole number of basis points/);
  });
});

describe('tick alignment by integer math (venue pitfall 5)', () => {
  const tick = 100n;

  it('rounds a price down to a multiple of the tick', () => {
    expect(roundDownToTick(2_716_349n, tick)).toBe(2_716_300n);
    expect(roundDownToTick(2_716_300n, tick)).toBe(2_716_300n);
  });

  it('rounds up only when the price is not already aligned', () => {
    expect(roundUpToTick(2_716_301n, tick)).toBe(2_716_400n);
    expect(roundUpToTick(2_716_300n, tick)).toBe(2_716_300n);
  });

  it('rounds a buy down and a sell up so neither side crosses its own limit', () => {
    expect(roundToTickForSide(2_716_349n, tick, 'buy')).toBe(2_716_300n);
    expect(roundToTickForSide(2_716_349n, tick, 'sell')).toBe(2_716_400n);
  });

  it('breaks nearest-ties downward', () => {
    expect(roundNearestTick(150n, 100n)).toBe(100n);
    expect(roundNearestTick(151n, 100n)).toBe(200n);
  });

  it('rejects a non-positive tick instead of dividing by zero', () => {
    expect(() => roundDownToTick(1n, 0n)).toThrow(/tickSize must be positive/);
    expect(() => roundUpToTick(1n, -1n)).toThrow(/tickSize must be positive/);
  });

  it('property: the result is tick-aligned and within one tick of the input', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 24n }),
        fc.bigInt({ min: 1n, max: 10n ** 9n }),
        (price, tick) => {
          const down = roundDownToTick(price, tick);
          const up = roundUpToTick(price, tick);
          expect(down % tick).toBe(0n);
          expect(up % tick).toBe(0n);
          expect(down).toBeLessThanOrEqual(price);
          expect(price - down).toBeLessThan(tick);
          expect(up).toBeGreaterThanOrEqual(price);
          expect(up - price).toBeLessThan(tick);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('does not behave like string truncation', () => {
    // clipToDecimals("0.02716349", 6) would give 0.027163 -> 27163 in 1e6 units,
    // which is not a multiple of a 100-unit tick and reverts with TickSizeError.
    const stringTruncated = 27_163n;
    expect(stringTruncated % 100n).not.toBe(0n);
    expect(roundDownToTick(27_163n, 100n) % 100n).toBe(0n);
  });
});

describe('rescale', () => {
  it('moves a 1e18 wire price into a 1e8 pricePrecision', () => {
    // 0.026473 * 1e18 -> 0.026473 * 1e8
    expect(rescale(26_473_000_000_000_000n, 10n ** 18n, 10n ** 8n)).toBe(2_647_300n);
  });

  it('moves a pricePrecision value back up to the wire scale', () => {
    expect(rescale(2_647_300n, 10n ** 8n, 10n ** 18n)).toBe(26_473_000_000_000_000n);
  });

  it('is identity when the scales match', () => {
    expect(rescale(12345n, 10n ** 8n, 10n ** 8n)).toBe(12345n);
  });

  it('rejects non-positive scales', () => {
    expect(() => rescale(1n, 0n, 10n)).toThrow(/scales must be positive/);
  });
});

describe('parseUnits / formatUnits', () => {
  it('parses AUSD amounts at 6 decimals without touching a float', () => {
    expect(parseUnits('1', 6)).toBe(1_000_000n);
    expect(parseUnits('0.000001', 6)).toBe(1n);
    expect(parseUnits('21689.661236', 6)).toBe(21_689_661_236n);
  });

  it('parses a value that a double could not represent exactly', () => {
    expect(parseUnits('0.1', 18)).toBe(100_000_000_000_000_000n);
    expect(parseUnits('9007199254740993', 0)).toBe(9_007_199_254_740_993n);
  });

  it('refuses to silently drop precision', () => {
    expect(() => parseUnits('1.0000001', 6)).toThrow(/decimal places/);
  });

  it('rejects junk', () => {
    expect(() => parseUnits('', 6)).toThrow();
    expect(() => parseUnits('1.2.3', 6)).toThrow();
    expect(() => parseUnits('1e6', 6)).toThrow();
  });

  it('formats back to the shortest exact decimal', () => {
    expect(formatUnits(21_689_661_236n, 6)).toBe('21689.661236');
    expect(formatUnits(1_000_000n, 6)).toBe('1');
    expect(formatUnits(0n, 6)).toBe('0');
    expect(formatUnits(-1n, 6)).toBe('-0.000001');
  });

  it('round-trips', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 30n }), (v) => {
        expect(parseUnits(formatUnits(v, 6), 6)).toBe(v);
      }),
      { numRuns: 300 },
    );
  });
});

describe('formatAusd (display only)', () => {
  it('groups thousands and always shows cents', () => {
    expect(formatAusd(21_689_661_236n)).toBe('21,689.66');
    expect(formatAusd(0n)).toBe('0.00');
    expect(formatAusd(1_000_000n)).toBe('1.00');
  });

  it('rounds half up at the cent in integer math', () => {
    expect(formatAusd(1_005_000n)).toBe('1.01');
    expect(formatAusd(1_004_999n)).toBe('1.00');
  });

  it('keeps the sign', () => {
    expect(formatAusd(-1_500_000n)).toBe('-1.50');
  });
});
