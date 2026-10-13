'use client';

import { useEffect, useState } from 'react';
import { Button, CheckIcon, Notice } from '@tradepro/ui';
import {
  canOfferMove,
  deriveTrackerState,
  isTrustedExplorerUrl,
  sourceTxExplorerUrl,
  trackerInputFromRow,
  type TrackerState,
} from '@tradepro/core';
import type { Address } from 'viem';
import { apiUrl } from '../lib/basePath';
import { requestMove } from '../lib/moveRequest';
import { explorerTxUrl, formatMoney } from '../lib/format';
import { useSettlement } from '../lib/useSettlement';
import { DepositHelp, rowIsStuck } from './DepositHelp';
import type { TicketState as MoveState } from '../lib/ticket';

/**
 * The deposit tracker (design rebuild, this session): one definition per step, one
 * evidence source per step, read straight from `@tradepro/core`'s `deriveTrackerState`.
 * This component's only job is to assemble that function's input from the watcher's
 * own row and a live settlement read, and render what comes back. It does not decide
 * what counts as "delivered" — the shared module does, and `RecentDeposits` reads the
 * same facts for its own one-line outcome.
 */

interface AttemptRow {
  depositAddress: string;
  chain: string;
  amountIn: string;
  originDecimals: number;
  originSymbol: string;
  createdAt: number;
  expiresAt: number;
  lastStatus: string;
  terminalStatus: string | null;
  sourceLandedAt: number | null;
  sourceTxHash: string | null;
  sourceEvidenceSource: string | null;
  sourceTxAt: number | null;
  vendorRawJson: string | null;
  vendorRawAt: number | null;
  etaSeconds: number | null;
  destinationTxHash: string | null;
  destinationTxBlock: string | null;
  destinationEvidenceSource: string | null;
  destinationDetectedAt: number | null;
  refundTxHash: string | null;
  refundExplorerUrl: string | null;
  refundReason: string | null;
  refundAmount: string | null;
  refundTo: string;
  refundEvidenceHash: string | null;
  refundEvidenceSource: string | null;
  refundEvidenceAmount: string | null;
  refundEvidenceAt: number | null;
  detectedAt: number | null;
  lastChangeAt: number | null;
  amountOut: string | null;
  marginBalanceBefore: string | null;
  marginBalanceBeforeBlock: string | null;
  landsIn: string | null;
  rail: string | null;
  quotedAmountOut: string | null;
  outToken: string | null;
  stuckAt: number | null;
  recoveryJson: string | null;
}

export function DepositProgress({
  depositAddress,
  landsIn = 'wallet',
  outToken = 'USDC',
  outTokenAddress,
  chainName,
  etaSeconds,
  onDelivered,
  address,
  moveState,
  moveTxHash,
  onMoveRequested,
}: {
  depositAddress: string;
  /**
   * Where the rail said it would deliver. `'margin'` only where the vendor itself
   * confirmed it will make the MarginAccount call — money that lands there has no
   * separate "in your wallet" stop, and steps 4 and 5 tick together.
   */
  landsIn?: 'wallet' | 'margin';
  /** What arrives on Monad, so the tracker and Move point at the right holding. */
  outToken?: string;
  /** The delivered token's contract address, for the margin-balance read. */
  outTokenAddress?: string | null;
  chainName?: string;
  etaSeconds?: number;
  /** Fires once, with the delivered amount in base units. */
  onDelivered?: (amountOut: string | null) => void;
  /** The signed-in account, to read the margin balance step 5 waits on. */
  address?: Address;
  moveState?: MoveState | undefined;
  /** The move transaction's own hash, once known — step 5's evidence when it proved the tick. */
  moveTxHash?: string | undefined;
  /**
   * Fired, in addition to the `requestMove` signal below, when the user taps "Move
   * ... to your trading balance" here. A caller on a page with more than one method
   * visible at once (Add money's tabs) uses this to bring that method into view —
   * purely where the user is looking, never a second move request.
   */
  onMoveRequested?: () => void;
}) {
  const [row, setRow] = useState<AttemptRow | undefined>();
  const [announced, setAnnounced] = useState(false);
  const [expandedStep, setExpandedStep] = useState<number | undefined>();
  const [, forceTick] = useState(0);

  useEffect(() => {
    let source: EventSource | undefined;
    let cancelled = false;
    try {
      source = new EventSource(
        apiUrl(`/api/fund/stream?depositAddress=${encodeURIComponent(depositAddress)}`),
      );
      source.addEventListener('snapshot', (event) => {
        if (cancelled) return;
        try {
          setRow(JSON.parse((event as MessageEvent<string>).data) as AttemptRow);
        } catch {
          // Unreadable frame. The next transition sends a fresh snapshot.
        }
      });
    } catch {
      // No EventSource in this environment. The address and the amount are still on the
      // card; only the live status line is missing, and the Recent list still updates.
    }
    return () => {
      cancelled = true;
      source?.close();
    };
  }, [depositAddress]);

  /**
   * A fallback read, independent of the stream above (D202).
   *
   * The push is still what makes the card feel instant, but nothing about a browser
   * tab, a proxy or an idle connection guarantees it always arrives — and a push that
   * is silently lost had no way to be noticed before this, because the card only ever
   * redrew from a `snapshot` event. `RecentDeposits` and the toast already poll this
   * same endpoint every ten seconds for exactly this reason; this gives the open card
   * the same guarantee, so a missed push costs ten seconds, never a stuck page.
   */
  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(apiUrl(`/api/fund/recent?recipient=${address}`), {
          cache: 'no-store',
        });
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as { attempts: AttemptRow[] };
        const match = body.attempts.find((a) => a.depositAddress === depositAddress);
        if (match && !cancelled) setRow(match);
      } catch {
        // Unreachable read. The stream or the next poll catches up.
      }
    };
    const id = window.setInterval(() => void poll(), 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [address, depositAddress]);

  // The slow-state message and "how long has step 3 been active" both depend on the
  // wall clock, not only on the next server push — re-evaluate on a plain timer too.
  useEffect(() => {
    const id = window.setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const settlement = useSettlement(address, moveState, {
    ...(moveTxHash ? { moveTxHash } : {}),
    ...(outTokenAddress ? { token: outTokenAddress as Address } : {}),
    ...(row?.marginBalanceBefore && row.marginBalanceBeforeBlock
      ? {
          externalBaseline: {
            balance: BigInt(row.marginBalanceBefore),
            block: BigInt(row.marginBalanceBeforeBlock),
          },
        }
      : {}),
    // Watch once something has arrived, or a move is locally in flight — no cadence
    // while nothing has happened yet.
    watch: Boolean(row?.sourceTxHash || row?.sourceLandedAt || row?.destinationTxHash),
  });

  // The row's own recorded value wins once it exists (new deposits carry it from
  // registration); the prop is the fallback for a row from before this column existed.
  const effectiveLandsIn: 'wallet' | 'margin' = row?.landsIn === 'margin' ? 'margin' : landsIn;

  const state: TrackerState | undefined = row
    ? deriveTrackerState(
        trackerInputFromRow(row, {
          now: Date.now(),
          ...(chainName ? { chainName } : {}),
          outToken,
          landsIn: effectiveLandsIn,
          ...(etaSeconds !== undefined ? { etaSeconds } : {}),
          explorerUrl: sourceTxExplorerUrl,
          settlement: {
            moveConfirmed: settlement.moveConfirmed,
            marginIncreased: settlement.marginIncreased,
            ...(settlement.moveTxHash ? { moveTxHash: settlement.moveTxHash } : {}),
            ...(settlement.baselineBlock !== undefined ? { baselineBlock: settlement.baselineBlock.toString() } : {}),
            ...(settlement.currentBlock !== undefined ? { currentBlock: settlement.currentBlock.toString() } : {}),
          },
        }),
      )
    : undefined;

  useEffect(() => {
    if (!state) return;
    const step4 = state.steps.find((s) => s.id === 4);
    if (step4?.status === 'done' && !announced) {
      setAnnounced(true);
      onDelivered?.(row?.amountOut ?? null);
    }
  }, [state, announced, onDelivered, row?.amountOut]);

  if (!row || !state) return null;

  const offerMove = canOfferMove(state, effectiveLandsIn);
  // A stuck deposit's own line and help button replace the step's slow message.
  const stuck = !state.terminal && rowIsStuck(row, Date.now());

  const short = state.terminal ? undefined : shortfall(row);

  return (
    <div style={{ marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
      {short ? (
        <div style={{ marginBottom: 10 }}>
          <Notice tone="warn">
            Only {short.arrived} {row.originSymbol} of the {short.quoted} {row.originSymbol} this quote was for
            has arrived, so the swap has not started. If the rest does not arrive before the quote expires,
            the provider returns what arrived to the address it came from.
          </Notice>
        </div>
      ) : null}
      <ol className="steps" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {state.steps.map((step) => {
          const isTerminalStop = state.terminal && state.terminal.atStep === step.id;
          const expanded = expandedStep === step.id;
          const hasEvidence = Boolean(step.evidence);
          return (
            <li
              key={step.id}
              className={
                isTerminalStop
                  ? 'step warn'
                  : step.status === 'done'
                    ? 'step done'
                    : step.status === 'active'
                      ? 'step active'
                      : 'step'
              }
            >
              <span className="dot">
                {isTerminalStop ? '!' : step.status === 'done' ? <CheckIcon /> : null}
              </span>
              <button
                type="button"
                onClick={() => hasEvidence && setExpandedStep(expanded ? undefined : step.id)}
                disabled={!hasEvidence}
                style={{
                  background: 'none',
                  border: 0,
                  padding: 0,
                  width: '100%',
                  textAlign: 'left',
                  cursor: hasEvidence ? 'pointer' : 'default',
                  color: 'inherit',
                  font: 'inherit',
                }}
              >
                <div className="between">
                  {/* A stopped step shows its outcome, never its in-progress label: a
                      returned deposit must not read "Bridging to Monad". */}
                  <span className="lbl">{isTerminalStop && state.terminal ? state.terminal.headline : step.label}</span>
                </div>
                <span className="sub tiny muted" style={{ display: 'block' }}>
                  {step.detail}
                  {step.inferredFromStep ? ` — from step ${step.inferredFromStep}` : ''}
                </span>
                {step.slow && !stuck ? (
                  <p className="tiny" style={{ marginTop: 4, color: 'var(--warn, #b58a00)' }}>
                    {step.slow.message}
                  </p>
                ) : null}
              </button>

              {expanded && step.evidence ? (
                <div
                  className="tiny muted"
                  style={{
                    gridColumn: '1 / -1',
                    marginTop: 6,
                    padding: '8px 10px',
                    background: 'var(--panel, rgba(0,0,0,0.03))',
                    borderRadius: 8,
                  }}
                >
                  <div>Source: {step.evidence.source}</div>
                  {step.evidence.hash ? (
                    <div style={{ wordBreak: 'break-all' }}>
                      Tx:{' '}
                      {(() => {
                        // Step 2's own hash is on the source chain, not on Monad.
                        const href =
                          step.id === 2 && !step.inferredFromStep
                            ? sourceTxExplorerUrl(row.chain, step.evidence.hash)
                            : explorerTxUrl(step.evidence.hash);
                        return href ? (
                          <a href={href} target="_blank" rel="noreferrer">{step.evidence.hash}</a>
                        ) : (
                          <span>{step.evidence.hash}</span>
                        );
                      })()}
                    </div>
                  ) : null}
                  {step.evidence.block ? <div>Block: {step.evidence.block}</div> : null}
                  {step.evidence.amount ? <div>Amount: {step.evidence.amount}</div> : null}
                  <div>Time: {new Date(step.evidence.at).toLocaleString()}</div>
                </div>
              ) : null}

              {isTerminalStop && state.terminal ? (
                <TerminalDetail terminal={state.terminal} />
              ) : null}
            </li>
          );
        })}
      </ol>

      {stuck ? <DepositHelp row={{ ...row, outToken: row.outToken ?? outToken }} /> : null}

      {row.amountOut && state.steps.find((s) => s.id === 4)?.status === 'done' ? (
        <div className="between tiny" style={{ marginTop: 8 }}>
          <span className="muted">Arrived</span>
          <span className="num">{formatMoney(BigInt(row.amountOut), 6, 6)} {outToken} on Monad</span>
        </div>
      ) : null}

      {offerMove ? (
        <div style={{ marginTop: 10 }}>
          <p className="tiny muted" style={{ margin: '0 0 6px' }}>
            It is in your wallet on Monad. One more tap puts it in your trading balance.
          </p>
          <Button
            size="sm"
            variant="soft"
            onClick={() => {
              requestMove(outToken);
              onMoveRequested?.();
            }}
          >
            Move {outToken} to your trading balance
          </Button>
        </div>
      ) : null}

      {!state.terminal && state.steps.find((s) => s.id === 5)?.status === 'done' ? (
        <p className="tiny" style={{ marginTop: 10, color: 'var(--up)' }}>
          {effectiveLandsIn === 'margin'
            ? 'It went straight into your trading balance. Nothing else to do — you can trade with it now.'
            : 'It is in your trading balance. Nothing else to do — you can trade with it now.'}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Less arrived than the quote was for. The provider's own status says so
 * (`INCOMPLETE_DEPOSIT`) and its payload carries the amount it counted; without this the
 * tracker read "Bridging to Monad" for an hour and then "Returned" (deposit of 2026-10-13:
 * 0.00929 SOL against a 0.01 SOL quote).
 */
function shortfall(row: AttemptRow): { arrived: string; quoted: string } | undefined {
  if (row.lastStatus !== 'INCOMPLETE_DEPOSIT' || !row.vendorRawJson) return undefined;
  try {
    const raw = JSON.parse(row.vendorRawJson) as { swapDetails?: { depositedAmount?: unknown } };
    const deposited = raw.swapDetails?.depositedAmount;
    if (typeof deposited !== 'string' || !/^\d+$/.test(deposited) || !/^\d+$/.test(row.amountIn)) return undefined;
    if (BigInt(deposited) >= BigInt(row.amountIn)) return undefined;
    return {
      arrived: formatMoney(BigInt(deposited), row.originDecimals, row.originDecimals),
      quoted: formatMoney(BigInt(row.amountIn), row.originDecimals, row.originDecimals),
    };
  } catch {
    return undefined;
  }
}

/**
 * What ended the deposit, stated in full: the amount that came back with its token and
 * chain, the refund transaction with a link on a verified explorer, and the vendor's
 * own reason, verbatim. No spinner: nothing about a finished deposit is still moving.
 */
function TerminalDetail({ terminal }: { terminal: NonNullable<TrackerState['terminal']> }) {
  const link =
    terminal.refundTxHash && terminal.refundExplorerUrl && isTrustedExplorerUrl(terminal.refundExplorerUrl)
      ? terminal.refundExplorerUrl
      : undefined;
  return (
    <div style={{ gridColumn: '1 / -1', marginTop: 8 }}>
      {terminal.returned ? (
        <div className="between tiny">
          <span className="muted">Returned</span>
          <span className="num">
            {formatMoney(BigInt(terminal.returned.amount), terminal.returned.decimals, terminal.returned.decimals)}{' '}
            {terminal.returned.symbol} on {terminal.returned.chainName}
          </span>
        </div>
      ) : null}
      {terminal.refundTxHash ? (
        <div className="tiny" style={{ marginTop: 4, wordBreak: 'break-all' }}>
          <span className="muted">Refund transaction </span>
          {link ? (
            <a href={link} target="_blank" rel="noreferrer">
              {terminal.refundTxHash}
            </a>
          ) : (
            <span>{terminal.refundTxHash}</span>
          )}
        </div>
      ) : null}
      <div style={{ marginTop: 8 }}>
        <Notice tone="warn">
          {terminal.reasonFromVendor ? `Reason given by the provider: ${terminal.reason}` : terminal.reason}
        </Notice>
      </div>
      <p className="tiny muted" style={{ marginTop: 6 }}>
        {terminal.whereItWent}
      </p>
    </div>
  );
}
