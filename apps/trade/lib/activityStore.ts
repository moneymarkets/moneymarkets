'use client';

import type { Address } from 'viem';
import { notify } from './notifications';

/**
 * The local record of things this app watched itself do.
 *
 * Source 4 of the activity feed. The other three sources are the deposit store, the
 * order store, and bounded on-chain reads — but a move, a conversion, a withdrawal, a
 * send or a direct deposit either has no event this app can cheaply find again, or has
 * one that a 100-block `eth_getLogs` window will have scrolled past within a minute
 * (the public RPC cap, recorded as C2). So the moment it happens is the moment to
 * write it down.
 *
 * **It is a record, never a claim.** Every row here carries a transaction hash that a
 * receipt actually returned, or it is not written. Nothing infers, nothing predicts,
 * and a row is never added for an action that was only attempted. Per browser, per
 * account, like the order store — and, like the order store, losing it loses the list
 * and not the money.
 */

export type ActivityKind =
  'direct-deposit' | 'move' | 'convert' | 'swap' | 'withdraw' | 'send' | 'order' | 'cancel';

export interface ActivityRow {
  /** Stable id: the tx hash where there is one, so a merge de-duplicates on it. */
  readonly id: string;
  readonly kind: ActivityKind;
  /** Plain words, past tense, written by the caller: "Received 1.00 USDC". */
  readonly summary: string;
  /** Base units of the asset that moved, as a decimal string. */
  readonly amount?: string;
  readonly decimals?: number;
  readonly symbol?: string;
  /**
   * The token's contract address (any-token wallet, spec E4), so a row about a token no
   * list names can still show its icon and its "unverified" chip. Absent on rows
   * written before it existed; those resolve by `symbol` where a match is unambiguous.
   */
  readonly token?: string;
  readonly txHash?: string;
  /** Unix ms. The app's clock, which is the only one it has for a local record. */
  readonly at: number;
  /**
   * True for a row repairing history that predates this store.
   *
   * It changes exactly one thing: no notification is raised. The row is as real as
   * any other — every one of them is a transaction on chain — but it did not just
   * happen, and a notification says that it did.
   */
  readonly backfilled?: boolean;
  /**
   * The two sides of a fill, when this row is one.
   *
   * Cost basis (ITEM 7) needs what was paid as well as what was received, and a
   * summary sentence is not a number. Present only on rows the app watched settle
   * with both sides known; absent means no basis can be computed from this row, and
   * nothing infers one.
   */
  readonly trade?: {
    readonly side: 'buy' | 'sell';
    readonly baseAmount: string;
    readonly baseSymbol: string;
    readonly baseDecimals: number;
    readonly quoteAmount: string;
    readonly quoteSymbol: string;
    readonly quoteDecimals: number;
  };

  /* ---------- detail fields (ITEM 4c) ----------
   *
   * Every one of these is optional, and that is the design rather than laziness. The
   * detail view omits a line it has no value for instead of rendering a blank or a
   * dash: a row written before a field existed genuinely does not know it, and a
   * placeholder would be this app claiming to have recorded something it did not.
   *
   * Nothing here is ever computed at read time. A row is written once, from what the
   * receipt actually said, and never recomputed — so a figure shown in the detail view
   * is the figure that was true at the moment it happened.
   */

  /** "MON/USDC" for a trade. Absent for anything that is not on a book. */
  readonly market?: string;
  /** How the money travelled: "Wallet to trading balance", "Sent from 0x…", a chain. */
  readonly route?: string;
  /** Under 7702 this is the handle a user actually has; the tx hash is the bundler's. */
  readonly userOpHash?: string;
  readonly blockNumber?: number;
  /** 'confirmed' unless the row records something else. Absent reads as confirmed. */
  readonly status?: 'confirmed' | 'failed' | 'pending' | 'refunded';
  /** The balance this action left behind, and where it lives. Written at the time. */
  readonly resultingBalance?: string;
  readonly resultingLocation?: 'wallet' | 'trading balance';
  /** Fees other than gas. Gas is always "paid for you" and is stated, not stored. */
  readonly feeText?: string;

  /** Order rows: what the book recorded. */
  readonly order?: {
    readonly id?: string;
    readonly priceText?: string;
    readonly sizeText?: string;
    readonly filledText?: string;
    readonly remainingText?: string;
  };

  /** Deposit rows: where it came from, and what the upstream said if it went wrong. */
  readonly deposit?: {
    readonly sourceChain?: string;
    readonly depositAddress?: string;
    /** The upstream's own sentence, verbatim and source-named. Never a substitute. */
    readonly upstreamMessage?: string;
  };
}

const LIMIT = 100;

function key(account: Address): string {
  return `tradepro.activity.${account.toLowerCase()}`;
}

export function readActivity(account: Address): ActivityRow[] {
  try {
    const raw = window.localStorage.getItem(key(account));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (v): v is ActivityRow =>
        typeof v === 'object' &&
        v !== null &&
        typeof (v as ActivityRow).id === 'string' &&
        typeof (v as ActivityRow).summary === 'string' &&
        typeof (v as ActivityRow).at === 'number',
    );
  } catch {
    return [];
  }
}

/**
 * Write one row. Idempotent on `id`, because the same arrival can be noticed by two
 * polls and a feed that shows a deposit twice is worse than one that shows it late.
 */
export function recordActivity(account: Address, row: ActivityRow): void {
  let written = false;
  try {
    const current = readActivity(account);
    if (current.some((r) => r.id === row.id)) return;
    const next = [row, ...current].slice(0, LIMIT);
    window.localStorage.setItem(key(account), JSON.stringify(next));
    written = true;
  } catch {
    // Storage blocked. The feed then covers this session only, which is still honest.
  }

  /**
   * One row, one notification (ITEM 6).
   *
   * Raised here rather than at each call site, so a notification exists for every
   * real event and cannot exist for anything else — and it is raised *after* the row
   * is written, so tapping the notification always lands on a row that is there.
   *
   * Backfilled rows are excluded: they describe transactions from before this store
   * existed, and telling someone their trade from yesterday just happened would be a
   * false statement dressed as a helpful one.
   */
  if (!written || row.backfilled) return;
  notify(account, {
    id: row.id,
    title: row.summary,
    ...(row.txHash ? {} : { detail: 'No transaction hash was found for this one.' }),
    at: row.at,
    href: `/activity?id=${encodeURIComponent(row.id)}`,
  });
}
