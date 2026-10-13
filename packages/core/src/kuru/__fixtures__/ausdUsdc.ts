import type { Address } from 'viem';
import type { MarketParams } from '../params.js';

/**
 * Kuru's AUSD/USDC order book, read live from Monad mainnet on 2026-09-02.
 *
 * `getMarketParams()` on `0x699AbC15308156E9a3AB89Ec7387e9CfE1c86A3b` at block
 * 101352461 returned the 11-tuple
 *
 *   [100000000, 1000000,
 *    0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a, 6,
 *    0x754704Bc059F8C67012fEd69BC8A327a5aafb603, 6,
 *    100, 10000000, 10000000000000, 0, 0]
 *
 * **AUSD is index 2, the base asset. USDC is index 4, the quote asset.** Every test
 * that asserts a conversion direction asserts it against this reading, so the day the
 * venue changes the pair the tests fail rather than the money moving the wrong way.
 */
export const AUSD_USDC_ADDRESS: Address = '0x699AbC15308156E9a3AB89Ec7387e9CfE1c86A3b';
export const AUSD_USDC_BLOCK = 101_352_461n;

export const AUSD_USDC_PARAMS: MarketParams = {
  pricePrecision: 100_000_000n,
  sizePrecision: 1_000_000n,
  baseAsset: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a',
  baseDecimals: 6,
  quoteAsset: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603',
  quoteDecimals: 6,
  tickSize: 100n,
  minSize: 10_000_000n,
  maxSize: 10_000_000_000_000n,
  takerFeeBps: 0n,
  makerFeeBps: 0n,
};

/** `bestBidAsk()` at that block, 1e18-scaled: 1.000147 / 1.000149. */
export const AUSD_USDC_BEST_BID_WIRE = 1_000_147_000_000_000_000n;
export const AUSD_USDC_BEST_ASK_WIRE = 1_000_149_000_000_000_000n;

/**
 * The zero-sender quotes taken at block 101352729, the same way `quoteConversion()`
 * takes them: `eth_call` from `address(0)`, which the verified OrderBook answers by
 * matching against live depth and returning the credit without writing anything.
 *
 * These are the numbers the direction argument rests on: spending USDC yields AUSD
 * only on the buy side.
 */
export const AUSD_USDC_MEASURED = {
  block: 101_352_729n,
  /** `placeAndExecuteMarketBuy`: USDC in (base units) -> AUSD out (base units). */
  buy: [
    { amountIn: 1_000_000n, out: 999_851n },
    { amountIn: 5_000_000n, out: 4_999_255n },
    { amountIn: 100_000_000n, out: 99_985_102n },
  ],
  /** `placeAndExecuteMarketSell`: AUSD in -> USDC out. */
  sell: [
    { amountIn: 1_000_000n, out: 1_000_148n },
    { amountIn: 5_000_000n, out: 5_000_740n },
    { amountIn: 100_000_000n, out: 100_014_800n },
  ],
} as const;
