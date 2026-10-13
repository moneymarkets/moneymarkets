import { existsSync, readFileSync } from 'node:fs';
import { createDecipheriv, scryptSync } from 'node:crypto';
import { keccak256, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { PrivateKeyAccount } from 'viem';

/**
 * Unlock the relayer's key.
 *
 * The relayer could previously only sign when `RELAYER_PRIVATE_KEY` was in the
 * environment, and it never is: keys are stored as encrypted Web3 Secret Storage v3
 * keystores under `.secrets/` precisely so a plaintext key does not sit in a `.env`
 * that something might read, log, or copy. The consequence was a relayer that could
 * report its float but could not fund an account's EntryPoint deposit — so the first
 * sponsored operation for any new account was impossible.
 *
 * The passphrase comes from `RELAYER_KEYSTORE_PASSPHRASE`, or from
 * `.secrets/PASSPHRASE.txt` while that file still exists.
 *
 * The decrypted key is held in one `PrivateKeyAccount` and never returned as bytes,
 * never logged, and never placed in a response (rule A2.2).
 */

interface KeystoreFile {
  version: 3;
  address: string;
  crypto: {
    ciphertext: string;
    cipherparams: { iv: string };
    cipher: string;
    kdf: string;
    kdfparams: { dklen: number; salt: string; n: number; r: number; p: number };
    mac: string;
  };
}

let cached: PrivateKeyAccount | undefined;

/**
 * `../../../.secrets/relayer-keystore.json` relative to this source file resolves
 * correctly in the repo (`apps/relayer/src/` is three levels below the root) but not
 * in any other layout — a bundled deploy has no such structure, since bundling
 * inlines this file's contents into one flat output whose own path is whatever the
 * deploy chose. `RELAYER_KEYSTORE_PATH` is the override for that case; the relative
 * default is unchanged for `tsx`/local dev, where this file really does live three
 * directories down.
 */
function keystorePath(): URL | string {
  const fromEnv = process.env.RELAYER_KEYSTORE_PATH;
  if (fromEnv) return fromEnv;
  return new URL('../../../.secrets/relayer-keystore.json', import.meta.url);
}

function resolvePassphrase(): string | undefined {
  const fromEnv = process.env.RELAYER_KEYSTORE_PASSPHRASE;
  if (fromEnv) return fromEnv;
  const file = new URL('../../../.secrets/PASSPHRASE.txt', import.meta.url);
  if (!existsSync(file)) return undefined;
  return readFileSync(file, 'utf8').split('\n')[0]?.trim();
}

/**
 * The relayer's signer, or `undefined` when there is nothing to unlock with.
 *
 * Callers must treat `undefined` as "this relayer cannot pay for anything" and say so,
 * rather than proceeding and failing later inside a bundler.
 */
export function loadRelayerAccount(): PrivateKeyAccount | undefined {
  if (cached) return cached;

  const fromEnv = process.env.RELAYER_PRIVATE_KEY;
  if (fromEnv && /^0x[0-9a-fA-F]{64}$/.test(fromEnv)) {
    cached = privateKeyToAccount(fromEnv as Hex);
    return cached;
  }

  const path = keystorePath();
  if (!existsSync(path)) return undefined;
  const passphrase = resolvePassphrase();
  if (!passphrase) return undefined;

  const store = JSON.parse(readFileSync(path, 'utf8')) as KeystoreFile;
  const { kdfparams, cipherparams, ciphertext, mac } = store.crypto;

  const derived = scryptSync(
    Buffer.from(passphrase, 'utf8'),
    Buffer.from(kdfparams.salt, 'hex'),
    kdfparams.dklen,
    { N: kdfparams.n, r: kdfparams.r, p: kdfparams.p, maxmem: 512 * 1024 * 1024 },
  );

  const cipherBytes = Buffer.from(ciphertext, 'hex');
  const expectedMac = keccak256(
    `0x${Buffer.concat([derived.subarray(16, 32), cipherBytes]).toString('hex')}`,
  );
  if (expectedMac.slice(2) !== mac.toLowerCase()) return undefined;

  const decipher = createDecipheriv(
    'aes-128-ctr',
    derived.subarray(0, 16),
    Buffer.from(cipherparams.iv, 'hex'),
  );
  const key = Buffer.concat([decipher.update(cipherBytes), decipher.final()]);
  const account = privateKeyToAccount(`0x${key.toString('hex')}` as Hex);
  key.fill(0);

  if (account.address.toLowerCase() !== `0x${store.address}`.toLowerCase()) return undefined;
  cached = account;
  return cached;
}
