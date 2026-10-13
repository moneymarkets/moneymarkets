'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Card, Chip, Empty, Notice, Skeleton } from '@tradepro/ui';
import type { MarketParams } from '@tradepro/core';
import type { Address, LocalAccount } from 'viem';
import { cancelCall, run, type Progress, type SimulatedOrder } from '../lib/ticket';
import { recordActivity } from '../lib/activityStore';
import type { OpenOrdersState } from '../lib/openOrders';
import { explorerTxUrl, formatPrice, formatSize } from '../lib/format';
import { WIRE_PRICE_SCALE } from '@tradepro/core';
import { priceDecimals } from './BookCard';

/**
 * Open orders with cancel (design 5.4).
 *
 * Cancel is not a shortcut: it builds `batchCancelOrders([id])` and goes through the
 * same `submit()` as a new order (spec 6.2), so it stops in the same place and
 * reports the same way.
 *
 * Two kinds of row, never mixed without a label. An **on-chain** order was really
 * placed and is re-read from `s_orders` every refresh. A **simulated** row is an
 * order this build checked and did not send, because `MODE=dryrun`; it carries the
 * real calldata that was built and it says "Simulated" on its face. Cancelling one
 * builds real cancel calldata, runs the same path, and — being a dry run again —
 * removes the row rather than claiming anything happened on chain.
 *
 * Two entries from the design §2.4 motion table live here: a row that has just
 * appeared slides down eight pixels with an accent flash, and a cancelled row slides
 * right and collapses before it is removed. Both are keyed on the row id, so a
 * re-render that changes nothing animates nothing — motion answers an action
 * (design §1) and nothing else.
 */

/** Long enough for the `.order.leave` animation in `tokens.css` to finish. */
const LEAVE_MS = 300;

export interface OpenOrdersCardProps {
  market: Address;
  params?: MarketParams;
  base: string;
  /** "MON/USDC". Used for the activity row a cancellation writes. */
  marketSymbol: string;
  sender?: Address;
  /** Same signer the ticket uses. Without it a cancel can never leave RELAYING. */
  owner?: LocalAccount;
  state: OpenOrdersState;
}

export function OpenOrdersCard({
  market,
  params,
  base,
  marketSymbol,
  sender,
  owner,
  state,
}: OpenOrdersCardProps) {
  const [busyId, setBusyId] = useState<string | undefined>();
  const [result, setResult] = useState<Progress | undefined>();
  const [leaving, setLeaving] = useState<string | undefined>();
  // Rows already on screen. A row missing from this set on a render is new, and only
  // a new row animates in.
  const seen = useRef<Set<string>>(new Set());

  const rowKey = [
    ...state.orders.map((o) => o.id),
    ...state.simulated.map((o) => `sim-${o.at}`),
  ].join(',');
  const rowIds = rowKey === '' ? [] : rowKey.split(',');
  const entering = new Set(rowIds.filter((id) => !seen.current.has(id)));

  useEffect(() => {
    // After the frame that painted them, the new rows are simply rows.
    seen.current = new Set(rowKey === '' ? [] : rowKey.split(','));
  }, [rowKey]);

  /** Let the row collapse before the state that owns it drops it. */
  function removeAfterAnimation(rowId: string, drop: () => void) {
    setLeaving(rowId);
    window.setTimeout(() => {
      setLeaving(undefined);
      seen.current.delete(rowId);
      drop();
    }, LEAVE_MS);
  }

  async function cancel(orderId: string) {
    if (!sender) return;
    setBusyId(orderId);
    setResult(undefined);
    try {
      const progress = await run({
        sender,
        calls: [cancelCall(market, BigInt(orderId))],
        purpose: 'cancel',
        ...(owner ? { owner } : {}),
        onProgress: () => {},
      });
      setResult(progress);
      if (progress.state === 'CONFIRMED') {
        /**
         * Write the cancellation down (2026-09-09 audit).
         *
         * Two reasons, and the second is the load-bearing one. A cancellation is a
         * thing the user did and it was missing from Activity entirely — `'cancel'`
         * was in the kind union and in the filter chips, and nothing ever wrote one.
         *
         * And `useFillWatcher` tells a fill from a cancellation by looking for exactly
         * this row. Its comment claimed "a cancel it performed wrote its own row at the
         * time" while nothing did, so every cancellation would have been announced as a
         * fill. The id is the same one the watcher looks for, so the row it would
         * otherwise write is also de-duplicated away.
         */
        const cancelled = state.orders.find((o) => o.id === orderId);
        if (sender) {
          const side = cancelled?.isBuy === undefined ? '' : cancelled.isBuy ? 'buy ' : 'sell ';
          recordActivity(sender, {
            id: `cancel:${marketSymbol}:${orderId}`,
            kind: 'cancel',
            summary: `Cancelled your ${side}order on ${marketSymbol}`,
            at: Date.now(),
            market: marketSymbol,
            ...(progress.result?.txHash ? { txHash: progress.result.txHash } : {}),
            order: { id: orderId },
          });
        }
        removeAfterAnimation(orderId, () => {
          state.forget(orderId);
          state.refresh();
        });
      }
    } finally {
      setBusyId(undefined);
    }
  }

  async function cancelSimulated(order: SimulatedOrder) {
    if (!sender || order.reference === null) return;
    const rowId = `sim-${order.at}`;
    setBusyId(rowId);
    setResult(undefined);
    try {
      const progress = await run({
        sender,
        calls: [cancelCall(market, BigInt(order.reference))],
        purpose: 'cancel',
        ...(owner ? { owner } : {}),
        onProgress: () => {},
      });
      setResult(progress);
      // Nothing was sent, so there is nothing on chain to wait for. The simulated
      // order has been cancelled in exactly the sense it existed: locally.
      if (progress.state === 'RELAYING' || progress.state === 'CONFIRMED') {
        removeAfterAnimation(rowId, () => state.forgetSimulated(order));
      }
    } finally {
      setBusyId(undefined);
    }
  }

  const onChain = state.orders.length;
  const simulated = state.simulated.length;
  const total = onChain + simulated;

  return (
    <Card
      title="Open orders"
      action={<span className="tiny muted num">{state.status === 'loading' ? '' : total}</span>}
    >
      {state.status === 'loading' ? (
        <Skeleton rows={2} />
      ) : state.status === 'error' ? (
        <div style={{ marginTop: 8 }}>
          <Notice tone="warn">{state.message}</Notice>
        </div>
      ) : total === 0 ? (
        <Empty>
          No open orders. An order you place stays here until it fills or you cancel it — this
          browser remembers which orders are yours and re-reads each one from the book, so clearing
          this browser&rsquo;s data loses the list, not the orders.
        </Empty>
      ) : (
        <div style={{ marginTop: 6 }}>
          {state.orders.map((order) => {
            const priceWire = params
              ? (BigInt(order.price) * WIRE_PRICE_SCALE) / params.pricePrecision
              : 0n;
            const sizeBase = params
              ? (BigInt(order.size) * 10n ** BigInt(params.baseDecimals)) / params.sizePrecision
              : 0n;
            return (
              <div className={rowClass(order.id, entering, leaving)} key={order.id}>
                <span className={`sidebadge ${order.isBuy ? 'buy' : 'sell'}`} aria-hidden="true" />
                <span>
                  <span className="t small" style={{ display: 'block' }}>
                    {order.isBuy ? 'Buy' : 'Sell'}{' '}
                    {params ? formatSize(sizeBase, params.baseDecimals, 2) : order.size} {base}
                  </span>
                  <span className="tiny muted num" style={{ display: 'block' }}>
                    at {params ? formatPrice(priceWire, priceDecimals(params)) : order.price}
                  </span>
                  {/* Placed and not yet re-read from `s_orders`. Labelled, never
                      silently mixed in with confirmed rows. */}
                  {order.pending ? (
                    <span className="tiny" style={{ display: 'block', color: 'var(--ink-3)' }}>
                      Pending — confirming on the book
                    </span>
                  ) : null}
                  {/* The transaction this order was created in. A gasless user's own
                      address never lists it — the bundler sent it to the EntryPoint. */}
                  {order.txHash ? (
                    <a
                      className="tiny"
                      href={explorerTxUrl(order.txHash)}
                      target="_blank"
                      rel="noreferrer"
                      style={{ display: 'block' }}
                    >
                      View on the explorer
                    </a>
                  ) : null}
                </span>
                <span />
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={order.pending === true || busyId === order.id}
                  disabledLabel={order.pending ? 'Confirming' : 'Cancelling'}
                  onClick={() => void cancel(order.id)}
                >
                  Cancel
                </Button>
              </div>
            );
          })}

          {state.simulated.map((order) => {
            const rowId = `sim-${order.at}`;
            return (
              <div className={rowClass(rowId, entering, leaving)} key={rowId}>
                <span className={`sidebadge ${order.isBuy ? 'buy' : 'sell'}`} aria-hidden="true" />
                <span>
                  <span className="t small" style={{ display: 'block' }}>
                    {order.isBuy ? 'Buy' : 'Sell'}{' '}
                    {params
                      ? formatSize(BigInt(order.sizeBase), params.baseDecimals, 2)
                      : order.sizeBase}{' '}
                    {base}
                  </span>
                  <span className="tiny muted num" style={{ display: 'block' }}>
                    at{' '}
                    {params
                      ? formatPrice(BigInt(order.priceWire), priceDecimals(params))
                      : order.priceWire}
                  </span>
                </span>
                <Chip tone="warn">Simulated</Chip>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busyId === rowId || order.reference === null}
                  disabledLabel={order.reference === null ? 'Cancel unavailable' : 'Cancelling'}
                  onClick={() => void cancelSimulated(order)}
                >
                  Cancel
                </Button>
              </div>
            );
          })}
        </div>
      )}

      {simulated > 0 ? (
        <p className="tiny muted" style={{ marginTop: 10 }}>
          Simulated orders were checked and costed but never sent. Nothing is resting on the book.
        </p>
      ) : null}

      {result?.message ? (
        <div style={{ marginTop: 10 }}>
          <Notice tone={result.state === 'CONFIRMED' ? 'ok' : 'warn'}>
            <span>
              {result.message}
              {result.detail ? (
                <span className="tiny muted" style={{ display: 'block', marginTop: 6 }}>
                  {result.detail}
                </span>
              ) : null}
            </span>
          </Notice>
        </div>
      ) : null}
    </Card>
  );
}

function rowClass(id: string, entering: Set<string>, leaving: string | undefined): string {
  if (leaving === id) return 'order leave';
  return entering.has(id) ? 'order enter' : 'order';
}
