'use client';

import { apiUrl } from './basePath';

/**
 * Tell me when one of *my* deposits changes.
 *
 * ## Why this is a poll and not a stream
 *
 * It used to subscribe to `/api/fund/stream?all=1`, which pushed every transition on the
 * server to anyone who asked — recipient addresses, deposit addresses, amounts and
 * transaction hashes for the whole user base, from one unauthenticated GET. The
 * subscription was convenient for this component and a live data leak for everyone else,
 * so the endpoint no longer offers it.
 *
 * The per-address stream still exists and `DepositProgress` uses it for the one address a
 * user is actually watching. This list does not know its addresses in advance, so it
 * re-reads its own account instead. Ten seconds is slower than a push and is not the part
 * a user is waiting on: the card they are looking at updates instantly over the stream,
 * and this list is the history behind it.
 */

const POLL_MS = 10_000;

export interface DepositTransitionEvent {
  readonly depositAddress: string;
  readonly type: 'SOURCE_LANDED' | 'ONECLICK_STATUS' | 'RAIL_STATUS';
  readonly status: string;
  readonly terminal: boolean;
  readonly at: number;
}

/**
 * Calls back when anything about this account's deposits has changed.
 *
 * The comparison is on a digest of the rows rather than a timestamp, so a poll that
 * finds nothing new costs the caller nothing — which matters because the caller
 * re-renders a list on every call.
 */
export function onDepositChanges(recipient: string, onChange: () => void): () => void {
  let stopped = false;
  let previous = '';

  const read = async () => {
    try {
      const res = await fetch(apiUrl(`/api/fund/recent?recipient=${recipient}`), {
        cache: 'no-store',
      });
      if (!res.ok || stopped) return;
      const body = (await res.json()) as {
        attempts?: {
          depositAddress: string;
          lastStatus: string;
          terminalStatus: string | null;
          destinationTxHash: string | null;
          sourceTxHash: string | null;
          refundTxHash?: string | null;
          refundReason?: string | null;
          refundEvidenceHash?: string | null;
        }[];
      };
      // `destinationTxHash`/`sourceTxHash` are in the digest, not only `lastStatus`:
      // security review finding M3, the tracker rebuild's own step-4 evidence can now
      // change without the vendor's status changing at all, and a change this digest
      // cannot see is a change this list never redraws for.
      const digest = (body.attempts ?? [])
        .map(
          (a) =>
            // The refund's own facts too: a return seen on chain, and the vendor's
            // reason or hash arriving after it, change the row without a status change.
            `${a.depositAddress}:${a.lastStatus}:${a.terminalStatus ?? ''}:${a.destinationTxHash ?? ''}:${a.sourceTxHash ?? ''}` +
            `:${a.refundEvidenceHash ?? ''}:${a.refundTxHash ?? ''}:${a.refundReason ?? ''}`,
        )
        .join('|');
      if (previous !== '' && digest !== previous) onChange();
      previous = digest;
    } catch {
      // Unreachable read. The next tick tries again; nothing is reported as changed,
      // which is the right failure for a list that already shows what it last knew.
    }
  };

  void read();
  const id = window.setInterval(() => void read(), POLL_MS);
  return () => {
    stopped = true;
    window.clearInterval(id);
  };
}
