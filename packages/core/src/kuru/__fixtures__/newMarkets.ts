import type { Address } from 'viem';
import type { MarketParams } from '../params.js';
import { MON_USDC_MARKET, MON_USDC_PARAMS } from './logs.js';

export { MON_USDC_MARKET, MON_USDC_PARAMS };

/**
 * `getMarketParams()` tuple for MON/USDC, built from the already-verified
 * `MON_USDC_PARAMS` fixture in `./logs.js` (same address, same read) rather than
 * retyped, so there is no second copy of these numbers that could drift from it.
 */
export const MON_USDC_TUPLE = [
  Number(MON_USDC_PARAMS.pricePrecision),
  MON_USDC_PARAMS.sizePrecision,
  MON_USDC_PARAMS.baseAsset,
  BigInt(MON_USDC_PARAMS.baseDecimals),
  MON_USDC_PARAMS.quoteAsset,
  BigInt(MON_USDC_PARAMS.quoteDecimals),
  Number(MON_USDC_PARAMS.tickSize),
  MON_USDC_PARAMS.minSize,
  MON_USDC_PARAMS.maxSize,
  MON_USDC_PARAMS.takerFeeBps,
  MON_USDC_PARAMS.makerFeeBps,
] as const;

/**
 * Five markets newly added to the live allowlist, verified live on Monad mainnet
 * (chain 143) via `getMarketParams()`, `bestBidAsk()`, `eth_call` and `getL2Book()`.
 * Source: `reports/MARKETS-VERIFIED.md`, sender `0x714f169Fe2D3990961B534D573f9646c037586E6`,
 * blocks 107,251,915 - 107,251,985 (params/action matrix) and 107,252,190 (emo/MON L2
 * depth). Every number below is copied from that report; none is invented.
 *
 * MON/USDC's params are not repeated here: they are the exact market already fixtured
 * as `MON_USDC_PARAMS` / `MON_USDC_MARKET` in `./logs.ts` (same address
 * `0x065C9d28E428A0db40191a54d33d5b7c71a9C394`, same pp/sp/tick/min/max/fees), which
 * this report's MON/USDC row confirms byte-for-byte.
 */

/* ────────────────────────────────── WETH/USDC ──────────────────────────────────── */

export const WETH_USDC_MARKET: Address = '0xa6aFD386135B7D41A6C40C525abC4A1019b0D132';
export const USDC_ADDRESS: Address = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603';
export const WETH_ADDRESS: Address = '0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242';

/** `getMarketParams()` tuple, exactly as the contract returns it. */
export const WETH_USDC_TUPLE = [
  10_000, // pricePrecision
  10_000_000_000n, // sizePrecision
  WETH_ADDRESS, // baseAsset
  18n, // baseDecimals
  USDC_ADDRESS, // quoteAsset
  6n, // quoteDecimals
  100, // tickSize
  20_000_000n, // minSize
  1_000_000_000_000_000_000n, // maxSize
  0n, // takerFeeBps
  0n, // makerFeeBps
] as const;

export const WETH_USDC_PARAMS: MarketParams = {
  pricePrecision: 10_000n,
  sizePrecision: 10_000_000_000n,
  baseAsset: WETH_ADDRESS,
  baseDecimals: 18,
  quoteAsset: USDC_ADDRESS,
  quoteDecimals: 6,
  tickSize: 100n,
  minSize: 20_000_000n,
  maxSize: 1_000_000_000_000_000_000n,
  takerFeeBps: 0n,
  makerFeeBps: 0n,
};

/** bestBidAsk 2758.03 / 2759.08 at read time (report §2). */
export const WETH_USDC_BEST_BID_WIRE = 2_758_030_000_000_000_000_000n;
export const WETH_USDC_BEST_ASK_WIRE = 2_759_080_000_000_000_000_000n;

/* ────────────────────────────────── cbBTC/USDC ─────────────────────────────────── */

export const CBBTC_USDC_MARKET: Address = '0x40c49F171202F91ff5d2faE34c22dD2BFdD22aF0';
export const CBBTC_ADDRESS: Address = '0xd18B7EC58Cdf4876f6AFebd3Ed1730e4Ce10414b';

export const CBBTC_USDC_TUPLE = [
  10_000,
  100_000_000n,
  CBBTC_ADDRESS,
  8n,
  USDC_ADDRESS,
  6n,
  100,
  12_500n,
  10_000_000_000n,
  0n,
  0n,
] as const;

export const CBBTC_USDC_PARAMS: MarketParams = {
  pricePrecision: 10_000n,
  sizePrecision: 100_000_000n,
  baseAsset: CBBTC_ADDRESS,
  baseDecimals: 8,
  quoteAsset: USDC_ADDRESS,
  quoteDecimals: 6,
  tickSize: 100n,
  minSize: 12_500n,
  maxSize: 10_000_000_000n,
  takerFeeBps: 0n,
  makerFeeBps: 0n,
};

/** bestBidAsk 86495.71 / 86530.32 at read time (report §2). */
export const CBBTC_USDC_BEST_BID_WIRE = 86_495_710_000_000_000_000_000n;
export const CBBTC_USDC_BEST_ASK_WIRE = 86_530_320_000_000_000_000_000n;

/* ────────────────────────────────── XAUt0/USDC ─────────────────────────────────── */

export const XAUT0_USDC_MARKET: Address = '0x851145eaeFdc37956B08dA829fa31722199F3f07';
export const XAUT0_ADDRESS: Address = '0x01bFF41798a0BcF287b996046Ca68b395DbC1071';

export const XAUT0_USDC_TUPLE = [
  10_000,
  1_000_000n,
  XAUT0_ADDRESS,
  6n,
  USDC_ADDRESS,
  6n,
  100,
  2_000n,
  100_000_000n,
  0n,
  0n,
] as const;

export const XAUT0_USDC_PARAMS: MarketParams = {
  pricePrecision: 10_000n,
  sizePrecision: 1_000_000n,
  baseAsset: XAUT0_ADDRESS,
  baseDecimals: 6,
  quoteAsset: USDC_ADDRESS,
  quoteDecimals: 6,
  tickSize: 100n,
  minSize: 2_000n,
  maxSize: 100_000_000n,
  takerFeeBps: 0n,
  makerFeeBps: 0n,
};

/** bestBidAsk 4333.88 / 4336.01 at read time (report §2). */
export const XAUT0_USDC_BEST_BID_WIRE = 4_333_880_000_000_000_000_000n;
export const XAUT0_USDC_BEST_ASK_WIRE = 4_336_010_000_000_000_000_000n;

/* ─────────────────────────────────── emo/MON ───────────────────────────────────── */

export const EMO_MON_MARKET: Address = '0xe7A4f90369b48d8F5B61f2FD519eC563c11e4B2d';
export const EMO_ADDRESS: Address = '0x81A224F8A62f52BdE942dBF23A56df77A10b7777';
export const NATIVE_MON: Address = '0x0000000000000000000000000000000000000000';

/**
 * The registry reports a wrapped (mod 2^64) `maxSize` for this market:
 * `1553255926290448384`. The chain's own `getMarketParams()` returns
 * `20000000000000000000`, and `20000000000000000000 - 2**64 === 1553255926290448384`
 * exactly (report §1, finding #5). The chain value is used here.
 */
export const EMO_MON_TUPLE = [
  100_000,
  100_000_000_000n,
  EMO_ADDRESS,
  18n,
  NATIVE_MON,
  18n,
  10,
  20_000_000_000_000n,
  20_000_000_000_000_000_000n, // chain value, not the registry's wrapped one
  2n,
  2n,
] as const;

export const EMO_MON_PARAMS: MarketParams = {
  pricePrecision: 100_000n,
  sizePrecision: 100_000_000_000n,
  baseAsset: EMO_ADDRESS,
  baseDecimals: 18,
  quoteAsset: NATIVE_MON,
  quoteDecimals: 18,
  tickSize: 10n,
  minSize: 20_000_000_000_000n,
  maxSize: 20_000_000_000_000_000_000n,
  takerFeeBps: 2n,
  makerFeeBps: 2n,
};

/**
 * emo/MON has **no ask**: `bestBidAsk()` returned a real bid and the "no ask"
 * sentinel (report §2 heading, §1 row). `bestBid` 0.031 is dust — one unit of
 * `sizePrecision`, i.e. 1e-11 emo — and the first real bid is 0.025 MON for 80,000
 * emo (`getL2Book()` at block 107,252,190, report §2 "emo/MON" section).
 */
export const EMO_MON_BEST_BID_WIRE = 31_000_000_000_000_000n; // 0.031 * 1e18
export const EMO_MON_NO_ASK = 0n; // bestBidAsk()'s "no ask" sentinel, already folded

/* ───────────────────── the afternoon re-read, for the cap valuation ───────────────────── */

/**
 * Read fresh on chain 143 on 2026-09-23 from block 107,310,276 (11:33:11Z) to 107,310,284
 * (11:33:14Z), for the change that values MON-quoted orders in dollars. Read-only
 * `eth_call`s against `https://rpc.monad.xyz`; the script and its full output are
 * summarised in `reports/MARKETS-VERIFIED.md` section 6.
 *
 * `getMarketParams()` on emo/MON and MON/USDC returned exactly `EMO_MON_TUPLE` and
 * `MON_USDC_TUPLE` again: no drift since the morning read. emo/MON still has no ask, the
 * same 0.031 dust bid and the same eight bid levels, and `s_orderIdCounter()` is still
 * 26,028, so nothing has been placed on it since.
 */
export const PM_READ_BLOCK = 107_310_277n;

/** MON/USDC `bestBidAsk()` raw at block 107,310,277: 0.025853 / 0.025869 USDC per MON. */
export const MON_USDC_PM_BEST_BID_WIRE = 25_853_000_000_000_000n;
export const MON_USDC_PM_BEST_ASK_WIRE = 25_869_000_000_000_000n;
/** Their mid, 0.025861 USDC per MON: the price the cap values one MON at. */
export const MON_USDC_PM_MID_WIRE = 25_861_000_000_000_000n;

/** emo/MON `bestBidAsk()` raw at the same read: `[0.031e18, 0]`, the bid and "no ask". */
export const EMO_MON_PM_BEST_BID_WIRE = 31_000_000_000_000_000n;
export const EMO_MON_PM_ORDER_ID_COUNTER = 26_028n;

/**
 * The owner's address and its balances at block 107,310,277. `MarginAccount.getBalance`
 * for native MON (`0x0`), USDC and emo, plus the wallet's own. Margin USDC is 5,200 base
 * units lower than the morning's 3,298,695; margin MON is unchanged.
 */
export const OWNER = '0x714f169Fe2D3990961B534D573f9646c037586E6' as const;
export const OWNER_PM_BALANCES = {
  marginMonWei: 3_732_318_142_700_000_000n,
  marginUsdc: 3_293_495n,
  marginEmo: 0n,
  walletMonWei: 8_000_000_000_000_000_000n,
  walletUsdc: 0n,
  walletEmo: 0n,
} as const;

/**
 * The emo/MON action matrix from the owner's address at block 107,310,277, `eth_call`
 * only, calldata from this repo's own builders (market orders `isMargin = true`):
 *
 *   - limit buy, 200 emo at the 0.031 best bid (price 3100, size 20000000000000):
 *     reverted `0xf4d678b8` InsufficientBalance. It costs 6.2 MON; margin holds 3.7323.
 *   - limit sell, 200 emo at 0.0311, one tick over the bid since there is no ask (price
 *     3110): reverted InsufficientBalance. The owner holds no emo.
 *   - market buy, 1 MON (quoteSize 100000): succeeded and returned 0. No asks to buy.
 *   - market sell, 200 emo (size 20000000000000): reverted InsufficientBalance.
 *   - cancel of id 26029, never issued: reverted `0xa0cdd781` OnlyOwnerAllowedError.
 *   - zero sender, `isMargin = false`: a 1 MON buy returned 0, and a 200 emo sell returned
 *     4998990002000000000 (4.998990002 MON), the same as the morning.
 */
export const EMO_MON_PM_MATRIX = {
  limitBuyMin: { price: 3_100n, size: 20_000_000_000_000n, revert: '0xf4d678b8' },
  limitSellMin: { price: 3_110n, size: 20_000_000_000_000n, revert: '0xf4d678b8' },
  marketBuy1Mon: { quoteSize: 100_000n, amountOut: 0n },
  marketSellMin: { size: 20_000_000_000_000n, revert: '0xf4d678b8' },
  cancelMissing: { id: 26_029n, revert: '0xa0cdd781' },
  zeroSenderSellMin: { size: 20_000_000_000_000n, amountOut: 4_998_990_002_000_000_000n },
} as const;

/* ──────────────────────────────── the action matrix ────────────────────────────── */

/**
 * `eth_call` results from `reports/MARKETS-VERIFIED.md` §2, sender
 * `0x714f169Fe2D3990961B534D573f9646c037586E6`, blocks 107,251,957-985. Every market
 * answered the same 1-USDC (or 1-MON, for emo) market buy at its own scale — this is
 * the evidence a scale error of any power of ten would show.
 */
export const ACTION_MATRIX = {
  wethUsdc: {
    /** market buy, quoteSize 10000 (1 USDC) -> 0.0003624396 WETH */
    marketBuy1Usdc: { quoteSize: 10_000n, amountOut: 362_439_600_000_000n },
    /** zero-sender market sell of minSize (0.002 WETH) -> 5.5167 USDC */
    marketSellMinSize: { size: 20_000_000n, amountOut: 5_516_700n },
  },
  cbbtcUsdc: {
    /** market buy, quoteSize 10000 (1 USDC) -> 1155 sats (0.00001155 cbBTC) */
    marketBuy1Usdc: { quoteSize: 10_000n, amountOut: 1_155n },
    /** zero-sender market sell of minSize (0.000125 cbBTC) -> 10.8119 USDC */
    marketSellMinSize: { size: 12_500n, amountOut: 10_811_900n },
  },
  xaut0Usdc: {
    /** market buy, quoteSize 10000 (1 USDC) -> 230 (0.000230 XAUt0) */
    marketBuy1Usdc: { quoteSize: 10_000n, amountOut: 230n },
    /** zero-sender market sell of minSize (0.002 XAUt0) -> 8.6677 USDC */
    marketSellMinSize: { size: 2_000n, amountOut: 8_667_700n },
  },
  monUsdc: {
    /** market buy, quoteSize 100000000 (1 USDC) -> 37.4434 MON */
    marketBuy1Usdc: { quoteSize: 100_000_000n, amountOut: 37_443_366_907_500_000_000n },
    /** zero-sender market sell of minSize (200 MON) -> 5.3382 USDC */
    marketSellMinSize: { size: 2_000_000_000_000n, amountOut: 5_338_200n },
  },
  emoMon: {
    /**
     * market buy, quoteSize 100000 (1 MON) -> **0, no revert**. There are no asks,
     * so the call fills nothing (report §2 "emo/MON" section, and §5 finding #2).
     */
    marketBuy1Mon: { quoteSize: 100_000n, amountOut: 0n },
    /** zero-sender market sell of minSize (200 emo) -> 4.998990002 MON */
    marketSellMinSize: { size: 20_000_000_000_000n, amountOut: 4_998_990_002_000_000_000n },
  },
} as const;

/**
 * minSize in base units, and what it is worth today, from report §1's "Minimum
 * resting size" table. cbBTC and XAUt0 sit above `MAX_ORDER_NOTIONAL_AUSD` ($6).
 */
export const MIN_SIZE_WORTH = {
  monUsdc: { minSizeBase: 200_000_000_000_000_000_000n, worthQuote: 5_338_200n }, // 5.3382 USDC
  wethUsdc: { minSizeBase: 2_000_000_000_000_000n, worthQuote: 5_516_700n }, // 5.5167 USDC
  cbbtcUsdc: { minSizeBase: 12_500n, worthQuote: 10_811_900n }, // 10.8119 USDC
  xaut0Usdc: { minSizeBase: 2_000n, worthQuote: 8_667_700n }, // 8.6677 USDC
  emoMon: { minSizeBase: 200_000_000_000_000_000_000n, worthQuote: 4_998_990_002_000_000_000n }, // 4.998990002 MON
} as const;

/**
 * `OnlyOwnerAllowedError` (`0xa0cdd781`) on a cancel of an order id that does not
 * exist — `s_orderIdCounter() + 1`, chosen so it certainly was never issued — measured
 * on all six books tested (report §2, and again in §5 "What the matrix proves"). Not
 * `OrderAlreadyFilledOrCancelled` (`0x829f7240`).
 */
export const CANCEL_MISSING_ORDER_SELECTOR = '0xa0cdd781' as const;
