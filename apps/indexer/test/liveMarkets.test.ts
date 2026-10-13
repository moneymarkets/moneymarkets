/**
 * Re-read `getMarketParams()` from the live chain and fail if the seed table in
 * `src/markets.ts` has drifted.
 *
 * The seed table is the indexer's fallback source of `pricePrecision`, so a stale row
 * there mis-scales every price on that market — silently, and in a direction nothing
 * else would catch. This test is how the table stays honest.
 *
 * It is opt-in because it needs the network, and a test that hits a public RPC on
 * every `pnpm test` is a test that fails for reasons that have nothing to do with the
 * code. `pnpm test` stays hermetic against the committed fixtures, which are
 * themselves real logs. Run the live check with:
 *
 *     INDEXER_LIVE_CHECK=1 pnpm --filter @tradepro/indexer test
 *
 * It is read-only: `eth_call` only, no key, no transaction, no mainnet write path.
 */

import { describe, expect, it } from 'vitest';
import { createPublicClient, http } from 'viem';
import { decodeMarketParams, monad, orderBookAbi } from '@tradepro/core';
import { SEED_MARKETS, SEED_READ } from '../src/markets.js';

const LIVE = process.env.INDEXER_LIVE_CHECK === '1';
const RPC = process.env.RPC_URL_MONAD_MAINNET ?? SEED_READ.rpc;

describe.runIf(LIVE)('seed table still matches the chain', () => {
  const client = createPublicClient({ chain: monad, transport: http(RPC) });

  it('is reading chain 143', async () => {
    expect(await client.getChainId()).toBe(SEED_READ.chainId);
  });

  for (const seed of SEED_MARKETS) {
    it(`${seed.symbol} params are unchanged`, async () => {
      const tuple = await client.readContract({
        address: seed.address,
        abi: orderBookAbi,
        functionName: 'getMarketParams',
      });
      const live = decodeMarketParams(tuple as never);

      expect(live.pricePrecision, `${seed.symbol} pricePrecision`).toBe(seed.pricePrecision);
      expect(live.sizePrecision, `${seed.symbol} sizePrecision`).toBe(seed.sizePrecision);
      expect(live.quoteDecimals, `${seed.symbol} quoteDecimals`).toBe(seed.quoteDecimals);
      expect(live.baseDecimals, `${seed.symbol} baseDecimals`).toBe(seed.baseDecimals);
      expect(live.baseAsset.toLowerCase()).toBe(seed.baseAsset.toLowerCase());
      expect(live.quoteAsset.toLowerCase()).toBe(seed.quoteAsset.toLowerCase());
      expect(live.tickSize, `${seed.symbol} tickSize`).toBe(seed.tickSize);
      expect(live.minSize, `${seed.symbol} minSize`).toBe(seed.minSize);
      expect(live.maxSize, `${seed.symbol} maxSize`).toBe(seed.maxSize);
    }, 30_000);
  }

  it('the books really do disagree about pricePrecision', async () => {
    // Not a tautology over the constants: this asserts the live chain still has a
    // market whose scale differs from the MON books, which is why the table is
    // per-market and not one shared constant.
    const precisions = new Set<bigint>();
    for (const seed of SEED_MARKETS) {
      const tuple = await client.readContract({
        address: seed.address,
        abi: orderBookAbi,
        functionName: 'getMarketParams',
      });
      precisions.add(decodeMarketParams(tuple as never).pricePrecision);
    }
    expect(precisions.size).toBeGreaterThan(1);
  }, 60_000);
});

describe('seed table shape', () => {
  it('records where its numbers came from', () => {
    expect(SEED_READ.chainId).toBe(143);
    expect(SEED_READ.blockNumber).toBeGreaterThan(101_000_000n);
    expect(SEED_READ.rpc).toContain('monad');
  });

  it('has no duplicate addresses', () => {
    const addresses = SEED_MARKETS.map((m) => m.address.toLowerCase());
    expect(new Set(addresses).size).toBe(addresses.length);
  });

  it('has a positive scale for every market', () => {
    for (const m of SEED_MARKETS) {
      expect(m.pricePrecision, m.symbol).toBeGreaterThan(0n);
      expect(m.sizePrecision, m.symbol).toBeGreaterThan(0n);
      expect(m.tickSize, m.symbol).toBeGreaterThan(0n);
      expect(m.minSize, m.symbol).toBeLessThanOrEqual(m.maxSize);
    }
  });
});
