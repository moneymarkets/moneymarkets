'use client';

import { useState } from 'react';
import { Button, Chip, Sheet } from '@tradepro/ui';
import type { ActivityRow } from '../lib/activityStore';
import { explorerTxUrl } from '../lib/format';
import { statusLabel, statusTone } from '../lib/activityView';
import { detailGroups, reportTextFor } from '../lib/activityDetailLines';

/**
 * One activity row, in full (ITEM 4c).
 *
 * ## It renders a list it is given and invents nothing
 *
 * Every line comes from `lib/activityDetailLines.ts`, which is pure and tested. This
 * file adds no line of its own, which is the point: the rule that a missing value
 * removes its whole line — label and all — lives in one place where a test can hold it,
 * rather than in JSX where a `?? '—'` added to tidy a layout would quietly turn an
 * absent field into a claim.
 *
 * ## Why the hashes are the last section and the loudest
 *
 * Under this account model the bundler sends the transaction, so a user's own address
 * never lists their trade on the explorer. The transaction hash is the only handle they
 * have, and "Report this" copies the whole record as text precisely so a person who is
 * stuck can paste one thing to someone who can help, instead of describing it.
 */

export function ActivityDetail({
  row,
  open,
  onClose,
}: {
  row: ActivityRow | undefined;
  open: boolean;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState<string | undefined>();

  async function copy(what: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      window.setTimeout(() => setCopied(undefined), 1800);
    } catch {
      // The clipboard refused. The value is on screen and selectable either way.
    }
  }

  if (!row) return null;
  const headingId = `activity-detail-${row.id}`;
  const groups = detailGroups(row);

  return (
    <Sheet open={open} onClose={onClose} labelledBy={headingId}>
      <div className="between" style={{ alignItems: 'flex-start', gap: 12 }}>
        {/* The same past-tense sentence the confirmation showed when it happened. One
            event should not be described two different ways by the same app. */}
        <h3 id={headingId} style={{ margin: 0 }}>
          {row.summary}
        </h3>
        <Chip tone={statusTone(row)}>{statusLabel(row)}</Chip>
      </div>

      {groups.map((group) => (
        <div
          key={group.key}
          style={{ marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 6 }}
        >
          {group.lines.map((l) => (
            <div
              key={l.label}
              className="between"
              style={{ marginTop: 8, gap: 16, alignItems: 'baseline' }}
            >
              <span className="tiny muted" style={{ flexShrink: 0 }}>
                {l.label}
              </span>
              <span
                className={l.mono ? 'tiny num' : 'small'}
                style={{ textAlign: 'right', wordBreak: l.mono ? 'break-all' : 'normal' }}
              >
                {l.value}
              </span>
            </div>
          ))}
        </div>
      ))}

      {row.txHash || row.userOpHash ? (
        <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
          {row.txHash ? (
            <>
              <Button size="sm" variant="soft" onClick={() => void copy('tx', row.txHash as string)}>
                {copied === 'tx' ? 'Copied' : 'Copy hash'}
              </Button>
              <a href={explorerTxUrl(row.txHash)} target="_blank" rel="noreferrer">
                <Button size="sm" variant="soft">
                  Explorer
                </Button>
              </a>
            </>
          ) : null}
          {row.userOpHash ? (
            <Button
              size="sm"
              variant="soft"
              onClick={() => void copy('op', row.userOpHash as string)}
            >
              {copied === 'op' ? 'Copied' : 'Copy operation'}
            </Button>
          ) : null}
        </div>
      ) : null}

      <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
        <Button size="sm" variant="ghost" onClick={() => void copy('report', reportTextFor(row))}>
          {copied === 'report' ? 'Copied the whole record' : 'Report this'}
        </Button>
        <div className="grow" />
        <Button size="sm" variant="soft" onClick={onClose}>
          Close
        </Button>
      </div>
    </Sheet>
  );
}
