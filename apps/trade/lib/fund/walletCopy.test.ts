import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A deposit-address route can never be labelled as needing a wallet.
 *
 * ## Why this is a source scan and not a render test
 *
 * The promise in item 1.1 is not "the card renders correctly for Base USDC". It is that
 * **no path through the screen** can put a wallet requirement on Relay or NEAR, or a
 * connect button outside the collapsed section. A render test proves one path. A scan of
 * where the strings may appear proves there is no second place for them to leak from.
 *
 * The rule it enforces: the sentence "Requires a wallet…" is produced in exactly one
 * function, `walletRequirement`, and that function is called in exactly one place — the
 * list of quotes already filtered to `needsWallet`. If either becomes two, this fails
 * and somebody has to think about whether the second one is also gated.
 */

const PICKER = readFileSync(
  join(import.meta.dirname, '..', '..', 'app', 'fund', 'RoutePicker.tsx'),
  'utf8',
);

/** Comments quote the rule and the reasoning; only rendered copy is under test. */
const code = PICKER.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

describe('the wallet requirement is produced in one place and shown in one place', () => {
  it('only `walletRequirement` builds the sentence', () => {
    // The sentence is assembled from template parts, so the scan is for the word that
    // starts it rather than for a whole phrase that never appears as one literal.
    const starts = [...code.matchAll(/`Requires /g)];
    expect(starts.length).toBe(1);
    // And it is inside that function, not somewhere else that happens to say it.
    const fnStart = code.indexOf('function walletRequirement');
    expect(fnStart).toBeGreaterThan(-1);
    expect(code.indexOf('`Requires ')).toBeGreaterThan(fnStart);
  });

  it('the one place that mentions a wallet outside it is the section header', () => {
    // The collapsed header describes what the whole section needs, which is the same
    // claim scoped to the same place. Anything beyond these two is a leak.
    const mentions = [...code.matchAll(/a wallet holding/g)];
    expect(mentions.length).toBe(2);
  });

  it('it is called only inside the wallet-signed list', () => {
    const calls = [...code.matchAll(/walletRequirement\(/g)];
    // The declaration plus exactly one call site.
    expect(calls.length).toBe(2);
    // And that call site sits inside the block rendering `walletQuotes`.
    const listStart = code.indexOf('walletQuotes.map(');
    const callSite = code.lastIndexOf('walletRequirement(');
    expect(listStart).toBeGreaterThan(-1);
    expect(callSite).toBeGreaterThan(listStart);
  });

  it('that list is filtered on needsWallet, not on rail name', () => {
    // Filtering by rail id would go stale the moment a rail changes how it executes.
    expect(code).toContain('ranked.filter((q) => q.needsWallet)');
    expect(code).toContain('ranked.filter((q) => !q.needsWallet)');
  });
});

describe('the connect buttons cannot appear on the default path', () => {
  it('SourceWalletCard is rendered exactly once', () => {
    const uses = [...code.matchAll(/<SourceWalletCard/g)];
    expect(uses.length).toBe(1);
  });

  it('and that one render is inside the collapsed section', () => {
    const sectionStart = code.indexOf('walletSectionOpen ? (');
    const card = code.indexOf('<SourceWalletCard');
    expect(sectionStart).toBeGreaterThan(-1);
    expect(card).toBeGreaterThan(sectionStart);
  });

  it('the section starts closed', () => {
    expect(code).toContain('useState(false)');
    expect(code).toMatch(/walletSectionOpen,\s*setWalletSectionOpen\]\s*=\s*useState\(false\)/);
  });
});

describe('the Best block never renders a wallet-signed quote', () => {
  it('it is gated on !bestNeedsWallet', () => {
    // Item 1.3: when only wallet rails quoted, the card explains that first rather than
    // presenting one of them as though it were the ordinary path.
    expect(code).toContain('best && entry && !bestNeedsWallet');
  });

  it('and says "No wallet needed" on the quote it does present', () => {
    expect(code).toContain('No wallet needed');
  });
});
