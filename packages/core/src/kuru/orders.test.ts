import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  buildCancelOrders,
  buildDeposit,
  buildLimitOrder,
  buildMarketOrder,
  buildWithdraw,
  FORWARDABLE_SELECTORS,
  isForwardableSelector,
  minSizeBase,
  selectorOf,
  toContractPrice,
  toContractSize,
} from './orders.js';
import { MON_AUSD_MARKET, MON_AUSD_PARAMS } from './__fixtures__/books.js';
import type { Address } from 'viem';

const MARGIN = '0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5' as Address;
const AUSD = '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a' as Address;
const USER = '0x1111111111111111111111111111111111111111' as Address;

describe('selectors match the deployed dispatchers', () => {
  // Read from the Monad mainnet contracts on 2026-09-02 by comparing ABI-derived
  // selectors with the PUSH4 constants in the deployed bytecode.
  it('encodes the calls the relayer is allowed to forward', () => {
    const built = [
      buildLimitOrder({
        market: MON_AUSD_MARKET,
        params: MON_AUSD_PARAMS,
        side: 'buy',
        priceWire: 25_952_000_000_000_000n,
        sizeBase: 1_000_000_000_000_000_000_000n,
      }),
      buildCancelOrders(MON_AUSD_MARKET, [1n]),
      buildDeposit(MARGIN, USER, AUSD, 1_000_000n),
      buildWithdraw(MARGIN, AUSD, 1_000_000n),
    ];
    for (const call of built) {
      expect(selectorOf(call.data)).toBe(FORWARDABLE_SELECTORS[call.purpose]);
      expect(isForwardableSelector(call.data)).toBe(true);
    }
  });

  it('rejects a selector that is not on the list', () => {
    // MarginAccount.creditUser — a privileged call the relayer must never forward.
    expect(isForwardableSelector('0x75eab98e00000000')).toBe(false);
    // OrderBook.batchUpdate — market-making, out of scope by decision.
    expect(isForwardableSelector('0x5339c59f00000000')).toBe(false);
  });

  it('refuses calldata too short to carry a selector', () => {
    expect(() => selectorOf('0x1234')).toThrow(/too short/);
  });
});

describe('price alignment', () => {
  it('rounds a buy down and a sell up to the tick', () => {
    // MON/AUSD: pricePrecision 1e8, tick 100. 0.02595234 -> 2595234 raw.
    const wire = 25_952_340_000_000_000n;
    expect(toContractPrice(wire, MON_AUSD_PARAMS, 'buy').price).toBe(2_595_200n);
    expect(toContractPrice(wire, MON_AUSD_PARAMS, 'sell').price).toBe(2_595_300n);
  });

  it('reports whether the price moved', () => {
    expect(toContractPrice(25_952_000_000_000_000n, MON_AUSD_PARAMS, 'buy').adjusted).toBe(false);
    expect(toContractPrice(25_952_340_000_000_000n, MON_AUSD_PARAMS, 'buy').adjusted).toBe(true);
  });

  it('round-trips the aligned price back to the wire scale', () => {
    const a = toContractPrice(25_952_340_000_000_000n, MON_AUSD_PARAMS, 'buy');
    expect(a.priceWire).toBe(25_952_000_000_000_000n);
  });

  it('refuses a price below one tick rather than sending zero', () => {
    expect(() => toContractPrice(1n, MON_AUSD_PARAMS, 'buy')).toThrow(/below one tick/);
  });

  it('refuses a non-positive price', () => {
    expect(() => toContractPrice(0n, MON_AUSD_PARAMS, 'buy')).toThrow(/must be positive/);
  });

  it('property: the encoded price is always a whole number of ticks', () => {
    fc.assert(
      fc.property(
        // Upper bound is the largest wire price this market can represent: uint32
        // max in 1e8 pricePrecision is 42.94967295 AUSD per MON.
        fc.bigInt({ min: 10n ** 13n, max: 4n * 10n ** 19n }),
        fc.constantFrom<'buy' | 'sell'>('buy', 'sell'),
        (wire, side) => {
          const a = toContractPrice(wire, MON_AUSD_PARAMS, side);
          expect(a.price % MON_AUSD_PARAMS.tickSize).toBe(0n);
          expect(a.price).toBeGreaterThan(0n);
          if (side === 'buy') expect(a.priceWire).toBeLessThanOrEqual(wire);
          else expect(a.priceWire).toBeGreaterThanOrEqual(wire);
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe('size checks happen before the chain sees them', () => {
  it('converts base units into sizePrecision units', () => {
    // sizePrecision 1e10, base 18 decimals. 1000 MON -> 1000 * 1e10.
    expect(toContractSize(1_000_000_000_000_000_000_000n, MON_AUSD_PARAMS).size).toBe(
      10_000_000_000_000n,
    );
  });

  it('rejects a size under the market minimum with a readable message', () => {
    // minSize 2e12 in sizePrecision units = 200 MON.
    expect(() => toContractSize(1_000_000_000_000_000_000n, MON_AUSD_PARAMS)).toThrow(
      /below the market minimum/,
    );
  });

  it('rejects a size over the market maximum', () => {
    expect(() => toContractSize(10n ** 30n, MON_AUSD_PARAMS)).toThrow(/above the market maximum/);
  });
});

describe('minSizeBase — the honest minimum, in units a screen can show (item 4b)', () => {
  it('is 200 MON for MON/AUSD, not 0.000002 MON', () => {
    // minSize 2e12 is sizePrecision units (1e10), not base units. Reading it as
    // base units directly said the market minimum was two-millionths of a MON,
    // which is not what `SizeError` actually enforces.
    expect(minSizeBase(MON_AUSD_PARAMS)).toBe(200_000_000_000_000_000_000n); // 200 MON, 18 decimals
  });

  it('round-trips through toContractSize at exactly the minimum', () => {
    const min = minSizeBase(MON_AUSD_PARAMS);
    expect(() => toContractSize(min, MON_AUSD_PARAMS)).not.toThrow();
    expect(toContractSize(min, MON_AUSD_PARAMS).size).toBe(MON_AUSD_PARAMS.minSize);
  });

  it('one unit under the minimum still fails toContractSize', () => {
    const min = minSizeBase(MON_AUSD_PARAMS);
    // A whole base-unit step here is far more than one wei of MON, so this is
    // still genuinely under the minimum in sizePrecision terms.
    expect(() => toContractSize(min - 10n ** 18n, MON_AUSD_PARAMS)).toThrow(
      /below the market minimum/,
    );
  });
});

describe('order calldata', () => {
  it('builds a post-only buy at the aligned price', () => {
    const order = buildLimitOrder({
      market: MON_AUSD_MARKET,
      params: MON_AUSD_PARAMS,
      side: 'buy',
      priceWire: 25_952_340_000_000_000n,
      sizeBase: 1_000_000_000_000_000_000_000n,
      postOnly: true,
    });
    expect(order.to).toBe(MON_AUSD_MARKET);
    expect(order.purpose).toBe('addBuyOrder');
    expect(order.price.price).toBe(2_595_200n);
    expect(order.size.size).toBe(10_000_000_000_000n);
    expect(order.data.endsWith('1')).toBe(true); // postOnly = true
  });

  it('builds a sell with the sell-side selector', () => {
    const order = buildLimitOrder({
      market: MON_AUSD_MARKET,
      params: MON_AUSD_PARAMS,
      side: 'sell',
      priceWire: 26_473_000_000_000_000n,
      sizeBase: 1_000_000_000_000_000_000_000n,
    });
    expect(selectorOf(order.data)).toBe(FORWARDABLE_SELECTORS.addSellOrder);
  });

  it('defaults market orders to margin mode and not fill-or-kill', () => {
    const call = buildMarketOrder({
      market: MON_AUSD_MARKET,
      params: MON_AUSD_PARAMS,
      side: 'buy',
      amount: 50_000_000n, // 50 AUSD
      minAmountOut: 0n,
    });
    expect(selectorOf(call.data)).toBe(FORWARDABLE_SELECTORS.placeAndExecuteMarketBuy);
    // isMargin true then isFOK false: ...0000001 0000000
    expect(call.data.slice(-64)).toBe('0'.repeat(64)); // isFOK = false
    expect(call.data.slice(-128, -64)).toBe(`${'0'.repeat(63)}1`); // isMargin = true
  });

  it('rejects an empty cancel batch', () => {
    expect(() => buildCancelOrders(MON_AUSD_MARKET, [])).toThrow(/at least one order id/);
  });

  it('rejects an order id that does not fit in uint40', () => {
    expect(() => buildCancelOrders(MON_AUSD_MARKET, [2n ** 41n])).toThrow(/uint40/);
  });

  it('rejects non-positive deposit and withdraw amounts', () => {
    expect(() => buildDeposit(MARGIN, USER, AUSD, 0n)).toThrow(/must be positive/);
    expect(() => buildWithdraw(MARGIN, AUSD, 0n)).toThrow(/must be positive/);
  });
});

describe('minSize gates resting orders only — measured on chain, not inferred', () => {
  /**
   * Live evidence, chain 143 block 103,110,791, 2026-09-08
   * (`scripts/probe-market-order-minsize.ts`, 36 `eth_call`s across the three books):
   *
   *   MON/USDC  minSize 2e12 sizePrecision 1e10  = 200 MON resting minimum
   *     placeAndExecuteMarketBuy(_quoteSize=10_000_000 /* 0.10 USDC *\/, 0, true, false)
   *       from 0x714f169…  -> SUCCESS, amountOut = 3837298541800000000 (3.837 MON)
   *     placeAndExecuteMarketBuy(_quoteSize=100_000, 0, true, false)
   *       from 0x714f169…  -> SUCCESS, amountOut = 38372985400000000 (0.0384 MON)
   *
   * `SizeError` (0x0a5c4f1f) came back from none of them. 3.837 MON is 52x under the
   * book's own resting minimum and it filled, so the minimum is not a venue-wide floor.
   */
  const MARKET_BUY_UNDER_MINIMUM_FILLED = 3_837_298_541_800_000_000n;

  it('builds a market sell below minSize, because the venue accepts one', () => {
    // One MON. MON/AUSD's resting minimum is 200 MON.
    const call = buildMarketOrder({
      market: MON_AUSD_MARKET,
      params: MON_AUSD_PARAMS,
      side: 'sell',
      amount: 1_000_000_000_000_000_000n,
      minAmountOut: 0n,
    });
    expect(selectorOf(call.data)).toBe(FORWARDABLE_SELECTORS.placeAndExecuteMarketSell);
  });

  it('still refuses a resting order below minSize, because that one really is refused', () => {
    expect(() =>
      buildLimitOrder({
        market: MON_AUSD_MARKET,
        params: MON_AUSD_PARAMS,
        side: 'sell',
        priceWire: 25_952_000_000_000_000n,
        sizeBase: 1_000_000_000_000_000_000n,
      }),
    ).toThrow(/below the market minimum/);
  });

  it('keeps toContractSize enforcing by default — only the taker paths opt out', () => {
    expect(() => toContractSize(1_000_000_000_000_000_000n, MON_AUSD_PARAMS)).toThrow(
      /below the market minimum/,
    );
    expect(toContractSize(1_000_000_000_000_000_000n, MON_AUSD_PARAMS, false).size).toBe(
      10_000_000_000n,
    );
  });

  it('refuses a size that rounds to nothing even with the minimum off', () => {
    // Below one unit of sizePrecision there is no order at all, minimum or not.
    expect(() => toContractSize(1n, MON_AUSD_PARAMS, false)).toThrow(/nothing to trade/);
  });

  it('the fill that proved it is well under the resting minimum', () => {
    expect(MARKET_BUY_UNDER_MINIMUM_FILLED).toBeLessThan(minSizeBase(MON_AUSD_PARAMS));
  });
});
