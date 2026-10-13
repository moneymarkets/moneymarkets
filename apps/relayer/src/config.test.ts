import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isolateEnv } from './testEnv.js';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { encryptToKeystore } from '../../../scripts/keystore.js';
import { readRelayerAddress } from './config.js';

// Every environment variable this file touches is restored after each test.
isolateEnv();

/**
 * `readRelayerAddress`'s fallback to the keystore file has the same hardcoded
 * `../../../.secrets/…` path `keystore.ts` had, and missed the same fix the first
 * time round: caught only by test-booting the real bundle on the real server,
 * where `/v1/health` reported `floatKnown: false` for an account that genuinely has
 * a keystore. This function backs the float-cap check specifically because a
 * deployment with no env key would otherwise skip it silently — the exact incident
 * named in its own doc comment (funded 5 MON against a 2 MON cap, nothing objected).
 * Missing the path fix here would have quietly reintroduced that gap in every
 * deployment that uses a keystore instead of `RELAYER_PRIVATE_KEY`.
 */

const PASSPHRASE = 'test-passphrase-not-a-real-secret';

let dir: string;
let expectedAddress: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'relayer-config-test-'));
  const key = generatePrivateKey();
  const account = privateKeyToAccount(key);
  expectedAddress = account.address;
  const store = encryptToKeystore(key, account.address, PASSPHRASE);
  writeFileSync(join(dir, 'keystore.json'), JSON.stringify(store));
});

afterEach(() => {
  delete process.env.RELAYER_KEYSTORE_PATH;
  delete process.env.RELAYER_ADDRESS;
  delete process.env.RELAYER_PRIVATE_KEY;
  rmSync(dir, { recursive: true, force: true });
});

describe('readRelayerAddress reads the plaintext address off an overridden keystore path', () => {
  it('recovers the address from RELAYER_KEYSTORE_PATH, not the source-relative default', () => {
    process.env.RELAYER_KEYSTORE_PATH = join(dir, 'keystore.json');
    const address = readRelayerAddress({ ...process.env });
    expect(address?.toLowerCase()).toBe(expectedAddress.toLowerCase());
  });

  it('prefers RELAYER_ADDRESS when it is set, without touching the keystore at all', () => {
    process.env.RELAYER_KEYSTORE_PATH = join(dir, 'does-not-matter.json');
    const address = readRelayerAddress({
      ...process.env,
      RELAYER_ADDRESS: '0x000000000000000000000000000000000000dEaD',
    });
    expect(address).toBe('0x000000000000000000000000000000000000dEaD');
  });

  it('returns undefined, not a throw, when the overridden path does not exist', () => {
    process.env.RELAYER_KEYSTORE_PATH = join(dir, 'nothing-here.json');
    expect(readRelayerAddress({ ...process.env })).toBeUndefined();
  });
});
