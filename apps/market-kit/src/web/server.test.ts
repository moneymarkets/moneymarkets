import { describe, expect, it } from 'vitest';
import { argsFromForm, commandLine } from './server.js';

/**
 * The web UI is only safe if two things hold: a request can never turn into a
 * submission by itself, and the plan the page shows is the plan the CLI would build.
 * Both are properties of these two pure functions, so both are tested here.
 */

describe('the operator UI cannot send a transaction by rendering one', () => {
  it('forces --dry-run onto every request, whatever the form says', () => {
    const args = argsFromForm('seed', { market: '0xabc', 'fee-bps': '30' });
    expect(args.flags.get('dry-run')).toBe(true);
  });

  it('forces it even when the form tries to turn it off', () => {
    const args = argsFromForm('seed', { 'dry-run': 'false', market: '0xabc' });
    expect(args.flags.get('dry-run')).toBe(true);
  });

  it('drops any key that is not a flag name, so a body cannot smuggle one in', () => {
    const args = argsFromForm('seed', {
      market: '0xabc',
      'Ref-Source': 'shouty',
      __proto__: 'nope',
      'rm -rf': 'nope',
      '': 'nope',
    });
    expect([...args.flags.keys()].sort()).toEqual(['dry-run', 'market']);
  });

  it('treats the string "true" as a bare flag, the way the CLI parser does', () => {
    const args = argsFromForm('seed', { hypothetical: 'true', side: 'both' });
    expect(args.flags.get('hypothetical')).toBe(true);
    expect(args.flags.get('side')).toBe('both');
  });
});

describe('every rendered plan carries the command that reproduces it', () => {
  it('writes the flags in order and ends with --dry-run', () => {
    expect(
      commandLine('seed', { market: '0xabc', 'fee-bps': '30', 'size-per-level': '5.50' }),
    ).toBe('kit seed --market 0xabc --fee-bps 30 --size-per-level 5.50 --dry-run');
  });

  it('renders a bare flag without a value', () => {
    expect(commandLine('seed', { hypothetical: 'true' })).toBe('kit seed --hypothetical --dry-run');
  });

  it('quotes a value that would not survive a shell word split', () => {
    expect(commandLine('seed', { 'ref-source': 'AUSD/USDC book, read 2026-09-02' })).toBe(
      'kit seed --ref-source "AUSD/USDC book, read 2026-09-02" --dry-run',
    );
  });
});
