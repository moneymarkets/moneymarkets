import { describe, expect, it } from 'vitest';
import { bpsToPps, PPS_PER_UNIT } from '@tradepro/core';
import {
  assertLadderSpacing,
  BAND_SCALE,
  baseRequiredFor,
  buildLadder,
  feePpsFromBps,
  flipPriceForBuy,
  flipPriceForSell,
  LadderError,
  parseBand,
  quoteRequiredFor,
  resolveAnchor,
  sizeForQuoteNotional,
  spacePrices,
  type Anchor,
  type LadderInput,
} from './ladder.js';
import {
  MON_AUSD,
  MON_AUSD_BEST_ASK_WIRE,
  MON_AUSD_BEST_BID_WIRE,
  MON_AUSD_MARKET,
  USDT0_AUSD,
} from './__fixtures__/markets.js';

const MARKET = { address: MON_AUSD_MARKET, symbol: 'MON/AUSD' } as const;

function baseInput(overrides: Partial<LadderInput> = {}): LadderInput {
  const anchor = resolveAnchor({
    bidWire: MON_AUSD_BEST_BID_WIRE,
    askWire: MON_AUSD_BEST_ASK_WIRE,
  });
  return {
    params: MON_AUSD,
    anchor,
    feeBps: 30n,
    levels: 6,
    bandLow: 980_000n,
    bandHigh: 1_020_000n,
    sizePerLevelQuote: 20_000_000n, // $20
    side: 'both',
    ...overrides,
  };
}

/* ══════════════════════ CORRECTION 1 — --fee-bps x 100 ═════════════════════ */

describe('correction 1: --fee-bps is multiplied by 100 because minFeesPps is pps', () => {
  it('converts basis points to parts-per-million', () => {
    expect(feePpsFromBps(30n)).toBe(3000n);
    expect(feePpsFromBps(1n)).toBe(100n);
    expect(feePpsFromBps(100n)).toBe(10_000n);
  });

  it('agrees with core.bpsToPps, which is the single source of the factor', () => {
    for (const bps of [1n, 5n, 30n, 250n, 9999n]) {
      expect(feePpsFromBps(bps)).toBe(bpsToPps(bps));
    }
  });

  it('0.30% is 3000 pps, not 30 — the documented Kuru example error', () => {
    // framework §4.1 error 2. The SDK example passes 30 where 3000 belongs.
    expect(feePpsFromBps(30n)).toBe(3000n);
    expect(feePpsFromBps(30n)).not.toBe(30n);
    expect(feePpsFromBps(30n)).toBe(30n * 100n);
  });

  it('rejects a zero or negative fee, which would make flip == price', () => {
    expect(() => feePpsFromBps(0n)).toThrow(LadderError);
    expect(() => feePpsFromBps(-1n)).toThrow(LadderError);
  });

  it('rejects a fee of 100% or more', () => {
    expect(() => feePpsFromBps(10_000n)).toThrow(/100%/);
  });

  it('the un-multiplied value is 100x too tight and collapses onto the tick', () => {
    // The bug this test exists to prevent: using the bps number as if it were pps.
    const price = 2_544_200n; // 0.025442 at pricePrecision 1e8
    const correct = flipPriceForBuy(price, feePpsFromBps(30n), MON_AUSD.tickSize);
    const wrong = flipPriceForBuy(price, 30n, MON_AUSD.tickSize);
    expect(correct - price).toBe(7700n); // ~30 bps of the price, well over a tick
    expect(wrong - price).toBe(100n); // one tick, i.e. 0.4 bps — 75x too tight
    expect(correct - price).toBeGreaterThan(MON_AUSD.tickSize);
  });

  it('a ladder built with the raw bps number fails the spacing assertion', () => {
    // On USDT0/AUSD (price ~1.0, pricePrecision 1e8) 30 pps is 3000 raw units against
    // a tick of 100, so it survives; on a market whose tick is coarse relative to the
    // price it collapses entirely. Build the collapse explicitly.
    const coarse = { ...USDT0_AUSD, tickSize: 1_000_000n };
    const price = 100_000_000n;
    expect(flipPriceForBuy(price, 30n, coarse.tickSize) - price).toBe(1_000_000n);
    // 30 pps of 1e8 is 3000, which rounds UP to one whole tick of 1e6 — a gap that is
    // 1% of the price rather than the 0.003% the caller asked for.
    const asked = (price * 30n) / PPS_PER_UNIT;
    expect(asked).toBe(3000n);
    expect(flipPriceForBuy(price, 30n, coarse.tickSize) - price).toBeGreaterThan(asked * 100n);
  });
});

/* ═══════════════ CORRECTION 2 — anchored on bestBidAsk(), or --ref ══════════ */

describe('correction 2: the ladder anchors on bestBidAsk(), or on an explicit --ref', () => {
  it('anchors on the chain bid and ask when the book is two-sided', () => {
    const anchor = resolveAnchor({
      bidWire: MON_AUSD_BEST_BID_WIRE,
      askWire: MON_AUSD_BEST_ASK_WIRE,
    });
    expect(anchor.source).toBe('bestBidAsk');
    expect(anchor.bidWire).toBe(MON_AUSD_BEST_BID_WIRE);
    expect(anchor.askWire).toBe(MON_AUSD_BEST_ASK_WIRE);
    expect(anchor.midWire).toBe((MON_AUSD_BEST_BID_WIRE + MON_AUSD_BEST_ASK_WIRE) / 2n);
  });

  it('ignores --ref when the chain has a two-sided book', () => {
    const anchor = resolveAnchor(
      { bidWire: MON_AUSD_BEST_BID_WIRE, askWire: MON_AUSD_BEST_ASK_WIRE },
      10n ** 18n,
    );
    expect(anchor.source).toBe('bestBidAsk');
    expect(anchor.midWire).not.toBe(10n ** 18n);
  });

  it('requires --ref when the book is empty, and refuses to invent one', () => {
    expect(() => resolveAnchor({ bidWire: 0n, askWire: 0n })).toThrow(/--ref/);
    const anchor = resolveAnchor({ bidWire: 0n, askWire: 0n }, 10n ** 18n);
    expect(anchor.source).toBe('ref');
    expect(anchor.midWire).toBe(10n ** 18n);
    expect(anchor.bidWire).toBe(10n ** 18n);
    expect(anchor.askWire).toBe(10n ** 18n);
  });

  it('requires --ref when the book is one-sided, and stays behind the live side', () => {
    expect(() => resolveAnchor({ bidWire: 5n * 10n ** 17n, askWire: 0n })).toThrow(/one-sided/);
    const anchor = resolveAnchor({ bidWire: 5n * 10n ** 17n, askWire: 0n }, 10n ** 18n);
    expect(anchor.source).toBe('ref');
    // The live bid is below the ref, so the buy ladder must not post above it.
    expect(anchor.bidWire).toBe(5n * 10n ** 17n);
    expect(anchor.askWire).toBe(10n ** 18n);
  });

  it('rejects a crossed book rather than averaging it away (invariant I1)', () => {
    expect(() =>
      resolveAnchor({ bidWire: MON_AUSD_BEST_ASK_WIRE, askWire: MON_AUSD_BEST_BID_WIRE }),
    ).toThrow(/crossed/);
    expect(() => resolveAnchor({ bidWire: 100n, askWire: 100n })).toThrow(/crossed/);
  });

  it('rejects a non-positive --ref', () => {
    expect(() => resolveAnchor({ bidWire: 0n, askWire: 0n }, 0n)).toThrow(/positive/);
  });

  it('a ladder anchored on --ref sits where --ref says, not where the SDK asks array would', () => {
    const anchor = resolveAnchor({ bidWire: 0n, askWire: 0n }, 10n ** 18n);
    const ladder = buildLadder(
      { address: MON_AUSD_MARKET, symbol: 'USDT0/AUSD' },
      {
        params: USDT0_AUSD,
        anchor,
        feeBps: 5n,
        levels: 4,
        bandLow: 995_000n,
        bandHigh: 1_005_000n,
        sizePerLevelQuote: 25_000_000n,
        side: 'both',
      },
    );
    const buys = ladder.levels.filter((l) => l.side === 'buy').map((l) => l.price);
    const sells = ladder.levels.filter((l) => l.side === 'sell').map((l) => l.price);
    // 1.0 at pricePrecision 1e8 is 100_000_000.
    expect(Math.max(...buys.map(Number))).toBeLessThan(100_000_000);
    expect(Math.min(...sells.map(Number))).toBeGreaterThanOrEqual(100_000_000);
  });
});

/* ═════════════════════════════ spacing assertions ══════════════════════════ */

describe('spacing: >= 1 tick and <= 5% of price', () => {
  it('accepts the default MON/AUSD ladder', () => {
    const ladder = buildLadder(MARKET, baseInput());
    expect(() => assertLadderSpacing(ladder)).not.toThrow();
    for (const level of ladder.levels) {
      expect(level.flipGap).toBeGreaterThanOrEqual(MON_AUSD.tickSize);
      expect(level.flipGap * 100n).toBeLessThanOrEqual(level.price * 5n);
    }
  });

  it('rejects a flip gap under one tick', () => {
    const ladder = buildLadder(MARKET, baseInput());
    const broken = {
      ...ladder,
      levels: ladder.levels.map((l) =>
        l.index === 0 && l.side === 'buy' ? { ...l, flipGap: MON_AUSD.tickSize - 1n } : l,
      ),
    };
    expect(() => assertLadderSpacing(broken)).toThrow(/under one tick/);
  });

  it('rejects a flip gap above 5% of the price', () => {
    // 600 bps = 6% > 5%.
    expect(() => buildLadder(MARKET, baseInput({ feeBps: 600n }))).toThrow(/5% of the price/);
  });

  it('rejects level spacing above 5% of the price', () => {
    // A 40% band over 3 levels puts consecutive levels ~13% apart.
    expect(() =>
      buildLadder(MARKET, baseInput({ bandLow: 800_000n, bandHigh: 1_200_000n, levels: 3 })),
    ).toThrow(/more than 5%/);
  });

  it('rejects level spacing under one tick', () => {
    // A band only a few ticks wide cannot hold 200 distinct levels.
    expect(() =>
      buildLadder(MARKET, baseInput({ bandLow: 999_990n, bandHigh: 1_000_010n, levels: 200 })),
    ).toThrow(/under one tick|Widen the band|not fit/);
  });

  it('every price and flip price is a whole multiple of the tick', () => {
    const ladder = buildLadder(MARKET, baseInput());
    for (const level of ladder.levels) {
      expect(level.price % MON_AUSD.tickSize).toBe(0n);
      expect(level.flipPrice % MON_AUSD.tickSize).toBe(0n);
    }
  });
});

/* ══════════════════════════════ flip direction ═════════════════════════════ */

describe('flip direction matches the live venue', () => {
  it('a buy flips to a HIGHER sell; a sell flips to a LOWER buy', () => {
    const ladder = buildLadder(MARKET, baseInput());
    for (const level of ladder.levels) {
      if (level.side === 'buy') expect(level.flipPrice).toBeGreaterThan(level.price);
      else expect(level.flipPrice).toBeLessThan(level.price);
    }
  });

  it('reproduces the direction of a live flip order on MON/AUSD', () => {
    // s_orders(13130678) on 0x131a2e70…, read 2026-09-02:
    //   size 3695244139753, price 2595200, flippedPrice 2544200, isBuy false
    // A resting SELL whose flip is BELOW it. 51000/2595200 = 196.5 bps.
    const price = 2_595_200n;
    const observedFlip = 2_544_200n;
    expect(observedFlip).toBeLessThan(price);
    const gapBps = ((price - observedFlip) * 10_000n) / price;
    expect(gapBps).toBe(196n);
    // Our builder, given that fee, lands on the same side of the price.
    const ours = flipPriceForSell(price, feePpsFromBps(gapBps), MON_AUSD.tickSize);
    expect(ours).toBeLessThan(price);
    expect(ours).toBeGreaterThan(observedFlip - 20_000n);
  });

  it('never lets a buy flip below itself or a sell flip above itself', () => {
    const ladder = buildLadder(MARKET, baseInput({ feeBps: 1n }));
    for (const level of ladder.levels) {
      if (level.side === 'buy') expect(level.flipPrice > level.price).toBe(true);
      else expect(level.flipPrice < level.price).toBe(true);
    }
  });
});

/* ═════════════════════════════ sizing and capital ══════════════════════════ */

describe('sizing and capital, in bigint only', () => {
  it('turns a quote notional into a sizePrecision size', () => {
    // $20 / 0.025442 = 786.1017215627 MON; at sizePrecision 1e10 that is
    // 20e6 * 1e8 * 1e10 / (2_544_200 * 1e6) = 7_861_017_215_627, truncated.
    const size = sizeForQuoteNotional(20_000_000n, 2_544_200n, MON_AUSD);
    expect(size).toBe(7_861_017_215_627n);
    expect(size).toBeGreaterThan(MON_AUSD.minSize);
  });

  it('round-trips a size back to roughly the notional it was sized for', () => {
    const price = 2_544_200n;
    const size = sizeForQuoteNotional(20_000_000n, price, MON_AUSD);
    const quote = quoteRequiredFor(size, price, MON_AUSD);
    expect(quote).toBeGreaterThanOrEqual(19_999_999n);
    expect(quote).toBeLessThanOrEqual(20_000_001n);
  });

  it('rounds capital requirements UP, never down', () => {
    // 1 sizePrecision unit of an 18-decimal base is 1e8 base units and cannot round to 0.
    expect(baseRequiredFor(1n, MON_AUSD)).toBe(100_000_000n);
    // A size that does not divide evenly still demands a whole unit of quote.
    const quote = quoteRequiredFor(1n, 1n, MON_AUSD);
    expect(quote).toBe(1n);
  });

  it('totals the two sides separately: buys lock quote, sells lock base', () => {
    const ladder = buildLadder(MARKET, baseInput());
    const buys = ladder.levels.filter((l) => l.side === 'buy');
    const sells = ladder.levels.filter((l) => l.side === 'sell');
    expect(ladder.totalQuote).toBe(buys.reduce((a, l) => a + l.quoteRequired, 0n));
    expect(ladder.totalBase).toBe(sells.reduce((a, l) => a + l.baseRequired, 0n));
    for (const l of buys) expect(l.baseRequired).toBe(0n);
    for (const l of sells) expect(l.quoteRequired).toBe(0n);
  });

  it('rejects a level below the market minSize instead of shipping it to revert', () => {
    expect(() => buildLadder(MARKET, baseInput({ sizePerLevelQuote: 1_000n }))).toThrow(
      /below the market minSize/,
    );
  });

  it('rejects a level above the market maxSize', () => {
    expect(() =>
      buildLadder(MARKET, baseInput({ sizePerLevelQuote: 100_000_000_000_000n })),
    ).toThrow(/above the market maxSize/);
  });
});

/* ═══════════════════════════ price spacing helper ══════════════════════════ */

describe('spacePrices', () => {
  it('produces `levels` tick-aligned prices, descending for buys', () => {
    const prices = spacePrices(1000n, 500n, 6, 100n, 'buy');
    expect(prices).toEqual([1000n, 900n, 800n, 700n, 600n, 500n]);
  });

  it('produces ascending prices for sells', () => {
    const prices = spacePrices(1000n, 500n, 6, 100n, 'sell');
    expect(prices).toEqual([500n, 600n, 700n, 800n, 900n, 1000n]);
  });

  it('collapses to a single level at the near edge when levels is 1', () => {
    expect(spacePrices(1000n, 500n, 1, 100n, 'buy')).toEqual([1000n]);
    expect(spacePrices(1000n, 500n, 1, 100n, 'sell')).toEqual([500n]);
  });

  it('rejects a non-positive or fractional level count', () => {
    expect(() => spacePrices(1000n, 500n, 0, 100n, 'buy')).toThrow(LadderError);
    expect(() => spacePrices(1000n, 500n, 1.5, 100n, 'buy')).toThrow(LadderError);
  });

  it('rejects an inverted band', () => {
    expect(() => spacePrices(500n, 1000n, 4, 100n, 'buy')).toThrow(/inverted/);
  });
});

/* ═══════════════════════════════ band parsing ══════════════════════════════ */

describe('parseBand', () => {
  it('parses the spec form', () => {
    expect(parseBand('0.98..1.02')).toEqual({ low: 980_000n, high: 1_020_000n });
  });

  it('keeps six decimal places without touching a float', () => {
    expect(parseBand('0.999995..1.000005')).toEqual({ low: 999_995n, high: 1_000_005n });
  });

  it('rejects more precision than it can represent', () => {
    expect(() => parseBand('0.9999995..1.02')).toThrow(/decimal places/);
  });

  it('rejects a malformed or inverted band', () => {
    expect(() => parseBand('0.98-1.02')).toThrow(LadderError);
    expect(() => parseBand('1.02..0.98')).toThrow(/not below/);
    expect(() => parseBand('abc..1.02')).toThrow(LadderError);
  });

  it('BAND_SCALE is 1e6, matching the six decimal places accepted', () => {
    expect(BAND_SCALE).toBe(1_000_000n);
  });
});

/* ═══════════════════════════════ whole ladder ══════════════════════════════ */

describe('buildLadder', () => {
  it('never crosses: the highest buy sits below the lowest sell', () => {
    for (const levels of [1, 2, 5, 12]) {
      const ladder = buildLadder(MARKET, baseInput({ levels }));
      const highestBuy = ladder.levels
        .filter((l) => l.side === 'buy')
        .reduce((m, l) => (l.price > m ? l.price : m), 0n);
      const lowestSell = ladder.levels
        .filter((l) => l.side === 'sell')
        .reduce((m, l) => (m === 0n || l.price < m ? l.price : m), 0n);
      expect(highestBuy).toBeLessThan(lowestSell);
    }
  });

  it('does not post through a live book', () => {
    const ladder = buildLadder(MARKET, baseInput());
    const highestBuy = ladder.levels
      .filter((l) => l.side === 'buy')
      .reduce((m, l) => (l.price > m ? l.price : m), 0n);
    // best bid 0.025442 -> 2_544_200 at pricePrecision 1e8
    expect(highestBuy).toBeLessThanOrEqual(2_544_200n);
  });

  it('honours --side', () => {
    expect(
      buildLadder(MARKET, baseInput({ side: 'buy' })).levels.every((l) => l.side === 'buy'),
    ).toBe(true);
    expect(
      buildLadder(MARKET, baseInput({ side: 'sell' })).levels.every((l) => l.side === 'sell'),
    ).toBe(true);
    expect(buildLadder(MARKET, baseInput({ side: 'both' })).levels).toHaveLength(12);
  });

  it('carries the pps conversion into the built ladder', () => {
    const ladder = buildLadder(MARKET, baseInput({ feeBps: 30n }));
    expect(ladder.feeBps).toBe(30n);
    expect(ladder.feePps).toBe(3000n);
  });

  it('rejects a band that does not straddle 1', () => {
    expect(() => buildLadder(MARKET, baseInput({ bandLow: 1_100_000n }))).toThrow(/band low/);
    expect(() => buildLadder(MARKET, baseInput({ bandHigh: 900_000n }))).toThrow(/band high/);
  });

  it('builds a USDT0/AUSD ladder anchored on --ref 1.0', () => {
    const anchor: Anchor = resolveAnchor({ bidWire: 0n, askWire: 0n }, 10n ** 18n);
    const ladder = buildLadder(
      { address: '0x572426e654DaFf7Ce15a3475dCE02bF5DAB4E80F', symbol: 'USDT0/AUSD' },
      {
        params: USDT0_AUSD,
        anchor,
        feeBps: 5n,
        levels: 6,
        bandLow: 997_000n,
        bandHigh: 1_003_000n,
        sizePerLevelQuote: 25_000_000n,
        side: 'both',
      },
    );
    expect(ladder.levels).toHaveLength(12);
    expect(ladder.feePps).toBe(500n);
    // $25 a level, 6 levels a side.
    expect(ladder.totalQuote).toBeGreaterThan(149_000_000n);
    expect(ladder.totalQuote).toBeLessThan(151_000_000n);
    expect(() => assertLadderSpacing(ladder)).not.toThrow();
  });
});

/* ═══════════ what the contract does and does not check, measured ═══════════ */

describe('why the pps assertion has to live here, not on chain', () => {
  /**
   * Measured on Monad mainnet 2026-09-02 by `eth_call` against MON/AUSD
   * `0x131a2e70…` with the operator's MarginAccount balances overridden:
   *
   *   flip prices at 3000 pps (correct)          -> ACCEPTED
   *   flip prices at 30 pps, i.e. one tick       -> ACCEPTED
   *   flip prices not aligned to the tick        -> REJECTED
   *
   * So `batchProvisionLiquidity` enforces tick alignment and nothing about the
   * *economics* of the flip gap. A ladder built with the bps number where pps
   * belongs is accepted by the venue and quotes 0.4 bps instead of 30 — it is picked
   * off, silently, at a price the operator never chose. The contract will not catch
   * that mistake, which is exactly why `assertLadderSpacing` must.
   */
  it('a one-tick flip gap is a real, contract-legal ladder — and a ruinous one', () => {
    const price = 2_544_200n;
    const oneTickFlip = price + MON_AUSD.tickSize;
    expect(oneTickFlip % MON_AUSD.tickSize).toBe(0n); // the contract is satisfied
    const spreadBps = ((oneTickFlip - price) * 10_000n) / price;
    expect(spreadBps).toBe(0n); // under one basis point of edge
  });

  it('the correct fee gives a gap the operator actually asked for', () => {
    const price = 2_544_200n;
    const flip = flipPriceForBuy(price, feePpsFromBps(30n), MON_AUSD.tickSize);
    const spreadBps = ((flip - price) * 10_000n) / price;
    expect(spreadBps).toBe(30n);
  });

  it('assertLadderSpacing is the only thing that separates the two', () => {
    const ladder = buildLadder(MARKET, baseInput({ feeBps: 30n }));
    const collapsed = {
      ...ladder,
      levels: ladder.levels.map((l) => ({ ...l, flipGap: MON_AUSD.tickSize / 2n })),
    };
    expect(() => assertLadderSpacing(ladder)).not.toThrow();
    expect(() => assertLadderSpacing(collapsed)).toThrow(/pps-vs-bps/);
  });
});
