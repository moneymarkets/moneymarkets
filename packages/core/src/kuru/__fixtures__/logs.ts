import type { Address, Hex, Log } from 'viem';
import type { MarketParams } from '../params.js';

/**
 * Real logs, copied byte-for-byte from Monad mainnet on 2026-09-02.
 * Market: MON/USDC `0x065C9d28E428A0db40191a54d33d5b7c71a9C394`.
 *
 * MON/AUSD produced no `Trade`, `OrderCreated` or `OrdersCanceled` log in the 4,000
 * blocks before this read — which is the empty-AUSD-book thesis of
 * `docs/01-framework.md` §4.1 showing up as an absence of data.
 */

export const MON_USDC_MARKET = '0x065C9d28E428A0db40191a54d33d5b7c71a9C394' as Address;

/** From `getMarketParams()` on the market above, same read. */
export const MON_USDC_PARAMS: MarketParams = {
  pricePrecision: 100_000_000n,
  sizePrecision: 10_000_000_000n,
  baseAsset: '0x0000000000000000000000000000000000000000' as Address,
  baseDecimals: 18,
  quoteAsset: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603' as Address,
  quoteDecimals: 6,
  tickSize: 100n,
  minSize: 2_000_000_000_000n,
  maxSize: 2_000_000_000_000_000_000n,
  takerFeeBps: 0n,
  makerFeeBps: 0n,
};

type Fixture = Log<bigint, number, false>;

/**
 * tx 0x888e1e5db88c5dc09ed9090f4d8bfd18fc8e6281a6f5f6b0d48692911387383d, block
 * 101267808, logIndex 4. One topic only: the signature. Every parameter is in `data`,
 * because no Kuru event indexes anything.
 */
export const REAL_TRADE_LOG = {
  address: MON_USDC_MARKET,
  topics: ['0xf16924fba1c18c108912fcacaac7450c98eb3f2d8c0a3cdf3df7066c08f21581'] as [Hex],
  data:
    '0x00000000000000000000000000000000000000000000000000000000056792fb' +
    '00000000000000000000000034ae4d081c0d46b23ebf5292c1be4e45f8a73fc5' +
    '0000000000000000000000000000000000000000000000000000000000000001' +
    '000000000000000000000000000000000000000000000000005d2c6875e12000' +
    '000000000000000000000000000000000000000000000000000307b6a9fbec75' +
    '00000000000000000000000080c74517bcc2d67ffe02d3ed886796272f647210' +
    '000000000000000000000000f380bf747b61ced8afb949337acb23e0aa4043ec' +
    '00000000000000000000000000000000000000000000000000005b63be4c5f8b',
  blockNumber: 101_267_808n,
  transactionHash: '0x888e1e5db88c5dc09ed9090f4d8bfd18fc8e6281a6f5f6b0d48692911387383d' as Hex,
  logIndex: 4,
  transactionIndex: 0,
  blockHash: '0x'.padEnd(66, '0') as Hex,
  removed: false,
} as unknown as Fixture;

export const REAL_TRADE_EXPECTED = {
  orderId: 90_673_915n,
  maker: '0x34Ae4d081c0D46b23ebF5292c1be4e45f8a73fC5' as Address,
  taker: '0x80c74517BCC2D67fFE02D3ED886796272F647210' as Address,
  txOrigin: '0xf380bf747b61CED8AFB949337Acb23e0aa4043EC' as Address,
  isBuy: true,
  /** 0.026226 — `Trade.price` is already 1e18. */
  priceWire: 26_226_000_000_000_000n,
  updatedSize: 852_906_047_433_845n,
  filledSize: 100_483_952_566_155n,
};

/**
 * tx 0xe11256e36207463c3f63601a773a48f40c8de72ee54ea1f2da73ec33bba2a952, block
 * 101267748, logIndex 31.
 *
 * `price` here is 2621900 — the market's `pricePrecision` (1e8), i.e. 0.026219 — not
 * the 1e18 scale `Trade` uses sixty blocks later for essentially the same price. The
 * two scales sit in the same market, in the same minute.
 */
export const REAL_ORDER_CREATED_LOG = {
  address: MON_USDC_MARKET,
  topics: ['0xb81bbaf150467ef3096ed6220cb963abc169bffd2eb88f26c47359ef344cf94c'] as [Hex],
  data:
    '0x0000000000000000000000000000000000000000000000000000000005679307' +
    '00000000000000000000000034ae4d081c0d46b23ebf5292c1be4e45f8a73fc5' +
    '0000000000000000000000000000000000000000000000000002b5b096a9c000' +
    '00000000000000000000000000000000000000000000000000000000002801cc' +
    '0000000000000000000000000000000000000000000000000000000000000001',
  blockNumber: 101_267_748n,
  transactionHash: '0xe11256e36207463c3f63601a773a48f40c8de72ee54ea1f2da73ec33bba2a952' as Hex,
  logIndex: 31,
  transactionIndex: 0,
  blockHash: '0x'.padEnd(66, '0') as Hex,
  removed: false,
} as unknown as Fixture;

export const REAL_ORDER_CREATED_EXPECTED = {
  orderId: 90_673_927n,
  owner: '0x34Ae4d081c0D46b23ebF5292c1be4e45f8a73fC5' as Address,
  size: 762_720_000_000_000n,
  priceRaw: 2_621_900n,
  priceWire: 26_219_000_000_000_000n,
  isBuy: true,
};

/**
 * Same transaction, logIndex 34. One event, an array of ids — `OrdersCanceled` is
 * plural even when a single order is cancelled.
 */
export const REAL_ORDERS_CANCELED_LOG = {
  address: MON_USDC_MARKET,
  topics: ['0x386974f41b61738b510019ccd5a3524a43eccf0d136929e09d524e87aeeca2c4'] as [Hex],
  data:
    '0x0000000000000000000000000000000000000000000000000000000000000040' +
    '00000000000000000000000034ae4d081c0d46b23ebf5292c1be4e45f8a73fc5' +
    '0000000000000000000000000000000000000000000000000000000000000001' +
    '0000000000000000000000000000000000000000000000000000000005679307',
  blockNumber: 101_267_748n,
  transactionHash: '0xe11256e36207463c3f63601a773a48f40c8de72ee54ea1f2da73ec33bba2a952' as Hex,
  logIndex: 34,
  transactionIndex: 0,
  blockHash: '0x'.padEnd(66, '0') as Hex,
  removed: false,
} as unknown as Fixture;
