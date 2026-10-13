/**
 * Venue pitfall 2: `OrdersCanceled` is plural and carries a `uint40[]`.
 *
 * This is not a theoretical edge case, and that matters enough to measure. Over blocks
 * 101,340,850..101,341,449 on the four live books — ten minutes of Monad at 400ms
 * blocks — 1,152 `OrdersCanceled` logs carried 1,841 order ids. An indexer that read
 * one id per log would have left 689 cancelled orders showing as OPEN forever, and
 * `/portfolio` would show a user resting orders they had already cancelled.
 *
 * Every log in `fixtures/batch-cancels.json` is a real, unedited log with more than
 * one id in it.
 */

import { describe, expect, it } from 'vitest';
import { TOPIC0 } from '../src/events.js';
import { cancelledOrderKeys, orderKey, toCancelRow } from '../src/normalize.js';
import { batchCancels, decodeOrdersCanceled, position, recentSweep } from './fixtures.js';
import type { Address } from 'viem';

const population = batchCancels.population as {
  cancelLogs: number;
  orderIdsCancelled: number;
  cancelLogsCarryingMoreThanOneId: number;
  idsLostByASingularHandler: number;
};

describe('batch cancels are common, not exotic', () => {
  it('the measured window cancelled more orders than it emitted logs', () => {
    expect(population.cancelLogs).toBeGreaterThan(1000);
    expect(population.orderIdsCancelled).toBeGreaterThan(population.cancelLogs);
    expect(population.idsLostByASingularHandler).toBeGreaterThan(0);
  });

  it('a singular handler would have missed a double-digit percentage of them', () => {
    const lostFraction = population.idsLostByASingularHandler / population.orderIdsCancelled;
    expect(lostFraction).toBeGreaterThan(0.1);
  });

  it('the fixture holds only real multi-id logs', () => {
    expect(batchCancels.logs.length).toBeGreaterThan(0);
    expect(batchCancels.logs.length).toBe(population.cancelLogsCarryingMoreThanOneId);
    for (const log of batchCancels.logs) {
      expect(log.topics[0]).toBe(TOPIC0.OrdersCanceled);
      expect(log.topics).toHaveLength(1);
      expect(decodeOrdersCanceled(log).orderId.length).toBeGreaterThan(1);
    }
  });
});

describe('the handler reads the whole array', () => {
  it('produces one order key per id, for every real batch', () => {
    let totalIds = 0;
    for (const log of batchCancels.logs) {
      const params = decodeOrdersCanceled(log);
      const keys = cancelledOrderKeys(log.address as Address, params);

      // One key per id — never `orderId[0]`, never a deduplicated subset.
      expect(keys).toHaveLength(params.orderId.length);
      for (const [i, id] of params.orderId.entries()) {
        expect(keys[i]).toBe(orderKey(log.address as Address, id));
      }
      totalIds += params.orderId.length;
    }
    // Strictly more keys than logs, which is the whole point.
    expect(totalIds).toBeGreaterThan(batchCancels.logs.length);
  });

  it('the Cancel row records every id and the batch size', () => {
    for (const log of batchCancels.logs.slice(0, 50)) {
      const params = decodeOrdersCanceled(log);
      const row = toCancelRow(log.address as Address, params, position(log));
      expect(row.orderCount).toBe(params.orderId.length);
      expect(row.orderIds).toHaveLength(params.orderId.length);
      expect(row.orderIds).toEqual(params.orderId.map((id) => id.toString()));
    }
  });

  it('ids are kept as strings, so a JSON client cannot round a uint40', () => {
    const log = batchCancels.logs[0]!;
    const row = toCancelRow(log.address as Address, decodeOrdersCanceled(log), position(log));
    for (const id of row.orderIds) expect(typeof id).toBe('string');
  });
});

describe('array sizes actually seen on chain', () => {
  it('include batches well beyond one', () => {
    const sizes = batchCancels.logs.map((l) => decodeOrdersCanceled(l).orderId.length);
    const max = Math.max(...sizes);
    expect(max).toBeGreaterThanOrEqual(2);
    // Every entry in this fixture is a batch by construction.
    expect(Math.min(...sizes)).toBeGreaterThan(1);
  });

  it('single-id cancels still decode as an array of one', () => {
    // From the complete window, not the filtered batch fixture: the common case is one
    // id, and it is still wrapped in an array. A handler must not special-case it.
    const singles = recentSweep.logs
      .filter((l) => l.topics[0] === TOPIC0.OrdersCanceled)
      .map(decodeOrdersCanceled)
      .filter((p) => p.orderId.length === 1);

    expect(singles.length).toBeGreaterThan(0);
    for (const p of singles) expect(Array.isArray(p.orderId)).toBe(true);
  });
});

describe('owner attribution on a cancel', () => {
  it('every real cancel names an owner, and it is in `data`, not a topic', () => {
    for (const log of batchCancels.logs.slice(0, 100)) {
      const params = decodeOrdersCanceled(log);
      expect(params.owner).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(log.topics).toHaveLength(1);
    }
  });
});
