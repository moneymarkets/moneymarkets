import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import type { AddressBookEntry } from './addressBook';
import { initialsFor, recipientChipsFrom } from './sendRecipients';

function entry(address: Address, label: string): AddressBookEntry {
  return { address, label, addedAt: Date.now() };
}

const COLD: Address = '0x43a275C3Eb0BE7313f847FFA4fb6Bd366606A961';
const GATE: Address = '0x1fC70003B9F349C00B4239F9e3bCe5333cF31B61';

describe('recipientChipsFrom', () => {
  it('carries the saved label through as the chip label', () => {
    const chips = recipientChipsFrom([entry(COLD, 'cold')]);
    expect(chips).toHaveLength(1);
    expect(chips[0]?.label).toBe('cold');
    expect(chips[0]?.address).toBe(COLD);
    expect(chips[0]?.initials).toBe('CO');
  });

  it('falls back to a truncated address when an entry has no label', () => {
    const chips = recipientChipsFrom([entry(COLD, '')]);
    expect(chips[0]?.label).toBe('0x43a2…A961');
    expect(chips[0]?.initials).toBe('0x');
  });

  it('falls back for a whitespace-only label too', () => {
    const chips = recipientChipsFrom([entry(COLD, '   ')]);
    expect(chips[0]?.label).toBe('0x43a2…A961');
  });

  it('keeps newest-first order, exactly as the address book stores it', () => {
    const chips = recipientChipsFrom([entry(GATE, 'gate'), entry(COLD, 'cold')]);
    expect(chips.map((c) => c.label)).toEqual(['gate', 'cold']);
  });

  it('caps the row at 12 chips', () => {
    const many: AddressBookEntry[] = Array.from({ length: 20 }, (_, i) =>
      entry(`0x${(i + 1).toString(16).padStart(40, '0')}` as Address, `entry ${i}`),
    );
    expect(recipientChipsFrom(many)).toHaveLength(12);
  });

  it('returns nothing for an empty address book, so the row shows only "+ New"', () => {
    expect(recipientChipsFrom([])).toEqual([]);
  });
});

describe('initialsFor', () => {
  it('upper-cases the first two characters of a label', () => {
    expect(initialsFor('cold')).toBe('CO');
    expect(initialsFor('gate')).toBe('GA');
  });

  it('leaves a truncated-address fallback ("0x…") as it is, not "0X"', () => {
    expect(initialsFor('0x43a2…A961')).toBe('0x');
  });

  it('is "?" for an empty label', () => {
    expect(initialsFor('')).toBe('?');
    expect(initialsFor('   ')).toBe('?');
  });
});
