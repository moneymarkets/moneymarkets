import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  isStuck,
  minutesSince,
  sourceTxExplorerUrl,
  stuckHelpReport,
  vendorFor,
  type RecoveryAttempt,
} from '@tradepro/core';
import type { DepositAttemptRow, DepositDb } from './db';

/**
 * Stuck deposits, handled by the app for every user and every rail (owner, 2026-09-30).
 * Each tick, every watched row is evaluated with `@tradepro/core`'s `isStuck`. A row
 * found stuck for the first time is:
 *   1. marked (`stuck_at`), recorded as a STUCK event, and kept on the watcher until a
 *      chain shows its delivery or refund (`db.followUps`);
 *   2. reported to the operator: a warn line in the server log and a section in
 *      STUCK-DEPOSITS.md, with the same fields as the user's help report;
 *   3. given ONE recovery call where the vendor documents one (`recovery.ts`), with the
 *      vendor's answer recorded verbatim on the row.
 * The tracker then shows "Taking longer than usual, N minutes so far" and the
 * "Get help with this deposit" report built by the same `stuckHelpReport`.
 */

export type Recover = (row: DepositAttemptRow) => Promise<RecoveryAttempt | undefined>;

export interface StuckDeps {
  readonly now: number;
  readonly recover?: Recover;
  readonly reportPath?: string;
  readonly warn?: (line: string) => void;
  readonly onChange?: (row: DepositAttemptRow) => void;
}

/** The facts the stuck rule needs, from one row. */
export function stuckFacts(row: DepositAttemptRow, now: number) {
  return {
    sourceConfirmed: Boolean(row.sourceLandedAt || row.sourceTxHash),
    etaSeconds: row.etaSeconds,
    lastChangeAt: Math.max(row.createdAt, row.lastChangeAt ?? 0, row.sourceTxAt ?? 0, row.sourceLandedAt ?? 0, row.detectedAt ?? 0),
    delivered: Boolean(row.destinationTxHash),
    refunded: Boolean(row.refundEvidenceHash) || row.terminalStatus === 'REFUNDED' || row.terminalStatus === 'FAILED',
    now,
  };
}

export function helpReportFor(row: DepositAttemptRow, now: number): string {
  const facts = stuckFacts(row, now);
  return stuckHelpReport({
    rail: row.rail,
    depositAddress: row.depositAddress,
    chain: row.chain,
    amountIn: row.amountIn,
    originDecimals: row.originDecimals,
    originSymbol: row.originSymbol,
    sourceTxHash: row.sourceTxHash,
    landedAt: row.sourceLandedAt ?? row.sourceTxAt,
    quotedAmountOut: row.quotedAmountOut,
    outToken: row.outToken,
    outDecimals: row.outToken === 'MON' ? 18 : 6,
    etaSeconds: row.etaSeconds,
    refundTo: row.refundTo,
    lastStatus: row.lastStatus,
    vendorRawJson: row.vendorRawJson,
    lastChangeAt: facts.lastChangeAt,
    now,
  });
}

export function defaultReportPath(): string {
  return (
    process.env.STUCK_DEPOSITS_REPORT ??
    join(dirname(process.env.DEPOSIT_DB_PATH ?? './data/deposits.sqlite'), 'STUCK-DEPOSITS.md')
  );
}

function operatorRecord(row: DepositAttemptRow, now: number) {
  const vendor = vendorFor(row.rail);
  const facts = stuckFacts(row, now);
  return {
    vendor: vendor.name,
    depositAddress: row.depositAddress,
    account: row.recipient,
    sourceTxHash: row.sourceTxHash,
    sourceTxUrl: row.sourceTxHash ? (sourceTxExplorerUrl(row.chain, row.sourceTxHash) ?? null) : null,
    amount: `${row.amountIn} ${row.originSymbol} base units on ${row.chain}`,
    landedAt: row.sourceLandedAt ?? row.sourceTxAt ? new Date((row.sourceLandedAt ?? row.sourceTxAt)!).toISOString() : null,
    routeQuoted: `${row.route} to ${row.quotedAmountOut ?? '?'} ${row.outToken ?? '?'} on Monad, eta ${row.etaSeconds ?? 'none'} s`,
    refundTo: row.refundTo,
    lastStatus: row.lastStatus,
    lastStatusPayload: row.vendorRawJson,
    minutesSinceChange: minutesSince(facts.lastChangeAt, now),
    supportUrl: vendor.supportUrl ?? null,
  };
}

function appendOperatorReport(path: string, row: DepositAttemptRow, now: number): void {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) {
    appendFileSync(
      path,
      '# Stuck deposits\n\nWritten by the deposit watcher, one section per deposit the moment it is found stuck. ' +
        'Every account, every rail. Each section is the report the user sees behind "Get help with this deposit".\n',
    );
  }
  const r = operatorRecord(row, now);
  appendFileSync(
    path,
    [
      '',
      `## ${new Date(now).toISOString()} ${r.vendor} ${r.depositAddress}`,
      '',
      `- Account: ${r.account}`,
      `- Source transaction: ${r.sourceTxHash ?? 'none'}${r.sourceTxUrl ? ` (${r.sourceTxUrl})` : ''}`,
      `- Amount: ${r.amount}`,
      `- Landed: ${r.landedAt ?? 'not recorded'}`,
      `- Route quoted: ${r.routeQuoted}`,
      `- Refund address: ${r.refundTo}`,
      `- Last status: ${r.lastStatus}`,
      `- Last status payload: ${r.lastStatusPayload ?? 'none'}`,
      `- No change for: ${r.minutesSinceChange} minutes`,
      `- Support: ${r.supportUrl ?? 'no support link read from this vendor\'s docs'}`,
      '',
    ].join('\n'),
  );
}

/**
 * One poll's stuck pass. Returns the rows found stuck for the first time on this pass.
 * A row already marked is left alone here: its recovery was tried once, and the watcher
 * keeps reading both chains for it every tick.
 */
export async function evaluateStuck(
  db: DepositDb,
  rows: readonly DepositAttemptRow[],
  deps: StuckDeps,
): Promise<DepositAttemptRow[]> {
  const found: DepositAttemptRow[] = [];
  const warn = deps.warn ?? ((line: string) => console.warn(line));
  for (const row of rows) {
    if (row.stuckAt !== null) continue;
    if (!isStuck(stuckFacts(row, deps.now))) continue;
    if (!db.markStuck(row.depositAddress, deps.now)) continue;
    const marked = db.attempt(row.depositAddress) ?? row;
    const record = operatorRecord(marked, deps.now);
    db.recordEvent(row.depositAddress, 'STUCK', row.lastStatus, record, deps.now);
    warn(JSON.stringify({ level: 'warn', msg: 'deposit stuck', ...record }));
    try {
      appendOperatorReport(deps.reportPath ?? defaultReportPath(), marked, deps.now);
    } catch (error) {
      warn(JSON.stringify({ level: 'warn', msg: 'stuck report file not written', error: String(error) }));
    }
    if (deps.recover) {
      try {
        const attempt = await deps.recover(marked);
        if (attempt) {
          db.appendRecovery(row.depositAddress, attempt);
          db.recordEvent(row.depositAddress, 'RECOVERY_ATTEMPT', row.lastStatus, attempt, attempt.at);
          warn(JSON.stringify({ level: 'warn', msg: 'deposit recovery attempted', depositAddress: row.depositAddress, ...attempt }));
        }
      } catch (error) {
        const attempt: RecoveryAttempt = {
          at: Date.now(),
          call: 'recovery call',
          httpStatus: null,
          answer: `the call failed before an answer: ${error instanceof Error ? error.message : String(error)}`,
        };
        db.appendRecovery(row.depositAddress, attempt);
        db.recordEvent(row.depositAddress, 'RECOVERY_ATTEMPT', row.lastStatus, attempt, attempt.at);
      }
    }
    const after = db.attempt(row.depositAddress) ?? marked;
    deps.onChange?.(after);
    found.push(after);
  }
  return found;
}
