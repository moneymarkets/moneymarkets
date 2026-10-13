'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Address } from 'viem';

/**
 * The local address book behind Wallet settings' "Address book" row and Send's
 * "Recent recipients" (spec §4.3, §4.6, §8): public addresses and labels only,
 * per account, in the browser. Same storage convention as `notifications.ts`.
 *
 * Nothing here ever leaves the browser and nothing here is a private key or a
 * signing credential — an address book is a list of addresses someone typed in
 * once, not an account.
 */

export interface AddressBookEntry {
  readonly address: Address;
  readonly label: string;
  readonly addedAt: number;
}

const LIMIT = 100;
const CHANGED = 'tradepro:addressBook';

function key(account: Address): string {
  return `tradepro.wallet.addressbook.${account.toLowerCase()}`;
}

export function readAddressBook(account: Address): AddressBookEntry[] {
  try {
    const raw = window.localStorage.getItem(key(account));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (v): v is AddressBookEntry =>
        typeof v === 'object' &&
        v !== null &&
        typeof (v as AddressBookEntry).address === 'string' &&
        typeof (v as AddressBookEntry).label === 'string' &&
        typeof (v as AddressBookEntry).addedAt === 'number',
    );
  } catch {
    return [];
  }
}

function write(account: Address, rows: readonly AddressBookEntry[]): void {
  try {
    window.localStorage.setItem(key(account), JSON.stringify(rows.slice(0, LIMIT)));
    window.dispatchEvent(new Event(CHANGED));
  } catch {
    // Storage blocked. The address book covers this tab's session only.
  }
}

/** Add or relabel an entry. Case-insensitive on the address, so the same wallet
 *  typed with different casing does not appear twice. */
export function addAddressBookEntry(
  account: Address,
  address: Address,
  label: string,
): AddressBookEntry[] {
  const current = readAddressBook(account).filter(
    (e) => e.address.toLowerCase() !== address.toLowerCase(),
  );
  const next = [{ address, label, addedAt: Date.now() }, ...current];
  write(account, next);
  return next;
}

export function removeAddressBookEntry(account: Address, address: Address): AddressBookEntry[] {
  const next = readAddressBook(account).filter(
    (e) => e.address.toLowerCase() !== address.toLowerCase(),
  );
  write(account, next);
  return next;
}

export interface AddressBookState {
  readonly entries: readonly AddressBookEntry[];
  add: (address: Address, label: string) => void;
  remove: (address: Address) => void;
}

export function useAddressBook(account: Address | undefined): AddressBookState {
  const [entries, setEntries] = useState<readonly AddressBookEntry[]>([]);

  useEffect(() => {
    if (!account) {
      setEntries([]);
      return;
    }
    const reload = () => setEntries(readAddressBook(account));
    reload();
    window.addEventListener('storage', reload);
    window.addEventListener(CHANGED, reload);
    return () => {
      window.removeEventListener('storage', reload);
      window.removeEventListener(CHANGED, reload);
    };
  }, [account]);

  const add = useCallback(
    (address: Address, label: string) => {
      if (account) setEntries(addAddressBookEntry(account, address, label));
    },
    [account],
  );
  const remove = useCallback(
    (address: Address) => {
      if (account) setEntries(removeAddressBookEntry(account, address));
    },
    [account],
  );

  return { entries, add, remove };
}
