'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  ActionResult,
  Button,
  Card,
  Empty,
  Field,
  Notice,
  Skeleton,
  TicketState,
} from '@tradepro/ui';
import {
  assertFreshPasskey,
  buildErc20Transfer,
  buildNativeSend,
  MONAD_DELEGATED_RESERVE_WEI,
  SPONSORED_TRANSFER_TOKENS,
  type TokenInfo,
} from '@tradepro/core';
import { flyToken, confettiBurst, usePrefersReducedMotion } from '@tradepro/ui';
import { isAddress, getAddress, type Address } from 'viem';
import { TokenIcon } from '../../components/TokenIcon';
import { TokenSelectorSheet } from '../../components/TokenSelectorSheet';
import { addAddressBookEntry, readAddressBook } from '../../lib/wallet/addressBook';
import { hapticConfirmed, hapticFaceId } from '../../lib/wallet/haptics';
import { useWalletPreferences } from '../../lib/wallet/preferences';
import { ding, swoosh } from '../../lib/wallet/sound';
import { walletHoldings as walletHoldingsOf } from '../../lib/wallet/holdingsModel';
import { isNative, maxNativeSpend } from '../../lib/wallet/swapPlan';
import { Chrome } from '../../components/Chrome';
import { FailureNotice } from '../../components/FailureNotice';
import { SignedOut } from '../../components/SignedOut';
import { RP_ID, useSession } from '../../lib/session';
import { useAccountBalances } from '../../lib/useAccountBalances';
import { apiUrl } from '../../lib/basePath';
import { displayDp, formatMoney } from '../../lib/format';
import { amountToSend, fillExact, onEdit, type AmountFieldState } from '../../lib/wallet/amountField';
import { failure } from '../../lib/failures';
import { recordActivity } from '../../lib/activityStore';
import { explorerTxUrl } from '../../lib/format';
import { isTerminal, run, segmentOf, type Progress } from '../../lib/ticket';

/**
 * `/send` — the wallet balance out to any address.
 *
 * Never mentioned in the requirements or the design. A wallet you cannot send from is
 * not a wallet.
 *
 * ## What the relayer will and will not pay for
 *
 * Any ERC-20 the wallet holds, listed or not (D1, owner's decision 2026-09-25 — three
 * pinned tokens from D128 before that): `transfer` only, a recipient that is not a
 * contract this app can name, and the par notional cap on the dollar tokens whose
 * price is pinned (C2). A send outside those bounds is refused by the relayer, and
 * that refusal arrives as its own verbatim sentence.
 *
 * MON is still out of scope, and not by choice: the account is EIP-7702 delegated and
 * Monad enforces a native-balance reserve on delegated accounts (measured at 10 MON,
 * D118). The screen says so and offers WMON, which sends like any other token.
 *
 * ## The address is the dangerous part
 *
 * Everything else here is recoverable; an address is not. So: malformed refused before
 * submit, the user's own address refused, code at the destination warned about but
 * never blocked, and a review step rendering the address in three parts with the ends
 * emphasised — the middle is what an address-swapping clipboard attack leaves alone.
 */

interface Holding {
  readonly token: TokenInfo;
  readonly balance: bigint;
}

type RecipientCheck =
  | { readonly kind: 'empty' }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'self' }
  | { readonly kind: 'contract'; readonly address: Address }
  /**
   * The code read failed or has not answered yet for this address. Never rendered as
   * "ok" — a read that could not complete is not evidence the address is a plain
   * account, and saying so would be a false negative on the one check this screen
   * calls dangerous (High #17).
   */
  | { readonly kind: 'code-unknown'; readonly address: Address }
  | { readonly kind: 'ok'; readonly address: Address };

export interface SendScreenProps {
  /**
   * Controlled recipient value, paired with `onRecipientChange`. `/wallet/send`
   * passes both so a recent-recipients tap or a QR scan can fill the field from
   * outside; the plain `/send` route omits them and this screen keeps its own
   * internal state, exactly as before this prop existed.
   */
  readonly recipient?: string;
  readonly onRecipientChange?: (value: string) => void;
  /**
   * True when a caller already renders the outer `<Chrome>`, the page wrapper,
   * the heading and the Back link — `/wallet/send` does (wallet spec §4.3), so
   * this screen's own header is not doubled under it. The plain `/send` route
   * leaves this unset and gets the screen's own chrome, unchanged.
   */
  readonly embedded?: boolean;
  /** Rendered inside "From your wallet", above the token and amount fields —
   *  the recent-recipients row (wallet spec §4.3). */
  readonly aboveFields?: ReactNode;
  /** Rendered beside the recipient input itself — the QR scan button (wallet
   *  spec §4.3), hidden on its own when the device cannot scan. */
  readonly recipientTrailing?: ReactNode;
}

export function SendScreen({
  recipient: recipientProp,
  onRecipientChange,
  embedded,
  aboveFields,
  recipientTrailing,
}: SendScreenProps = {}) {
  const session = useSession();
  const account = session.account;
  const balance = useAccountBalances(account?.address);
  const prefs = useWalletPreferences(account?.address);
  const reducedMotion = usePrefersReducedMotion();
  const [selected, setSelected] = useState<string | undefined>();
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [amountState, setAmountState] = useState<AmountFieldState>({ text: '' });
  const screenRef = useRef<HTMLDivElement | null>(null);
  const amountBoxRef = useRef<HTMLDivElement | null>(null);
  const recipientBoxRef = useRef<HTMLDivElement | null>(null);
  const [recipientState, setRecipientState] = useState('');
  const recipient = recipientProp ?? recipientState;
  const setRecipient = onRecipientChange ?? setRecipientState;
  /**
   * `undefined` — nothing checked yet (empty or malformed input). `'unknown'` — a
   * valid address, but the code read has not answered or failed. `'clean'` — the read
   * answered and this address carries no code. An address — that address is confirmed
   * to carry code. Never collapse `'unknown'` into `'clean'`: a read that did not
   * complete is not the same fact as a read that came back and said "no code here"
   * (High #17).
   */
  const [isContract, setIsContract] = useState<Address | 'unknown' | 'clean' | undefined>();
  const [confirming, setConfirming] = useState(false);
  const [progress, setProgress] = useState<Progress | undefined>();
  const [busy, setBusy] = useState(false);
  /**
   * The relayer's own cap, asked of the relayer (`/api/limits`).
   *
   * Not a constant: the environment may tighten the code cap, so a figure compiled into
   * this bundle would eventually disagree with the process that enforces it. `undefined`
   * means we could not read one — in which case this screen imposes nothing and the
   * relayer's refusal arrives in its own words, after the signature rather than before.
   */
  const [sendCap, setSendCap] = useState<bigint | undefined>();

  useEffect(() => {
    let cancelled = false;
    void fetch(apiUrl('/api/limits'), { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : undefined))
      .then((body: { caps?: { maxOrderNotionalAusd?: string } | null } | undefined) => {
        const raw = body?.caps?.maxOrderNotionalAusd;
        if (!cancelled && raw) setSendCap(BigInt(raw));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * What can be sent: every ERC-20 the wallet holds, listed or not (D1), plus
   * native MON itself since D200 — the one holdings model, never a fixed list.
   */
  const holdings = useMemo<readonly Holding[]>(() => {
    return walletHoldingsOf(balance.tokens ?? []).map((t) => ({
      token: { address: t.address, decimals: t.decimals, symbol: t.symbol },
      balance: t.wallet.value,
    }));
  }, [balance.tokens]);

  // Selected by ADDRESS, not symbol: with any token sendable, two unlisted tokens can
  // legitimately share a ticker, and a symbol key would conflate them.
  const held =
    holdings.find((h) => h.token.address.toLowerCase() === (selected ?? '').toLowerCase()) ??
    holdings[0];
  /** The full balances entry for the held token: the icon and name live there. */
  const heldEntry = (balance.tokens ?? []).find(
    (t) => t.address.toLowerCase() === (held?.token.address ?? '').toLowerCase(),
  );
  const isNativeHeld = held !== undefined && isNative(held.token.address);
  /**
   * Item 1 (10 MON reserve, D199/D200): `held.balance` stays the raw wallet figure
   * everywhere it is shown; only what may actually be sent is capped at the
   * reserve, the same `maxNativeSpend` formula Swap and Move use. No gas term —
   * a native send is always exempt (`assertSponsoredNativeSend`/`exemptionOf`),
   * so it never pays its own gas from this same wallet MON.
   */
  const spendableBalance = isNativeHeld && held ? maxNativeSpend(held.balance, MONAD_DELEGATED_RESERVE_WEI) : held?.balance;
  const parsed = held ? amountToSend(amountState, held.token.decimals) : undefined;
  const withinBalance =
    held !== undefined && parsed !== undefined && parsed > 0n && spendableBalance !== undefined && parsed <= spendableBalance;
  const overSpendableNative =
    isNativeHeld && held !== undefined && parsed !== undefined && parsed > 0n && spendableBalance !== undefined && parsed > spendableBalance;
  // The par cap binds only the pinned dollar tokens, whose base units ARE the cap's
  // units (C2): an unpriced token's notional is unknown and the cap does not apply.
  const overCap =
    sendCap !== undefined &&
    parsed !== undefined &&
    held !== undefined &&
    SPONSORED_TRANSFER_TOKENS.includes(held.token.address.toLowerCase()) &&
    parsed > sendCap;

  const check = useMemo<RecipientCheck>(() => {
    const value = recipient.trim();
    if (value === '') return { kind: 'empty' };
    if (!isAddress(value)) return { kind: 'malformed' };
    const address = getAddress(value);
    // Sending to yourself moves nothing and costs a signature.
    if (account && address.toLowerCase() === account.address.toLowerCase()) {
      return { kind: 'self' };
    }
    if (
      isContract !== undefined &&
      isContract !== 'unknown' &&
      isContract !== 'clean' &&
      isContract.toLowerCase() === address.toLowerCase()
    ) {
      return { kind: 'contract', address };
    }
    if (isContract === undefined || isContract === 'unknown') {
      return { kind: 'code-unknown', address };
    }
    return { kind: 'ok', address };
  }, [recipient, account, isContract]);

  // Code detection, on a valid address only. A warning, never a block: plenty of
  // contracts receive tokens perfectly well, and refusing them would be this app
  // deciding for the user.
  function checkCode(value: string) {
    if (!isAddress(value)) {
      setIsContract(undefined);
      return;
    }
    // Unknown the moment a fresh address starts being checked, not "plain account" —
    // that was this step's actual defect: a read that had not answered yet, or never
    // would, rendered exactly like one that came back and said "no code here."
    setIsContract('unknown');
    void fetch(apiUrl(`/api/account/code?address=${getAddress(value)}`), { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : undefined))
      .then((body: { hasCode?: boolean } | undefined) => {
        if (body === undefined) {
          setIsContract('unknown');
          return;
        }
        setIsContract(body.hasCode ? getAddress(value) : 'clean');
      })
      .catch(() => setIsContract('unknown'));
  }

  /**
   * Runs the code check, and clears a pending confirmation, on every change to
   * `recipient` — however it changed. Typing used to call both directly from the
   * field's own `onChange`; moved here so a recipient set from outside this
   * screen (a recent-recipients tap, a QR scan) gets exactly the same treatment
   * as one that was typed, rather than skipping the contract check silently.
   */
  useEffect(() => {
    checkCode(recipient.trim());
    setConfirming(false);
  }, [recipient]);

  async function send() {
    if (!account || !held || parsed === undefined || !withinBalance) return;
    // A code read that could not complete is a warning, same as a confirmed contract —
    // never a block. Refusing to send whenever a read is merely slow would be worse
    // than the false negative this replaces.
    if (check.kind !== 'ok' && check.kind !== 'contract' && check.kind !== 'code-unknown') return;
    const to = check.address;
    setBusy(true);
    setProgress(undefined);
    let result: Awaited<ReturnType<typeof run>> | undefined;
    try {
      /**
       * Native MON only (D200, rule 1.6): simulated at the tap, before any Face ID
       * prompt. An ERC-20 transfer of the sender's own balance essentially never
       * reverts for a reason this screen has not already checked, but a native send
       * can — the 10 MON reserve is a chain rule, and a balance read a moment ago
       * can be stale. A plan that would revert is reported and never asks for Face
       * ID; `checked: false` (the simulation itself could not be run) is not
       * evidence either way and proceeds like today.
       */
      if (isNativeHeld) {
        const sim = await fetch(apiUrl('/api/wallet/send/simulate'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sender: account.address, to, amount: parsed.toString() }),
        })
          .then((r) => r.json())
          .catch(() => ({ executable: true, checked: false }));
        if (sim?.executable === false) {
          setProgress({
            state: 'REJECTED',
            message: sim.reason ?? 'That could not be sent. Nothing was signed.',
            refusedAtChecking: true,
          });
          setBusy(false);
          return;
        }
      }

      /**
       * The passkey, every time, before anything is signed.
       *
       * Trading runs on the in-memory session by design — an order can be cancelled.
       * Moving money out cannot be. This screen was reachable with one tap in an
       * already-open session, so an unlocked phone or a clickjack over the confirm
       * button was the whole of the defence. The owner's rule names this action as
       * must-prompt-every-time.
       *
       * It throws when the user cancels, and the catch below reports that nothing was
       * signed — which is true: this runs before `run()`.
       *
       * This try/catch covers only the signing and submission, not what happens after
       * a confirmed result. A throw here truly means nothing was sent. A throw from the
       * bookkeeping below a real confirmation does not, and must not say so.
       */
      hapticFaceId(prefs.soundsEnabled);
      await assertFreshPasskey({
        rpId: RP_ID,
        ...(account.credentialId ? { credentialId: account.credentialId } : {}),
      });

      const call = isNativeHeld ? buildNativeSend(to, parsed) : buildErc20Transfer(held.token.address, to, parsed);
      let flew = false;
      result = await run({
        sender: account.address,
        calls: [call],
        purpose: 'withdraw',
        owner: account.account,
        onProgress: (p) => {
          setProgress(p);
          // The flying token at the Sending step, with the swoosh (v2.1 spec 1.9).
          if (p.state === 'RELAYING' && !flew) {
            flew = true;
            swoosh(prefs.soundsEnabled, 0.7);
            if (!reducedMotion && amountBoxRef.current && recipientBoxRef.current && screenRef.current) {
              flyToken(
                amountBoxRef.current,
                recipientBoxRef.current,
                `${formatMoney(parsed, held.token.decimals, displayDp(held.token.symbol, held.token.decimals))} ${held.token.symbol}`,
                screenRef.current,
                reducedMotion,
              );
            }
          }
        },
      });
    } catch {
      // assertFreshPasskey throws when the user cancels or the ceremony fails; run()
      // reports its own failures through onProgress and does not normally throw here.
      // Either way, "nothing was signed" is the true state, and a terminal REJECTED
      // decided before anything was sent keeps the pill at "Checking", not "Sending"
      // (see Progress.refusedAtChecking).
      setProgress({
        state: 'REJECTED',
        message: "Face ID wasn't confirmed, so nothing was sent. Try again.",
        refusedAtChecking: true,
      });
    } finally {
      setBusy(false);
    }

    // Bookkeeping only, after a real confirmation. Its own failure does not undo the
    // send and must not be reported as though it had — the pill already reads
    // CONFIRMED from run()'s own progress callback.
    if (result?.state === 'CONFIRMED') {
      ding(prefs.soundsEnabled);
      hapticConfirmed(prefs.soundsEnabled);
      if (!reducedMotion && recipientBoxRef.current && screenRef.current) {
        confettiBurst(recipientBoxRef.current, screenRef.current, reducedMotion);
      }
      try {
        // Recent recipients (v2.1 spec 1.6): a confirmed send records where it went,
        // without ever clobbering a label the user chose themselves.
        if (!readAddressBook(account.address).some((e) => e.address.toLowerCase() === to.toLowerCase())) {
          addAddressBookEntry(account.address, to, `${to.slice(0, 6)}…${to.slice(-4)}`);
        }
      } catch {
        // Bookkeeping only.
      }
      try {
        const txHash = result.result?.txHash;
        recordActivity(account.address, {
          id: txHash ?? `send:${held.token.symbol}:${Date.now()}`,
          kind: 'send',
          summary: `Sent ${formatMoney(parsed, held.token.decimals, displayDp(held.token.symbol, held.token.decimals))} ${held.token.symbol} to ${to.slice(0, 6)}…${to.slice(-4)}`,
          token: held.token.address,
          amount: parsed.toString(),
          decimals: held.token.decimals,
          symbol: held.token.symbol,
          ...(txHash ? { txHash } : {}),
          at: Date.now(),
        });
        balance.refresh();
      } catch {
        // The send is real regardless. Local activity/balance bookkeeping failing is
        // not a reason to tell the user their money didn't move.
      }
    }
  }

  if (session.status !== 'signed-in' || !account) {
    if (embedded) return <SignedOut />;
    return (
      <Chrome>
        <div className="page">
          <h2 style={{ paddingTop: 6 }}>Send</h2>
          <SignedOut />
        </div>
      </Chrome>
    );
  }

  const ready =
    withinBalance &&
    !overCap &&
    (check.kind === 'ok' || check.kind === 'contract' || check.kind === 'code-unknown');

  // The Cards only. `embedded` callers (`/wallet/send`) supply their own
  // `<Chrome>`, page wrapper, heading and Back link around this; the plain
  // `/send` route gets those from this file, unchanged from before `embedded`
  // existed.
  const content = (
    <div ref={screenRef} style={{ position: 'relative' }}>
      <Card title="From your wallet">
        {aboveFields}
          {balance.status === 'loading' ? (
            <Skeleton rows={3} />
          ) : balance.status === 'error' ? (
            <FailureNotice failure={failure('BALANCE_UNREADABLE')} onRetry={() => balance.refresh()} />
          ) : holdings.length === 0 ? (
            <>
              <Empty>Nothing in your wallet to send.</Empty>
              <p className="tiny muted" style={{ marginTop: 8 }}>
                Tokens in your trading balance have to be withdrawn first.
              </p>
              <div style={{ marginTop: 12 }}>
                <Link href="/withdraw" style={{ textDecoration: 'none' }}>
                  <Button variant="soft" size="sm">
                    Withdraw to your wallet
                  </Button>
                </Link>
              </div>
            </>
          ) : (
            <>
              {/* Token first (v2.1 spec 2.2): the same searchable selector Swap and
                  Move use, so any held ERC-20 — listed or not — is sendable. */}
              <div className="field" style={{ marginTop: 0 }}>
                <label htmlFor="send-token">Token, from your wallet</label>
                <button
                  id="send-token"
                  type="button"
                  className="tokbtn"
                  aria-haspopup="dialog"
                  onClick={() => setSelectorOpen(true)}
                >
                  {held ? (
                    <TokenIcon address={held.token.address} symbol={held.token.symbol} size={30} />
                  ) : null}
                  <span style={{ minWidth: 0, textAlign: 'left' }}>
                    <span className="sym">{held?.token.symbol ?? '—'}</span>
                    <span className="nm" style={{ display: 'block' }}>{heldEntry?.name ?? ''}</span>
                  </span>
                  <span className="bal num">
                    <b>
                      {held
                        ? formatMoney(held.balance, held.token.decimals, displayDp(held.token.symbol, held.token.decimals))
                        : ''}
                    </b>
                    available
                  </span>
                  <span className="chev">▾</span>
                </button>
              </div>

              <div style={{ marginTop: 12 }} ref={amountBoxRef}>
                <Field
                  id="send-amount"
                  label={`Amount in ${held?.token.symbol ?? ''}`}
                  value={amountState.text}
                  inputMode="decimal"
                  numeric
                  onChange={(value) => {
                    setAmountState(onEdit(value));
                    setConfirming(false);
                  }}
                />
                {isNativeHeld ? (
                  // Item 1: native MON's Max/25/50/75% fill from what the wallet may
                  // actually spend (the 10 MON reserve, D199/D200), the same pattern
                  // Swap and Move use — never the raw balance.
                  <div className="pcts" style={{ marginTop: 8 }}>
                    {[25, 50, 75, 100].map((pct) => (
                      <button
                        key={pct}
                        type="button"
                        disabled={spendableBalance === undefined || spendableBalance === 0n}
                        onClick={() => {
                          const b = spendableBalance ?? 0n;
                          setAmountState(
                            fillExact(b, held!.token.decimals, held!.token.symbol, pct === 100 ? undefined : pct * 100),
                          );
                          setConfirming(false);
                        }}
                      >
                        {pct === 100 ? 'Max' : `${pct}%`}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div style={{ marginTop: 8 }}>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        held &&
                        setAmountState(
                          fillExact(
                            // Max is what can actually be sent: the balance, or the cap
                            // when the cap is the smaller of the two. The exact bigint
                            // sent is always this figure itself (item 2), the display
                            // text is only floored to the token's own precision (B8).
                            sendCap !== undefined && held.balance > sendCap ? sendCap : held.balance,
                            held.token.decimals,
                            held.token.symbol,
                          ),
                        )
                      }
                    >
                      Max
                    </Button>
                  </div>
                )}
                {overSpendableNative && held ? (
                  <p className="tiny muted" style={{ marginTop: 8 }}>
                    Up to {formatMoney(spendableBalance ?? 0n, held.token.decimals, displayDp('MON', held.token.decimals))}{' '}
                    MON. Monad keeps 10 MON in smart accounts.{' '}
                    <button
                      type="button"
                      className="link small"
                      onClick={() =>
                        setAmountState(fillExact(spendableBalance ?? 0n, held.token.decimals, held.token.symbol, undefined))
                      }
                    >
                      Fill
                    </button>
                  </p>
                ) : null}
                {overCap && sendCap !== undefined && held ? (
                  <p className="tiny" style={{ marginTop: 8, color: 'var(--down)' }}>
                    Gas is paid for you up to {formatMoney(sendCap, held.token.decimals, 2)}{' '}
                    {held.token.symbol} per send. Send{' '}
                    {formatMoney(sendCap, held.token.decimals, held.token.decimals)}{' '}
                    {held.token.symbol} or less, or send the rest in a second transfer.
                  </p>
                ) : null}
              </div>

              <div style={{ marginTop: 12 }} ref={recipientBoxRef}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Field
                      id="send-recipient"
                      label="Recipient address on Monad"
                      value={recipient}
                      onChange={(value) => setRecipient(value)}
                    />
                  </div>
                  {recipientTrailing ? (
                    <div style={{ paddingBottom: 2 }}>{recipientTrailing}</div>
                  ) : null}
                </div>
                {check.kind === 'malformed' ? (
                  <p className="tiny" style={{ marginTop: 8, color: 'var(--down)' }}>
                    That is not a Monad address. It should be 42 characters beginning 0x.
                  </p>
                ) : null}
                {check.kind === 'self' ? (
                  <p className="tiny" style={{ marginTop: 8, color: 'var(--down)' }}>
                    That is your own address. Sending to yourself moves nothing.
                  </p>
                ) : null}
                {check.kind === 'contract' ? (
                  <div style={{ marginTop: 10 }}>
                    <Notice tone="warn">
                      This address is a contract. If it cannot receive tokens, they will be lost.
                    </Notice>
                  </div>
                ) : null}
                {check.kind === 'code-unknown' ? (
                  <div style={{ marginTop: 10 }}>
                    <Notice tone="warn">
                      Could not confirm whether this address is a contract. If it is one, and it
                      cannot receive tokens, they will be lost.
                    </Notice>
                  </div>
                ) : null}
              </div>

              {ready && !confirming ? (
                <div style={{ marginTop: 14 }}>
                  <Button variant="primary" block onClick={() => setConfirming(true)}>
                    Review
                  </Button>
                </div>
              ) : null}

              {/* The confirmation step. The address is broken into three parts with the
                  ends emphasised, because the middle is what an address-swapping
                  clipboard attack leaves alone. */}
              {ready && confirming ? (
                <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--line)' }}>
                  <p className="small" style={{ margin: '0 0 8px', fontWeight: 600 }}>
                    Check the address before you send
                  </p>
                  <p className="small">
                    Sending{' '}
                    <b>
                      {held
                        ? formatMoney(parsed ?? 0n, held.token.decimals, displayDp(held.token.symbol, held.token.decimals))
                        : ''}{' '}
                      {held?.token.symbol}
                    </b>{' '}
                    to:
                  </p>
                  <div className="addr" style={{ marginTop: 8 }}>
                    <b>{check.address.slice(0, 6)}</b>
                    <span className="muted">{check.address.slice(6, -6)}</span>
                    <b>{check.address.slice(-6)}</b>
                  </div>

                  <div className="grid2" style={{ marginTop: 14 }}>
                    <Button variant="ghost" block onClick={() => setConfirming(false)}>
                      Back
                    </Button>
                    <Button
                      variant="primary"
                      block
                      disabled={busy}
                      disabledLabel="Working"
                      onClick={() => void send()}
                    >
                      Send
                    </Button>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </Card>

        {progress ? (
          <Card title="Send">
            <TicketState
              index={segmentOf(progress)}
              // A terminal state must render as finished, not mid-animation.
              settled={isTerminal(progress.state)}
              {...(progress.state === 'REJECTED' || progress.state === 'REVERTED'
                ? { error: [progress.message, progress.detail].filter(Boolean).join(' ') }
                : {})}
            />
            {progress.state === 'CONFIRMED' && held ? (
              <div style={{ marginTop: 12 }}>
                <ActionResult
                  headline={`Sent ${formatMoney(parsed ?? 0n, held.token.decimals, displayDp(held.token.symbol, held.token.decimals))} ${held.token.symbol}`}
                  {...('address' in check ? { resultingBalance: `To ${check.address}` } : {})}
                  {...(progress.result?.txHash
                    ? {
                        txHash: progress.result.txHash,
                        explorerUrl: explorerTxUrl(progress.result.txHash),
                      }
                    : {})}
                />
              </div>
            ) : null}
          </Card>
        ) : null}

      <TokenSelectorSheet
        open={selectorOpen}
        onClose={() => setSelectorOpen(false)}
        title="Choose a token to send"
        account={account.address}
        tokens={balance.tokens ?? []}
        location="wallet"
        accept={(row) => row.walletValue > 0n}
        onTokenAdded={() => balance.refresh()}
        onPick={(t) => {
          setSelected(t.address);
          setAmountState({ text: '' });
          setConfirming(false);
          setSelectorOpen(false);
        }}
      />
    </div>
  );

  if (embedded) return content;

  return (
    <Chrome>
      <div className="page">
        <div className="between" style={{ paddingTop: 6 }}>
          <div>
            <h2>Send</h2>
            <p className="tiny">From your wallet on Monad, to any address</p>
          </div>
        </div>
        {content}
      </div>
    </Chrome>
  );
}
