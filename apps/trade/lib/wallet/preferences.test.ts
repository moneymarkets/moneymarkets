import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import {
  DEFAULT_WALLET_PREFERENCES,
  readWalletPreferences,
  writeWalletPreferences,
} from './preferences';

const ACCOUNT = '0x714f169Fe2D3990961B534D573f9646c037586E6' as Address;
const OTHER_ACCOUNT = '0x00000000000000000000000000000000000001' as Address;

class FakeStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
}

describe('wallet preferences', () => {
  let fired: string[] = [];

  beforeEach(() => {
    fired = [];
    (globalThis as { window?: unknown }).window = {
      localStorage: new FakeStorage(),
      dispatchEvent: (event: Event) => {
        fired.push(event.type);
        return true;
      },
    };
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('reads defaults for an account that has never written anything', () => {
    expect(readWalletPreferences(ACCOUNT)).toEqual(DEFAULT_WALLET_PREFERENCES);
  });

  it('sound is on by default; everything else starts off', () => {
    expect(DEFAULT_WALLET_PREFERENCES.soundsEnabled).toBe(true);
    expect(DEFAULT_WALLET_PREFERENCES.autoMoveArrivals).toBe(false);
    expect(DEFAULT_WALLET_PREFERENCES.showValuesInAusd).toBe(false);
    expect(DEFAULT_WALLET_PREFERENCES.hideSmallBalances).toBe(false);
  });

  it('writes a patch and reads it back merged with the rest', () => {
    writeWalletPreferences(ACCOUNT, { autoMoveArrivals: true });
    expect(readWalletPreferences(ACCOUNT)).toEqual({
      ...DEFAULT_WALLET_PREFERENCES,
      autoMoveArrivals: true,
    });
    // A second, unrelated patch does not clobber the first.
    writeWalletPreferences(ACCOUNT, { soundsEnabled: false });
    expect(readWalletPreferences(ACCOUNT)).toEqual({
      ...DEFAULT_WALLET_PREFERENCES,
      autoMoveArrivals: true,
      soundsEnabled: false,
    });
  });

  it('is keyed per account: one account writing never changes another', () => {
    writeWalletPreferences(ACCOUNT, { hideSmallBalances: true });
    expect(readWalletPreferences(OTHER_ACCOUNT)).toEqual(DEFAULT_WALLET_PREFERENCES);
  });

  it('is keyed case-insensitively on the address', () => {
    writeWalletPreferences(ACCOUNT, { showValuesInAusd: true });
    const upper = ACCOUNT.toUpperCase() as Address;
    expect(readWalletPreferences(upper).showValuesInAusd).toBe(true);
  });

  it('dispatches a same-tab change event so two mounted toggles stay in sync', () => {
    writeWalletPreferences(ACCOUNT, { soundsEnabled: false });
    expect(fired).toContain('tradepro:walletPreferences');
  });

  it('degrades to defaults instead of throwing when storage is blocked', () => {
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem() {
          throw new Error('blocked');
        },
        setItem() {
          throw new Error('blocked');
        },
      },
      dispatchEvent: () => true,
    };
    expect(() => readWalletPreferences(ACCOUNT)).not.toThrow();
    expect(readWalletPreferences(ACCOUNT)).toEqual(DEFAULT_WALLET_PREFERENCES);
    expect(() => writeWalletPreferences(ACCOUNT, { soundsEnabled: false })).not.toThrow();
  });

  it('ignores a corrupt stored value rather than throwing', () => {
    const storage = new FakeStorage();
    storage.setItem('tradepro.wallet.prefs.' + ACCOUNT.toLowerCase(), 'not json');
    (globalThis as { window?: unknown }).window = { localStorage: storage, dispatchEvent: () => true };
    expect(readWalletPreferences(ACCOUNT)).toEqual(DEFAULT_WALLET_PREFERENCES);
  });
});
