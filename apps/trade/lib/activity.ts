'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Address } from 'viem';
import { apiUrl } from './basePath';
import { displayDp, formatMoney } from './format';
import { readActivity, recordActivity, type ActivityRow } from './activityStore';

/**
 * The activity feed, built from what this app already knows.
 *
 * ## It does not scan the chain, on purpose
 *
 * The original requirement (US-6 AC2) made history indexer-dependent, and the indexer
 * has never run, so `/portfolio` said "History syncing" for its entire life about a
 * process that did not exist. The obvious repair — scan `eth_getLogs` for the user's
 * events — is worse than it looks: the public RPC caps a range at 100 blocks (C2),
 * which at 400 ms blocks is forty seconds, so any "history" it produced would be a
 * lookback window pretending to be a record.
 *
 * So there is no scan, no lookback, and no "showing the last N hours". Every row comes
 * from something this app watched happen and wrote down at the time
 * (`activityStore.ts`) or from the deposit store the server already keeps. Written
 * once, on the receipt, never recomputed.
 *
 * ## The two things that happen without the user acting
 *
 * Both still produce a row, and neither needs a scan:
 *
 *   1. **A resting order fills while they are away.** The app already tracks its own
 *      open orders. When one leaves the book, `/api/orders` stops returning it — that
 *      is a targeted lookup of ids we already hold, not a search. The row carries the
 *      side from the order record, never from `Trade.isBuy`, which is the taker's side
 *      and therefore backwards for the maker a resting fill makes you.
 *   2. **Money arrives that they did not send.** The balance poll already runs. A
 *      wallet balance that rises with no action of ours in flight is an arrival;
 *      `/api/account/incoming` is asked for the transaction, and when it cannot find
 *      one the row is still written with the amount and the time, marked as having no
 *      known hash. A row without a hash is honest; a missing row is not.
 */

export interface ActivityFeed {
  readonly status: 'loading' | 'ready';
  readonly rows: readonly ActivityRow[];
  /**
   * True when the deposit store could not be read.
   *
   * The local record still stands on its own, so the list is not empty and not wrong —
   * it is **short**, and silently short is the problem. A user looking for a deposit
   * that is missing because a fetch failed would conclude the deposit was lost. The
   * screen says a source is missing instead.
   */
  readonly depositsUnavailable: boolean;
  refresh: () => void;
}

/** A deposit attempt as `/api/fund/recent` returns it. */
interface WireDeposit {
  depositAddress: string;
  chain: string;
  amountIn: string;
  originDecimals: number;
  originSymbol: string;
  createdAt: number;
  terminalAt: number | null;
  lastStatus: string;
  terminalStatus: string | null;
  amountOut: string | null;
  destinationTxHash: string | null;
  refundTxHash: string | null;
}

function depositRows(deposits: readonly WireDeposit[]): ActivityRow[] {
  return deposits.map((d) => {
    const delivered = d.terminalStatus === 'SUCCESS';
    const refunded = d.terminalStatus === 'REFUNDED';
    const summary = delivered
      ? `Deposit from ${d.chain} delivered`
      : refunded
        ? `Deposit from ${d.chain} refunded`
        : d.terminalStatus === 'FAILED'
          ? `Deposit from ${d.chain} failed`
          : `Deposit from ${d.chain} in progress`;
    const txHash = d.destinationTxHash ?? d.refundTxHash ?? undefined;
    return {
      // The deposit address is unique per attempt and stable, so it de-duplicates
      // against itself across reloads even before a hash exists.
      id: txHash ?? `deposit:${d.depositAddress}`,
      kind: 'direct-deposit' as const,
      summary,
      amount: d.amountIn,
      decimals: d.originDecimals,
      symbol: d.originSymbol,
      ...(txHash ? { txHash } : {}),
      at: d.terminalAt ?? d.createdAt,
    };
  });
}

export function useActivity(account: Address | undefined): ActivityFeed {
  const [rows, setRows] = useState<readonly ActivityRow[]>([]);
  const [status, setStatus] = useState<ActivityFeed['status']>('loading');
  const [depositsUnavailable, setDepositsUnavailable] = useState(false);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!account) {
      setRows([]);
      setStatus('ready');
      return;
    }
    let cancelled = false;

    void (async () => {
      const local = readActivity(account);
      let deposits: ActivityRow[] = [];
      let depositsFailed = false;
      try {
        const res = await fetch(apiUrl(`/api/fund/recent?recipient=${account}`), {
          cache: 'no-store',
        });
        if (res.ok) {
          const body = (await res.json()) as { attempts: WireDeposit[] };
          deposits = depositRows(body.attempts);
        } else {
          depositsFailed = true;
        }
      } catch {
        // The local record still stands on its own. A deposit list that did not load
        // is a missing source, not an empty history — and the screen must say which.
        depositsFailed = true;
      }
      if (cancelled) return;
      setDepositsUnavailable(depositsFailed);

      // Merge and de-duplicate on id — a tx hash where one exists, so the same event
      // recorded locally and returned by the deposit store collapses into one row.
      const byId = new Map<string, ActivityRow>();
      for (const row of [...local, ...deposits]) {
        if (!byId.has(row.id)) byId.set(row.id, row);
      }
      setRows([...byId.values()].sort((a, b) => b.at - a.at));
      setStatus('ready');
    })();

    return () => {
      cancelled = true;
    };
  }, [account, nonce]);

  return { status, rows, depositsUnavailable, refresh };
}

/**
 * A resting order this app is tracking, as `/api/orders` re-read it from `s_orders`.
 *
 * `isBuy` here is the **order owner's own side**, straight out of the order record —
 * not an event field, and not something anyone has to infer. That distinction is the
 * whole reason this watcher takes records rather than ids.
 */
export interface WatchedOrder {
  readonly id: string;
  readonly isBuy: boolean;
  /** Already rendered for display, with its token, by the caller that has the params. */
  readonly sizeText?: string;
  readonly priceText?: string;
}

/**
 * Watch the tracked open orders and write a row when one leaves the book.
 *
 * A targeted lookup, not a search: the ids are ones this app recorded itself, and
 * `/api/orders` reads `s_orders(id)` for each. An id that stops coming back has either
 * filled or been cancelled.
 *
 * ## The side comes from the order, never from an event
 *
 * This used to take a bare list of ids and write "Order 13130688 left the book —
 * filled or cancelled": no side, no size, no price. It was not *wrong*, because it
 * asserted nothing, but it was close to useless on the one screen a user opens to find
 * out what happened while they were away.
 *
 * It now takes the whole record, and the side on it is the user's own resting side as
 * `s_orders` reports it. That is deliberately not `Trade.isBuy`, which is the **taker's**
 * side — a maker reading it directly gets the opposite of what they did, which is
 * exactly the error the 2026-09-09 audit found in two places. A resting order that fills
 * makes its owner the maker, so this is precisely the case where reading the event would
 * have been backwards.
 *
 * ## Filled or cancelled, told apart honestly
 *
 * A cancel this app performs writes its own row first (`OpenOrdersCard`), so an id that
 * disappears with a cancel already recorded for it is a cancel, and anything else is a
 * fill. Before this pass that reasoning was written down as a comment and was false —
 * nothing recorded a cancel anywhere — so the watcher would have called every cancel a
 * fill. `cancelledIds` is what makes the sentence true.
 */
export function useFillWatcher(
  account: Address | undefined,
  openOrders: readonly WatchedOrder[],
  market: string,
): void {
  const seen = useRef<readonly WatchedOrder[] | undefined>(undefined);

  useEffect(() => {
    if (!account) return;
    const before = seen.current;
    seen.current = openOrders;
    if (!before) return; // the first reading is a baseline, never a departure

    for (const order of before) {
      if (openOrders.some((o) => o.id === order.id)) continue;

      recordActivity(
        account,
        departedRow(order, market, wasCancelled(account, market, order.id), Date.now()),
      );
    }
  }, [openOrders, account, market]);
}

/**
 * The row an order's disappearance produces.
 *
 * Pure and exported so the side, the wording and the fill-versus-cancel decision can be
 * asserted directly — this is the path that runs when nobody is watching, so it is the
 * one least likely to be noticed if it goes wrong.
 */
export function departedRow(
  order: WatchedOrder,
  market: string,
  cancelled: boolean,
  at: number,
): ActivityRow {
  // The user's own resting side, from `s_orders`. Never `Trade.isBuy`, which is the
  // taker's side and therefore the opposite of what a filled maker did.
  const side = order.isBuy ? 'buy' : 'sell';
  const what = [order.sizeText, order.priceText ? `at ${order.priceText}` : undefined]
    .filter(Boolean)
    .join(' ');
  return {
    id: `${cancelled ? 'cancel' : 'fill'}:${market}:${order.id}`,
    kind: cancelled ? 'cancel' : 'order',
    summary: cancelled
      ? `Cancelled your ${side} order${what ? ` for ${what}` : ''} on ${market}`
      : `Your ${side} order${what ? ` for ${what}` : ''} filled on ${market}`,
    at,
    market,
    order: {
      id: order.id,
      ...(order.priceText ? { priceText: order.priceText } : {}),
      ...(order.sizeText ? { sizeText: order.sizeText } : {}),
    },
  };
}

/**
 * Did this app cancel that order itself?
 *
 * `OpenOrdersCard` writes a `cancel:` row the moment a cancellation confirms, so the
 * question is answerable from the record the app already keeps rather than from the
 * chain. An order that vanished with no such row filled.
 */
function wasCancelled(account: Address, market: string, orderId: string): boolean {
  return readActivity(account).some((r) => r.id === `cancel:${market}:${orderId}`);
}

/** One wallet balance this watcher compares, as `useAccountBalances` returns `tokens[]`. */
interface WalletTokenReading {
  readonly address: Address;
  readonly symbol: string;
  readonly wallet: { readonly value: bigint; readonly decimals: number };
}

const NATIVE_MON_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Write a row when money arrives that this app did not send.
 *
 * The balance poll is already running, five seconds apart, for the screens that show
 * numbers. A token balance that is higher than the previous reading means something
 * arrived; that is the whole detection, and it costs no extra call.
 *
 * Two deliberate choices:
 *
 *   - **The first reading is a baseline, never an arrival.** Otherwise every page load
 *     would report the account's entire balance as having just turned up.
 *   - **A rise with no hash is still written.** `/api/account/incoming` looks back a
 *     bounded number of blocks (the public RPC caps a range at 100 blocks, C2), so a
 *     transfer that landed while the tab was closed is real and unnameable at the same
 *     time. The row says the amount and the time and says the hash is not known. A row
 *     without a hash is honest; a missing row is not.
 *
 * Rises this app caused are excluded by the caller: `pause` is held true from the
 * moment a user action is submitted until its own row has been written, so a withdrawal
 * landing in the wallet is not also announced as an arrival.
 */
export function useArrivalWatcher(
  account: Address | undefined,
  tokens: readonly WalletTokenReading[] | undefined,
  pause = false,
): void {
  const seen = useRef<ReadonlyMap<string, WalletTokenReading> | undefined>(undefined);

  useEffect(() => {
    if (!account || !tokens) return;
    // Any token, by address (spec A2d): an airdrop of a token no list names is an
    // arrival exactly like a USDC one.
    const now = new Map(tokens.map((t) => [t.address.toLowerCase(), t]));
    const before = seen.current;
    seen.current = now;
    if (!before || pause) return;

    for (const [key, reading] of now) {
      const previous = before.get(key);
      // A token seen for the first time on this poll is a baseline for itself, not an
      // arrival: its whole balance would otherwise read as having just landed.
      if (!previous) continue;
      const rise = reading.wallet.value - previous.wallet.value;
      if (rise <= 0n) continue;
      const { symbol, address } = reading;
      const decimals = reading.wallet.decimals;
      const at = Date.now();

      void (async () => {
        let txHash: string | undefined;
        if (address.toLowerCase() !== NATIVE_MON_ADDRESS) {
          try {
            const res = await fetch(
              apiUrl(`/api/account/incoming?address=${account}&token=${address}`),
              { cache: 'no-store' },
            );
            if (res.ok) {
              const body = (await res.json()) as { txHash?: string | null };
              if (body.txHash) txHash = body.txHash;
            }
          } catch {
            // Unreachable lookup. The arrival still happened; the row still gets written.
          }
        }
        recordActivity(account, {
          // Keyed on the hash when there is one, so the same arrival noticed by two
          // polls collapses; on the amount and the second when there is not.
          id: txHash ?? `arrival:${symbol}:${rise.toString()}:${Math.floor(at / 1000)}`,
          kind: 'direct-deposit',
          summary: `Received ${formatMoney(rise, decimals, displayDp(symbol, decimals))} ${symbol} in your wallet`,
          amount: rise.toString(),
          decimals,
          symbol,
          token: address,
          ...(txHash ? { txHash } : {}),
          at,
        });
      })();
    }
  }, [tokens, account, pause]);
}
