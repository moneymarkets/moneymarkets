'use client';

import { useCallback, useEffect, useState } from 'react';
import { ActionResult, Button, Field, Notice, Skeleton, TicketState } from '@tradepro/ui';
import type { MeraAccount } from '@tradepro/core';
import { FailureNotice } from '../../components/FailureNotice';
import { failure, withDetail } from '../../lib/failures';
import { explorerTxUrl, formatMoney } from '../../lib/format';
import { amountToSend, fillExact, onEdit, type AmountFieldState } from '../../lib/wallet/amountField';
import { onMoveRequest } from '../../lib/moveRequest';
import {
  BOOK_CONVERSION_MIN_USDC,
  checkVenueClear,
  ConversionUnquotable,
  flowConvert,
  FlowRouteUnavailable,
  preflight,
  PreflightError,
  quoteFlowConvert,
  quoteToAusd,
  tokenToMove,
  topUp,
  type ConversionQuoteWire,
  type ConversionRouteKind,
  type FlowConversionQuoteWire,
  type PermitPreflight,
  type TokenPreflight,
} from '../../lib/fund/pathB';
// `TicketState` is also a component name in @tradepro/ui, so the type is aliased.
import { segmentOf, type Progress, type TicketState as MoveState } from '../../lib/ticket';
import { useLiveStatus } from '../../components/LiveStatus';
import { useAccountBalances } from '../../lib/useAccountBalances';
import { tokenBySymbol } from '../../lib/wallet/holdingsModel';
import { apiUrl } from '../../lib/basePath';

/**
 * "Move to trading balance" — Path B's second half (spec §7.2, §6.4, design §5.3).
 *
 * Move and Convert are two separate actions on the same money, not one coupled flow.
 *
 * ## Move — no amount floor, ever
 *
 * `Move to trading balance` deposits whatever the user is holding — USDC or AUSD —
 * into the margin account **as itself**. No conversion, no minimum, one signature.
 * MON/USDC is tradable on a USDC balance immediately. This is deliberately never
 * gated on a book quote: a $1.35 deposit used to be stuck behind a $10 book minimum
 * it never needed.
 *
 * ## Convert — optional, and the route is picked silently by amount
 *
 * `Convert to AUSD` is offered whenever the held token is not already AUSD, at any
 * amount. Which route runs is decided by `BOOK_CONVERSION_MIN_USDC`, never asked of
 * the user and never a reason to disable the button:
 *
 *   - **>= 10 USDC**: the existing atomic batch —
 *     `permit(USDC) -> MarginAccount.deposit(USDC) -> market buy AUSD/USDC` — lands
 *     directly in the margin account as AUSD. The quote is a real `eth_call` from the
 *     zero address that the verified `OrderBook` answers by matching real depth
 *     without touching state; not a mid-price, not a model.
 *   - **< 10 USDC**: `permit(USDC, KuruFlowRouter) -> Flow swap`, which lands AUSD in
 *     the user's own **wallet**, not margin — the book's own 10 AUSD minimum order
 *     size means it cannot fill anything smaller, and this is the fallback that keeps
 *     a small amount from being stuck. `Move to trading balance` then does the second
 *     step once that AUSD holding shows up here, the same one-tap action already
 *     described above, just for the AUSD it now holds instead of the USDC it started
 *     with. The 10-AUSD figure appears as a one-line note when it applies, never as a
 *     blocker.
 *
 * Every figure — balance, permit nonce, EIP-712 domain (*proved* against the token's
 * own `DOMAIN_SEPARATOR()`, never looked up), the book quote, the Flow quote — is read
 * from the chain or the venue live, for this account, when the amount settles. No
 * quote lookup is allowed to sit in "loading" once it has actually answered: every one
 * of them times out at five seconds and resolves to a clear ready-or-failed state.
 */

type State =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly pre: PermitPreflight; readonly token: TokenPreflight }
  | { readonly status: 'unsupported' }
  | { readonly status: 'unavailable' };

type ConversionState =
  | { readonly status: 'none' }
  | { readonly status: 'loading'; readonly route: ConversionRouteKind }
  | { readonly status: 'ready'; readonly route: 'book'; readonly quote: ConversionQuoteWire }
  | { readonly status: 'ready'; readonly route: 'flow'; readonly quote: FlowConversionQuoteWire }
  | {
      readonly status: 'failed';
      readonly route: ConversionRouteKind;
      /** Which failure copy applies — a route that exists but isn't safe reads differently. */
      readonly code: 'CONVERSION_UNQUOTABLE' | 'FLOW_ROUTE_NEEDS_NATIVE_VALUE';
      /** The upstream's own words, source-named — never masked (2026-09-08 rule). */
      readonly upstream?: string;
    };

export function TopUpCard({
  account,
  onDone,
  onProgress,
}: {
  account: MeraAccount;
  onDone: (message: string) => void;
  /**
   * Reported upward so the deposit step list can tick "In your trading balance" on a
   * real transaction rather than on the swap having delivered into the wallet. The
   * hash is step 5's own evidence when it is what proved the tick.
   */
  onProgress?: (state: MoveState | undefined, txHash?: string) => void;
}) {
  const [state, setState] = useState<State>({ status: 'loading' });
  // Which holding the user is moving. An account can hold both USDC and AUSD, and
  // offering only one of them made the other invisible (design 5.2).
  const [selected, setSelected] = useState<string | undefined>();
  const [amountState, setAmountState] = useState<AmountFieldState>({ text: '' });
  const [conversion, setConversion] = useState<ConversionState>({ status: 'none' });
  const [progress, setProgress] = useState<Progress | undefined>();
  // Which of the two independent actions the current `progress`/busy state belongs
  // to, so the ticket state renders under the button that actually produced it.
  const [activeAction, setActiveAction] = useState<'move' | 'convert' | undefined>();
  const [busy, setBusy] = useState(false);
  // Called with the other hooks, before any early return. Placed lower it sits
  // after this component's loading and unsupported returns, and React throws
  // "rendered more hooks than during the previous render" the moment the card
  // finishes loading — which is exactly what it did.
  const venue = useLiveStatus();
  // The single balance source (item 2c). `preflight()` below still runs — it is the
  // only place a permit domain and nonce can come from, and those are signing
  // material, not a rendered figure — but the *displayed* balance, which token looks
  // "funded", and the default amount all come from here now, the same read Home,
  // Portfolio and the ticket use. Two different routes disagreeing about the same
  // wallet is exactly what made this card vanish while real USDC sat there.
  const liveBalance = useAccountBalances(account.address);

  const load = useCallback(() => {
    setState({ status: 'loading' });
    void (async () => {
      try {
        const pre = await preflight(account.address);
        const token = tokenToMove(pre);
        if (!token) {
          setState({ status: 'unsupported' });
          return;
        }
        setState({ status: 'ready', pre, token });
      } catch (caught) {
        if (caught instanceof PreflightError && caught.kind === 'PERMIT_UNSUPPORTED') {
          setState({ status: 'unsupported' });
        } else {
          setState({ status: 'unavailable' });
        }
      }
    })();
  }, [account.address]);

  useEffect(load, [load]);

  // Mirror the move's state to the parent. The step list is a claim about where money
  // is, so it is driven by this and by a margin read, never by the swap alone.
  useEffect(() => {
    onProgress?.(progress?.state, progress?.result?.txHash);
  }, [progress?.state, progress?.result?.txHash, onProgress]);

  // Permit metadata (address, domain, nonce — signing material `preflight()` alone
  // can supply) merged with the live balance (item 2c's hook — never `preflight()`'s
  // own balance field, which is a second read of the same wallet and can disagree
  // with the shared one for however long a poll cycle lasts). A token whose *live*
  // balance is zero is not "held," whatever `preflight()` read a moment earlier.
  // Any token the balance read knows, by symbol (spec A2d): no switch over a fixed pair.
  const liveBalanceFor = (symbol: string): bigint | undefined =>
    tokenBySymbol(liveBalance.tokens ?? [], symbol)?.wallet.value;

  const holdings: readonly TokenPreflight[] =
    state.status === 'ready'
      ? state.pre.tokens
          .filter((t) => t.permit)
          .map((t) => ({ ...t, balance: liveBalanceFor(t.symbol) ?? t.balance }))
          .filter((t) => t.balance > 0n)
          .sort((a, b) => {
            if (a.symbol === b.symbol) return 0;
            if (a.symbol === 'AUSD') return 1;
            if (b.symbol === 'AUSD') return -1;
            return a.symbol.localeCompare(b.symbol);
          })
      : [];

  const token =
    state.status === 'ready'
      ? (holdings.find((h) => h.symbol === selected) ??
        holdings[0] ?? { ...state.token, balance: liveBalanceFor(state.token.symbol) ?? 0n })
      : undefined;

  // Default to the whole live balance once it is known — what someone who just
  // funded wants, and a real figure rather than a round number nobody read. Runs
  // whenever the token or its live balance changes, not only on first load, so it
  // still fires the moment `liveBalance` finishes its own first fetch.
  useEffect(() => {
    if (amountState.text !== '' || !token || token.balance <= 0n) return;
    // Item 2: the exact bigint is the full balance itself; the display text is only
    // floored to the token's own display precision (B8), never more on-chain
    // decimals than that shown, even though every permit token here happens to
    // carry 6 on-chain decimals already.
    setAmountState(fillExact(token.balance, token.decimals, token.symbol));
  }, [token?.symbol, token?.balance]);

  /**
   * A deposit just landed and the user tapped "Move this".
   *
   * Selects the holding that arrived and clears the amount, so the effect above refills
   * it from the **new** live balance rather than leaving whatever was typed for a
   * different token. Nothing else about the card changes: the user still reviews and
   * still taps Move.
   */
  useEffect(
    () =>
      onMoveRequest(({ symbol }) => {
        setSelected(symbol);
        setAmountState({ text: '' });
      }),
    [],
  );

  const needsConversion = token !== undefined && token.symbol !== 'AUSD';
  const parsed = token ? amountToSend(amountState, token.decimals) : undefined;
  const withinBalance =
    token !== undefined && parsed !== undefined && parsed > 0n && parsed <= token.balance;

  // The route is picked by amount alone, never by the user and never a reason to
  // disable Convert — see BOOK_CONVERSION_MIN_USDC. Re-quoted when the amount settles;
  // no timer, this is a read on intent, not a cadence.
  const conversionRoute: ConversionRouteKind =
    parsed !== undefined && parsed >= BOOK_CONVERSION_MIN_USDC ? 'book' : 'flow';

  useEffect(() => {
    if (!needsConversion || !withinBalance || parsed === undefined) {
      setConversion({ status: 'none' });
      return;
    }
    const route = conversionRoute;
    let cancelled = false;
    setConversion({ status: 'loading', route });
    const id = window.setTimeout(() => {
      if (route === 'book') {
        void quoteToAusd(parsed)
          .then((quote) => {
            if (!cancelled) setConversion({ status: 'ready', route: 'book', quote });
          })
          .catch((caught: unknown) => {
            if (!cancelled) {
              setConversion({
                status: 'failed',
                route: 'book',
                code: 'CONVERSION_UNQUOTABLE',
                ...(caught instanceof ConversionUnquotable && caught.upstream
                  ? { upstream: caught.upstream }
                  : {}),
              });
            }
          });
      } else {
        void quoteFlowConvert(account.address, parsed)
          .then((quote) => {
            if (!cancelled) setConversion({ status: 'ready', route: 'flow', quote });
          })
          .catch((caught: unknown) => {
            if (cancelled) return;
            const code =
              caught instanceof FlowRouteUnavailable
                ? 'FLOW_ROUTE_NEEDS_NATIVE_VALUE'
                : 'CONVERSION_UNQUOTABLE';
            const upstream =
              (caught instanceof FlowRouteUnavailable || caught instanceof ConversionUnquotable) &&
              caught.upstream
                ? caught.upstream
                : undefined;
            setConversion({
              status: 'failed',
              route: 'flow',
              code,
              ...(upstream ? { upstream } : {}),
            });
          });
      }
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [needsConversion, withinBalance, parsed, account.address]);

  if (state.status === 'loading') {
    return (
      <div className="pg-fund-pane">
        <h2>Move to trading balance</h2>
        <Skeleton rows={3} />
      </div>
    );
  }

  if (state.status === 'unsupported') {
    return (
      <div className="pg-fund-pane">
        <h2>Move to trading balance</h2>
        <FailureNotice failure={failure('PERMIT_UNSUPPORTED')} />
      </div>
    );
  }

  if (state.status === 'unavailable') {
    return (
      <div className="pg-fund-pane">
        <h2>Move to trading balance</h2>
        <FailureNotice failure={failure('RPC_UNAVAILABLE')} onRetry={load} />
      </div>
    );
  }

  // The balance read failing is a different fact from "nothing is there," and gets a
  // different screen — never an empty card, never a silent zero (item 2d, item 3c).
  if (liveBalance.status === 'error') {
    return (
      <div className="pg-fund-pane">
        <h2>Move to trading balance</h2>
        <FailureNotice
          failure={failure('RPC_UNAVAILABLE')}
          onRetry={() => {
            liveBalance.refresh();
            load();
          }}
        />
      </div>
    );
  }

  const { pre } = state;
  const held = token ?? state.token;
  const funded = held.balance > 0n;
  const balanceKnown = liveBalance.status === 'ready';
  // In dryrun the card still renders and the button still explains itself. An
  // interface nobody can see before arming is one nobody can check before arming.
  //
  // `venue` starts `undefined` and this hook polls every ten minutes (useLiveStatus),
  // so "paused === true" read literally treated both "just mounted, no answer yet" and
  // "the last poll, up to ten minutes old, said clear" as equally safe to send money on
  // — the same "unknown is not evidence of clear" gap the unpause watcher had. Anything
  // short of an explicit, fresh `false` blocks. Both actions re-check live before
  // asking for a signature, so this is the display state, not the last line of defence.
  const venueKnown = venue !== undefined;
  const paused = venue?.paused !== false;
  const live = venue?.live ?? (state.status === 'ready' ? state.pre.live !== false : true);
  // Move has no amount floor and does not wait on any quote — the whole point of
  // separating it from Convert is that it never depends on the book having a price.
  const canMove = venueKnown && live && !paused && funded && withinBalance && !busy;
  const canConvert =
    venueKnown &&
    live &&
    !paused &&
    funded &&
    withinBalance &&
    needsConversion &&
    conversion.status === 'ready' &&
    !busy;

  async function move() {
    if (!withinBalance || parsed === undefined) return;
    setBusy(true);
    setActiveAction('move');
    setProgress({ state: 'VALIDATING' });

    // A fresh read, not the polled `venue` above — that can be up to ten minutes old,
    // and asking for a passkey signature on a batch already known to fail is exactly
    // what let "AA21 didn't pay prefund" reach the screen after Face ID had already
    // fired. Nothing is signed before this resolves.
    const venueCheck = await checkVenueClear();
    if (!venueCheck.clear) {
      setProgress({ state: 'REJECTED', message: venueCheck.message });
      setBusy(false);
      return;
    }

    try {
      // No conversion, ever — this is the no-floor path (spec: separate Move from
      // Convert). Whatever `held` is, it lands as itself.
      const result = await topUp({
        account,
        preflight: pre,
        token: held,
        amount: parsed,
        onProgress: setProgress,
      });
      if (result.state === 'CONFIRMED') {
        onDone(`Moved to your trading balance as ${held.symbol}`);
        load();
        liveBalance.refresh();
      } else if (result.state === 'RELAYING') {
        onDone('Checked. Nothing sent in this mode');
      }
    } catch (caught) {
      setProgress({
        state: 'REJECTED',
        message:
          caught instanceof Error && /User|NotAllowed|abort/i.test(caught.message)
            ? 'Your passkey was not confirmed. Nothing was signed.'
            : 'That could not be prepared. Nothing was signed and nothing was spent.',
      });
    } finally {
      setBusy(false);
    }
  }

  async function convert() {
    if (!withinBalance || parsed === undefined || conversion.status !== 'ready') return;
    setBusy(true);
    setActiveAction('convert');
    setProgress({ state: 'VALIDATING' });

    const venueCheck = await checkVenueClear();
    if (!venueCheck.clear) {
      setProgress({ state: 'REJECTED', message: venueCheck.message });
      setBusy(false);
      return;
    }

    try {
      const result =
        conversion.route === 'book'
          ? await topUp({
              account,
              preflight: pre,
              token: held,
              amount: parsed,
              conversion: conversion.quote,
              onProgress: setProgress,
            })
          : await flowConvert({
              account,
              preflight: pre,
              usdc: held,
              amount: parsed,
              quote: conversion.quote,
              onProgress: setProgress,
            });
      if (result.state === 'CONFIRMED') {
        onDone(
          conversion.route === 'book'
            ? 'Converted and moved to your trading balance as AUSD'
            : 'Converted to AUSD in your wallet — move it in as a second step',
        );
        load();
        liveBalance.refresh();
      } else if (result.state === 'RELAYING') {
        onDone('Checked. Nothing sent in this mode');
      }
    } catch (caught) {
      setProgress({
        state: 'REJECTED',
        message:
          caught instanceof Error && /User|NotAllowed|abort/i.test(caught.message)
            ? 'Your passkey was not confirmed. Nothing was signed.'
            : 'That could not be prepared. Nothing was signed and nothing was spent.',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pg-fund-pane">
      <h2>
        {funded
          ? `${formatMoney(held.balance, held.decimals, 2)} ${held.symbol} waiting — move to trading balance`
          : 'Move to trading balance'}
      </h2>
      <p className="small" style={{ margin: '6px 0 12px' }}>
        {funded
          ? `${formatMoney(held.balance, held.decimals, held.decimals)} ${held.symbol} arrived in your wallet on Monad. ` +
            'Moving it in is one signature and no gas — we pay that, at any amount.'
          : balanceKnown
            ? 'Nothing waiting in your wallet. When money arrives, this is where you move it across.'
            : 'Reading your wallet…'}
      </p>

      {/* An account can hold more than one movable asset. Offering only the first left
          the rest invisible, which is the failure design 5.2 forbids. */}
      {/* A paused venue is the venue's fact, not a failure of ours and never a hex
          code. The money has not moved and the copy says where it is. Shown only once
          we KNOW it is paused — while venue is still loading, `paused` blocks the
          button but this notice would be claiming a fact we do not have yet. */}
      {venue?.paused === true && funded ? (
        <div style={{ marginTop: 4, marginBottom: 12 }}>
          <Notice tone="warn">
            Kuru has paused deposits right now. Your {formatMoney(held.balance, held.decimals, 2)}{' '}
            {held.symbol} stays in your wallet. We&rsquo;ll retry automatically.
          </Notice>
          <div style={{ marginTop: 10 }}>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void fetch(apiUrl('/api/status'), { cache: 'no-store' })
                  .then((r) => r.json())
                  .then(() => load());
              }}
            >
              Retry now
            </Button>
          </div>
        </div>
      ) : null}

      {holdings.length > 1 ? (
        <div className="row" style={{ gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          {holdings.map((h) => (
            <button
              key={h.address}
              type="button"
              className={h.symbol === held.symbol ? 'chip chip-on' : 'chip'}
              onClick={() => {
                setSelected(h.symbol);
                setAmountState(fillExact(h.balance, h.decimals, h.symbol));
              }}
            >
              {formatMoney(h.balance, h.decimals, 2)} {h.symbol}
            </button>
          ))}
        </div>
      ) : null}

      <Field
        id="topup-amount"
        label={`Amount to move, in ${held.symbol}`}
        value={amountState.text}
        inputMode="decimal"
        numeric
        disabled={!funded || busy}
        onChange={(v) => setAmountState(onEdit(v))}
      />

      {funded && parsed !== undefined && parsed > held.balance ? (
        <div style={{ marginTop: 10 }}>
          <Notice tone="warn">
            That is more than your wallet holds. Move at most{' '}
            {formatMoney(held.balance, held.decimals, held.decimals)} {held.symbol}.
          </Notice>
        </div>
      ) : null}

      {/* Move: no amount floor, no conversion, no dependency on any quote. */}
      <div style={{ marginTop: 14 }}>
        <Button
          variant="primary"
          block
          disabled={!canMove}
          disabledLabel={
            busy && activeAction === 'move'
              ? 'Waiting for your passkey'
              : !venueKnown
                ? "Checking Kuru's status"
                : paused
                  ? 'Kuru has paused deposits'
                  : !funded
                    ? `No ${held.symbol} in your wallet yet`
                    : !withinBalance
                      ? 'Enter an amount to move'
                      : busy
                        ? 'Working'
                        : 'Live actions are off'
          }
          onClick={() => void move()}
        >
          Move to trading balance
        </Button>
      </div>

      {activeAction === 'move' && progress ? (
        <div style={{ marginTop: 14 }}>
          <TicketState
            index={segmentOf(progress)}
            {...(progress.state === 'REJECTED' || progress.state === 'REVERTED'
              ? {
                  error: [
                    progress.message ?? 'That did not go through. Nothing was spent.',
                    progress.detail,
                  ]
                    .filter(Boolean)
                    .join(' '),
                }
              : {})}
          />
          {progress.state === 'RELAYING' && progress.message ? (
            <div style={{ marginTop: 10 }}>
              <FailureNotice failure={failure('NOT_LIVE')} />
            </div>
          ) : null}
          {/* ITEM 4: the one confirmation component, same as every other action. */}
          {progress.state === 'CONFIRMED' ? (
            <div style={{ marginTop: 10 }}>
              <ActionResult
                headline={progress.message ?? 'Done'}
                {...(progress.result?.txHash
                  ? {
                      txHash: progress.result.txHash,
                      explorerUrl: explorerTxUrl(progress.result.txHash),
                    }
                  : {})}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      <p className="tiny muted" style={{ marginTop: 12 }}>
        The approval is for exactly this amount and expires in five minutes. It can only ever let
        Kuru&rsquo;s margin account take it, and only into your own balance.
      </p>

      {/* Convert: optional, at any amount. The route is picked silently by amount —
          never a reason to disable the button. */}
      {needsConversion ? (
        <div style={{ marginTop: 22, paddingTop: 18, borderTop: '1px solid var(--line)' }}>
          <p className="small" style={{ margin: '0 0 10px', fontWeight: 600 }}>
            Convert to AUSD
          </p>

          {conversionRoute === 'flow' && withinBalance ? (
            <p className="tiny muted" style={{ margin: '0 0 10px' }}>
              Amounts under {formatMoney(BOOK_CONVERSION_MIN_USDC, held.decimals, 2)} {held.symbol}{' '}
              convert through a Kuru swap into your wallet as AUSD — move it in as a second step,
              above.
            </p>
          ) : null}

          <div className="stack small">
            <div className="between">
              <span className="muted">
                {conversion.status === 'ready' && conversion.route === 'flow'
                  ? 'Converted via Kuru swap'
                  : 'Converted on the AUSD book'}
              </span>
              <span className="num">
                {conversion.status === 'ready'
                  ? conversion.route === 'book'
                    ? `${formatMoney(conversion.quote.expectedOut, conversion.quote.outDecimals, 6)} AUSD`
                    : `${formatMoney(conversion.quote.output, held.decimals, 6)} AUSD`
                  : conversion.status === 'loading'
                    ? 'Reading the price…'
                    : conversion.status === 'failed'
                      ? 'Price unavailable'
                      : 'No price yet'}
              </span>
            </div>
            {conversion.status === 'ready' ? (
              <div className="between">
                <span className="muted">You receive at least</span>
                <span className="num">
                  {conversion.route === 'book'
                    ? `${formatMoney(conversion.quote.minAmountOut, conversion.quote.outDecimals, 6)} AUSD`
                    : `${formatMoney(conversion.quote.minOut, held.decimals, 6)} AUSD`}
                </span>
              </div>
            ) : null}
            {conversion.status === 'ready' && conversion.route === 'flow' ? (
              <div className="between">
                <span className="muted">Swap fee (est.)</span>
                <span className="num">
                  {conversion.quote.amountIn > conversion.quote.output
                    ? `${formatMoney(conversion.quote.amountIn - conversion.quote.output, held.decimals, 6)} ${held.symbol}`
                    : `0 ${held.symbol}`}
                </span>
              </div>
            ) : null}
            <div className="between">
              <span className="muted">Network fee</span>
              <span className="num" style={{ color: 'var(--up)' }}>
                Paid for you
              </span>
            </div>
          </div>

          {conversion.status === 'failed' ? (
            <div style={{ marginTop: 10 }}>
              <FailureNotice failure={withDetail(failure(conversion.code), conversion.upstream)} />
            </div>
          ) : null}

          <div style={{ marginTop: 14 }}>
            <Button
              variant="soft"
              block
              disabled={!canConvert}
              disabledLabel={
                busy && activeAction === 'convert'
                  ? 'Waiting for your passkey'
                  : !venueKnown
                    ? "Checking Kuru's status"
                    : paused
                      ? 'Kuru has paused deposits'
                      : !funded
                        ? `No ${held.symbol} in your wallet yet`
                        : !withinBalance
                          ? 'Enter an amount to move'
                          : conversion.status === 'failed'
                            ? conversion.code === 'FLOW_ROUTE_NEEDS_NATIVE_VALUE'
                              ? 'This route needs native MON sent with it'
                              : "Can't quote AUSD for this amount"
                            : conversion.status !== 'ready'
                              ? 'Reading the AUSD price'
                              : busy
                                ? 'Working'
                                : 'Live actions are off'
              }
              onClick={() => void convert()}
            >
              Convert to AUSD
            </Button>
          </div>

          {activeAction === 'convert' && progress ? (
            <div style={{ marginTop: 14 }}>
              <TicketState
                index={segmentOf(progress)}
                {...(progress.state === 'REJECTED' || progress.state === 'REVERTED'
                  ? {
                      error: [
                        progress.message ?? 'That did not go through. Nothing was spent.',
                        progress.detail,
                      ]
                        .filter(Boolean)
                        .join(' '),
                    }
                  : {})}
              />
              {progress.state === 'RELAYING' && progress.message ? (
                <div style={{ marginTop: 10 }}>
                  <FailureNotice failure={failure('NOT_LIVE')} />
                </div>
              ) : null}
              {/* ITEM 4: the same confirmation component the move above uses. */}
              {progress.state === 'CONFIRMED' ? (
                <div style={{ marginTop: 10 }}>
                  <ActionResult
                    headline={progress.message ?? 'Done'}
                    {...(progress.result?.txHash
                      ? {
                          txHash: progress.result.txHash,
                          explorerUrl: explorerTxUrl(progress.result.txHash),
                        }
                      : {})}
                  />
                </div>
              ) : null}
            </div>
          ) : null}

          <p className="tiny muted" style={{ marginTop: 12 }}>
            {conversionRoute === 'book'
              ? 'A market buy on the AUSD book with a floor 0.1% under the quoted price, so it cannot fill at any price.'
              : "A Kuru Flow swap. Unlike an in-app order this leg is not routed through Kuru's own order book matching, but it still runs inside the same sponsored operation — you sign once and pay no gas."}
          </p>
        </div>
      ) : (
        <p className="tiny muted" style={{ marginTop: 16 }}>
          This is already AUSD, so there is nothing to convert.
        </p>
      )}
    </div>
  );
}
