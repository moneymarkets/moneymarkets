'use client';

import { useRouter } from 'next/navigation';
import { Chip, Empty, Row } from '@tradepro/ui';
import type { ActivityRow } from '../lib/activityStore';
import { activityRowView } from '../lib/activityView';
import type { WalletTokenEntry } from '../lib/useAccountBalances';
import { TokenIcon } from './TokenIcon';

/**
 * The brief activity row, used on `/home` for the five most recent.
 *
 * The full list lives at `/activity` (`components/ActivityTable.tsx`), which has the
 * columns, the filters and the detail view. This is the summary form: enough to
 * recognise what happened, and a tap through to the rest of it.
 *
 * Every row states what happened in plain words and past tense, the amount with its
 * token, when, and the transaction — because under this account model the bundler
 * sends the transaction and the user's own address never lists it.
 *
 * A row with no transaction hash is rendered and labelled rather than hidden. Money
 * that arrived is a fact whether or not the lookup that would have named the transfer
 * happened to find it inside its window; dropping the row would be tidier and untrue.
 */

function when(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function ActivityList({
  rows,
  limit,
  emptyText = 'Nothing yet. Your deposits, trades and transfers appear here as they happen.',
  tokens = [],
}: {
  readonly rows: readonly ActivityRow[];
  readonly limit?: number;
  readonly emptyText?: string;
  /** The account's holdings, for each row's icon and "unverified" chip (spec E4). */
  readonly tokens?: readonly WalletTokenEntry[];
}) {
  const router = useRouter();
  if (rows.length === 0) return <Empty>{emptyText}</Empty>;
  const shown = limit === undefined ? rows : rows.slice(0, limit);

  return (
    <div className="list" style={{ marginTop: 6 }}>
      {shown.map((row) => {
        const view = activityRowView(row, tokens);
        return (
          <Row
            key={row.id}
            {...(view.symbol ? { leading: <TokenIcon address={view.address} symbol={view.symbol} /> } : {})}
            title={
              view.unverified ? (
                <span>
                  {view.title} <Chip tone="warn">unverified</Chip>
                </span>
              ) : (
                view.title
              )
            }
            {...(view.amountText ? { subtitle: view.amountText } : {})}
            value={when(row.at)}
            subValue={new Date(row.at).toLocaleString()}
            // ITEM 4a: the summary links into /activity at its own row rather than
            // straight out to the explorer. The detail view has the explorer link, plus
            // everything else about the row — and a user who taps a summary line is
            // asking "what was this", not "show me a block explorer".
            onClick={() => router.push(`/activity?id=${encodeURIComponent(row.id)}`)}
          />
        );
      })}
    </div>
  );
}
