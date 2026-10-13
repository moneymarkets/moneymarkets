import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * B2d / G1: "Delete the exempt-scope refusal behaviour and every remaining
 * gas-refusal string in the codebase" — "no gas-refusal string exists in the
 * codebase". The user is never told an action is unavailable, gated, or waiting on
 * a review: every lane either works or falls through to the next (own MON, then
 * the trading balance, then the one sentence with two live choices).
 *
 * A grep-level guard, like `noFixedTokenLists.test.ts`: the phrases below are the
 * exact copy the old gates used, and none of them may reappear in this app's
 * source. Test files are excluded — several of them assert these phrases are GONE.
 */

const FORBIDDEN = [
  'pending a security review',
  'not sponsored yet',
  'gas-policy update',
  'available yet',
  'refused under sustained load',
  // v2.1 spec 3.1/3.2: no gas limitation sentence anywhere, ever.
  'gasless account',
  'NOT_GASLESS_SAFE',
] as const;

const ROOT = join(__dirname, '..');
const SCAN_DIRS = ['app', 'components', 'lib'];

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* sourceFiles(full);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      yield full;
    }
  }
}

describe('no gas-refusal string exists in the codebase (G1)', () => {
  it.each(FORBIDDEN)('no source file says %j', (phrase) => {
    const offenders: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of sourceFiles(join(ROOT, dir))) {
        if (readFileSync(file, 'utf8').includes(phrase)) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
    // 30 s: a full source walk is deterministic but slow under a parallel
    // workspace run's disk contention (seen 11 s on 2026-09-26).
  }, 30_000);
});
