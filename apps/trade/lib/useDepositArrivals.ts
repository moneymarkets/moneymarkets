'use client';

import { useEffect, useRef } from 'react';
import type { Address } from 'viem';
import { deriveTrackerState, trackerInputFromRow, type TrackerRow } from '@tradepro/core';
import { apiUrl } from './basePath';
import { formatMoney } from './format';
import { onDepositChanges } from './depositStream';
import { recordActivity } from './activityStore';

/**
 * Write the Activity row and raise the notification the moment a deposit resolves —
 * on whichever rail carried it.
 *
 * ## Why this exists next to `useArrivalWatcher`
 *
 * `useArrivalWatcher` notices money by comparing balance readings. That works for any
 * arrival, including ones this app knew nothing about, and it is mounted on Home and
 * Portfolio where the balance is already being polled. It cannot help the user who is
 * sitting on `/fund` watching the address they were just given: no balance poll runs
 * there, and the one screen where somebody is actually waiting was the one screen that
 * said nothing when the money landed.
 *
 * This closes that. The watcher already publishes every transition to
 * `/api/fund/stream`; a terminal one means the vendor has finished — delivered,
 * refunded or failed — and that is a fact worth a row and a notification.
 *
 * ## One definition of "resolved" (D202)
 *
 * This used to decide "resolved" from the vendor's own `terminalStatus` word, while
 * `DepositProgress`'s stepper decided it from `deriveTrackerState` — chain evidence
 * first, vendor status only as a fallback. The two could and did disagree: a deposit
 * that landed on Monad (step 4, proven by `destinationTxHash`) told the toast "done"
 * off the vendor's own SUCCESS, while the stepper on `/fund` was still waiting on a
 * push that never arrived, so it sat on "Waiting for your transfer" with the money
 * already there. Both now read the same `deriveTrackerState` output this hook shares
 * with `DepositProgress`, so there is exactly one place where "has this finished, and
 * how" is decided.
 *
 * ## What keeps it from lying, and from repeating itself
 *
 *   - **Only resolved deposits.** "In progress" is not an event; the Recent deposits
 *     list already shows it moving.
 *   - **The row is built from the server's own record**, re-read after the transition,
 *     not from the transition frame — so the amount, the symbol and the hash are the
 *     stored ones rather than anything reconstructed here.
 *   - **The id matches `depositRows()`** — the destination or refund hash where there
 *     is one, `deposit:<address>` where there is not — so the local row and the one
 *     the deposit store returns collapse into a single entry in the feed instead of
 *     appearing twice.
 *   - **`recordActivity` is idempotent on that id**, and it is what raises the
 *     notification, so one arrival can only ever produce one of each.
 *   - **Addresses seen resolved on the first read are recorded, not announced.** A
 *     deposit that finished before this tab opened has already been notified once, on
 *     whichever tab was open then; this session's own first look is a baseline.
 */

export interface WireDeposit extends TrackerRow {
  readonly depositAddress: string;
  readonly amountIn: string;
  readonly terminalAt: number | null;
}

/** Resolved the same way the stepper is: chain evidence for delivery, the shared
 * terminal derivation for a refund, an expiry or a vendor-reported failure.
 * Exported only for `useDepositArrivals.test.ts` — not part of the hook's own API. */
export function resolution(d: WireDeposit): { done: boolean; state: ReturnType<typeof deriveTrackerState> } {
  const state = deriveTrackerState(trackerInputFromRow(d, { now: Date.now() }));
  const delivered = state.steps.find((s) => s.id === 4)?.status === 'done';
  return { done: Boolean(state.terminal) || delivered, state };
}

export function summaryFor(d: WireDeposit, state: ReturnType<typeof deriveTrackerState>): string {
  if (state.terminal?.kind === 'REFUNDED') return `Deposit from ${d.chain} refunded`;
  if (state.terminal?.kind === 'EXPIRED') return `Deposit from ${d.chain} expired, nothing was sent`;
  if (state.terminal?.kind === 'FAILED') return `Deposit from ${d.chain} failed`;
  const amount = d.amountOut
    ? `${formatMoney(BigInt(d.amountOut), 6, 6)} USDC`
    : `${formatMoney(BigInt(d.amountIn), d.originDecimals ?? 0, d.originDecimals ?? 0)} ${d.originSymbol ?? ''}`;
  return `Received ${amount} from ${d.chain}`;
}

export function useDepositArrivals(account: Address | undefined): void {
  const announced = useRef(new Set<string>());
  const baselined = useRef(false);

  useEffect(() => {
    if (!account) return;
    let cancelled = false;
    announced.current = new Set();
    baselined.current = false;

    const read = async (announce: boolean) => {
      let attempts: WireDeposit[];
      try {
        const res = await fetch(apiUrl(`/api/fund/recent?recipient=${account}`), {
          cache: 'no-store',
        });
        if (!res.ok) return;
        attempts = ((await res.json()) as { attempts: WireDeposit[] }).attempts;
      } catch {
        // Unreachable read. Nothing is written, which is the right failure: a row
        // invented from a transition frame would be this app's guess at the amount.
        return;
      }
      if (cancelled) return;

      for (const d of attempts) {
        const { done, state } = resolution(d);
        if (!done) continue;
        if (announced.current.has(d.depositAddress)) continue;
        announced.current.add(d.depositAddress);
        if (!announce) continue;
        const txHash = d.destinationTxHash ?? d.refundTxHash ?? undefined;
        recordActivity(account, {
          id: txHash ?? `deposit:${d.depositAddress}`,
          kind: 'direct-deposit',
          summary: summaryFor(d, state),
          amount: d.amountIn,
          decimals: d.originDecimals ?? 0,
          symbol: d.originSymbol ?? '',
          ...(txHash ? { txHash } : {}),
          at: d.terminalAt ?? Date.now(),
        });
      }
    };

    // The baseline: everything already resolved when this tab opened is remembered
    // silently, so opening `/fund` never announces last week's deposits.
    void read(false).then(() => {
      baselined.current = true;
    });

    // Polls this account's own rows. The server-wide subscription this used to hold
    // published every other user's deposits to anyone who asked.
    const close = onDepositChanges(account, () => {
      if (!baselined.current) return;
      void read(true);
    });

    return () => {
      cancelled = true;
      close();
    };
  }, [account]);
}
