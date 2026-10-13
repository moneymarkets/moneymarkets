'use client';

import Link from 'next/link';
import { useState } from 'react';
import { isAddress } from 'viem';
import { Button, Card, Chip, Field, Row, Toast, Toggle } from '@tradepro/ui';
import { Chrome } from '../../../components/Chrome';
import { SignedOut } from '../../../components/SignedOut';
import { apiUrl } from '../../../lib/basePath';
import { useSession } from '../../../lib/session';
import { useActivity } from '../../../lib/activity';
import { useAddedTokens } from '../../../lib/wallet/addedTokens';
import { useAddressBook } from '../../../lib/wallet/addressBook';
import { useWalletPreferences } from '../../../lib/wallet/preferences';
import { activityToCsv, downloadCsv } from '../../../lib/wallet/exportCsv';
import { tick } from '../../../lib/wallet/sound';
import { WALLET_HOME_HREF } from '../../../lib/wallet/routeHrefs';

/**
 * `/settings/wallet` — Wallet settings (spec §4.6), under Settings.
 *
 * Every toggle here is a local preference with no signing involved (spec §6: never
 * prompts), persisted per account in `localStorage` through
 * `lib/wallet/preferences.ts`. "Sounds and haptics" is the same preference the
 * mobile header's sound icon reads and writes — this screen and that icon are two
 * controls over one stored value, not two.
 *
 * "Back up your account" and "How fees work" are entry points, not new flows: the
 * recovery phrase export already lives at `/settings` (`showPhrase()` there, gated
 * by a fresh WebAuthn assertion every time — see that file), and network fee copy
 * is Help's to write. Both are linked, not duplicated.
 */
export default function WalletSettingsPage() {
  const session = useSession();
  const account = session.account?.address;
  const prefs = useWalletPreferences(account);
  const activity = useActivity(account);
  const book = useAddressBook(account);
  const added = useAddedTokens(account);
  const [toast, setToast] = useState<string | undefined>();
  const [tokenAddress, setTokenAddress] = useState('');
  const [tokenError, setTokenError] = useState<string | undefined>();
  const [adding, setAdding] = useState(false);

  function exportCsv() {
    const csv = activityToCsv(activity.rows);
    downloadCsv(`moneymarkets-activity-${account ?? 'account'}.csv`, csv);
    setToast(activity.rows.length === 0 ? 'Nothing to export yet' : 'Activity exported');
  }

  /**
   * Add a token by contract address (spec A2c, E5). The server reads `symbol()` and
   * `decimals()` from the contract before accepting it, so a pasted address that is not
   * an ERC-20 is refused in words rather than rendered as a row with made-up facts.
   */
  async function addToken() {
    if (!account) return;
    const value = tokenAddress.trim();
    if (!isAddress(value)) {
      setTokenError('That is not a Monad contract address');
      return;
    }
    setAdding(true);
    setTokenError(undefined);
    try {
      const res = await fetch(apiUrl('/api/account/tokens'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account, address: value }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; symbol?: string };
      if (!res.ok) {
        setTokenError(
          body.error === 'NOT_ERC20'
            ? 'That address is not a token contract'
            : 'Could not read that contract right now. Try again.',
        );
        return;
      }
      added.add(value);
      setTokenAddress('');
      setToast(`Added ${body.symbol ?? 'token'}`);
    } catch {
      setTokenError('Could not read that contract right now. Try again.');
    } finally {
      setAdding(false);
    }
  }

  return (
    <Chrome>
      <div className="page">
        <Link href="/settings" className="back">
          ‹ Settings
        </Link>
        <h1>Wallet settings</h1>
        <p className="small">Saved on this device, for this account</p>

        {session.status !== 'signed-in' || !account ? (
          <SignedOut />
        ) : (
          <>
            <Card title="Preferences" className="rise" style={{ animationDelay: '60ms' }}>
              <div className="list">
                <Row
                  title="Auto-move arrivals to trading balance"
                  subtitle="Skip the Move tap. One signature per arrival, still no gas."
                  trailing={
                    <Toggle
                      checked={prefs.autoMoveArrivals}
                      onChange={(next) => {
                        tick(prefs.soundsEnabled);
                        prefs.setPreference('autoMoveArrivals', next);
                      }}
                      label={null}
                      ariaLabel="Auto-move arrivals to trading balance"
                    />
                  }
                />
                <Row
                  title="Show values in AUSD"
                  subtitle="Instead of USD, everywhere in the Wallet tab."
                  trailing={
                    <Toggle
                      checked={prefs.showValuesInAusd}
                      onChange={(next) => {
                        tick(prefs.soundsEnabled);
                        prefs.setPreference('showValuesInAusd', next);
                      }}
                      label={null}
                      ariaLabel="Show values in AUSD"
                    />
                  }
                />
                <Row
                  title="Sounds and haptics"
                  subtitle="A soft swoosh when money moves, a tap on confirm. Same switch as the header."
                  trailing={
                    <Toggle
                      checked={prefs.soundsEnabled}
                      onChange={(next) => {
                        tick(next);
                        prefs.setPreference('soundsEnabled', next);
                      }}
                      label={null}
                      ariaLabel="Sounds and haptics"
                    />
                  }
                />
                <Row
                  title="Hide balances under $1"
                  subtitle="Dust stays out of the holdings list."
                  trailing={
                    <Toggle
                      checked={prefs.hideSmallBalances}
                      onChange={(next) => {
                        tick(prefs.soundsEnabled);
                        prefs.setPreference('hideSmallBalances', next);
                      }}
                      label={null}
                      ariaLabel="Hide balances under $1"
                    />
                  }
                />
                <Row
                  title="Hide unlisted tokens"
                  subtitle="Tokens no list names stay collapsed under Unlisted. Nothing is removed."
                  trailing={
                    <Toggle
                      checked={prefs.hideUnlisted}
                      onChange={(next) => {
                        tick(prefs.soundsEnabled);
                        prefs.setPreference('hideUnlisted', next);
                      }}
                      label={null}
                      ariaLabel="Hide unlisted tokens"
                    />
                  }
                />
              </div>
            </Card>

            <Card title="Add a token" className="rise" style={{ animationDelay: '100ms' }}>
              <p className="small" style={{ marginTop: 6 }}>
                Paste a Monad token contract address. Its symbol and decimals are read from the
                contract, and it appears in your holdings on the next refresh.
              </p>
              <div style={{ marginTop: 10 }}>
                <Field
                  id="add-token-address"
                  label="Token contract address"
                  value={tokenAddress}
                  onChange={(v) => {
                    setTokenAddress(v);
                    setTokenError(undefined);
                  }}
                  disabled={adding}
                />
              </div>
              {tokenError ? (
                <p className="tiny" style={{ marginTop: 6, color: 'var(--down)' }}>
                  {tokenError}
                </p>
              ) : null}
              <div style={{ marginTop: 10 }}>
                <Button variant="soft" size="sm" disabled={adding || tokenAddress.trim() === ''} onClick={() => void addToken()}>
                  {adding ? 'Reading the contract' : 'Add token'}
                </Button>
              </div>
              {added.tokens.length > 0 ? (
                <p className="tiny muted" style={{ marginTop: 10 }}>
                  Added on this device: {added.tokens.length} token{added.tokens.length === 1 ? '' : 's'}.
                </p>
              ) : null}
            </Card>

            <Card title="Records" className="rise" style={{ animationDelay: '140ms' }}>
              <div className="list">
                <Row
                  title="Address book"
                  subtitle={`${book.entries.length} saved recipient${book.entries.length === 1 ? '' : 's'}`}
                  trailing={
                    <Link href="/settings/wallet/address-book" style={{ textDecoration: 'none' }}>
                      <Chip>Open</Chip>
                    </Link>
                  }
                />
                <Row
                  title="Export activity as CSV"
                  subtitle="Every action this account has taken, with hashes"
                  trailing={
                    <Button variant="ghost" size="sm" onClick={exportCsv}>
                      Export
                    </Button>
                  }
                />
                <Row
                  title="Back up your account"
                  subtitle="24 words, behind Face ID. Lives on the main Settings screen."
                  trailing={
                    <Link href="/settings" style={{ textDecoration: 'none' }}>
                      <Chip>Open</Chip>
                    </Link>
                  }
                />
                <Row
                  title="How fees work"
                  subtitle="20 free actions a day, then at cost. Full explanation in Help."
                  trailing={
                    <Link href="/help" style={{ textDecoration: 'none' }}>
                      <Chip>Read</Chip>
                    </Link>
                  }
                />
              </div>
            </Card>

            <div style={{ textAlign: 'center' }}>
              <Link href={WALLET_HOME_HREF} className="small">
                Back to Wallet
              </Link>
            </div>
          </>
        )}
      </div>
      <Toast message={toast ?? ''} show={Boolean(toast)} onDismiss={() => setToast(undefined)} />
    </Chrome>
  );
}
