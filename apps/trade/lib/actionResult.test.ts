import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ITEM 4: one confirmation component, six call sites.
 *
 * The design system's ticket state machine ended at CONFIRMED and never said what the
 * user then sees, so every screen grew its own ending. This asserts the replacement
 * actually reached every screen that completes an action — a static check, because the
 * alternative is six component tests that each prove only that one card renders.
 */

const ROOT = join(import.meta.dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('every completed action ends in <ActionResult>', () => {
  const callSites: readonly [string, string][] = [
    ['the trade ticket', 'components/TicketCard.tsx'],
    ['move and convert', 'app/fund/TopUpCard.tsx'],
    ['direct deposit', 'app/fund/DirectDepositCard.tsx'],
    ['withdraw', 'app/withdraw/WithdrawScreen.tsx'],
  ];

  for (const [name, file] of callSites) {
    it(`${name} renders it`, () => {
      const source = read(file);
      expect(source).toContain('ActionResult');
      expect(source).toMatch(/from '@tradepro\/ui'/);
    });
  }

  it('the component itself carries the transaction, not just a headline', () => {
    const source = readFileSync(join(ROOT, '../../packages/ui/src/components.tsx'), 'utf8');
    expect(source).toContain('export function ActionResult');
    // The hash is the only handle a gasless user has on their own money: the bundler
    // sent the transaction, so their own address never lists it.
    expect(source).toContain('txHash');
    expect(source).toContain('View on the explorer');
  });
});

describe('withdraw exists at all, which FR-07 required and the docs never designed', () => {
  it('builds MarginAccount.withdraw and records it in the activity log', () => {
    const source = read('app/withdraw/WithdrawScreen.tsx');
    expect(source).toContain('buildWithdraw');
    expect(source).toContain("kind: 'withdraw'");
    // The destination is never a field: the contract credits msg.sender.
    expect(source).not.toMatch(/id="withdraw-recipient"/);
  });
});

describe('send checks the address before it can ever spend', () => {
  const source = read('app/send/SendScreen.tsx');

  it('rejects a malformed address, refuses the user own address, warns on a contract', () => {
    expect(source).toContain("kind: 'malformed'");
    expect(source).toContain("kind: 'self'");
    expect(source).toContain("kind: 'contract'");
    // A warning, never a block.
    expect(source).toContain('If it cannot receive tokens, they will be lost');
  });

  it('requires an explicit review step before anything is signed', () => {
    expect(source).toContain('setConfirming(true)');
    expect(source).toContain('Check the address before you send');
  });
});
