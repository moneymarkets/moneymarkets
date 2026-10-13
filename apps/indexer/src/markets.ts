/**
 * Seed scales for the order books that were already live before this indexer existed.
 *
 * The indexer's proper source for a market's `pricePrecision` is
 * `Router.MarketRegistered`. That event fired for MON_AUSD in block **45,440,066**,
 * and the chain is past 101,000,000. Indexing every order book from 45M forward to
 * collect four registration events is not a reasonable trade, and any later
 * `start_block` means those registrations are never seen — so the four known books are
 * seeded here and `MarketRegistered` handles everything registered from now on.
 *
 * Rule A2.5: none of these numbers was typed from memory. Every row is the decoded
 * return of `getMarketParams()` read live from `https://rpc.monad.xyz` (chain 143) at
 * block **101,341,988** on **2026-09-02**. Reproduce with:
 *
 *     pnpm --filter @tradepro/indexer exec tsx scripts/read-market-params.ts
 *
 * `test/markets.test.ts` re-reads the chain and fails if any row has drifted, so a
 * stale seed cannot sit here unnoticed.
 *
 * **WBTC_AUSD is why this table is per-market rather than one constant.** Its
 * `pricePrecision` is 1e4 while the three MON/AUSD/USDC books are 1e8. A single
 * hardcoded 1e8 would misprice every WBTC order by a factor of 10,000.
 */

import type { Address } from 'viem';
import type { MarketScales } from './normalize.js';

export interface SeedMarket extends MarketScales {
  readonly symbol: string;
  readonly address: Address;
  readonly baseAsset: Address;
  readonly baseDecimals: number;
  readonly quoteAsset: Address;
  readonly tickSize: bigint;
  readonly minSize: bigint;
  readonly maxSize: bigint;
}

/** Provenance for the values below, asserted in tests rather than only claimed. */
export const SEED_READ = {
  rpc: 'https://rpc.monad.xyz',
  chainId: 143,
  blockNumber: 101_341_988n,
  readAt: '2026-09-02',
} as const;

export const SEED_MARKETS: readonly SeedMarket[] = [
  {
    symbol: 'MON_AUSD',
    address: '0x131A2e70A5b31a517A74b8c567149bc294470Da9',
    pricePrecision: 100_000_000n,
    sizePrecision: 10_000_000_000n,
    baseAsset: '0x0000000000000000000000000000000000000000',
    baseDecimals: 18,
    quoteAsset: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a',
    quoteDecimals: 6,
    tickSize: 100n,
    minSize: 2_000_000_000_000n,
    maxSize: 20_000_000_000_000_000_000n,
  },
  {
    symbol: 'MON_USDC',
    address: '0x065C9d28E428A0db40191a54d33d5b7c71a9C394',
    pricePrecision: 100_000_000n,
    sizePrecision: 10_000_000_000n,
    baseAsset: '0x0000000000000000000000000000000000000000',
    baseDecimals: 18,
    quoteAsset: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603',
    quoteDecimals: 6,
    tickSize: 100n,
    minSize: 2_000_000_000_000n,
    maxSize: 2_000_000_000_000_000_000n,
  },
  {
    symbol: 'AUSD_USDC',
    address: '0x699AbC15308156E9a3AB89Ec7387e9CfE1c86A3b',
    pricePrecision: 100_000_000n,
    sizePrecision: 1_000_000n,
    baseAsset: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a',
    baseDecimals: 6,
    quoteAsset: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603',
    quoteDecimals: 6,
    tickSize: 100n,
    minSize: 10_000_000n,
    maxSize: 10_000_000_000_000n,
  },
  {
    // pricePrecision 1e4, not 1e8. See the file header.
    symbol: 'WBTC_AUSD',
    address: '0xbDC776284Bf593981b1F0237F053A7Ad11Eb596F',
    pricePrecision: 10_000n,
    sizePrecision: 100_000_000n,
    baseAsset: '0x0555E30da8f98308EdB960aa94C0Db47230d2B9c',
    baseDecimals: 8,
    quoteAsset: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a',
    quoteDecimals: 6,
    tickSize: 10_000n,
    minSize: 10_000n,
    maxSize: 10_000_000_000n,
  },
];

const BY_ADDRESS: ReadonlyMap<string, SeedMarket> = new Map(
  SEED_MARKETS.map((m) => [m.address.toLowerCase(), m]),
);

export function seedMarketFor(market: string): SeedMarket | undefined {
  return BY_ADDRESS.get(market.toLowerCase());
}

/** The addresses `config.yaml` lists statically. Kept in one place so they agree. */
export const SEED_MARKET_ADDRESSES: readonly Address[] = SEED_MARKETS.map((m) => m.address);
