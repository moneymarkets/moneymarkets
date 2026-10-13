import { describe, expect, it } from 'vitest';
import {
  assertOrderWithinCap,
  assertQuoteAmountWithinCap,
  CapExceededError,
  MAX_ORDER_NOTIONAL_AUSD,
} from './caps.js';
import { quoteAmountInCapUnits, quoteValuationFor } from './quoteValuation.js';
import { buildLimitOrder, buildMarketOrder, minSizeBase } from '../kuru/orders.js';
import {
  EMO_MON_MARKET,
  EMO_MON_PARAMS,
  EMO_MON_PM_BEST_BID_WIRE,
  EMO_MON_PM_MATRIX,
  MIN_SIZE_WORTH,
  MON_USDC_PM_MID_WIRE,
} from '../kuru/__fixtures__/newMarkets.js';

/**
 * emo/MON against the $1,000 order cap, side by side, at realistic sizes.
 *
 * The companion of `newMarketCapInteraction.test.ts`, which measures the four
 * dollar-quoted books. emo/MON is quoted in native MON, so an order's value arrives in
 * wei of MON and is valued at the MON/USDC mid before it meets the cap. Every number here
 * is a real read: emo/MON's params and book (`reports/MARKETS-VERIFIED.md` sections 1-2,
 * re-read unchanged at block 107,310,277) and the MON/USDC mid at that block, 0.025861.
 *
 * At that mid the cap is 38,668.26 MON per order (it was 232.0096 MON under the $6 cap in
 * force until 2026-10-13). For each side: a size that passes, including the sizes $6 used
 * to refuse, and a size that is refused because it is genuinely worth more than $1,000.
 */

const MON = 10n ** 18n;
const EMO = 10n ** 18n;
const mon = quoteValuationFor(EMO_MON_PARAMS)!;

/** An order's value in wei of MON: price (wire) times size, both 18-decimal here. */
function quoteWeiOf(priceWire: bigint, sizeBase: bigint): bigint {
  return (
    (priceWire * sizeBase * 10n ** BigInt(EMO_MON_PARAMS.quoteDecimals)) /
    (10n ** 18n * 10n ** BigInt(EMO_MON_PARAMS.baseDecimals))
  );
}

function dollars(quoteWei: bigint): bigint {
  return quoteAmountInCapUnits(quoteWei, mon, MON_USDC_PM_MID_WIRE)!;
}

const passes = (quoteWei: bigint) =>
  expect(() =>
    assertQuoteAmountWithinCap(quoteWei, EMO_MON_PARAMS, MON_USDC_PM_MID_WIRE),
  ).not.toThrow();
const refused = (quoteWei: bigint) =>
  expect(() => assertQuoteAmountWithinCap(quoteWei, EMO_MON_PARAMS, MON_USDC_PM_MID_WIRE)).toThrow(
    CapExceededError,
  );

describe('emo/MON’s resting minimum fits under the cap once it is valued in dollars', () => {
  it('the minimum is 200 emo', () => {
    expect(minSizeBase(EMO_MON_PARAMS)).toBe(200n * EMO);
    expect(minSizeBase(EMO_MON_PARAMS)).toBe(MIN_SIZE_WORTH.emoMon.minSizeBase);
  });

  it('is worth $0.129279 at the measured 4.998990002 MON fill, about 0.013% of the cap', () => {
    expect(dollars(MIN_SIZE_WORTH.emoMon.worthQuote)).toBe(129_279n);
    expect(dollars(MIN_SIZE_WORTH.emoMon.worthQuote)).toBeLessThan(MAX_ORDER_NOTIONAL_AUSD);
  });

  it('compared raw, as it was until 2026-09-23, the same order is about 5 billion times the cap', () => {
    // 833 billion times the $6 cap of that day; 4,998,990,002 times today's $1,000.
    expect(MIN_SIZE_WORTH.emoMon.worthQuote / MAX_ORDER_NOTIONAL_AUSD).toBe(4_998_990_002n);
    expect(() => assertOrderWithinCap(MIN_SIZE_WORTH.emoMon.worthQuote)).toThrow(CapExceededError);
  });
});

describe('limit buy', () => {
  it('passes 200 emo at the 0.031 best bid: 6.2 MON, $0.160339', () => {
    const order = buildLimitOrder({
      market: EMO_MON_MARKET,
      params: EMO_MON_PARAMS,
      side: 'buy',
      priceWire: EMO_MON_PM_BEST_BID_WIRE,
      sizeBase: 200n * EMO,
    });
    // The same calldata arguments the owner's eth_call carried.
    expect(order.price.price).toBe(EMO_MON_PM_MATRIX.limitBuyMin.price);
    expect(order.size.size).toBe(EMO_MON_PM_MATRIX.limitBuyMin.size);
    const value = quoteWeiOf(order.price.priceWire, order.size.sizeBase);
    expect(value).toBe(6_200_000_000_000_000_000n);
    expect(dollars(value)).toBe(160_339n);
    passes(value);
  });

  it('passes 9,000 emo at 0.025, the first real bid: 225 MON, $5.818725', () => {
    const value = quoteWeiOf(25_000_000_000_000_000n, 9_000n * EMO);
    expect(value).toBe(225n * MON);
    expect(dollars(value)).toBe(5_818_725n);
    passes(value);
  });

  it('passes 10,000 emo at 0.025, which $6 refused: 250 MON, $6.46525', () => {
    const order = buildLimitOrder({
      market: EMO_MON_MARKET,
      params: EMO_MON_PARAMS,
      side: 'buy',
      priceWire: 25_000_000_000_000_000n,
      sizeBase: 10_000n * EMO,
    });
    const value = quoteWeiOf(order.price.priceWire, order.size.sizeBase);
    expect(value).toBe(250n * MON);
    expect(dollars(value)).toBe(6_465_250n);
    passes(value);
  });

  it('refuses 1,600,000 emo at 0.025: 40,000 MON, $1,034.44', () => {
    const order = buildLimitOrder({
      market: EMO_MON_MARKET,
      params: EMO_MON_PARAMS,
      side: 'buy',
      priceWire: 25_000_000_000_000_000n,
      sizeBase: 1_600_000n * EMO,
    });
    const value = quoteWeiOf(order.price.priceWire, order.size.sizeBase);
    expect(value).toBe(40_000n * MON);
    expect(dollars(value)).toBe(1_034_440_000n);
    refused(value);
  });
});

describe('limit sell', () => {
  it('passes 200 emo at 0.0311, one tick over the bid (there is no ask): 6.22 MON, $0.160856', () => {
    const order = buildLimitOrder({
      market: EMO_MON_MARKET,
      params: EMO_MON_PARAMS,
      side: 'sell',
      priceWire: 31_100_000_000_000_000n,
      sizeBase: 200n * EMO,
    });
    expect(order.price.price).toBe(EMO_MON_PM_MATRIX.limitSellMin.price);
    const value = quoteWeiOf(order.price.priceWire, order.size.sizeBase);
    expect(value).toBe(6_220_000_000_000_000_000n);
    expect(dollars(value)).toBe(160_856n);
    passes(value);
  });

  it('passes 10,000 emo at 0.0311, which $6 refused: 311 MON, $8.04', () => {
    const value = quoteWeiOf(31_100_000_000_000_000n, 10_000n * EMO);
    expect(value).toBe(311n * MON);
    expect(dollars(value)).toBe(8_042_771n);
    passes(value);
  });

  it('refuses 1,300,000 emo at 0.0311: 40,430 MON, $1,045.56', () => {
    const value = quoteWeiOf(31_100_000_000_000_000n, 1_300_000n * EMO);
    expect(value).toBe(40_430n * MON);
    expect(dollars(value)).toBe(1_045_560_230n);
    refused(value);
  });
});

describe('market buy', () => {
  it('passes 1 MON, the matrix’s own size: $0.025861', () => {
    const call = buildMarketOrder({
      market: EMO_MON_MARKET,
      params: EMO_MON_PARAMS,
      side: 'buy',
      amount: MON,
      minAmountOut: 0n,
    });
    expect(BigInt(`0x${call.data.slice(10, 74)}`)).toBe(EMO_MON_PM_MATRIX.marketBuy1Mon.quoteSize);
    expect(dollars(MON)).toBe(25_861n);
    passes(MON);
  });

  it('passes 38,668 MON ($999.993148) and refuses 38,669 MON ($1,000.019009)', () => {
    expect(dollars(38_668n * MON)).toBe(999_993_148n);
    passes(38_668n * MON);
    expect(dollars(38_669n * MON)).toBe(1_000_019_009n);
    refused(38_669n * MON);
  });

  it('passes 233 MON ($6.025613), the first whole MON the $6 cap refused', () => {
    expect(dollars(233n * MON)).toBe(6_025_613n);
    passes(233n * MON);
  });
});

describe('market sell', () => {
  it('passes 200 emo valued at the 0.031 best bid, 6.2 MON, and at its measured fill, 4.998990002 MON', () => {
    // The relayer values a market sell at the book's best bid, which over-reads a thin
    // book — here the 0.031 bid is dust — and that is the safe direction for a cap.
    passes(quoteWeiOf(EMO_MON_PM_BEST_BID_WIRE, 200n * EMO));
    passes(EMO_MON_PM_MATRIX.zeroSenderSellMin.amountOut);
  });

  it('passes 10,000 emo at the 0.031 best bid, which $6 refused: 310 MON, $8.01691', () => {
    const value = quoteWeiOf(EMO_MON_PM_BEST_BID_WIRE, 10_000n * EMO);
    expect(value).toBe(310n * MON);
    expect(dollars(value)).toBe(8_016_910n);
    passes(value);
  });

  it('refuses 1,300,000 emo at the 0.031 best bid: 40,300 MON, $1,042.1983', () => {
    const value = quoteWeiOf(EMO_MON_PM_BEST_BID_WIRE, 1_300_000n * EMO);
    expect(value).toBe(40_300n * MON);
    expect(dollars(value)).toBe(1_042_198_300n);
    refused(value);
  });
});

describe('without a MON price, no side passes', () => {
  it('refuses every side’s smallest order rather than valuing it at anything', () => {
    for (const value of [6_200_000_000_000_000_000n, 6_220_000_000_000_000_000n, MON]) {
      expect(() => assertQuoteAmountWithinCap(value, EMO_MON_PARAMS)).toThrow(/no usable mid/);
    }
  });
});
