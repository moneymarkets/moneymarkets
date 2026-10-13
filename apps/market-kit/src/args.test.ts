import { describe, expect, it } from 'vitest';
import {
  ArgError,
  assertKnownFlags,
  flagAmount,
  flagBool,
  flagInt,
  flagPriceWire,
  flagString,
  parseArgs,
  parseIntegerLiteral,
  requireAddress,
  requireAmount,
  requireBigInt,
  unknownFlags,
} from './args.js';

const parse = (line: string) => parseArgs(line.split(' ').filter((t) => t.length > 0));

describe('parseArgs', () => {
  it('reads --flag value, --flag=value and bare --flag', () => {
    const args = parse('seed --market 0xabc --band=0.98..1.02 --dry-run');
    expect(args.command).toBe('seed');
    expect(args.flags.get('market')).toBe('0xabc');
    expect(args.flags.get('band')).toBe('0.98..1.02');
    expect(args.flags.get('dry-run')).toBe(true);
  });

  it('treats a following --flag as the end of the previous flag', () => {
    const args = parse('seed --dry-run --levels 6');
    expect(args.flags.get('dry-run')).toBe(true);
    expect(args.flags.get('levels')).toBe('6');
  });

  it('refuses a repeated flag rather than silently taking the last', () => {
    expect(() => parse('seed --levels 6 --levels 8')).toThrow(/given twice/);
  });

  it('refuses a missing command', () => {
    expect(() => parseArgs([])).toThrow(ArgError);
    expect(() => parseArgs(['--help'])).toThrow(ArgError);
  });

  it('collects positional arguments', () => {
    expect(parse('status 0xabc --scan 10').positional).toEqual(['0xabc']);
  });
});

describe('flag accessors', () => {
  it('flagString refuses a valueless flag that needs a value', () => {
    expect(() => flagString(parse('seed --band'), 'band')).toThrow(/needs a value/);
  });

  it('flagBool accepts bare, true and false', () => {
    expect(flagBool(parse('seed --dry-run'), 'dry-run')).toBe(true);
    expect(flagBool(parse('seed --dry-run=true'), 'dry-run')).toBe(true);
    expect(flagBool(parse('seed --dry-run=false'), 'dry-run')).toBe(false);
    expect(flagBool(parse('seed'), 'dry-run')).toBe(false);
    expect(() => flagBool(parse('seed --dry-run=yes'), 'dry-run')).toThrow(ArgError);
  });

  it('flagInt rejects anything but a non-negative integer', () => {
    expect(flagInt(parse('seed --levels 12'), 'levels')).toBe(12);
    expect(() => flagInt(parse('seed --levels 1.5'), 'levels')).toThrow(ArgError);
    expect(() => flagInt(parse('seed --levels -1'), 'levels')).toThrow(ArgError);
  });

  it('requireAddress checksums and rejects non-addresses', () => {
    const args = parse('seed --market 0x131a2e70a5b31a517a74b8c567149bc294470da9');
    expect(requireAddress(args, 'market')).toBe('0x131A2e70A5b31a517A74b8c567149bc294470Da9');
    expect(() => requireAddress(parse('seed --market 0x00'), 'market')).toThrow(ArgError);
    expect(() => requireAddress(parse('seed'), 'market')).toThrow(/required/);
  });
});

describe('parseIntegerLiteral', () => {
  it('accepts plain digits, underscores and 1e8 notation', () => {
    expect(parseIntegerLiteral('100000000', 'x')).toBe(100_000_000n);
    expect(parseIntegerLiteral('1_000_000', 'x')).toBe(1_000_000n);
    expect(parseIntegerLiteral('1e8', 'x')).toBe(100_000_000n);
    expect(parseIntegerLiteral('1E10', 'x')).toBe(10_000_000_000n);
    expect(parseIntegerLiteral('5e3', 'x')).toBe(5000n);
  });

  it('never goes through a float, so a large exponent is exact', () => {
    expect(parseIntegerLiteral('1e30', 'x')).toBe(10n ** 30n);
    expect(parseIntegerLiteral('1e30', 'x').toString()).toBe(`1${'0'.repeat(30)}`);
  });

  it('rejects decimals and negatives', () => {
    expect(() => parseIntegerLiteral('1.5', 'x')).toThrow(ArgError);
    expect(() => parseIntegerLiteral('-1', 'x')).toThrow(ArgError);
    expect(() => parseIntegerLiteral('1e-8', 'x')).toThrow(ArgError);
  });

  it('is what requireBigInt uses', () => {
    expect(requireBigInt(parse('deploy --price-precision 1e8'), 'price-precision')).toBe(
      100_000_000n,
    );
  });
});

describe('amount flags', () => {
  it('parses a human decimal into base units at the token decimals', () => {
    expect(flagAmount(parse('seed --size-per-level 20'), 'size-per-level', 6)).toBe(20_000_000n);
    expect(flagAmount(parse('seed --size-per-level 20.5'), 'size-per-level', 6)).toBe(20_500_000n);
    expect(flagAmount(parse('seed --size-per-level 0.000001'), 'size-per-level', 6)).toBe(1n);
  });

  it('refuses more decimal places than the token has', () => {
    expect(() =>
      requireAmount(parse('seed --size-per-level 0.0000001'), 'size-per-level', 6),
    ).toThrow(/decimal places/);
  });

  it('parses --ref onto the 1e18 wire scale bestBidAsk uses', () => {
    expect(flagPriceWire(parse('seed --ref 1.0'), 'ref')).toBe(10n ** 18n);
    expect(flagPriceWire(parse('seed --ref 0.025442'), 'ref')).toBe(25_442_000_000_000_000n);
    expect(flagPriceWire(parse('seed'), 'ref')).toBeUndefined();
  });
});

describe('unknown flags', () => {
  it('lists them', () => {
    expect(unknownFlags(parse('seed --market 0x1 --nope 2'), ['market'])).toEqual(['nope']);
  });

  it('assertKnownFlags throws with the known list', () => {
    expect(() => assertKnownFlags(parse('seed --typo 1'), ['market', 'band'])).toThrow(
      /unknown flag: --typo/,
    );
    expect(() => assertKnownFlags(parse('seed --market 0x1'), ['market'])).not.toThrow();
  });
});
