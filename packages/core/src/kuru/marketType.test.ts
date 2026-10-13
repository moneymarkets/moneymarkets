import { describe, expect, it } from 'vitest';
import {
  isNativeAsset,
  isPowerOfTen,
  MarketTypeMismatchError,
  NATIVE_ASSET,
  ORDER_BOOK_TYPE,
  orderBookTypeFor,
  orderBookTypeName,
} from './marketType.js';

const AUSD = '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a';
const USDC = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603';
const USDT0 = '0xe7cd86e13AC4309349F30B3435a9d337750fC82D';

/**
 * The enum ordering is not a guess. It comes from the verified Router implementation
 * `0x0f2a2a5c0a78c406c26adb2f1681d3e47322a9cd` on Monad mainnet, and the mapping
 * below reproduces the `_type` argument of real `deployProxy` transactions read from
 * the Router's own transaction history on 2026-09-02.
 */
describe('OrderBookType', () => {
  it('orders the enum NO_NATIVE, NATIVE_IN_BASE, NATIVE_IN_QUOTE', () => {
    expect(ORDER_BOOK_TYPE.NO_NATIVE).toBe(0);
    expect(ORDER_BOOK_TYPE.NATIVE_IN_BASE).toBe(1);
    expect(ORDER_BOOK_TYPE.NATIVE_IN_QUOTE).toBe(2);
  });

  it('names a type back', () => {
    expect(orderBookTypeName(0)).toBe('NO_NATIVE');
    expect(orderBookTypeName(1)).toBe('NATIVE_IN_BASE');
    expect(orderBookTypeName(2)).toBe('NATIVE_IN_QUOTE');
  });
});

describe('orderBookTypeFor reproduces real deployProxy calls', () => {
  const cases = [
    {
      tx: '0x8642018193e395f73e79d0f5bc357de4c735ae37baa28194565816f39ba6d57e',
      what: 'MON/AUSD, block 45440066',
      base: NATIVE_ASSET,
      quote: AUSD,
      type: 1,
    },
    {
      tx: '0x9284be16e3e3bd6f169594cc35e0e880cc8c71b201e2cf6f14ce8624e86b36d7',
      what: 'MON/USDC, block 33615323 — the Router’s first market',
      base: NATIVE_ASSET,
      quote: USDC,
      type: 1,
    },
    {
      tx: '0x4d9be94b5898cd237d92c050912c4a15bd90b3beaea9b2ce976afab1e422ec7a',
      what: 'USDC/USDT0, block 36604059',
      base: USDC,
      quote: USDT0,
      type: 0,
    },
    {
      tx: '0x12de5c3f14f5f6384f02d200c4830f6708a9e88960ace415a036cfe9dbb2e7d2',
      what: 'AUSD/USDC, block 36600715',
      base: AUSD,
      quote: USDC,
      type: 0,
    },
    {
      tx: '0xb4985dbd8e95eceb35541a8cb2b16bcd4eb4bd9db5acc6b36361681c408da4ef',
      what: 'a token quoted in native MON, block 35100563',
      base: '0x8E6e80F2Bd268Be7D37Efd15229cF8Ff00992df6',
      quote: NATIVE_ASSET,
      type: 2,
    },
  ] as const;

  for (const c of cases) {
    it(`${c.what} -> _type ${c.type} (${c.tx.slice(0, 10)}…)`, () => {
      expect(orderBookTypeFor(c.base, c.quote)).toBe(c.type);
    });
  }
});

describe('orderBookTypeFor refuses what the Router refuses', () => {
  it('rejects a pair that is native on both sides', () => {
    expect(() => orderBookTypeFor(NATIVE_ASSET, NATIVE_ASSET)).toThrow(MarketTypeMismatchError);
  });

  it('rejects base == quote, which reverts with BaseAndQuoteAssetSame()', () => {
    expect(() => orderBookTypeFor(AUSD, AUSD)).toThrow(/BaseAndQuoteAssetSame/);
    expect(() => orderBookTypeFor(AUSD.toLowerCase() as `0x${string}`, AUSD)).toThrow(
      /BaseAndQuoteAssetSame/,
    );
  });

  it('rejects a non-address', () => {
    expect(() => orderBookTypeFor('0xnope' as `0x${string}`, AUSD)).toThrow(/not an address/);
  });
});

describe('isNativeAsset', () => {
  it('is case-insensitive about the zero address', () => {
    expect(isNativeAsset(NATIVE_ASSET)).toBe(true);
    expect(isNativeAsset('0x0000000000000000000000000000000000000000')).toBe(true);
    expect(isNativeAsset(AUSD)).toBe(false);
  });
});

describe('isPowerOfTen', () => {
  it('matches the Router check 10 ** log10(x) == x', () => {
    for (const value of [1n, 10n, 100n, 1_000_000n, 100_000_000n, 10_000_000_000n]) {
      expect(isPowerOfTen(value)).toBe(true);
    }
    for (const value of [0n, -10n, 2n, 15n, 150_000_000n, 999n]) {
      expect(isPowerOfTen(value)).toBe(false);
    }
  });
});
