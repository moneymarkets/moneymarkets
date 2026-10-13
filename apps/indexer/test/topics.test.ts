/**
 * The event signatures this indexer filters on must hash to the topic0 that real
 * Kuru logs actually carry.
 *
 * This is the test that catches a hallucinated ABI. A signature can be plausible,
 * compile, pass review and still be wrong — a renamed parameter is harmless but a
 * changed type, a changed order, or an `indexed` keyword all move topic0, and an
 * indexer filtering on the wrong topic0 does not error. It returns nothing, forever,
 * and looks like a quiet market.
 *
 * So topic0 is never asserted against a constant written by hand here. It is asserted
 * against logs pulled off chain 143 and committed under `fixtures/`.
 */

import { describe, expect, it } from 'vitest';
import { toEventSelector } from 'viem';
import {
  EVENT_BY_TOPIC0,
  MARKET_REGISTERED_EVENT,
  ORDERS_CANCELED_EVENT,
  ORDER_CREATED_EVENT,
  TOPIC0,
  TRADE_EVENT,
} from '../src/events.js';
import {
  ALL_FIXTURES,
  batchCancels,
  groundTruth,
  marketRegistered,
  recentSweep,
} from './fixtures.js';

describe('topic0 is derived from the ABI, not asserted from memory', () => {
  it('each constant is the hash of its own signature', () => {
    expect(TOPIC0.Trade).toBe(toEventSelector(TRADE_EVENT));
    expect(TOPIC0.OrderCreated).toBe(toEventSelector(ORDER_CREATED_EVENT));
    expect(TOPIC0.OrdersCanceled).toBe(toEventSelector(ORDERS_CANCELED_EVENT));
    expect(TOPIC0.MarketRegistered).toBe(toEventSelector(MARKET_REGISTERED_EVENT));
  });

  it('the reverse lookup covers all four', () => {
    expect(EVENT_BY_TOPIC0.size).toBe(4);
    expect(EVENT_BY_TOPIC0.get(TOPIC0.Trade)).toBe('Trade');
    expect(EVENT_BY_TOPIC0.get(TOPIC0.OrdersCanceled)).toBe('OrdersCanceled');
  });
});

describe('topic0 matches real logs from Monad mainnet', () => {
  it('every fixture really came from chain 143', () => {
    for (const [name, fixture] of Object.entries(ALL_FIXTURES)) {
      expect(fixture.chainId, name).toBe(143);
      expect(fixture.rpc, name).toContain('monad');
      expect(fixture.logs.length, name).toBeGreaterThan(0);
    }
  });

  it('OrderCreated: the real log in block 101310782 carries our topic0', () => {
    const created = groundTruth.logs.filter((l) => l.topics[0] === TOPIC0.OrderCreated);
    expect(created).toHaveLength(1);
    expect(created[0]?.blockNumber).toBe('0x609e13e'); // 101310782
  });

  it('OrdersCanceled: the real cancel in block 101310801 carries our topic0', () => {
    const cancels = groundTruth.logs.filter((l) => l.topics[0] === TOPIC0.OrdersCanceled);
    expect(cancels).toHaveLength(1);
    expect(cancels[0]?.blockNumber).toBe('0x609e151'); // 101310801
  });

  it('Trade: real trade logs in the recent window carry our topic0', () => {
    const trades = recentSweep.logs.filter((l) => l.topics[0] === TOPIC0.Trade);
    expect(trades.length).toBeGreaterThan(0);
  });

  it('MarketRegistered: the real MON_AUSD registration log carries our topic0', () => {
    expect(marketRegistered.logs).toHaveLength(1);
    expect(marketRegistered.logs[0]?.topics[0]).toBe(TOPIC0.MarketRegistered);
    // Emitted by the Router, not by the order book.
    expect(marketRegistered.logs[0]?.address.toLowerCase()).toBe(
      '0xd651346d7c789536ebf06dc72ae3c8502cd695cc',
    );
  });
});

describe('venue pitfall 1 — no Kuru event indexes anything', () => {
  it('every real log of ours carries exactly one topic', () => {
    const handled = [...groundTruth.logs, ...recentSweep.logs, ...marketRegistered.logs].filter(
      (l) => EVENT_BY_TOPIC0.has(l.topics[0] as `0x${string}`),
    );
    expect(handled.length).toBeGreaterThan(100);
    for (const log of handled) {
      // If any parameter were indexed there would be a topics[1]. There never is.
      expect(log.topics).toHaveLength(1);
    }
  });

  it('means an owner filter cannot be pushed to the node', () => {
    // The consequence, stated as a test so it cannot be forgotten: filtering by user
    // is a client-side comparison over every log in the market.
    const created = groundTruth.logs.filter((l) => l.topics[0] === TOPIC0.OrderCreated);
    expect(created[0]?.topics[1]).toBeUndefined();
  });
});

describe('events this indexer does not handle', () => {
  it('the real window contains topic0s outside our four, which must be ignored', () => {
    const unhandled = recentSweep.logs.filter(
      (l) => !EVENT_BY_TOPIC0.has(l.topics[0] as `0x${string}`),
    );
    // The live books emit more than the four events we index. The indexer must skip
    // these rather than try to decode them with the nearest-looking ABI.
    expect(unhandled.length).toBeGreaterThan(0);
    for (const log of unhandled) {
      expect(EVENT_BY_TOPIC0.get(log.topics[0] as `0x${string}`)).toBeUndefined();
    }
  });
});

describe('batch cancel fixture provenance', () => {
  it('records the population it was filtered from', () => {
    const pop = batchCancels.population as {
      cancelLogs: number;
      orderIdsCancelled: number;
      idsLostByASingularHandler: number;
    };
    expect(pop.orderIdsCancelled).toBeGreaterThan(pop.cancelLogs);
    expect(pop.idsLostByASingularHandler).toBe(pop.orderIdsCancelled - pop.cancelLogs);
  });
});
