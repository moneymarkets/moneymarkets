import type { Address } from 'viem';
import type { AddressBookEntry } from './addressBook';
import { shortAddress } from '../format';

/**
 * Send's "Recent recipients" row (wallet spec §4.3): the local address book,
 * shaped for a horizontal-scroll row of chips. Pure data shaping only — the
 * component owns the DOM, this owns what goes in it, so it is testable without
 * rendering anything (this app's suite runs with no DOM; see
 * `apps/trade/vitest.config.ts`).
 */

export interface RecipientChip {
  readonly address: Address;
  /** The saved label, or a truncated address when the entry has none (the add
   *  flow at `settings/wallet/address-book` requires a label today, but this
   *  does not assume that always holds — an entry written some other way could
   *  still have an empty one). */
  readonly label: string;
  /** Up to two characters shown in the avatar. */
  readonly initials: string;
}

/** The address book keeps up to 100 entries (`addressBook.ts`'s own `LIMIT`);
 *  Send only ever needs the most recent few in a row a thumb can scan. */
const MAX_CHIPS = 12;

/**
 * Up to two characters for the avatar. A label's first two, upper-cased —
 * except a truncated-address fallback (which starts "0x"), left as it is:
 * upper-casing would print "0X", which is not how anyone writes the prefix.
 * Same rule `TokenIcon.tsx` uses for its own two-letter fallback mark.
 */
export function initialsFor(label: string): string {
  const trimmed = label.trim();
  if (trimmed === '') return '?';
  const head = trimmed.slice(0, 2);
  return head.toLowerCase() === '0x' ? head : head.toUpperCase();
}

/** `entries` newest-first, exactly as `addressBook.ts` stores them. */
export function recipientChipsFrom(entries: readonly AddressBookEntry[]): readonly RecipientChip[] {
  return entries.slice(0, MAX_CHIPS).map((entry) => {
    const label = entry.label.trim() !== '' ? entry.label.trim() : shortAddress(entry.address);
    return { address: entry.address, label, initials: initialsFor(label) };
  });
}
