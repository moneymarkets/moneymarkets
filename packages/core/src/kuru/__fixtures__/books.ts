import type { Address } from 'viem';
import type { MarketParams } from '../params.js';

/**
 * Fixtures are recorded observations, never invented numbers.
 * Each one names where it came from.
 */

/**
 * MON/AUSD market params, read live from
 * `0x131a2e70a5b31a517a74b8c567149bc294470da9`.`getMarketParams()` on Monad mainnet
 * (chain 143) at 2026-09-02. Raw tuple:
 *   [100000000, 10000000000, 0x0000…0000, 18, 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a, 6,
 *    100, 2000000000000, 20000000000000000000, 0, 0]
 */
export const MON_AUSD_PARAMS: MarketParams = {
  pricePrecision: 100_000_000n,
  sizePrecision: 10_000_000_000n,
  baseAsset: '0x0000000000000000000000000000000000000000' as Address,
  baseDecimals: 18,
  quoteAsset: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a' as Address,
  quoteDecimals: 6,
  tickSize: 100n,
  minSize: 2_000_000_000_000n,
  maxSize: 20_000_000_000_000_000_000n,
  takerFeeBps: 0n,
  makerFeeBps: 0n,
};

export const MON_AUSD_MARKET = '0x131a2e70a5b31a517a74b8c567149bc294470da9' as Address;

/**
 * `bestBidAsk()` on the same market and the same read: bestBid 0.025952,
 * bestAsk 0.026473, both already 1e18-scaled on the wire. This is the evidence that
 * `bestBidAsk` returns the wire scale and not `pricePrecision` units.
 */
export const MON_AUSD_BEST_BID = 25_952_000_000_000_000n;
export const MON_AUSD_BEST_ASK = 26_473_000_000_000_000n;

/**
 * The crossed book observed on the `MON_AUSD_V4_5` pseudo-symbol feed: a bid of
 * 0.0291 above an ask of 0.0041, produced by stale vault levels
 * (`docs/01-framework.md` §4.1, "Market data for the app"). Pseudo-symbol feeds
 * report human decimals, which is why the source enum matters here.
 *
 * Invariant I1 must mark this INVALID. A UI that renders it shows a user a 600%
 * arbitrage that does not exist and a ticket that will revert.
 */
export const MON_AUSD_V4_5_CROSSED = {
  source: 'pseudo-symbol-human' as const,
  bids: [
    { price: '0.0291', size: '1000' },
    { price: '0.0290', size: '2000' },
  ],
  asks: [
    { price: '0.0041', size: '1500' },
    { price: '0.0042', size: '2500' },
  ],
};

/**
 * A `@monadDepth` frame shape. `s` is the market ADDRESS, not a symbol
 * (framework §4.1, error 4): routing this by symbol sends MON/AUSD depth into a
 * MON/USDC book.
 */
export const MONAD_DEPTH_FRAME = {
  s: '0x131a2e70a5b31a517a74b8c567149bc294470da9',
  state: 'finalized',
  // 1e18 prices, sizePrecision (1e10) sizes
  bids: [
    ['25952000000000000', '150000000000'],
    ['25900000000000000', '90000000000'],
  ],
  asks: [
    ['26473000000000000', '120000000000'],
    ['26500000000000000', '80000000000'],
  ],
};

/**
 * The same levels as they arrive from the SDK's `asks` accessor, which sorts
 * DESCENDING — `asks[0]` is the WORST ask (framework §4.1, error 1). Normalization
 * must produce the identical book from either ordering.
 */
export const SDK_DESCENDING_ASKS = [
  { price: 26_500_000_000_000_000n, size: 80_000_000_000n },
  { price: 26_473_000_000_000_000n, size: 120_000_000_000n },
];
