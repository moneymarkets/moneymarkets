import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Spec A2d: no fixed token list anywhere in the UI. Every screen reads the one holdings
 * model over `AccountBalances.tokens[]`. This reads the screens that used to carry a
 * hand-picked AUSD/USDC/USDT0/MON list and refuses the patterns that made one, so a
 * list cannot quietly return in a later edit.
 *
 * Allowed on purpose: `packages/core/src/chain/addresses.ts` (the address book itself,
 * the base set the registry seeds from), `app/help/page.tsx` (copy that shows contract
 * addresses), `app/api/fund/permit/route.ts` (the permit tokens, a relayer-policy gate
 * that phase 2 widens), and `lib/useAccountBalances.ts` (its fixed `wallet`/`margin`
 * records are derived views over `tokens[]`, kept for one release so older callers
 * compile; they are read from the same body, never a second list).
 */

const root = join(__dirname, '..');

const SCREENS = [
  'app/home/page.tsx',
  'app/portfolio/page.tsx',
  'app/send/SendScreen.tsx',
  'app/withdraw/WithdrawScreen.tsx',
  'app/fund/DirectDepositCard.tsx',
  'app/fund/TopUpCard.tsx',
  'app/wallet/page.tsx',
  'app/wallet/MoveSheet.tsx',
  'lib/activity.ts',
  'components/ActivityList.tsx',
];

/** A screen reaching into the legacy fixed record for a named token, or a literal list of the four. */
const FIXED_LIST_PATTERNS: readonly RegExp[] = [
  /balance\.(wallet|margin)\??\.(AUSD|USDC|USDT0|MON)\b/,
  /\['AUSD',\s*'USDC'/,
  /\[\s*'AUSD'\s*,\s*'USDC'\s*,\s*'USDT0'\s*(,\s*'MON'\s*)?\]/,
  /tokens\.(USDC|AUSD|USDT0|MON)\b.*balance/,
];

describe('no screen keeps a fixed token list (spec A2d)', () => {
  for (const file of SCREENS) {
    it(`${file} reads tokens[] through the holdings model, not a hand-picked list`, () => {
      const source = readFileSync(join(root, file), 'utf8');
      for (const pattern of FIXED_LIST_PATTERNS) {
        expect(source, `${file} matches ${pattern}`).not.toMatch(pattern);
      }
    });
  }
});
