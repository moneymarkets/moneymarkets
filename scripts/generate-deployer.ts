/**
 * Generate the DEPLOYER key for `apps/market-kit`, encrypted at rest, and print only
 * its address.
 *
 * Rule A2.2: a private key never appears in a log, a commit, a chat message or a
 * frontend bundle. This script prints an address. It never prints a key, and it never
 * writes one in plaintext.
 *
 * ## Why a new key and not the owner's wallet
 *
 * The deployer signs `Router.deployProxy`, ERC-20 approvals, `MarginAccount.deposit`
 * and `batchProvisionLiquidity` — every one of which moves the operator's own capital.
 * Pointing that at a personal wallet means a typo in `--size-per-level`, or a leaked
 * environment file, reaches everything that wallet holds. A separate key holds only
 * the seeding float, so the blast radius is the float and nothing else. The keystore
 * is written with a fresh `generatePrivateKey()`; there is no import path here, by
 * design.
 *
 * ## Encryption
 *
 * Web3 Secret Storage v3 (scrypt + AES-128-CTR + keccak MAC) under `.secrets/`, which
 * is git-ignored — the same format and the same passphrase as the relayer and gate
 * keystores, so `.secrets/PASSPHRASE.txt` (or `RELAYER_KEYSTORE_PASSPHRASE`) opens all
 * three. That passphrase must already exist: this script will not invent a second one,
 * because a keystore nobody can open is worse than no keystore.
 *
 *   pnpm generate-deployer
 */

import { mkdirSync } from 'node:fs';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { safeLog } from '@tradepro/core';
import { encryptToKeystore, keystoreExists, passphrase, writeKeystore } from './keystore.js';

const SECRETS = new URL('../.secrets/', import.meta.url);

function main(): void {
  mkdirSync(SECRETS, { recursive: true });

  if (keystoreExists('deployer')) {
    console.error(
      '.secrets/deployer-keystore.json already exists. Refusing to overwrite it — that\n' +
        'would orphan any capital already sent to the old address. Delete the file by hand\n' +
        'if you really mean to start over.',
    );
    process.exitCode = 1;
    return;
  }

  const secret = passphrase();
  const key = generatePrivateKey();
  const account = privateKeyToAccount(key);
  const file = writeKeystore('deployer', encryptToKeystore(key, account.address, secret));

  safeLog('Deployer key generated. It is not printed here and it is not in git.\n');
  safeLog('  DEPLOYER  ' + account.address);
  safeLog('            deploys and seeds markets with the operator’s own capital.');
  safeLog('            ' + file);
  safeLog('');
  safeLog('Set DEPLOYER_ADDRESS to that address so the kit builds plans for it:');
  safeLog('  DEPLOYER_ADDRESS=' + account.address);
  safeLog('');
  safeLog('Signing stays gated. `kit` submits nothing unless CHAIN=mainnet, MODE=live and');
  safeLog('I_UNDERSTAND_THIS_USES_REAL_FUNDS=true are all set, and nothing in this repo');
  safeLog('sets them.');
  safeLog('');
  safeLog('Fund it only when you are ready to seed. See reports/phase1-live-procedure.md');
  safeLog('for the amounts and the order.');
}

main();
