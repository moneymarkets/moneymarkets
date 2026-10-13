import { getAddress, type Address } from 'viem';
import { MAINNET } from './addresses.js';
import { midPrice, normalizeBestBidAsk, normalizeBook } from '../kuru/book.js';
import type { MarketParams } from '../kuru/params.js';
import { rescaleWithRounding, WIRE_PRICE_SCALE } from '../math/fixed.js';

/**
 * What an order is worth in the order cap's own unit, whatever its market is quoted in.
 *
 * `MAX_ORDER_NOTIONAL_AUSD` (`caps.ts`) is $6, written as 6,000,000 base units of a
 * six-decimal dollar token. An order's value arrives in its market's own quote-asset
 * base units, so before the two can be compared the quote asset has to be valued in
 * dollars. The rule is the owner's (2026-09-23):
 *
 *   - **AUSD and USDC** are one-for-one with the cap's unit. No price, no conversion.
 *     This is the rule that was always in force; it just used to be implicit.
 *   - **Native MON** is valued at the live mid of the MON/USDC book, the app's most
 *     verified market. Nothing else prices it: no fallback figure, no cached number.
 *   - **Anything else** has no valuation, and an order quoted in it is refused.
 *
 * Keyed by quote asset rather than by market, so a second MON-quoted market needs no
 * code here, and a new non-dollar quote asset needs one line in `PRICED_QUOTES` plus a
 * verified book to price it.
 *
 * Both sides of the signing boundary use this module and nothing else to do it: the
 * ticket's `validate()` before the user signs, and the relayer's `notional.ts` after.
 */

/** The cap's unit: base units of a six-decimal dollar token. */
export const CAP_UNIT_DECIMALS = 6;

/**
 * MON/USDC, `0x065c9d28…c394`. The book whose live mid prices native MON in dollars.
 *
 * The address is pinned here rather than read from `TRADING_MARKET_CANDIDATES`, which
 * would make this module import `liveMarkets.ts` and close an import cycle through
 * `caps.ts`. `liveMarkets.ts` refuses to load unless it is the verified MON/USDC
 * trading candidate (base native MON, 18 decimals; quote USDC, 6), so the two cannot
 * drift apart silently. Source: `reports/MARKETS-VERIFIED.md` section 1, and re-read
 * at block 107,310,277 on 2026-09-23.
 */
export const MON_USDC_PRICING_BOOK: Address = getAddress(
  '0x065c9d28e428a0db40191a54d33d5b7c71a9c394',
);

export type QuoteValuation =
  | {
      /** One base unit is one cap unit. */
      readonly kind: 'dollar';
      readonly asset: Address;
      readonly symbol: string;
      readonly decimals: number;
    }
  | {
      /** One whole unit is worth the live mid of `book`, a book quoted in a dollar asset. */
      readonly kind: 'priced';
      readonly asset: Address;
      readonly symbol: string;
      readonly decimals: number;
      readonly book: Address;
    };

/** AUSD and USDC, from the address book. Both must be six-decimal, or this module does not load. */
const DOLLAR_QUOTES: readonly QuoteValuation[] = [MAINNET.tokens.AUSD, MAINNET.tokens.USDC].map(
  (token) => {
    if (token.decimals !== CAP_UNIT_DECIMALS) {
      throw new Error(
        `${token.symbol} is not a six-decimal token; it cannot be one-for-one with the cap`,
      );
    }
    return { kind: 'dollar', asset: token.address, symbol: token.symbol, decimals: token.decimals };
  },
);

/** Native MON, priced by the MON/USDC mid. */
const PRICED_QUOTES: readonly QuoteValuation[] = [
  {
    kind: 'priced',
    asset: MAINNET.tokens.MON.address,
    symbol: MAINNET.tokens.MON.symbol,
    decimals: MAINNET.tokens.MON.decimals,
    book: MON_USDC_PRICING_BOOK,
  },
];

/** Every quote asset the cap can value, and how. */
export const QUOTE_VALUATIONS: readonly QuoteValuation[] = [...DOLLAR_QUOTES, ...PRICED_QUOTES];

/**
 * How the cap values an order on a market with these params, or `undefined` when it
 * cannot. The address must match, and so must the decimals: the same address with other
 * decimals is not the asset this table describes.
 */
export function quoteValuationFor(
  params: Pick<MarketParams, 'quoteAsset' | 'quoteDecimals'>,
): QuoteValuation | undefined {
  const asset = params.quoteAsset.toLowerCase();
  const valuation = QUOTE_VALUATIONS.find((v) => v.asset.toLowerCase() === asset);
  if (!valuation || valuation.decimals !== params.quoteDecimals) return undefined;
  return valuation;
}

/**
 * Is `params` a book that can price `valuation`? Its base must be the priced asset, at
 * the same decimals, and its quote must itself be a dollar the cap takes one-for-one.
 */
export function pricesValuation(
  params: Pick<MarketParams, 'baseAsset' | 'baseDecimals' | 'quoteAsset' | 'quoteDecimals'>,
  valuation: QuoteValuation,
): boolean {
  if (valuation.kind !== 'priced') return false;
  return (
    params.baseAsset.toLowerCase() === valuation.asset.toLowerCase() &&
    params.baseDecimals === valuation.decimals &&
    quoteValuationFor(params)?.kind === 'dollar'
  );
}

/**
 * The dollar price of one whole unit of the priced asset, wire scale (human * 1e18), from
 * a raw `bestBidAsk()` reading of its pricing book. `undefined` unless the book has a
 * live bid, a live ask, and is not crossed.
 *
 * No price logic of its own: the sentinels are folded by `normalizeBestBidAsk`, and the
 * book is judged and its mid taken by `normalizeBook` and `midPrice`, exactly as the
 * trade screen does for every book it draws (I1: a crossed book has no price).
 */
export function usdMidOf(
  book: Address,
  bookParams: MarketParams,
  rawBid: bigint,
  rawAsk: bigint,
): bigint | undefined {
  const { bestBid, bestAsk } = normalizeBestBidAsk(rawBid, rawAsk);
  return midPrice(
    normalizeBook({
      market: book,
      source: 'bestBidAsk',
      state: 'finalized',
      params: bookParams,
      bids: [],
      asks: [],
      bestBid,
      bestAsk,
    }),
  );
}

/** The two reads a live price needs. The relayer backs `params` with its params cache. */
export interface QuotePriceReader {
  readonly params: (book: Address) => Promise<MarketParams>;
  readonly bestBidAsk: (book: Address) => Promise<readonly [bigint, bigint]>;
}

/**
 * Read the live dollar price a priced valuation needs, or `undefined` when there is not
 * a usable one. Never throws: a read that fails is not a price, and the caller refuses
 * the order rather than valuing it at something else.
 *
 * The pricing book's own params are checked every time they are read, so an address that
 * stopped being MON/USDC could not price MON.
 */
export async function readQuoteUsdPrice(
  reader: QuotePriceReader,
  valuation: QuoteValuation,
): Promise<bigint | undefined> {
  if (valuation.kind !== 'priced') return undefined;
  try {
    const [bookParams, touch] = await Promise.all([
      reader.params(valuation.book),
      reader.bestBidAsk(valuation.book),
    ]);
    if (!pricesValuation(bookParams, valuation)) return undefined;
    return usdMidOf(valuation.book, bookParams, touch[0], touch[1]);
  } catch {
    return undefined;
  }
}

/**
 * `amount` base units of the valuation's asset, in cap units.
 *
 * A dollar asset is its own amount. A priced asset is `amount * price`, rescaled from the
 * asset's decimals and the 1e18 wire scale down to six decimals, **rounded up**: a cap
 * that rounds down lets through an order a fraction of a cent over it.
 *
 * `undefined` when a priced asset has no usable price. The caller refuses; there is no
 * default price anywhere in this module.
 */
export function quoteAmountInCapUnits(
  amount: bigint,
  valuation: QuoteValuation,
  usdPrice?: bigint,
): bigint | undefined {
  if (valuation.kind === 'dollar') return amount;
  if (usdPrice === undefined || usdPrice <= 0n) return undefined;
  return rescaleWithRounding(
    amount * usdPrice,
    10n ** BigInt(valuation.decimals) * WIRE_PRICE_SCALE,
    10n ** BigInt(CAP_UNIT_DECIMALS),
    'ceil',
  );
}
