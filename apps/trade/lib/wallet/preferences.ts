'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Address } from 'viem';

/**
 * Wallet settings (spec §4.6), persisted per account in `localStorage`, following
 * the exact convention `notifications.ts` and `activityStore.ts` already use: one
 * JSON blob per account keyed by its lowercased address, read defensively so a
 * blocked or corrupt store degrades to defaults instead of throwing.
 *
 * `soundsEnabled` is the single field the header toggle and the Wallet settings
 * toggle both read and write — two controls over one preference, not two
 * preferences that can disagree (spec §7).
 */

export interface WalletPreferences {
  readonly autoMoveArrivals: boolean;
  readonly showValuesInAusd: boolean;
  readonly soundsEnabled: boolean;
  readonly hideSmallBalances: boolean;
  /** Keep tokens no registry source lists collapsed under "Unlisted tokens" (spec A3). Display only. */
  readonly hideUnlisted: boolean;
}

/** Sound is on by default (spec §7) and unlisted tokens start hidden (spec A3);
 *  everything else starts off until the account turns it on. */
export const DEFAULT_WALLET_PREFERENCES: WalletPreferences = {
  autoMoveArrivals: false,
  showValuesInAusd: false,
  soundsEnabled: true,
  hideSmallBalances: false,
  hideUnlisted: true,
};

const CHANGED = 'tradepro:walletPreferences';

function key(account: Address): string {
  return `tradepro.wallet.prefs.${account.toLowerCase()}`;
}

export function readWalletPreferences(account: Address): WalletPreferences {
  try {
    const raw = window.localStorage.getItem(key(account));
    if (!raw) return DEFAULT_WALLET_PREFERENCES;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_WALLET_PREFERENCES;
    const p = parsed as Partial<Record<keyof WalletPreferences, unknown>>;
    const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
    return {
      autoMoveArrivals: bool(p.autoMoveArrivals, DEFAULT_WALLET_PREFERENCES.autoMoveArrivals),
      showValuesInAusd: bool(p.showValuesInAusd, DEFAULT_WALLET_PREFERENCES.showValuesInAusd),
      soundsEnabled: bool(p.soundsEnabled, DEFAULT_WALLET_PREFERENCES.soundsEnabled),
      hideSmallBalances: bool(p.hideSmallBalances, DEFAULT_WALLET_PREFERENCES.hideSmallBalances),
      hideUnlisted: bool(p.hideUnlisted, DEFAULT_WALLET_PREFERENCES.hideUnlisted),
    };
  } catch {
    return DEFAULT_WALLET_PREFERENCES;
  }
}

function write(account: Address, prefs: WalletPreferences): void {
  try {
    window.localStorage.setItem(key(account), JSON.stringify(prefs));
    // Same-tab listeners: `storage` only fires in *other* tabs, so the header toggle
    // and the Wallet settings toggle would not see each other's write without this.
    window.dispatchEvent(new Event(CHANGED));
  } catch {
    // Storage blocked. The choice holds for this tab only.
  }
}

/** Merge `patch` onto the account's stored preferences and persist the result. */
export function writeWalletPreferences(
  account: Address,
  patch: Partial<WalletPreferences>,
): WalletPreferences {
  const next = { ...readWalletPreferences(account), ...patch };
  write(account, next);
  return next;
}

export interface WalletPreferencesState extends WalletPreferences {
  setPreference: <K extends keyof WalletPreferences>(key: K, value: WalletPreferences[K]) => void;
}

/**
 * Live-bound to one account's preferences. Reloads on this tab's own writes (the
 * `CHANGED` event) and on another tab's writes (the `storage` event), so the header
 * toggle and the Wallet settings toggle stay in step wherever they are mounted.
 */
export function useWalletPreferences(account: Address | undefined): WalletPreferencesState {
  const [prefs, setPrefs] = useState<WalletPreferences>(DEFAULT_WALLET_PREFERENCES);

  useEffect(() => {
    if (!account) {
      setPrefs(DEFAULT_WALLET_PREFERENCES);
      return;
    }
    const reload = () => setPrefs(readWalletPreferences(account));
    reload();
    window.addEventListener('storage', reload);
    window.addEventListener(CHANGED, reload);
    return () => {
      window.removeEventListener('storage', reload);
      window.removeEventListener(CHANGED, reload);
    };
  }, [account]);

  const setPreference = useCallback(
    <K extends keyof WalletPreferences>(prefKey: K, value: WalletPreferences[K]) => {
      if (!account) {
        // Signed out: nothing to key storage by. The choice holds in memory for
        // this render only, which is honest — there is no account to persist it to.
        setPrefs((current) => ({ ...current, [prefKey]: value }));
        return;
      }
      setPrefs(writeWalletPreferences(account, { [prefKey]: value } as Partial<WalletPreferences>));
    },
    [account],
  );

  return { ...prefs, setPreference };
}
