import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import {
  assertQuoteAmountWithinCap,
  MAINNET,
  MAX_ORDER_NOTIONAL_AUSD,
  type MarketParams,
} from '@tradepro/core';
import { validate, type TicketDraft } from './ticket.js';
import { baseSizeFor, quoteNotionalFor } from './format.js';

/**
 * The ticket's size-limit check, per quote asset (2026-09-23).
 *
 * `validate()` runs before the user signs and has to agree with the relayer, which checks
 * the same order again after. Both now call `assertQuoteAmountWithinCap` from core: the
 * order's value in its quote asset, measured in dollars — AUSD and USDC one-for-one, MON
 * at the live MON/USDC mid, which the ticket receives from the market route's own poll.
 *
 * Params are real `getMarketParams()` reads on chain 143 (re-read at block 107,310,277).
 * Prices are that block's touches: MON/USDC 0.025853 / 0.025869 (mid 0.025861), emo/MON
 * best bid 0.031 and no ask.
 *
 * The limit is $1,000 per order since 2026-10-13 (it was $6). Boundaries are taken from
 * `MAX_ORDER_NOTIONAL_AUSD`, pinned once below so a moved cap fails here by name.
 */

const NATIVE = '0x0000000000000000000000000000000000000000' as Address;
const MON_USDC_MARKET = '0x065C9d28E428A0db40191a54d33d5b7c71a9C394' as Address;
const MON_AUSD_MARKET = '0x131A2e70A5b31a517A74b8c567149bc294470Da9' as Address;
const EMO_MON_MARKET = '0xe7A4f90369b48d8F5B61f2FD519eC563c11e4B2d' as Address;

const MON_USDC_PARAMS: MarketParams = {
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
const MON_AUSD_PARAMS: MarketParams = {
  ...MON_USDC_PARAMS,
  quoteAsset: MAINNET.tokens.AUSD.address,
  maxSize: 20_000_000_000_000_000_000n,
};
const EMO_MON_PARAMS: MarketParams = {
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

const MON_USD_MID = 25_861_000_000_000_000n;
const MON_USDC_ASK = 25_869_000_000_000_000n;
const EMO_BID = 31_000_000_000_000_000n;
const WEI = 10n ** 18n;
const PLENTY = 10n ** 30n;
const SIZE_LIMIT = /above the size limit/;

/** A draft built the way `TicketCard` builds one: the typed side's amount, the other derived. */
function buyDraft(
  market: Address,
  params: MarketParams,
  type: 'limit' | 'market',
  priceWire: bigint,
  quoteAmount: bigint,
): TicketDraft {
  return {
    market,
    params,
    side: 'buy',
    type,
    priceWire,
    quoteAmount,
    sizeBase: baseSizeFor(quoteAmount, priceWire, params.quoteDecimals, params.baseDecimals),
  };
}

function sellDraft(
  market: Address,
  params: MarketParams,
  type: 'limit' | 'market',
  priceWire: bigint,
  sizeBase: bigint,
): TicketDraft {
  return {
    market,
    params,
    side: 'sell',
    type,
    priceWire,
    sizeBase,
    quoteAmount: quoteNotionalFor(sizeBase, priceWire, params.quoteDecimals, params.baseDecimals),
  };
}

describe('the size limit these tests measure against', () => {
  it('is $1,000, 1_000_000_000 base units of a six-decimal dollar', () => {
    expect(MAX_ORDER_NOTIONAL_AUSD).toBe(1_000_000_000n);
  });
});

describe('USDC-quoted (MON/USDC): one-for-one, no price needed, unchanged', () => {
  it('passes a $1,000.00 market buy and refuses $1,000.000001', () => {
    const at = validate(
      buyDraft(MON_USDC_MARKET, MON_USDC_PARAMS, 'market', MON_USDC_ASK, MAX_ORDER_NOTIONAL_AUSD),
      PLENTY,
    );
    expect(at.ok).toBe(true);
    const over = validate(
      buyDraft(
        MON_USDC_MARKET,
        MON_USDC_PARAMS,
        'market',
        MON_USDC_ASK,
        MAX_ORDER_NOTIONAL_AUSD + 1n,
      ),
      PLENTY,
    );
    expect(over.ok).toBe(false);
    expect(over.message).toMatch(SIZE_LIMIT);
  });

  it('is not changed by a quote price, which only a MON-quoted market uses', () => {
    const over = validate(
      // 2,500 USDC. A tiny "price" would shrink it under the limit if it were applied.
      buyDraft(MON_USDC_MARKET, MON_USDC_PARAMS, 'market', MON_USDC_ASK, 2_500_000_000n),
      PLENTY,
      undefined,
      1n,
    );
    expect(over.message).toMatch(SIZE_LIMIT);
  });
});

describe('AUSD-quoted (MON/AUSD): one-for-one, no price needed, unchanged', () => {
  it('passes $1,000.00 and refuses $1,000.000001', () => {
    const price = 26_473_000_000_000_000n;
    expect(
      validate(
        buyDraft(MON_AUSD_MARKET, MON_AUSD_PARAMS, 'market', price, MAX_ORDER_NOTIONAL_AUSD),
        PLENTY,
      ).ok,
    ).toBe(true);
    expect(
      validate(
        buyDraft(MON_AUSD_MARKET, MON_AUSD_PARAMS, 'market', price, MAX_ORDER_NOTIONAL_AUSD + 1n),
        PLENTY,
      ).message,
    ).toMatch(SIZE_LIMIT);
  });
});

describe('MON-quoted (emo/MON): valued at the MON/USDC mid before the size limit', () => {
  it('passes the resting minimum, 200 emo at the 0.031 bid (6.2 MON, $0.16)', () => {
    const draft = buyDraft(
      EMO_MON_MARKET,
      EMO_MON_PARAMS,
      'limit',
      EMO_BID,
      6_200_000_000_000_000_000n,
    );
    expect(draft.sizeBase).toBe(200n * WEI);
    const v = validate(draft, PLENTY, undefined, MON_USD_MID);
    expect(v.ok).toBe(true);
    expect(v.call).toBeDefined();
  });

  it('passes 10,000 emo at 0.025, 250 MON ($6.47), which the $6 limit refused', () => {
    const draft = buyDraft(
      EMO_MON_MARKET,
      EMO_MON_PARAMS,
      'limit',
      25_000_000_000_000_000n,
      250n * WEI,
    );
    expect(draft.sizeBase).toBe(10_000n * WEI);
    const v = validate(draft, PLENTY, undefined, MON_USD_MID);
    expect(v.ok).toBe(true);
    expect(v.call).toBeDefined();
  });

  it('refuses 1,600,000 emo at 0.025, 40,000 MON ($1,034.44), for its size', () => {
    const draft = buyDraft(
      EMO_MON_MARKET,
      EMO_MON_PARAMS,
      'limit',
      25_000_000_000_000_000n,
      40_000n * WEI,
    );
    expect(draft.sizeBase).toBe(1_600_000n * WEI);
    const v = validate(draft, PLENTY, undefined, MON_USD_MID);
    expect(v.ok).toBe(false);
    expect(v.message).toMatch(SIZE_LIMIT);
  });

  it('holds the order back, and says why, when the MON price has not loaded', () => {
    const draft = buyDraft(
      EMO_MON_MARKET,
      EMO_MON_PARAMS,
      'limit',
      EMO_BID,
      6_200_000_000_000_000_000n,
    );
    for (const price of [undefined, 0n]) {
      const v = validate(draft, PLENTY, undefined, price);
      expect(v.ok).toBe(false);
      expect(v.message).toMatch(/MON price used to check this order’s size has not loaded/);
      expect(v.message).not.toMatch(/0x/);
      expect(v.call).toBeUndefined();
    }
  });

  it('passes 200 emo and 10,000 emo (310 MON, $8.02) market sells into the 0.031 bid, and refuses 1,300,000 emo (40,300 MON, $1,042.20)', () => {
    const small = validate(
      sellDraft(EMO_MON_MARKET, EMO_MON_PARAMS, 'market', EMO_BID, 200n * WEI),
      PLENTY,
      PLENTY,
      MON_USD_MID,
    );
    expect(small.ok).toBe(true);
    // The size the $6 limit refused.
    const medium = validate(
      sellDraft(EMO_MON_MARKET, EMO_MON_PARAMS, 'market', EMO_BID, 10_000n * WEI),
      PLENTY,
      PLENTY,
      MON_USD_MID,
    );
    expect(medium.ok).toBe(true);
    const big = validate(
      sellDraft(EMO_MON_MARKET, EMO_MON_PARAMS, 'market', EMO_BID, 1_300_000n * WEI),
      PLENTY,
      PLENTY,
      MON_USD_MID,
    );
    expect(big.ok).toBe(false);
    expect(big.message).toMatch(SIZE_LIMIT);
  });

  it('refuses a market buy on the real book, which has no ask, before any size question', () => {
    const v = validate(
      buyDraft(EMO_MON_MARKET, EMO_MON_PARAMS, 'market', 0n, WEI),
      PLENTY,
      undefined,
      MON_USD_MID,
    );
    expect(v.message).toMatch(/no orders to buy from/);
  });

  it('agrees with the relayer’s check to the wei, at the cap and one wei over it', () => {
    // 38,668.264954951471327481 MON is $1,000.000000 at the 0.025861 mid; one wei more
    // rounds up to $1,000.000001. The relayer runs `assertQuoteAmountWithinCap` on the
    // same figure.
    const atCap = 38_668_264_954_951_471_327_481n;
    const price = 25_000_000_000_000_000n;
    const at = validate(
      buyDraft(EMO_MON_MARKET, EMO_MON_PARAMS, 'limit', price, atCap),
      PLENTY,
      undefined,
      MON_USD_MID,
    );
    const over = validate(
      buyDraft(EMO_MON_MARKET, EMO_MON_PARAMS, 'limit', price, atCap + 1n),
      PLENTY,
      undefined,
      MON_USD_MID,
    );
    expect(at.ok).toBe(true);
    expect(over.message).toMatch(SIZE_LIMIT);
    expect(() => assertQuoteAmountWithinCap(atCap, EMO_MON_PARAMS, MON_USD_MID)).not.toThrow();
    expect(() => assertQuoteAmountWithinCap(atCap + 1n, EMO_MON_PARAMS, MON_USD_MID)).toThrow();
  });

  it('spends margin MON on the buy side, so a MON balance below the order refuses it', () => {
    // The owner's margin MON at block 107,310,277: 3.7323 MON. 200 emo at 0.031 is 6.2.
    const v = validate(
      buyDraft(EMO_MON_MARKET, EMO_MON_PARAMS, 'limit', EMO_BID, 6_200_000_000_000_000_000n),
      3_732_318_142_700_000_000n,
      undefined,
      MON_USD_MID,
    );
    expect(v.message).toMatch(/not enough in your trading balance/i);
  });
});
