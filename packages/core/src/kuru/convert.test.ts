import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { decodeFunctionData, type Address } from 'viem';
import { orderBookAbi } from '../abi/orderBook.js';
import { FORWARDABLE_SELECTORS, selectorOf } from './orders.js';
import {
  assertConversionMarket,
  assertMinAmountOut,
  AUSD_USDC_MARKET,
  buildConversion,
  conversionAmountIn,
  conversionRoute,
  ConversionPairError,
  DEFAULT_CONVERSION_SLIPPAGE_BPS,
  MAX_CONVERSION_SLIPPAGE_BPS,
  minAmountOutFor,
  SlippageFloorError,
  submitConversion,
} from './convert.js';
import {
  AUSD_USDC_ADDRESS,
  AUSD_USDC_MEASURED,
  AUSD_USDC_PARAMS,
} from './__fixtures__/ausdUsdc.js';
import type { ModeGate } from '../chain/mode.js';

const AUSD = AUSD_USDC_PARAMS.baseAsset;
const USDC = AUSD_USDC_PARAMS.quoteAsset;
const USDT0 = '0xe7cd86e13AC4309349F30B3435a9d337750fC82D' as Address;
const USER = '0x43a275C3Eb0BE7313f847FFA4fb6Bd366606A961' as Address;

/** The live measurement at block 101352729, used as the quote in every build test. */
const QUOTED_AUSD_FOR_5_USDC = AUSD_USDC_MEASURED.buy[1].out;
const QUOTED_USDC_FOR_5_AUSD = AUSD_USDC_MEASURED.sell[1].out;

describe('the direction comes from the market, not from its name', () => {
  it('agrees with the address this module ships', () => {
    expect(AUSD_USDC_MARKET.toLowerCase()).toBe(AUSD_USDC_ADDRESS.toLowerCase());
  });

  it('reads AUSD as the base and USDC as the quote', () => {
    // If Kuru ever redeploys this pair the other way round, this is the test that
    // fails rather than a user's USDC being spent to receive USDC.
    expect(AUSD_USDC_PARAMS.baseAsset).toBe(AUSD);
    expect(AUSD_USDC_PARAMS.quoteAsset).toBe(USDC);
  });

  it('converts USDC into AUSD with a market BUY', () => {
    const route = conversionRoute(AUSD_USDC_MARKET, AUSD_USDC_PARAMS, USDC, AUSD);
    expect(route.side).toBe('buy');
    expect(route.direction).toBe('quote-to-base');
  });

  it('converts AUSD into USDC with a market SELL', () => {
    const route = conversionRoute(AUSD_USDC_MARKET, AUSD_USDC_PARAMS, AUSD, USDC);
    expect(route.side).toBe('sell');
    expect(route.direction).toBe('base-to-quote');
  });

  it('refuses a token the market does not trade', () => {
    expect(() => conversionRoute(AUSD_USDC_MARKET, AUSD_USDC_PARAMS, USDT0, AUSD)).toThrow(
      ConversionPairError,
    );
  });

  it('refuses a conversion of a token into itself', () => {
    expect(() => conversionRoute(AUSD_USDC_MARKET, AUSD_USDC_PARAMS, AUSD, AUSD)).toThrow(
      ConversionPairError,
    );
  });

  it('refuses a market whose pair is not the one expected', () => {
    expect(() => assertConversionMarket(AUSD_USDC_PARAMS, { base: USDC, quote: AUSD })).toThrow(
      ConversionPairError,
    );
    expect(() =>
      assertConversionMarket(AUSD_USDC_PARAMS, { base: AUSD, quote: USDC }),
    ).not.toThrow();
  });

  it('the live measurement itself says which way AUSD comes out', () => {
    // Buying with USDC returns slightly LESS than the input (you cross the ask at
    // 1.000149); selling AUSD returns slightly MORE (you hit the bid at 1.000147).
    for (const { amountIn, out } of AUSD_USDC_MEASURED.buy) expect(out).toBeLessThan(amountIn);
    for (const { amountIn, out } of AUSD_USDC_MEASURED.sell) expect(out).toBeGreaterThan(amountIn);
  });
});

describe('the wire amount matches what the contract will debit', () => {
  it('scales a buy into pricePrecision units of the quote asset', () => {
    // _pricePrecisionToQuoteAssetPrecision(_quote) = _quote * 1e6 / 1e8
    const amount = conversionAmountIn(5_000_000n, AUSD_USDC_PARAMS, 'buy');
    expect(amount.wire).toBe(500_000_000n);
    expect(amount.effectiveIn).toBe(5_000_000n);
    expect(amount.adjusted).toBe(false);
  });

  it('scales a sell into sizePrecision units of the base asset', () => {
    // _sizePrecisionToBaseAssetPrecision(_size) = _size * 1e6 / 1e6
    const amount = conversionAmountIn(5_000_000n, AUSD_USDC_PARAMS, 'sell');
    expect(amount.wire).toBe(5_000_000n);
    expect(amount.effectiveIn).toBe(5_000_000n);
    expect(amount.adjusted).toBe(false);
  });

  it('is below one tick of size when there is nothing left to convert', () => {
    // sizePrecision 1e6 against 6-decimal AUSD means one base unit is one wire unit,
    // so the smallest convertible sell is 1 unit and 0 throws.
    expect(() => conversionAmountIn(0n, AUSD_USDC_PARAMS, 'sell')).toThrow();
    expect(conversionAmountIn(1n, AUSD_USDC_PARAMS, 'sell').wire).toBe(1n);
  });

  it('round-trips every amount, and flags the ones precision cannot express', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n ** 12n }), (amountIn) => {
        for (const side of ['buy', 'sell'] as const) {
          const a = conversionAmountIn(amountIn, AUSD_USDC_PARAMS, side);
          // Never claims to spend more than asked.
          expect(a.effectiveIn).toBeLessThanOrEqual(amountIn);
          expect(a.adjusted).toBe(a.effectiveIn !== amountIn);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('does not apply the resting-order minimum to a taker', () => {
    // The verified OrderBook checks minSize/maxSize only in addBuyOrder (line 185),
    // addSellOrder (255), the flip variants and batchUpdate. The two
    // placeAndExecuteMarket* functions check neither. AUSD/USDC's minSize is 10 AUSD,
    // so a 5 AUSD conversion is legal on chain and must be legal here.
    expect(AUSD_USDC_PARAMS.minSize).toBe(10_000_000n);
    const built = buildConversion({
      market: AUSD_USDC_MARKET,
      params: AUSD_USDC_PARAMS,
      tokenIn: AUSD,
      tokenOut: USDC,
      amountIn: 5_000_000n,
      expectedOut: QUOTED_USDC_FOR_5_AUSD,
    });
    expect(built.wireAmountIn).toBe(5_000_000n);
    expect(built.wireAmountIn).toBeLessThan(AUSD_USDC_PARAMS.minSize);
  });
});

describe('the encoding is the venue’s own, and stays on the allowlist', () => {
  it('encodes USDC->AUSD as placeAndExecuteMarketBuy with the quote spend', () => {
    const built = buildConversion({
      market: AUSD_USDC_MARKET,
      params: AUSD_USDC_PARAMS,
      tokenIn: USDC,
      tokenOut: AUSD,
      amountIn: 5_000_000n,
      expectedOut: QUOTED_AUSD_FOR_5_USDC,
    });
    expect(built.purpose).toBe('placeAndExecuteMarketBuy');
    expect(selectorOf(built.data)).toBe(FORWARDABLE_SELECTORS.placeAndExecuteMarketBuy);
    expect(built.to).toBe(AUSD_USDC_MARKET);

    const decoded = decodeFunctionData({ abi: orderBookAbi, data: built.data });
    expect(decoded.functionName).toBe('placeAndExecuteMarketBuy');
    expect(decoded.args).toEqual([500_000_000n, built.minAmountOut, true, false]);
  });

  it('encodes AUSD->USDC as placeAndExecuteMarketSell with the base size', () => {
    const built = buildConversion({
      market: AUSD_USDC_MARKET,
      params: AUSD_USDC_PARAMS,
      tokenIn: AUSD,
      tokenOut: USDC,
      amountIn: 5_000_000n,
      expectedOut: QUOTED_USDC_FOR_5_AUSD,
    });
    expect(built.purpose).toBe('placeAndExecuteMarketSell');
    expect(selectorOf(built.data)).toBe(FORWARDABLE_SELECTORS.placeAndExecuteMarketSell);

    const decoded = decodeFunctionData({ abi: orderBookAbi, data: built.data });
    expect(decoded.functionName).toBe('placeAndExecuteMarketSell');
    expect(decoded.args).toEqual([5_000_000n, built.minAmountOut, true, false]);
  });

  it('draws from the margin balance unless told otherwise, and never sends MON', () => {
    const margin = buildConversion({
      market: AUSD_USDC_MARKET,
      params: AUSD_USDC_PARAMS,
      tokenIn: USDC,
      tokenOut: AUSD,
      amountIn: 1_000_000n,
      expectedOut: AUSD_USDC_MEASURED.buy[0].out,
    });
    expect(decodeFunctionData({ abi: orderBookAbi, data: margin.data }).args?.[2]).toBe(true);

    const wallet = buildConversion({
      market: AUSD_USDC_MARKET,
      params: AUSD_USDC_PARAMS,
      tokenIn: USDC,
      tokenOut: AUSD,
      amountIn: 1_000_000n,
      expectedOut: AUSD_USDC_MEASURED.buy[0].out,
      isMargin: false,
    });
    expect(decodeFunctionData({ abi: orderBookAbi, data: wallet.data }).args?.[2]).toBe(false);
  });
});

describe('a zero or absurd minAmountOut is impossible', () => {
  it('defaults to 25 bps under the quote', () => {
    const built = buildConversion({
      market: AUSD_USDC_MARKET,
      params: AUSD_USDC_PARAMS,
      tokenIn: USDC,
      tokenOut: AUSD,
      amountIn: 5_000_000n,
      expectedOut: QUOTED_AUSD_FOR_5_USDC,
    });
    expect(built.slippageBps).toBe(DEFAULT_CONVERSION_SLIPPAGE_BPS);
    expect(built.minAmountOut).toBe((QUOTED_AUSD_FOR_5_USDC * 9975n) / 10_000n);
    expect(built.minAmountOut).toBeGreaterThan(0n);
  });

  it('refuses a zero floor, however it is reached', () => {
    expect(() => minAmountOutFor(0n, 25n)).toThrow(SlippageFloorError);
    expect(() => assertMinAmountOut(0n, QUOTED_AUSD_FOR_5_USDC)).toThrow(SlippageFloorError);
    expect(() =>
      buildConversion({
        market: AUSD_USDC_MARKET,
        params: AUSD_USDC_PARAMS,
        tokenIn: USDC,
        tokenOut: AUSD,
        amountIn: 5_000_000n,
        expectedOut: QUOTED_AUSD_FOR_5_USDC,
        minAmountOut: 0n,
      }),
    ).toThrow(SlippageFloorError);
  });

  it('refuses slippage wider than the 1% cap, and negative slippage', () => {
    expect(() => minAmountOutFor(1_000_000n, MAX_CONVERSION_SLIPPAGE_BPS + 1n)).toThrow(
      SlippageFloorError,
    );
    expect(() => minAmountOutFor(1_000_000n, -1n)).toThrow(SlippageFloorError);
    expect(minAmountOutFor(1_000_000n, MAX_CONVERSION_SLIPPAGE_BPS)).toBe(990_000n);
  });

  it('refuses an override further below the quote than the cap allows', () => {
    // 1 base unit against a 4.999255 AUSD quote: the classic "accept anything" order,
    // dressed up as a non-zero number.
    expect(() => assertMinAmountOut(1n, QUOTED_AUSD_FOR_5_USDC)).toThrow(SlippageFloorError);
  });

  it('refuses a floor above the quote, which could only revert', () => {
    expect(() => assertMinAmountOut(QUOTED_AUSD_FOR_5_USDC + 1n, QUOTED_AUSD_FOR_5_USDC)).toThrow(
      SlippageFloorError,
    );
  });

  it('accepts nothing outside [quote * (1 - cap), quote], for any quote', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1_000n, max: 10n ** 15n }),
        fc.bigInt({ min: 0n, max: 10n ** 15n }),
        (expectedOut, minOut) => {
          const floor = (expectedOut * (10_000n - MAX_CONVERSION_SLIPPAGE_BPS)) / 10_000n;
          const legal = minOut > 0n && minOut >= floor && minOut <= expectedOut;
          let threw = false;
          try {
            assertMinAmountOut(minOut, expectedOut);
          } catch {
            threw = true;
          }
          expect(threw).toBe(!legal);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('every floor the module produces survives its own check', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1_000n, max: 10n ** 15n }),
        fc.bigInt({ min: 0n, max: MAX_CONVERSION_SLIPPAGE_BPS }),
        (expectedOut, slippageBps) => {
          const min = minAmountOutFor(expectedOut, slippageBps);
          expect(() => assertMinAmountOut(min, expectedOut)).not.toThrow();
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('a conversion goes through submit(), and submits nothing by default', () => {
  const built = buildConversion({
    market: AUSD_USDC_MARKET,
    params: AUSD_USDC_PARAMS,
    tokenIn: USDC,
    tokenOut: AUSD,
    amountIn: 5_000_000n,
    expectedOut: QUOTED_AUSD_FOR_5_USDC,
  });

  const gate = (over: Partial<ModeGate> = {}): ModeGate => ({
    mode: 'testnet',
    runMode: 'dryrun',
    realFundsAcknowledged: false,
    ...over,
  });

  it('returns DRYRUN with no transport in the default mode', async () => {
    const result = await submitConversion(USER, built, undefined, { gate: gate() });
    expect(result.status).toBe('DRYRUN');
    // NO_TRANSPORT, not MODE_NOT_LIVE: submit() no longer reads the mode. A build with
    // nothing to submit through cannot send whatever the environment says.
    expect(result.reason).toBe('NO_TRANSPORT');
    expect(result.message).not.toMatch(/0x/);
  });

  it('stays DRYRUN when only two of the three switches are thrown', async () => {
    for (const partial of [
      { mode: 'mainnet' as const },
      { mode: 'mainnet' as const, runMode: 'live' as const },
      { runMode: 'live' as const, realFundsAcknowledged: true },
    ]) {
      const result = await submitConversion(USER, built, undefined, { gate: gate(partial) });
      expect(result.status).toBe('DRYRUN');
    }
  });

  it('hands the transport a single zero-value call to the market when armed', async () => {
    let seen: { to: Address; value?: bigint }[] = [];
    const result = await submitConversion(
      USER,
      built,
      {
        send: async (request) => {
          seen = request.calls.map((c) => ({
            to: c.to,
            ...(c.value !== undefined ? { value: c.value } : {}),
          }));
          expect(request.sender).toBe(USER);
          return { status: 'SUBMITTED' as const };
        },
      },
      { gate: gate({ mode: 'mainnet', runMode: 'live', realFundsAcknowledged: true }) },
    );
    expect(result.status).toBe('SUBMITTED');
    expect(seen).toEqual([{ to: AUSD_USDC_MARKET, value: 0n }]);
  });
});
