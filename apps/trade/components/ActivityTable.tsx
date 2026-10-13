'use client';

import { Fragment } from 'react';
import { Chip, Empty } from '@tradepro/ui';
import type { ActivityRow } from '../lib/activityStore';
import { formatMoney } from '../lib/format';
import type { WalletTokenEntry } from '../lib/useAccountBalances';
import {
  absoluteTime,
  activityRowView,
  amountText,
  groupFor,
  kindLabel,
  relativeTime,
  statusLabel,
  statusTone,
  whereText,
} from '../lib/activityView';
import { TokenIcon } from './TokenIcon';

/**
 * The activity list (ITEM 4b): a table on desktop, a stacked list on a phone.
 *
 * **One set of rows, rendered twice, with CSS choosing.** Both are always in the DOM
 * and `.act-table` / `.act-stack` decide which is visible, so there is no width
 * measurement in JavaScript and no layout flash on first paint — the same approach the
 * app shell already takes for the rail and the tab bar. It also means the two can never
 * show different data, because they are built from the same array in the same order.
 *
 * Every row is a button. The whole row is the tap target, not a chevron at the end of
 * it: the row is one thing and tapping any part of it should do the one thing.
 */

export function ActivityTable({
  rows,
  onOpen,
  emptyText = 'Nothing yet. Your trades, deposits and transfers will appear here.',
  tokens = [],
}: {
  readonly rows: readonly ActivityRow[];
  readonly onOpen: (row: ActivityRow) => void;
  readonly emptyText?: string;
  /** The account's holdings, for each row's token icon and "unverified" chip (spec E4). */
  readonly tokens?: readonly WalletTokenEntry[];
}) {
  if (rows.length === 0) return <Empty>{emptyText}</Empty>;

  // Rows arrive newest-first (lib/activity.ts), so a group's rows are always
  // contiguous — this just notices when the label changes as it walks the list,
  // never re-sorts or re-buckets anything. The table and the stack each walk the
  // same rows independently, so each gets its own tracker.
  const now = Date.now();
  function createGrouper() {
    let last: string | undefined;
    return (row: ActivityRow): string | undefined => {
      const g = groupFor(row.at, now);
      if (g === last) return undefined;
      last = g;
      return g;
    };
  }

  const tableGroup = createGrouper();
  const stackGroup = createGrouper();

  /** The type cell: the token's icon from the registry, the kind, and a chip when no list names the token. */
  const typeCell = (row: ActivityRow) => {
    const view = activityRowView(row, tokens);
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        {view.symbol ? <TokenIcon address={view.address} symbol={view.symbol} size={22} /> : null}
        <span className="t">{kindLabel(row)}</span>
        {view.unverified ? <Chip tone="warn">unverified</Chip> : null}
      </span>
    );
  };

  return (
    <>
      {/* Desktop */}
      <table className="act-table">
        <thead>
          <tr>
            <th scope="col">Type</th>
            <th scope="col">Amount</th>
            <th scope="col">Market or route</th>
            <th scope="col">When</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const group = tableGroup(row);
            return (
              <Fragment key={row.id}>
                {group ? (
                  <tr>
                    <td colSpan={5} className="tiny muted" style={{ borderBottom: 0, paddingTop: 16 }}>
                      {group}
                    </td>
                  </tr>
                ) : null}
                <tr onClick={() => onOpen(row)} tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onOpen(row);
                    }
                  }}
                >
                  <td>{typeCell(row)}</td>
                  <td className="num">{amountText(row, formatMoney) ?? ''}</td>
                  <td>{whereText(row) ?? ''}</td>
                  {/* Relative in the cell, absolute in the tooltip — both always available,
                      never one instead of the other. */}
                  <td title={absoluteTime(row.at)}>{relativeTime(row.at)}</td>
                  <td>
                    <Chip tone={statusTone(row)}>{statusLabel(row)}</Chip>
                  </td>
                </tr>
              </Fragment>
            );
          })}
        </tbody>
      </table>

      {/* Phone */}
      <div className="act-stack">
        {rows.map((row) => {
          const group = stackGroup(row);
          return (
          <Fragment key={row.id}>
            {group ? (
              <div className="tiny muted" style={{ padding: '14px 4px 2px' }}>
                {group}
              </div>
            ) : null}
          <button type="button" className="act-item" onClick={() => onOpen(row)}>
            <span className="act-main">
              {typeCell(row)}
              <span className="num t">{amountText(row, formatMoney) ?? ''}</span>
            </span>
            <span className="act-sub">
              <span className="s">{whereText(row) ?? ''}</span>
              <span className="s" title={absoluteTime(row.at)}>
                {relativeTime(row.at)}
              </span>
            </span>
            <span className="act-status">
              <Chip tone={statusTone(row)}>{statusLabel(row)}</Chip>
            </span>
          </button>
          </Fragment>
          );
        })}
      </div>
    </>
  );
}
