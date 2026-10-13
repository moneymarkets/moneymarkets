import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertNoSecretValues, safeLog, SECRET_ENV_NAMES } from './secretGuard.js';

/**
 * ## Every fixture in this file is synthetic, and a test below enforces that
 *
 * This file previously contained the **real** `PIMLICO_API_KEY` and the **real**
 * `RELAYER_KEYSTORE_PASSPHRASE`, pasted in as "the exact shape of the leak". They were
 * committed on 2026-09-03 — in the commit that added this very guard against printing
 * secrets — and were still live when found on 2026-09-10 while preparing to publish the
 * repository. The passphrase opened the gate and deployer keystores; the API key was
 * byte-identical to the one in the deployed relayer's environment.
 *
 * The lesson is narrow and worth stating plainly: a test that needs the *shape* of a
 * secret does not need the *value* of one. These fixtures are shaped like the real
 * things — same character classes, same lengths — and are not any real thing.
 *
 * `no fixture in this file is a real secret` is the guard against a repeat. It hashes
 * every long token in this file's own source and fails if one matches the hash of a
 * value present in the environment. See D147.
 */

/** Synthetic. Same length and character class as a Pimlico key, and not one. */
const FAKE_PIMLICO_KEY = 'pim_EXAMPLE_not_a_real_key';

/** Synthetic. 43 base64url-ish characters, the shape of a 32-byte passphrase. */
const FAKE_PASSPHRASE = 'EXAMPLE_passphrase_never_used_anywhere_0000';

/** Synthetic, for the loop over every guarded name. */
const FAKE_GENERIC_VALUE = 'EXAMPLE_value_not_secret';

describe('assertNoSecretValues', () => {
  it('throws on the shape of the 2026-09-04 leak', () => {
    expect(() => assertNoSecretValues(`PIMLICO_API_KEY=${FAKE_PIMLICO_KEY}`)).toThrow();
    expect(() =>
      assertNoSecretValues(`RELAYER_KEYSTORE_PASSPHRASE=${FAKE_PASSPHRASE}`),
    ).toThrow();
  });

  it('catches a leaked secret even mixed into a larger multi-line block', () => {
    const block = 'NODE_ENV=production\nPIMLICO_API_KEY=pim_leak\nCHAIN=mainnet';
    expect(() => assertNoSecretValues(block)).toThrow(/PIMLICO_API_KEY/);
  });

  it('allows a bare key name with no value — what a "list key names only" diagnostic produces', () => {
    expect(() => assertNoSecretValues('PIMLICO_API_KEY=')).not.toThrow();
    expect(() => assertNoSecretValues('key names present: PIMLICO_API_KEY, MODE')).not.toThrow();
  });

  it('allows an unrelated KEY=value line', () => {
    expect(() => assertNoSecretValues('MODE=live')).not.toThrow();
    expect(() => assertNoSecretValues('CHAIN=mainnet\nMODE=live')).not.toThrow();
  });

  it('every name in SECRET_ENV_NAMES is actually guarded', () => {
    for (const name of SECRET_ENV_NAMES) {
      expect(() => assertNoSecretValues(`${name}=${FAKE_GENERIC_VALUE}`), name).toThrow();
    }
  });

  it('a narrower name list only guards the names given', () => {
    expect(() => assertNoSecretValues('PIMLICO_API_KEY=leak', ['RELAYER_PRIVATE_KEY'])).not.toThrow();
  });
});

describe('safeLog', () => {
  afterEach(() => vi.restoreAllMocks());

  it('never reaches console.log when a secret value is present', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(() => safeLog(`RELAYER_KEYSTORE_PASSPHRASE=${FAKE_PASSPHRASE}`)).toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it('logs normally when nothing secret is present', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    safeLog('MODE=live');
    expect(spy).toHaveBeenCalledWith('MODE=live');
  });
});

/**
 * The guard against this file ever holding a real secret again.
 *
 * It reads its **own source**, pulls out every token long enough to be a credential,
 * and compares each one's SHA-256 against the SHA-256 of every value currently in the
 * environment. A match means someone has pasted a live value in here, and the test
 * fails naming the variable — without ever printing either value, which is the same
 * discipline the module under test enforces (rule A4).
 *
 * Hashes, not equality, so a failure message can name the collision without becoming
 * the leak it is reporting.
 */
describe('no fixture in this file is a real secret', () => {
  const source = readFileSync(new URL(import.meta.url), 'utf8');
  /** Long enough to be a credential; short tokens are identifiers and prose. */
  const tokens = [...new Set(source.match(/[A-Za-z0-9_-]{16,}/g) ?? [])];
  const sha = (v: string) => createHash('sha256').update(v).digest('hex');

  it('finds tokens to check, so a regex change cannot silently disable this', () => {
    expect(tokens.length).toBeGreaterThan(5);
    // The three deliberate fixtures must be among them.
    const hashes = new Set(tokens.map(sha));
    expect(hashes.has(sha(FAKE_PIMLICO_KEY))).toBe(true);
    expect(hashes.has(sha(FAKE_PASSPHRASE))).toBe(true);
  });

  it('matches no value present in the environment', () => {
    const envHashes = new Map<string, string>();
    for (const [name, value] of Object.entries(process.env)) {
      if (typeof value === 'string' && value.length >= 16) envHashes.set(sha(value), name);
    }
    const collisions = tokens
      .map((t) => ({ token: t, name: envHashes.get(sha(t)) }))
      .filter((c) => c.name !== undefined)
      .map((c) => c.name);
    expect(
      collisions,
      `a fixture in this file is the live value of: ${collisions.join(', ')}. ` +
        'Replace it with a synthetic value of the same shape.',
    ).toEqual([]);
  });

  it('the fixtures are not the values that leaked on 2026-09-04', () => {
    // The two real values are recorded in DECISIONS.md D115 and D147 only as hashes,
    // so this can assert they are gone without knowing them.
    const LEAKED_PASSPHRASE_SHA =
      'f5d4eeda' as const; /* first 8 of the sha256 recorded in D115 */
    expect(sha(FAKE_PASSPHRASE).startsWith(LEAKED_PASSPHRASE_SHA)).toBe(false);
    for (const token of tokens) {
      expect(sha(token).startsWith(LEAKED_PASSPHRASE_SHA), 'the leaked passphrase is back').toBe(
        false,
      );
    }
  });
});
