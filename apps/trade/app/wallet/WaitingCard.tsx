'use client';

import { useEffect, useState } from 'react';
import { ActionResult, Button, Notice, TicketState, Toggle } from '@tradepro/ui';
import { MAINNET, type MeraAccount } from '@tradepro/core';
import type { Address } from 'viem';
import { moveInWithApprove } from '../../lib/wallet/moveInApprove';
import { FailureNotice } from '../../components/FailureNotice';
import { TokenIcon } from '../../components/TokenIcon';
import { failure, withDetail } from '../../lib/failures';
import { explorerTxUrl, formatMoney } from '../../lib/format';
import {
  BOOK_CONVERSION_MIN_USDC,
  checkVenueClear,
  ConversionUnquotable,
  flowConvert,
  FlowRouteUnavailable,
  preflight,
  quoteFlowConvert,
  quoteToAusd,
  tokenBySymbol,
  topUp,
  type ConversionQuoteWire,
  type FlowConversionQuoteWire,
  type PermitPreflight,
} from '../../lib/fund/pathB';
import type { ActivityRow } from '../../lib/activityStore';
import { recordActivity } from '../../lib/activityStore';
import { isTerminal, segmentOf, type Progress } from '../../lib/ticket';
import type { WalletTokenEntry } from '../../lib/useAccountBalances';
import { ding, swoosh } from '../../lib/wallet/sound';
import { hapticConfirmed } from '../../lib/wallet/haptics';

/**
 * The Waiting card (wallet spec §4.1, §5.4): rendered only when a real wallet
 * balance is waiting, with a Move button that runs the Move-in flow (§5.2) directly
 * for that token — the same one-tap, no-sheet interaction the design reference's
 * `#doMoveWait` button has, and the same underlying `preflight`/`topUp()` calls
 * `TopUpCard.tsx` and the Move sheet both call, not a third copy of that logic.
 *
 * "Also convert to AUSD" reuses the existing conversion route (`quoteToAusd` for
 * ten AUSD and above, `quoteFlowConvert`/`flowConvert` below that —
 * `BOOK_CONVERSION_MIN_USDC` picks silently, same as `TopUpCard`) rather than
 * inventing a second one.
 */
export function WaitingCard({
  account,
  token,
  recentRows,
  soundsEnabled,
  onMoved,
}: {
  readonly account: MeraAccount;
  readonly token: WalletTokenEntry;
  /** Recent activity, to find when this token last arrived — never guessed. */
  readonly recentRows: readonly ActivityRow[];
  readonly soundsEnabled: boolean;
  readonly onMoved: (info: { readonly symbol: string }) => void;
}) {
  const [pre, setPre] = useState<PermitPreflight | 'loading' | 'error'>('loading');
  const [progress, setProgress] = useState<Progress | undefined>();
  const [busy, setBusy] = useState(false);
  const [convertOn, setConvertOn] = useState(false);
  const [conversion, setConversion] = useState<
    | { status: 'loading' }
    | { status: 'ready'; route: 'book'; quote: ConversionQuoteWire }
    | { status: 'ready'; route: 'flow'; quote: FlowConversionQuoteWire }
    | { status: 'failed'; code: 'CONVERSION_UNQUOTABLE' | 'FLOW_ROUTE_NEEDS_NATIVE_VALUE'; upstream?: string }
  >();

  useEffect(() => {
    let cancelled = false;
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
  }, [account.address]);

  useEffect(() => {
    if (!convertOn || pre === 'loading' || pre === 'error') return;
    const permitToken = tokenBySymbol(pre, token.symbol);
    if (!permitToken || token.symbol === 'AUSD') return;
    const amount = token.wallet.value;
    if (amount <= 0n) return;
    let cancelled = false;
    setConversion({ status: 'loading' });
    const route = amount >= BOOK_CONVERSION_MIN_USDC ? 'book' : 'flow';
    if (route === 'book') {
      void quoteToAusd(amount)
        .then((quote) => {
          if (!cancelled) setConversion({ status: 'ready', route: 'book', quote });
        })
        .catch((caught: unknown) => {
          if (cancelled) return;
          setConversion({
            status: 'failed',
            code: 'CONVERSION_UNQUOTABLE',
            ...(caught instanceof ConversionUnquotable && caught.upstream ? { upstream: caught.upstream } : {}),
          });
        });
    } else {
      void quoteFlowConvert(account.address, amount)
        .then((quote) => {
          if (!cancelled) setConversion({ status: 'ready', route: 'flow', quote });
        })
        .catch((caught: unknown) => {
          if (cancelled) return;
          const code =
            caught instanceof FlowRouteUnavailable ? 'FLOW_ROUTE_NEEDS_NATIVE_VALUE' : 'CONVERSION_UNQUOTABLE';
          const upstream =
            (caught instanceof FlowRouteUnavailable || caught instanceof ConversionUnquotable) && caught.upstream
              ? caught.upstream
              : undefined;
          setConversion({ status: 'failed', code, ...(upstream ? { upstream } : {}) });
        });
    }
    return () => {
      cancelled = true;
    };
  }, [convertOn, pre, token.symbol, token.wallet.value, account.address]);

  const permitToken = pre !== 'loading' && pre !== 'error' ? tokenBySymbol(pre, token.symbol) : undefined;
  const canOfferConvert = token.symbol !== 'AUSD' && permitToken !== undefined;

  async function run() {
    if (token.wallet.value <= 0n) return;
    if (!permitToken && (pre === 'loading' || pre === 'error')) return;
    setBusy(true);
    setProgress({ state: 'VALIDATING' });
    const venue = await checkVenueClear();
    if (!venue.clear) {
      setProgress({ state: 'REJECTED', message: venue.message, refusedAtChecking: true });
      setBusy(false);
      return;
    }
    try {
      const useConversion = convertOn && conversion?.status === 'ready' && conversion.route === 'book';
      const pt = permitToken;
      const result = !pt
        ? // A Kuru-traded token without permit moves by the D2 approve triple — the
          // same batch the Move sheet builds for it (v2.1 spec 1.3: the card shows
          // only for movable tokens, and every movable token really moves).
          await moveInWithApprove({
            account,
            marginAccount: MAINNET.kuru.marginAccount as Address,
            token: token.address,
            amount: token.wallet.value,
            onProgress: (p) => {
              setProgress(p);
              if (p.state === 'RELAYING') swoosh(soundsEnabled);
            },
          })
        : convertOn && conversion?.status === 'ready' && conversion.route === 'flow'
          ? await flowConvert({
              account,
              preflight: pre as PermitPreflight,
              usdc: { ...pt, balance: token.wallet.value },
              amount: token.wallet.value,
              quote: conversion.quote,
              onProgress: (p) => {
                setProgress(p);
                if (p.state === 'RELAYING') swoosh(soundsEnabled);
              },
            })
          : await topUp({
              account,
              preflight: pre as PermitPreflight,
              token: { ...pt, balance: token.wallet.value },
              amount: token.wallet.value,
              ...(useConversion && conversion?.status === 'ready' && conversion.route === 'book'
                ? { conversion: conversion.quote }
                : {}),
              onProgress: (p) => {
                setProgress(p);
                if (p.state === 'RELAYING') swoosh(soundsEnabled);
              },
            });
      if (result.state === 'CONFIRMED') {
        ding(soundsEnabled);
        hapticConfirmed(soundsEnabled);
        try {
          recordActivity(account.address, {
            id: result.result?.txHash ?? `move-in:${token.symbol}:${Date.now()}`,
            kind: 'move',
            summary: `Moved ${formatMoney(token.wallet.value, token.decimals, token.decimals)} ${token.symbol} to your trading balance`,
            amount: token.wallet.value.toString(),
            decimals: token.decimals,
            symbol: token.symbol,
            ...(result.result?.txHash ? { txHash: result.result.txHash } : {}),
            route: 'Wallet to trading balance',
            at: Date.now(),
          });
        } catch {
          // The move is real regardless of local bookkeeping.
        }
        onMoved({ symbol: token.symbol });
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

  const arrival = recentRows.find((r) => r.kind === 'direct-deposit' && r.symbol === token.symbol);
  const confirmed = progress?.state === 'CONFIRMED';

  return (
    <section className="waiting">
      <div className="row2">
        <span className="chip warn">Waiting in your wallet</span>
        {arrival ? <span className="small">{arrivedAgo(arrival.at)}</span> : null}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0 2px' }}>
        <TokenIcon address={token.address} symbol={token.symbol} size={22} />
        <span className="fig num">
          {formatMoney(token.wallet.value, token.decimals, token.decimals)}
          <span className="cur" style={{ fontSize: 14, marginLeft: 6 }}>
            {token.symbol}
          </span>
        </span>
      </div>
      <p className="sub2" style={{ margin: '2px 0 0' }}>
        In your wallet, not yet tradable. One signature moves it to your trading balance, no gas, any
        amount.
      </p>

      {canOfferConvert ? (
        <div className="row2" style={{ marginTop: 8 }}>
          <Toggle checked={convertOn} onChange={setConvertOn} label="Also convert to AUSD" />
          <span className="small">Optional</span>
        </div>
      ) : null}

      {convertOn && canOfferConvert ? (
        <div style={{ marginTop: 8 }}>
          {conversion?.status === 'loading' || conversion === undefined ? (
            <p className="tiny muted">Reading the price…</p>
          ) : conversion.status === 'failed' ? (
            <FailureNotice failure={withDetail(failure(conversion.code), conversion.upstream)} />
          ) : (
            <div className="between small">
              <span className="muted">
                {conversion.route === 'book' ? 'On the AUSD book' : 'Via a Kuru swap'}
              </span>
              <span className="num">
                {conversion.route === 'book'
                  ? `${formatMoney(conversion.quote.expectedOut, conversion.quote.outDecimals, 6)} AUSD`
                  : `${formatMoney(conversion.quote.output, token.decimals, 6)} AUSD`}
              </span>
            </div>
          )}
        </div>
      ) : null}

      <div style={{ marginTop: 8 }}>
        <Button
          variant="primary"
          block
          disabled={token.wallet.value <= 0n || busy || pre === 'loading' || pre === 'error'}
          disabledLabel={
            busy
              ? 'Working'
              : pre === 'loading'
                ? 'Reading your account'
                : pre === 'error'
                  ? 'Could not read your account. Try again.'
                  : 'Nothing to move'
          }
          onClick={() => void run()}
        >
          Move to trading balance
        </Button>
      </div>

      {progress ? (
        <div style={{ marginTop: 12 }}>
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
                headline={`Moved ${formatMoney(token.wallet.value, token.decimals, token.decimals)} ${token.symbol}`}
                resultingBalance="Ready to trade."
                {...(progress.result?.txHash
                  ? { txHash: progress.result.txHash, explorerUrl: explorerTxUrl(progress.result.txHash) }
                  : {})}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {pre === 'error' ? (
        <div style={{ marginTop: 10 }}>
          <Notice tone="warn">Could not read whether this token can be moved by signature. Retry.</Notice>
        </div>
      ) : null}
    </section>
  );
}

function arrivedAgo(at: number): string {
  const mins = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (mins < 1) return 'Arrived just now';
  if (mins < 60) return `Arrived ${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `Arrived ${hours}h ago`;
  const days = Math.round(hours / 24);
  return `Arrived ${days}d ago`;
}
