'use client';

import Link from 'next/link';

import { useCallback, useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Button, Card, Chip, Notice, Passkey, Row, Segmented, Sheet, Toast } from '@tradepro/ui';
import { exportMnemonic, type StoredAccount } from '@tradepro/core';
import { Chrome } from '../../components/Chrome';
import { SignedOut } from '../../components/SignedOut';
import { messageForSignInError, RP_ID, useSession } from '../../lib/session';
import { useAccountBalances } from '../../lib/useAccountBalances';
import { formatMoney, shortAddress, sumAusd, toAusdEquivalent } from '../../lib/format';
import {
  CLOSED,
  close as closePhrase,
  failed,
  holdsWords,
  open as openPhrase,
  reveal as revealPhrase,
  shown,
  type PhraseState,
} from '../../lib/recoveryPhrase';
import { useTheme } from '../../lib/theme';
import { useLiveStatus } from '../../components/LiveStatus';
import { SponsoredNote } from '../../components/SponsoredNote';
import './settings.css';

/**
 * `/settings` — address, recovery phrase, signing sessions, fees (design 5.6).
 *
 * The recovery phrase is gated by a **fresh** WebAuthn assertion, by construction:
 * `exportMnemonic()` re-derives it from a new PRF evaluation on every call, so there
 * is nothing cached anywhere to leak and no path to the words that skips the passkey.
 *
 * Everything else rule A4 asks for is in `lib/recoveryPhrase.ts`, where it can be
 * tested: the words exist in exactly one phase, that phase always begins blurred,
 * only an explicit tap un-blurs it, and closing drops the field rather than emptying
 * it. The screen adds the last piece — the phrase is dropped on a route change as
 * well as on unmount, so navigating away with the sheet open cannot leave it held.
 *
 * It is never logged and never sent anywhere: no call in this file passes the words
 * to `console`, to storage, or to `fetch`.
 *
 * The word count is twenty-four, not the twelve the design draws: Mera's PRF output
 * is 32 bytes and 32 bytes of BIP-39 entropy is a 24-word phrase. See DECISIONS.md
 * D16.
 */

/** The seven sections (design §5.6), in nav order. Each `id` anchors a `.set-sec`
 *  wrapper below, which the scroll-spy observes to highlight the section in view. */
const SECTIONS = [
  { id: 'set-account', label: 'Account' },
  { id: 'set-wallet', label: 'Wallet' },
  { id: 'set-look', label: 'Appearance' },
  { id: 'set-backup', label: 'Back up' },
  { id: 'set-sessions', label: 'Signing sessions' },
  { id: 'set-fees', label: 'Fees' },
  { id: 'set-help', label: 'Help' },
] as const;

/** Stable across renders, so the scroll-spy effect below only resets when the
 *  section list itself changes — which it never does, it is a module constant. */
const SECTION_IDS = SECTIONS.map((s) => s.id);

/** Which section is in view, for the sticky nav's `aria-current` (design §5.6's
 *  "highlighting the section in view"). Purely presentational: it never changes
 *  what is rendered, only which nav entry is marked current. */
function useActiveSection(ids: readonly string[]): string | undefined {
  const [active, setActive] = useState<string | undefined>(ids[0]);
  useEffect(() => {
    const elements = ids
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (elements.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive(entry.target.id);
        }
      },
      { rootMargin: '-30% 0px -60% 0px' },
    );
    elements.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [ids]);
  return active;
}

export default function SettingsPage() {
  const session = useSession();
  const theme = useTheme();
  const active = useActiveSection(SECTION_IDS);

  /**
   * Kuru's own trading fee, read from the live books rather than stated in copy.
   *
   * All four report the same figure today; if they ever disagree the range is shown
   * rather than one of them standing in for the rest. `undefined` from every book means
   * the read failed, and the chip says that instead of falling back to a comforting 0%.
   */
  const venueStatus = useLiveStatus();
  const feeBps = (venueStatus?.markets ?? [])
    .flatMap((m) => [m.takerFeeBps, m.makerFeeBps])
    .filter((v): v is string => v !== undefined)
    .map((v) => Number(v) / 100);
  const kuruFeeLabel =
    feeBps.length === 0
      ? 'Not read'
      : Math.min(...feeBps) === Math.max(...feeBps)
        ? `${Math.min(...feeBps)}%`
        : `${Math.min(...feeBps)}% to ${Math.max(...feeBps)}%`;
  const [phrase, setPhrase] = useState<PhraseState>(CLOSED);
  const [toast, setToast] = useState<string | undefined>();
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const pathname = usePathname();

  const closeSheet = useCallback(() => setPhrase(closePhrase()), []);

  /**
   * The phrase never outlives this route.
   *
   * The cleanup covers unmount; the dependency on `pathname` covers a soft
   * navigation that re-renders this component before React tears it down. Neither
   * can promise the strings are collected — no browser can — but after this runs
   * there is no reference left for the app to read.
   */
  /**
   * Drop the phrase on a route change, an account switch, or a sign-out.
   *
   * Only `pathname` was watched. Switching accounts changes neither the path nor the
   * mount — `adopt()` swaps state and `status` stays `signed-in` — so person A's
   * twenty-four words stayed on screen while the page re-rendered with person B's
   * address and balance. On the shared laptop this screen's Sign out card exists for,
   * that is one person's master key shown to another.
   *
   * A4 says the phrase is cleared on route change; these are the other two ways the
   * viewer can change without one.
   */
  useEffect(() => closeSheet, [pathname, session.account?.credentialId, session.status, closeSheet]);


  async function showPhrase() {
    setPhrase(openPhrase());
    try {
      // A fresh assertion every time. There is no cached phrase to fall back on, so
      // a refused passkey means no words rather than stale ones.
      const mnemonic = await exportMnemonic({
        rpId: RP_ID,
        ...(session.credentialId ? { credentialId: session.credentialId } : {}),
      });
      setPhrase(shown(mnemonic));
    } catch (caught) {
      setPhrase(failed(messageForSignInError(caught)));
    }
  }

  async function copyAddress() {
    if (!session.account) return;
    try {
      await navigator.clipboard.writeText(session.account.address);
      setToast('Address copied');
    } catch {
      setToast('Copying is blocked in this browser');
    }
  }

  if (session.status !== 'signed-in' || !session.account) {
    return (
      <Chrome>
        <div className="page">
          <h2 style={{ paddingTop: 6 }}>Settings</h2>
          <SignedOut />
        </div>
      </Chrome>
    );
  }

  const started = session.session
    ? new Date(session.session.startedAt).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : undefined;

  return (
    <Chrome>
      <div className="page pg-settings">
        <h2 className="rise" style={{ paddingTop: 6 }}>
          Settings
        </h2>

        <div className="set-grid">
          <nav className="set-nav rise" aria-label="Settings sections">
            {SECTIONS.map((s) => (
              <a
                key={s.id}
                href={`#${s.id}`}
                aria-current={active === s.id ? 'true' : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }}
              >
                {s.label}
              </a>
            ))}
          </nav>

          <div className="stack">
            {/* Account: address, how you're signed in, every stored account, and
                Sign out — one place for everything about who is signed in, rather
                than three cards scattered down the page. */}
            <div id="set-account" className="set-sec stack rise" style={{ animationDelay: '60ms' }}>
              <Card title="Your account">
                <div className="list" style={{ marginTop: 6 }}>
                  <Row
                    title="Address"
                    subtitle={shortAddress(session.account.address)}
                    trailing={
                      <Button variant="ghost" size="sm" onClick={() => void copyAddress()}>
                        Copy
                      </Button>
                    }
                  />
                  <Row
                    title="Signed in with"
                    subtitle="Passkey on this device"
                    trailing={<Chip tone="up">Active</Chip>}
                  />
                </div>
              </Card>

              <Card title="Switch account">
                <p className="small" style={{ margin: '6px 0 8px' }}>
                  Every account this device has created or signed into. Switching asks for Face ID
                  again — nothing here is shown by just having a value stored.
                </p>
                <div className="list">
                  {session.accounts.map((stored) => (
                    <AccountRow
                      key={stored.credentialId}
                      account={stored}
                      isCurrent={stored.credentialId === session.account?.credentialId}
                      busy={session.busy}
                      onSwitch={() => void session.authenticate('any', stored.credentialId)}
                    />
                  ))}
                </div>
              </Card>

              {/* ITEM 5. `endSession` already cleared the account and kept the credential;
                  it was only ever reachable as "End" on a signing session, which is a
                  different promise. On a shared or demo laptop the absence of this was a
                  real problem. */}
              <Card title="Sign out">
                <p className="small" style={{ margin: '6px 0 10px' }}>
                  Your account stays on this device. Sign back in with your passkey.
                </p>
                {confirmSignOut ? (
                  <>
                    <Notice tone="warn">
                      Signing out locks this account until your passkey unlocks it again. Nothing is
                      deleted and no money moves.
                    </Notice>
                    <div className="grid2" style={{ marginTop: 12 }}>
                      <Button variant="ghost" block onClick={() => setConfirmSignOut(false)}>
                        Stay signed in
                      </Button>
                      <Button
                        variant="primary"
                        block
                        onClick={() => {
                          session.endSession();
                          setConfirmSignOut(false);
                          setToast('Signed out');
                        }}
                      >
                        Sign out
                      </Button>
                    </div>
                  </>
                ) : (
                  <Button variant="soft" size="sm" onClick={() => setConfirmSignOut(true)}>
                    Sign out
                  </Button>
                )}
              </Card>
            </div>

            <div id="set-wallet" className="set-sec rise" style={{ animationDelay: '100ms' }}>
              <Card title="Wallet">
                <div className="list" style={{ marginTop: 6 }}>
                  <Row
                    title="Wallet settings"
                    subtitle="Auto-move, sounds and haptics, address book, export activity"
                    trailing={
                      <Link href="/settings/wallet" style={{ textDecoration: 'none' }}>
                        <Chip>Open</Chip>
                      </Link>
                    }
                  />
                </div>
              </Card>
            </div>

            <div id="set-look" className="set-sec rise" style={{ animationDelay: '140ms' }}>
              <Card
                title="Appearance"
                action={
                  <Segmented
                    label="Appearance"
                    value={theme.choice}
                    onChange={theme.setChoice}
                    options={[
                      { value: 'system', label: 'System' },
                      { value: 'light', label: 'Light' },
                      { value: 'dark', label: 'Dark' },
                    ]}
                  />
                }
              >
                <p className="small" style={{ marginTop: 6 }}>
                  {theme.choice === 'system'
                    ? `Following your device, which is currently ${theme.resolved}.`
                    : `Always ${theme.choice}, whatever your device is set to.`}
                </p>
              </Card>
            </div>

            {/* ITEM 5a. This card used to say the phrase "imports into any standard wallet"
                and left it there, which reads as "you can get back in". Two thirds of that
                is true and the last third is the part that matters: the words reproduce the
                key, and this app cannot currently take them back — so recovery today means
                recovering INTO another wallet, with the caveats that follow. Every claim
                below was checked against `prfOutputToMnemonic` and `accountFromMnemonic` in
                core, and against D118's measured native-balance rule. */}
            <div id="set-backup" className="set-sec rise" style={{ animationDelay: '180ms' }}>
              <Card title="Back up your account">
                <p className="small" style={{ margin: '6px 0 10px' }}>
                  Your passkey is the only key to this account. The recovery phrase is the same key
                  written as 24 words, so anyone who has them has your money.
                </p>
                <div className="facts">
                  <div className="fact">
                    <b>What the words can do</b>
                    They are a standard BIP-39 phrase on the usual Ethereum derivation path, so
                    importing them into MetaMask, Rabby, a Ledger or any standard wallet reproduces
                    this exact address and its full control of your funds.
                  </div>
                  <div className="fact">
                    <b>What they cannot do yet</b>
                    This app cannot take them back — there is no sign-in with a phrase here, only
                    with your passkey. If you lose every device that has the passkey, the phrase
                    recovers your money in another wallet rather than your access to this app.
                  </div>
                  <div className="fact">
                    <b>Other wallets may warn you</b>
                    This account is delegated under EIP-7702, which means it carries code; some
                    wallets show a warning about that, and it does not stop the key from signing.
                  </div>
                  <div className="fact">
                    <b>Keep a little MON</b>
                    Nobody pays your fees outside this app, so you will need a little MON in the
                    account before it can do anything — Monad also requires a delegated account to
                    keep a MON reserve, so sending the last of it out is refused by the network.
                  </div>
                </div>
                <Button
                  variant="primary"
                  block
                  disabled={holdsWords(phrase)}
                  disabledLabel="Already showing"
                  onClick={() => void showPhrase()}
                >
                  Show recovery phrase
                </Button>
              </Card>
            </div>

            <div id="set-sessions" className="set-sec rise" style={{ animationDelay: '220ms' }}>
              <Card title="Signing sessions">
                <p className="small" style={{ margin: '6px 0 8px' }}>
                  A session lets you trade for a while without Face ID on every order. End one to
                  require it again.
                </p>
                <div className="list">
                  <Row
                    title={session.session?.device ?? 'This browser'}
                    subtitle={started ? `Started ${started}` : 'Started this visit'}
                    trailing={
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          session.endSession();
                          setToast('Session ended');
                        }}
                      >
                        End
                      </Button>
                    }
                  />
                </div>
              </Card>
            </div>

            <div id="set-fees" className="set-sec rise" style={{ animationDelay: '260ms' }}>
              <Card title="Fees">
                <div className="list" style={{ marginTop: 6 }}>
                  <Row
                    title="Monad network fees"
                    subtitle="Paid for you on every action"
                    trailing={<Chip tone="up">Free</Chip>}
                  />
                  <SponsoredNote style={{ marginTop: 0, marginBottom: 6 }} />
                  {/* Read from `getMarketParams()` per book, not typed here. It is 0 bps on
                      all four today, which is exactly why the hardcoded "0%" survived so long
                      unnoticed — and exactly why it had to go: it would have become a lie
                      silently the day Kuru set a fee. When the read fails this says so. */}
                  <Row
                    title="Kuru trading fees"
                    subtitle="Maker and taker, read from each order book"
                    trailing={<Chip>{kuruFeeLabel}</Chip>}
                  />
                  <Row
                    title="Deposit routing"
                    subtitle="Shown on every quote before you sign"
                    trailing={<Chip>Varies</Chip>}
                  />
                </div>
              </Card>
            </div>

            {/* ITEM 10. One route with the whole shape of the thing, linked from the one
                screen a stuck person opens first. */}
            <div id="set-help" className="set-sec rise" style={{ animationDelay: '300ms' }}>
              <Card title="Help">
                <div className="list" style={{ marginTop: 6 }}>
                  <Row
                    title="What this app is, and what is not working today"
                    subtitle="The contracts it uses, how recovery works, and the current limits — read live"
                    trailing={
                      <Link href="/help" style={{ textDecoration: 'none' }}>
                        <Chip>Open</Chip>
                      </Link>
                    }
                  />
                </div>
              </Card>
            </div>
          </div>
        </div>
      </div>

      <Sheet open={phrase.phase !== 'closed'} onClose={closeSheet}>
        {phrase.phase === 'confirm' ? (
          <>
            <h3>Confirm it’s you</h3>
            <p className="small" style={{ margin: '6px 0 14px' }}>
              Your passkey is required to show the recovery phrase.
            </p>
            <Passkey state="pulsing" />
          </>
        ) : null}

        {phrase.phase === 'error' ? (
          <>
            <h3>Not shown</h3>
            <div style={{ marginTop: 10 }}>
              <Notice tone="err">{phrase.message}</Notice>
            </div>
            <div style={{ marginTop: 14 }}>
              <Button variant="ghost" block onClick={closeSheet}>
                Close
              </Button>
            </div>
          </>
        ) : null}

        {phrase.phase === 'shown' ? (
          <>
            <h3>Recovery phrase</h3>
            <p className="small" style={{ margin: '6px 0 14px' }}>
              Write these twenty-four words down in order. Anyone with them controls your money.
              Never type them into a website.
            </p>
            <div className={phrase.revealed ? 'words reveal' : 'words'}>
              {phrase.words.map((word, index) => (
                <span key={`${index}-${word}`}>
                  <i>{index + 1}</i>
                  {word}
                </span>
              ))}
            </div>
            <div style={{ marginTop: 14 }}>
              <Button
                variant="ghost"
                block
                onClick={() => setPhrase((current) => revealPhrase(current))}
              >
                {phrase.revealed ? 'Shown' : 'Tap to reveal'}
              </Button>
            </div>
            <div style={{ marginTop: 8 }}>
              <Button
                variant="primary"
                block
                onClick={() => {
                  closeSheet();
                  setToast('Backed up');
                }}
              >
                I’ve written it down
              </Button>
            </div>
          </>
        ) : null}
      </Sheet>

      <Toast message={toast ?? ''} show={Boolean(toast)} onDismiss={() => setToast(undefined)} />
    </Chrome>
  );
}

/**
 * One remembered account. Its balance is a public chain read (`useAccountBalances`
 * takes only an address), so it renders without a passkey prompt; only `onSwitch`
 * needs one, and that ceremony is `session.authenticate`'s, not this component's.
 */
function AccountRow({
  account,
  isCurrent,
  busy,
  onSwitch,
}: {
  account: StoredAccount;
  isCurrent: boolean;
  busy: boolean;
  onSwitch: () => void;
}) {
  const balance = useAccountBalances(account.address);
  const marginAusd = balance.margin?.AUSD.value ?? 0n;
  const marginUsdc = balance.margin?.USDC.value ?? 0n;
  // `undefined` when a nonzero USDC margin balance has no live mid to price it at —
  // never a fabricated par figure (audit U5).
  const availableToTrade = sumAusd(marginAusd, toAusdEquivalent(marginUsdc, balance.ausdPerUsdcMid));
  const subtitle =
    balance.status === 'ready'
      ? availableToTrade === undefined
        ? // The AUSD leg is real; only the USDC leg has no live price right now —
          // shown honestly rather than guessed at par.
          `${formatMoney(marginAusd, 6)} AUSD + ${formatMoney(marginUsdc, 6)} USDC (price unavailable)`
        : `${formatMoney(availableToTrade, 6)} AUSD`
      : balance.status === 'error'
        ? 'Balance unavailable'
        : 'Loading balance…';

  return (
    <Row
      title={shortAddress(account.address)}
      subtitle={subtitle}
      trailing={
        isCurrent ? (
          <Chip tone="up">Active</Chip>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            disabledLabel="Waiting for your passkey"
            onClick={onSwitch}
          >
            Switch
          </Button>
        )
      }
    />
  );
}
