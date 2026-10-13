import { DEFAULT_MARKET } from '../markets';
import { WALLET_HOME_HREF } from './routeHrefs';

/**
 * The app's destinations (spec §2), as plain data with no JSX in it — `Chrome.tsx`
 * attaches icons and badges to these. Kept JSX-free and in its own `.ts` file so it
 * can be asserted directly in a Node test: `Chrome.tsx` and its icons cannot be
 * imported into this repo's `.test.ts` suite (no JSX transform is configured for
 * it — see `vitest.config.ts`), but the data driving it can.
 */
export interface NavRoute {
  readonly href: string;
  readonly label: string;
}

/**
 * Desktop rail: all seven (design §4, spec §2). Wallet sits second, right after
 * Home.
 */
export const RAIL_NAV: readonly NavRoute[] = [
  { href: '/home', label: 'Home' },
  { href: WALLET_HOME_HREF, label: 'Wallet' },
  { href: '/fund', label: 'Add money' },
  { href: `/trade/${DEFAULT_MARKET.key}`, label: 'Trade' },
  { href: '/activity', label: 'Activity' },
  { href: '/portfolio', label: 'Portfolio' },
  { href: '/settings', label: 'Settings' },
];

/**
 * Phone tab bar: six. Seven does not fit 390px with readable labels (spec §2), so
 * Settings moves to a gear icon in the mobile header instead of a seventh tab —
 * everything else on the rail stays, in the same order.
 */
export const MOBILE_NAV: readonly NavRoute[] = RAIL_NAV.filter(
  (entry) => entry.href !== '/settings',
);
