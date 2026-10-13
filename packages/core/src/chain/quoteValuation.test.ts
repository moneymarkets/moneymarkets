import { describe, expect, it } from 'vitest';
import { getAddress, type Address } from 'viem';
import {
  CAP_UNIT_DECIMALS,
  MON_USDC_PRICING_BOOK,
  pricesValuation,
  QUOTE_VALUATIONS,
  quoteAmountInCapUnits,
  quoteValuationFor,
  readQuoteUsdPrice,
  usdMidOf,
  type QuotePriceReader,
  type QuoteValuation,
} from './quoteValuation.js';
import { MAINNET } from './addresses.js';
import { NO_BID_SENTINEL } from '../kuru/book.js';
import { TRADING_MARKET_CANDIDATES } from '../kuru/liveMarkets.js';
import type { MarketParams } from '../kuru/params.js';
import {
  EMO_MON_PARAMS,
  MON_USDC_PARAMS,
  MON_USDC_PM_BEST_ASK_WIRE,
  MON_USDC_PM_BEST_BID_WIRE,
  MON_USDC_PM_MID_WIRE,
  WETH_USDC_PARAMS,
  XAUT0_USDC_PARAMS,
} from '../kuru/__fixtures__/newMarkets.js';
import { MON_AUSD_PARAMS } from '../kuru/__fixtures__/books.js';

/**
 * The owner's valuation rule for the order cap (2026-09-23): AUSD and USDC one-for-one
 * with the cap's six-decimal dollar unit, native MON at the live MON/USDC mid, anything
 * else refused. Prices are the real MON/USDC touch read at block 107,310,277.
 */

const valuationOf = (
  params: Pick<MarketParams, 'quoteAsset' | 'quoteDecimals'>,
): QuoteValuation => {
  const v = quoteValuationFor(params);
  if (!v) throw new Error('expected a valuation');
  return v;
};
const MON = 10n ** 18n;

describe('which quote assets the cap can value, and how', () => {
  it('takes AUSD and USDC one-for-one, and nothing else as a dollar', () => {
    expect(quoteValuationFor(MON_AUSD_PARAMS)?.kind).toBe('dollar');
    expect(quoteValuationFor(MON_USDC_PARAMS)?.kind).toBe('dollar');
    expect(QUOTE_VALUATIONS.filter((v) => v.kind === 'dollar').map((v) => v.symbol)).toEqual([
      'AUSD',
      'USDC',
    ]);
    for (const v of QUOTE_VALUATIONS.filter((q) => q.kind === 'dollar')) {
      expect(v.decimals).toBe(CAP_UNIT_DECIMALS);
    }
  });

  it('prices native MON through the MON/USDC book, and only native MON', () => {
    const v = quoteValuationFor(EMO_MON_PARAMS);
    expect(v).toEqual({
      kind: 'priced',
      asset: MAINNET.tokens.MON.address,
      symbol: 'MON',
      decimals: 18,
      book: MON_USDC_PRICING_BOOK,
    });
    expect(QUOTE_VALUATIONS.filter((q) => q.kind === 'priced')).toHaveLength(1);
  });

  it('pins the pricing book to the verified MON/USDC trading candidate', () => {
    expect(MON_USDC_PRICING_BOOK).toBe(getAddress('0x065c9d28e428a0db40191a54d33d5b7c71a9c394'));
    const candidate = TRADING_MARKET_CANDIDATES.find((c) => c.address === MON_USDC_PRICING_BOOK);
    expect(candidate?.symbol).toBe('MON/USDC');
    expect(pricesValuation(candidate!.params, valuationOf(EMO_MON_PARAMS))).toBe(true);
  });

  it('has no valuation for a quote it has no rule for, or the right address at the wrong decimals', () => {
    // USDT0: a six-decimal dollar, but not one the owner's rule names.
    expect(quoteValuationFor({ quoteAsset: MAINNET.tokens.USDT0.address, quoteDecimals: 6 })).toBe(
      undefined,
    );
    // WETH: a real 18-decimal token with a verified book, and no rule.
    expect(quoteValuationFor({ quoteAsset: WETH_USDC_PARAMS.baseAsset, quoteDecimals: 18 })).toBe(
      undefined,
    );
    expect(quoteValuationFor({ ...EMO_MON_PARAMS, quoteDecimals: 6 })).toBeUndefined();
    expect(quoteValuationFor({ ...MON_USDC_PARAMS, quoteDecimals: 18 })).toBeUndefined();
  });

  it('matches the quote address case-insensitively', () => {
    const lower = MAINNET.tokens.USDC.address.toLowerCase() as Address;
    expect(quoteValuationFor({ quoteAsset: lower, quoteDecimals: 6 })?.symbol).toBe('USDC');
  });
});

describe('a book prices MON only if it really is MON against a dollar', () => {
  const mon = valuationOf(EMO_MON_PARAMS);

  it('accepts MON/USDC’s real params', () => {
    expect(pricesValuation(MON_USDC_PARAMS, mon)).toBe(true);
  });

  it('refuses the same book with its base, base decimals or quote edited', () => {
    expect(
      pricesValuation({ ...MON_USDC_PARAMS, baseAsset: WETH_USDC_PARAMS.baseAsset }, mon),
    ).toBe(false);
    expect(pricesValuation({ ...MON_USDC_PARAMS, baseDecimals: 6 }, mon)).toBe(false);
    // XAUt0/USDC is a real dollar-quoted book, but it prices XAUt0, not MON.
    expect(pricesValuation(XAUT0_USDC_PARAMS, mon)).toBe(false);
    // MON against a quote with no dollar rule (emo/MON's own params, base and quote swapped).
    expect(
      pricesValuation(
        { ...MON_USDC_PARAMS, quoteAsset: EMO_MON_PARAMS.baseAsset, quoteDecimals: 18 },
        mon,
      ),
    ).toBe(false);
  });

  it('never treats a dollar valuation as something a book prices', () => {
    expect(pricesValuation(MON_USDC_PARAMS, valuationOf(MON_USDC_PARAMS))).toBe(false);
  });
});

describe('the MON/USDC mid, from a raw bestBidAsk() reading', () => {
  it('is the midpoint of the real touch: 0.025853 / 0.025869 -> 0.025861', () => {
    expect(
      usdMidOf(
        MON_USDC_PRICING_BOOK,
        MON_USDC_PARAMS,
        MON_USDC_PM_BEST_BID_WIRE,
        MON_USDC_PM_BEST_ASK_WIRE,
      ),
    ).toBe(MON_USDC_PM_MID_WIRE);
  });

  it('has no price when either side is missing, including the raw 2^256-1 no-bid sentinel', () => {
    expect(
      usdMidOf(MON_USDC_PRICING_BOOK, MON_USDC_PARAMS, NO_BID_SENTINEL, MON_USDC_PM_BEST_ASK_WIRE),
    ).toBe(undefined);
    expect(usdMidOf(MON_USDC_PRICING_BOOK, MON_USDC_PARAMS, MON_USDC_PM_BEST_BID_WIRE, 0n)).toBe(
      undefined,
    );
    expect(usdMidOf(MON_USDC_PRICING_BOOK, MON_USDC_PARAMS, NO_BID_SENTINEL, 0n)).toBe(undefined);
  });

  it('has no price on a crossed or locked book (I1)', () => {
    // The real touch, swapped.
    expect(
      usdMidOf(
        MON_USDC_PRICING_BOOK,
        MON_USDC_PARAMS,
        MON_USDC_PM_BEST_ASK_WIRE,
        MON_USDC_PM_BEST_BID_WIRE,
      ),
    ).toBe(undefined);
    expect(
      usdMidOf(
        MON_USDC_PRICING_BOOK,
        MON_USDC_PARAMS,
        MON_USDC_PM_BEST_BID_WIRE,
        MON_USDC_PM_BEST_BID_WIRE,
      ),
    ).toBe(undefined);
  });
});

describe('readQuoteUsdPrice: a live price, or none', () => {
  const mon = valuationOf(EMO_MON_PARAMS);
  const reader = (
    overrides: Partial<QuotePriceReader> = {},
  ): QuotePriceReader & { asked: string[] } => {
    const asked: string[] = [];
    return {
      asked,
      params: async (book: Address) => {
        asked.push(`params:${book}`);
        return MON_USDC_PARAMS;
      },
      bestBidAsk: async (book: Address) => {
        asked.push(`bestBidAsk:${book}`);
        return [MON_USDC_PM_BEST_BID_WIRE, MON_USDC_PM_BEST_ASK_WIRE] as const;
      },
      ...overrides,
    };
  };

  it('reads the pinned MON/USDC book and returns its mid', async () => {
    const r = reader();
    expect(await readQuoteUsdPrice(r, mon)).toBe(MON_USDC_PM_MID_WIRE);
    expect(r.asked.sort()).toEqual(
      [`bestBidAsk:${MON_USDC_PRICING_BOOK}`, `params:${MON_USDC_PRICING_BOOK}`].sort(),
    );
  });

  it('reads nothing for a dollar valuation, which needs no price', async () => {
    const r = reader();
    expect(await readQuoteUsdPrice(r, valuationOf(MON_USDC_PARAMS))).toBeUndefined();
    expect(r.asked).toEqual([]);
  });

  it('has no price when the book’s own params no longer price MON in dollars', async () => {
    const r = reader({
      params: async () => ({ ...MON_USDC_PARAMS, quoteAsset: EMO_MON_PARAMS.baseAsset }),
    });
    expect(await readQuoteUsdPrice(r, mon)).toBeUndefined();
  });

  it('has no price, and does not throw, when a read fails', async () => {
    const failing = reader({
      bestBidAsk: async () => {
        throw new Error('rpc down');
      },
    });
    expect(await readQuoteUsdPrice(failing, mon)).toBeUndefined();
    const failingParams = reader({
      params: async () => {
        throw new Error('rpc down');
      },
    });
    expect(await readQuoteUsdPrice(failingParams, mon)).toBeUndefined();
  });

  it('has no price when the book has no ask', async () => {
    const r = reader({ bestBidAsk: async () => [MON_USDC_PM_BEST_BID_WIRE, 0n] as const });
    expect(await readQuoteUsdPrice(r, mon)).toBeUndefined();
  });
});

describe('quoteAmountInCapUnits', () => {
  const mon = valuationOf(EMO_MON_PARAMS);

  it('is the amount itself for AUSD and USDC, with or without a price', () => {
    expect(quoteAmountInCapUnits(5_338_200n, valuationOf(MON_USDC_PARAMS))).toBe(5_338_200n);
    expect(quoteAmountInCapUnits(5_294_600n, valuationOf(MON_AUSD_PARAMS), 1n)).toBe(5_294_600n);
  });

  it('values 1 MON at the 0.025861 mid as exactly 25,861 cap units ($0.025861)', () => {
    expect(quoteAmountInCapUnits(MON, mon, MON_USDC_PM_MID_WIRE)).toBe(25_861n);
  });

  it('rounds a fractional cap unit UP, never down', () => {
    // 6.2 MON * 0.025861 = 0.1603382 dollars: 160338.2 cap units, so 160339.
    expect(quoteAmountInCapUnits(6_200_000_000_000_000_000n, mon, MON_USDC_PM_MID_WIRE)).toBe(
      160_339n,
    );
    // One wei of MON is worth far less than one cap unit, and still counts as one.
    expect(quoteAmountInCapUnits(1n, mon, MON_USDC_PM_MID_WIRE)).toBe(1n);
    expect(quoteAmountInCapUnits(0n, mon, MON_USDC_PM_MID_WIRE)).toBe(0n);
  });

  it('has no value for a priced asset without a usable price', () => {
    expect(quoteAmountInCapUnits(MON, mon)).toBeUndefined();
    expect(quoteAmountInCapUnits(MON, mon, 0n)).toBeUndefined();
    expect(quoteAmountInCapUnits(MON, mon, -1n)).toBeUndefined();
  });
});
