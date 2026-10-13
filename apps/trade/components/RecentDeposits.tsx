'use client';

import { useEffect, useState } from 'react';
import type { Address } from 'viem';
import { Button, Card, Chip, Notice } from '@tradepro/ui';
import type { ChipTone } from '@tradepro/ui';
import { deriveTrackerState, monad, sourceTxExplorerUrl, trackerInputFromRow } from '@tradepro/core';
import { apiUrl } from '../lib/basePath';
import { formatMoney } from '../lib/format';
import { onDepositChanges } from '../lib/depositStream';
import { DepositHelp, helpReportText, rowIsStuck } from './DepositHelp';

/**
 * Every deposit attempt this account has made, in flight or resolved (design intent
 * D105 item 3: "attempts never disappear"). Read on mount, then kept current by polling
 * this account's own rows — it used to subscribe to a server-wide firehose, which was a
 * live leak of every other user's deposits.
 *
 * ## Honest states (stabilization pass, item 5)
 *
 * Before this, every non-terminal status — an address nothing had ever reached, and
 * a swap genuinely mid-flight — read the same word: "In progress." An address funded
 * five days ago with nothing sent read exactly the same as one about to land. Every
 * branch below exists because that sentence was true for a different reason than the
 * one it implied.
 */

interface RecentAttempt {
  readonly depositAddress: string;
  readonly sourceKey: string;
  readonly chain: string;
  readonly amountIn: string;
  readonly originDecimals: number;
  readonly originSymbol: string;
  readonly createdAt: number;
  readonly sourceLandedAt: number | null;
  readonly detectedAt: number | null;
  readonly terminalAt: number | null;
  readonly lastStatus: string;
  readonly terminalStatus: string | null;
  readonly refundReason: string | null;
  readonly refundAmount: string | null;
  readonly refundTxHash: string | null;
  readonly refundExplorerUrl: string | null;
  readonly refundTo: string;
  readonly amountOut: string | null;
  readonly destinationTxHash: string | null;
  readonly destinationTxBlock: string | null;
  readonly destinationEvidenceSource: string | null;
  readonly destinationDetectedAt: number | null;
  readonly sourceTxHash: string | null;
  readonly sourceEvidenceSource: string | null;
  readonly sourceTxAt: number | null;
  readonly vendorRawJson: string | null;
  readonly vendorRawAt: number | null;
  readonly etaSeconds: number | null;
  readonly outToken: string | null;
  readonly landsIn: string | null;
  readonly expiresAt: number;
  readonly refundEvidenceHash: string | null;
  readonly refundEvidenceSource: string | null;
  readonly refundEvidenceAmount: string | null;
  readonly refundEvidenceAt: number | null;
  readonly lastChangeAt: number | null;
  readonly rail: string | null;
  readonly quotedAmountOut: string | null;
  readonly stuckAt: number | null;
  readonly recoveryJson: string | null;
}

/**
 * `undefined` — nothing read yet. `'error'` — the read failed or answered non-ok.
 * An array — the real list, possibly empty. `'error'` must never collapse into an
 * empty array: a card that reads "no deposits" for a read that never happened told
 * people who had deposits in flight that there was nothing to see (High #21).
 */
type AttemptsState = readonly RecentAttempt[] | 'error' | undefined;

export function RecentDeposits({ recipient }: { recipient: Address }) {
  const [attempts, setAttempts] = useState<AttemptsState>(undefined);

  const load = () => {
    void fetch(apiUrl(`/api/fund/recent?recipient=${recipient}`), { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body: { attempts: RecentAttempt[] }) => setAttempts(body.attempts))
      .catch(() => setAttempts('error'));
  };

  useEffect(load, [recipient]);

  useEffect(() => onDepositChanges(recipient, load), [recipient]);

  // A PENDING_DEPOSIT row's own label depends on the wall clock (expired or not),
  // so it is re-evaluated on a plain timer too — not only when the server pushes
  // an actual status change, which never happens for an address nothing was sent to.
  const [, forceTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  if (attempts === 'error') {
    return (
      <Card title="Recent deposits">
        <Notice tone="warn">
          Your recent deposits could not be read just now. This is a reading problem, not an
          empty list — reload to try again.
        </Notice>
      </Card>
    );
  }

  if (!attempts || attempts.length === 0) return null;

  return (
    <Card title="Recent deposits">
      <ul className="deps">
        {attempts.map((a) => (
          <RecentRow key={a.depositAddress} attempt={a} />
        ))}
      </ul>
    </Card>
  );
}

const DELAYED_AFTER_MS = 15 * 60 * 1000;

function RecentRow({ attempt: a }: { attempt: RecentAttempt }) {
  const amount = `${formatMoney(BigInt(a.amountIn), a.originDecimals, a.originDecimals)} ${a.originSymbol}`;
  const when = new Date(a.createdAt).toLocaleString();
  const outcome = outcomeLine(a);
  const [copied, setCopied] = useState(false);

  const stuck = rowIsStuck(a, Date.now());

  async function copyReport() {
    // The same report, word for word, as "Get help with this deposit" (every rail).
    const report = helpReportText(a, Date.now());
    try {
      await navigator.clipboard.writeText(report);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access blocked — the report text is still visible in this row.
    }
  }

  return (
    <li className="dep">
      <div>
        <b>{amount}</b>
        <div className="d">
          {a.chain} · {when}
        </div>
      </div>
      <div className="st">
        <Chip tone={chipToneFor(outcome.tone)}>{outcome.label}</Chip>
        {a.destinationTxHash ? (
          <a
            href={destinationExplorerUrl(a.destinationTxHash)}
            target="_blank"
            rel="noreferrer"
            className="why"
          >
            View on Monad
          </a>
        ) : outcome.refundUrl ? (
          <a href={outcome.refundUrl} target="_blank" rel="noreferrer" className="why">
            View refund
          </a>
        ) : null}
        {outcome.detail ? <span className="why">{outcome.detail}</span> : null}
        {outcome.delayed && !stuck ? (
          <Button variant="ghost" size="sm" onClick={() => void copyReport()}>
            {copied ? 'Copied' : 'Report this'}
          </Button>
        ) : null}
      </div>
      {stuck ? (
        <div style={{ gridColumn: '1 / -1' }}>
          <DepositHelp row={a} withLine={false} />
        </div>
      ) : null}
    </li>
  );
}

/** The outcome's three tones, as the design system's own chip tones. */
function chipToneFor(tone: 'ok' | 'err' | 'warn'): ChipTone {
  if (tone === 'ok') return 'ok';
  if (tone === 'warn') return 'warn';
  return 'bad';
}

function destinationExplorerUrl(hash: string): string {
  return `${monad.blockExplorers.default.url}/tx/${hash}`;
}

interface Outcome {
  readonly label: string;
  readonly tone: 'ok' | 'err' | 'warn';
  readonly delayed: boolean;
  /** A second line under the outcome: what came back, and the vendor's reason. */
  readonly detail?: string;
  /** The refund transaction on a verified explorer, built by this app, never the vendor's link. */
  readonly refundUrl?: string;
}

/**
 * One line, read from the same tracker `deriveTrackerState` computes for the full
 * five-step card — one definition, one evidence source, used everywhere a deposit's
 * state is drawn. A destination this app has confirmed itself says "Delivered" even
 * while the vendor's own word lags; a vendor terminal word without that proof does not.
 */
function outcomeLine(a: RecentAttempt): Outcome {
  const state = deriveTrackerState(
    trackerInputFromRow(a, { now: Date.now(), explorerUrl: sourceTxExplorerUrl }),
  );

  if (state.terminal) {
    const t = state.terminal;
    const returned = t.returned
      ? `${formatMoney(BigInt(t.returned.amount), t.returned.decimals, t.returned.decimals)} ${t.returned.symbol} on ${t.returned.chainName}`
      : undefined;
    const reason = t.reasonFromVendor ? `Reason given by the provider: ${t.reason}` : t.reason;
    return {
      label: t.headline,
      tone: t.kind === 'REFUNDED' ? 'warn' : 'err',
      delayed: false,
      detail: [returned, reason].filter(Boolean).join('. '),
      ...(t.refundExplorerUrl ? { refundUrl: t.refundExplorerUrl } : {}),
    };
  }
  const step4Done = state.steps.find((s) => s.id === 4)?.status === 'done';
  if (step4Done) return { label: 'Delivered', tone: 'ok', delayed: false };

  const step2Done = state.steps.find((s) => s.id === 2)?.status === 'done';
  if (!step2Done) {
    const minutesLeft = Math.max(0, Math.ceil((a.expiresAt - Date.now()) / 60_000));
    return { label: `Awaiting deposit, expires in ${minutesLeft}m`, tone: 'warn', delayed: false };
  }

  // Something has genuinely landed and is bridging — "in progress" is true here, unlike
  // the pre-arrival case above, so this is the one place that word belongs.
  const slow = state.steps.find((s) => s.id === 3)?.slow;
  if (slow) return { label: slow.message, tone: 'warn', delayed: true };
  const since = a.vendorRawAt ?? a.sourceLandedAt ?? a.createdAt;
  const delayed = Date.now() - since > DELAYED_AFTER_MS;
  return delayed
    ? { label: 'Delayed on the solver network', tone: 'warn', delayed: true }
    : { label: 'In progress', tone: 'warn', delayed: false };
}
