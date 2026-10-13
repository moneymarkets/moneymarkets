/**
 * `Router.MarketRegistered`, decoded from the real log emitted when MON_AUSD was
 * registered (block 45,440,066).
 *
 * Twelve parameters, none indexed, and the order is load-bearing: `market` is the
 * third address, not the first. Getting the order wrong would silently write the base
 * asset's address as the order book's id, and the indexer would then follow a token
 * contract expecting order events. The test checks against values that are known
 * independently — MON_AUSD's own address, AUSD's address, and the precisions read
 * from `getMarketParams()`.
 */

import { describe, expect, it } from 'vitest';
import { TOPIC0 } from '../src/events.js';
import { big, toMarketRow } from '../src/normalize.js';
import { seedMarketFor } from '../src/markets.js';
import { decodeMarketRegistered, marketRegistered } from './fixtures.js';

const log = marketRegistered.logs[0]!;
const params = decodeMarketRegistered(log);

const MON_AUSD = '0x131a2e70a5b31a517a74b8c567149bc294470da9';
const AUSD = '0x00000000efe302beaa2b3e6e1b18d08d69a9012a';
const NATIVE_MON = '0x0000000000000000000000000000000000000000';

describe('the real MarketRegistered log', () => {
  it('is a Router log with our topic0 and no indexed params', () => {
    expect(log.topics[0]).toBe(TOPIC0.MarketRegistered);
    expect(log.topics).toHaveLength(1);
    expect(log.address.toLowerCase()).toBe('0xd651346d7c789536ebf06dc72ae3c8502cd695cc');
  });

  it('carries exactly twelve 32-byte words of data', () => {
    const words = (log.data.length - 2) / 64;
    expect(words).toBe(12);
  });
});

describe('parameter order is right', () => {
  it('resolves `market` to the MON_AUSD order book, not to a token', () => {
    // The independent check: this address is the one the rest of the repo already
    // knows as MON_AUSD, and the one the fixture was fetched from.
    expect(params.market.toLowerCase()).toBe(MON_AUSD);
  });

  it('resolves base to native MON and quote to AUSD', () => {
    expect(params.baseAsset.toLowerCase()).toBe(NATIVE_MON);
    expect(params.quoteAsset.toLowerCase()).toBe(AUSD);
  });

  it('the three addresses are distinct, so the fields are not aliased', () => {
    const distinct = new Set([
      params.baseAsset.toLowerCase(),
      params.quoteAsset.toLowerCase(),
      params.market.toLowerCase(),
    ]);
    expect(distinct.size).toBe(3);
  });
});

describe('the event agrees with getMarketParams()', () => {
  it('reports the same precisions the chain read produced', () => {
    const seed = seedMarketFor(MON_AUSD)!;
    // The event was emitted in block 45,440,066; the seed was read at 101,341,988.
    // They agree, which is the evidence that MarketRegistered is a usable source of
    // scales and the seed table is not papering over a mismatch.
    // `big()` throughout: `pricePrecision` and `tickSize` are uint32, which viem
    // returns as `number`, while the uint96 sizes come back as `bigint`.
    expect(big(params.pricePrecision)).toBe(seed.pricePrecision);
    expect(big(params.sizePrecision)).toBe(seed.sizePrecision);
    expect(big(params.tickSize)).toBe(seed.tickSize);
    expect(big(params.minSize)).toBe(seed.minSize);
    expect(big(params.maxSize)).toBe(seed.maxSize);
  });

  it('has the 1e8 pricePrecision the MON books use', () => {
    expect(big(params.pricePrecision)).toBe(100_000_000n);
  });

  it('reports zero fees, as the live read did', () => {
    expect(big(params.takerFeeBps)).toBe(0n);
    expect(big(params.makerFeeBps)).toBe(0n);
  });
});

describe('the Market row', () => {
  it('is keyed on the order book address, lowercased', () => {
    const row = toMarketRow(params, { blockNumber: Number(BigInt(log.blockNumber)) });
    expect(row.id).toBe(MON_AUSD);
    expect(row.registeredBlock).toBe(45_440_066);
  });

  it('keeps every scale as a bigint', () => {
    const row = toMarketRow(params, { blockNumber: Number(BigInt(log.blockNumber)) });
    for (const key of [
      'pricePrecision',
      'sizePrecision',
      'tickSize',
      'minSize',
      'maxSize',
    ] as const) {
      expect(typeof row[key]).toBe('bigint');
    }
  });

  it('records the vault address the Router assigned', () => {
    const row = toMarketRow(params, { blockNumber: Number(BigInt(log.blockNumber)) });
    expect(row.vault).toMatch(/^0x[0-9a-f]{40}$/);
  });
});
