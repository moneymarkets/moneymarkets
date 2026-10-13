import { describe, expect, it } from 'vitest';
import { accountFromMnemonic } from './account.js';

/**
 * The derived account must not hand out its own private key.
 *
 * viem's `hdKeyToAccount` returns `{ ...account, getHdKey: () => hdKey }`, and
 * `getHdKey().privateKey` is the raw 32-byte secp256k1 key — a public method on a plain
 * object, not a closure. That object lives in React state and is published through
 * context, and React's fiber tree makes it walkable from `document.body`, so any script
 * executing in the page could read the key outright.
 *
 * Stripping it does not make a compromised page safe — the account still signs. It
 * removes the one-shot total grab, which matters more than usual here: the key cannot be
 * rotated, because the same key is what the 24 recovery words reproduce.
 *
 * A test rather than a comment because the strip is one destructuring line that a future
 * refactor would not think twice about.
 */

const PHRASE = 'test test test test test test test test test test test junk';

describe('the derived account exposes no path to its own key', () => {
  const account = accountFromMnemonic(PHRASE);

  it('has no getHdKey', () => {
    expect((account as Record<string, unknown>).getHdKey).toBeUndefined();
  });

  it('exposes no property whose name suggests key material', () => {
    for (const key of Object.keys(account)) {
      expect(key).not.toMatch(/private|mnemonic|seed|secret|hdkey/i);
    }
  });

  it('carries no 32-byte hex value anywhere on the object', () => {
    // A key that survived under another name would still be a key.
    for (const value of Object.values(account)) {
      if (typeof value === 'string') expect(value).not.toMatch(/^0x[0-9a-fA-F]{64}$/);
      if (value instanceof Uint8Array) expect(value.length).not.toBe(32);
    }
  });

  it('still signs, and still derives the same address', async () => {
    // The strip must not cost the account its job.
    expect(account.address).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    expect(typeof account.signMessage).toBe('function');
    expect(typeof account.signTypedData).toBe('function');
    expect(typeof account.signAuthorization).toBe('function');
    const sig = await account.signMessage({ message: 'audit' });
    expect(sig).toMatch(/^0x[0-9a-fA-F]{130}$/);
  });
});
