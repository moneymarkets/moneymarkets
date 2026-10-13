/**
 * Fixed-point money math. Every value that represents money, a price, or a size is a
 * `bigint` (rule A2.6). The only functions here that produce a `string` are the
 * display formatters at the bottom, and nothing in this file ever produces a
 * `number` from a monetary value.
 */

/** Kuru wire prices for real markets are 1e18-scaled (spec §4.4 I3). */
export const WIRE_PRICE_SCALE = 10n ** 18n;

/**
 * `minFeesPps` and ladder spacing are parts-per-million on Kuru, not basis points.
 * 100 pps = 1 bp, so 0.30% = 3000 pps. Kuru's own liquidity example passes basis
 * points here, which places a ladder 100x too tight (framework §4.1, error 2).
 */
export const PPS_PER_BP = 100n;
export const PPS_PER_UNIT = 1_000_000n;
export const BPS_PER_UNIT = 10_000n;

export function bpsToPps(bps: bigint): bigint {
  return bps * PPS_PER_BP;
}

export function ppsToBps(pps: bigint): bigint {
  if (pps % PPS_PER_BP !== 0n) {
    throw new Error(`ppsToBps: ${pps} pps is not a whole number of basis points`);
  }
  return pps / PPS_PER_BP;
}

/**
 * Align a price down to the market's tick by integer division.
 *
 * Kuru's SDK exposes `clipToDecimals`, which truncates the decimal *string* and is
 * not tick alignment at all (framework §4.1, error 5). A price that survives string
 * truncation can still revert with `TickSizeError`.
 */
export function roundDownToTick(price: bigint, tick: bigint): bigint {
  assertPositiveTick(tick);
  if (price < 0n) throw new Error('roundDownToTick: negative price');
  return (price / tick) * tick;
}

export function roundUpToTick(price: bigint, tick: bigint): bigint {
  assertPositiveTick(tick);
  if (price < 0n) throw new Error('roundUpToTick: negative price');
  const down = (price / tick) * tick;
  return down === price ? price : down + tick;
}

/** Ties round down, so the result is never further from `price` than one tick. */
export function roundNearestTick(price: bigint, tick: bigint): bigint {
  assertPositiveTick(tick);
  if (price < 0n) throw new Error('roundNearestTick: negative price');
  const down = (price / tick) * tick;
  const rem = price - down;
  return rem * 2n > tick ? down + tick : down;
}

/**
 * Align a limit price the way the side wants it: a buy never pays more than asked,
 * a sell never asks less than intended.
 */
export function roundToTickForSide(price: bigint, tick: bigint, side: 'buy' | 'sell'): bigint {
  return side === 'buy' ? roundDownToTick(price, tick) : roundUpToTick(price, tick);
}

function assertPositiveTick(tick: bigint): void {
  if (tick <= 0n) throw new Error(`tickSize must be positive, got ${tick}`);
}

export type RoundingMode = 'floor' | 'ceil';

/**
 * Rescale an integer from one fixed-point scale to another, truncating toward zero.
 * Used to move between the 1e18 wire scale and a market's `pricePrecision`.
 */
export function rescale(value: bigint, fromScale: bigint, toScale: bigint): bigint {
  return rescaleWithRounding(value, fromScale, toScale, 'floor');
}

/**
 * Rescale with an explicit direction.
 *
 * Scaling *down* loses the remainder, and which way that remainder goes matters: a
 * sell limit that floors can end up below the price the user typed, which is a real
 * (if small) loss. Buys floor, sells ceil.
 */
export function rescaleWithRounding(
  value: bigint,
  fromScale: bigint,
  toScale: bigint,
  mode: RoundingMode,
): bigint {
  if (fromScale <= 0n || toScale <= 0n) throw new Error('rescale: scales must be positive');
  if (fromScale === toScale) return value;
  if (toScale > fromScale) return value * (toScale / fromScale);
  const divisor = fromScale / toScale;
  const quotient = value / divisor;
  if (mode === 'floor' || value % divisor === 0n || value < 0n) return quotient;
  return quotient + 1n;
}

/** Parse a human decimal string ("1.234") into base units. No floats involved. */
export function parseUnits(value: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) {
    throw new Error(`parseUnits: bad decimals ${decimals}`);
  }
  const trimmed = value.trim();
  if (!/^-?\d*(\.\d*)?$/.test(trimmed) || trimmed === '' || trimmed === '.' || trimmed === '-') {
    throw new Error(`parseUnits: ${JSON.stringify(value)} is not a decimal number`);
  }
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [whole = '', fractionRaw = ''] = unsigned.split('.');
  if (fractionRaw.length > decimals) {
    throw new Error(
      `parseUnits: ${value} has ${fractionRaw.length} decimal places but only ${decimals} are representable`,
    );
  }
  const fraction = fractionRaw.padEnd(decimals, '0');
  const magnitude = BigInt((whole === '' ? '0' : whole) + fraction);
  return negative ? -magnitude : magnitude;
}

/**
 * Render base units as a decimal string. Display only — never feed the result back
 * into arithmetic.
 */
export function formatUnits(value: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) {
    throw new Error(`formatUnits: bad decimals ${decimals}`);
  }
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals === 0 ? '' : digits.slice(digits.length - decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/**
 * Format an AUSD amount the way the design system wants it: grouped thousands and
 * exactly two decimal places, tabular-nums friendly. Display only.
 */
export function formatAusd(value: bigint, decimals = 6): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const centsScale = 100n;
  // Round half-up at the cent, entirely in integer math.
  const cents = (magnitude * centsScale + scale / 2n) / scale;
  const whole = cents / centsScale;
  const remainder = cents % centsScale;
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}.${remainder.toString().padStart(2, '0')}`;
}
