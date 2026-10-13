import { decodeFunctionData, type Address, type Hex } from 'viem';
import {
  assertQuoteAmountWithinCap,
  CapExceededError,
  FORWARDABLE_SELECTORS,
  normalizeBestBidAsk,
  orderBookAbi,
  quoteValuationFor,
  readQuoteUsdPrice,
  selectorOf,
  WIRE_PRICE_SCALE,
  type MarketParams,
  type QuotePriceReader,
} from '@tradepro/core';

/**
 * Notional enforcement for the live mainnet path.
 *
 * The owner's cap is $6 per order. The relayer cannot take the client's word for what
 * an order is worth — it has to read the notional out of the calldata it is being
 * asked to forward, using the market's own params. That is the only number that
 * matches what the contract will do.
 *
 * That notional is in the market's own quote-asset base units. It is valued in dollars
 * before it meets the cap (`assertQuoteAmountWithinCap` in `@tradepro/core`): AUSD and
 * USDC one-for-one, native MON at the live MON/USDC mid. Until 2026-09-23 it was compared
 * raw, which only worked because every traded market happened to be quoted in a
 * six-decimal dollar.
 *
 * `MAX_ORDER_NOTIONAL_AUSD` lives in `@tradepro/core` as code, not config, so nothing
 * in an environment file can raise what this function allows.
 */

/**
 * Live prices the cap needs, read by the caller at cap time (`readNotionalContext`).
 * Both are wire prices (human * 1e18).
 */
export interface NotionalContext {
  /**
   * The book's own best bid. A market sell carries no quote figure of its own, so it can
   * only be valued against a live price.
   */
  readonly marketPrice?: bigint;
  /**
   * The dollar price of one whole unit of the market's quote asset — the MON/USDC mid for
   * a market quoted in native MON. Required when the quote asset is priced; ignored when
   * it is a dollar.
   */
  readonly quoteUsdPrice?: bigint;
}

/** The four selectors that open a position, and so the only ones with a notional. */
const NOTIONAL_SELECTORS: ReadonlySet<string> = new Set([
  FORWARDABLE_SELECTORS.addBuyOrder,
  FORWARDABLE_SELECTORS.addSellOrder,
  FORWARDABLE_SELECTORS.placeAndExecuteMarketBuy,
  FORWARDABLE_SELECTORS.placeAndExecuteMarketSell,
]);

/** Does this call open a position, and so need valuing against the cap? */
export function carriesNotional(data: Hex): boolean {
  return NOTIONAL_SELECTORS.has(selectorOf(data));
}

/** Quote-asset base units an order commits, or `undefined` for calls with no notional. */
export function notionalOf(
  data: Hex,
  params: MarketParams,
  context: NotionalContext = {},
): bigint | undefined {
  const selector = selectorOf(data);

  if (selector === FORWARDABLE_SELECTORS.addBuyOrder) {
    const { args } = decodeFunctionData({ abi: orderBookAbi, data });
    const [price, size] = args as readonly [number, bigint, boolean];
    return limitNotional(BigInt(price), size, params);
  }

  if (selector === FORWARDABLE_SELECTORS.addSellOrder) {
    const { args } = decodeFunctionData({ abi: orderBookAbi, data });
    const [price, size] = args as readonly [number, bigint, boolean];
    return limitNotional(BigInt(price), size, params);
  }

  if (selector === FORWARDABLE_SELECTORS.placeAndExecuteMarketBuy) {
    // quoteSize is already in pricePrecision units of the quote asset.
    const { args } = decodeFunctionData({ abi: orderBookAbi, data });
    const [quoteSize] = args as readonly [bigint, bigint, boolean, boolean];
    return (quoteSize * 10n ** BigInt(params.quoteDecimals)) / params.pricePrecision;
  }

  if (selector === FORWARDABLE_SELECTORS.placeAndExecuteMarketSell) {
    // A market sell commits BASE size, and the calldata carries no quote figure. This
    // used to return `minAmountOut`, which was wrong twice over:
    //
    //   1. Every market sell this app builds sets `minAmountOut` to 0 — deliberately,
    //      a market order has no floor (`apps/trade/lib/ticket.ts`). So the notional
    //      read as 0 and `assertOrderWithinCap` refused it with "order notional must
    //      be positive". Every market sell on every market was rejected, always.
    //   2. Worse, when it was non-zero it UNDER-read the exposure: `minAmountOut` is
    //      the floor the seller will accept, not what the order commits. A large size
    //      with a token floor would have passed a cap it dwarfed.
    //
    // So the size is valued at a live price instead, and if there is no price to
    // value it at, this refuses rather than sponsoring an order it cannot bound.
    const { args } = decodeFunctionData({ abi: orderBookAbi, data });
    const [size] = args as readonly [bigint, bigint, boolean, boolean];
    const price = context.marketPrice;
    if (price === undefined || price <= 0n) {
      throw new CapExceededError(
        'MAX_ORDER_NOTIONAL',
        'a market sell cannot be valued without a live best bid, so it cannot be ' +
          'capped; refusing rather than sponsoring an order of unknown size',
      );
    }
    // size is in sizePrecision units; price is human * 1e18. Result is quote base units.
    return (size * price * 10n ** BigInt(params.quoteDecimals)) /
      (params.sizePrecision * WIRE_PRICE_SCALE);
  }

  // Cancels, deposits and withdrawals do not open a position. Deposits are bounded
  // by what the user actually holds and by the permit they signed.
  return undefined;
}

/**
 * price is in `pricePrecision` units, size in `sizePrecision` units.
 * notional = price * size, expressed in quote base units.
 */
function limitNotional(price: bigint, size: bigint, params: MarketParams): bigint {
  const quoteScale = 10n ** BigInt(params.quoteDecimals);
  return (price * size * quoteScale) / (params.pricePrecision * params.sizePrecision);
}

/**
 * Throws `CapExceededError` when the order is worth more than the hard cap, in dollars.
 *
 * Also throws when it cannot be valued: a market sell with no best bid, a quote asset the
 * cap has no valuation for, or a MON-quoted order with no usable MON/USDC mid.
 */
export function assertNotionalWithinCap(
  data: Hex,
  params: MarketParams,
  context: NotionalContext = {},
): void {
  const notional = notionalOf(data, params, context);
  if (notional === undefined) return;
  assertQuoteAmountWithinCap(notional, params, context.quoteUsdPrice);
}

/**
 * The reads `readNotionalContext` makes: `bestBidAsk()` on a book, and a book's params.
 * The target book's best bid and the pricing book's touch are both a `bestBidAsk()` read.
 * The server backs `params` with its params cache.
 */
export type NotionalReader = QuotePriceReader;

/**
 * Read the live prices the cap needs for this call, and nothing it does not.
 *
 *   - a call with no notional (a cancel, a deposit) reads nothing;
 *   - a market sell reads its own book's best bid, `marketPrice`;
 *   - any of the four order selectors on a market whose quote asset is priced reads that
 *     asset's pricing book, `quoteUsdPrice` (MON: the MON/USDC mid, whose own params are
 *     checked on every read).
 *
 * A read that fails leaves its field unset, and `assertNotionalWithinCap` then refuses:
 * an order that cannot be valued is never sponsored.
 */
export async function readNotionalContext(
  reader: NotionalReader,
  market: Address,
  data: Hex,
  params: MarketParams,
): Promise<NotionalContext> {
  if (!carriesNotional(data)) return {};
  const valuation = quoteValuationFor(params);
  const isMarketSell = selectorOf(data) === FORWARDABLE_SELECTORS.placeAndExecuteMarketSell;
  const [marketPrice, quoteUsdPrice] = await Promise.all([
    isMarketSell ? bestBidOf(reader, market) : Promise.resolve(undefined),
    valuation?.kind === 'priced'
      ? readQuoteUsdPrice(reader, valuation)
      : Promise.resolve(undefined),
  ]);
  return {
    ...(marketPrice === undefined ? {} : { marketPrice }),
    ...(quoteUsdPrice === undefined ? {} : { quoteUsdPrice }),
  };
}

/**
 * The book's best bid as a wire price, or `undefined` when there is no bid to read.
 *
 * `bestBidAsk()` reports "no bid" as `2^256-1`, not zero (measured on the empty MON/AUSD
 * book, chain 143 block 103,110,791); `normalizeBestBidAsk` folds it, so a caller that
 * needs a price to bound an order is told there is none instead of capping against the
 * largest number a uint256 can hold. A read that did not answer is not a price either.
 */
async function bestBidOf(reader: NotionalReader, market: Address): Promise<bigint | undefined> {
  try {
    const [rawBid, rawAsk] = await reader.bestBidAsk(market);
    const { bestBid } = normalizeBestBidAsk(rawBid, rawAsk);
    return bestBid > 0n ? bestBid : undefined;
  } catch {
    return undefined;
  }
}

export { WIRE_PRICE_SCALE };
