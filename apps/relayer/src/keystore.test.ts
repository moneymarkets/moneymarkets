import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isolateEnv } from './testEnv.js';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { encryptToKeystore } from '../../../scripts/keystore.js';

// Every environment variable this file touches is restored after each test.
isolateEnv();

/**
 * `RELAYER_KEYSTORE_PATH` (the fix for a real deploy bug): `keystorePath()`'s default,
 * `../../../.secrets/relayer-keystore.json` relative to this source file, only
 * resolves correctly in the repo layout — `apps/relayer/src/` really is three levels
 * below the root. A bundled single-file deploy has no such structure: bundling
 * inlines this file into one flat output at whatever path the deploy chose, and the
 * relative default silently walked past the deploy's own directory to the filesystem
 * root, so `existsSync` was false and the relayer would report itself unable to sign
 * with no error — found by test-booting the real bundle before it went anywhere near
 * production, not after.
 *
 * Every key in this file is thrown away at the end of the test it is generated in.
 * None is ever printed or logged; only addresses are compared.
 */

const PASSPHRASE = 'test-passphrase-not-a-real-secret';

let dir: string;
let keystorePath: string;
let expectedAddress: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'relayer-keystore-test-'));
  keystorePath = join(dir, 'test-keystore.json');

  const key = generatePrivateKey();
  const account = privateKeyToAccount(key);
  expectedAddress = account.address;
  const store = encryptToKeystore(key, account.address, PASSPHRASE);
  writeFileSync(keystorePath, JSON.stringify(store));

  process.env.RELAYER_KEYSTORE_PATH = keystorePath;
  process.env.RELAYER_KEYSTORE_PASSPHRASE = PASSPHRASE;
  delete process.env.RELAYER_PRIVATE_KEY;

  // The module caches the decrypted account in a closure-level variable, which
  // would leak the previous test's key into this one — vi.resetModules() forces
  // the next import to be a fresh instance with a fresh cache.
  vi.resetModules();
});

afterEach(() => {
  delete process.env.RELAYER_KEYSTORE_PATH;
  delete process.env.RELAYER_KEYSTORE_PASSPHRASE;
  rmSync(dir, { recursive: true, force: true });
});

describe('RELAYER_KEYSTORE_PATH overrides the source-relative default', () => {
  it('decrypts a keystore at the overridden path and recovers the right address', async () => {
    const { loadRelayerAccount } = await import('./keystore.js');
    const account = loadRelayerAccount();
    expect(account?.address.toLowerCase()).toBe(expectedAddress.toLowerCase());
  });

  it('returns undefined, not a throw, when the passphrase is wrong', async () => {
    process.env.RELAYER_KEYSTORE_PASSPHRASE = 'the-wrong-passphrase-entirely';
    const { loadRelayerAccount } = await import('./keystore.js');
    expect(loadRelayerAccount()).toBeUndefined();
  });

  it('returns undefined, not a throw, when the overridden path does not exist', async () => {
    process.env.RELAYER_KEYSTORE_PATH = join(dir, 'nothing-here.json');
    const { loadRelayerAccount } = await import('./keystore.js');
    expect(loadRelayerAccount()).toBeUndefined();
  });
});
