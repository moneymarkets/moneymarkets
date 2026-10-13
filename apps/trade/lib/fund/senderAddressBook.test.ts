import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readLastSenderAddress, saveLastSenderAddress, senderAddressError } from './senderAddressBook';

/**
 * The refill bug (D202) was `RoutePicker`'s own `useEffect` re-firing on every change
 * to the field it was supposed to only ever fill once — not a defect in this module.
 * What this module needs tested is the contract `RoutePicker` is built on: storage is
 * per account and per chain, a read never throws, and the shape check used to gate the
 * inline error is right for each non-EVM chain it is asked about.
 */

class FakeStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

const ACCOUNT = '0x714f169Fe2D3990961B534D573f9646c037586E6';
const SOLANA = 'AmRKSc6fbvA6YSsrVRVHkDgEW2xiD7qxSu14wrstUaFR';
const TRON = 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7';

describe('senderAddressBook: storage', () => {
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = { localStorage: new FakeStorage() };
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('starts blank for a chain nothing has been saved for yet', () => {
    expect(readLastSenderAddress(ACCOUNT, 'solana')).toBeUndefined();
  });

  it('round-trips what was saved, for that account and that chain', () => {
    saveLastSenderAddress(ACCOUNT, 'solana', SOLANA);
    expect(readLastSenderAddress(ACCOUNT, 'solana')).toBe(SOLANA);
  });

  it('keeps Solana and Tron apart for the same account — sending from one never pre-fills the other', () => {
    saveLastSenderAddress(ACCOUNT, 'solana', SOLANA);
    saveLastSenderAddress(ACCOUNT, 'tron', TRON);
    expect(readLastSenderAddress(ACCOUNT, 'solana')).toBe(SOLANA);
    expect(readLastSenderAddress(ACCOUNT, 'tron')).toBe(TRON);
  });

  it('keeps two accounts apart on the same browser', () => {
    saveLastSenderAddress(ACCOUNT, 'solana', SOLANA);
    expect(readLastSenderAddress('0x0000000000000000000000000000000000000001', 'solana')).toBeUndefined();
  });

  it('a read with no window (SSR, or storage blocked) degrades to blank rather than throwing', () => {
    delete (globalThis as { window?: unknown }).window;
    expect(() => readLastSenderAddress(ACCOUNT, 'solana')).not.toThrow();
    expect(readLastSenderAddress(ACCOUNT, 'solana')).toBeUndefined();
  });
});

describe('senderAddressBook: senderAddressError', () => {
  it('accepts a blank address — nothing to validate before anything has been typed', () => {
    expect(senderAddressError('svm', '')).toBeUndefined();
    expect(senderAddressError('svm', '   ')).toBeUndefined();
  });

  it('accepts a real-shaped Solana address, rejects an EVM one pasted into it', () => {
    expect(senderAddressError('svm', SOLANA)).toBeUndefined();
    expect(senderAddressError('svm', '0x714f169Fe2D3990961B534D573f9646c037586E6')).toBeDefined();
  });

  it('accepts a real-shaped Tron address, rejects one missing the leading T', () => {
    expect(senderAddressError('tvm', TRON)).toBeUndefined();
    expect(senderAddressError('tvm', TRON.slice(1))).toBeDefined();
  });

  it('accepts both Bitcoin address shapes it is told to expect', () => {
    expect(senderAddressError('btc', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')).toBeUndefined();
    expect(senderAddressError('btc', '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2')).toBeUndefined();
  });

  it('rejects a truncated paste', () => {
    expect(senderAddressError('svm', SOLANA.slice(0, 10))).toBeDefined();
  });
});
