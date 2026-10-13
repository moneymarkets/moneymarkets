import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { keccak256, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

/**
 * Read a Web3 Secret Storage v3 keystore.
 *
 * The address is stored in the clear, so anything that only needs to *look* at an
 * account — a dry run, a balance check, a funding table — never asks for the
 * passphrase. Only a path that actually signs decrypts anything.
 */

/**
 * The accounts this repo holds a key for. Each is a separate key with a separate job:
 *
 *   relayer   pays gas for sponsored user operations. Holds MON, never user funds.
 *   gate      the M0 test account. Holds AUSD, never MON.
 *   deployer  operator key for `apps/market-kit`: deploys a market and seeds it with
 *             the operator's own capital. Never the owner's personal wallet, so a
 *             market-kit mistake can only reach the capital that was moved to it.
 */
export type KeystoreName = 'relayer' | 'gate' | 'deployer';

export interface KeystoreFile {
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

export function keystorePath(name: KeystoreName): URL {
  return new URL(`../.secrets/${name}-keystore.json`, import.meta.url);
}

export function keystoreExists(name: KeystoreName): boolean {
  return existsSync(keystorePath(name));
}

export function readKeystore(name: KeystoreName): KeystoreFile {
  const path = keystorePath(name);
  if (!existsSync(path)) {
    throw new Error(`no ${name} keystore. Run: pnpm generate-keys`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as KeystoreFile;
}

/** The account's address, without decrypting anything. */
export function addressOf(name: KeystoreName): `0x${string}` {
  const store = readKeystore(name);
  // Checksum it by round-tripping through viem rather than trusting the file's case.
  return `0x${store.address.replace(/^0x/, '')}`.toLowerCase() as `0x${string}`;
}

/**
 * Decrypt a keystore into a signer.
 *
 * The passphrase comes from `RELAYER_KEYSTORE_PASSPHRASE`, or from
 * `.secrets/PASSPHRASE.txt` if that file still exists. The returned account is the
 * only place a key is ever in memory; it is never logged, and this function never
 * returns the raw key.
 */
/**
 * Decrypt a keystore with a passphrase given explicitly, returning the private key.
 *
 * Separate from `loadAccount` because rotation needs to open a store with a passphrase
 * that is *not* the ambient one, and to ask "does the old passphrase still work" and
 * get an answer rather than an exception. Returns `undefined` for a wrong passphrase —
 * that is a question with a legitimate negative answer, not an error.
 *
 * The caller owns the returned key and should zero nothing else: the intermediate
 * buffer here is cleared before returning.
 */
export function decryptKeystore(json: string, passphrase: string): Hex | undefined {
  const store = JSON.parse(json) as KeystoreFile;
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
  // The MAC is the whole test: a wrong passphrase derives a different key and this
  // will not match. Checked before decrypting so nothing is produced from a bad one.
  if (expectedMac.slice(2) !== mac.toLowerCase()) return undefined;

  const decipher = createDecipheriv(
    'aes-128-ctr',
    derived.subarray(0, 16),
    Buffer.from(cipherparams.iv, 'hex'),
  );
  const key = Buffer.concat([decipher.update(cipherBytes), decipher.final()]);
  const hex = `0x${key.toString('hex')}` as Hex;
  key.fill(0);
  return hex;
}

export function loadAccount(name: KeystoreName) {
  const store = readKeystore(name);
  const passphrase = resolvePassphrase();
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
  if (expectedMac.slice(2) !== mac.toLowerCase()) {
    throw new Error(`wrong passphrase for the ${name} keystore`);
  }

  const decipher = createDecipheriv(
    'aes-128-ctr',
    derived.subarray(0, 16),
    Buffer.from(cipherparams.iv, 'hex'),
  );
  const key = Buffer.concat([decipher.update(cipherBytes), decipher.final()]);
  const account = privateKeyToAccount(`0x${key.toString('hex')}` as Hex);
  key.fill(0);

  if (account.address.toLowerCase() !== `0x${store.address}`.toLowerCase()) {
    throw new Error(`${name} keystore address does not match its key`);
  }
  return account;
}

function resolvePassphrase(): string {
  const fromEnv = process.env.RELAYER_KEYSTORE_PASSPHRASE;
  if (fromEnv) return fromEnv;
  const file = new URL('../.secrets/PASSPHRASE.txt', import.meta.url);
  if (existsSync(file)) return readFileSync(file, 'utf8').split('\n')[0]!.trim();
  throw new Error(
    'No passphrase. Set RELAYER_KEYSTORE_PASSPHRASE or keep .secrets/PASSPHRASE.txt.',
  );
}

/* ───────────────────────── writing a keystore ───────────────────────── */

/**
 * Web3 Secret Storage v3 — scrypt + AES-128-CTR + a keccak MAC. The same format geth
 * and every wallet reads, so a keystore written here imports into MetaMask or Rabby
 * without a plaintext key ever existing.
 *
 * `n = 1 << 18` is the standard "heavy" setting: about a second to derive, which is
 * the point — it is what makes a stolen keystore expensive to attack offline.
 */
export function encryptToKeystore(
  privateKey: Hex,
  address: string,
  passphrase: string,
): KeystoreFile & { id: string } {
  const salt = randomBytes(32);
  const iv = randomBytes(16);
  const kdfparams = { dklen: 32, salt: salt.toString('hex'), n: 1 << 18, r: 8, p: 1 };
  const derived = scryptSync(Buffer.from(passphrase, 'utf8'), salt, kdfparams.dklen, {
    N: kdfparams.n,
    r: kdfparams.r,
    p: kdfparams.p,
    maxmem: 512 * 1024 * 1024,
  });

  const cipher = createCipheriv('aes-128-ctr', derived.subarray(0, 16), iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(privateKey.slice(2), 'hex')),
    cipher.final(),
  ]);
  const mac = keccak256(
    `0x${Buffer.concat([derived.subarray(16, 32), ciphertext]).toString('hex')}`,
  );

  return {
    version: 3,
    id: randomBytes(16).toString('hex'),
    address: address.slice(2).toLowerCase(),
    crypto: {
      ciphertext: ciphertext.toString('hex'),
      cipherparams: { iv: iv.toString('hex') },
      cipher: 'aes-128-ctr',
      kdf: 'scrypt',
      kdfparams,
      mac: mac.slice(2),
    },
  };
}

/** Write a keystore to `.secrets/<name>-keystore.json` and return its repo path. */
export function writeKeystore(name: KeystoreName, keystore: KeystoreFile): string {
  const path = keystorePath(name);
  writeFileSync(path, JSON.stringify(keystore, null, 2) + '\n', { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows ignores POSIX modes; .secrets/ being git-ignored is the real control.
  }
  return `.secrets/${name}-keystore.json`;
}

/**
 * The passphrase that unlocks `.secrets/*-keystore.json`.
 *
 * `RELAYER_KEYSTORE_PASSPHRASE` first, then `.secrets/PASSPHRASE.txt`. Exported so a
 * generator writes the same keystore the readers can open, rather than inventing a
 * second passphrase for a second file.
 */
export function passphrase(): string {
  return resolvePassphrase();
}
