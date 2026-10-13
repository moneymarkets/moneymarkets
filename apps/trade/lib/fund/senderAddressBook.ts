'use client';

/**
 * The "last used address" for a non-EVM source chain's sender field (D202 fix).
 *
 * This is a refund/sender address on someone else's chain, typed in once — not a
 * credential, not this app's own account. Per account and per chain, so sending
 * from Solana one time and Tron the next never cross-fills the wrong field.
 *
 * Deliberately simple compared to `addressBook.ts`: one address per chain, no
 * labels, no list — this field has exactly one job, remembering what was typed
 * last time so it is not re-typed every visit.
 */

function key(account: string, chainKey: string): string {
  return `tradepro.fund.sender.${account.toLowerCase()}.${chainKey}`;
}

export function readLastSenderAddress(account: string, chainKey: string): string | undefined {
  try {
    const raw = window.localStorage.getItem(key(account, chainKey));
    return raw && raw.trim() !== '' ? raw : undefined;
  } catch {
    return undefined;
  }
}

export function saveLastSenderAddress(account: string, chainKey: string, address: string): void {
  try {
    window.localStorage.setItem(key(account, chainKey), address);
  } catch {
    // Storage blocked — nothing persists this session, which is a safe degrade:
    // the field is simply blank next time instead of pre-filled.
  }
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const BECH32 = /^bc1[a-z0-9]{11,71}$/i;

/**
 * A short, chain-specific shape check — not a checksum validator. Good enough to
 * catch a pasted EVM address, a truncated paste, or stray whitespace-free garbage
 * before it reaches a vendor that will reject it anyway; never a claim that the
 * address is real or owned by anyone in particular.
 */
export function senderAddressError(vm: 'svm' | 'tvm' | 'btc', address: string): string | undefined {
  const trimmed = address.trim();
  if (trimmed === '') return undefined;
  if (vm === 'svm') {
    if (!BASE58.test(trimmed) || trimmed.length < 32 || trimmed.length > 44) {
      return 'That doesn’t look like a Solana address.';
    }
  } else if (vm === 'tvm') {
    if (!trimmed.startsWith('T') || !BASE58.test(trimmed) || trimmed.length !== 34) {
      return 'That doesn’t look like a Tron address.';
    }
  } else if (vm === 'btc') {
    if (!BECH32.test(trimmed) && !(BASE58.test(trimmed) && trimmed.length >= 25 && trimmed.length <= 35)) {
      return 'That doesn’t look like a Bitcoin address.';
    }
  }
  return undefined;
}
