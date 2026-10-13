import type { ReactNode } from 'react';

/**
 * App chrome (redesign, design/tradepro-redesign.html): one sticky top bar at
 * every width — full nav row on desktop, compact on phone — and a fixed bottom tab
 * bar under 720px. Both are rendered; CSS decides which parts show, so there is no
 * layout flash and no client-side width measurement. This replaced a left rail at
 * ≥960px plus a separate mobile-only header row; see
 * design/REDESIGN-FOUNDATION.md for the class contracts this file now renders.
 *
 * Links are injected rather than imported. `packages/ui` must not depend on Next's
 * router — `apps/market-kit` uses the same components — so the app passes whichever
 * link component it has and the default is a plain anchor.
 */

export interface NavEntry {
  readonly href: string;
  readonly label: string;
  readonly icon: ReactNode;
  /**
   * Unread count. Omit or pass 0 for no badge.
   *
   * A number, never a dot: "3 things happened" and "something happened" are
   * different facts, and the dot is the one that makes people open the tab to find
   * out which. Counts above 9 render as "9+" rather than widening the tab.
   */
  readonly badge?: number;
}

export interface LinkLikeProps {
  href: string;
  className?: string;
  'aria-current'?: 'page' | undefined;
  children: ReactNode;
}

export type LinkLike = (props: LinkLikeProps) => ReactNode;

const AnchorLink: LinkLike = ({ href, className, children, ...rest }) => (
  <a href={href} className={className} aria-current={rest['aria-current']}>
    {children}
  </a>
);

export interface MoreTabProps {
  readonly label: string;
  readonly icon: ReactNode;
  readonly onClick: () => void;
  /** Highlight the tab, e.g. while the current route is one the More sheet links to. */
  readonly current?: boolean;
}

export interface AppShellProps {
  /** Every destination; the top bar's nav row on desktop. */
  nav: readonly NavEntry[];
  /**
   * Phone tab bar's direct links. Defaults to `nav`. Pass a short list (the
   * mockup's phone tab bar holds four route tabs plus `more`) — destinations left
   * out need another way in, typically `more` or `mobileHeaderActions`.
   */
  mobileNav?: readonly NavEntry[];
  /**
   * The tab bar's fifth, non-route tab (mockup: "More"), a button rather than a
   * link — it opens a sheet the caller owns instead of navigating. Omit it to
   * render `mobileNav` alone with no fifth tab.
   */
  more?: MoreTabProps;
  /** Current pathname. An entry is current when the path starts with its href. */
  pathname: string;
  wordmark: string;
  /** Trailing slice of `wordmark` to render in `--trade` (e.g. "Money**Markets**").
   *  Omit for a plain, single-colour wordmark. */
  wordmarkAccent?: string;
  /** The logo mark, drawn before the wordmark. */
  mark?: string;
  link?: LinkLike;
  /** Footer status, e.g. relayer/venue health (design §4). Rendered by the caller,
   *  typically at the end of `children`, wherever the page content puts it — kept
   *  here only for a caller that wants the shell to place it for them. */
  status?: ReactNode;
  /**
   * Extra controls in the compact top bar, mobile widths only (desktop already
   * shows every destination in the nav row and every per-account control in
   * `topRight`). Hidden at desktop widths via CSS.
   */
  mobileHeaderActions?: ReactNode;
  /**
   * The top bar's right-hand cluster at every width — free-actions meter, account
   * pill, theme button (gas spec B4, design §4). An item that should disappear on
   * a phone (the account pill) hides itself via its own CSS, the same way the
   * mockup's `.acct` does, so this is one persistent slot rather than two.
   */
  topRight?: ReactNode;
  /** @deprecated use `topRight`; kept for a caller that has not moved to it. */
  counter?: ReactNode;
  children: ReactNode;
}

/**
 * A nav entry is current when it shares a first path segment with the location, so
 * `/trade/0x065c…` still lights up the Trade tab whichever market is open.
 */
function isCurrent(pathname: string, href: string): boolean {
  const segment = (value: string) => value.split('/').filter(Boolean)[0] ?? '';
  return segment(pathname) === segment(href);
}

function Badge({ count, label }: { count: number | undefined; label: string }) {
  if (!count || count <= 0) return null;
  return (
    <span className="navbadge" aria-label={`${count} unread on ${label}`}>
      {count > 9 ? '9+' : count}
    </span>
  );
}

export function AppShell({
  nav,
  mobileNav,
  more,
  pathname,
  wordmark,
  wordmarkAccent,
  mark,
  link,
  status,
  mobileHeaderActions,
  topRight,
  counter,
  children,
}: AppShellProps) {
  const Link = link ?? AnchorLink;
  const tabs = mobileNav ?? nav;
  const tabCount = tabs.length + (more ? 1 : 0);
  const activeTabIndex = (() => {
    const routeIndex = tabs.findIndex((entry) => isCurrent(pathname, entry.href));
    if (routeIndex >= 0) return routeIndex;
    return more?.current ? tabs.length : -1;
  })();
  const accentStart =
    wordmarkAccent && wordmark.endsWith(wordmarkAccent)
      ? wordmark.length - wordmarkAccent.length
      : wordmark.length;

  return (
    <div className="shell">
      <header className="topbar fade-down">
        <div className="topbar-inner">
          <span className="logo">
            {mark ? <img className="logo-mark" src={mark} alt="" width={26} height={26} /> : null}
            {wordmark.slice(0, accentStart)}
            {accentStart < wordmark.length ? <span>{wordmark.slice(accentStart)}</span> : null}
          </span>
          <nav className="topbar-nav" aria-label="Main">
            {nav.map((entry) => (
              <Link
                key={entry.href}
                href={entry.href}
                aria-current={isCurrent(pathname, entry.href) ? 'page' : undefined}
              >
                <span className="navicon">
                  {entry.label}
                  <Badge count={entry.badge} label={entry.label} />
                </span>
              </Link>
            ))}
          </nav>
          <div className="topbar-right">
            {topRight ?? counter}
            {mobileHeaderActions}
          </div>
        </div>
      </header>
      <main>
        {children}
        <nav
          className="tabbar"
          aria-label="Main"
          style={{ gridTemplateColumns: `repeat(${tabCount}, 1fr)` }}
        >
          {activeTabIndex >= 0 ? (
            <span
              className="tab-pill"
              aria-hidden="true"
              style={{
                left: 0,
                width: `${100 / tabCount}%`,
                transform: `translateX(${activeTabIndex * 100}%)`,
              }}
            />
          ) : null}
          {tabs.map((entry) => (
            <Link
              key={entry.href}
              href={entry.href}
              aria-current={isCurrent(pathname, entry.href) ? 'page' : undefined}
            >
              <span className="navicon">
                {entry.icon}
                <Badge count={entry.badge} label={entry.label} />
              </span>
              <span>{entry.label}</span>
            </Link>
          ))}
          {more ? (
            <button
              type="button"
              onClick={more.onClick}
              aria-current={more.current ? 'page' : undefined}
            >
              <span className="navicon">{more.icon}</span>
              <span>{more.label}</span>
            </button>
          ) : null}
        </nav>
      </main>
      {status ? <footer className="appfooter">{status}</footer> : null}
    </div>
  );
}

/* ---------- states every screen owes the user (rule A5) ---------- */

/** Empty state. Invites the next action (design §6); never just "nothing here". */
export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

/** Loading placeholder. No spinner, no entrance animation (rule A6). */
export function Skeleton({ rows = 3, width = '100%' }: { rows?: number; width?: string }) {
  return (
    <div aria-busy="true" aria-live="polite" style={{ padding: '10px 4px' }}>
      <span className="visually-hidden" style={{ position: 'absolute', left: -9999 }}>
        Loading
      </span>
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className="skel" style={{ width: i === rows - 1 ? '60%' : width }} />
      ))}
    </div>
  );
}

/* ---------- nav icons (design §3: 20 px, 1.8 stroke, rounded caps) ---------- */

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg className="i" viewBox="0 0 24 24" aria-hidden="true">
      {children}
    </svg>
  );
}

export function HomeIcon() {
  return (
    <Icon>
      <path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />
    </Icon>
  );
}

export function FundIcon() {
  return (
    <Icon>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}

export function TradeIcon() {
  return (
    <Icon>
      <path d="M4 17l5-6 4 3 7-9" />
      <path d="M14 5h6v6" />
    </Icon>
  );
}

/** Activity: a list, because that is what it is. */
export function ActivityIcon() {
  return (
    <Icon>
      <path d="M4 7h10M4 12h13M4 17h7" />
      <circle cx="19" cy="7" r="1.6" />
    </Icon>
  );
}

export function PortfolioIcon() {
  return (
    <Icon>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M7 14l3-3 3 2 4-5" />
    </Icon>
  );
}

export function SettingsIcon() {
  return (
    <Icon>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </Icon>
  );
}

export function CopyIcon() {
  return (
    <Icon>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </Icon>
  );
}

/** Wallet: what this account holds and what it can do with it (spec §1). */
export function WalletIcon() {
  return (
    <Icon>
      <rect x="3" y="6" width="18" height="13" rx="2.5" />
      <path d="M3 10.5h18" />
      <circle cx="16.5" cy="14.5" r="1" fill="currentColor" stroke="none" />
    </Icon>
  );
}

/** Sound on. Mirrored between the mobile header and Wallet settings (spec §7). */
export function SoundIcon() {
  return (
    <Icon>
      <path d="M4 9v6h4l5 4V5L8 9H4z" />
      <path d="M16.4 8.6a5 5 0 0 1 0 6.8" />
      <path d="M19 6a9 9 0 0 1 0 12" />
    </Icon>
  );
}

/** Sound off: same glyph, a struck line instead of the sound waves. */
export function SoundOffIcon() {
  return (
    <Icon>
      <path d="M4 9v6h4l5 4V5L8 9H4z" />
      <path d="M16 9l5 6M21 9l-5 6" />
    </Icon>
  );
}

/** Theme button, dark: a crescent (light mode is on; tap to switch to dark). */
export function MoonIcon() {
  return (
    <Icon>
      <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
    </Icon>
  );
}

/** Theme button, light: a sun (dark mode is on; tap to switch to light). */
export function SunIcon() {
  return (
    <Icon>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </Icon>
  );
}

/** The mobile tab bar's fifth tab: three dots, "More". */
export function MoreIcon() {
  return (
    <svg className="i" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <circle cx="5" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="19" cy="12" r="2" />
    </svg>
  );
}
