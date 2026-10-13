import { describe, expect, it, afterEach } from 'vitest';
import { mnemonicToAccount } from 'viem/accounts';
import {
  accountFromMnemonic,
  accountFromPrfOutput,
  ACCOUNTS_STORAGE_KEY,
  CREDENTIAL_STORAGE_KEY,
  createAccount,
  exportMnemonic,
  MERA_DERIVATION_PATH,
  PERSISTED_KEYS,
  prfOutputToMnemonic,
  readStoredAccounts,
  setMeraModule,
  signIn,
  withStoredAccount,
  type MeraModule,
  type StoredAccount,
} from './account.js';

/** Deterministic 32 bytes standing in for a PRF output. Not a secret; not a key. */
const prf = () => new Uint8Array(32).fill(7);

const fakeMera: MeraModule = {
  createPasskeyWithPrfOutput: async () => ({ credentialId: 'cred-new', prfOutput: prf() }),
  getPasskeyPrfOutput: async ({ credential }) => ({
    credentialId: credential?.credentialId ?? 'cred-discovered',
    prfOutput: prf(),
  }),
};

afterEach(() => setMeraModule(undefined));

describe('derivation', () => {
  it('turns a 32-byte PRF output into a 24-word phrase', () => {
    const words = prfOutputToMnemonic(prf()).split(' ');
    expect(words).toHaveLength(24);
  });

  it('is deterministic: the same PRF output always gives the same address', () => {
    expect(accountFromPrfOutput(prf()).address).toBe(accountFromPrfOutput(prf()).address);
  });

  it('gives a different address for a different PRF output', () => {
    const other = new Uint8Array(32).fill(8);
    expect(accountFromPrfOutput(prf()).address).not.toBe(accountFromPrfOutput(other).address);
  });

  it('rejects a PRF output that is not 32 bytes', () => {
    expect(() => prfOutputToMnemonic(new Uint8Array(16))).toThrow(/32 bytes/);
  });

  it('uses the standard Ethereum path, so the phrase imports into MetaMask (US-7 AC2)', () => {
    const mnemonic = prfOutputToMnemonic(prf());
    // What a standard wallet does with the same phrase, spelled out rather than
    // assumed: default account, first address.
    const wallet = mnemonicToAccount(mnemonic, { path: "m/44'/60'/0'/0/0" });
    expect(accountFromMnemonic(mnemonic).address).toBe(wallet.address);
    expect(MERA_DERIVATION_PATH).toBe("m/44'/60'/0'/0/0");
  });
});

describe('account lifecycle', () => {
  it('creates an account from one passkey ceremony', async () => {
    setMeraModule(fakeMera);
    const account = await createAccount({ rp: { id: 'localhost', name: 'tradepro' } });
    expect(account.credentialId).toBe('cred-new');
    expect(account.address).toBe(accountFromPrfOutput(prf()).address);
  });

  it('signs back in to the same address', async () => {
    setMeraModule(fakeMera);
    const created = await createAccount({ rp: { id: 'localhost', name: 'tradepro' } });
    const returned = await signIn({ rpId: 'localhost', credentialId: created.credentialId });
    expect(returned.address).toBe(created.address);
    expect(returned.credentialId).toBe(created.credentialId);
  });

  it('produces a viem account that can sign EIP-712 without a further prompt', async () => {
    setMeraModule(fakeMera);
    const { account } = await createAccount({ rp: { id: 'localhost', name: 'tradepro' } });
    const signature = await account.signTypedData({
      domain: { name: 'KuruForwarder', version: '1.0.0', chainId: 143 },
      types: { Probe: [{ name: 'x', type: 'uint256' }] },
      primaryType: 'Probe',
      message: { x: 1n },
    });
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it('re-derives the phrase for export rather than storing it', async () => {
    setMeraModule(fakeMera);
    const mnemonic = await exportMnemonic({ rpId: 'localhost', credentialId: 'cred-new' });
    expect(mnemonic.split(' ')).toHaveLength(24);
    expect(accountFromMnemonic(mnemonic).address).toBe(accountFromPrfOutput(prf()).address);
  });
});

describe('what is allowed to persist', () => {
  it('is credential ids and addresses, and nothing that carries key material', () => {
    // The literal values, not `PERSISTED_KEYS` re-derived from the same two
    // constants — that assertion could never fail (audit M5). Checking the strings
    // themselves means renaming either constant's value without updating this test
    // actually breaks it.
    expect(CREDENTIAL_STORAGE_KEY).toBe('tradepro.credentialId');
    expect(ACCOUNTS_STORAGE_KEY).toBe('tradepro.accounts');
    expect(PERSISTED_KEYS).toEqual(['tradepro.credentialId', 'tradepro.accounts']);
    for (const key of PERSISTED_KEYS) expect(key).not.toMatch(/key|mnemonic|seed|secret/i);
  });

  it('is exactly two keys — this module writes nothing else to localStorage', () => {
    // A third key added here without updating this length would still carry no key
    // material by construction of the regex check above, but this catches the
    // completeness claim in the doc comment drifting silently.
    expect(PERSISTED_KEYS).toHaveLength(2);
  });
});

describe('readStoredAccounts', () => {
  it('is empty when nothing has been stored yet', () => {
    expect(readStoredAccounts(null)).toEqual([]);
  });

  it('parses a real stored list back out', () => {
    const stored: StoredAccount[] = [
      { credentialId: 'cred-a', address: '0x0000000000000000000000000000000000000001' },
    ];
    expect(readStoredAccounts(JSON.stringify(stored))).toEqual(stored);
  });

  it('survives a corrupted value rather than throwing', () => {
    expect(readStoredAccounts('not json')).toEqual([]);
    expect(readStoredAccounts('{"not":"an array"}')).toEqual([]);
    expect(readStoredAccounts('[1, "two", {"credentialId":"c"}]')).toEqual([]);
  });
});

describe('withStoredAccount', () => {
  const a: StoredAccount = {
    credentialId: 'cred-a',
    address: '0x0000000000000000000000000000000000000001',
  };
  const b: StoredAccount = {
    credentialId: 'cred-b',
    address: '0x0000000000000000000000000000000000000002',
  };

  it('adds a new account to the front', () => {
    expect(withStoredAccount([a], b)).toEqual([b, a]);
  });

  it('replaces an existing row for the same credential rather than duplicating it', () => {
    const updated: StoredAccount = { ...a, address: '0x0000000000000000000000000000000000000009' };
    expect(withStoredAccount([a, b], updated)).toEqual([updated, b]);
  });
});
