'use client';

import { useEffect, useState } from 'react';
import { ActionResult, Button, Field, Notice, Sheet, Skeleton, TicketState } from '@tradepro/ui';
import { TokenSelectorSheet } from '../../components/TokenSelectorSheet';
import { BLOCK_TIME_MS, MONAD_DELEGATED_RESERVE_WEI, type MeraAccount } from '@tradepro/core';
import type { Address } from 'viem';
import { FailureNotice } from '../../components/FailureNotice';
import { TokenIcon } from '../../components/TokenIcon';
import { failure } from '../../lib/failures';
import { displayDp, explorerTxUrl, formatMoney } from '../../lib/format';
import { amountToSend, fillExact, onEdit, type AmountFieldState } from '../../lib/wallet/amountField';
import { moveInSwapFirstNotice } from '../../lib/wallet/kuruAccepted';
import {
  checkVenueClear,
  preflight,
  tokenBySymbol,
  topUp,
  type PermitPreflight,
} from '../../lib/fund/pathB';
import Link from 'next/link';
import { moveInWithApprove } from '../../lib/wallet/moveInApprove';
import { moveInNative } from '../../lib/wallet/moveInNative';
import { moveOut } from '../../lib/wallet/moveOut';
import { isMoveOutDisabled, type WalletTokenEntry } from '../../lib/wallet/holdings';
import { WALLET_SWAP_HREF } from '../../lib/wallet/routeHrefs';
import { isNative, maxNativeSpend } from '../../lib/wallet/swapPlan';
import { kuruTradedTokens, useTokenRegistry } from '../../lib/useTokenRegistry';
import { isTerminal, segmentOf, type Progress } from '../../lib/ticket';
import { recordActivity } from '../../lib/activityStore';
import {
  feeLineText,
  isGasChargeActive,
  type FeeLegPlan,
  type GasAllowance,
} from '../../lib/wallet/gasCharge';
import { ding, swoosh } from '../../lib/wallet/sound';
import { hapticConfirmed, hapticFaceId } from '../../lib/wallet/haptics';

/**
 * The Move sheet (wallet spec §4.5, §5.2, §5.3).
 *
 * Move-in reuses `apps/trade/lib/fund/pathB.ts`'s `preflight`/`topUp`/
 * `checkVenueClear` exactly as `TopUpCard.tsx`'s own "Move to trading balance"
 * button calls them — those functions were already broken out as a standalone,
 * reusable flow, not private to that component, so this is a second UI shell around
 * the same underlying calls rather than a duplicate of them. Per spec §6, Move-in
 * "may sign without a fresh prompt": `topUp()` never calls `assertFreshPasskey`, the
 * same as `TopUpCard`'s own move — the funds stay inside the user's own account.
 *
 * Move-in is limited to whatever `preflight()` returns today — AUSD and USDC, per
 * `/api/fund/permit`'s own doc comment ("Two tokens, not one"). Native MON is never
 * in that list (it is not an ERC-20 and cannot be `permit()`ed), so it is simply
 * never offered here; no extra check was needed to keep it out.
 *
 * Move-out is `./moveOut.ts`, the same `MarginAccount.withdraw` call and fresh-
 * passkey ceremony `apps/withdraw/WithdrawScreen.tsx` already uses, for every token
 * except MON — see `isMoveOutDisabled` in `../../lib/wallet/holdings.ts` for why.
 */

export type MoveDirection = 'in' | 'out';

export function MoveSheet({
  open,
  onClose,
  direction,
  onDirectionChange,
  account,
  marginAccount,
  tokens,
  gasAllowance,
  soundsEnabled,
  initialSymbol,
  onMoved,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly direction: MoveDirection;
  readonly onDirectionChange: (next: MoveDirection) => void;
  readonly account: MeraAccount;
  readonly marginAccount: Address;
  readonly tokens: readonly WalletTokenEntry[];
  readonly gasAllowance: GasAllowance | undefined;
  readonly soundsEnabled: boolean;
  readonly initialSymbol?: string;
  readonly onMoved: (info: { readonly symbol: string }) => void;
}) {
  const [pre, setPre] = useState<PermitPreflight | 'loading' | 'error'>('loading');
  const [symbol, setSymbol] = useState<string | undefined>(initialSymbol);
  const [tokenSelectorOpen, setTokenSelectorOpen] = useState(false);
  const [amountState, setAmountState] = useState<AmountFieldState>({ text: '' });
  const [progress, setProgress] = useState<Progress | undefined>();
  const [busy, setBusy] = useState(false);
  // Move-in's gas-charge quote, once known — see `runWithGasCharge`'s `onFeePlan`.
  // Undefined until the user taps the action button; Move-out never sets it (it is
  // always exempt, see the `feeLine` computation below).
  const [feePlan, setFeePlan] = useState<FeeLegPlan | undefined>();

  // Reset per open, and read Move-in's permit metadata fresh every time the sheet
  // opens — a nonce read a minute ago is stale material to sign against.
  useEffect(() => {
    if (!open) return;
    setProgress(undefined);
    setFeePlan(undefined);
    setAmountState({ text: '' });
    setSymbol(initialSymbol);
    if (direction !== 'in') {
      setPre('loading');
      return;
    }
    let cancelled = false;
    setPre('loading');
    preflight(account.address)
      .then((p) => {
        if (!cancelled) setPre(p);
      })
      .catch(() => {
        if (!cancelled) setPre('error');
      });
    return () => {
      cancelled = true;
    };
    // `initialSymbol` deliberately does not appear here: it only seeds the first
    // render of a fresh open, and re-running this effect on every re-render of the
    // parent (which can change what it passes) would clobber the user's own choice.
  }, [open, direction, account.address]);

  const registry = useTokenRegistry();

  if (!open) return null;

  const permitReady = direction === 'in' && pre !== 'loading' && pre !== 'error';

  const NATIVE_SENTINEL = '0x0000000000000000000000000000000000000000';
  // The live markets' base and quote tokens, from the runtime registry read, never
  // a hardcoded list (item 3, 2026-09-29). `acceptedByMarginAccount` unions this
  // with native MON, since MarginAccount holds MON whether or not a live market
  // happens to name it today.
  const kuruTraded = new Set(kuruTradedTokens(registry.tokens).map((t) => t.address.toLowerCase()));

  /**
   * Whether THIS sheet's own mechanism can move `t` in. Three mechanisms, one per
   * token shape: permit (one signature, no standing allowance), the D2
   * approve-deposit-revoke triple for every other ERC-20, or — native MON, which
   * has neither `permit()` nor `approve()` — a direct native deposit (D200): Kuru's
   * MarginAccount takes native MON straight into `deposit()`, confirmed on mainnet.
   */
  const movableIn = (t: WalletTokenEntry): boolean =>
    t.address.toLowerCase() === NATIVE_SENTINEL ||
    (permitReady && tokenBySymbol(pre as PermitPreflight, t.symbol) !== undefined) ||
    kuruTraded.has(t.address.toLowerCase());

  // Candidates: every token present at the source (spec §4.5: "Token selector
  // limited to tokens present at the source"), not narrowed to what this sheet's
  // mechanism can move. A token Kuru does not hold, or holds but cannot move in
  // through this sheet yet, is still selectable, so the sheet can say why *that*
  // token specifically is stuck (item 3) instead of silently omitting it from a
  // separate list.
  const candidates: readonly WalletTokenEntry[] =
    direction === 'in' ? tokens.filter((t) => t.wallet.value > 0n) : tokens.filter((t) => t.margin.value > 0n);

  const usable = direction === 'out' ? candidates.filter((c) => !isMoveOutDisabled(c.symbol)) : candidates;
  const selected = usable.find((c) => c.symbol === symbol) ?? usable[0];
  const decimals = selected?.decimals ?? 6;
  const balance = selected ? (direction === 'in' ? selected.wallet.value : selected.margin.value) : undefined;
  /**
   * Item 1 (10 MON reserve, D199/D200): Move-in's own balance figure stays the raw
   * wallet amount (what the token button and "Wallet holds" line show); only the
   * Max/% fill and the within-balance check are capped at what the wallet may
   * actually spend, same formula as Swap — the reserve, plus this deposit's own gas
   * when it will be paid from the same wallet MON (the 'own-mon' lane). Move-out
   * never needs this: receiving MON only raises the wallet's balance.
   */
  const isNativeMoveIn = direction === 'in' && selected !== undefined && isNative(selected.address);
  const ownMonGasWei = feePlan?.kind === 'own-mon' ? feePlan.quote.ownMon.gasWei : 0n;
  const spendableBalance =
    isNativeMoveIn && balance !== undefined
      ? maxNativeSpend(balance, MONAD_DELEGATED_RESERVE_WEI + ownMonGasWei)
      : balance;
  const parsed = selected ? amountToSend(amountState, decimals) : undefined;
  const withinBalance =
    selected !== undefined &&
    parsed !== undefined &&
    parsed > 0n &&
    spendableBalance !== undefined &&
    parsed <= spendableBalance;
  const overSpendableNative =
    isNativeMoveIn && parsed !== undefined && parsed > 0n && spendableBalance !== undefined && parsed > spendableBalance;

  // Item 3: the "swap it first" notice is about the selected token only, never a
  // list of every other token sitting in the wallet.
  const showSwapFirstNotice = direction === 'in' && moveInSwapFirstNotice(selected, kuruTraded);
  const selectedMovableIn = direction !== 'in' || !selected || movableIn(selected);

  const headingId = 'move-sheet-title';

  async function moveIn() {
    if (direction !== 'in' || !selected || parsed === undefined || !withinBalance || !movableIn(selected)) return;
    const permitToken = permitReady
      ? tokenBySymbol(pre as PermitPreflight, selected.symbol)
      : undefined;
    setBusy(true);
    setProgress({ state: 'VALIDATING' });
    setFeePlan(undefined);

    const venue = await checkVenueClear();
    if (!venue.clear) {
      setProgress({ state: 'REJECTED', message: venue.message, refusedAtChecking: true });
      setBusy(false);
      return;
    }

    try {
      const onProgress = (p: Progress) => {
        setProgress(p);
        if (p.state === 'RELAYING') swoosh(soundsEnabled);
      };
      // Native MON (D200): a direct deposit, no allowance of any kind. Otherwise
      // permit where the token supports it (one signature, no standing allowance),
      // or the D2 approve-deposit-revoke triple for every other Kuru-traded token.
      const result = isNativeMoveIn
        ? await moveInNative({
            account,
            marginAccount,
            amount: parsed,
            onFeePlan: setFeePlan,
            onProgress,
          })
        : permitToken
        ? await topUp({
            account,
            preflight: pre as PermitPreflight,
            token: { ...permitToken, balance: selected.wallet.value },
            amount: parsed,
            // Known before the batch is signed — the real fee (if any) replaces the
            // placeholder "Charged at cost..." line the instant the quote resolves.
            onFeePlan: setFeePlan,
            onProgress,
          })
        : await moveInWithApprove({
            account,
            marginAccount,
            token: selected.address,
            amount: parsed,
            onFeePlan: setFeePlan,
            onProgress,
          });
      if (result.state === 'CONFIRMED') {
        ding(soundsEnabled);
        hapticConfirmed(soundsEnabled);
        recordMove('move', selected.symbol, parsed, decimals, result.result?.txHash, 'trading balance');
        onMoved({ symbol: selected.symbol });
      }
    } catch {
      setProgress({
        state: 'REJECTED',
        message: 'That could not be prepared. Nothing was signed and nothing was spent.',
      });
    } finally {
      setBusy(false);
    }
  }

  async function moveOutAction() {
    if (direction !== 'out' || !selected || parsed === undefined || !withinBalance) return;
    if (isMoveOutDisabled(selected.symbol)) return;
    setBusy(true);
    setProgress({ state: 'VALIDATING' });
    hapticFaceId(soundsEnabled);
    try {
      const result = await moveOut({
        account,
        marginAccount,
        token: selected.address,
        amount: parsed,
        onProgress: (p) => {
          setProgress(p);
          if (p.state === 'RELAYING') swoosh(soundsEnabled);
        },
      });
      if (result.state === 'CONFIRMED') {
        ding(soundsEnabled);
        hapticConfirmed(soundsEnabled);
        recordMove(
          'move',
          selected.symbol,
          parsed,
          decimals,
          result.result?.txHash,
          'your wallet',
        );
        onMoved({ symbol: selected.symbol });
      }
    } finally {
      setBusy(false);
    }
  }

  function recordMove(
    kind: 'move',
    sym: string,
    amt: bigint,
    dp: number,
    txHash: string | undefined,
    destination: string,
  ) {
    try {
      recordActivity(account.address, {
        id: txHash ?? `move-${direction}:${sym}:${Date.now()}`,
        kind,
        summary: `Moved ${formatMoney(amt, dp, dp)} ${sym} to ${destination}`,
        amount: amt.toString(),
        decimals: dp,
        symbol: sym,
        ...(txHash ? { txHash } : {}),
        route: direction === 'in' ? 'Wallet to trading balance' : 'Trading balance to wallet',
        at: Date.now(),
      });
    } catch {
      // The move is real regardless; local bookkeeping failing is not a reason to
      // say otherwise.
    }
  }

  const confirmed = progress?.state === 'CONFIRMED';
  const txHash = progress?.result?.txHash;

  // Move-out is always "Paid for you": every Move-out batch here is one
  // `MarginAccount.withdraw` call, which `packages/core/src/gas/policy.ts`'s
  // `isSendOrWithdraw` classifies as the same own-funds exemption as Send and
  // Withdraw (proved in `moveOut.test.ts`, not assumed). Move-in has no such
  // exemption — a deposit is an ordinary action, counted like a swap — so once the
  // free tier is exhausted it is charged. Before the user taps the button this
  // shows a placeholder (no live quote exists yet, and nothing here fabricates one);
  // `feePlan`, set by `topUp()`'s `onFeePlan`, replaces it with the real computed
  // figure the moment the quote resolves — before the batch is signed.
  // The live fee plan wins over the free-tier count (D191 item 2): a MON budget reached
  // while free actions remain charges the action, either direction.
  const chargeActiveForMoveIn = direction === 'in' && isGasChargeActive(gasAllowance);
  const feeLine =
    feePlan?.kind === 'fee' || feePlan?.kind === 'own-mon'
      ? { text: feeLineText({ allowance: gasAllowance, quote: feePlan.quote }) ?? 'Charged at cost from your trading balance', up: false }
      : feePlan?.kind === 'sponsored' || !chargeActiveForMoveIn
        ? { text: 'Paid for you', up: true }
        : { text: 'Charged at cost from your trading balance', up: false };

  const arrivesCopy =
    BLOCK_TIME_MS < 1000 ? 'Next block, under a second' : `Next block, about ${Math.round(BLOCK_TIME_MS / 1000)}s`;

  return (
    <Sheet open={open} onClose={onClose} labelledBy={headingId}>
      <h3 id={headingId} style={{ margin: '0 0 4px' }}>
        Move
      </h3>
      <p className="small" style={{ margin: '0 0 10px' }}>
        Between your wallet on Monad and your trading balance on Kuru. One signature.
      </p>

      <div className="dir" role="group" aria-label="Direction">
        <button type="button" aria-pressed={direction === 'in'} onClick={() => onDirectionChange('in')}>
          Wallet → Trading balance
        </button>
        <button type="button" aria-pressed={direction === 'out'} onClick={() => onDirectionChange('out')}>
          Trading balance → Wallet
        </button>
      </div>

      {direction === 'in' && pre === 'loading' ? (
        <Skeleton rows={3} />
      ) : direction === 'in' && pre === 'error' ? (
        <FailureNotice
          failure={failure('RPC_UNAVAILABLE')}
          onRetry={() => {
            setPre('loading');
            void preflight(account.address).then(setPre).catch(() => setPre('error'));
          }}
        />
      ) : candidates.length === 0 ? (
        <Notice tone="warn">
          {direction === 'in'
            ? 'Nothing in your wallet to move in right now.'
            : 'Nothing in your trading balance to move out right now.'}
        </Notice>
      ) : selected ? (
        <>
          {/* Token first, via the shared searchable selector (v2.1 spec 2.2). */}
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="move-token">
              {direction === 'in' ? 'Token, from your wallet' : 'Token, from your trading balance'}
            </label>
            <button
              id="move-token"
              type="button"
              className="tokbtn"
              aria-haspopup="dialog"
              onClick={() => setTokenSelectorOpen(true)}
            >
              <TokenIcon address={selected.address} symbol={selected.symbol} size={30} />
              <span style={{ minWidth: 0, textAlign: 'left' }}>
                <span className="sym">{selected.symbol}</span>
                <span className="nm" style={{ display: 'block' }}>{selected.name}</span>
              </span>
              <span className="bal num">
                <b>
                  {formatMoney(
                    direction === 'in' ? selected.wallet.value : selected.margin.value,
                    selected.decimals,
                    displayDp(selected.symbol, selected.decimals),
                  )}
                </b>
                available
              </span>
              <span className="chev">▾</span>
            </button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '10px 0 2px' }}>
            <TokenIcon address={selected.address} symbol={selected.symbol} size={22} />
            <span className="small muted">
              {direction === 'in' ? 'Wallet holds' : 'Trading balance holds'}{' '}
              {formatMoney(balance ?? 0n, decimals, displayDp(selected.symbol, decimals))} {selected.symbol}
            </span>
          </div>

          {/* Item 3: about the selected token only, never a list of every other
              token sitting in the wallet. */}
          {showSwapFirstNotice ? (
            <div style={{ marginTop: 8 }}>
              <Notice tone="warn">
                {formatMoney(selected.wallet.value, selected.decimals, displayDp(selected.symbol, selected.decimals))}{' '}
                {selected.symbol}: Kuru does not hold this token; swap it first.{' '}
                <Link href={WALLET_SWAP_HREF}>Swap</Link>
              </Notice>
            </div>
          ) : null}

          <Field
            id="move-amount"
            label={`Amount, in ${selected.symbol}`}
            value={amountState.text}
            inputMode="decimal"
            numeric
            disabled={busy}
            onChange={(v) => {
              setAmountState(onEdit(v));
              setProgress(undefined);
              setFeePlan(undefined);
            }}
          />

          <div className="pcts" style={{ marginTop: 8 }}>
            {[25, 50, 75, 100].map((pct) => (
              <button
                key={pct}
                type="button"
                disabled={spendableBalance === undefined || spendableBalance === 0n || busy}
                onClick={() => {
                  const b = spendableBalance ?? 0n;
                  // Item 2: the exact bigint share is computed straight from the
                  // balance and kept alongside the display text, which is floored
                  // to the token's own display precision (B8), the amount SHOWN,
                  // not the amount SENT, which is now always the exact share, not
                  // a figure re-parsed from that rounded-down string.
                  setAmountState(fillExact(b, decimals, selected.symbol, pct === 100 ? undefined : pct * 100));
                  setProgress(undefined);
                  setFeePlan(undefined);
                }}
              >
                {pct === 100 ? 'Max' : `${pct}%`}
              </button>
            ))}
          </div>
          {overSpendableNative ? (
            <p className="tiny muted" style={{ margin: '4px 0 0' }}>
              Up to {formatMoney(spendableBalance ?? 0n, decimals, displayDp(selected.symbol, decimals))}{' '}
              {selected.symbol}. Monad keeps 10 MON in smart accounts.{' '}
              <button
                type="button"
                className="link small"
                onClick={() => {
                  setAmountState(fillExact(spendableBalance ?? 0n, decimals, selected.symbol, undefined));
                  setProgress(undefined);
                  setFeePlan(undefined);
                }}
              >
                Fill
              </button>
            </p>
          ) : null}

          <div className="stack small" style={{ marginTop: 12 }}>
            <div className="between">
              <span className="muted">Network fee</span>
              <span className="num" style={{ color: feeLine.up ? 'var(--up)' : undefined }}>
                {feeLine.text}
              </span>
            </div>
            <div className="between">
              <span className="muted">Arrives</span>
              <span className="num">{arrivesCopy}</span>
            </div>
          </div>

          <div style={{ marginTop: 14 }}>
            <Button
              variant="primary"
              block
              disabled={!withinBalance || busy || !selectedMovableIn}
              disabledLabel={
                busy
                  ? 'Working'
                  : showSwapFirstNotice
                    ? `Swap ${selected.symbol} first to move it in`
                    : !selectedMovableIn
                      ? `${selected.symbol} can't be moved in from here yet`
                      : parsed === undefined || parsed <= 0n
                        ? 'Enter an amount to move'
                        : `More than your ${selected.symbol} ${direction === 'in' ? 'wallet' : 'trading'} balance`
              }
              onClick={() => void (direction === 'in' ? moveIn() : moveOutAction())}
            >
              {direction === 'in'
                ? 'Move to trading balance with Face ID'
                : 'Withdraw to wallet with Face ID'}
            </Button>
          </div>

          {progress ? (
            <div style={{ marginTop: 14 }}>
              <TicketState
                index={segmentOf(progress)}
                settled={isTerminal(progress.state)}
                {...(progress.state === 'REJECTED' || progress.state === 'REVERTED'
                  ? { error: [progress.message, progress.detail].filter(Boolean).join(' ') }
                  : {})}
              />
              {confirmed ? (
                <div style={{ marginTop: 10 }}>
                  <ActionResult
                    headline={`Moved ${formatMoney(parsed ?? 0n, decimals, displayDp(selected.symbol, decimals))} ${selected.symbol}`}
                    resultingBalance={
                      direction === 'in'
                        ? 'It is in your trading balance now.'
                        : 'It is in your wallet on Monad now.'
                    }
                    {...(txHash ? { txHash, explorerUrl: explorerTxUrl(txHash) } : {})}
                    actionLabel="Done"
                    onAction={onClose}
                  />
                </div>
              ) : null}
              {progress.state === 'RELAYING' && progress.message ? (
                <div style={{ marginTop: 10 }}>
                  <Notice tone="warn">{progress.message}</Notice>
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
      <TokenSelectorSheet
        open={tokenSelectorOpen}
        onClose={() => setTokenSelectorOpen(false)}
        title={direction === 'in' ? 'Choose a token to move in' : 'Choose a token to withdraw'}
        account={account.address}
        tokens={tokens}
        location={direction === 'in' ? 'wallet' : 'trading'}
        accept={(row) => (direction === 'in' ? row.walletValue > 0n : row.marginValue > 0n)}
        onTokenAdded={() => undefined}
        onPick={(t) => {
          setSymbol(t.symbol);
          setAmountState({ text: '' });
          setProgress(undefined);
          setFeePlan(undefined);
          setTokenSelectorOpen(false);
        }}
      />
    </Sheet>
  );
}
