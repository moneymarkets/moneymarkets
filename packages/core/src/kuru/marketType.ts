import { isAddress, type Address } from 'viem';

/**
 * `Router.deployProxy(_type, …)` — DECISIONS.md open item 5, closed 2026-09-02.
 *
 * `_type` is `IOrderBook.OrderBookType`, a `uint8` enum whose ordering comes from the
 * verified Router implementation on Monad mainnet
 * (`0x0f2a2a5c0a78c406c26adb2f1681d3e47322a9cd`, the ERC-1967 implementation behind
 * Router `0xd651346d7c789536ebf06dc72aE3C8502cd695CC`, fetched from Etherscan V2
 * `getsourcecode` chainid 143, `contracts/interfaces/IOrderBook.sol`):
 *
 *     enum OrderBookType { NO_NATIVE, NATIVE_IN_BASE, NATIVE_IN_QUOTE }
 *
 * It is not a free choice. `Router.deployProxy` requires it to agree with which side
 * is the zero address (`contracts/Router.sol`, the first statement of the function):
 *
 *     NATIVE_IN_BASE  -> base == address(0) && quote != address(0)
 *     NATIVE_IN_QUOTE -> base != address(0) && quote == address(0)
 *     NO_NATIVE       -> both non-zero and distinct
 *
 * Anything else reverts with `MarketTypeMismatch()`. So the type is a *function* of
 * the pair, which is why this module derives it instead of taking it as an argument.
 *
 * Confirmed against every `deployProxy` call the Router has ever received: 38 calls
 * across its whole history (Etherscan V2 `account/txlist`, chainid 143, read
 * 2026-09-02), and the correlation is exact — every `_type == 1` call passes
 * `base == 0x0`, every `_type == 2` passes `quote == 0x0`, every `_type == 0` passes
 * two real tokens. MON/AUSD itself was created by
 * `0x8642018193e395f73e79d0f5bc357de4c735ae37baa28194565816f39ba6d57e` (block
 * 45440066) with `_type = 1`.
 */
export const ORDER_BOOK_TYPE = {
  NO_NATIVE: 0,
  NATIVE_IN_BASE: 1,
  NATIVE_IN_QUOTE: 2,
} as const;

export type OrderBookTypeName = keyof typeof ORDER_BOOK_TYPE;
export type OrderBookType = (typeof ORDER_BOOK_TYPE)[OrderBookTypeName];

/** The one address Kuru uses to mean "native MON" on both sides of a market. */
export const NATIVE_ASSET: Address = '0x0000000000000000000000000000000000000000';

export function isNativeAsset(asset: Address): boolean {
  return asset.toLowerCase() === NATIVE_ASSET;
}

export class MarketTypeMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarketTypeMismatchError';
  }
}

/**
 * The only `_type` `Router.deployProxy` will accept for this pair.
 *
 * Throws for the two pairs the Router itself refuses — both sides native, and base
 * equal to quote — so a deploy fails here with a sentence rather than on chain with a
 * four-byte selector.
 */
export function orderBookTypeFor(base: Address, quote: Address): OrderBookType {
  if (!isAddress(base)) throw new MarketTypeMismatchError(`base asset ${base} is not an address`);
  if (!isAddress(quote))
    throw new MarketTypeMismatchError(`quote asset ${quote} is not an address`);
  const baseNative = isNativeAsset(base);
  const quoteNative = isNativeAsset(quote);
  if (baseNative && quoteNative) {
    throw new MarketTypeMismatchError(
      'both base and quote are the native asset; Router.deployProxy has no type for that',
    );
  }
  if (baseNative) return ORDER_BOOK_TYPE.NATIVE_IN_BASE;
  if (quoteNative) return ORDER_BOOK_TYPE.NATIVE_IN_QUOTE;
  if (base.toLowerCase() === quote.toLowerCase()) {
    throw new MarketTypeMismatchError(
      'base and quote are the same token; Router.deployProxy reverts with BaseAndQuoteAssetSame()',
    );
  }
  return ORDER_BOOK_TYPE.NO_NATIVE;
}

export function orderBookTypeName(type: OrderBookType): OrderBookTypeName {
  const hit = (Object.keys(ORDER_BOOK_TYPE) as OrderBookTypeName[]).find(
    (k) => ORDER_BOOK_TYPE[k] === type,
  );
  if (!hit) throw new MarketTypeMismatchError(`${type} is not an OrderBookType`);
  return hit;
}

/**
 * `Router.deployProxy` requires both precisions to be exact powers of ten
 * (`10 ** Math.log10(x) == x`) and the tick to be non-zero. Checked here so a typo
 * costs a line of output instead of a reverted mainnet transaction.
 */
export function isPowerOfTen(value: bigint): boolean {
  if (value <= 0n) return false;
  let v = value;
  while (v % 10n === 0n) v /= 10n;
  return v === 1n;
}
