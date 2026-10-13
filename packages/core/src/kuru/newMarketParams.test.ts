import { describe, expect, it } from 'vitest';
import { decodeMarketParams } from './params.js';
import { orderBookTypeFor, ORDER_BOOK_TYPE } from './marketType.js';
import {
  CBBTC_USDC_PARAMS,
  CBBTC_USDC_TUPLE,
  EMO_MON_PARAMS,
  EMO_MON_TUPLE,
  MON_USDC_PARAMS,
  MON_USDC_TUPLE,
  WETH_USDC_PARAMS,
  WETH_USDC_TUPLE,
  XAUT0_USDC_PARAMS,
  XAUT0_USDC_TUPLE,
} from './__fixtures__/newMarkets.js';

/**
 * Item 1: `getMarketParams()` decodes to exactly the values `reports/MARKETS-VERIFIED.md`
 * measured live for the five markets being added to the live allowlist. This is a pure
 * decode test against a hand-built tuple that matches the report's numbers — no network
 * call, same pattern `__fixtures__/ausdUsdc.ts` and `__fixtures__/books.ts` use.
 */
describe('decodeMarketParams — the five newly-verified markets', () => {
  it('MON/USDC 0x065c9d28… decodes to the report’s row', () => {
    expect(decodeMarketParams(MON_USDC_TUPLE)).toEqual(MON_USDC_PARAMS);
  });

  it('WETH/USDC 0xa6afd386… decodes to the report’s row', () => {
    expect(decodeMarketParams(WETH_USDC_TUPLE)).toEqual(WETH_USDC_PARAMS);
  });

  it('cbBTC/USDC 0x40c49f17… decodes to the report’s row', () => {
    expect(decodeMarketParams(CBBTC_USDC_TUPLE)).toEqual(CBBTC_USDC_PARAMS);
  });

  it('XAUt0/USDC 0x851145ea… decodes to the report’s row', () => {
    expect(decodeMarketParams(XAUT0_USDC_TUPLE)).toEqual(XAUT0_USDC_PARAMS);
  });

  it('emo/MON 0xe7a4f903… decodes to the report’s row, using the CHAIN maxSize', () => {
    // The registry wraps maxSize at 64 bits for this market (report §1, finding #5):
    // 20000000000000000000 - 2**64 = 1553255926290448384. Decoding the chain's own
    // tuple must produce the real value, not the registry's wrapped one.
    const decoded = decodeMarketParams(EMO_MON_TUPLE);
    expect(decoded).toEqual(EMO_MON_PARAMS);
    expect(decoded.maxSize).toBe(20_000_000_000_000_000_000n);
    expect(decoded.maxSize - 2n ** 64n).toBe(1_553_255_926_290_448_384n);
  });

  it('all five have distinct base/quote pairs', () => {
    const pairs = [
      [MON_USDC_PARAMS.baseAsset, MON_USDC_PARAMS.quoteAsset],
      [WETH_USDC_PARAMS.baseAsset, WETH_USDC_PARAMS.quoteAsset],
      [CBBTC_USDC_PARAMS.baseAsset, CBBTC_USDC_PARAMS.quoteAsset],
      [XAUT0_USDC_PARAMS.baseAsset, XAUT0_USDC_PARAMS.quoteAsset],
      [EMO_MON_PARAMS.baseAsset, EMO_MON_PARAMS.quoteAsset],
    ];
    const unique = new Set(pairs.map(([b, q]) => `${b.toLowerCase()}/${q.toLowerCase()}`));
    expect(unique.size).toBe(5);
  });
});

/**
 * `emo` is not a unique ticker in Kuru's registry (report §1: "at least four different
 * tokens use emo/EMO"), and emo/MON quotes in native MON, not a stablecoin — the only
 * two of the five markets whose Router `OrderBookType` is not `NO_NATIVE`. Cheap
 * cross-check against `marketType.ts`, using only real addresses from the report.
 */
describe('OrderBookType agrees with which side is native, for the two markets that have one', () => {
  it('MON/USDC is NATIVE_IN_BASE (MON is the base, at address zero)', () => {
    expect(orderBookTypeFor(MON_USDC_PARAMS.baseAsset, MON_USDC_PARAMS.quoteAsset)).toBe(
      ORDER_BOOK_TYPE.NATIVE_IN_BASE,
    );
  });

  it('emo/MON is NATIVE_IN_QUOTE (MON is the quote, at address zero)', () => {
    expect(orderBookTypeFor(EMO_MON_PARAMS.baseAsset, EMO_MON_PARAMS.quoteAsset)).toBe(
      ORDER_BOOK_TYPE.NATIVE_IN_QUOTE,
    );
  });

  it('WETH/USDC, cbBTC/USDC and XAUt0/USDC are all NO_NATIVE', () => {
    for (const p of [WETH_USDC_PARAMS, CBBTC_USDC_PARAMS, XAUT0_USDC_PARAMS]) {
      expect(orderBookTypeFor(p.baseAsset, p.quoteAsset)).toBe(ORDER_BOOK_TYPE.NO_NATIVE);
    }
  });
});
