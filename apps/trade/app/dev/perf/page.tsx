'use client';

import { useState, useSyncExternalStore } from 'react';
import { Card, Chip, Notice } from '@tradepro/ui';
import {
  getPerfActions,
  rowsFor,
  subscribePerf,
  type PerfAction,
} from '../../../lib/perf/orderPerf';

/**
 * `/dev/perf` — real on-device timing for the tap-to-confirmed order path.
 *
 * Not a product screen (rule A6: no entrance animation, no new visual language beyond
 * what's needed for a legible table), and not linked from anywhere in the main nav —
 * reachable only by navigating directly to it, the same way `/dev/mera` and `/dev/ui`
 * already are. It reads `lib/perf/orderPerf.ts`'s in-memory ring buffer, which is
 * filled by `performance.mark()` calls alongside the existing `onStage?.()` callbacks
 * in `lib/ticket.ts`'s `run()` and `lib/fund/bundlerTransport.ts`'s `send()`. Nothing
 * here is sent to a server — it lives only in the tab that placed the order, and is
 * gone on reload.
 *
 * This is why the owner asked for it: a CLI script's timing includes a network path
 * that does not represent a real user pressing Buy on their own phone. This page shows
 * only real actions from real taps in this browser.
 */

const EMPTY_ACTIONS: readonly PerfAction[] = [];

function getServerSnapshot(): readonly PerfAction[] {
  return EMPTY_ACTIONS;
}

function fmtMs(ms: number | undefined): string {
  if (ms === undefined) return '—';
  return `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;
}

function fmtClock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

export default function DevPerfPage() {
  const actions = useSyncExternalStore(subscribePerf, getPerfActions, getServerSnapshot);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const selected = actions.find((a) => a.id === selectedId) ?? actions[0];
  const rows = selected ? rowsFor(selected) : [];
  const lastStage = rows[rows.length - 1]?.stage;
  const complete = lastStage === 'ui-updated';

  return (
    <main className="page">
      <div className="between" style={{ paddingTop: 16 }}>
        <h1>Order timing</h1>
        <Chip tone="acc">Dev only</Chip>
      </div>
      <p className="small muted">
        Real, on-device stage timing for the last order this tab placed — from the tap on Buy or
        Sell through to the screen updating. Captured with <code>performance.mark()</code> in{' '}
        <code>lib/ticket.ts</code> and <code>lib/fund/bundlerTransport.ts</code>. Nothing here is
        sent anywhere; it lives only in this tab and clears on reload.
      </p>

      {!selected ? (
        <Card>
          <Notice>
            No order placed in this tab yet. Place a real order from the trade screen, then come
            back — this updates live, no reload needed.
          </Notice>
        </Card>
      ) : (
        <>
          <Card
            title={`Action started ${fmtClock(selected.startedAt)}`}
            action={<Chip tone={complete ? 'up' : 'warn'}>{complete ? 'Complete' : `Stopped at ${lastStage}`}</Chip>}
          >
            <div style={{ overflowX: 'auto', marginTop: 6 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    {['Stage', 'Since previous', 'Since tap', 'Note'].map((h) => (
                      <th
                        key={h}
                        style={{
                          textAlign: 'left',
                          fontSize: 12,
                          fontWeight: 500,
                          color: 'var(--ink-3)',
                          padding: '6px 10px 6px 0',
                          borderBottom: '1px solid var(--line)',
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.stage}>
                      <td style={{ padding: '8px 10px 8px 0', borderBottom: '1px solid var(--line)' }}>
                        {row.stage}
                      </td>
                      <td
                        className="num"
                        style={{ padding: '8px 10px 8px 0', borderBottom: '1px solid var(--line)' }}
                      >
                        {fmtMs(row.sinceLastMs)}
                      </td>
                      <td
                        className="num"
                        style={{ padding: '8px 10px 8px 0', borderBottom: '1px solid var(--line)' }}
                      >
                        {fmtMs(row.sinceTapMs)}
                      </td>
                      <td
                        className="tiny muted"
                        style={{ padding: '8px 10px 8px 0', borderBottom: '1px solid var(--line)' }}
                      >
                        {row.note ?? ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!complete ? (
              <p className="tiny muted" style={{ marginTop: 10 }}>
                This action never reached <code>ui-updated</code> — it may still be in flight, or it
                stopped at an earlier stage (a validation refusal, a rejection, a dry run). What ran
                is exactly what's listed above.
              </p>
            ) : null}
          </Card>

          {actions.length > 1 ? (
            <Card title="Recent actions">
              <div className="list" style={{ marginTop: 4 }}>
                {actions.map((action) => {
                  const actionRows = rowsFor(action);
                  const last = actionRows[actionRows.length - 1];
                  return (
                    <button
                      key={action.id}
                      type="button"
                      className="row"
                      aria-pressed={selected.id === action.id}
                      onClick={() => setSelectedId(action.id)}
                      style={{
                        width: '100%',
                        border: 'none',
                        background: selected.id === action.id ? 'var(--surface-2)' : 'transparent',
                        cursor: 'pointer',
                        textAlign: 'left',
                      }}
                    >
                      <span className="grow">
                        <span className="t">{fmtClock(action.startedAt)}</span>
                        <span className="s">
                          {last ? `${last.stage} · ${fmtMs(last.sinceTapMs)} since tap` : 'no stages recorded'}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </Card>
          ) : null}
        </>
      )}
    </main>
  );
}
