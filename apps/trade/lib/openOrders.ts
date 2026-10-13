'use client';

import { apiUrl } from './basePath';
import { detailFrom, type WireErrorBody } from './upstream';

import { useCallback, useEffect, useState } from 'react';
import type { Address } from 'viem';
import type { SimulatedOrder } from './ticket';

/**
 * Open orders.
 *
 * There is no on-chain call that enumerates a user's orders, and the public Monad RPC
 * caps `eth_getLogs` at a 100-block range, so a complete order list needs the indexer
 * — Phase 3 (spec 9). What this app can do honestly now is remember the ids of the
 * orders it watched itself create, and confirm each one against `s_orders(id)`; a
 * filled or cancelled order reports a zero owner and drops out of the list.
 *
 * Consequence, stated plainly on the screen: until an order is actually placed, this
 * list is empty. It is never seeded with an example.
 *
 * In `MODE=dryrun` an order is checked and not sent, so there is nothing on chain to
 * re-read. Those are kept in a **separate** list of simulated orders, each carrying
 * `simulated: true` and the real calldata that was built, and every screen that shows
 * one labels it. A simulated order is never queried against `s_orders` and never
 * counted as an on-chain order.
 */

export interface OpenOrder {
  readonly id: string;
  /**
   * Shown before `s_orders` has confirmed it, never instead of confirming it.
   *
   * The receipt gives us the order id, so the moment an order is placed the app knows
   * it exists — but the list only refreshed after a round trip to `/api/orders`, so a
   * user watched "No open orders" for a beat after placing one and reasonably wondered
   * whether it had worked.
   *
   * A pending row is labelled as pending and is **dropped by the very next successful
   * read**, whatever that read says. It is a claim about what we just watched happen,
   * with a hard expiry — not a row that can outlive the truth. An order that filled
   * instantly disappears on that read rather than lingering as a phantom.
   */
  readonly pending?: boolean;
  readonly size: string;
  readonly price: string;
  readonly isBuy: boolean;
  /**
   * The transaction this order was created in, when the app watched it happen.
   *
   * A gasless user cannot find it any other way: the bundler sends the transaction to
   * the EntryPoint, so their own address's "Transactions" tab never shows it. Stored
   * beside the id rather than fetched, because `s_orders` does not carry it.
   */
  readonly txHash?: string;
}

/** What is remembered per order. A bare string is the pre-2026-09-09 shape. */
interface TrackedOrder {
  readonly id: string;
  readonly txHash?: string;
}

export interface OpenOrdersState {
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  /** Confirmed on chain, re-read from `s_orders`. */
  readonly orders: readonly OpenOrder[];
  /** Checked and not sent. Always rendered as simulated. */
  readonly simulated: readonly SimulatedOrder[];
  readonly message?: string;
  track: (orderId: string, txHash?: string, optimistic?: OptimisticOrder) => void;
  forget: (orderId: string) => void;
  trackSimulated: (order: SimulatedOrder) => void;
  forgetSimulated: (order: SimulatedOrder) => void;
  refresh: () => void;
}

/** What the ticket already knows about an order at the moment it is placed. */
export interface OptimisticOrder {
  readonly size: string;
  readonly price: string;
  readonly isBuy: boolean;
}

function storageKey(market: Address, owner: Address): string {
  return `tradepro.orders.${market.toLowerCase()}.${owner.toLowerCase()}`;
}

function simulatedKey(market: Address, owner: Address): string {
  return `tradepro.simulated.${market.toLowerCase()}.${owner.toLowerCase()}`;
}

function readSimulated(market: Address, owner: Address): SimulatedOrder[] {
  try {
    const raw = window.localStorage.getItem(simulatedKey(market, owner));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Anything without the flag is not trusted into a list the screen labels.
    return parsed.filter(
      (v): v is SimulatedOrder =>
        typeof v === 'object' && v !== null && (v as SimulatedOrder).simulated === true,
    );
  } catch {
    return [];
  }
}

function writeSimulated(market: Address, owner: Address, rows: readonly SimulatedOrder[]): void {
  try {
    window.localStorage.setItem(simulatedKey(market, owner), JSON.stringify(rows));
  } catch {
    // Storage blocked. The list is then per-page-load, which is still honest.
  }
}

function readTracked(market: Address, owner: Address): TrackedOrder[] {
  try {
    const raw = window.localStorage.getItem(storageKey(market, owner));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Both shapes: ids were stored as bare strings before the tx hash was kept.
    return parsed.flatMap((v): TrackedOrder[] => {
      if (typeof v === 'string') return [{ id: v }];
      if (typeof v === 'object' && v !== null && typeof (v as TrackedOrder).id === 'string') {
        const row = v as TrackedOrder;
        return [row.txHash ? { id: row.id, txHash: row.txHash } : { id: row.id }];
      }
      return [];
    });
  } catch {
    return [];
  }
}

function writeTracked(market: Address, owner: Address, ids: readonly TrackedOrder[]): void {
  try {
    window.localStorage.setItem(storageKey(market, owner), JSON.stringify(ids));
  } catch {
    // Storage blocked. The list is then per-page-load, which is still honest.
  }
}

/**
 * @param live Whether this deployment sends real transactions, from `/api/status`.
 *   When true, simulated rows are **not returned and are purged from storage**. A dry
 *   run is a record of something that was checked and never sent; showing one beside
 *   real resting orders on a live account invites cancelling an order that does not
 *   exist, and on 2026-09-10 two "Buy 4.03 MON — Simulated" rows were doing exactly
 *   that. `undefined` means the status has not loaded, and nothing is purged on a
 *   guess — the rows simply stay hidden until the answer arrives.
 */
export function useOpenOrders(
  market: Address,
  owner: Address | undefined,
  live?: boolean,
): OpenOrdersState {
  const [ids, setIds] = useState<readonly TrackedOrder[]>([]);
  const [orders, setOrders] = useState<readonly OpenOrder[]>([]);
  /** Optimistic rows, retired by the next successful `/api/orders` read. */
  const [pending, setPending] = useState<readonly OpenOrder[]>([]);
  const [simulated, setSimulated] = useState<readonly SimulatedOrder[]>([]);
  const [status, setStatus] = useState<OpenOrdersState['status']>('idle');
  const [message, setMessage] = useState<string | undefined>();
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!owner) {
      setIds([]);
      setOrders([]);
      setSimulated([]);
      setStatus('idle');
      return;
    }
    setIds(readTracked(market, owner));
    setSimulated(readSimulated(market, owner));
  }, [market, owner]);

  useEffect(() => {
    if (!owner) return;
    if (ids.length === 0) {
      setOrders([]);
      setStatus('ready');
      setMessage(undefined);
      return;
    }
    let cancelled = false;
    setStatus('loading');

    void (async () => {
      try {
        const res = await fetch(
          apiUrl(
            `/api/orders?market=${market}&address=${owner}&ids=${ids.map((o) => o.id).join(',')}`,
          ),
          { cache: 'no-store' },
        );
        if (!res.ok) {
          if (!cancelled) {
            // The route carries the real RPC error as `upstream` (R5) — attach it rather
            // than showing the same line whether this was a one-off RPC hiccup or
            // something that will keep happening.
            const errorBody = (await res.json().catch(() => undefined)) as WireErrorBody | undefined;
            const detail = errorBody ? detailFrom(errorBody, 'Monad RPC') : undefined;
            setStatus('error');
            setMessage(
              detail
                ? `Your open orders did not load. They are still on the book. ${detail}`
                : 'Your open orders did not load. They are still on the book.',
            );
          }
          return;
        }
        const body = (await res.json()) as { open: OpenOrder[] };
        if (cancelled) return;
        // The chain says which are still resting; local memory says which transaction
        // each arrived in. `s_orders` has no idea about the latter.
        //
        // This read is also what retires every optimistic row: whatever it returns is
        // the whole truth, so a pending row that is not in it was filled or cancelled
        // and must not survive.
        setPending([]);
        setOrders(
          body.open.map((o) => {
            const hash = ids.find((t) => t.id === o.id)?.txHash;
            return hash ? { ...o, txHash: hash } : o;
          }),
        );
        setStatus('ready');
        setMessage(undefined);
      } catch {
        if (!cancelled) {
          setStatus('error');
          setMessage('Your open orders did not load. They are still on the book.');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [market, owner, ids, nonce]);

  const track = useCallback(
    (orderId: string, txHash?: string, optimistic?: OptimisticOrder) => {
      if (!owner) return;
      // Show it now. The next successful read replaces this entirely.
      if (optimistic) {
        setPending((current) =>
          current.some((o) => o.id === orderId)
            ? current
            : [{ id: orderId, ...optimistic, pending: true, ...(txHash ? { txHash } : {}) }, ...current],
        );
      }
      setIds((current) => {
        if (current.some((o) => o.id === orderId)) return current;
        const row: TrackedOrder = txHash ? { id: orderId, txHash } : { id: orderId };
        const next = [row, ...current].slice(0, 50);
        writeTracked(market, owner, next);
        return next;
      });
    },
    [market, owner],
  );

  const forget = useCallback(
    (orderId: string) => {
      if (!owner) return;
      setIds((current) => {
        const next = current.filter((o) => o.id !== orderId);
        writeTracked(market, owner, next);
        return next;
      });
    },
    [market, owner],
  );

  /**
   * Purge dry-run rows once we know the deployment is live.
   *
   * Deliberately a deletion, not a filter. These rows were written while the app was
   * in dryrun mode and are meaningless now; leaving them in storage means they
   * reappear the moment anything reads the key again, and the user asked for them
   * gone rather than hidden.
   */
  useEffect(() => {
    if (live !== true || !owner) return;
    setSimulated((current) => {
      if (current.length === 0) return current;
      writeSimulated(market, owner, []);
      return [];
    });
    try {
      window.localStorage.removeItem(simulatedKey(market, owner));
    } catch {
      // Storage blocked. Nothing was stored to purge either.
    }
  }, [live, market, owner]);

  const trackSimulated = useCallback(
    (order: SimulatedOrder) => {
      if (!owner) return;
      setSimulated((current) => {
        const next = [order, ...current].slice(0, 20);
        writeSimulated(market, owner, next);
        return next;
      });
    },
    [market, owner],
  );

  const forgetSimulated = useCallback(
    (order: SimulatedOrder) => {
      if (!owner) return;
      setSimulated((current) => {
        const next = current.filter((row) => row.at !== order.at || row.data !== order.data);
        writeSimulated(market, owner, next);
        return next;
      });
    },
    [market, owner],
  );

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  return {
    status,
    // Pending rows first, and never one whose id the chain has already confirmed.
    orders: [...pending.filter((p) => !orders.some((o) => o.id === p.id)), ...orders],
    // A live deployment has no simulated orders, by definition.
    simulated: live === true ? [] : simulated,
    ...(message ? { message } : {}),
    track,
    forget,
    trackSimulated,
    forgetSimulated,
    refresh,
  };
}
