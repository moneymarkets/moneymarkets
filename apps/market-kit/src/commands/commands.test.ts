import { describe, expect, it } from 'vitest';
import { ORDER_BOOK_TYPE, orderBookTypeFor, orderBookTypeName } from '@tradepro/core';
import { ArgError } from '../args.js';
import { assertDeployParams, toSizePrecisionUnits, DEFAULT_PRESET_MARKET } from './deploy.js';
import { chunk, parseOrderIds } from './teardown.js';
import { MON_AUSD, USDT0_AUSD } from '../__fixtures__/markets.js';

describe('assertDeployParams', () => {
  const ok = {
    pricePrecision: 100_000_000n,
    sizePrecision: 10_000_000_000n,
    tickSize: 100n,
    minSize: 1_000_000n,
    maxSize: 1_000_000_000_000n,
  };

  it('accepts the MON/AUSD scheme', () => {
    expect(() => assertDeployParams(ok)).not.toThrow();
  });

  it('rejects a precision that is not a power of ten', () => {
    // Router.deployProxy: require(10 ** Math.log10(x) == x)
    expect(() => assertDeployParams({ ...ok, pricePrecision: 150_000_000n })).toThrow(
      /InvalidPricePrecision/,
    );
    expect(() => assertDeployParams({ ...ok, sizePrecision: 3n })).toThrow(/InvalidSizePrecision/);
  });

  it('rejects a zero tick', () => {
    expect(() => assertDeployParams({ ...ok, tickSize: 0n })).toThrow(/InvalidTickSize/);
  });

  it('rejects a tick coarser than the whole price precision', () => {
    expect(() => assertDeployParams({ ...ok, tickSize: 100_000_001n })).toThrow(/larger than/);
  });

  it('rejects an inverted or zero size range', () => {
    expect(() => assertDeployParams({ ...ok, minSize: 0n })).toThrow(ArgError);
    expect(() => assertDeployParams({ ...ok, minSize: 2n, maxSize: 1n })).toThrow(/above/);
  });
});

describe('toSizePrecisionUnits', () => {
  it('converts human base units to sizePrecision units', () => {
    // 200 MON at sizePrecision 1e10 is MON/AUSD's real minSize.
    expect(toSizePrecisionUnits('200', 18, MON_AUSD.sizePrecision)).toBe(MON_AUSD.minSize);
    // 1 USDT0 at sizePrecision 1e6.
    expect(toSizePrecisionUnits('1', 6, USDT0_AUSD.sizePrecision)).toBe(1_000_000n);
  });

  it('is the reason min/max are not copied from a preset', () => {
    // The same *number* means 12 orders of magnitude apart on the two bases.
    const asMon = toSizePrecisionUnits('200', 18, 10_000_000_000n);
    const asUsdt0 = toSizePrecisionUnits('200', 6, 1_000_000n);
    expect(asMon).toBe(2_000_000_000_000n);
    expect(asUsdt0).toBe(200_000_000n);
  });
});

describe('deployProxy._type (DECISIONS.md open item 5)', () => {
  it('is 1 / NATIVE_IN_BASE when the base is address(0), as MON/AUSD was deployed', () => {
    const type = orderBookTypeFor(MON_AUSD.baseAsset, MON_AUSD.quoteAsset);
    expect(type).toBe(ORDER_BOOK_TYPE.NATIVE_IN_BASE);
    expect(type).toBe(1);
    expect(orderBookTypeName(type)).toBe('NATIVE_IN_BASE');
  });

  it('is 0 / NO_NATIVE for a two-token pair such as USDT0/AUSD', () => {
    const type = orderBookTypeFor(USDT0_AUSD.baseAsset, USDT0_AUSD.quoteAsset);
    expect(type).toBe(ORDER_BOOK_TYPE.NO_NATIVE);
    expect(type).toBe(0);
  });

  it('is 2 / NATIVE_IN_QUOTE when the quote is address(0)', () => {
    expect(
      orderBookTypeFor(USDT0_AUSD.baseAsset, '0x0000000000000000000000000000000000000000'),
    ).toBe(ORDER_BOOK_TYPE.NATIVE_IN_QUOTE);
  });

  it('refuses the two pairs the Router itself refuses', () => {
    expect(() =>
      orderBookTypeFor(
        '0x0000000000000000000000000000000000000000',
        '0x0000000000000000000000000000000000000000',
      ),
    ).toThrow(/no type for that/);
    expect(() => orderBookTypeFor(USDT0_AUSD.baseAsset, USDT0_AUSD.baseAsset)).toThrow(
      /BaseAndQuoteAssetSame/,
    );
  });
});

describe('the default preset market', () => {
  it('is MON/AUSD, the market whose params the docs tell us to copy', () => {
    expect(DEFAULT_PRESET_MARKET).toBe('0x131A2e70A5b31a517A74b8c567149bc294470Da9');
  });
});

describe('teardown helpers', () => {
  it('parses a comma-separated order id list', () => {
    expect(parseOrderIds('1,2, 3')).toEqual([1n, 2n, 3n]);
    expect(parseOrderIds(undefined)).toBeUndefined();
  });

  it('rejects a non-numeric id, an empty list and a uint40 overflow', () => {
    expect(() => parseOrderIds('1,x')).toThrow(ArgError);
    expect(() => parseOrderIds(' , ')).toThrow(/empty/);
    expect(() => parseOrderIds('1099511627776')).toThrow(/uint40/);
    expect(parseOrderIds('1099511627775')).toEqual([1_099_511_627_775n]);
  });

  it('chunks a cancel list into batches', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 2)).toEqual([]);
    expect(chunk([1], 50)).toEqual([[1]]);
  });
});
