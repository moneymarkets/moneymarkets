/**
 * Envio HyperIndex handlers.
 *
 * This file is deliberately thin. Everything that decides a value lives in
 * `normalize.ts`, which imports nothing from Envio and is unit-tested against REAL
 * logs from chain 143. What is left here is plumbing: read an entity, call a pure
 * function, write the entity back.
 *
 * That split exists because `generated` only appears after `envio codegen`, which
 * needs Docker. Logic that can only be executed under Docker is logic that does not
 * get tested on a machine without it — so the logic is not in here.
 *
 * `../tsconfig.json` excludes this file for the same reason: the repo-wide
 * `pnpm typecheck` must pass without Docker. It is typechecked by
 * `pnpm codegen && pnpm exec tsc --noEmit` once codegen has run; see README.
 *
 * Two venue pitfalls are handled explicitly and are the things to check in review:
 *
 *  1. No Kuru event indexes anything, so `owner`/`maker`/`taker` come out of `data`
 *     and every address comparison is client-side and lowercased.
 *  2. `OrdersCanceled` is plural. `handlerContext` loops the array; it never reads
 *     `event.params.orderId[0]`.
 */

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck -- `generated` does not exist until `envio codegen` has run.
import { OrderBook, Router } from 'generated';

import {
  cancelledOrderKeys,
  fillQuoteValue,
  logKey,
  orderKey,
  statusAfterCancel,
  statusAfterFill,
  toCancelRow,
  toFillRow,
  toMarketRow,
  toOrderRow,
  userKey,
  type OrderStatus,
} from './normalize.js';
import { seedMarketFor } from './markets.js';

/**
 * The slice of Envio's generated context these helpers actually use.
 *
 * Written structurally rather than imported from `generated` so the helpers stay
 * readable (and lint-clean) without codegen. Envio's real context is a superset.
 */
interface EntityStore<T> {
  get(id: string): Promise<T | undefined>;
  set(row: T): void;
}

interface StoredMarket {
  pricePrecision: bigint;
  sizePrecision: bigint;
  quoteAsset: string;
}

interface StoredUserStats {
  id: string;
  volumeQuote: bigint;
  fills: number;
  ordersPlaced: number;
  ordersCanceled: number;
  lastSeenBlock: number;
}

interface HelperContext {
  Market: EntityStore<StoredMarket>;
  UserStats: EntityStore<StoredUserStats>;
}

interface Scales {
  pricePrecision: bigint;
  sizePrecision: bigint;
  quoteDecimals: number;
}

/**
 * A market's scales, from the indexed `Market` entity if `MarketRegistered` was seen,
 * otherwise from the verified seed table.
 *
 * Returns `undefined` rather than assuming a scale. A guessed `pricePrecision` does
 * not produce a slightly-wrong price, it produces one off by orders of magnitude —
 * 1e4 on WBTC_AUSD versus 1e8 on the MON books — and it would be shown to a user as
 * their PnL. Fail closed (design principle 5).
 */
async function scalesFor(
  context: HelperContext,
  marketAddress: string,
): Promise<Scales | undefined> {
  const id = marketAddress.toLowerCase();
  const seed = seedMarketFor(id);
  const stored = await context.Market.get(id);
  if (stored) {
    return {
      pricePrecision: stored.pricePrecision,
      sizePrecision: stored.sizePrecision,
      // MarketRegistered carries the quote token address but not its decimals, so the
      // seed supplies them where we have it. Quote decimals only affect the display
      // notional in `quoteValue`, never a price.
      quoteDecimals: seed?.quoteDecimals ?? 6,
    };
  }
  if (!seed) return undefined;
  return {
    pricePrecision: seed.pricePrecision,
    sizePrecision: seed.sizePrecision,
    quoteDecimals: seed.quoteDecimals,
  };
}

async function bumpUser(
  context: HelperContext,
  address: string,
  blockNumber: number,
  delta: { volumeQuote?: bigint; fills?: number; ordersPlaced?: number; ordersCanceled?: number },
): Promise<void> {
  const id = userKey(address as `0x${string}`);
  const prev = await context.UserStats.get(id);
  context.UserStats.set({
    id,
    volumeQuote: (prev?.volumeQuote ?? 0n) + (delta.volumeQuote ?? 0n),
    fills: (prev?.fills ?? 0) + (delta.fills ?? 0),
    ordersPlaced: (prev?.ordersPlaced ?? 0) + (delta.ordersPlaced ?? 0),
    ordersCanceled: (prev?.ordersCanceled ?? 0) + (delta.ordersCanceled ?? 0),
    lastSeenBlock: blockNumber,
  });
}

/**
 * Market discovery. Registers the new order book with the indexer so its events are
 * followed from this block on, without a redeploy.
 */
Router.MarketRegistered.contractRegister(({ event, context }) => {
  context.addOrderBook(event.params.market);
});

Router.MarketRegistered.handler(async ({ event, context }) => {
  const row = toMarketRow(event.params, { blockNumber: event.block.number });
  context.Market.set(row);
});

OrderBook.OrderCreated.handler(async ({ event, context }) => {
  const market = event.srcAddress;
  const scales = await scalesFor(context, market);
  if (!scales) {
    // Refuse to store a price we cannot scale. Better a missing order than a wrong
    // number presented as a real one.
    context.log.error(
      `OrderCreated on unknown market ${market}: no MarketRegistered indexed and no ` +
        'seed entry. Skipping rather than guessing pricePrecision.',
    );
    return;
  }

  const row = toOrderRow(market, event.params, scales.pricePrecision, {
    blockNumber: event.block.number,
    txHash: event.transaction.hash,
  });
  context.Order.set({ ...row, lastUpdatedBlock: event.block.number });
  await bumpUser(context, event.params.owner, event.block.number, { ordersPlaced: 1 });
});

OrderBook.Trade.handler(async ({ event, context }) => {
  const market = event.srcAddress;
  const scales = await scalesFor(context, market);
  if (!scales) {
    context.log.error(`Trade on unknown market ${market}: no scales, skipping.`);
    return;
  }

  const fill = toFillRow(market, event.params, {
    blockNumber: event.block.number,
    txHash: event.transaction.hash,
    logIndex: event.logIndex,
  });
  const quoteValue = fillQuoteValue(
    fill.priceWire,
    fill.filledSize,
    scales.sizePrecision,
    scales.quoteDecimals,
  );

  context.Fill.set({
    id: logKey(event.transaction.hash, event.logIndex),
    market_id: fill.market,
    // The maker's resting order. Undefined if it was created before `start_block`,
    // which is expected on a fresh sync and is why the relation is nullable.
    order_id: fill.order,
    orderId: fill.orderId,
    maker: fill.maker,
    taker: fill.taker,
    txOrigin: fill.txOrigin,
    isBuy: fill.isBuy,
    priceWire: fill.priceWire,
    filledSize: fill.filledSize,
    updatedSize: fill.updatedSize,
    quoteValue,
    blockNumber: fill.blockNumber,
    timestamp: event.block.timestamp,
    txHash: fill.txHash,
    logIndex: fill.logIndex,
  });

  // `updatedSize` is the REMAINDER on the maker's order, not the amount taken.
  const existing = await context.Order.get(orderKey(market, event.params.orderId));
  if (existing) {
    context.Order.set({
      ...existing,
      remaining: event.params.updatedSize,
      status: statusAfterFill(event.params.updatedSize),
      lastUpdatedBlock: event.block.number,
    });
  }

  // Both sides are credited, but a self-trade is one fill, not two.
  await bumpUser(context, fill.maker, event.block.number, { volumeQuote: quoteValue, fills: 1 });
  if (fill.taker !== fill.maker) {
    await bumpUser(context, fill.taker, event.block.number, { volumeQuote: quoteValue, fills: 1 });
  }
});

OrderBook.OrdersCanceled.handler(async ({ event, context }) => {
  const market = event.srcAddress;

  const row = toCancelRow(market, event.params, {
    blockNumber: event.block.number,
    txHash: event.transaction.hash,
    logIndex: event.logIndex,
  });
  context.Cancel.set({
    id: row.id,
    market_id: row.market,
    owner: row.owner,
    orderIds: row.orderIds,
    orderCount: row.orderCount,
    blockNumber: row.blockNumber,
    timestamp: event.block.timestamp,
    txHash: row.txHash,
    logIndex: row.logIndex,
  });

  // THE ARRAY. Every id in the batch, not just the first. Reading one id per log
  // would have left 689 of 1,841 cancelled orders showing as OPEN over a single
  // 600-block window (test/fixtures/batch-cancels.json).
  for (const key of cancelledOrderKeys(market, event.params)) {
    const order = await context.Order.get(key);
    if (!order) continue;
    context.Order.set({
      ...order,
      status: statusAfterCancel(order.status as OrderStatus),
      remaining: 0n,
      lastUpdatedBlock: event.block.number,
    });
  }

  await bumpUser(context, event.params.owner, event.block.number, {
    ordersCanceled: event.params.orderId.length,
  });
});
