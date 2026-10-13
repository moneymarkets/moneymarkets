import { existsSync, readFileSync } from 'node:fs';
import { createDecipheriv, scryptSync } from 'node:crypto';
import { keccak256, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { PrivateKeyAccount } from 'viem/accounts';

/**
 * Read the deployer keystore. **Read only** — this module cannot create, overwrite or
 * export a key.
 *
 * `scripts/keystore.ts` is the repo's writer and holds the same Web3 Secret Storage v3
 * format. This is a deliberate second copy of the *decrypt* half rather than an import
 * of it, for two reasons:
 *
 *  - `apps/market-kit` compiles with `rootDir: ./src`, so `scripts/` is not reachable
 *    from a built artifact at all;
 *  - the local web server loads this module, and a server process should not have a
 *    key *generator* on its import graph. What it can do is unlock a key that already
 *    exists, when the mode gate is open. What it cannot do is mint a new one, or write
 *    a key anywhere.
 *
 * Nothing here returns, prints or logs raw key material. The only thing that leaves is
 * a viem account, whose private source viem keeps to itself, and an address.
 */

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

export class KeystoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeystoreError';
  }
}

/**
 * `.secrets/deployer-keystore.json` at the repo root, or `DEPLOYER_KEYSTORE`.
 *
 * The repo root is found by walking up from this module until a `pnpm-workspace.yaml`
 * sits beside a `.secrets` directory, so the path is the same whether the kit runs
 * from `src/` under tsx or from `dist/`.
 */
export function deployerKeystorePath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.DEPLOYER_KEYSTORE;
  if (explicit && explicit.length > 0) return explicit;
  return new URL('deployer-keystore.json', secretsDir()).pathname.replace(/^\/([A-Za-z]:)/, '$1');
}

function secretsDir(): URL {
  let dir = new URL('./', import.meta.url);
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(new URL('pnpm-workspace.yaml', dir))) return new URL('.secrets/', dir);
    dir = new URL('../', dir);
  }
  throw new KeystoreError('could not find the repo root from this module');
}

export function deployerKeystoreExists(env: NodeJS.ProcessEnv = process.env): boolean {
  return existsSync(deployerKeystorePath(env));
}

/** The deployer's address, read from the keystore's cleartext `address` field. */
export function deployerAddress(env: NodeJS.ProcessEnv = process.env): `0x${string}` | undefined {
  const path = deployerKeystorePath(env);
  if (!existsSync(path)) return undefined;
  const store = JSON.parse(readFileSync(path, 'utf8')) as KeystoreFile;
  return `0x${store.address.replace(/^0x/, '')}` as `0x${string}`;
}

/**
 * Decrypt the deployer keystore into a signer.
 *
 * The passphrase comes from `RELAYER_KEYSTORE_PASSPHRASE`, or from
 * `.secrets/PASSPHRASE.txt` if that file still exists — the same two sources the
 * relayer and gate keystores use, so one passphrase opens all three.
 */
export function loadDeployerAccount(env: NodeJS.ProcessEnv = process.env): PrivateKeyAccount {
  const path = deployerKeystorePath(env);
  if (!existsSync(path)) {
    throw new KeystoreError(
      `no deployer keystore at ${path}. Run \`pnpm generate-deployer\` to make one; it ` +
        'prints an address and never a key.',
    );
  }
  const store = JSON.parse(readFileSync(path, 'utf8')) as KeystoreFile;
  const { kdfparams, cipherparams, ciphertext, mac } = store.crypto;

  const derived = scryptSync(
    Buffer.from(resolvePassphrase(env), 'utf8'),
    Buffer.from(kdfparams.salt, 'hex'),
    kdfparams.dklen,
    { N: kdfparams.n, r: kdfparams.r, p: kdfparams.p, maxmem: 512 * 1024 * 1024 },
  );

  const cipherBytes = Buffer.from(ciphertext, 'hex');
  const expectedMac = keccak256(
    `0x${Buffer.concat([derived.subarray(16, 32), cipherBytes]).toString('hex')}`,
  );
  if (expectedMac.slice(2) !== mac.toLowerCase()) {
    throw new KeystoreError('wrong passphrase for the deployer keystore');
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
    throw new KeystoreError('the deployer keystore address does not match its key');
  }
  return account;
}

function resolvePassphrase(env: NodeJS.ProcessEnv): string {
  const fromEnv = env.RELAYER_KEYSTORE_PASSPHRASE;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  const file = new URL('PASSPHRASE.txt', secretsDir());
  if (existsSync(file)) return readFileSync(file, 'utf8').split('\n')[0]!.trim();
  throw new KeystoreError(
    'no passphrase for the deployer keystore. Set RELAYER_KEYSTORE_PASSPHRASE, or keep ' +
      '.secrets/PASSPHRASE.txt.',
  );
}
