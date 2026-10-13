import { describe, expect, it } from 'vitest';
import { buildMarketOrder, minSizeBase, toContractPrice, toContractSize } from './orders.js';
import { normalizePrice, normalizeSize } from './book.js';
import { rescale } from '../math/fixed.js';
import {
  ACTION_MATRIX,
  CBBTC_USDC_BEST_ASK_WIRE,
  CBBTC_USDC_BEST_BID_WIRE,
  CBBTC_USDC_MARKET,
  CBBTC_USDC_PARAMS,
  EMO_MON_MARKET,
  EMO_MON_PARAMS,
  MIN_SIZE_WORTH,
  MON_USDC_MARKET,
  MON_USDC_PARAMS,
  WETH_USDC_MARKET,
  WETH_USDC_PARAMS,
  XAUT0_USDC_BEST_ASK_WIRE,
  XAUT0_USDC_BEST_BID_WIRE,
  XAUT0_USDC_MARKET,
  XAUT0_USDC_PARAMS,
} from './__fixtures__/newMarkets.js';

/**
 * Item 2: cbBTC and XAUt0 genuinely use a different scale from every market this
 * package had a fixture for before today (MON/USDC, MON/AUSD, AUSD/USDC all share
 * `pricePrecision` 1e8; cbBTC and XAUt0 are 1e4). A formatter or calldata builder that
 * silently assumes the 1e8/1e6-style precision the old fixtures share would misprice
 * both of these — this file proves the real conversion helpers (`orders.ts`,
 * `book.ts`, `math/fixed.ts`) do not make that assumption, using the exact numbers
 * `reports/MARKETS-VERIFIED.md` measured with real `eth_call`s against these two
 * books, not invented ones.
 */

describe('the scales really do differ from MON/USDC (report §1 "The scales really do differ")', () => {
  it('cbBTC/USDC and XAUt0/USDC both use pricePrecision 1e4, not MON/USDC’s 1e8', () => {
    expect(CBBTC_USDC_PARAMS.pricePrecision).toBe(10_000n);
    expect(XAUT0_USDC_PARAMS.pricePrecision).toBe(10_000n);
    expect(MON_USDC_PARAMS.pricePrecision).toBe(100_000_000n);
    expect(CBBTC_USDC_PARAMS.pricePrecision).not.toBe(MON_USDC_PARAMS.pricePrecision);
  });

  it('cbBTC and XAUt0 sizePrecision equals 10**baseDecimals; MON/USDC and WETH/USDC do not', () => {
    // Report §1: "For cbBTC and XAUt0, sizePrecision == 10^baseDecimals, so a size in
    // contract units equals a size in token base units. For MON/USDC, WETH/USDC and
    // emo/MON it does not."
    expect(CBBTC_USDC_PARAMS.sizePrecision).toBe(10n ** BigInt(CBBTC_USDC_PARAMS.baseDecimals));
    expect(XAUT0_USDC_PARAMS.sizePrecision).toBe(10n ** BigInt(XAUT0_USDC_PARAMS.baseDecimals));
    expect(MON_USDC_PARAMS.sizePrecision).not.toBe(10n ** BigInt(MON_USDC_PARAMS.baseDecimals));
    expect(WETH_USDC_PARAMS.sizePrecision).not.toBe(10n ** BigInt(WETH_USDC_PARAMS.baseDecimals));
  });

  it('cbBTC has 8 base decimals and XAUt0 has 6, against MON/USDC’s 18', () => {
    expect(CBBTC_USDC_PARAMS.baseDecimals).toBe(8);
    expect(XAUT0_USDC_PARAMS.baseDecimals).toBe(6);
    expect(MON_USDC_PARAMS.baseDecimals).toBe(18);
  });
});

describe('toContractPrice at cbBTC/XAUt0 precision matches the report’s own calldata args', () => {
  // The report's "resting limit buy/sell" rows give the exact price arg this repo's own
  // `buildLimitOrder` produced for a real `eth_call`. Reproducing that price from the
  // measured bestBidAsk is therefore a check against a real, independently-recorded
  // number, not a self-consistency check against this file's own fixtures.
  it('cbBTC/USDC: bestBid 86495.71 -> price 864957100, bestAsk 86530.32 -> price 865303200', () => {
    expect(toContractPrice(CBBTC_USDC_BEST_BID_WIRE, CBBTC_USDC_PARAMS, 'buy').price).toBe(
      864_957_100n,
    );
    expect(toContractPrice(CBBTC_USDC_BEST_ASK_WIRE, CBBTC_USDC_PARAMS, 'sell').price).toBe(
      865_303_200n,
    );
  });

  it('XAUt0/USDC: bestBid 4333.88 -> price 43338800, bestAsk 4336.01 -> price 43360100', () => {
    expect(toContractPrice(XAUT0_USDC_BEST_BID_WIRE, XAUT0_USDC_PARAMS, 'buy').price).toBe(
      43_338_800n,
    );
    expect(toContractPrice(XAUT0_USDC_BEST_ASK_WIRE, XAUT0_USDC_PARAMS, 'sell').price).toBe(
      43_360_100n,
    );
  });

  it('a formatter hard-coded to MON/USDC’s 1e8 pricePrecision fails loudly on cbBTC rather than silently mispricing it', () => {
    // At cbBTC's real price (~86495.71), assuming MON/USDC's 1e8 pricePrecision instead
    // of cbBTC's own 1e4 inflates the aligned price 10,000x past uint32's range — so
    // the wrong-scale assumption cannot even reach the chain as a plausible-looking
    // wrong number; toContractPrice's own overflow guard refuses it outright.
    const wrongScale = { ...CBBTC_USDC_PARAMS, pricePrecision: 100_000_000n };
    expect(() => toContractPrice(CBBTC_USDC_BEST_BID_WIRE, wrongScale, 'buy')).toThrow(
      /overflows uint32/,
    );
    // The real 1e4 precision, by contrast, encodes without any trouble.
    expect(() =>
      toContractPrice(CBBTC_USDC_BEST_BID_WIRE, CBBTC_USDC_PARAMS, 'buy'),
    ).not.toThrow();
  });

  it('rescale() alone reproduces the same wire-to-pricePrecision conversion', () => {
    expect(rescale(CBBTC_USDC_BEST_BID_WIRE, 10n ** 18n, CBBTC_USDC_PARAMS.pricePrecision)).toBe(
      864_957_100n,
    );
    expect(rescale(XAUT0_USDC_BEST_ASK_WIRE, 10n ** 18n, XAUT0_USDC_PARAMS.pricePrecision)).toBe(
      43_360_100n,
    );
  });
});

describe('toContractSize / minSizeBase at cbBTC/XAUt0 precision', () => {
  it('cbBTC minSize in contract units IS the base-unit amount (sizePrecision == 1e8)', () => {
    // 0.000125 cbBTC (12500 sats) is both the sizePrecision-units minSize and the
    // base-unit minSize, because sizePrecision == 10**baseDecimals here.
    expect(CBBTC_USDC_PARAMS.minSize).toBe(12_500n);
    expect(minSizeBase(CBBTC_USDC_PARAMS)).toBe(12_500n);
    expect(minSizeBase(CBBTC_USDC_PARAMS)).toBe(MIN_SIZE_WORTH.cbbtcUsdc.minSizeBase);
  });

  it('XAUt0 minSize in contract units IS the base-unit amount (sizePrecision == 1e6)', () => {
    expect(XAUT0_USDC_PARAMS.minSize).toBe(2_000n);
    expect(minSizeBase(XAUT0_USDC_PARAMS)).toBe(2_000n);
    expect(minSizeBase(XAUT0_USDC_PARAMS)).toBe(MIN_SIZE_WORTH.xaut0Usdc.minSizeBase);
  });

  it('round-trips cbBTC’s minimum through toContractSize back to the contract’s own minSize', () => {
    const min = minSizeBase(CBBTC_USDC_PARAMS);
    expect(toContractSize(min, CBBTC_USDC_PARAMS).size).toBe(CBBTC_USDC_PARAMS.minSize);
  });

  it('a formatter hard-coded to sizePrecision != baseScale would misprice cbBTC’s minimum', () => {
    // MON/USDC's sizePrecision (1e10) is NOT 10**baseDecimals (1e18); a helper that
    // always divides by a MON/USDC-shaped ratio would turn cbBTC's 12500 sats into
    // garbage instead of leaving it unchanged.
    expect(MON_USDC_PARAMS.sizePrecision).not.toBe(10n ** BigInt(MON_USDC_PARAMS.baseDecimals));
    expect(CBBTC_USDC_PARAMS.sizePrecision).toBe(10n ** BigInt(CBBTC_USDC_PARAMS.baseDecimals));
  });
});

describe('buildMarketOrder’s quoteSize at each market’s own scale, against the report’s real quoteSize args', () => {
  // Every market answered the same 1-USDC (or 1-MON) market buy with a DIFFERENT
  // quoteSize argument, because quoteSize = amount * pricePrecision / 10**quoteDecimals.
  // A scale error of any power of ten shows up here directly.
  it('MON/USDC: 1 USDC -> quoteSize 100000000 (pricePrecision 1e8)', () => {
    const call = buildMarketOrder({
      market: MON_USDC_MARKET,
      params: MON_USDC_PARAMS,
      side: 'buy',
      amount: 1_000_000n, // 1 USDC, 6 decimals
      minAmountOut: 0n,
    });
    // quoteSize is the first arg to placeAndExecuteMarketBuy: encoded right after the selector.
    expect(quoteSizeArg(call.data)).toBe(ACTION_MATRIX.monUsdc.marketBuy1Usdc.quoteSize);
  });

  it('WETH/USDC, cbBTC/USDC and XAUt0/USDC: 1 USDC -> quoteSize 10000 (pricePrecision 1e4), NOT 1e8-scaled', () => {
    for (const [params, market, expected] of [
      [WETH_USDC_PARAMS, WETH_USDC_MARKET, ACTION_MATRIX.wethUsdc],
      [CBBTC_USDC_PARAMS, CBBTC_USDC_MARKET, ACTION_MATRIX.cbbtcUsdc],
      [XAUT0_USDC_PARAMS, XAUT0_USDC_MARKET, ACTION_MATRIX.xaut0Usdc],
    ] as const) {
      const call = buildMarketOrder({
        market,
        params,
        side: 'buy',
        amount: 1_000_000n,
        minAmountOut: 0n,
      });
      expect(quoteSizeArg(call.data)).toBe(expected.marketBuy1Usdc.quoteSize);
      expect(quoteSizeArg(call.data)).not.toBe(ACTION_MATRIX.monUsdc.marketBuy1Usdc.quoteSize);
    }
  });

  it('emo/MON: 1 MON -> quoteSize 100000 (pricePrecision 1e5, quoteDecimals 18)', () => {
    const call = buildMarketOrder({
      market: EMO_MON_MARKET,
      params: EMO_MON_PARAMS,
      side: 'buy',
      amount: 1_000_000_000_000_000_000n, // 1 MON, 18 decimals
      minAmountOut: 0n,
    });
    expect(quoteSizeArg(call.data)).toBe(ACTION_MATRIX.emoMon.marketBuy1Mon.quoteSize);
  });
});

describe('book.ts normalizeSize/normalizePrice at cbBTC precision (I3/I4 at a non-MON/USDC scale)', () => {
  it('normalizePrice: contract-getL2Book pricePrecision units -> wire scale, at cbBTC’s 1e4', () => {
    // 864957100 pricePrecision units (the report's own resting-buy price arg) lifted
    // back to the 1e18 wire scale must reproduce the measured bestBid, 86495.71.
    expect(normalizePrice('864957100', 'contract-getL2Book', CBBTC_USDC_PARAMS)).toBe(
      CBBTC_USDC_BEST_BID_WIRE,
    );
  });

  it('normalizeSize: sizePrecision units -> base units, at cbBTC’s 1:1 ratio', () => {
    // sizePrecision == 10**baseDecimals for cbBTC, so this is an identity — and that is
    // exactly the case a MON/USDC-shaped assumption (sizePrecision != base scale) gets
    // wrong.
    expect(normalizeSize('12500', 'ws-monadDepth', CBBTC_USDC_PARAMS)).toBe(12_500n);
  });

  it('normalizeSize: sizePrecision units -> base units, at XAUt0’s 1:1 ratio', () => {
    expect(normalizeSize('2000', 'ws-monadDepth', XAUT0_USDC_PARAMS)).toBe(2_000n);
  });
});

/** Decode the first `uint96`/`uint256` argument after the 4-byte selector. */
function quoteSizeArg(data: `0x${string}`): bigint {
  return BigInt(`0x${data.slice(10, 10 + 64)}`);
}
