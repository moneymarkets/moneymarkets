/**
 * Decrypt one keystore to a local file.
 *
 * Rule A2.2 says a private key never appears in a log or a chat message. This script
 * therefore prints a **path**, never a key: the hex is written to `.secrets/`, which
 * is git-ignored, and nothing about it reaches stdout, a terminal transcript, or an
 * agent's context.
 *
 * Prefer importing `.secrets/<name>-keystore.json` straight into MetaMask or Rabby —
 * both read Web3 Secret Storage v3 — which needs no plaintext key to exist at all.
 * Use this only for a tool that accepts nothing but raw hex, and delete the file
 * afterwards.
 *
 *   pnpm export-key gate
 *   pnpm export-key relayer
 */

import { writeFileSync, chmodSync } from 'node:fs';
import { loadAccount } from './keystore.js';

const name = process.argv[2];

if (name !== 'gate' && name !== 'relayer') {
  console.error('Usage: pnpm export-key <gate|relayer>');
  process.exitCode = 1;
} else {
  const account = loadAccount(name);

  // `loadAccount` returns a viem account; the key lives on its private source. Read it
  // back out of the keystore rather than off the account object, so there is exactly
  // one code path that ever holds plaintext.
  const { readKeystore } = await import('./keystore.js');
  const store = readKeystore(name);
  void store;

  const out = new URL(`../.secrets/${name}-PRIVATE-KEY.txt`, import.meta.url);
  writeFileSync(out, `${account.address}\n${process.env.EXPORT_INCLUDE_KEY === 'true' ? '' : ''}`, {
    mode: 0o600,
  });

  console.log(`Address: ${account.address}`);
  console.log('');
  console.log('The raw key was NOT written. Importing the keystore is almost always');
  console.log('what you want, and needs no plaintext key to exist:');
  console.log('');
  console.log(`  MetaMask -> Import account -> JSON File -> .secrets/${name}-keystore.json`);
  console.log('  Password: the first line of .secrets/PASSPHRASE.txt');
  console.log('');
  console.log('If a tool truly accepts only raw hex, re-run with:');
  console.log(`  EXPORT_INCLUDE_KEY=true pnpm export-key ${name}`);
  console.log('and the hex is written to .secrets/<name>-PRIVATE-KEY.txt. Delete it after.');

  if (process.env.EXPORT_INCLUDE_KEY === 'true') {
    const { createDecipheriv, scryptSync } = await import('node:crypto');
    const { kdfparams, cipherparams, ciphertext } = store.crypto;
    const passphrase =
      process.env.RELAYER_KEYSTORE_PASSPHRASE ??
      (await import('node:fs'))
        .readFileSync(new URL('../.secrets/PASSPHRASE.txt', import.meta.url), 'utf8')
        .split('\n')[0]!
        .trim();
    const derived = scryptSync(
      Buffer.from(passphrase, 'utf8'),
      Buffer.from(kdfparams.salt, 'hex'),
      kdfparams.dklen,
      { N: kdfparams.n, r: kdfparams.r, p: kdfparams.p, maxmem: 512 * 1024 * 1024 },
    );
    const decipher = createDecipheriv(
      'aes-128-ctr',
      derived.subarray(0, 16),
      Buffer.from(cipherparams.iv, 'hex'),
    );
    const key = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'hex')), decipher.final()]);
    writeFileSync(out, `${account.address}\n0x${key.toString('hex')}\n`, { mode: 0o600 });
    key.fill(0);
    try {
      chmodSync(out, 0o600);
    } catch {
      /* Windows ignores POSIX modes; .secrets/ being git-ignored is the real control. */
    }
    console.log('');
    console.log(`Written to .secrets/${name}-PRIVATE-KEY.txt — open it yourself, then delete it.`);
  }
}
