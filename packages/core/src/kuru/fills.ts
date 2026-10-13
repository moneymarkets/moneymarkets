import {
  decodeEventLog,
  parseAbiItem,
  toEventSelector,
  type Address,
  type Hex,
  type Log,
} from 'viem';
import { rescale, WIRE_PRICE_SCALE } from '../math/fixed.js';
import type { MarketParams } from './params.js';

/**
 * Fill and order-lifecycle decoding.
 *
 * No Kuru event has indexed parameters (verified against the deployed ABI:
 * `OrderCreated`, `OrdersCanceled` and `Trade` all declare `indexed: false` on every
 * input). That means the node cannot filter by user for us — the only topic
 * available is the event signature, and attribution is a client-side comparison
 * (framework §4.1, error 3).
 *
 * Two price scales meet here: `Trade.price` is 1e18 while `OrderCreated.price` is in
 * the market's `pricePrecision`. Both are normalized to the 1e18 wire scale on the
 * way out, so nothing downstream has to remember which was which.
 */

export const TRADE_EVENT = parseAbiItem(
  'event Trade(uint40 orderId, address makerAddress, bool isBuy, uint256 price, uint96 updatedSize, address takerAddress, address txOrigin, uint96 filledSize)',
);

export const ORDER_CREATED_EVENT = parseAbiItem(
  'event OrderCreated(uint40 orderId, address owner, uint96 size, uint32 price, bool isBuy)',
);

/**
 * `OrderCreated`'s topic0. No Kuru event indexes any parameter, so this is the ONLY
 * topic a log carries and the only cheap way to pick these out of a receipt.
 */
export const ORDER_CREATED_TOPIC = toEventSelector(ORDER_CREATED_EVENT).toLowerCase();

/** Plural and an array — one cancel event can carry many ids. */
export const ORDERS_CANCELED_EVENT = parseAbiItem(
  'event OrdersCanceled(uint40[] orderId, address owner)',
);

export interface Fill {
  readonly market: Address;
  readonly orderId: bigint;
  readonly maker: Address;
  readonly taker: Address;
  /**
   * The EOA that paid gas. For a forwarded transaction this is the **relayer**, not
   * the user, which is exactly why attribution uses maker/taker instead.
   */
  readonly txOrigin: Address;
  /**
   * **The TAKER's side, not the maker's and not necessarily yours.**
   *
   * Measured, not read off the ABI: across the owner's four MON/USDC fills on chain
   * 143 (`0x99aafb54`, `0xa0c1abf5`, `0xc859b103`, `0x6876229d`) this field equals the
   * taker's side on all four, checked against the margin-balance deltas at each block.
   *
   * Use `userSideOf()` rather than reading this directly. A bare `isBuy` on a type
   * called `Fill` reads like "the side of this fill", which is the assumption that
   * produced a backwards side in `scripts/read-activity-receipts.ts` and, briefly, in
   * `DECISIONS.md` D132 — it concluded the field was unusable when it was simply being
   * inverted.
   */
  readonly isBuy: boolean;
  /** human * 1e18 */
  readonly priceWire: bigint;
  /** sizePrecision units, as emitted */
  readonly filledSize: bigint;
  /** remaining size on the resting order, sizePrecision units */
  readonly updatedSize: bigint;
  readonly blockNumber: bigint;
  readonly txHash: Hex;
  readonly logIndex: number;
}

export interface OrderCreated {
  readonly market: Address;
  readonly orderId: bigint;
  readonly owner: Address;
  /** sizePrecision units */
  readonly size: bigint;
  /** human * 1e18, converted up from the emitted pricePrecision value */
  readonly priceWire: bigint;
  /** the raw pricePrecision value the contract emitted */
  readonly priceRaw: bigint;
  readonly isBuy: boolean;
  readonly blockNumber: bigint;
  readonly txHash: Hex;
  readonly logIndex: number;
}

export interface OrdersCanceled {
  readonly market: Address;
  readonly orderIds: readonly bigint[];
  readonly owner: Address;
  readonly blockNumber: bigint;
  readonly txHash: Hex;
  readonly logIndex: number;
}

type AnyLog = Log<bigint, number, false>;

function common(log: AnyLog) {
  if (log.blockNumber === null || log.transactionHash === null || log.logIndex === null) {
    throw new Error('pending logs have no position; refusing to record an unmined fill');
  }
  return {
    market: log.address,
    blockNumber: log.blockNumber,
    txHash: log.transactionHash,
    logIndex: log.logIndex,
  };
}

export function decodeTrade(log: AnyLog): Fill {
  const { args } = decodeEventLog({ abi: [TRADE_EVENT], data: log.data, topics: log.topics });
  return {
    ...common(log),
    orderId: BigInt(args.orderId),
    maker: args.makerAddress,
    taker: args.takerAddress,
    txOrigin: args.txOrigin,
    isBuy: args.isBuy,
    // Already 1e18 on the wire.
    priceWire: args.price,
    filledSize: args.filledSize,
    updatedSize: args.updatedSize,
  };
}

export function decodeOrderCreated(log: AnyLog, params: MarketParams): OrderCreated {
  const { args } = decodeEventLog({
    abi: [ORDER_CREATED_EVENT],
    data: log.data,
    topics: log.topics,
  });
  const priceRaw = BigInt(args.price);
  return {
    ...common(log),
    orderId: BigInt(args.orderId),
    owner: args.owner,
    size: args.size,
    priceRaw,
    // pricePrecision -> 1e18. Getting this backwards is a 1e10 error on MON/AUSD.
    priceWire: rescale(priceRaw, params.pricePrecision, WIRE_PRICE_SCALE),
    isBuy: args.isBuy,
  };
}

export function decodeOrdersCanceled(log: AnyLog): OrdersCanceled {
  const { args } = decodeEventLog({
    abi: [ORDERS_CANCELED_EVENT],
    data: log.data,
    topics: log.topics,
  });
  return {
    ...common(log),
    orderIds: args.orderId.map((id) => BigInt(id)),
    owner: args.owner,
  };
}

export type FillRole = 'maker' | 'taker';

export interface AttributedFill extends Fill {
  readonly role: FillRole;
}

/**
 * Which fills belong to a user.
 *
 * `txOrigin` is deliberately not part of the match. Under ERC-2771 it is the
 * relayer's address on every forwarded fill, so matching on it would attribute every
 * user's trade to the relayer and, worse, attribute the relayer's own gas payments to
 * whichever user happened to look. `_msgSender()` lands in `makerAddress` /
 * `takerAddress`, and those are the truth.
 */
/**
 * Which way a fill went **for one particular account**.
 *
 * `Trade.isBuy` is the taker's side (see `Fill.isBuy`), so a user who was the maker did
 * the opposite of what the field says. Getting this backwards is silent: it produces a
 * row that reads "Sold 0.39 MON" for a purchase, and nothing downstream can tell.
 *
 * Returns `undefined` when the fill is not this account's at all, rather than guessing
 * a side for a stranger's trade.
 */
export function userSideOf(fill: Fill, user: Address): 'buy' | 'sell' | undefined {
  const target = user.toLowerCase();
  if (fill.taker.toLowerCase() === target) return fill.isBuy ? 'buy' : 'sell';
  if (fill.maker.toLowerCase() === target) return fill.isBuy ? 'sell' : 'buy';
  return undefined;
}

export function attributeFills(fills: readonly Fill[], user: Address): AttributedFill[] {
  const target = user.toLowerCase();
  const out: AttributedFill[] = [];
  for (const fill of fills) {
    if (fill.maker.toLowerCase() === target) out.push({ ...fill, role: 'maker' });
    else if (fill.taker.toLowerCase() === target) out.push({ ...fill, role: 'taker' });
  }
  return out;
}

/**
 * Quote value of a fill in the quote asset's base units.
 * price (1e18) * size (sizePrecision) -> quote base units.
 */
export function fillQuoteValue(fill: Fill, params: MarketParams): bigint {
  const quoteScale = 10n ** BigInt(params.quoteDecimals);
  return (
    (fill.priceWire * fill.filledSize * quoteScale) / (WIRE_PRICE_SCALE * params.sizePrecision)
  );
}

/** `Trade`'s topic0. Same reasoning as `ORDER_CREATED_TOPIC`: it is the only topic. */
export const TRADE_TOPIC = toEventSelector(TRADE_EVENT).toLowerCase();

/**
 * What one receipt actually filled for one user on one market.
 *
 * Cost basis (`lib/costBasis.ts` in the app) needs both sides of a fill — how much
 * base arrived and how much quote left — and neither is in the calldata: a market
 * order names one side and the book decides the other. The receipt is where both
 * exist, and it exists for a moment. So this reads them there, at the same instant
 * the activity row is written, and nothing later has to reconstruct them.
 *
 * A batch can fill in several `Trade` events at several prices. They are summed, so
 * the caller gets one total of each side and the ratio between the two is the real
 * average price paid rather than any single print.
 *
 * `role` is not consulted: whether the user was the maker or the taker changes who
 * waited, not what moved. Both sides are still theirs.
 */
export function filledFromReceipt(
  logs: readonly AnyLog[],
  market: Address,
  user: Address,
  params: MarketParams,
): { readonly baseFilled: bigint; readonly quoteFilled: bigint } | undefined {
  const wanted = market.toLowerCase();
  const fills: Fill[] = [];
  for (const log of logs) {
    if (log.address?.toLowerCase() !== wanted) continue;
    if (log.topics?.[0]?.toLowerCase() !== TRADE_TOPIC) continue;
    try {
      fills.push(decodeTrade(log));
    } catch {
      // One unreadable log must not lose the fills beside it.
    }
  }
  const mine = attributeFills(fills, user);
  if (mine.length === 0) return undefined;

  const baseScale = 10n ** BigInt(params.baseDecimals);
  let baseFilled = 0n;
  let quoteFilled = 0n;
  for (const fill of mine) {
    baseFilled += (fill.filledSize * baseScale) / params.sizePrecision;
    quoteFilled += fillQuoteValue(fill, params);
  }
  return { baseFilled, quoteFilled };
}

/**
 * The order ids this receipt created for one owner on one market.
 *
 * The whole point of the open-orders list is that the app remembers the ids of the
 * orders it watched itself create — there is no on-chain call that enumerates a
 * user's orders, and the public RPC caps `eth_getLogs` at 100 blocks. That
 * remembering never happened: nothing in the app decoded `OrderCreated`, so `track()`
 * was called from nowhere and a real resting order was invisible and uncancellable.
 *
 * Deliberately narrow: it takes a receipt's logs and returns ids, needing no
 * `MarketParams` (unlike `decodeOrderCreated`, which rescales the price). A log from
 * another contract, another market, or another owner is skipped — a batch can touch
 * several — and a log that does not decode is skipped rather than throwing, because
 * one unrecognised log must not lose the ids alongside it.
 */
export function orderIdsCreatedFor(
  logs: readonly AnyLog[],
  market: Address,
  owner: Address,
): bigint[] {
  const topic0 = ORDER_CREATED_TOPIC;
  const wanted = market.toLowerCase();
  const who = owner.toLowerCase();
  const ids: bigint[] = [];
  for (const log of logs) {
    if (log.address?.toLowerCase() !== wanted) continue;
    if (log.topics?.[0]?.toLowerCase() !== topic0) continue;
    try {
      const { args } = decodeEventLog({
        abi: [ORDER_CREATED_EVENT],
        data: log.data,
        topics: log.topics,
      });
      if (String(args.owner).toLowerCase() !== who) continue;
      ids.push(BigInt(args.orderId));
    } catch {
      // Not an OrderCreated we can read. Skipping it keeps the rest.
    }
  }
  return ids;
}
