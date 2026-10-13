/**
 * Generate the two keys the mainnet M0 gate needs, encrypted at rest, and print only
 * their addresses.
 *
 * Rule A2.2: a private key never appears in a log, a commit, a chat message or a
 * frontend bundle. This script prints addresses. It never prints a key, and it never
 * writes one in plaintext.
 *
 * ## What it makes
 *
 *   relayer     pays gas for forwarded transactions. Holds MON, never user funds.
 *   gate        the test account the M0 gate signs with. Holds AUSD, never MON.
 *
 * ## Why the gate account is not a passkey account
 *
 * A Mera account's address is a function of a WebAuthn PRF output, which only exists
 * inside a browser during a user-verified passkey ceremony. Node cannot produce one,
 * so a headless gate script cannot sign as a passkey-derived account. The two things
 * are therefore proven separately:
 *
 *   - this locally-held key proves the forwarded-order mechanism end to end;
 *   - `/dev/mera` on a real device proves the passkey derivation and that signing
 *     typed data needs no second biometric.
 *
 * Both are required for M0; neither substitutes for the other. The passkey account
 * needs no funding.
 *
 * ## Encryption
 *
 * Keys are stored as Web3 Secret Storage v3 keystores (scrypt + AES-128-CTR +
 * keccak MAC) under `.secrets/`, which is git-ignored. The passphrase comes from
 * `RELAYER_KEYSTORE_PASSPHRASE` if it is set. If it is not, one is generated and
 * written to `.secrets/PASSPHRASE.txt`.
 *
 * Be clear about what that buys: a keystore beside its passphrase is protected
 * against a keystore being copied, committed or backed up on its own — which is how
 * these leak in practice — and is *not* protected against someone who already has
 * the machine. Move the passphrase into a password manager and delete that file.
 */

import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { safeLog } from '@tradepro/core';
import { encryptToKeystore, writeKeystore } from './keystore.js';

const SECRETS = new URL('../.secrets/', import.meta.url);

function resolvePassphrase(): { passphrase: string; generated: boolean } {
  const fromEnv = process.env.RELAYER_KEYSTORE_PASSPHRASE;
  if (fromEnv && fromEnv.length >= 16) return { passphrase: fromEnv, generated: false };
  if (fromEnv) {
    throw new Error('RELAYER_KEYSTORE_PASSPHRASE is set but shorter than 16 characters');
  }
  // 32 bytes of base64url: ~192 bits. Not memorable, not meant to be.
  return { passphrase: randomBytes(32).toString('base64url'), generated: true };
}

function main(): void {
  mkdirSync(SECRETS, { recursive: true });

  const relayerPath = new URL('relayer-keystore.json', SECRETS);
  const gatePath = new URL('gate-keystore.json', SECRETS);
  if (existsSync(relayerPath) || existsSync(gatePath)) {
    console.error(
      'A keystore already exists in .secrets/. Refusing to overwrite it — that would\n' +
        'orphan any funds already sent to the old address. Delete the files by hand if\n' +
        'you really mean to start over.',
    );
    process.exitCode = 1;
    return;
  }

  const { passphrase, generated } = resolvePassphrase();

  const relayerKey = generatePrivateKey();
  const relayer = privateKeyToAccount(relayerKey);
  const gateKey = generatePrivateKey();
  const gate = privateKeyToAccount(gateKey);

  const relayerFile = writeKeystore(
    'relayer',
    encryptToKeystore(relayerKey, relayer.address, passphrase),
  );
  const gateFile = writeKeystore('gate', encryptToKeystore(gateKey, gate.address, passphrase));

  if (generated) {
    const p = new URL('PASSPHRASE.txt', SECRETS);
    writeFileSync(
      p,
      `${passphrase}\n\nThis unlocks .secrets/*-keystore.json.\n` +
        'Move it into a password manager and delete this file.\n',
      { mode: 0o600 },
    );
    try {
      chmodSync(p, 0o600);
    } catch {
      /* see above */
    }
  }

  safeLog('Two keys generated. Neither is printed here and neither is in git.\n');
  safeLog('  RELAYER   ' + relayer.address);
  safeLog('            pays gas. Fund with MON. Cap is 2 MON — do not send more.');
  safeLog('            ' + relayerFile);
  safeLog('');
  safeLog('  GATE      ' + gate.address);
  safeLog('            signs the M0 order. Fund with AUSD. Must hold ZERO MON.');
  safeLog('            ' + gateFile);
  safeLog('');
  safeLog('AUSD on Monad mainnet: 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a (6 decimals)');
  safeLog('');
  if (generated) {
    safeLog('The passphrase was generated and written to .secrets/PASSPHRASE.txt.');
    safeLog('Move it to a password manager and delete that file. Encryption beside its');
    safeLog('own passphrase protects a copied or committed keystore, not this machine.');
  } else {
    safeLog('Encrypted with RELAYER_KEYSTORE_PASSPHRASE from the environment.');
  }
  safeLog('');
  safeLog('Nothing else happens until you confirm both are funded.');
}

main();
