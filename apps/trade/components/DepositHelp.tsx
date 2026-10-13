'use client';

import { useState } from 'react';
import { Button } from '@tradepro/ui';
import { isStuck, minutesSince, stuckHelpReport, vendorFor, type RecoveryAttempt } from '@tradepro/core';

/**
 * The way out for a stuck deposit (owner, 2026-09-30), the same on every rail: "Taking
 * longer than usual, N minutes so far", what the app already asked the provider and
 * what it answered, verbatim, and a "Get help with this deposit" button that opens the
 * prefilled report with a Copy button and the provider's own support link.
 */

export interface HelpRow {
  readonly depositAddress: string;
  readonly rail?: string | null;
  readonly chain: string;
  readonly amountIn: string;
  readonly originDecimals: number;
  readonly originSymbol: string;
  readonly createdAt: number;
  readonly sourceTxHash: string | null;
  readonly sourceLandedAt: number | null;
  readonly sourceTxAt: number | null;
  readonly detectedAt: number | null;
  readonly quotedAmountOut?: string | null;
  readonly outToken?: string | null;
  readonly etaSeconds: number | null;
  readonly refundTo: string;
  readonly lastStatus: string;
  readonly terminalStatus: string | null;
  readonly vendorRawJson: string | null;
  readonly lastChangeAt: number | null;
  readonly destinationTxHash: string | null;
  readonly refundEvidenceHash: string | null;
  readonly stuckAt?: number | null;
  readonly recoveryJson?: string | null;
}

function lastChange(row: HelpRow): number {
  return Math.max(row.createdAt, row.lastChangeAt ?? 0, row.sourceTxAt ?? 0, row.sourceLandedAt ?? 0, row.detectedAt ?? 0);
}

export function rowIsStuck(row: HelpRow, now: number): boolean {
  if (row.stuckAt && !row.destinationTxHash && !row.refundEvidenceHash) return true;
  return isStuck({
    sourceConfirmed: Boolean(row.sourceLandedAt || row.sourceTxHash),
    etaSeconds: row.etaSeconds,
    lastChangeAt: lastChange(row),
    delivered: Boolean(row.destinationTxHash),
    refunded: Boolean(row.refundEvidenceHash) || row.terminalStatus === 'REFUNDED' || row.terminalStatus === 'FAILED',
    now,
  });
}

export function helpReportText(row: HelpRow, now: number): string {
  return stuckHelpReport({
    rail: row.rail ?? null,
    depositAddress: row.depositAddress,
    chain: row.chain,
    amountIn: row.amountIn,
    originDecimals: row.originDecimals,
    originSymbol: row.originSymbol,
    sourceTxHash: row.sourceTxHash,
    landedAt: row.sourceLandedAt ?? row.sourceTxAt,
    quotedAmountOut: row.quotedAmountOut ?? null,
    outToken: row.outToken ?? null,
    outDecimals: row.outToken === 'MON' ? 18 : 6,
    etaSeconds: row.etaSeconds,
    refundTo: row.refundTo,
    lastStatus: row.lastStatus,
    vendorRawJson: row.vendorRawJson,
    lastChangeAt: lastChange(row),
    now,
  });
}

export function DepositHelp({ row, withLine = true }: { row: HelpRow; withLine?: boolean }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const now = Date.now();
  if (!rowIsStuck(row, now)) return null;
  const vendor = vendorFor(row.rail);
  const report = helpReportText(row, now);
  let attempts: RecoveryAttempt[] = [];
  try {
    attempts = row.recoveryJson ? (JSON.parse(row.recoveryJson) as RecoveryAttempt[]) : [];
  } catch {
    attempts = [];
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(report);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked: the report is on screen to select by hand.
    }
  }

  return (
    <div className="deposit-help" style={{ marginTop: 10 }}>
      {withLine ? (
        <p className="tiny" style={{ margin: '0 0 6px', color: 'var(--warn, #b58a00)' }}>
          Taking longer than usual, {minutesSince(lastChange(row), now)} minutes so far. We keep watching both chains
          and will update this the moment it arrives or comes back.
        </p>
      ) : (
        <p className="tiny muted" style={{ margin: '0 0 6px' }}>
          We keep watching both chains and will update this the moment it arrives or comes back.
        </p>
      )}
      {attempts.map((a) => (
        <p key={a.at} className="tiny muted" style={{ margin: '0 0 6px', wordBreak: 'break-word' }}>
          We asked {vendor.name} to check it again at {new Date(a.at).toLocaleString()}. {vendor.name} answered:{' '}
          {a.answer}
        </p>
      ))}
      <Button size="sm" variant="soft" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        Get help with this deposit
      </Button>
      {open ? (
        <div className="help-report" style={{ marginTop: 8 }}>
          <pre
            className="tiny"
            style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              margin: 0,
              padding: '8px 10px',
              background: 'var(--panel, rgba(0,0,0,0.03))',
              borderRadius: 8,
              fontFamily: 'inherit',
            }}
          >
            {report}
          </pre>
          <div className="row" style={{ gap: 8, marginTop: 8, alignItems: 'center' }}>
            <Button size="sm" onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
            {vendor.supportUrl ? (
              <a href={vendor.supportUrl} target="_blank" rel="noreferrer" className="small">
                Contact {vendor.name} support
              </a>
            ) : (
              <span className="tiny muted">{vendor.name} has published no support link we could verify.</span>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
