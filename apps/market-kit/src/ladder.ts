import {
  bpsToPps,
  PPS_PER_UNIT,
  rescale,
  rescaleWithRounding,
  roundDownToTick,
  roundUpToTick,
  UINT32_MAX,
  UINT96_MAX,
  WIRE_PRICE_SCALE,
  type MarketParams,
  type Side,
} from '@tradepro/core';

/**
 * The flip-order ladder builder.
 *
 * Two things in here are the whole point of the file, and both are the corrections
 * from `docs/01-framework.md` §4.1 (errors 1 and 2) made structural:
 *
 *  1. `--fee-bps` is multiplied by 100. `minFeesPps` is parts-per-million, not basis
 *     points; 100 pps = 1 bp. Passing 30 where 3000 belongs builds a ladder 100x too
 *     tight, which on a 1e8-precision market collapses every flip price onto its own
 *     order price. `feePpsFromBps` is the only way a fee enters this module, and
 *     `assertLadderSpacing` fails loudly if the gap it produces is under one tick.
 *
 *  2. The ladder is anchored on `bestBidAsk()` read from the chain. The SDK's `asks`
 *     array is sorted *descending*, so `asks[0]` is the WORST ask; anchoring on it
 *     puts the whole sell side in the wrong place. When the book is genuinely empty
 *     there is nothing to anchor on, so `--ref` becomes mandatory rather than
 *     optional — `resolveAnchor` throws instead of inventing a price.
 *
 * Everything here is `bigint` (rule A2.6) and pure: no client, no clock, no env.
 * Prices are carried in the market's own `pricePrecision` units, which is the domain
 * `batchProvisionLiquidity` takes, so nothing is converted twice.
 */

/** `assertLadderSpacing` refuses a gap wider than this share of the price. */
export const MAX_SPACING_PERCENT = 5n;

/** Band multipliers are carried as integers at this scale (0.98 -> 980_000). */
export const BAND_SCALE = 1_000_000n;

export class LadderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LadderError';
  }
}

/* ─────────────────────────────── the fee correction ───────────────────────── */

/**
 * Correction 1. `--fee-bps 30` is 0.30%, which Kuru wants as **3000 pps**.
 *
 * `bpsToPps` lives in `@tradepro/core` and is tested there; this wrapper exists so
 * the CLI has exactly one door into the conversion and so the bounds checks that
 * make the ladder buildable live next to it.
 */
export function feePpsFromBps(feeBps: bigint): bigint {
  if (feeBps <= 0n) {
    throw new LadderError('--fee-bps must be positive; a zero flip spread never turns a profit');
  }
  const pps = bpsToPps(feeBps);
  if (pps >= PPS_PER_UNIT) {
    throw new LadderError(
      `--fee-bps ${feeBps} is ${pps} pps, which is 100% or more of the price; ` +
        'a flip sell would be priced at or beyond double its buy',
    );
  }
  return pps;
}

/* ────────────────────────────── the anchor correction ─────────────────────── */

export type AnchorSource = 'bestBidAsk' | 'ref';

export interface BestBidAsk {
  /** human * 1e18, straight from `OrderBook.bestBidAsk()`. Zero means "no side". */
  readonly bidWire: bigint;
  readonly askWire: bigint;
}

export interface Anchor {
  readonly source: AnchorSource;
  /** The highest price the buy ladder may occupy, human * 1e18. */
  readonly bidWire: bigint;
  /** The lowest price the sell ladder may occupy, human * 1e18. */
  readonly askWire: bigint;
  /** The price the band is measured from, human * 1e18. */
  readonly midWire: bigint;
  /** Human-readable reason, for the dry-run header. */
  readonly note: string;
}

/**
 * Correction 2. Anchor on the chain's own best bid and ask; fall back to `--ref`
 * only when there is no book to anchor to, and refuse to guess when there is not.
 */
export function resolveAnchor(book: BestBidAsk, refWire?: bigint): Anchor {
  const { bidWire, askWire } = book;
  if (bidWire < 0n || askWire < 0n) throw new LadderError('bestBidAsk returned a negative price');
  if (refWire !== undefined && refWire <= 0n) throw new LadderError('--ref must be positive');

  if (bidWire > 0n && askWire > 0n) {
    if (bidWire >= askWire) {
      // Invariant I1: a crossed book is never traded on, never "fixed" by averaging.
      throw new LadderError(
        `bestBidAsk() is crossed: bid ${bidWire} >= ask ${askWire}. ` +
          'Refusing to build a ladder on a crossed book.',
      );
    }
    return {
      source: 'bestBidAsk',
      bidWire,
      askWire,
      midWire: (bidWire + askWire) / 2n,
      note: 'anchored on bestBidAsk() read from chain',
    };
  }

  if (refWire === undefined) {
    const which = bidWire === 0n && askWire === 0n ? 'empty' : 'one-sided';
    throw new LadderError(
      `bestBidAsk() reports a ${which} book (bid ${bidWire}, ask ${askWire}) and no ` +
        '--ref was given. Pass --ref <price> to anchor the ladder explicitly; ' +
        'this tool will not invent a reference price.',
    );
  }

  // One live side still constrains us: never post through it.
  const anchorBid = bidWire > 0n && bidWire < refWire ? bidWire : refWire;
  const anchorAsk = askWire > 0n && askWire > refWire ? askWire : refWire;
  const live = bidWire > 0n ? 'bid' : askWire > 0n ? 'ask' : 'neither side';
  return {
    source: 'ref',
    bidWire: anchorBid,
    askWire: anchorAsk,
    midWire: refWire,
    note:
      bidWire === 0n && askWire === 0n
        ? 'book empty; anchored on --ref'
        : `book one-sided (${live} only); anchored on --ref, kept behind the live ${live}`,
  };
}

/* ─────────────────────────────────── the ladder ───────────────────────────── */

export type LadderSide = 'buy' | 'sell' | 'both';

export interface LadderInput {
  readonly params: MarketParams;
  readonly anchor: Anchor;
  /** As typed on the CLI. Converted to pps here, never before. */
  readonly feeBps: bigint;
  /** Levels **per side**. */
  readonly levels: number;
  /** Band multipliers at `BAND_SCALE`, e.g. 980_000n and 1_020_000n. */
  readonly bandLow: bigint;
  readonly bandHigh: bigint;
  /** Quote base units of notional per level. */
  readonly sizePerLevelQuote: bigint;
  readonly side: LadderSide;
}

export interface LadderLevel {
  readonly side: Side;
  readonly index: number;
  /** `uint32`, pricePrecision units — what `batchProvisionLiquidity` takes. */
  readonly price: bigint;
  readonly flipPrice: bigint;
  /** `uint96`, sizePrecision units. */
  readonly size: bigint;
  /** Gap between price and flip price, pricePrecision units. */
  readonly flipGap: bigint;
  /** Quote base units this level locks up (buys) — zero for sells. */
  readonly quoteRequired: bigint;
  /** Base base units this level locks up (sells) — zero for buys. */
  readonly baseRequired: bigint;
}

export interface Ladder {
  readonly market: LadderMarketRef;
  readonly params: MarketParams;
  readonly anchor: Anchor;
  readonly feeBps: bigint;
  readonly feePps: bigint;
  readonly levels: readonly LadderLevel[];
  readonly levelsPerSide: number;
  readonly bandLow: bigint;
  readonly bandHigh: bigint;
  readonly sizePerLevelQuote: bigint;
  /** Total quote base units the buy side needs in the MarginAccount. */
  readonly totalQuote: bigint;
  /** Total base base units the sell side needs in the MarginAccount. */
  readonly totalBase: bigint;
}

export interface LadderMarketRef {
  readonly address: `0x${string}`;
  readonly symbol: string;
}

/**
 * Quote notional -> `uint96` size, entirely in integers.
 *
 *   size = quote * pricePrecision * sizePrecision / (price * 10**quoteDecimals)
 *
 * Truncating is the safe direction: it can only make a level cheaper than asked, and
 * `assertSizes` then rejects anything that fell under `minSize`.
 */
export function sizeForQuoteNotional(
  quoteUnits: bigint,
  pricePp: bigint,
  params: MarketParams,
): bigint {
  if (quoteUnits <= 0n) throw new LadderError('size per level must be positive');
  if (pricePp <= 0n) throw new LadderError('cannot size a level at a non-positive price');
  return (
    (quoteUnits * params.pricePrecision * params.sizePrecision) /
    (pricePp * 10n ** BigInt(params.quoteDecimals))
  );
}

/** Quote base units a resting buy of `size` at `pricePp` locks up. Rounds up. */
export function quoteRequiredFor(size: bigint, pricePp: bigint, params: MarketParams): bigint {
  const numerator = size * pricePp * 10n ** BigInt(params.quoteDecimals);
  const denominator = params.sizePrecision * params.pricePrecision;
  return divCeil(numerator, denominator);
}

/** Base base units a resting sell of `size` locks up. Rounds up. */
export function baseRequiredFor(size: bigint, params: MarketParams): bigint {
  return divCeil(size * 10n ** BigInt(params.baseDecimals), params.sizePrecision);
}

function divCeil(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new LadderError('division by non-positive denominator');
  return a % b === 0n ? a / b : a / b + 1n;
}

/** The flip price of a resting buy: sell it back `feePps` higher. */
export function flipPriceForBuy(pricePp: bigint, feePps: bigint, tick: bigint): bigint {
  return roundUpToTick((pricePp * (PPS_PER_UNIT + feePps)) / PPS_PER_UNIT, tick);
}

/** The flip price of a resting sell: buy it back `feePps` lower. */
export function flipPriceForSell(pricePp: bigint, feePps: bigint, tick: bigint): bigint {
  return roundDownToTick((pricePp * (PPS_PER_UNIT - feePps)) / PPS_PER_UNIT, tick);
}

/**
 * Evenly spaced tick-aligned prices from `top` down to `bottom`, inclusive.
 * Buys round down, sells round up, so alignment never pushes a level through the
 * anchor it was measured from.
 */
export function spacePrices(
  top: bigint,
  bottom: bigint,
  levels: number,
  tick: bigint,
  side: Side,
): bigint[] {
  if (!Number.isInteger(levels) || levels < 1) {
    throw new LadderError(`--levels must be a positive integer, got ${levels}`);
  }
  if (top < bottom) throw new LadderError(`ladder band is inverted: top ${top} < bottom ${bottom}`);
  const align = side === 'buy' ? roundDownToTick : roundUpToTick;
  if (levels === 1) return [align(side === 'buy' ? top : bottom, tick)];
  const span = top - bottom;
  const n = BigInt(levels - 1);
  const out: bigint[] = [];
  for (let i = 0; i < levels; i += 1) {
    const raw = side === 'buy' ? top - (span * BigInt(i)) / n : bottom + (span * BigInt(i)) / n;
    out.push(align(raw, tick));
  }
  return out;
}

export function buildLadder(market: LadderMarketRef, input: LadderInput): Ladder {
  const { params, anchor } = input;
  const tick = params.tickSize;
  const feePps = feePpsFromBps(input.feeBps);

  if (input.bandLow <= 0n || input.bandLow >= BAND_SCALE) {
    throw new LadderError(
      `--band low must sit strictly between 0 and 1; got ${fmtBand(input.bandLow)}`,
    );
  }
  if (input.bandHigh <= BAND_SCALE) {
    throw new LadderError(`--band high must be above 1; got ${fmtBand(input.bandHigh)}`);
  }

  const toPp = (wire: bigint, mode: 'floor' | 'ceil'): bigint =>
    rescaleWithRounding(wire, WIRE_PRICE_SCALE, params.pricePrecision, mode);

  const midPp = toPp(anchor.midWire, 'floor');
  if (midPp <= 0n) {
    throw new LadderError(
      `the anchor price ${anchor.midWire} (1e18) is below one unit of this market's ` +
        `pricePrecision (${params.pricePrecision}); it cannot be represented`,
    );
  }

  const bandBottom = roundDownToTick((midPp * input.bandLow) / BAND_SCALE, tick);
  const bandTop = roundUpToTick((midPp * input.bandHigh) / BAND_SCALE, tick);

  let topBuy = roundDownToTick(toPp(anchor.bidWire, 'floor'), tick);
  const botSell = roundUpToTick(toPp(anchor.askWire, 'ceil'), tick);
  if (topBuy >= botSell) {
    // Keep the two halves of the ladder from crossing when the anchor is a single
    // price (an empty book anchored on --ref) or a one-tick-wide live book.
    topBuy = botSell - tick;
  }

  const wantBuys = input.side === 'buy' || input.side === 'both';
  const wantSells = input.side === 'sell' || input.side === 'both';

  const levels: LadderLevel[] = [];

  if (wantBuys) {
    if (topBuy <= 0n) {
      throw new LadderError('the top buy price rounds to zero; the anchor is below one tick');
    }
    if (bandBottom > topBuy) {
      throw new LadderError(
        `--band low ${fmtBand(input.bandLow)} puts the lowest buy at ${bandBottom}, ` +
          `above the highest allowed buy ${topBuy}. Widen the band.`,
      );
    }
    const prices = spacePrices(topBuy, bandBottom, input.levels, tick, 'buy');
    prices.forEach((price, index) => {
      const size = sizeForQuoteNotional(input.sizePerLevelQuote, price, params);
      const flipPrice = flipPriceForBuy(price, feePps, tick);
      levels.push({
        side: 'buy',
        index,
        price,
        flipPrice,
        size,
        flipGap: flipPrice - price,
        quoteRequired: quoteRequiredFor(size, price, params),
        baseRequired: 0n,
      });
    });
  }

  if (wantSells) {
    if (bandTop < botSell) {
      throw new LadderError(
        `--band high ${fmtBand(input.bandHigh)} puts the highest sell at ${bandTop}, ` +
          `below the lowest allowed sell ${botSell}. Widen the band.`,
      );
    }
    const prices = spacePrices(bandTop, botSell, input.levels, tick, 'sell');
    prices.forEach((price, index) => {
      const size = sizeForQuoteNotional(input.sizePerLevelQuote, price, params);
      const flipPrice = flipPriceForSell(price, feePps, tick);
      levels.push({
        side: 'sell',
        index,
        price,
        flipPrice,
        size,
        flipGap: price - flipPrice,
        quoteRequired: 0n,
        baseRequired: baseRequiredFor(size, params),
      });
    });
  }

  if (levels.length === 0) throw new LadderError('nothing to build: no side selected');

  const ladder: Ladder = {
    market,
    params,
    anchor,
    feeBps: input.feeBps,
    feePps,
    levels,
    levelsPerSide: input.levels,
    bandLow: input.bandLow,
    bandHigh: input.bandHigh,
    sizePerLevelQuote: input.sizePerLevelQuote,
    totalQuote: levels.reduce((a, l) => a + l.quoteRequired, 0n),
    totalBase: levels.reduce((a, l) => a + l.baseRequired, 0n),
  };

  assertLadderSpacing(ladder);
  assertSizes(ladder);
  assertNotCrossed(ladder);
  assertWireBounds(ladder);
  return ladder;
}

/* ──────────────────────────────── the assertions ──────────────────────────── */

/**
 * Spec §8.3: ladder spacing >= 1 tick and <= 5% of price.
 *
 * Both spacings are checked, because both can be wrong in the ways the framework
 * documents: the flip gap (price -> flipPrice, which is what `--fee-bps` sets, and
 * what collapses to zero if pps is confused for bps) and the level gap (level i ->
 * level i+1, which collapses if the band is narrower than `levels` ticks).
 */
export function assertLadderSpacing(ladder: Ladder): void {
  const tick = ladder.params.tickSize;
  for (const level of ladder.levels) {
    if (level.flipGap < tick) {
      throw new LadderError(
        `${level.side} level ${level.index}: flip gap ${level.flipGap} is under one tick ` +
          `(${tick}). --fee-bps ${ladder.feeBps} is ${ladder.feePps} pps; on a market with ` +
          `pricePrecision ${ladder.params.pricePrecision} that is too tight to express. ` +
          'This is the pps-vs-bps error: a fee given in bps is 100x too small.',
      );
    }
    assertUnderFivePercent(level.flipGap, level.price, `${level.side} level ${level.index} flip`);
  }

  for (const side of ['buy', 'sell'] as const) {
    const prices = ladder.levels.filter((l) => l.side === side).map((l) => l.price);
    for (let i = 1; i < prices.length; i += 1) {
      const a = prices[i - 1]!;
      const b = prices[i]!;
      const gap = a > b ? a - b : b - a;
      if (gap < tick) {
        throw new LadderError(
          `${side} levels ${i - 1} and ${i} are ${gap} apart, under one tick (${tick}). ` +
            `${ladder.levelsPerSide} levels do not fit in this band at this tick.`,
        );
      }
      assertUnderFivePercent(gap, a < b ? a : b, `${side} levels ${i - 1}..${i}`);
    }
  }
}

function assertUnderFivePercent(gap: bigint, price: bigint, what: string): void {
  if (gap * 100n > price * MAX_SPACING_PERCENT) {
    throw new LadderError(
      `${what}: spacing ${gap} is more than ${MAX_SPACING_PERCENT}% of the price ${price}. ` +
        'Narrow the band or add levels.',
    );
  }
}

export function assertSizes(ladder: Ladder): void {
  const { minSize, maxSize } = ladder.params;
  for (const level of ladder.levels) {
    if (level.size < minSize) {
      throw new LadderError(
        `${level.side} level ${level.index}: size ${level.size} is below the market ` +
          `minSize ${minSize}. Raise --size-per-level.`,
      );
    }
    if (level.size > maxSize) {
      throw new LadderError(
        `${level.side} level ${level.index}: size ${level.size} is above the market ` +
          `maxSize ${maxSize}. Lower --size-per-level.`,
      );
    }
    if (level.size > UINT96_MAX) {
      throw new LadderError(`${level.side} level ${level.index}: size overflows uint96`);
    }
  }
}

/** No buy may sit at or above any sell, and no flip may cross its own side. */
export function assertNotCrossed(ladder: Ladder): void {
  const buys = ladder.levels.filter((l) => l.side === 'buy');
  const sells = ladder.levels.filter((l) => l.side === 'sell');
  const highestBuy = buys.reduce((m, l) => (l.price > m ? l.price : m), 0n);
  const lowestSell = sells.reduce((m, l) => (m === 0n || l.price < m ? l.price : m), 0n as bigint);
  if (highestBuy > 0n && lowestSell > 0n && highestBuy >= lowestSell) {
    throw new LadderError(
      `ladder is crossed: highest buy ${highestBuy} >= lowest sell ${lowestSell}`,
    );
  }
  for (const level of ladder.levels) {
    if (level.side === 'buy' && level.flipPrice <= level.price) {
      throw new LadderError(`buy level ${level.index}: flip price is not above the buy price`);
    }
    if (level.side === 'sell' && level.flipPrice >= level.price) {
      throw new LadderError(`sell level ${level.index}: flip price is not below the sell price`);
    }
  }
}

/** Every price the contract sees is a `uint32`. */
export function assertWireBounds(ladder: Ladder): void {
  for (const level of ladder.levels) {
    for (const [what, value] of [
      ['price', level.price],
      ['flip price', level.flipPrice],
    ] as const) {
      if (value <= 0n) {
        throw new LadderError(`${level.side} level ${level.index}: ${what} is not positive`);
      }
      if (value > UINT32_MAX) {
        throw new LadderError(
          `${level.side} level ${level.index}: ${what} ${value} overflows uint32`,
        );
      }
      if (value % ladder.params.tickSize !== 0n) {
        throw new LadderError(
          `${level.side} level ${level.index}: ${what} ${value} is not a multiple of the ` +
            `tick ${ladder.params.tickSize}`,
        );
      }
    }
  }
}

/* ───────────────────────────────── helpers ────────────────────────────────── */

/** pricePrecision units back to the 1e18 wire scale, for display. */
export function toWire(pricePp: bigint, params: MarketParams): bigint {
  return rescale(pricePp, params.pricePrecision, WIRE_PRICE_SCALE);
}

export function fmtBand(band: bigint): string {
  const whole = band / BAND_SCALE;
  const frac = (band % BAND_SCALE).toString().padStart(6, '0').replace(/0+$/, '') || '0';
  return `${whole}.${frac}`;
}

/**
 * Parse `0.98..1.02` into two `BAND_SCALE` integers. No floats: the string is split
 * and padded, so `0.9800001` is a parse error rather than a silent rounding.
 */
export function parseBand(text: string): { low: bigint; high: bigint } {
  const parts = text.split('..');
  if (parts.length !== 2) {
    throw new LadderError(`--band must look like 0.98..1.02, got ${JSON.stringify(text)}`);
  }
  const [low, high] = parts.map((p) => parseBandNumber(p.trim())) as [bigint, bigint];
  if (low >= high) throw new LadderError(`--band low ${text} is not below its high`);
  return { low, high };
}

function parseBandNumber(text: string): bigint {
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new LadderError(`${JSON.stringify(text)} is not a positive decimal band multiplier`);
  }
  const [whole = '0', frac = ''] = text.split('.');
  if (frac.length > 6) {
    throw new LadderError(
      `band multiplier ${text} has ${frac.length} decimal places; at most 6 are representable`,
    );
  }
  return BigInt(whole) * BAND_SCALE + BigInt(frac.padEnd(6, '0') || '0');
}
