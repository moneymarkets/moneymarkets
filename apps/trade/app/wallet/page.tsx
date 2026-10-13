'use client';

import Link from 'next/link';
import { Suspense, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  Button,
  Card,
  Chip,
  Disclosure,
  LiveAmount,
  Row,
  Segmented,
  Skeleton,
  Toast,
  Toggle,
  useRipple,
  useRowFlash,
} from '@tradepro/ui';
import { formatAusd, MAINNET, MONAD_DELEGATED_RESERVE_WEI } from '@tradepro/core';
import type { Address } from 'viem';
import { Chrome } from '../../components/Chrome';
import { SignedOut } from '../../components/SignedOut';
import { FailureNotice } from '../../components/FailureNotice';
import { TokenIcon } from '../../components/TokenIcon';
import { UnlistedTokensCard } from '../../components/UnlistedTokensCard';
import { splitListed, unlistedGroupState } from '../../lib/wallet/holdingsModel';
import { useSession } from '../../lib/session';
import { useAccountBalances } from '../../lib/useAccountBalances';
import { useActivity } from '../../lib/activity';
import { useWalletPreferences } from '../../lib/wallet/preferences';
import { kuruTradedTokens, useTokenRegistry } from '../../lib/useTokenRegistry';
import { failure } from '../../lib/failures';
import { displayDp, formatMoney } from '../../lib/format';
import { statusLabel, statusTone } from '../../lib/activityView';
import { TRADING_MARKETS } from '../../lib/markets';
import { maxNativeSpend } from '../../lib/wallet/swapPlan';
import { tick } from '../../lib/wallet/sound';
import {
  WALLET_RECEIVE_HREF,
  WALLET_SEND_HREF,
  WALLET_SETTINGS_HREF,
  WALLET_SWAP_HREF,
} from '../../lib/wallet/routeHrefs';
import {
  allPriced,
  isMoveOutDisabled,
  sortHoldings,
  totalUsd,
  visibleHoldings,
  waitingToken,
  type HoldingsSegment,
  type WalletTokenEntry,
} from '../../lib/wallet/holdings';
import { MoveSheet, type MoveDirection } from './MoveSheet';
import { WaitingCard } from './WaitingCard';
import { approximateFeeDollars, useGasAllowance } from '../../lib/wallet/gasCharge';
import { apiUrl } from '../../lib/basePath';
import './wallet.css';

/**
 * `/wallet` — Wallet home (wallet spec §4.1).
 *
 * Every figure comes from `useAccountBalances`, the app's single balance source —
 * never a second, disagreeing read of the same account. Deep links: `?token=` opens
 * that holding expanded, `?move=in`/`?move=out` opens the Move sheet in that
 * direction (spec §2), read once on load; the sheet's own Back/close controls the
 * rest, rather than fighting a two-way URL sync for a bottom sheet.
 */
function WalletHome() {
  const session = useSession();
  const account = session.account;
  const params = useSearchParams();

  const balances = useAccountBalances(account?.address);
  const activity = useActivity(account?.address);
  const gas = useGasAllowance(account?.address);
  const prefs = useWalletPreferences(account?.address);
  const registry = useTokenRegistry();

  const [segment, setSegment] = useState<HoldingsSegment>('all');
  const [expanded, setExpanded] = useState<string | undefined>(params?.get('token') ?? undefined);
  const [toast, setToast] = useState<string | undefined>();
  const [flashSymbol, setFlashSymbol] = useState<string | undefined>();

  const [moveOpen, setMoveOpen] = useState(false);
  const [moveDirection, setMoveDirection] = useState<MoveDirection>('in');
  const [moveSymbol, setMoveSymbol] = useState<string | undefined>();

  // Add token by address, inline on this page (spec: "Add token by address...
  // expanding in place"). Same `POST /api/account/tokens` contract
  // `TokenSelectorSheet`'s own `addPasted` already calls — not a second mechanism.
  const [addOpen, setAddOpen] = useState(false);
  const [addValue, setAddValue] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | undefined>();

  const ripple = useRipple();
  const rowFlash = useRowFlash();

  // A freshly-landed activity row, so it can slide in once (spec: "the new activity
  // row slides in. Trigger this only after the existing move succeeds."). Purely a
  // display flag over the existing `activity.rows` the Recent card already renders —
  // it fetches nothing of its own.
  const justMovedRef = useRef(false);
  const prevTopActivityId = useRef<string | undefined>(undefined);
  const [freshActivityId, setFreshActivityId] = useState<string | undefined>();

  // Deep links, read once: `?move=in`/`?move=out` opens the sheet on load.
  useEffect(() => {
    const move = params?.get('move');
    if (move === 'in' || move === 'out') {
      setMoveDirection(move);
      setMoveOpen(true);
    }
    // Intentionally empty deps: this reads the URL the page was opened with, once —
    // it must not re-fire every time `params` changes identity on navigation.
  }, []);

  const tokens = balances.tokens ?? [];
  const priced = allPriced(tokens, 'all');
  // Listed tokens fill the main list; tokens no registry source names sit in their own
  // collapsed group below it (spec A3), with the same actions.
  const { listed: listedTokens } = splitListed(tokens);
  const unlisted = unlistedGroupState(tokens, prefs);

  // v2.1 spec 1.3: only a movable token waits — one Kuru's MarginAccount accepts
  // (permit, or the D2 approve triple on a Kuru-traded token). Native MON is not an
  // ERC-20 and never waits. Computed here (not only inside the loading branch) so the
  // matching holdings row can render its own inline box (spec: "instead of the big
  // banner") rather than a separate section above Holdings.
  const kuruTraded = new Set(kuruTradedTokens(registry.tokens).map((t) => t.address.toLowerCase()));
  const waiting = waitingToken(
    tokens,
    (t) =>
      t.address.toLowerCase() !== '0x0000000000000000000000000000000000000000' &&
      kuruTraded.has(t.address.toLowerCase()),
  );

  // The split bar's two shares, straight from the same `totalUsd` the two legend
  // figures already use — never a second computation of the same number.
  const tradingTotal = totalUsd(tokens, 'trading');
  const walletTotal = totalUsd(tokens, 'wallet');
  const splitSum = tradingTotal + walletTotal;
  const tradingPct = splitSum > 0n ? Number((tradingTotal * 1000n) / splitSum) / 10 : 0;

  // v2.1 spec 1.1: the ripple (and the hero's own count-up) plays on ANY balance
  // increase the poll notices — an arrival too, not only a Move made from here.
  const prevTotal = useRef<bigint | undefined>(undefined);
  useEffect(() => {
    if (balances.status !== 'ready') return;
    const total = totalUsd(tokens, 'all');
    if (prevTotal.current !== undefined && total > prevTotal.current) ripple.play();
    prevTotal.current = total;
    // `ripple` is a stable hook handle; `tokens` identity changes on every poll body.
  }, [balances.status, tokens]);

  function handleMoved(info: { readonly symbol: string }) {
    setToast(`Moved ${info.symbol}`);
    setFlashSymbol(info.symbol);
    justMovedRef.current = true;
    ripple.play();
    rowFlash.flash();
    balances.refresh();
    activity.refresh();
    window.setTimeout(() => setFlashSymbol(undefined), 1200);
  }

  // The Recent card's top row, once, right after a move actually lands in it.
  useEffect(() => {
    const topId = activity.rows[0]?.id;
    if (justMovedRef.current && topId !== undefined && topId !== prevTopActivityId.current) {
      justMovedRef.current = false;
      setFreshActivityId(topId);
      window.setTimeout(() => setFreshActivityId(undefined), 900);
    }
    prevTopActivityId.current = topId;
  }, [activity.rows]);

  async function addTokenInline() {
    if (!account) return;
    const value = addValue.trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(value)) {
      setAddError('Enter a full 0x address, 42 characters.');
      return;
    }
    setAddBusy(true);
    setAddError(undefined);
    try {
      const res = await fetch(apiUrl('/api/account/tokens'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account: account.address, address: value }),
      });
      const body = (await res.json().catch(() => undefined)) as { token?: unknown; error?: string } | undefined;
      if (!res.ok || !body?.token) {
        setAddError(
          body?.error === 'NOT_ERC20'
            ? 'That address is not an ERC-20 token contract on Monad.'
            : 'The token could not be read from its contract. Try again.',
        );
        return;
      }
      setToast('Token added to your list');
      setAddValue('');
      setAddOpen(false);
      balances.refresh();
    } catch {
      setAddError('The token could not be read from its contract. Try again.');
    } finally {
      setAddBusy(false);
    }
  }

  function openMove(direction: MoveDirection, symbol?: string) {
    setMoveDirection(direction);
    setMoveSymbol(symbol);
    setMoveOpen(true);
  }

  return (
    <Chrome>
      <div className="page pg-wallet">
        <div className="between">
          <div>
            <h1>Wallet</h1>
            <p className="small">What this account holds, and what you can do with it</p>
          </div>
        </div>

        {session.status !== 'signed-in' || !account ? (
          <SignedOut />
        ) : balances.status === 'error' ? (
          <FailureNotice failure={failure('BALANCE_UNREADABLE')} onRetry={() => balances.refresh()} />
        ) : (
          <>
            <section className="hero" style={{ position: 'relative', overflow: 'hidden' }}>
              <div className={ripple.className} />
              <div className="pg-wallet-herorow">
                <div className="rise">
                  <p className="label small">Total value</p>
                  {balances.status === 'loading' ? (
                    <div style={{ marginTop: 6 }}>
                      <Skeleton rows={1} width="60%" />
                    </div>
                  ) : (
                    <>
                      <LiveAmount formatted={formatAusd(totalUsd(tokens, 'all'))} currency="USD" />
                      {!priced ? (
                        <p className="tiny muted" style={{ marginTop: 2 }}>
                          Partial: some holdings have no price source yet.
                        </p>
                      ) : null}
                    </>
                  )}
                </div>
                <div className="pg-wallet-heroactions rise">
                  <div className="actions">
                    <Link href={WALLET_RECEIVE_HREF} style={{ textDecoration: 'none', color: 'inherit' }}>
                      <ActionButtonBody tone="up" label="Receive" subtitle="money in" icon={<ReceiveGlyph />} />
                    </Link>
                    <Link href={WALLET_SEND_HREF} style={{ textDecoration: 'none', color: 'inherit' }}>
                      <ActionButtonBody tone="down" label="Send" subtitle="to an address" icon={<SendGlyph />} />
                    </Link>
                    <Link href={WALLET_SWAP_HREF} style={{ textDecoration: 'none', color: 'inherit' }}>
                      <ActionButtonBody tone="acc" label="Swap" subtitle="change token" icon={<SwapGlyph />} />
                    </Link>
                    <button type="button" onClick={() => openMove('in')}>
                      <ActionButtonBody tone="warn" label="Move" subtitle="wallet ↔ trading" icon={<MoveGlyph />} />
                    </button>
                  </div>
                </div>
              </div>

              {balances.status === 'ready' && splitSum > 0n ? (
                <div className="rise">
                  <div
                    className="pg-wallet-splitbar"
                    role="img"
                    aria-label={`Trading balance ${formatAusd(tradingTotal)}, wallet ${formatAusd(walletTotal)}`}
                  >
                    <span style={{ flexBasis: `${tradingPct}%`, background: 'var(--trade)' }} />
                    <span style={{ flexBasis: `${100 - tradingPct}%`, background: 'var(--wallet)' }} />
                  </div>
                  <div className="split">
                    <div>
                      <div className="k">Trading balance, on Kuru</div>
                      <div className="n num">
                        <span className="cur">USD</span>
                        {formatAusd(tradingTotal)}
                      </div>
                    </div>
                    <div>
                      <div className="k">Wallet, on Monad</div>
                      <div className="n num">
                        <span className="cur">USD</span>
                        {formatAusd(walletTotal)}
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}
            </section>

            <div className="pg-wallet-grid">
            <div className="pg-wallet-col-main">
            <Card
              title="Holdings"
              action={
                <Toggle
                  checked={prefs.hideSmallBalances}
                  onChange={(next) => {
                    tick(prefs.soundsEnabled);
                    prefs.setPreference('hideSmallBalances', next);
                  }}
                  label="Hide small"
                />
              }
            >
              <div style={{ marginBottom: 12 }}>
                <Segmented
                  label="Holdings filter"
                  value={segment}
                  onChange={setSegment}
                  options={[
                    { value: 'all', label: 'All' },
                    { value: 'trading', label: 'Trading balance' },
                    { value: 'wallet', label: 'Wallet' },
                  ]}
                />
              </div>

              {balances.status === 'loading' ? (
                <Skeleton rows={4} />
              ) : (
                (() => {
                  const rows = sortHoldings(visibleHoldings(listedTokens, segment, prefs.hideSmallBalances), segment);
                  if (rows.length === 0) {
                    return (
                      <p className="small muted" style={{ padding: '8px 0' }}>
                        {tokens.length === 0
                          ? 'Nothing here yet. Add money to see it.'
                          : 'Nothing under this filter.'}
                      </p>
                    );
                  }
                  return (
                    <div className="holdings-rows">
                      {rows.map((t) => (
                        <HoldingRow
                          key={t.address}
                          token={t}
                          segment={segment}
                          expanded={expanded === t.symbol}
                          flashing={flashSymbol === t.symbol}
                          rowFlashClassName={rowFlash.className}
                          onToggle={() => setExpanded((cur) => (cur === t.symbol ? undefined : t.symbol))}
                          onMoveIn={() => openMove('in', t.symbol)}
                          onMoveOut={() => openMove('out', t.symbol)}
                          waitingNode={
                            waiting && waiting.symbol === t.symbol ? (
                              <WaitingCard
                                account={account}
                                token={waiting}
                                recentRows={activity.rows}
                                soundsEnabled={prefs.soundsEnabled}
                                onMoved={handleMoved}
                              />
                            ) : undefined
                          }
                        />
                      ))}
                    </div>
                  );
                })()
              )}
              {/* Add token by address, expanding in place (spec: "Add token by
                  address and Unlisted tokens expanding in place"). Same
                  `POST /api/account/tokens` contract as the token selector sheets'
                  own pasted-address flow. */}
              <div className="pg-wallet-holdfoot">
                <button
                  type="button"
                  className="link small"
                  aria-expanded={addOpen}
                  onClick={() => setAddOpen((v) => !v)}
                >
                  {addOpen ? 'Hide add token' : 'Add token by address'}
                </button>
                <Disclosure open={addOpen}>
                  <div className="pg-wallet-addrow">
                    <input
                      value={addValue}
                      placeholder="Paste token contract address (0x…)"
                      aria-label="Token contract address"
                      disabled={addBusy}
                      onChange={(e) => {
                        setAddValue(e.target.value);
                        setAddError(undefined);
                      }}
                    />
                    <Button variant="primary" size="sm" disabled={addBusy} onClick={() => void addTokenInline()}>
                      {addBusy ? 'Adding' : 'Add token'}
                    </Button>
                  </div>
                  {addError ? (
                    <p className="tiny" style={{ marginTop: 6, color: 'var(--down)' }}>
                      {addError}
                    </p>
                  ) : null}
                </Disclosure>
              </div>
            </Card>

            {balances.status === 'ready' ? (
              <UnlistedTokensCard
                group={unlisted}
                // Spec A3/1.4: an unlisted token's actions are IDENTICAL to a listed
                // one's — send, move either way, swap. Nothing gated on the chip.
                actions={(row) => (
                  <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {row.wallet.value > 0n ? (
                      <Button variant="ghost" size="sm" onClick={() => openMove('in', row.symbol)}>
                        Move
                      </Button>
                    ) : null}
                    {row.margin.value > 0n ? (
                      <Button variant="ghost" size="sm" onClick={() => openMove('out', row.symbol)}>
                        Withdraw
                      </Button>
                    ) : null}
                    {row.wallet.value > 0n ? (
                      <Link href={WALLET_SEND_HREF} style={{ textDecoration: 'none' }}>
                        <Button variant="ghost" size="sm">
                          Send
                        </Button>
                      </Link>
                    ) : null}
                    <Link href={WALLET_SWAP_HREF} style={{ textDecoration: 'none' }}>
                      <Button variant="ghost" size="sm">
                        Swap
                      </Button>
                    </Link>
                  </span>
                )}
              />
            ) : null}
            </div>

            <aside className="pg-wallet-col-aside">
              {gas.allowance ? (
                <Card>
                  <div className="pg-wallet-free">
                    <FreeActionsBigRing freeActions={gas.allowance.freeActions} />
                    <div>
                      <h3 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>Free actions today</h3>
                      {gas.allowance.freeActions.resetsAt ? (
                        <p className="small" style={{ margin: '4px 0 0' }}>
                          Resets{' '}
                          {new Date(gas.allowance.freeActions.resetsAt).toLocaleTimeString([], {
                            hour: 'numeric',
                            minute: '2-digit',
                          })}
                        </p>
                      ) : null}
                    </div>
                  </div>
                  <p className="small" style={{ marginTop: 10 }}>
                    <b>{gas.allowance.freeActions.remaining}</b> of {gas.allowance.freeActions.limit} left.
                    {gas.allowance.charging ? (
                      <>
                        {' '}
                        After that, gas is charged at cost from your trading balance in USDC or AUSD,
                        about {approximateFeeDollars(gas.allowance)} per action.
                      </>
                    ) : null}{' '}
                    Send and withdraw are always free.
                  </p>
                </Card>
              ) : null}

              <Card title="Recent" action={<Link href="/activity">See all activity</Link>}>
                {activity.status === 'loading' ? (
                  <Skeleton rows={3} />
                ) : activity.rows.length === 0 ? (
                  <p className="small muted" style={{ padding: '8px 0' }}>
                    Nothing yet. Actions you take show up here.
                  </p>
                ) : (
                  activity.rows.slice(0, 3).map((row) => (
                    <div key={row.id} className={row.id === freshActivityId ? 'pg-wallet-act-fresh' : undefined}>
                      <Row
                        title={row.summary}
                        subtitle={new Date(row.at).toLocaleString()}
                        trailing={<Chip tone={statusTone(row)}>{statusLabel(row)}</Chip>}
                      />
                    </div>
                  ))
                )}
              </Card>

              <div style={{ textAlign: 'center' }}>
                <Link href={WALLET_SETTINGS_HREF} className="small">
                  Wallet settings
                </Link>
              </div>
            </aside>
            </div>

            <MoveSheet
              open={moveOpen}
              onClose={() => setMoveOpen(false)}
              direction={moveDirection}
              onDirectionChange={setMoveDirection}
              account={account}
              marginAccount={MAINNET.kuru.marginAccount as Address}
              tokens={tokens}
              gasAllowance={gas.allowance}
              soundsEnabled={prefs.soundsEnabled}
              onMoved={handleMoved}
              {...(moveSymbol ? { initialSymbol: moveSymbol } : {})}
            />
          </>
        )}
      </div>
      <Toast message={toast ?? ''} show={Boolean(toast)} onDismiss={() => setToast(undefined)} />
    </Chrome>
  );
}

/** The Free actions card's own ring (spec: "free actions ring panel"), the real
 *  count and limit from the same `gas.allowance.freeActions` the top bar's pill and
 *  the fine-print sentence below it both read — never a second source. */
function FreeActionsBigRing({
  freeActions,
}: {
  readonly freeActions: { readonly used: number; readonly limit: number };
}) {
  const remaining = Math.max(0, freeActions.limit - freeActions.used);
  const r = 40;
  const c = 2 * Math.PI * r;
  const offset = freeActions.limit > 0 ? c - (c * remaining) / freeActions.limit : c;
  return (
    <div
      className="pg-wallet-bigring"
      role="img"
      aria-label={`${remaining} of ${freeActions.limit} free actions left today`}
    >
      <svg width="92" height="92" viewBox="0 0 92 92" aria-hidden="true">
        <circle className="track" cx="46" cy="46" r={r} />
        <circle className="fill" cx="46" cy="46" r={r} strokeDasharray={c} strokeDashoffset={offset} />
      </svg>
      <div className="pg-wallet-bigring-num">
        <span>{remaining}</span>
        <small>of {freeActions.limit}</small>
      </div>
    </div>
  );
}

function ActionButtonBody({
  tone,
  label,
  subtitle,
  icon,
}: {
  readonly tone: 'up' | 'down' | 'acc' | 'warn';
  readonly label: string;
  readonly subtitle: string;
  readonly icon: ReactNode;
}) {
  return (
    <>
      <span className={tone === 'acc' ? 'ic' : `ic ${tone}`}>{icon}</span>
      {label}
      <span className="s">{subtitle}</span>
    </>
  );
}

function ReceiveGlyph() {
  return (
    <svg className="i" viewBox="0 0 24 24">
      <path d="M12 3v12M6 9l6 6 6-6" />
      <path d="M4 19h16" />
    </svg>
  );
}
function SendGlyph() {
  return (
    <svg className="i" viewBox="0 0 24 24">
      <path d="M12 21V9M6 15l6-6 6 6" />
      <path d="M4 5h16" />
    </svg>
  );
}
function SwapGlyph() {
  return (
    <svg className="i" viewBox="0 0 24 24">
      <path d="M4 8h13l-3-3M20 16H7l3 3" />
    </svg>
  );
}
function MoveGlyph() {
  return (
    <svg className="i" viewBox="0 0 24 24">
      <rect x="3" y="4" width="8" height="16" rx="2" />
      <rect x="13" y="4" width="8" height="16" rx="2" />
      <path d="M11 10h2M11 14h2" />
    </svg>
  );
}

function HoldingRow({
  token,
  segment,
  expanded,
  flashing,
  rowFlashClassName,
  onToggle,
  onMoveIn,
  onMoveOut,
  waitingNode,
}: {
  readonly token: WalletTokenEntry;
  readonly segment: HoldingsSegment;
  readonly expanded: boolean;
  readonly flashing: boolean;
  readonly rowFlashClassName: string;
  readonly onToggle: () => void;
  readonly onMoveIn: () => void;
  readonly onMoveOut: () => void;
  /** The Waiting card, rendered inline under this row's own line when this token is
   *  the one waiting (spec: "the inline amber ... box ... inside that row instead of
   *  the big banner") — `undefined` for every other row. */
  readonly waitingNode?: ReactNode;
}) {
  const quantity =
    segment === 'trading' ? token.margin.value : segment === 'wallet' ? token.wallet.value : token.wallet.value + token.margin.value;
  const usd = segment === 'trading' ? token.usd.margin : segment === 'wallet' ? token.usd.wallet : token.usd.total;
  const market = TRADING_MARKETS.find((m) => m.base === token.symbol);
  const canMoveIn = token.wallet.value > 0n;
  const canMoveOut = token.margin.value > 0n && !isMoveOutDisabled(token.symbol);

  // The pocket chip(s): one for the active segment filter, or both when "All" shows
  // a token that genuinely sits in both places at once — never a guess at which one
  // "really" holds it.
  const chipFlip = flashing ? ' pg-wallet-chipflip' : undefined;
  const pocketChips: ReactNode[] = [];
  if (segment === 'trading') {
    pocketChips.push(
      <span key="t" className={chipFlip}>
        <Chip tone="trading">Trading</Chip>
      </span>,
    );
  } else if (segment === 'wallet') {
    pocketChips.push(
      <span key="w" className={chipFlip}>
        <Chip tone="wallet">Wallet</Chip>
      </span>,
    );
  } else {
    if (token.margin.value > 0n) {
      pocketChips.push(
        <span key="t" className={chipFlip}>
          <Chip tone="trading">Trading</Chip>
        </span>,
      );
    }
    if (token.wallet.value > 0n) {
      pocketChips.push(
        <span key="w" className={chipFlip}>
          <Chip tone="wallet">Wallet</Chip>
        </span>,
      );
    }
  }

  return (
    <div>
      <button
        type="button"
        className={flashing ? `row ${rowFlashClassName}` : 'row'}
        style={{ width: '100%', textAlign: 'left' }}
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <TokenIcon address={token.address} symbol={token.symbol} size={34} />
        <span className="grow" style={{ minWidth: 0 }}>
          <span className="t" style={{ display: 'block' }}>
            {token.symbol}
          </span>
          <span className="s" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {token.name}
          </span>
          {pocketChips.length > 0 ? <span className="pg-wallet-chips">{pocketChips}</span> : null}
        </span>
        <span className="num" style={{ textAlign: 'right' }}>
          <span className="t" style={{ display: 'block' }}>
            {formatMoney(quantity, token.decimals, displayDp(token.symbol, token.decimals))}
          </span>
          <span className="s" style={{ display: 'block' }}>
            {usd ? (
              `$${formatMoney(usd.value, usd.decimals, 2)}${
                token.change24h !== null ? ` ${token.change24h >= 0 ? '+' : ''}${token.change24h.toFixed(1)}%` : ''
              }`
            ) : (
              'No price available'
            )}
          </span>
          {/* Item 1: MON's wallet balance alone is not all spendable — Monad's 10
              MON reserve on a delegated account (D199) holds some of it back. */}
          {token.symbol === 'MON' && token.wallet.value > 0n ? (
            <span className="s" style={{ display: 'block' }}>
              Spendable{' '}
              {formatMoney(
                maxNativeSpend(token.wallet.value, MONAD_DELEGATED_RESERVE_WEI),
                token.decimals,
                displayDp(token.symbol, token.decimals),
              )}
            </span>
          ) : null}
        </span>
      </button>

      {waitingNode ? <div className="pg-wallet-waiting-wrap">{waitingNode}</div> : null}

      <Disclosure open={expanded}>
        <div className="expin" style={{ background: 'var(--surface-2)', borderRadius: 12, padding: 12, margin: '2px 0 10px' }}>
          <div className="split">
            <div>
              <div className="k">Trading balance</div>
              <div className="n num">
                {formatMoney(token.margin.value, token.decimals, displayDp(token.symbol, token.decimals))}
              </div>
            </div>
            <div>
              <div className="k">Wallet</div>
              <div className="n num">
                {formatMoney(token.wallet.value, token.decimals, displayDp(token.symbol, token.decimals))}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            {canMoveIn ? (
              <Button variant="soft" size="sm" onClick={onMoveIn}>
                Move to trading
              </Button>
            ) : null}
            {market ? (
              <Link href={`/trade/${market.key}`} style={{ textDecoration: 'none' }}>
                <Button variant="ghost" size="sm">
                  Trade
                </Button>
              </Link>
            ) : null}
            {canMoveOut ? (
              <Button variant="ghost" size="sm" onClick={onMoveOut}>
                {token.symbol === 'MON' ? 'Withdraw as WMON' : 'Withdraw to wallet'}
              </Button>
            ) : null}
            {token.wallet.value > 0n && token.symbol !== 'MON' ? (
              <Link href={WALLET_SEND_HREF} style={{ textDecoration: 'none' }}>
                <Button variant="ghost" size="sm">
                  Send
                </Button>
              </Link>
            ) : null}
            <Link href={WALLET_SWAP_HREF} style={{ textDecoration: 'none' }}>
              <Button variant="ghost" size="sm">
                Swap
              </Button>
            </Link>
          </div>
          {token.symbol === 'MON' && token.margin.value > 0n ? (
            <p className="tiny muted" style={{ marginTop: 8 }}>
              MON withdraws to your wallet as WMON, wrapped in the same transaction (D3).
            </p>
          ) : null}
        </div>
      </Disclosure>
    </div>
  );
}

export default function WalletPage() {
  return (
    <Suspense
      fallback={
        <Chrome>
          <div className="page">
            <h1>Wallet</h1>
            <Card>
              <Skeleton rows={4} />
            </Card>
          </div>
        </Chrome>
      }
    >
      <WalletHome />
    </Suspense>
  );
}
