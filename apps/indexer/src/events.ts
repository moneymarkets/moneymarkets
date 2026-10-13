/**
 * The four Kuru events this indexer consumes, and the topic0 each one hashes to.
 *
 * Rule A2.5: none of these signatures was written from memory. Every one is
 * transcribed from the ABI arrays in `packages/core/src/abi/` (themselves verbatim
 * from `@kuru-labs/kuru-sdk@0.0.95` and selector-checked against the deployed Monad
 * mainnet dispatchers), and every topic0 below is asserted in `test/topics.test.ts`
 * against a REAL log fetched from chain 143 — see `test/fixtures/`.
 *
 * Two venue pitfalls are encoded here rather than in prose:
 *
 *  1. **No Kuru event indexes anything.** Every input is `indexed: false`, so a log
 *     carries exactly one topic — the signature — and every parameter lives in
 *     `data`. There is no node-side filter by owner; attribution is a client-side
 *     comparison. A handler written against an indexed `owner` reads garbage.
 *  2. **The cancel event is plural.** `OrdersCanceled` carries a `uint40[]`, even
 *     when one order is cancelled. A handler that treats it as a single id silently
 *     drops every order after the first in a batch cancel.
 */

import { parseAbiItem, toEventSelector, type AbiEvent, type Hex } from 'viem';

/**
 * `OrderBook.Trade`. `price` is 1e18 here — a different scale from the `uint32`
 * `price` on `OrderCreated` in the very same market. See `normalize.ts`.
 */
export const TRADE_EVENT: AbiEvent = parseAbiItem(
  'event Trade(uint40 orderId, address makerAddress, bool isBuy, uint256 price, uint96 updatedSize, address takerAddress, address txOrigin, uint96 filledSize)',
);

/** `OrderBook.OrderCreated`. `price` is in the market's `pricePrecision`. */
export const ORDER_CREATED_EVENT: AbiEvent = parseAbiItem(
  'event OrderCreated(uint40 orderId, address owner, uint96 size, uint32 price, bool isBuy)',
);

/** `OrderBook.OrdersCanceled`. Plural, and an array — pitfall 2 above. */
export const ORDERS_CANCELED_EVENT: AbiEvent = parseAbiItem(
  'event OrdersCanceled(uint40[] orderId, address owner)',
);

/**
 * `Router.MarketRegistered`. Twelve non-indexed params; the parameter order is the
 * ABI's, not a guess (`packages/core/src/abi/router.ts`). This is how the indexer
 * discovers a market and learns its `pricePrecision` without an RPC round-trip.
 */
export const MARKET_REGISTERED_EVENT: AbiEvent = parseAbiItem(
  'event MarketRegistered(address baseAsset, address quoteAsset, address market, address vaultAddress, uint32 pricePrecision, uint96 sizePrecision, uint32 tickSize, uint96 minSize, uint96 maxSize, uint256 takerFeeBps, uint256 makerFeeBps, uint96 kuruAmmSpread)',
);

export const TOPIC0 = {
  Trade: toEventSelector(TRADE_EVENT) as Hex,
  OrderCreated: toEventSelector(ORDER_CREATED_EVENT) as Hex,
  OrdersCanceled: toEventSelector(ORDERS_CANCELED_EVENT) as Hex,
  MarketRegistered: toEventSelector(MARKET_REGISTERED_EVENT) as Hex,
} as const;

export type KuruEventName = keyof typeof TOPIC0;

/** Reverse lookup, so a raw log can be routed without re-hashing per log. */
export const EVENT_BY_TOPIC0: ReadonlyMap<Hex, KuruEventName> = new Map(
  (Object.entries(TOPIC0) as [KuruEventName, Hex][]).map(([name, topic]) => [topic, name]),
);
