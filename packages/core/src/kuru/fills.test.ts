import { describe, expect, it } from 'vitest';
import { toEventSelector } from 'viem';
import {
  attributeFills,
  decodeOrderCreated,
  decodeOrdersCanceled,
  decodeTrade,
  fillQuoteValue,
  ORDERS_CANCELED_EVENT,
  ORDER_CREATED_EVENT,
  TRADE_EVENT,
} from './fills.js';
import {
  MON_USDC_PARAMS,
  REAL_ORDERS_CANCELED_LOG,
  REAL_ORDER_CREATED_EXPECTED,
  REAL_ORDER_CREATED_LOG,
  REAL_TRADE_EXPECTED,
  REAL_TRADE_LOG,
} from './__fixtures__/logs.js';
import type { Address } from 'viem';

describe('no Kuru event indexes anything (venue pitfall 3)', () => {
  it('leaves only the signature in topics', () => {
    for (const log of [REAL_TRADE_LOG, REAL_ORDER_CREATED_LOG, REAL_ORDERS_CANCELED_LOG]) {
      expect(log.topics).toHaveLength(1);
    }
  });

  it('has the topic0 the ABI predicts', () => {
    expect(REAL_TRADE_LOG.topics[0]).toBe(toEventSelector(TRADE_EVENT));
    expect(REAL_ORDER_CREATED_LOG.topics[0]).toBe(toEventSelector(ORDER_CREATED_EVENT));
    expect(REAL_ORDERS_CANCELED_LOG.topics[0]).toBe(toEventSelector(ORDERS_CANCELED_EVENT));
  });

  it('means a node-side filter by user is impossible', () => {
    // If `owner` were indexed it would be topics[1]. It is not, so every log for the
    // market has to be fetched and compared client-side.
    expect(REAL_ORDER_CREATED_LOG.topics[1]).toBeUndefined();
  });
});

describe('decoding real logs', () => {
  it('decodes a real Trade', () => {
    const fill = decodeTrade(REAL_TRADE_LOG);
    expect(fill.orderId).toBe(REAL_TRADE_EXPECTED.orderId);
    expect(fill.maker).toBe(REAL_TRADE_EXPECTED.maker);
    expect(fill.taker).toBe(REAL_TRADE_EXPECTED.taker);
    expect(fill.txOrigin).toBe(REAL_TRADE_EXPECTED.txOrigin);
    expect(fill.isBuy).toBe(true);
    expect(fill.priceWire).toBe(REAL_TRADE_EXPECTED.priceWire);
    expect(fill.filledSize).toBe(REAL_TRADE_EXPECTED.filledSize);
    expect(fill.updatedSize).toBe(REAL_TRADE_EXPECTED.updatedSize);
    expect(fill.txHash).toBe(REAL_TRADE_LOG.transactionHash);
  });

  it('decodes a real OrderCreated and lifts its price to the wire scale', () => {
    const created = decodeOrderCreated(REAL_ORDER_CREATED_LOG, MON_USDC_PARAMS);
    expect(created.orderId).toBe(REAL_ORDER_CREATED_EXPECTED.orderId);
    expect(created.owner).toBe(REAL_ORDER_CREATED_EXPECTED.owner);
    expect(created.priceRaw).toBe(REAL_ORDER_CREATED_EXPECTED.priceRaw);
    expect(created.priceWire).toBe(REAL_ORDER_CREATED_EXPECTED.priceWire);
    expect(created.size).toBe(REAL_ORDER_CREATED_EXPECTED.size);
  });

  it('decodes OrdersCanceled as an array even for one id', () => {
    const cancel = decodeOrdersCanceled(REAL_ORDERS_CANCELED_LOG);
    expect(Array.isArray(cancel.orderIds)).toBe(true);
    expect(cancel.orderIds).toEqual([90_673_927n]);
    expect(cancel.owner).toBe(REAL_ORDER_CREATED_EXPECTED.owner);
  });
});

describe('the two price scales in one market', () => {
  it('reads Trade.price as 1e18 and OrderCreated.price as pricePrecision', () => {
    const fill = decodeTrade(REAL_TRADE_LOG);
    const created = decodeOrderCreated(REAL_ORDER_CREATED_LOG, MON_USDC_PARAMS);
    // Both around 0.0262 once normalized, sixty blocks apart on the same market.
    expect(fill.priceWire).toBe(26_226_000_000_000_000n);
    expect(created.priceWire).toBe(26_219_000_000_000_000n);
    // Reading OrderCreated.price as if it were already 1e18 understates it by
    // exactly pricePrecision-to-1e18, a factor of 1e10.
    expect(created.priceWire).toBe(created.priceRaw * 10n ** 10n);
    expect(created.priceWire / created.priceRaw).toBe(10_000_000_000n);
  });
});

describe('attribution under ERC-2771', () => {
  const fill = decodeTrade(REAL_TRADE_LOG);

  it('matches the maker', () => {
    const out = attributeFills([fill], REAL_TRADE_EXPECTED.maker);
    expect(out).toHaveLength(1);
    expect(out[0]?.role).toBe('maker');
  });

  it('matches the taker', () => {
    const out = attributeFills([fill], REAL_TRADE_EXPECTED.taker);
    expect(out).toHaveLength(1);
    expect(out[0]?.role).toBe('taker');
  });

  it('is case-insensitive about the address', () => {
    const lower = REAL_TRADE_EXPECTED.taker.toLowerCase() as Address;
    expect(attributeFills([fill], lower)).toHaveLength(1);
  });

  it('does NOT attribute by txOrigin', () => {
    // On a forwarded fill `txOrigin` is the relayer. Attributing by it would hand
    // every user's fills to the relayer, and the relayer's to whoever looked.
    expect(fill.txOrigin).not.toBe(fill.maker);
    expect(fill.txOrigin).not.toBe(fill.taker);
    expect(attributeFills([fill], REAL_TRADE_EXPECTED.txOrigin)).toHaveLength(0);
  });

  it('ignores a stranger', () => {
    expect(
      attributeFills([fill], '0x1111111111111111111111111111111111111111' as Address),
    ).toHaveLength(0);
  });
});

describe('fill value', () => {
  it('prices a real fill in quote base units', () => {
    const fill = decodeTrade(REAL_TRADE_LOG);
    // 100483952566155 sizePrecision units / 1e10 = 10048.395 MON at 0.026226
    // = 263.53 USDC, i.e. 263_528_... in 6-decimal base units.
    const value = fillQuoteValue(fill, MON_USDC_PARAMS);
    expect(value).toBeGreaterThan(263_000_000n);
    expect(value).toBeLessThan(264_000_000n);
  });
});
