import { getAddress, isAddress, type Address } from 'viem';
import { parseUnits } from '@tradepro/core';

/**
 * Argument parsing, kept pure and separate from every command so it can be tested
 * without a chain. No `any`, no coercion by `Number()` on anything monetary: a value
 * that represents money is parsed straight into `bigint` by `core`'s `parseUnits`.
 */

export class ArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArgError';
  }
}

export type FlagValue = string | true;

export interface ParsedArgs {
  readonly command: string;
  readonly flags: ReadonlyMap<string, FlagValue>;
  readonly positional: readonly string[];
}

/**
 * `--flag value`, `--flag=value` and bare `--flag` (which becomes `true`). A repeated
 * flag is an error rather than a last-one-wins surprise.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command, ...rest] = argv;
  if (!command || command.startsWith('-')) {
    throw new ArgError('no command given. Try: kit help');
  }
  const flags = new Map<string, FlagValue>();
  const positional: string[] = [];

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]!;
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf('=');
    const name = eq === -1 ? body : body.slice(0, eq);
    if (name.length === 0) throw new ArgError(`${token} is not a flag`);
    if (flags.has(name)) throw new ArgError(`--${name} was given twice`);
    if (eq !== -1) {
      flags.set(name, body.slice(eq + 1));
      continue;
    }
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags.set(name, true);
    } else {
      flags.set(name, next);
      i += 1;
    }
  }
  return { command, flags, positional };
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  if (value === undefined) return undefined;
  if (value === true) throw new ArgError(`--${name} needs a value`);
  return value;
}

export function requireString(args: ParsedArgs, name: string): string {
  const value = flagString(args, name);
  if (value === undefined) throw new ArgError(`--${name} is required`);
  return value;
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  const value = args.flags.get(name);
  if (value === undefined) return false;
  if (value === true) return true;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ArgError(`--${name} takes no value, or true/false; got ${JSON.stringify(value)}`);
}

export function flagAddress(args: ParsedArgs, name: string): Address | undefined {
  const value = flagString(args, name);
  if (value === undefined) return undefined;
  if (!isAddress(value)) throw new ArgError(`--${name} ${value} is not an address`);
  return getAddress(value);
}

export function requireAddress(args: ParsedArgs, name: string): Address {
  const value = flagAddress(args, name);
  if (value === undefined) throw new ArgError(`--${name} is required`);
  return value;
}

export function flagInt(args: ParsedArgs, name: string): number | undefined {
  const value = flagString(args, name);
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new ArgError(`--${name} must be a non-negative integer`);
  return Number(value);
}

/** A whole number, as `bigint`. Used for bps, precisions and tick sizes. */
export function flagBigInt(args: ParsedArgs, name: string): bigint | undefined {
  const value = flagString(args, name);
  if (value === undefined) return undefined;
  return parseIntegerLiteral(value, name);
}

export function requireBigInt(args: ParsedArgs, name: string): bigint {
  const value = flagBigInt(args, name);
  if (value === undefined) throw new ArgError(`--${name} is required`);
  return value;
}

/**
 * Accept `100000000`, `1e8` and `1_000_000`. `1e8` is the notation the spec's own CLI
 * examples use for precisions, and expanding it here keeps it out of float land.
 */
export function parseIntegerLiteral(text: string, name: string): bigint {
  const cleaned = text.replaceAll('_', '').trim();
  const exponential = /^(\d+)e(\d+)$/i.exec(cleaned);
  if (exponential) {
    return BigInt(exponential[1]!) * 10n ** BigInt(exponential[2]!);
  }
  if (!/^\d+$/.test(cleaned)) {
    throw new ArgError(`--${name} ${JSON.stringify(text)} is not a whole number`);
  }
  return BigInt(cleaned);
}

/** A human decimal amount in a token's own units, e.g. `--size-per-level 25.5`. */
export function flagAmount(args: ParsedArgs, name: string, decimals: number): bigint | undefined {
  const value = flagString(args, name);
  if (value === undefined) return undefined;
  try {
    return parseUnits(value, decimals);
  } catch (error) {
    throw new ArgError(
      `--${name} ${JSON.stringify(value)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function requireAmount(args: ParsedArgs, name: string, decimals: number): bigint {
  const value = flagAmount(args, name, decimals);
  if (value === undefined) throw new ArgError(`--${name} is required`);
  return value;
}

/** A price given in human units, converted to the 1e18 wire scale `bestBidAsk` uses. */
export function flagPriceWire(args: ParsedArgs, name: string): bigint | undefined {
  const value = flagString(args, name);
  if (value === undefined) return undefined;
  try {
    return parseUnits(value, 18);
  } catch (error) {
    throw new ArgError(
      `--${name} ${JSON.stringify(value)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function unknownFlags(args: ParsedArgs, known: readonly string[]): string[] {
  const allowed = new Set(known);
  return [...args.flags.keys()].filter((k) => !allowed.has(k));
}

export function assertKnownFlags(args: ParsedArgs, known: readonly string[]): void {
  const unknown = unknownFlags(args, known);
  if (unknown.length > 0) {
    throw new ArgError(
      `unknown flag${unknown.length > 1 ? 's' : ''}: ${unknown.map((f) => `--${f}`).join(', ')}. ` +
        `Known: ${known.map((f) => `--${f}`).join(', ')}`,
    );
  }
}
