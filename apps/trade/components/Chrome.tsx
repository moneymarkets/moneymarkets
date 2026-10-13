'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { LiveStatus, LiveStatusProvider } from './LiveStatus';
import type { ReactNode } from 'react';
import {
  ActivityIcon,
  AppShell,
  Button,
  CopyIcon,
  Toast,
  FundIcon,
  HomeIcon,
  MoonIcon,
  MoreIcon,
  PortfolioIcon,
  Sheet,
  SettingsIcon,
  SoundIcon,
  SoundOffIcon,
  SunIcon,
  TradeIcon,
  WalletIcon,
  type LinkLike,
  type NavEntry,
} from '@tradepro/ui';
import { BASE_PATH } from '../lib/basePath';
import { useSession } from '../lib/session';
import { useNotifications } from '../lib/notifications';
import { MOBILE_NAV, RAIL_NAV } from '../lib/wallet/nav';
import { WALLET_HOME_HREF } from '../lib/wallet/routeHrefs';
import { useWalletPreferences } from '../lib/wallet/preferences';
import { tick } from '../lib/wallet/sound';
import { shortAddress } from '../lib/format';
import { useTheme } from '../lib/theme';
import { GasChargeBanner } from './GasChargeBanner';
import { FreeActionsPill } from './FreeActionsPill';
import { isGasChargeActive, useGasAllowance } from '../lib/wallet/gasCharge';

/**
 * The seven destinations of design §4 / wallet spec §2, in rail order. Activity
 * became one of them on 2026-09-09, between Trade and Portfolio, for the reasons
 * recorded in design §4; Wallet became the second one, right after Home, when the
 * Wallet tab shipped.
 *
 * Icons live here rather than in `lib/wallet/nav.ts` because that module is plain
 * data with no JSX (so it can be asserted directly in this app's JSX-free
 * `.test.ts` suite) — this map is the only place the two are joined.
 */
const ICONS: Record<string, ReactNode> = {
  '/home': <HomeIcon />,
  '/wallet': <WalletIcon />,
  '/fund': <FundIcon />,
  '/activity': <ActivityIcon />,
  '/portfolio': <PortfolioIcon />,
  '/settings': <SettingsIcon />,
};

function withIcon(route: { href: string; label: string }): NavEntry {
  // Trade's href carries a market key (`/trade/0x…`), which never matches ICONS'
  // literal keys — every other destination does, so a route with no exact match is
  // Trade and only Trade.
  return { href: route.href, label: route.label, icon: ICONS[route.href] ?? <TradeIcon /> };
}

const RAIL: readonly NavEntry[] = RAIL_NAV.map(withIcon);
const TABS: readonly NavEntry[] = MOBILE_NAV.map(withIcon);

/**
 * The tab bar's four direct links (mockup: Home, Wallet, Trade, Activity), from
 * the same `MOBILE_NAV` data as before — nothing new, just a shorter slice of it
 * so there is room for the fifth, non-route "More" tab. The two `MOBILE_NAV`
 * entries left out (Add money, Portfolio) and Settings (rail-only) move into the
 * More sheet below; every destination stays exactly where its route already is.
 */
const QUICK_TAB_HREFS = new Set(['/home', WALLET_HOME_HREF, '/activity']);
function isQuickTab(entry: NavEntry): boolean {
  return QUICK_TAB_HREFS.has(entry.href) || entry.href.startsWith('/trade');
}

/** Theme button: the top bar's sun/moon toggle, wired to the existing Appearance
 *  setting (`lib/theme.tsx`) — no new setter, the same `setChoice` Settings uses. */
function ThemeButton() {
  const { resolved, setChoice } = useTheme();
  return (
    <button
      type="button"
      className="theme-btn"
      aria-label={resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      onClick={() => setChoice(resolved === 'dark' ? 'light' : 'dark')}
    >
      {resolved === 'dark' ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

/** Top bar's account pill: address + Copy (desktop only — `.acct` hides itself
 *  under 720px, same as the mockup). Copy reuses the app-wide toast. */
function AccountPill({
  address,
  onCopied,
}: {
  address: string | undefined;
  onCopied: (message: string) => void;
}) {
  if (!address) return null;
  return (
    <span className="acct">
      <span className="addr num">{shortAddress(address)}</span>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          void navigator.clipboard
            .writeText(address)
            .then(() => onCopied('Address copied'))
            .catch(() => onCopied('Copying is blocked in this browser'));
        }}
      >
        Copy
      </Button>
    </span>
  );
}

/**
 * The desktop rail renders all seven destinations and the mobile tab bar its six
 * (`AppShell` draws both; CSS picks which is visible — see `shell.tsx`), so that is
 * thirteen `<Link>` elements mounted on every page load. Next's default
 * `prefetch="auto"` fires a full route+data prefetch for each one the moment it
 * enters the viewport, which measured as several extra seconds of background
 * `?_rsc=` traffic after the page had already rendered (C2) — the tab bar is chrome
 * people glance at, not a list of links they are about to click, so paying for
 * that many speculative full-route fetches up front is not worth the network idle
 * time it costs. `prefetch={false}` (App Router) turns off both the viewport and
 * the hover prefetch — a click still navigates instantly through the client
 * router, it just no longer warms the destination ahead of time.
 */
const nextLink: LinkLike = ({ href, className, children, ...rest }) => (
  <Link href={href} className={className} aria-current={rest['aria-current']} prefetch={false}>
    {children}
  </Link>
);

export function Chrome({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '/home';
  const session = useSession();
  const notifications = useNotifications(session.account?.address);

  /**
   * The toast, and why it is here rather than on each screen.
   *
   * A notification is raised by whichever watcher noticed the event, which may be
   * running on any screen. Putting the toast in the chrome means the user sees it
   * wherever they happen to be, and exactly once — `shown` remembers the id it has
   * already announced, so a re-render does not re-announce it.
   */
  const [shownId, setShownId] = useState<string | undefined>();
  const [toast, setToast] = useState<string | undefined>();
  const latest = notifications.latestUnread;
  const router = useRouter();

  useEffect(() => {
    if (!latest || latest.id === shownId) return;
    setShownId(latest.id);
    setToast(latest.title);
    // The toast takes itself down after four seconds (spec F1); nothing to time here.
  }, [latest, shownId]);

  // Landing on Activity is reading them: the rows are right there. It moved here from
  // Portfolio along with the list itself — the badge has to point at the screen that
  // actually answers it.
  useEffect(() => {
    if (pathname.startsWith('/activity') && notifications.unread > 0) {
      notifications.markAllRead();
    }
  }, [pathname, notifications]);

  const withBadge = (entries: readonly NavEntry[]) =>
    entries.map((entry) =>
      entry.href === '/activity' && notifications.unread > 0
        ? { ...entry, badge: notifications.unread }
        : entry,
    );
  const rail = withBadge(RAIL);
  const tabs = withBadge(TABS);
  // The tab bar's four direct links; the rest surface in the "More" sheet below
  // (same destinations, same routes — see `isQuickTab`'s doc comment).
  const quickTabs = tabs.filter(isQuickTab);
  const settingsRoute = RAIL_NAV.find((entry) => entry.href === '/settings');
  const moreLinks = [
    ...tabs.filter((entry) => !isQuickTab(entry)),
    ...(settingsRoute ? [withIcon(settingsRoute)] : []),
  ];

  // Sounds and haptics (spec §7): on by default, persisted per account, mirrored
  // between this header toggle and the same row in Wallet settings — one
  // preference, two controls, never two independent toggles. The reskin drops the
  // top-bar shortcut to it (mobile top bar is now ring + theme only, per the
  // redesign brief); it stays reachable here, in the More sheet, and in Wallet
  // settings — never fewer places than before.
  const prefs = useWalletPreferences(session.account?.address);

  // One free-actions read for the whole chrome (B4): the header pill and the
  // banner below share it, so they can never disagree about the count.
  const gas = useGasAllowance(session.account?.address);

  const [moreOpen, setMoreOpen] = useState(false);
  const address = session.account?.address;

  // One footer row (desktop) and the More sheet (mobile): the live gate and build id,
  // the fee lane from the same allowance read as the pill (never a fixed "Paid for
  // you": once free actions are used, fees are charged at cost), and where reads come from.
  const footerStatus = (
    <>
      <LiveStatus />
      <span>
        Network fees{' '}
        <b>{isGasChargeActive(gas.allowance) ? 'Charged at cost' : 'Paid for you'}</b>
      </span>
      <span>Reading Monad directly</span>
    </>
  );

  return (
    // One `/api/status` poll for everything under the chrome — the footer below and
    // any screen that also calls `useLiveStatus()` (the trade ticket, the funding
    // card, settings) all read the same fetch instead of each opening its own.
    <LiveStatusProvider>
      <AppShell
        nav={rail}
        mobileNav={quickTabs}
        more={{
          label: 'More',
          icon: <MoreIcon />,
          onClick: () => setMoreOpen(true),
          current: moreLinks.some((entry) => pathname.startsWith(entry.href)),
        }}
        pathname={pathname}
        wordmark="MoneyMarkets"
        wordmarkAccent="Markets"
        logo={{ light: `${BASE_PATH}/logo.svg`, dark: `${BASE_PATH}/logo-on-dark.svg` }}
        link={nextLink}
        status={footerStatus}
        topRight={
          <>
            <FreeActionsPill allowance={gas.allowance} />
            <AccountPill address={address} onCopied={setToast} />
            <ThemeButton />
          </>
        }
      >
        {/* App-wide (not just Wallet): B4's low-actions and used-up banners, off the
            same allowance read as the header pill. */}
        <GasChargeBanner address={session.account?.address} allowance={gas.allowance} />
        {children}
        {/* Tapping the toast dismisses it (spec F1). "View" goes to the row it is
            about — the notification and the activity row share an id, so there is
            always something to land on. Two controls, two meanings. */}
        <Toast
          message={toast ?? ''}
          show={toast !== undefined}
          onDismiss={() => setToast(undefined)}
          action={{
            label: 'View',
            onClick: () => {
              setToast(undefined);
              router.push(latest?.href ?? '/portfolio');
            },
          }}
        />
      </AppShell>
      {/* Mobile-only "More" sheet (redesign PWA spec): the two tab-bar destinations
          that did not fit, plus Settings, plus the account address and the footer
          status — every one of them a link or control that already exists
          elsewhere, just reachable one more way on a narrow screen. */}
      <Sheet open={moreOpen} onClose={() => setMoreOpen(false)} labelledBy="more-sheet-title">
        <h3 id="more-sheet-title">More</h3>
        <nav className="list" aria-label="More destinations" style={{ marginTop: 14 }}>
          {moreLinks.map((entry) => (
            <Link
              key={entry.href}
              href={entry.href}
              className="row"
              onClick={() => setMoreOpen(false)}
              aria-current={pathname.startsWith(entry.href) ? 'page' : undefined}
            >
              <span className="navicon">{entry.icon}</span>
              <span className="grow t">{entry.label}</span>
            </Link>
          ))}
        </nav>
        <hr className="sep" />
        <div className="row">
          <span className="grow">
            <span className="t" style={{ display: 'block' }}>
              Your account
            </span>
            <span className="s num" style={{ display: 'block' }}>
              {address ? shortAddress(address) : '—'}
            </span>
          </span>
          {address ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void navigator.clipboard
                  .writeText(address)
                  .then(() => setToast('Address copied'))
                  .catch(() => setToast('Copying is blocked in this browser'));
              }}
            >
              <CopyIcon /> Copy
            </Button>
          ) : null}
        </div>
        <button
          type="button"
          className="row"
          aria-pressed={prefs.soundsEnabled}
          onClick={() => {
            const next = !prefs.soundsEnabled;
            tick(next);
            prefs.setPreference('soundsEnabled', next);
          }}
          style={{ width: '100%' }}
        >
          <span className="navicon">{prefs.soundsEnabled ? <SoundIcon /> : <SoundOffIcon />}</span>
          <span className="grow t" style={{ textAlign: 'left' }}>
            Sounds and haptics
          </span>
          <span className="s">{prefs.soundsEnabled ? 'On' : 'Off'}</span>
        </button>
        <hr className="sep" />
        <div className="footer-status">{footerStatus}</div>
      </Sheet>
    </LiveStatusProvider>
  );
}
