import { beforeEach, describe, expect, it } from 'vitest';
import {
  beginPerfAction,
  getPerfActions,
  recordPerfStage,
  resetPerfActionsForTest,
  rowsFor,
  type PerfAction,
} from './orderPerf.js';

/**
 * Coverage for the ring buffer / stage-recording logic that `/dev/perf`
 * (`app/dev/perf/page.tsx`) reads, and for `rowsFor` — the pure function that turns a
 * `PerfAction`'s recorded marks into the exact rows that page's table renders. There
 * is no jsdom/testing-library in this app (`vitest.config.ts`), so the page itself is
 * not rendered here; `rowsFor` is what makes that unnecessary, the same way
 * `activityDetailLines.ts` lets its screen's logic be tested as data.
 */

beforeEach(() => {
  resetPerfActionsForTest();
});

describe('beginPerfAction / recordPerfStage', () => {
  it('starts a new action with its tap stage already recorded', () => {
    const id = beginPerfAction();
    const [action] = getPerfActions();
    expect(action?.id).toBe(id);
    expect(action?.stages.map((s) => s.stage)).toEqual(['tap']);
  });

  it('appends stages in the order they are recorded, newest action first in the buffer', () => {
    const id = beginPerfAction();
    recordPerfStage(id, 'validated');
    recordPerfStage(id, 'estimated');
    const [action] = getPerfActions();
    expect(action?.stages.map((s) => s.stage)).toEqual(['tap', 'validated', 'estimated']);
  });

  it('carries an optional note through to the stored stage entry', () => {
    const id = beginPerfAction();
    recordPerfStage(id, 'precomputed-inputs-used', 'nonce warm, fees cold');
    const [action] = getPerfActions();
    expect(action?.stages[1]?.note).toBe('nonce warm, fees cold');
  });

  it('ignores a stage recorded against a stale id rather than throwing', () => {
    const id = beginPerfAction();
    expect(() => recordPerfStage('not-a-real-id', 'signed')).not.toThrow();
    const [action] = getPerfActions();
    expect(action?.id).toBe(id);
    expect(action?.stages).toHaveLength(1);
  });

  it('keeps two concurrent-looking actions independent by id', () => {
    const first = beginPerfAction();
    const second = beginPerfAction();
    recordPerfStage(first, 'validated');
    recordPerfStage(second, 'validated');
    recordPerfStage(second, 'estimated');
    const actions = getPerfActions();
    const firstAction = actions.find((a) => a.id === first);
    const secondAction = actions.find((a) => a.id === second);
    expect(firstAction?.stages.map((s) => s.stage)).toEqual(['tap', 'validated']);
    expect(secondAction?.stages.map((s) => s.stage)).toEqual(['tap', 'validated', 'estimated']);
  });

  it('evicts the oldest action once the ring buffer is full', () => {
    const ids: string[] = [];
    // One more than the buffer holds (20).
    for (let i = 0; i < 21; i += 1) ids.push(beginPerfAction());
    const actions = getPerfActions();
    expect(actions).toHaveLength(20);
    // Newest first; the very first id created must have been evicted.
    expect(actions[0]?.id).toBe(ids[ids.length - 1]);
    expect(actions.some((a) => a.id === ids[0])).toBe(false);
  });
});

describe('rowsFor — what /dev/perf actually renders', () => {
  it('returns no rows for an action with no recorded stages', () => {
    const action: PerfAction = { id: 'x', startedAt: 0, stages: [] };
    expect(rowsFor(action)).toEqual([]);
  });

  it('returns no rows for undefined (no action selected yet)', () => {
    expect(rowsFor(undefined)).toEqual([]);
  });

  it('computes ms-since-previous and ms-since-tap for a fixture set of marks', () => {
    // A hand-built fixture standing in for a real tap-to-confirmed run: tap at t=0,
    // each later stage some real gap after the last, exactly what `atMs` values on a
    // real `PerfAction` look like (performance.now()-scale numbers).
    const action: PerfAction = {
      id: 'fixture-1',
      startedAt: 1_700_000_000_000,
      stages: [
        { stage: 'tap', atMs: 1000 },
        { stage: 'validated', atMs: 1004 }, // +4
        { stage: 'precomputed-inputs-used', atMs: 1006, note: 'nonce warm, fees warm' }, // +2
        { stage: 'estimated', atMs: 1210 }, // +204
        { stage: 'signed', atMs: 1215 }, // +5
        { stage: 'submitted', atMs: 1420 }, // +205
        { stage: 'hash-received', atMs: 1420 }, // +0, same instant as submitted
        { stage: 'mined', atMs: 1820 }, // +400 (one block)
        { stage: 'confirmed', atMs: 2220 }, // +400 (one more block)
        { stage: 'ui-updated', atMs: 2224 }, // +4
      ],
    };

    const rows = rowsFor(action);
    expect(rows).toHaveLength(10);

    // First row: no "since previous", zero since tap.
    expect(rows[0]).toEqual({ stage: 'tap', sinceLastMs: undefined, sinceTapMs: 0 });

    expect(rows[1]).toEqual({ stage: 'validated', sinceLastMs: 4, sinceTapMs: 4 });
    expect(rows[2]).toEqual({
      stage: 'precomputed-inputs-used',
      sinceLastMs: 2,
      sinceTapMs: 6,
      note: 'nonce warm, fees warm',
    });
    expect(rows[3]).toEqual({ stage: 'estimated', sinceLastMs: 204, sinceTapMs: 210 });
    expect(rows[6]).toEqual({ stage: 'hash-received', sinceLastMs: 0, sinceTapMs: 420 });

    // Last row: cumulative since tap is the whole action's total duration.
    const last = rows[rows.length - 1]!;
    expect(last.stage).toBe('ui-updated');
    expect(last.sinceTapMs).toBe(2224 - 1000);
  });

  it('reflects an action that stopped short (e.g. rejected before signing)', () => {
    const action: PerfAction = {
      id: 'fixture-2',
      startedAt: 0,
      stages: [
        { stage: 'tap', atMs: 500 },
        { stage: 'validated', atMs: 508 },
      ],
    };
    const rows = rowsFor(action);
    expect(rows.map((r) => r.stage)).toEqual(['tap', 'validated']);
    expect(rows[rows.length - 1]?.stage).not.toBe('ui-updated');
  });
});
