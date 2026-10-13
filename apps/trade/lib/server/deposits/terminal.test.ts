import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Only an outcome is terminal — the rule that decides whether an address stays watched.
 *
 * ## The defect this exists to prevent
 *
 * `active()` selects `WHERE terminal_status IS NULL`. Anything written into
 * `terminal_status` therefore ends the watch, permanently. `checkRelay` computed
 * `terminal = mapped !== 'PROCESSING'`, and Relay answers `unknown` — mapped to
 * `PENDING_DEPOSIT` — for an address nothing has been sent to yet. So every Relay
 * address was marked finished roughly three seconds after it was issued, and the money
 * a user then sent to it was never noticed.
 *
 * Five rows in production carried that state. It was invisible from the screen, because
 * an unfunded address and an abandoned one look identical until somebody funds it.
 *
 * A state a deposit passes *through* is not an outcome. Delivered, returned and failed
 * are outcomes; waiting and in-flight are not.
 */

const ROOT = join(import.meta.dirname);
const watcher = readFileSync(join(ROOT, 'watcher.ts'), 'utf8');
const db = readFileSync(join(ROOT, 'db.ts'), 'utf8');

describe('terminal means an outcome, never a waiting state', () => {
  it('the watcher names the three outcomes explicitly', () => {
    expect(watcher).toContain(
      "const terminal = mapped === 'SUCCESS' || mapped === 'REFUNDED' || mapped === 'FAILED'",
    );
  });

  it('never decides terminality by excluding one in-flight state', () => {
    // `!== 'PROCESSING'` is the exact shape of the bug: it makes every state that is
    // not that one an outcome, including the ones that mean "nothing has arrived".
    const code = watcher.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/terminal\s*=\s*mapped\s*!==/);
  });

  it('PENDING_DEPOSIT is not in any terminal expression', () => {
    const code = watcher.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const terminalLines = code.split('\n').filter((l) => /\bterminal\b\s*=/.test(l));
    for (const line of terminalLines) {
      expect(line).not.toContain('PENDING_DEPOSIT');
    }
  });

  it('active() still gates on terminal_status, which is what makes this load-bearing', () => {
    // If this changes, the rule above stops being about whether a deposit is watched
    // and this test needs rewriting rather than deleting.
    expect(db).toContain('WHERE terminal_status IS NULL');
  });
});
