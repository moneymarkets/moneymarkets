/**
 * The indexer's logic, with no Envio in it.
 *
 * Envio's generated handlers are a thin shell around this file. That split is
 * deliberate: `envio codegen` needs Docker, Docker is not on every machine, and logic
 * that can only run under Docker is logic that never gets tested. Everything here is
 * a pure function over plain values, so `test/` can drive it with REAL logs pulled
 * off chain 143 and assert the results against what the venue actually emitted.
 *
 * Rule A2.6: every monetary value in and out of this file is a `bigint`. There is no
 * `number` on any price, size or notional path — `Number` appears only on block
 * numbers and log indices, which are positions, not money.
 */

import type { Address, Hex } from 'viem';
import { rescale, WIRE_PRICE_SCALE } from '@tradepro/core';

export { WIRE_PRICE_SCALE };

/**
 * An integer event parameter as a decoder hands it over — `bigint` or `number`.
 *
 * **This is not defensive padding, it is a real difference that bit these tests.**
 * viem decodes any Solidity integer of 48 bits or fewer to a JavaScript `number` and
 * anything wider to a `bigint`. Kuru's events straddle that line inside a single
 * event: `OrderCreated(uint40 orderId, address owner, uint96 size, uint32 price, bool
 * isBuy)` yields `orderId` and `price` as `number` while `size` comes back as
 * `bigint`. Mixing them throws `TypeError: Cannot mix BigInt and other types`, which
 * is the good case; the bad case is `2493300 !== 2493300n` passing silently through a
 * loose comparison.
 *
 * Envio's generated handler types make their own choice here, and this module is
 * driven by both (viem in the tests, Envio in `EventHandlers.ts`). So every integer
 * parameter is accepted either way and coerced exactly once, at the boundary.
 */
export type Uint = bigint | number;

/**
 * Coerce an event parameter to `bigint` (rule A2.6).
 *
 * `BigInt(number)` throws on a non-integer rather than truncating, so a float that
 * somehow reached here fails loudly instead of silently losing its fraction.
 */
export function big(value: Uint): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}

/** Lifecycle of a resting order, as the indexer can observe it from logs alone. */
export type OrderStatus = 'OPEN' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED';

export type Side = 'BUY' | 'SELL';

/**
 * Only ever correct for an **`OrderCreated`** flag, where `isBuy` is the order owner's
 * own side. Do not point it at a `Trade`: that event's `isBuy` is the **taker's** side
 * (measured on chain 143, 2026-09-09), so a maker's row would come out backwards.
 * `FillRow` keeps the raw flag and says whose it is rather than pre-labelling a side.
 */
export const sideOf = (isBuy: boolean): Side => (isBuy ? 'BUY' : 'SELL');

/**
 * Entity ids.
 *
 * An `orderId` is only unique *within* an order book — Kuru numbers orders per
 * market, so two markets will happily hand out the same `uint40`. Keying an entity on
 * the bare id merges unrelated users' orders together, which is the kind of bug that
 * shows a stranger's position on someone's portfolio. The market address is therefore
 * part of every order key.
 */
export const orderKey = (market: Address, orderId: Uint): string =>
  `${market.toLowerCase()}-${big(orderId).toString()}`;

/** A log's position is unique chain-wide and never collides across reorg-free data. */
export const logKey = (txHash: Hex, logIndex: number): string =>
  `${txHash.toLowerCase()}-${logIndex}`;

export const userKey = (address: Address): string => address.toLowerCase();

/**
 * Price scale normalisation (spec invariant I3).
 *
 * `OrderCreated.price` is a `uint32` in the market's own `pricePrecision`, while
 * `Trade.price` is a `uint256` already at the 1e18 wire scale — two scales for the
 * same quantity, in the same market, sometimes in the same block. Everything stored
 * by this indexer is at the wire scale, so a consumer never has to ask which one it
 * is holding.
 *
 * On MON/AUSD `pricePrecision` is 1e8, so getting the direction backwards is a 1e10
 * error: a 2.4933 price becomes 0.00000000024933 or 249,330,000,000. That is not a
 * rounding difference, it is a different number, and it would be displayed as a
 * user's PnL.
 */
export function orderPriceToWire(priceRaw: Uint, pricePrecision: Uint): bigint {
  const precision = big(pricePrecision);
  if (precision <= 0n) {
    throw new Error(`orderPriceToWire: market has non-positive pricePrecision ${precision}`);
  }
  return rescale(big(priceRaw), precision, WIRE_PRICE_SCALE);
}

/**
 * `Trade.price` is already 1e18. This function exists so the handler for `Trade` has
 * a named, documented no-op instead of an unexplained missing conversion — the next
 * person to read the handler should not have to wonder whether a rescale was
 * forgotten here.
 */
export function tradePriceToWire(price: Uint): bigint {
  return big(price);
}

/**
 * Notional of a fill in the quote asset's base units.
 *
 * `priceWire` is human*1e18 and `filledSize` is in `sizePrecision` units, so the
 * product has to lose both scales and pick up the quote's decimals. Pure integer
 * math; the division truncates, which under-counts by less than one base unit.
 */
export function fillQuoteValue(
  priceWire: Uint,
  filledSize: Uint,
  sizePrecision: Uint,
  quoteDecimals: number,
): bigint {
  const precision = big(sizePrecision);
  if (precision <= 0n) {
    throw new Error(`fillQuoteValue: market has non-positive sizePrecision ${precision}`);
  }
  const quoteScale = 10n ** BigInt(quoteDecimals);
  return (big(priceWire) * big(filledSize) * quoteScale) / (WIRE_PRICE_SCALE * precision);
}

/**
 * Status of a resting order after a `Trade` touched it.
 *
 * `Trade.updatedSize` is what is *left* on the maker's order, not what was taken. A
 * handler that reads it as the filled amount reports a half-filled order as fully
 * filled and vice versa.
 */
export function statusAfterFill(updatedSize: Uint): OrderStatus {
  return big(updatedSize) === 0n ? 'FILLED' : 'PARTIALLY_FILLED';
}

/**
 * Whether a cancel should overwrite the status already on an order.
 *
 * A fully-filled order can still appear in a later `OrdersCanceled` batch — the venue
 * does not mind being asked to cancel something that is already gone. `FILLED` is
 * terminal and truthful, so it wins; anything else yields to the cancel.
 */
export function statusAfterCancel(current: OrderStatus): OrderStatus {
  return current === 'FILLED' ? 'FILLED' : 'CANCELED';
}

export interface MarketScales {
  readonly pricePrecision: bigint;
  readonly sizePrecision: bigint;
  readonly quoteDecimals: number;
}

/** Decoded `OrderCreated` params, in the shape Envio hands a handler. */
export interface OrderCreatedParams {
  /** uint40 - viem hands this over as a `number`. */
  readonly orderId: Uint;
  readonly owner: Address;
  /** uint96 - wide enough that viem hands over a `bigint`. */
  readonly size: Uint;
  /** uint32, in the market's pricePrecision - viem hands over a `number`. */
  readonly price: Uint;
  readonly isBuy: boolean;
}

export interface OrderRow {
  readonly id: string;
  readonly market: string;
  readonly orderId: bigint;
  readonly owner: string;
  readonly side: Side;
  /** human * 1e18, normalised up from the emitted `pricePrecision` value. */
  readonly priceWire: bigint;
  /** exactly what the contract emitted, kept so the normalisation stays auditable. */
  readonly priceRaw: bigint;
  readonly size: bigint;
  readonly remaining: bigint;
  readonly status: OrderStatus;
  readonly createdBlock: number;
  readonly createdTxHash: string;
}

export function toOrderRow(
  market: Address,
  params: OrderCreatedParams,
  pricePrecision: Uint,
  position: { blockNumber: number; txHash: Hex },
): OrderRow {
  const size = big(params.size);
  return {
    id: orderKey(market, params.orderId),
    market: market.toLowerCase(),
    orderId: big(params.orderId),
    owner: params.owner.toLowerCase(),
    side: sideOf(params.isBuy),
    priceWire: orderPriceToWire(params.price, pricePrecision),
    priceRaw: big(params.price),
    size,
    // Nothing has traded against it yet, so the whole size is still resting.
    remaining: size,
    status: 'OPEN',
    createdBlock: position.blockNumber,
    createdTxHash: position.txHash.toLowerCase(),
  };
}

/** Decoded `Trade` params, in the shape Envio hands a handler. */
export interface TradeParams {
  /** uint40 - viem hands this over as a `number`. */
  readonly orderId: Uint;
  readonly makerAddress: Address;
  readonly isBuy: boolean;
  /** uint256, ALREADY 1e18-scaled. Not the scale OrderCreated.price uses. */
  readonly price: Uint;
  readonly updatedSize: Uint;
  readonly takerAddress: Address;
  readonly txOrigin: Address;
  readonly filledSize: Uint;
}

export interface FillRow {
  readonly id: string;
  readonly market: string;
  readonly orderId: bigint;
  readonly order: string;
  readonly maker: string;
  readonly taker: string;
  /**
   * The EOA that paid gas. Under the sponsored-gas path this is a bundler or the
   * sponsor, never reliably the user — which is why it is recorded but is not what
   * attribution keys on.
   */
  readonly txOrigin: string;
  /**
   * **The taker's side.** Not the maker's, and not necessarily the side of whoever is
   * reading this row: a maker did the opposite. Measured across the owner's four real
   * MON/USDC fills against the margin ledger, 2026-09-09. Consumers deriving a user's
   * own side must compare against `maker`/`taker` first — `userSideOf` in
   * `@tradepro/core` is the reference implementation.
   */
  readonly isBuy: boolean;
  /** human * 1e18. `Trade.price` arrives at this scale already. */
  readonly priceWire: bigint;
  readonly filledSize: bigint;
  readonly updatedSize: bigint;
  readonly blockNumber: number;
  readonly txHash: string;
  readonly logIndex: number;
}

export function toFillRow(
  market: Address,
  params: TradeParams,
  position: { blockNumber: number; txHash: Hex; logIndex: number },
): FillRow {
  return {
    id: logKey(position.txHash, position.logIndex),
    market: market.toLowerCase(),
    orderId: big(params.orderId),
    order: orderKey(market, params.orderId),
    maker: params.makerAddress.toLowerCase(),
    taker: params.takerAddress.toLowerCase(),
    txOrigin: params.txOrigin.toLowerCase(),
    isBuy: params.isBuy,
    priceWire: tradePriceToWire(params.price),
    filledSize: big(params.filledSize),
    updatedSize: big(params.updatedSize),
    blockNumber: position.blockNumber,
    txHash: position.txHash.toLowerCase(),
    logIndex: position.logIndex,
  };
}

/** Decoded `OrdersCanceled` params. `orderId` is an ARRAY — venue pitfall 2. */
export interface OrdersCanceledParams {
  /** uint40[] - an ARRAY, and viem hands over `number` elements. */
  readonly orderId: readonly Uint[];
  readonly owner: Address;
}

export interface CancelRow {
  readonly id: string;
  readonly market: string;
  readonly owner: string;
  /** Every id in the batch, as strings so a GraphQL client keeps full uint40 range. */
  readonly orderIds: readonly string[];
  readonly orderCount: number;
  readonly blockNumber: number;
  readonly txHash: string;
  readonly logIndex: number;
}

export function toCancelRow(
  market: Address,
  params: OrdersCanceledParams,
  position: { blockNumber: number; txHash: Hex; logIndex: number },
): CancelRow {
  return {
    id: logKey(position.txHash, position.logIndex),
    market: market.toLowerCase(),
    owner: params.owner.toLowerCase(),
    orderIds: params.orderId.map((id) => big(id).toString()),
    orderCount: params.orderId.length,
    blockNumber: position.blockNumber,
    txHash: position.txHash.toLowerCase(),
    logIndex: position.logIndex,
  };
}

/**
 * The order entity keys a cancel batch touches.
 *
 * This is the plural pitfall in one function. Over blocks 101340850..101341449 on the
 * four live books, 1,152 `OrdersCanceled` logs carried 1,841 order ids
 * (`test/fixtures/batch-cancels.json`); an indexer that read one id per log would have
 * left 689 cancelled orders showing as OPEN forever.
 */
export function cancelledOrderKeys(market: Address, params: OrdersCanceledParams): string[] {
  return params.orderId.map((id) => orderKey(market, id));
}

/** Decoded `Router.MarketRegistered` params. Twelve of them, none indexed. */
export interface MarketRegisteredParams {
  readonly baseAsset: Address;
  readonly quoteAsset: Address;
  readonly market: Address;
  readonly vaultAddress: Address;
  /** uint32 - viem hands over a `number`. */
  readonly pricePrecision: Uint;
  readonly sizePrecision: Uint;
  /** uint32 - viem hands over a `number`. */
  readonly tickSize: Uint;
  readonly minSize: Uint;
  readonly maxSize: Uint;
  readonly takerFeeBps: Uint;
  readonly makerFeeBps: Uint;
  readonly kuruAmmSpread: Uint;
}

export interface MarketRow {
  readonly id: string;
  readonly baseAsset: string;
  readonly quoteAsset: string;
  readonly vault: string;
  readonly pricePrecision: bigint;
  readonly sizePrecision: bigint;
  readonly tickSize: bigint;
  readonly minSize: bigint;
  readonly maxSize: bigint;
  readonly takerFeeBps: bigint;
  readonly makerFeeBps: bigint;
  readonly kuruAmmSpread: bigint;
  readonly registeredBlock: number;
}

export function toMarketRow(
  params: MarketRegisteredParams,
  position: { blockNumber: number },
): MarketRow {
  return {
    id: params.market.toLowerCase(),
    baseAsset: params.baseAsset.toLowerCase(),
    quoteAsset: params.quoteAsset.toLowerCase(),
    vault: params.vaultAddress.toLowerCase(),
    pricePrecision: big(params.pricePrecision),
    sizePrecision: big(params.sizePrecision),
    tickSize: big(params.tickSize),
    minSize: big(params.minSize),
    maxSize: big(params.maxSize),
    takerFeeBps: big(params.takerFeeBps),
    makerFeeBps: big(params.makerFeeBps),
    kuruAmmSpread: big(params.kuruAmmSpread),
    registeredBlock: position.blockNumber,
  };
}

/**
 * `MarketRegistered` is the only source of a market's `pricePrecision` that the
 * indexer gets for free. If a market's first `OrderCreated` arrives before its
 * registration has been indexed — possible when `start_block` is set past the
 * registration, which is the normal case for a fresh deploy — there is nothing to
 * normalise the price with.
 *
 * Fail closed rather than guess (design principle 5). Storing `priceRaw` with a
 * silently-assumed 1e8 would produce numbers that look plausible on MON markets and
 * are wrong by orders of magnitude on any market that differs.
 */
export class UnknownMarketScaleError extends Error {
  constructor(readonly market: string) {
    super(
      `no pricePrecision known for market ${market}. The indexer must see ` +
        'Router.MarketRegistered (or be seeded from getMarketParams) before it can ' +
        'normalise this market’s prices; refusing to guess a scale.',
    );
    this.name = 'UnknownMarketScaleError';
  }
}
