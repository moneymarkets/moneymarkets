'use client';

import { useCallback, useEffect, useState } from 'react';
import { getAddress, isAddress, type Address } from 'viem';

/**
 * Tokens the user added by contract address (spec A2c), per account, in
 * `localStorage`: addresses only, nothing else. The server keeps the authoritative
 * copy (`POST /api/account/tokens`); this list is what lets the row render on the very
 * next balance poll through `?extraTokens=` instead of waiting for the server's own set
 * to be read. Same defensive-read convention as `preferences.ts`.
 */

const CHANGED = 'tradepro:addedTokens';

function key(account: Address): string {
  return `tradepro.wallet.addedTokens.${account.toLowerCase()}`;
}

export function readAddedTokens(account: Address): Address[] {
  try {
    const raw = window.localStorage.getItem(key(account));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: Address[] = [];
    const seen = new Set<string>();
    for (const v of parsed) {
      if (typeof v !== 'string' || !isAddress(v)) continue;
      const a = getAddress(v);
      if (seen.has(a.toLowerCase())) continue;
      seen.add(a.toLowerCase());
      out.push(a);
    }
    return out;
  } catch {
    return [];
  }
}

function write(account: Address, tokens: readonly Address[]): void {
  try {
    window.localStorage.setItem(key(account), JSON.stringify(tokens));
    window.dispatchEvent(new Event(CHANGED));
  } catch {
    // Storage blocked. The addition holds for this tab only.
  }
}

/** Pure: the list with `address` added once, checksummed. Throws on a non-address. */
export function withAddedToken(tokens: readonly Address[], address: string): Address[] {
  if (!isAddress(address)) throw new Error('not an address');
  const a = getAddress(address);
  if (tokens.some((t) => t.toLowerCase() === a.toLowerCase())) return [...tokens];
  return [...tokens, a];
}

export function addAddedToken(account: Address, address: string): Address[] {
  const next = withAddedToken(readAddedTokens(account), address);
  write(account, next);
  return next;
}

export function removeAddedToken(account: Address, address: Address): Address[] {
  const next = readAddedTokens(account).filter((t) => t.toLowerCase() !== address.toLowerCase());
  write(account, next);
  return next;
}

export function useAddedTokens(account: Address | undefined): {
  readonly tokens: readonly Address[];
  readonly add: (address: string) => void;
  readonly remove: (address: Address) => void;
} {
  const [tokens, setTokens] = useState<readonly Address[]>([]);

  useEffect(() => {
    if (!account) {
      setTokens([]);
      return;
    }
    const reload = () => setTokens(readAddedTokens(account));
    reload();
    window.addEventListener('storage', reload);
    window.addEventListener(CHANGED, reload);
    return () => {
      window.removeEventListener('storage', reload);
      window.removeEventListener(CHANGED, reload);
    };
  }, [account]);

  const add = useCallback(
    (address: string) => {
      if (!account) return;
      setTokens(addAddedToken(account, address));
    },
    [account],
  );
  const remove = useCallback(
    (address: Address) => {
      if (!account) return;
      setTokens(removeAddedToken(account, address));
    },
    [account],
  );

  return { tokens, add, remove };
}
