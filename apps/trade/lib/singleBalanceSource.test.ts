import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Item 2c's rule, enforced: `apps/trade/app/api/account/balances/route.ts` is the
 * only place a Monad account balance is read for display. Four different reads once
 * disagreeing about the same wallet is what made the Move card vanish while real
 * USDC sat there, and a screen quietly growing a fifth read is how that comes back.
 *
 * Every other hit below is a real, narrower exception, not a display source:
 *   - `api/account/route.ts` backs `useSettlement.ts`'s baseline-vs-current margin
 *     comparison, which this route's flat "current value" shape cannot express.
 *   - `api/fund/permit/route.ts` reads a balance to bound a permit's signed amount
 *     at sign time — a security check right before a signature, not a rendered
 *     number.
 *   - `api/fund/oft/route.ts` and `lib/server/deposits/chains.ts` read balances on
 *     *other* chains (Base, the refund chain) that this route has no way to answer.
 *   - `lib/server/deposits/watcher.ts` reads the margin balance once, at registration,
 *     as step 5's "before" snapshot (`margin_balance_before`) -- the same narrow,
 *     one-time-at-registration shape `chains.ts`'s `sourceBalance` already has for a
 *     refund's "before", not a rendered figure.
 *
 * This scans source text for the two call shapes those routes use
 * (`functionName: 'balanceOf'` / `'getBalance'`) rather than importing modules,
 * so it catches a new call site being added without needing it to be reachable.
 */

const ROOT = join(__dirname, '..');

const ALLOWED = new Set([
  'app/api/account/balances/route.ts',
  'app/api/account/route.ts',
  'app/api/fund/permit/route.ts',
  'app/api/fund/oft/route.ts',
  'lib/server/deposits/chains.ts',
  'lib/server/deposits/watcher.ts',
  'lib/useSettlement.ts',
]);

const SKIP_DIRS = new Set(['node_modules', '.next', '.next-bp', '.next-build', '.turbo']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) walk(full, out);
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith('.test.ts') && !entry.endsWith('.test.tsx')) {
      out.push(full);
    }
  }
  return out;
}

describe('one balance source (item 2c)', () => {
  it('finds a balance-shaped contract call only in the allowed files', () => {
    const offenders: string[] = [];
    for (const dir of ['app', 'lib', 'components']) {
      for (const file of walk(join(ROOT, dir))) {
        const rel = relative(ROOT, file).replace(/\\/g, '/');
        if (ALLOWED.has(rel)) continue;
        const text = readFileSync(file, 'utf8');
        if (/functionName:\s*['"](balanceOf|getBalance)['"]/.test(text)) {
          offenders.push(rel);
        }
      }
    }
    expect(offenders, offenders.join(', ')).toEqual([]);
  }, 30_000);

  it('the allowlist itself still exists — a moved or renamed file must update this test, not silently pass', () => {
    for (const rel of ALLOWED) {
      expect(() => statSync(join(ROOT, rel)), rel).not.toThrow();
    }
  });
});
