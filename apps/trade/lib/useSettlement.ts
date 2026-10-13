'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Address } from 'viem';
import type { SettlementProgress } from '@tradepro/core';
import { apiUrl } from './basePath';
import type { TicketState } from './ticket';

/**
 * The last two deposit steps, read from the chain.
 *
 * ## Why these cannot come from the swap
 *
 * The solver network reports `SUCCESS` when it has delivered — into the user's
 * **wallet**. It has no view of Kuru's MarginAccount and never will. So a step list
 * driven by swap status alone ticked "Landing in your Kuru balance" and "Ready to
 * trade" while the money sat untouched in the wallet and the user had moved nothing.
 *
 * This hook supplies the two facts that justify those ticks:
 *
 *   `moveConfirmed`    the move transaction reached MINED or CONFIRMED
 *   `marginIncreased`  `MarginAccount.getBalance(user, AUSD)` is above where it
 *                      started — the balance actually rose, rather than a transaction
 *                      merely having been accepted
 *
 * The second is deliberately a *comparison*, not a non-zero test: an account that
 * already had a trading balance would otherwise light the final step before it moved
 * anything at all.
 *
 * ## The baseline survives a reload
 *
 * `externalBaseline` is the watcher's own snapshot (`margin_balance_before`), captured
 * server-side the moment the deposit was registered — before anything arrived. Without
 * it, a page opened after a move already happened had no "before" to compare against:
 * this hook's own first read becomes the baseline, which means a reload right after
 * delivery could never prove the balance rose. The server-side snapshot is preferred
 * when present; the hook's own first read is the fallback for a snapshot that failed
 * (best-effort, same as `refund_balance_before`).
 */
export interface SettlementState extends SettlementProgress {
  /** Margin balance when this hook first read it, before any move. */
  readonly baseline?: bigint;
  readonly current?: bigint;
  readonly baselineBlock?: bigint;
  readonly currentBlock?: bigint;
  readonly moveTxHash?: string;
  refresh: () => void;
}

const POLL_MS = 4000;

export function useSettlement(
  address: Address | undefined,
  moveState: TicketState | undefined,
  options?: {
    /** The tx hash of the move, once known — step 5's evidence when it is what proved the tick. */
    moveTxHash?: string;
    /** The watcher's own "before" snapshot, from `margin_balance_before`/`_block`. */
    externalBaseline?: { balance: bigint; block: bigint };
    /** Keep polling even with no local move in flight — e.g. step 4 is already done. */
    watch?: boolean;
    /** The delivered token's margin balance to read. Defaults to AUSD when omitted. */
    token?: Address;
  },
): SettlementState {
  const baseline = useRef<bigint | undefined>(undefined);
  const baselineBlock = useRef<bigint | undefined>(undefined);
  const [current, setCurrent] = useState<bigint | undefined>();
  const [currentBlock, setCurrentBlock] = useState<bigint | undefined>();
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  // A move that has been mined has done what it can do; whether it *worked* is the
  // margin read below, not this.
  const moveConfirmed = moveState === 'MINED' || moveState === 'CONFIRMED';

  const externalBaselineBalance = options?.externalBaseline?.balance;
  const externalBaselineBlock = options?.externalBaseline?.block;

  useEffect(() => {
    if (externalBaselineBalance !== undefined) {
      baseline.current = externalBaselineBalance;
      baselineBlock.current = externalBaselineBlock;
    }
  }, [externalBaselineBalance, externalBaselineBlock]);

  useEffect(() => {
    if (!address) {
      baseline.current = externalBaselineBalance;
      baselineBlock.current = externalBaselineBlock;
      setCurrent(undefined);
      setCurrentBlock(undefined);
      return;
    }
    let cancelled = false;

    const read = async () => {
      try {
        const tokenParam = options?.token ? `&token=${options.token}` : '';
        const res = await fetch(apiUrl(`/api/account?address=${address}${tokenParam}`), {
          cache: 'no-store',
        });
        if (!res.ok) return;
        const body = (await res.json()) as { marginBalance: string; blockNumber?: string };
        if (cancelled) return;
        const value = BigInt(body.marginBalance);
        const block = body.blockNumber !== undefined ? BigInt(body.blockNumber) : undefined;
        // The server-side snapshot wins where it exists; the first successful read here
        // is the fallback baseline for a snapshot that was never captured.
        if (baseline.current === undefined) {
          baseline.current = value;
          baselineBlock.current = block;
        }
        setCurrent(value);
        setCurrentBlock(block);
      } catch {
        // A failed read leaves the last known value alone. It must not be treated as
        // "the balance went back down", which would un-tick a step that really happened.
      }
    };

    void read();
    // Poll while a move is in flight, has just landed, or the caller asked to watch
    // regardless (step 4 already done, so step 5 may complete with no local move at
    // all — a margin-landing rail, or a move made in an earlier session).
    const active = moveState !== undefined || options?.watch === true;
    const id = active ? window.setInterval(read, POLL_MS) : undefined;
    return () => {
      cancelled = true;
      if (id !== undefined) window.clearInterval(id);
    };
  }, [address, moveState, nonce, options?.watch, options?.token, externalBaselineBalance, externalBaselineBlock]);

  const marginIncreased =
    baseline.current !== undefined && current !== undefined && current > baseline.current;

  return {
    moveConfirmed,
    marginIncreased,
    ...(baseline.current === undefined ? {} : { baseline: baseline.current }),
    ...(current === undefined ? {} : { current }),
    ...(baselineBlock.current === undefined ? {} : { baselineBlock: baselineBlock.current }),
    ...(currentBlock === undefined ? {} : { currentBlock }),
    ...(options?.moveTxHash ? { moveTxHash: options.moveTxHash } : {}),
    refresh,
  };
}
