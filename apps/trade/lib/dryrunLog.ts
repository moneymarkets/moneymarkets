'use client';

import type { Address, Hex } from 'viem';

/**
 * What a dry run would have sent.
 *
 * `MODE=dryrun` stops at `submit()`, which returns `DRYRUN` and sends nothing. The
 * calldata it was asked to send is real, though — it came out of `buildLimitOrder`,
 * `buildMarketOrder` or `buildCancelOrders` in `@tradepro/core`, against the market's
 * own `getMarketParams()`. Throwing it away would make a dry run unreviewable, so it
 * is kept here, in this browser, marked as simulated.
 *
 * Nothing in this log is a claim about the chain. There is no transaction hash, no
 * block, no receipt — those do not exist, because nothing was sent. What is stored is
 * exactly the bytes the sponsored user operation would have carried.
 */

export const DRYRUN_LOG_KEY = 'tradepro.dryrun.log';
const LIMIT = 40;

export interface DryRunEntry {
  /** Always true. Present in the stored JSON so a reader cannot mistake it. */
  readonly simulated: true;
  readonly purpose: 'order' | 'cancel' | 'deposit' | 'withdraw' | 'swap';
  readonly sender: Address;
  readonly calls: readonly { readonly to: Address; readonly data: Hex }[];
  /** Why nothing was sent, from `submit()` itself. */
  readonly reason: string;
  readonly at: number;
}

export function readDryRunLog(): readonly DryRunEntry[] {
  try {
    const raw = window.localStorage.getItem(DRYRUN_LOG_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DryRunEntry[]) : [];
  } catch {
    return [];
  }
}

export function recordDryRun(entry: DryRunEntry): void {
  try {
    const next = [entry, ...readDryRunLog()].slice(0, LIMIT);
    window.localStorage.setItem(DRYRUN_LOG_KEY, JSON.stringify(next));
  } catch {
    // Storage blocked. The run still happened; it is just not reviewable later.
  }
}
