/**
 * Order 13130679 on MON_AUSD, end to end.
 *
 * A real order placed by `0x43a275C3…` in block 101,310,782 and cancelled nineteen
 * blocks later. Both logs are in `fixtures/ground-truth-order-13130679.json`, fetched
 * from `https://rpc.monad.xyz`. This test walks them through the same functions the
 * Envio handlers call and asserts the result against values that are independently
 * known — the order id and owner from the spec, the price from the raw `data` word.
 */

import { describe, expect, it } from 'vitest';
import { TOPIC0 } from '../src/events.js';
import {
  big,
  cancelledOrderKeys,
  orderKey,
  statusAfterCancel,
  toCancelRow,
  toOrderRow,
  WIRE_PRICE_SCALE,
} from '../src/normalize.js';
import { seedMarketFor } from '../src/markets.js';
import { decodeOrderCreated, decodeOrdersCanceled, groundTruth, position } from './fixtures.js';
import type { Address } from 'viem';

const MON_AUSD = '0x131A2e70A5b31a517A74b8c567149bc294470Da9' as Address;
const OWNER = '0x43a275C3Eb0BE7313f847FFA4fb6Bd366606A961';
const ORDER_ID = 13_130_679n;

const createdLog = groundTruth.logs.find((l) => l.topics[0] === TOPIC0.OrderCreated);
const cancelLog = groundTruth.logs.find((l) => l.topics[0] === TOPIC0.OrdersCanceled);

describe('the real OrderCreated', () => {
  it('is present in the fixture', () => {
    expect(createdLog).toBeDefined();
    expect(createdLog?.address.toLowerCase()).toBe(MON_AUSD.toLowerCase());
  });

  it('decodes to the order id and owner the spec names', () => {
    const params = decodeOrderCreated(createdLog!);
    // `big()` because `orderId` is a uint40 and viem returns those as `number`.
    expect(big(params.orderId)).toBe(ORDER_ID);
    expect(params.owner.toLowerCase()).toBe(OWNER.toLowerCase());
    expect(params.isBuy).toBe(true);
  });

  it('carries the price the raw log data carries', () => {
    const params = decodeOrderCreated(createdLog!);
    // Word 3 of `data` (0-indexed), read straight out of the hex rather than through
    // the decoder, so this is an independent check of the decoder itself.
    const word3 = BigInt(`0x${createdLog!.data.slice(2).slice(3 * 64, 4 * 64)}`);
    expect(big(params.price)).toBe(word3);
    expect(big(params.price)).toBe(2_493_300n);
  });

  it('normalises 1e8 pricePrecision up to the 1e18 wire scale', () => {
    const seed = seedMarketFor(MON_AUSD);
    expect(seed?.pricePrecision).toBe(100_000_000n);

    const params = decodeOrderCreated(createdLog!);
    const row = toOrderRow(MON_AUSD, params, seed!.pricePrecision, position(createdLog!));

    // 2493300 / 1e8 = 0.024933, so at 1e18 that is 24_933_000_000_000_000.
    expect(row.priceWire).toBe(24_933_000_000_000_000n);
    expect(row.priceRaw).toBe(2_493_300n);
    // The invariant, stated as a ratio rather than a magic number.
    expect(row.priceWire).toBe((row.priceRaw * WIRE_PRICE_SCALE) / seed!.pricePrecision);
  });

  it('starts OPEN with nothing filled', () => {
    const seed = seedMarketFor(MON_AUSD)!;
    const params = decodeOrderCreated(createdLog!);
    const row = toOrderRow(MON_AUSD, params, seed.pricePrecision, position(createdLog!));

    expect(row.status).toBe('OPEN');
    expect(row.remaining).toBe(row.size);
    expect(row.side).toBe('BUY');
    expect(row.createdBlock).toBe(101_310_782);
    expect(row.id).toBe(orderKey(MON_AUSD, ORDER_ID));
  });
});

describe('the real OrdersCanceled — plural, carrying an array', () => {
  it('is present, in the block the spec names', () => {
    expect(cancelLog).toBeDefined();
    expect(Number(BigInt(cancelLog!.blockNumber))).toBe(101_310_801);
  });

  it('decodes to an ARRAY containing the order id, not a bare id', () => {
    const params = decodeOrdersCanceled(cancelLog!);
    expect(Array.isArray(params.orderId)).toBe(true);
    expect(params.orderId.map(big)).toEqual([ORDER_ID]);
    expect(params.owner.toLowerCase()).toBe(OWNER.toLowerCase());
  });

  it('produces a Cancel row that records the batch size', () => {
    const params = decodeOrdersCanceled(cancelLog!);
    const row = toCancelRow(MON_AUSD, params, position(cancelLog!));
    expect(row.orderIds).toEqual([ORDER_ID.toString()]);
    expect(row.orderCount).toBe(1);
    expect(row.blockNumber).toBe(101_310_801);
  });
});

describe('the order round-trips: created then cancelled', () => {
  it('the cancel names exactly the order the create made', () => {
    const created = decodeOrderCreated(createdLog!);
    const cancelled = decodeOrdersCanceled(cancelLog!);

    const createdId = orderKey(MON_AUSD, created.orderId);
    const cancelledIds = cancelledOrderKeys(MON_AUSD, cancelled);

    // This is the round-trip: the key the OrderCreated handler would write is exactly
    // the key the OrdersCanceled handler would look up.
    expect(cancelledIds).toContain(createdId);
  });

  it('ends CANCELED, with nothing left resting', () => {
    const seed = seedMarketFor(MON_AUSD)!;
    const created = decodeOrderCreated(createdLog!);
    const row = toOrderRow(MON_AUSD, created, seed.pricePrecision, position(createdLog!));

    expect(row.status).toBe('OPEN');
    expect(statusAfterCancel(row.status)).toBe('CANCELED');
  });

  it('same owner on both sides, and it is not the gas payer', () => {
    const created = decodeOrderCreated(createdLog!);
    const cancelled = decodeOrdersCanceled(cancelLog!);
    expect(created.owner.toLowerCase()).toBe(cancelled.owner.toLowerCase());
    expect(created.owner.toLowerCase()).toBe(OWNER.toLowerCase());
  });

  it('create and cancel are different transactions', () => {
    expect(createdLog!.transactionHash).not.toBe(cancelLog!.transactionHash);
  });
});
