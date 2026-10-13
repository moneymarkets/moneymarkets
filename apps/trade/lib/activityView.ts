'use client';

import type { ActivityKind, ActivityRow } from './activityStore';
import { displayDp, formatMoney } from './format';
import type { WalletTokenEntry } from './useAccountBalances';
import { tokenByAddress, tokenBySymbol } from './wallet/holdingsModel';

/**
 * How an activity row is described, filtered and sorted. Shared by `/activity`, the
 * Home summary and the detail view, so a row is labelled the same everywhere.
 *
 * No formatting decisions live in the page components. A row is written once and read
 * many times, and having two places decide what to call a `move` is how they end up
 * disagreeing.
 */

export type FilterKey = 'all' | 'trades' | 'deposits' | 'moves' | 'withdrawals' | 'sends';

export const FILTERS: readonly { readonly key: FilterKey; readonly label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'trades', label: 'Trades' },
  { key: 'deposits', label: 'Deposits' },
  { key: 'moves', label: 'Moves' },
  { key: 'withdrawals', label: 'Withdrawals' },
  { key: 'sends', label: 'Sends' },
];

const KINDS_FOR: Record<Exclude<FilterKey, 'all'>, readonly ActivityKind[]> = {
  // A swap files with trades: the user chose to accept a specific price, the same as
  // an order — unlike a convert, which the account currency's own book fills at market.
  trades: ['order', 'cancel', 'swap'],
  deposits: ['direct-deposit'],
  // A conversion is a move between forms of the same money, so it files with moves
  // rather than with trades — the user did not choose a price.
  moves: ['move', 'convert'],
  withdrawals: ['withdraw'],
  sends: ['send'],
};

export function matchesFilter(row: ActivityRow, filter: FilterKey): boolean {
  if (filter === 'all') return true;
  return KINDS_FOR[filter].includes(row.kind);
}

/** The short label in the type column. Present tense noun, not a sentence. */
export function kindLabel(row: ActivityRow): string {
  switch (row.kind) {
    case 'order':
      return row.trade ? (row.trade.side === 'buy' ? 'Buy' : 'Sell') : 'Order';
    case 'cancel':
      return 'Cancelled';
    case 'direct-deposit':
      return 'Deposit';
    case 'move':
      return 'Move';
    case 'convert':
      return 'Convert';
    case 'swap':
      return 'Swap';
    case 'withdraw':
      return 'Withdrawal';
    case 'send':
      return 'Send';
  }
}

/**
 * A row's status, defaulting to confirmed.
 *
 * A row is only written once something confirmed, so the absence of a status field
 * means confirmed rather than unknown. The deposit rows are the exception: they come
 * from the server's store and can be pending or refunded, and they say so.
 */
export function statusOf(row: ActivityRow): 'confirmed' | 'failed' | 'pending' | 'refunded' {
  return row.status ?? 'confirmed';
}

export function statusTone(row: ActivityRow): 'up' | 'down' | 'warn' | 'neutral' {
  switch (statusOf(row)) {
    case 'confirmed':
      return 'up';
    case 'failed':
      return 'down';
    case 'refunded':
      return 'warn';
    case 'pending':
      return 'warn';
  }
}

export function statusLabel(row: ActivityRow): string {
  switch (statusOf(row)) {
    case 'confirmed':
      return 'Confirmed';
    case 'failed':
      return 'Failed';
    case 'refunded':
      return 'Refunded';
    case 'pending':
      return 'In progress';
  }
}

/** Market for a trade, route for anything else, and nothing when neither was recorded. */
export function whereText(row: ActivityRow): string | undefined {
  return row.market ?? row.route;
}

/**
 * Which time group a row falls into (design §5.7): "Last 24 hours", "Yesterday",
 * "Last 7 days" or "Earlier", computed from the row's own timestamp against now.
 * Rows are already read newest-first, so a caller walking the list in order sees
 * each group's rows together without having to bucket the whole list up front.
 */
export type ActivityGroup = 'Last 24 hours' | 'Yesterday' | 'Last 7 days' | 'Earlier';

export function groupFor(at: number, now = Date.now()): ActivityGroup {
  const hours = (now - at) / 3_600_000;
  if (hours < 24) return 'Last 24 hours';
  if (hours < 48) return 'Yesterday';
  if (hours < 24 * 7) return 'Last 7 days';
  return 'Earlier';
}

/** Relative time. The absolute one is always available beside it, never instead of it. */
export function relativeTime(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * The exact time, with its zone named.
 *
 * A timestamp without a zone is a timestamp someone will read wrong, and this is the
 * screen people open to reconcile against an exchange statement or a bank line.
 */
export function absoluteTime(at: number): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `${new Date(at).toLocaleString()} (${zone})`;
}

/**
 * Amount with its token, or nothing. Never a bare number (rule: amounts carry units),
 * and never more places than the token's display precision (spec F2).
 */
export function amountText(row: ActivityRow, format: (v: bigint, d: number, p: number) => string) {
  if (row.amount === undefined || row.decimals === undefined || !row.symbol) return undefined;
  return `${format(BigInt(row.amount), row.decimals, displayDp(row.symbol, row.decimals))} ${row.symbol}`;
}

/**
 * What a summary row shows, as data (spec E4): the token's icon from the registry, an
 * "unverified" chip when no list names it, and the amount at display precision. Pure,
 * so it is tested without rendering; `ActivityList` renders it.
 */
export interface ActivityRowView {
  readonly title: string;
  readonly amountText?: string;
  readonly symbol?: string;
  readonly iconUrl: string | null;
  /** The token's contract, for its icon, when the row names one. */
  readonly address?: string;
  /** A token this account holds that no registry source lists. */
  readonly unverified: boolean;
}

export function activityRowView(row: ActivityRow, tokens: readonly WalletTokenEntry[] = []): ActivityRowView {
  const resolved =
    (row.token ? tokenByAddress(tokens, row.token) : undefined) ??
    (row.symbol ? tokenBySymbol(tokens, row.symbol) : undefined);
  const amount = amountText(row, formatMoney);
  return {
    title: row.summary,
    ...(amount ? { amountText: amount } : {}),
    ...(row.symbol ? { symbol: row.symbol } : {}),
    iconUrl: resolved?.iconUrl ?? null,
    ...((resolved?.address ?? row.token) ? { address: resolved?.address ?? row.token } : {}),
    unverified: resolved !== undefined && !resolved.listed,
  };
}
