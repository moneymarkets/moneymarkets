import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { addAddressBookEntry, readAddressBook, removeAddressBookEntry } from './addressBook';

const ACCOUNT = '0x714f169Fe2D3990961B534D573f9646c037586E6' as Address;
const RECIPIENT = '0x43a275C3Eb0BE7313f847FFA4fb6Bd366606A961' as Address;

class FakeStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

describe('wallet address book', () => {
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = {
      localStorage: new FakeStorage(),
      dispatchEvent: () => true,
    };
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('starts empty for an account that has saved nothing', () => {
    expect(readAddressBook(ACCOUNT)).toEqual([]);
  });

  it('adds an entry, newest first', () => {
    addAddressBookEntry(ACCOUNT, RECIPIENT, 'cold');
    const rows = readAddressBook(ACCOUNT);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.address).toBe(RECIPIENT);
    expect(rows[0]?.label).toBe('cold');
    expect(typeof rows[0]?.addedAt).toBe('number');
  });

  it('re-adding the same address (any case) replaces the label instead of duplicating it', () => {
    addAddressBookEntry(ACCOUNT, RECIPIENT, 'cold');
    addAddressBookEntry(ACCOUNT, RECIPIENT.toUpperCase() as Address, 'gate');
    const rows = readAddressBook(ACCOUNT);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe('gate');
  });

  it('removes an entry case-insensitively', () => {
    addAddressBookEntry(ACCOUNT, RECIPIENT, 'cold');
    removeAddressBookEntry(ACCOUNT, RECIPIENT.toLowerCase() as Address);
    expect(readAddressBook(ACCOUNT)).toEqual([]);
  });

  it('carries only public addresses and labels, no key material', () => {
    addAddressBookEntry(ACCOUNT, RECIPIENT, 'cold');
    const [entry] = readAddressBook(ACCOUNT);
    expect(Object.keys(entry ?? {}).sort()).toEqual(['addedAt', 'address', 'label']);
  });
});
