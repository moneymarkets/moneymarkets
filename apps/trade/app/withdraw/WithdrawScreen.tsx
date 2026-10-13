'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ActionResult,
  Button,
  Card,
  Empty,
  Field,
  Notice,
  Select,
  Skeleton,
  TicketState,
} from '@tradepro/ui';
import {
  assertFreshPasskey, buildWithdraw, MAINNET, type TokenInfo } from '@tradepro/core';
import type { Address } from 'viem';
import { Chrome } from '../../components/Chrome';
import { FailureNotice } from '../../components/FailureNotice';
import { SignedOut } from '../../components/SignedOut';
import { RP_ID, useSession } from '../../lib/session';
import { useAccountBalances } from '../../lib/useAccountBalances';
import { displayDp, explorerTxUrl, formatMoney, shortAddress } from '../../lib/format';
import { amountToSend, fillExact, onEdit, type AmountFieldState } from '../../lib/wallet/amountField';
import { failure } from '../../lib/failures';
import { recordActivity } from '../../lib/activityStore';
import { isTerminal, run, segmentOf, type Progress } from '../../lib/ticket';
import { isMoveOutDisabled } from '../../lib/wallet/holdings';
import { marginHoldings } from '../../lib/wallet/holdingsModel';

/**
 * `/withdraw` — trading balance back out to the user's own wallet on Monad.
 *
 * FR-07 named withdraw beside deposit as a Must and it was never built: no user story,
 * no screen in the design, no acceptance criteria. Money had one direction.
 *
 * ## Where it goes, and why that is not a field
 *
 * Always the signed-in account's own wallet on Monad. `MarginAccount.withdraw` credits
 * `msg.sender` and takes no recipient, so a destination field would be a lie in the
 * shape of a control. Sending somewhere else is a different action on a different
 * screen (`/send`), against the wallet balance this one produces.
 *
 * ## No minimum of ours
 *
 * There is none to enforce: withdrawing is not an order and `minSize` is a
 * resting-order rule (D125). If Kuru refuses a size, its own decoded error is what the
 * user reads — this screen never invents a floor to pre-empt it (the 2026-09-09 rule
 * that removed the cached one on `/fund`).
 */

interface Holding {
  readonly token: TokenInfo;
  readonly balance: bigint;
}

export function WithdrawScreen() {
  const session = useSession();
  const account = session.account;
  const balance = useAccountBalances(account?.address);
  const [selected, setSelected] = useState<string | undefined>();
  const [amountState, setAmountState] = useState<AmountFieldState>({ text: '' });
  const [progress, setProgress] = useState<Progress | undefined>();
  const [busy, setBusy] = useState(false);

  // Any token with a margin balance, listed or not (spec D3), from the one holdings
  // model every screen reads. MON stays out until the relayer's policy carries the
  // WMON wrap it needs (phase 2); the Move sheet says so in the same words.
  const holdings = useMemo<readonly Holding[]>(() => {
    return marginHoldings(balance.tokens ?? [])
      .filter((t) => !isMoveOutDisabled(t.symbol))
      .map((t) => ({
        token: { address: t.address, decimals: t.decimals, symbol: t.symbol },
        balance: t.margin.value,
      }));
  }, [balance.tokens]);

  const held = holdings.find((h) => h.token.symbol === selected) ?? holdings[0];
  const parsed = held ? amountToSend(amountState, held.token.decimals) : undefined;
  const withinBalance =
    held !== undefined && parsed !== undefined && parsed > 0n && parsed <= held.balance;

  async function withdraw() {
    if (!account || !held || parsed === undefined || !withinBalance) return;
    setBusy(true);
    setProgress(undefined);
    let result: Awaited<ReturnType<typeof run>> | undefined;
    try {
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
      await assertFreshPasskey({
        rpId: RP_ID,
        ...(account.credentialId ? { credentialId: account.credentialId } : {}),
      });

      const call = buildWithdraw(MAINNET.kuru.marginAccount as Address, held.token.address, parsed);
      result = await run({
        sender: account.address,
        calls: [call],
        purpose: 'withdraw',
        owner: account.account,
        onProgress: setProgress,
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
    // withdrawal and must not be reported as though it had — the pill already reads
    // CONFIRMED from run()'s own progress callback.
    if (result?.state === 'CONFIRMED') {
      try {
        const txHash = result.result?.txHash;
        recordActivity(account.address, {
          id: txHash ?? `withdraw:${held.token.symbol}:${Date.now()}`,
          kind: 'withdraw',
          summary: `Withdrew ${formatMoney(parsed, held.token.decimals, held.token.decimals)} ${held.token.symbol} to your wallet`,
          amount: parsed.toString(),
          decimals: held.token.decimals,
          symbol: held.token.symbol,
          token: held.token.address,
          ...(txHash ? { txHash } : {}),
          at: Date.now(),
        });
        balance.refresh();
      } catch {
        // The withdrawal is real regardless. Local activity/balance bookkeeping
        // failing is not a reason to tell the user their money didn't move.
      }
    }
  }

  if (session.status !== 'signed-in' || !account) {
    return (
      <Chrome>
        <div className="page">
          <h2 style={{ paddingTop: 6 }}>Withdraw</h2>
          <SignedOut />
        </div>
      </Chrome>
    );
  }

  const confirmed = progress?.state === 'CONFIRMED';
  const txHash = progress?.result?.txHash;

  return (
    <Chrome>
      <div className="page">
        <div className="between" style={{ paddingTop: 6 }}>
          <div>
            <h2>Withdraw</h2>
            <p className="tiny">Out of your trading balance, into your wallet</p>
          </div>
        </div>

        <Card title="From your trading balance">
          {balance.status === 'loading' ? (
            <Skeleton rows={3} />
          ) : balance.status === 'error' ? (
            <FailureNotice failure={failure('BALANCE_UNREADABLE')} onRetry={() => balance.refresh()} />
          ) : holdings.length === 0 ? (
            <>
              <Empty>Nothing in your trading balance to withdraw.</Empty>
              <div style={{ marginTop: 12 }}>
                <Link href="/fund" style={{ textDecoration: 'none' }}>
                  <Button variant="soft" size="sm">
                    Add money
                  </Button>
                </Link>
              </div>
            </>
          ) : (
            <>
              <Select
                id="withdraw-token"
                label="Token"
                value={held?.token.symbol ?? ''}
                onChange={(value) => {
                  setSelected(value);
                  setAmountState({ text: '' });
                  setProgress(undefined);
                }}
                options={holdings.map((h) => ({
                  value: h.token.symbol,
                  label: `${h.token.symbol} — ${formatMoney(h.balance, h.token.decimals, 6)} available`,
                }))}
              />

              <div style={{ marginTop: 12 }}>
                <Field
                  id="withdraw-amount"
                  label={`Amount in ${held?.token.symbol ?? ''}`}
                  value={amountState.text}
                  inputMode="decimal"
                  numeric
                  onChange={(value) => {
                    setAmountState(onEdit(value));
                    setProgress(undefined);
                  }}
                />
                <div style={{ marginTop: 8 }}>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      held && setAmountState(fillExact(held.balance, held.token.decimals, held.token.symbol))
                    }
                  >
                    Max
                  </Button>
                </div>
              </div>

              {/* Not a field: MarginAccount.withdraw credits msg.sender and takes no
                  recipient, so anything editable here would be decoration. */}
              <p className="tiny muted" style={{ marginTop: 12 }}>
                Goes to your wallet on Monad: {shortAddress(account.address)}
              </p>

              <div style={{ marginTop: 14 }}>
                <Button
                  variant="primary"
                  block
                  disabled={!withinBalance || busy}
                  disabledLabel={
                    busy
                      ? 'Working'
                      : parsed === undefined || parsed <= 0n
                        ? 'Enter an amount to withdraw'
                        : `More than your ${held?.token.symbol ?? ''} trading balance`
                  }
                  onClick={() => void withdraw()}
                >
                  Withdraw
                </Button>
              </div>
            </>
          )}
        </Card>

        {progress ? (
          <Card title="Withdrawal">
            <TicketState
              index={segmentOf(progress)}
              // A terminal state must render as finished, not mid-animation.
              settled={isTerminal(progress.state)}
              {...(progress.state === 'REJECTED' || progress.state === 'REVERTED'
                ? {
                    error: [progress.message, progress.detail].filter(Boolean).join(' '),
                  }
                : {})}
            />
            {confirmed && held ? (
              <div style={{ marginTop: 12 }}>
                <ActionResult
                  headline={`Withdrew ${formatMoney(parsed ?? 0n, held.token.decimals, displayDp(held.token.symbol, held.token.decimals))} ${held.token.symbol}`}
                  resultingBalance="It is in your wallet on Monad now."
                  {...(txHash ? { txHash, explorerUrl: explorerTxUrl(txHash) } : {})}
                  actionLabel="Back to your portfolio"
                  onAction={() => {
                    window.location.href = '/portfolio';
                  }}
                />
              </div>
            ) : null}
            {progress.state === 'RELAYING' && progress.message ? (
              <div style={{ marginTop: 10 }}>
                <Notice tone="warn">{progress.message}</Notice>
              </div>
            ) : null}
          </Card>
        ) : null}
      </div>
    </Chrome>
  );
}
