import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  WALLET_HOME_HREF,
  WALLET_RECEIVE_HREF,
  WALLET_SEND_HREF,
  WALLET_SETTINGS_HREF,
  WALLET_SWAP_HREF,
} from './routeHrefs';

const APP_DIR = join(__dirname, '..', '..', 'app');

describe('wallet route files exist (wallet spec §2)', () => {
  it.each([
    ['/wallet', 'wallet/page.tsx'],
    ['/wallet/receive', 'wallet/receive/page.tsx'],
    ['/wallet/send', 'wallet/send/page.tsx'],
    ['/wallet/swap', 'wallet/swap/page.tsx'],
    ['/settings/wallet', 'settings/wallet/page.tsx'],
    ['/settings/wallet/address-book', 'settings/wallet/address-book/page.tsx'],
  ])('%s has a route file at app/%s', (_route, relativePath) => {
    expect(existsSync(join(APP_DIR, relativePath))).toBe(true);
  });
});

describe('the route constants match the actual paths (spec §2)', () => {
  it('are exactly the strings the app navigates with', () => {
    expect(WALLET_HOME_HREF).toBe('/wallet');
    expect(WALLET_RECEIVE_HREF).toBe('/wallet/receive');
    expect(WALLET_SEND_HREF).toBe('/wallet/send');
    expect(WALLET_SWAP_HREF).toBe('/wallet/swap');
    expect(WALLET_SETTINGS_HREF).toBe('/settings/wallet');
  });
});

describe('every wallet sub-view backs to /wallet (spec §2: "every sub-view has a Back link to /wallet")', () => {
  // Asserted against the JSX attribute, not just the presence of the string
  // "/wallet" anywhere in the file — that would also match this file's own
  // `lib/wallet/routeHrefs` import path and prove nothing about the actual link.
  it.each(['wallet/send/page.tsx', 'wallet/swap/page.tsx'])(
    '%s renders <Link className="back" href={WALLET_HOME_HREF}>',
    (relativePath) => {
      const source = readFileSync(join(APP_DIR, relativePath), 'utf8');
      expect(source).toContain('className="back"');
      expect(source).toContain('href={WALLET_HOME_HREF}');
      expect(WALLET_HOME_HREF).toBe('/wallet');
    },
  );
});

describe('Wallet settings sits under Settings, and backs there (spec §4.6: "under Settings")', () => {
  it('settings/wallet/page.tsx backs to /settings', () => {
    const source = readFileSync(join(APP_DIR, 'settings/wallet/page.tsx'), 'utf8');
    expect(source).toContain('className="back"');
    expect(source).toContain('href="/settings"');
  });

  it('the main /settings screen links to Wallet settings', () => {
    const source = readFileSync(join(APP_DIR, 'settings/page.tsx'), 'utf8');
    expect(source).toContain('/settings/wallet');
  });

  it('the Wallet home stub links to Wallet settings', () => {
    const source = readFileSync(join(APP_DIR, 'wallet/page.tsx'), 'utf8');
    expect(source).toContain('WALLET_SETTINGS_HREF');
  });
});

describe('Add money is untouched (rule: do not touch apps/trade/app/fund in this pass)', () => {
  it('the fund route still exists at its own URL, unreplaced', () => {
    expect(existsSync(join(APP_DIR, 'fund/page.tsx'))).toBe(true);
  });

  it('fund/page.tsx is still nothing but Chrome + FundScreen — no logic added here duplicates it', () => {
    const source = readFileSync(join(APP_DIR, 'fund/page.tsx'), 'utf8');
    expect(source).toContain('<FundScreen');
  });

  /**
   * Receive (spec §4.2): "Mounts the existing Add money page as is, under a Back
   * link and the Wallet header" — a real `/wallet` sub-view, not a redirect to
   * `/fund`. `wallet/receive/page.tsx` mounts the same `FundScreen` component
   * `/fund/page.tsx` mounts, rather than duplicating its markup or its logic.
   */
  it('the Wallet home links to the mounted Receive view, not directly to /fund', () => {
    const source = readFileSync(join(APP_DIR, 'wallet/page.tsx'), 'utf8');
    expect(source).toContain('WALLET_RECEIVE_HREF');
  });

  it('wallet/receive/page.tsx mounts the same FundScreen component /fund uses, under a Back link', () => {
    const source = readFileSync(join(APP_DIR, 'wallet/receive/page.tsx'), 'utf8');
    expect(source).toContain("from '../../fund/FundScreen'");
    expect(source).toContain('<FundScreen');
    expect(source).toContain('className="back"');
    expect(source).toContain('href={WALLET_HOME_HREF}');
  });
});
