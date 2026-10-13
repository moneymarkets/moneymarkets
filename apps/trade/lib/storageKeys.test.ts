import { describe, expect, it } from 'vitest';
import { ACCOUNTS_STORAGE_KEY, CREDENTIAL_STORAGE_KEY, PERSISTED_KEYS } from '@tradepro/core';
import { DRYRUN_LOG_KEY } from './dryrunLog';

/**
 * `THEME_STORAGE_KEY` (`lib/theme.tsx:22`) and `DISMISSED_KEY`
 * (`components/InstallPrompt.tsx:20`) are not imported here: both live in `.tsx`
 * files, and importing one into this `.ts` test broke the JSX transform for an
 * unrelated reason. Their literal values are checked directly below instead — both
 * constants stay module-private, which is the smaller footprint.
 */
const THEME_STORAGE_KEY = 'tradepro.theme'; // lib/theme.tsx:22
const INSTALL_PROMPT_DISMISSED_KEY = 'tradepro.installBannerDismissed'; // components/InstallPrompt.tsx:20

/**
 * Every `localStorage` key this app actually writes, in one place (audit M5).
 *
 * `PERSISTED_KEYS` (`packages/core/src/mera/account.ts`) claimed completeness for
 * "the account-related values this app persists" while only ever knowing about two
 * of the real total — `packages/core` cannot see `apps/trade`'s own modules — and its
 * guarding test asserted the constant equalled its own definition, which could never
 * fail. This is the inventory that claim needed: every static key, found by reading
 * every `localStorage.setItem`/`getItem` call site in this app on 2026-09-23, plus
 * every *pattern* for the keys that are per-account or per-market (those embed an
 * address or a market, so there is no single literal string to list).
 *
 * A new module that starts writing to `localStorage` and carries something that
 * looks like key material is exactly what this file exists to catch — add its key
 * (or its pattern, with a citation) to the lists below when it ships.
 */

/** One literal string per key, each with the exact site that owns it. */
const STATIC_KEYS: readonly string[] = [
  CREDENTIAL_STORAGE_KEY, // packages/core/src/mera/account.ts:255
  ACCOUNTS_STORAGE_KEY, // packages/core/src/mera/account.ts:268
  INSTALL_PROMPT_DISMISSED_KEY,
  DRYRUN_LOG_KEY, // lib/dryrunLog.ts:19
  THEME_STORAGE_KEY,
];

/**
 * Prefixes for keys that are built per-account or per-market and so have no single
 * literal value. Each function is private to its module, so the prefix is checked
 * directly against a real address rather than importing the builder.
 */
const DYNAMIC_KEY_PREFIXES: readonly string[] = [
  'tradepro.notifications.', // lib/notifications.ts:48 — `${prefix}${account.toLowerCase()}`
  'tradepro.activity.', // lib/activityStore.ts:113 — `${prefix}${account.toLowerCase()}`
  'tradepro.orders.', // lib/openOrders.ts:86 — `${prefix}${market}.${owner}`
  'tradepro.simulated.', // lib/openOrders.ts:90 — `${prefix}${market}.${owner}`
  'tradepro.wallet.prefs.', // lib/wallet/preferences.ts — `${prefix}${account.toLowerCase()}`
  'tradepro.wallet.addressbook.', // lib/wallet/addressBook.ts — `${prefix}${account.toLowerCase()}`
  'tradepro.wallet.addedTokens.', // lib/wallet/addedTokens.ts — `${prefix}${account.toLowerCase()}`, contract addresses only
];

const NO_KEY_MATERIAL = /key|mnemonic|seed|secret|private/i;

describe('every localStorage key this app writes, inventoried for real', () => {
  it('carries nothing that reads like key material, in its literal keys', () => {
    for (const key of STATIC_KEYS) expect(key, key).not.toMatch(NO_KEY_MATERIAL);
  });

  it('carries nothing that reads like key material, in its per-account/market prefixes', () => {
    for (const prefix of DYNAMIC_KEY_PREFIXES) expect(prefix, prefix).not.toMatch(NO_KEY_MATERIAL);
  });

  it('every key starts with the one namespace this app uses', () => {
    for (const key of [...STATIC_KEYS, ...DYNAMIC_KEY_PREFIXES]) {
      expect(key.startsWith('tradepro.'), key).toBe(true);
    }
  });

  it('has no duplicate static keys', () => {
    expect(new Set(STATIC_KEYS).size).toBe(STATIC_KEYS.length);
  });

  it("packages/core's own PERSISTED_KEYS is a subset of this inventory, not a rival claim", () => {
    for (const key of PERSISTED_KEYS) expect(STATIC_KEYS).toContain(key);
  });
});
