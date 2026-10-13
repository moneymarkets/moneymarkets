import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import {
  buildCancelOrders,
  buildDeposit,
  buildLimitOrder,
  buildMarketOrder,
  CapExceededError,
  MAINNET,
  MAX_ORDER_NOTIONAL_AUSD,
  MON_USDC_PRICING_BOOK,
  parseUnits,
  type MarketParams,
} from '@tradepro/core';
import {
  assertNotionalWithinCap,
  carriesNotional,
  notionalOf,
  readNotionalContext,
  type NotionalReader,
} from './notional.js';

const MON_AUSD = '0x131a2e70a5b31a517a74b8c567149bc294470da9' as Address;
const MARGIN = '0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5' as Address;
const AUSD = '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a' as Address;
const USER = '0x1111111111111111111111111111111111111111' as Address;

/** Read from MON/AUSD on chain 143, 2026-09-02. */
const params: MarketParams = {
  pricePrecision: 100_000_000n,
  sizePrecision: 10_000_000_000n,
  baseAsset: '0x0000000000000000000000000000000000000000' as Address,
  baseDecimals: 18,
  quoteAsset: AUSD,
  quoteDecimals: 6,
  tickSize: 100n,
  minSize: 2_000_000_000_000n,
  maxSize: 20_000_000_000_000_000_000n,
  takerFeeBps: 0n,
  makerFeeBps: 0n,
};

/** MON was 0.026473 AUSD at the read. 200 MON is about $5.29; the $1,000 cap is 37,774 MON. */
const PRICE_WIRE = 26_473_000_000_000_000n;
const mon = (n: string) => parseUnits(n, 18);

function limitOrder(side: 'buy' | 'sell', size: bigint) {
  return buildLimitOrder({ market: MON_AUSD, params, side, priceWire: PRICE_WIRE, sizeBase: size });
}

describe('notional is read out of the calldata, not taken on trust', () => {
  it('values a limit buy at price times size in AUSD base units', () => {
    // minSize is 200 MON: 200 * 0.026473 = 5.2946 AUSD
    const order = limitOrder('buy', mon('200'));
    expect(notionalOf(order.data, params)).toBe(5_294_600n);
  });

  it('values a limit sell the same way', () => {
    const order = limitOrder('sell', mon('200'));
    expect(notionalOf(order.data, params)).toBe(5_294_600n);
  });

  it('values a market buy by its quote spend', () => {
    const call = buildMarketOrder({
      market: MON_AUSD,
      params,
      side: 'buy',
      amount: 3_000_000n, // 3 AUSD
      minAmountOut: 0n,
    });
    expect(notionalOf(call.data, params)).toBe(3_000_000n);
  });

  /**
   * A market sell used to be valued at `minAmountOut`, which broke both ways and is
   * the bug the owner hit on 2026-09-09: "AUSD/USDC market SELL rejected: order
   * notional must be positive".
   */
  describe('a market sell is valued at a live price, never at minAmountOut', () => {
    // 0.026473 * 1e18 — the same MON/AUSD price the limit-order cases above use.
    const bestBid = 26_473_000_000_000_000n;

    const sell = (amount: bigint, minAmountOut = 0n) =>
      buildMarketOrder({ market: MON_AUSD, params, side: 'sell', amount, minAmountOut });

    it('values 200 MON at the best bid, not at the zero floor the app sends', () => {
      // Every market order this app builds sets minAmountOut to 0 on purpose. Reading
      // that as the notional made it 0, and `assertOrderWithinCap` refused every
      // market sell ever submitted with "order notional must be positive".
      const call = sell(mon('200'));
      expect(notionalOf(call.data, params, { marketPrice: bestBid })).toBe(5_294_600n);
      expect(() =>
        assertNotionalWithinCap(call.data, params, { marketPrice: bestBid }),
      ).not.toThrow();
    });

    it('ignores minAmountOut even when it is set, because it under-reads exposure', () => {
      // The evasion the old code allowed: a large sell with a token floor read as a
      // tiny notional and sailed under the cap. 40,000 MON is $1,058.92, over the
      // $1,000 cap, and it is refused however small the floor claims to be.
      const call = sell(mon('40000'), 1n);
      expect(notionalOf(call.data, params, { marketPrice: bestBid })).toBe(1_058_920_000n);
      expect(() => assertNotionalWithinCap(call.data, params, { marketPrice: bestBid })).toThrow(
        CapExceededError,
      );
    });

    it('refuses rather than skipping the cap when there is no price to value it at', () => {
      // Fail closed: an order that cannot be valued cannot be bounded. Returning
      // `undefined` here would have skipped the cap entirely.
      const call = sell(mon('200'));
      expect(() => notionalOf(call.data, params)).toThrow(CapExceededError);
      expect(() => notionalOf(call.data, params, { marketPrice: 0n })).toThrow(CapExceededError);
      expect(() => assertNotionalWithinCap(call.data, params)).toThrow(
        /cannot be valued without a live best bid/,
      );
    });
  });

  it('has no notional for a cancel or a deposit', () => {
    expect(notionalOf(buildCancelOrders(MON_AUSD, [1n]).data, params)).toBeUndefined();
    expect(notionalOf(buildDeposit(MARGIN, USER, AUSD, 5_000_000n).data, params)).toBeUndefined();
  });
});

describe('the $1,000 cap is enforced against the decoded notional', () => {
  it('accepts the smallest legal MON/AUSD limit order', () => {
    // 200 MON at 0.026473 = $5.2946. Under $5 this was impossible; that collision
    // is what first raised the cap, to $6 (DECISIONS.md C5). It is $1,000 since
    // 2026-10-13.
    const order = limitOrder('buy', mon('200'));
    expect(notionalOf(order.data, params)).toBe(5_294_600n);
    expect(() => assertNotionalWithinCap(order.data, params)).not.toThrow();
  });

  it('accepts a 300 MON order, which is $7.94 and which the $6 cap refused', () => {
    const order = limitOrder('buy', mon('300'));
    expect(notionalOf(order.data, params)).toBe(7_941_900n);
    expect(() => assertNotionalWithinCap(order.data, params)).not.toThrow();
  });

  it('refuses a 40,000 MON order, which is $1,058.92', () => {
    const order = limitOrder('buy', mon('40000'));
    expect(notionalOf(order.data, params)).toBe(1_058_920_000n);
    expect(() => assertNotionalWithinCap(order.data, params)).toThrow(CapExceededError);
    expect(() => assertNotionalWithinCap(order.data, params)).toThrow(/1000\.00 AUSD/);
  });

  it('accepts a market buy at exactly the cap', () => {
    const call = buildMarketOrder({
      market: MON_AUSD,
      params,
      side: 'buy',
      amount: MAX_ORDER_NOTIONAL_AUSD,
      minAmountOut: 0n,
    });
    expect(() => assertNotionalWithinCap(call.data, params)).not.toThrow();
  });

  it('refuses one base unit above the cap', () => {
    const call = buildMarketOrder({
      market: MON_AUSD,
      params,
      side: 'buy',
      amount: MAX_ORDER_NOTIONAL_AUSD + 1n,
      minAmountOut: 0n,
    });
    expect(() => assertNotionalWithinCap(call.data, params)).toThrow(CapExceededError);
  });

  it('lets cancels through, since they close exposure rather than open it', () => {
    expect(() =>
      assertNotionalWithinCap(buildCancelOrders(MON_AUSD, [1n]).data, params),
    ).not.toThrow();
  });
});

/* ─────────────────── the cap in dollars, per quote asset (2026-09-23) ─────────────────── */

/**
 * MON/USDC and emo/MON, each read with `getMarketParams()` on chain 143 at block
 * 107,310,277 (identical to `reports/MARKETS-VERIFIED.md` section 1). The MON price is
 * the MON/USDC touch at that block: 0.025853 / 0.025869, mid 0.025861.
 */
const MON_USDC = MON_USDC_PRICING_BOOK;
const EMO_MON = '0xe7A4f90369b48d8F5B61f2FD519eC563c11e4B2d' as Address;
const NATIVE = '0x0000000000000000000000000000000000000000' as Address;
const monUsdcParams: MarketParams = {
  pricePrecision: 100_000_000n,
  sizePrecision: 10_000_000_000n,
  baseAsset: NATIVE,
  baseDecimals: 18,
  quoteAsset: MAINNET.tokens.USDC.address,
  quoteDecimals: 6,
  tickSize: 100n,
  minSize: 2_000_000_000_000n,
  maxSize: 2_000_000_000_000_000_000n,
  takerFeeBps: 0n,
  makerFeeBps: 0n,
};
const emoMonParams: MarketParams = {
  pricePrecision: 100_000n,
  sizePrecision: 100_000_000_000n,
  baseAsset: '0x81A224F8A62f52BdE942dBF23A56df77A10b7777' as Address,
  baseDecimals: 18,
  quoteAsset: NATIVE,
  quoteDecimals: 18,
  tickSize: 10n,
  minSize: 20_000_000_000_000n,
  maxSize: 20_000_000_000_000_000_000n,
  takerFeeBps: 2n,
  makerFeeBps: 2n,
};
const MON_USDC_BID = 25_853_000_000_000_000n;
const MON_USDC_ASK = 25_869_000_000_000_000n;
const MON_USD_MID = 25_861_000_000_000_000n;
/** emo/MON's best bid at the same block, 0.031 MON. It has no ask. */
const EMO_BID = 31_000_000_000_000_000n;
const emo = (n: bigint) => n * 10n ** 18n;
const monWei = (n: string) => parseUnits(n, 18);

describe('a USDC-quoted market (MON/USDC): valued one-for-one, exactly as before', () => {
  it('passes the 200 MON resting minimum at 0.026691, 5.3382 USDC, and needs no MON price', () => {
    const order = buildLimitOrder({
      market: MON_USDC,
      params: monUsdcParams,
      side: 'buy',
      priceWire: 26_691_000_000_000_000n,
      sizeBase: monWei('200'),
    });
    expect(notionalOf(order.data, monUsdcParams)).toBe(5_338_200n);
    expect(() => assertNotionalWithinCap(order.data, monUsdcParams)).not.toThrow();
  });

  it('passes a 1,000 USDC market buy and refuses 1,000.000001', () => {
    expect(MAX_ORDER_NOTIONAL_AUSD).toBe(1_000_000_000n);
    const at = buildMarketOrder({
      market: MON_USDC,
      params: monUsdcParams,
      side: 'buy',
      amount: MAX_ORDER_NOTIONAL_AUSD,
      minAmountOut: 0n,
    });
    const over = buildMarketOrder({
      market: MON_USDC,
      params: monUsdcParams,
      side: 'buy',
      amount: MAX_ORDER_NOTIONAL_AUSD + 1n,
      minAmountOut: 0n,
    });
    expect(() => assertNotionalWithinCap(at.data, monUsdcParams)).not.toThrow();
    expect(() => assertNotionalWithinCap(over.data, monUsdcParams)).toThrow(CapExceededError);
  });

  it('ignores a MON price even if one is supplied', () => {
    const over = buildMarketOrder({
      market: MON_USDC,
      params: monUsdcParams,
      side: 'buy',
      amount: 2_500_000_000n, // 2,500 USDC
      minAmountOut: 0n,
    });
    // A tiny "price" would shrink the order if it were applied. It must not be.
    expect(() => assertNotionalWithinCap(over.data, monUsdcParams, { quoteUsdPrice: 1n })).toThrow(
      CapExceededError,
    );
  });
});

describe('a MON-quoted market (emo/MON): valued at the MON/USDC mid, on all four order selectors', () => {
  const ctx = { quoteUsdPrice: MON_USD_MID };
  const limit = (side: 'buy' | 'sell', priceWire: bigint, size: bigint) =>
    buildLimitOrder({ market: EMO_MON, params: emoMonParams, side, priceWire, sizeBase: size });
  const marketBuy = (amount: bigint) =>
    buildMarketOrder({
      market: EMO_MON,
      params: emoMonParams,
      side: 'buy',
      amount,
      minAmountOut: 0n,
    });
  const marketSell = (size: bigint) =>
    buildMarketOrder({
      market: EMO_MON,
      params: emoMonParams,
      side: 'sell',
      amount: size,
      minAmountOut: 0n,
    });

  it('addBuyOrder: passes 200 emo at 0.031 (6.2 MON, $0.160339) and 10,000 at 0.025 (250 MON, $6.47), refuses 1,600,000 at 0.025 (40,000 MON, $1,034.44)', () => {
    const small = limit('buy', EMO_BID, emo(200n));
    expect(notionalOf(small.data, emoMonParams)).toBe(monWei('6.2'));
    expect(() => assertNotionalWithinCap(small.data, emoMonParams, ctx)).not.toThrow();
    // The size the $6 cap refused. It fits under $1,000.
    const medium = limit('buy', 25_000_000_000_000_000n, emo(10_000n));
    expect(notionalOf(medium.data, emoMonParams)).toBe(monWei('250'));
    expect(() => assertNotionalWithinCap(medium.data, emoMonParams, ctx)).not.toThrow();
    const big = limit('buy', 25_000_000_000_000_000n, emo(1_600_000n));
    expect(notionalOf(big.data, emoMonParams)).toBe(monWei('40000'));
    expect(() => assertNotionalWithinCap(big.data, emoMonParams, ctx)).toThrow(
      /exceeds the hard cap/,
    );
  });

  it('addSellOrder: passes 200 emo at 0.0311 (6.22 MON) and 10,000 (311 MON, $8.04), refuses 1,300,000 (40,430 MON, $1,045.56)', () => {
    const small = limit('sell', 31_100_000_000_000_000n, emo(200n));
    expect(notionalOf(small.data, emoMonParams)).toBe(monWei('6.22'));
    expect(() => assertNotionalWithinCap(small.data, emoMonParams, ctx)).not.toThrow();
    // The size the $6 cap refused. It fits under $1,000.
    const medium = limit('sell', 31_100_000_000_000_000n, emo(10_000n));
    expect(() => assertNotionalWithinCap(medium.data, emoMonParams, ctx)).not.toThrow();
    const big = limit('sell', 31_100_000_000_000_000n, emo(1_300_000n));
    expect(notionalOf(big.data, emoMonParams)).toBe(monWei('40430'));
    expect(() => assertNotionalWithinCap(big.data, emoMonParams, ctx)).toThrow(CapExceededError);
  });

  it('placeAndExecuteMarketBuy: passes 38,668.26495 MON ($1,000.000000) and refuses 0.00001 MON more', () => {
    // quoteSize has 1e5 pricePrecision units per MON, so the finest step is 1e13 wei.
    // $1,000 at the 0.025861 mid is 38,668.264954951... MON.
    const atCap = marketBuy(monWei('38668.26495'));
    expect(notionalOf(atCap.data, emoMonParams)).toBe(monWei('38668.26495'));
    expect(() => assertNotionalWithinCap(atCap.data, emoMonParams, ctx)).not.toThrow();
    const over = marketBuy(monWei('38668.26496'));
    expect(() => assertNotionalWithinCap(over.data, emoMonParams, ctx)).toThrow(CapExceededError);
  });

  it('placeAndExecuteMarketSell: values 200 emo at its own best bid, then MON at the mid', () => {
    const small = marketSell(emo(200n));
    expect(notionalOf(small.data, emoMonParams, { marketPrice: EMO_BID })).toBe(monWei('6.2'));
    expect(() =>
      assertNotionalWithinCap(small.data, emoMonParams, { ...ctx, marketPrice: EMO_BID }),
    ).not.toThrow();
    // 10,000 emo is 310 MON, $8.02: refused under $6, inside $1,000.
    const medium = marketSell(emo(10_000n));
    expect(() =>
      assertNotionalWithinCap(medium.data, emoMonParams, { ...ctx, marketPrice: EMO_BID }),
    ).not.toThrow();
    const big = marketSell(emo(1_300_000n)); // 40,300 MON, $1,042.20
    expect(notionalOf(big.data, emoMonParams, { marketPrice: EMO_BID })).toBe(monWei('40300'));
    expect(() =>
      assertNotionalWithinCap(big.data, emoMonParams, { ...ctx, marketPrice: EMO_BID }),
    ).toThrow(CapExceededError);
  });

  it('refuses every order selector when there is no MON price, rather than comparing wei with dollars', () => {
    const calls: Hex[] = [
      limit('buy', EMO_BID, emo(200n)).data,
      limit('sell', 31_100_000_000_000_000n, emo(200n)).data,
      marketBuy(monWei('1')).data,
      marketSell(emo(200n)).data,
    ];
    for (const data of calls) {
      expect(() => assertNotionalWithinCap(data, emoMonParams, { marketPrice: EMO_BID })).toThrow(
        /no usable mid/,
      );
      expect(() =>
        assertNotionalWithinCap(data, emoMonParams, { marketPrice: EMO_BID, quoteUsdPrice: 0n }),
      ).toThrow(CapExceededError);
    }
  });

  it('still needs the book’s own best bid for a market sell, with or without the MON price', () => {
    expect(() => assertNotionalWithinCap(marketSell(emo(200n)).data, emoMonParams, ctx)).toThrow(
      /cannot be valued without a live best bid/,
    );
  });

  it('lets a cancel through with no price at all', () => {
    expect(() =>
      assertNotionalWithinCap(buildCancelOrders(EMO_MON, [26_029n]).data, emoMonParams),
    ).not.toThrow();
  });
});

describe('a market whose quote asset has no valuation', () => {
  it('is refused, never compared raw', () => {
    // emo/MON's real params with the quote edited to WETH (18 decimals, no rule). A
    // one-wei order would have passed a raw comparison.
    const wethQuoted = {
      ...emoMonParams,
      quoteAsset: '0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242' as Address,
    };
    const call = buildMarketOrder({
      market: EMO_MON,
      params: wethQuoted,
      side: 'buy',
      amount: 10n ** 13n,
      minAmountOut: 0n,
    });
    expect(() =>
      assertNotionalWithinCap(call.data, wethQuoted, { quoteUsdPrice: MON_USD_MID }),
    ).toThrow(/cannot be valued in dollars/);
  });
});

/* ───────────────────────── which live prices get read, and when ───────────────────────── */

function fakeReader(
  overrides: {
    touch?: Record<string, readonly [bigint, bigint] | 'throw'>;
    params?: Record<string, MarketParams | 'throw'>;
  } = {},
): NotionalReader & { reads: string[] } {
  const reads: string[] = [];
  const touch: Record<string, readonly [bigint, bigint] | 'throw'> = {
    [MON_USDC.toLowerCase()]: [MON_USDC_BID, MON_USDC_ASK],
    // emo/MON: a real bid and bestBidAsk()'s "no ask" zero.
    [EMO_MON.toLowerCase()]: [EMO_BID, 0n],
    ...overrides.touch,
  };
  const paramsBy: Record<string, MarketParams | 'throw'> = {
    [MON_USDC.toLowerCase()]: monUsdcParams,
    [EMO_MON.toLowerCase()]: emoMonParams,
    ...overrides.params,
  };
  return {
    reads,
    bestBidAsk: async (book) => {
      reads.push(`bestBidAsk:${book.toLowerCase()}`);
      const answer = touch[book.toLowerCase()];
      if (!answer || answer === 'throw') throw new Error('execution reverted');
      return answer;
    },
    params: async (book) => {
      reads.push(`params:${book.toLowerCase()}`);
      const answer = paramsBy[book.toLowerCase()];
      if (!answer || answer === 'throw') throw new Error('execution reverted');
      return answer;
    },
  };
}

describe('readNotionalContext', () => {
  const emoCalls = {
    addBuyOrder: buildLimitOrder({
      market: EMO_MON,
      params: emoMonParams,
      side: 'buy',
      priceWire: EMO_BID,
      sizeBase: emo(200n),
    }),
    addSellOrder: buildLimitOrder({
      market: EMO_MON,
      params: emoMonParams,
      side: 'sell',
      priceWire: 31_100_000_000_000_000n,
      sizeBase: emo(200n),
    }),
    placeAndExecuteMarketBuy: buildMarketOrder({
      market: EMO_MON,
      params: emoMonParams,
      side: 'buy',
      amount: monWei('1'),
      minAmountOut: 0n,
    }),
    placeAndExecuteMarketSell: buildMarketOrder({
      market: EMO_MON,
      params: emoMonParams,
      side: 'sell',
      amount: emo(200n),
      minAmountOut: 0n,
    }),
  };

  it.each(Object.entries(emoCalls))(
    'reads the MON/USDC mid for emo/MON %s, and the order then passes',
    async (_name, call) => {
      const reader = fakeReader();
      const context = await readNotionalContext(reader, EMO_MON, call.data, emoMonParams);
      expect(context.quoteUsdPrice).toBe(MON_USD_MID);
      expect(reader.reads).toContain(`bestBidAsk:${MON_USDC.toLowerCase()}`);
      expect(reader.reads).toContain(`params:${MON_USDC.toLowerCase()}`);
      expect(() => assertNotionalWithinCap(call.data, emoMonParams, context)).not.toThrow();
    },
  );

  it('also reads emo/MON’s own best bid for a market sell, and only for a market sell', async () => {
    const sell = await readNotionalContext(
      fakeReader(),
      EMO_MON,
      emoCalls.placeAndExecuteMarketSell.data,
      emoMonParams,
    );
    expect(sell.marketPrice).toBe(EMO_BID);
    const buyReader = fakeReader();
    const buy = await readNotionalContext(
      buyReader,
      EMO_MON,
      emoCalls.addBuyOrder.data,
      emoMonParams,
    );
    expect(buy.marketPrice).toBeUndefined();
    expect(buyReader.reads).not.toContain(`bestBidAsk:${EMO_MON.toLowerCase()}`);
  });

  it('reads nothing for a cancel or a deposit', async () => {
    const reader = fakeReader();
    expect(
      await readNotionalContext(
        reader,
        EMO_MON,
        buildCancelOrders(EMO_MON, [1n]).data,
        emoMonParams,
      ),
    ).toEqual({});
    const deposit = buildDeposit(MARGIN, USER, AUSD, 1_000_000n);
    expect(carriesNotional(deposit.data)).toBe(false);
    expect(await readNotionalContext(reader, MARGIN, deposit.data, emoMonParams)).toEqual({});
    expect(reader.reads).toEqual([]);
  });

  it('never reads a MON price for a USDC-quoted market', async () => {
    const reader = fakeReader();
    const buy = buildMarketOrder({
      market: MON_USDC,
      params: monUsdcParams,
      side: 'buy',
      amount: 3_000_000n,
      minAmountOut: 0n,
    });
    expect(await readNotionalContext(reader, MON_USDC, buy.data, monUsdcParams)).toEqual({});
    const sell = buildMarketOrder({
      market: MON_USDC,
      params: monUsdcParams,
      side: 'sell',
      amount: monWei('100'),
      minAmountOut: 0n,
    });
    const context = await readNotionalContext(reader, MON_USDC, sell.data, monUsdcParams);
    // Its own best bid, for the market sell. Never its params, never a quote price.
    expect(context).toEqual({ marketPrice: MON_USDC_BID });
    expect(reader.reads).toEqual([`bestBidAsk:${MON_USDC.toLowerCase()}`]);
  });

  it('leaves the MON price unset, so the order is refused, when MON/USDC cannot be read', async () => {
    for (const reader of [
      fakeReader({ touch: { [MON_USDC.toLowerCase()]: 'throw' } }),
      fakeReader({ params: { [MON_USDC.toLowerCase()]: 'throw' } }),
    ]) {
      const context = await readNotionalContext(
        reader,
        EMO_MON,
        emoCalls.addBuyOrder.data,
        emoMonParams,
      );
      expect(context.quoteUsdPrice).toBeUndefined();
      expect(() =>
        assertNotionalWithinCap(emoCalls.addBuyOrder.data, emoMonParams, context),
      ).toThrow(/no usable mid/);
    }
  });

  it('leaves the MON price unset when MON/USDC is one-sided or crossed', async () => {
    for (const touch of [
      [2n ** 256n - 1n, MON_USDC_ASK] as const, // the raw no-bid sentinel
      [MON_USDC_BID, 0n] as const, // no ask
      [MON_USDC_ASK, MON_USDC_BID] as const, // crossed
    ]) {
      const reader = fakeReader({ touch: { [MON_USDC.toLowerCase()]: touch } });
      const context = await readNotionalContext(
        reader,
        EMO_MON,
        emoCalls.placeAndExecuteMarketBuy.data,
        emoMonParams,
      );
      expect(context.quoteUsdPrice).toBeUndefined();
    }
  });

  it('refuses a price from a pricing book whose params no longer say MON against USDC', async () => {
    const reader = fakeReader({
      params: { [MON_USDC.toLowerCase()]: { ...monUsdcParams, baseAsset: emoMonParams.baseAsset } },
    });
    const context = await readNotionalContext(
      reader,
      EMO_MON,
      emoCalls.addBuyOrder.data,
      emoMonParams,
    );
    expect(context.quoteUsdPrice).toBeUndefined();
  });

  it('does not treat the raw no-bid sentinel as a best bid for a market sell', async () => {
    const reader = fakeReader({ touch: { [EMO_MON.toLowerCase()]: [2n ** 256n - 1n, 0n] } });
    const context = await readNotionalContext(
      reader,
      EMO_MON,
      emoCalls.placeAndExecuteMarketSell.data,
      emoMonParams,
    );
    expect(context.marketPrice).toBeUndefined();
    expect(context.quoteUsdPrice).toBe(MON_USD_MID);
  });
});
