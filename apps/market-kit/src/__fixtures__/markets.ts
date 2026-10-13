import type { MarketParams } from '@tradepro/core';

/**
 * Real market parameters, read from Monad mainnet and pasted verbatim — not invented.
 *
 * MON/AUSD `0x131A2e70A5b31a517A74b8c567149bc294470Da9`, `getMarketParams()` at block
 * 101315410 (2026-09-02):
 *
 *   [100000000, 10000000000, 0x0000…0000, 18, 0x0000…9012a, 6,
 *    100, 2000000000000, 20000000000000000000, 0, 0]
 *
 * and `bestBidAsk()` in the same block:
 *
 *   [25442000000000000, 25952000000000000]     (0.025442 / 0.025952)
 */
export const MON_AUSD: MarketParams = {
  pricePrecision: 100_000_000n,
  sizePrecision: 10_000_000_000n,
  baseAsset: '0x0000000000000000000000000000000000000000',
  baseDecimals: 18,
  quoteAsset: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a',
  quoteDecimals: 6,
  tickSize: 100n,
  minSize: 2_000_000_000_000n,
  maxSize: 20_000_000_000_000_000_000n,
  takerFeeBps: 0n,
  makerFeeBps: 0n,
};

export const MON_AUSD_MARKET = '0x131A2e70A5b31a517A74b8c567149bc294470Da9' as const;
export const MON_AUSD_BEST_BID_WIRE = 25_442_000_000_000_000n;
export const MON_AUSD_BEST_ASK_WIRE = 25_952_000_000_000_000n;

/**
 * A hypothetical USDT0/AUSD, on the parameter scheme `kit deploy` copies from
 * MON/AUSD: same pricePrecision, tick, fees and AMM spread, with the size scale and
 * min/max chosen for a six-decimal, ~$1 base.
 *
 * USDT0 `0xe7cd86e13AC4309349F30B3435a9d337750fC82D` (6 decimals) and AUSD
 * `0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a` (6 decimals) are both live mainnet
 * tokens; the market itself does not exist. `Router.computeAddress` says this
 * parameter set would deploy to `0x572426e654DaFf7Ce15a3475dCE02bF5DAB4E80F`, which
 * has no code (read 2026-09-02).
 */
export const USDT0_AUSD: MarketParams = {
  pricePrecision: 100_000_000n,
  sizePrecision: 1_000_000n,
  baseAsset: '0xe7cd86e13AC4309349F30B3435a9d337750fC82D',
  baseDecimals: 6,
  quoteAsset: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a',
  quoteDecimals: 6,
  tickSize: 100n,
  minSize: 1_000_000n,
  maxSize: 1_000_000_000_000n,
  takerFeeBps: 0n,
  makerFeeBps: 0n,
};
