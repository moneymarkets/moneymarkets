'use client';

import type { ActivityRow } from '../activityStore';

/**
 * "Export activity as CSV" (spec §4.6): every row this app already has in
 * `activityStore.ts`, turned into a file. It reads the same rows the Activity tab
 * renders and adds nothing to them — no re-derived totals, no synthesised rows for
 * gaps in history.
 */

const HEADER = [
  'Date',
  'Kind',
  'Summary',
  'Amount',
  'Symbol',
  'Status',
  'Transaction hash',
] as const;

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Pure formatting: rows in, CSV text out. No `Date` formatting choice hidden in a
 *  locale — ISO 8601, so the file sorts and parses the same way everywhere. */
export function activityToCsv(rows: readonly ActivityRow[]): string {
  const lines = [HEADER.join(',')];
  for (const row of rows) {
    lines.push(
      [
        new Date(row.at).toISOString(),
        row.kind,
        row.summary,
        row.amount ?? '',
        row.symbol ?? '',
        row.status ?? 'confirmed',
        row.txHash ?? '',
      ]
        .map(String)
        .map(csvField)
        .join(','),
    );
  }
  return lines.join('\r\n');
}

/** Browser-only file save: builds a `Blob`, clicks a detached anchor, revokes the
 *  object URL. Not unit tested beyond `activityToCsv` above — there is no file
 *  system in a Node test environment to assert against, only DOM plumbing. */
export function downloadCsv(filename: string, content: string): void {
  try {
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  } catch {
    // Download blocked or unavailable in this browser; nothing to fall back to
    // that is not itself a file.
  }
}
