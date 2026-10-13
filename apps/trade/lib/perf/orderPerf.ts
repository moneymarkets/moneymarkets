/**
 * Dev-only client-side timing capture for the real order-submission path.
 *
 * This changes nothing about what an order does. It only records
 * `performance.mark()`/`performance.measure()` calls, alongside the existing
 * `onStage?.()` callbacks in `lib/ticket.ts`'s `run()` and
 * `lib/fund/bundlerTransport.ts`'s `send()`, into a small in-memory ring buffer of the
 * last few actions. `/dev/perf` (`app/dev/perf/page.tsx`) reads that buffer. Nothing
 * here is persisted or sent anywhere — it lives only in the tab that ran the order.
 */

/** The real stage boundaries on the tap-to-confirmed path, in the order they fire. */
export const PERF_STAGES = [
  'tap',
  'validated',
  'precomputed-inputs-used',
  'estimated',
  'signed',
  'submitted',
  'hash-received',
  'mined',
  'confirmed',
  'ui-updated',
] as const;

export type PerfStage = (typeof PERF_STAGES)[number];

export interface PerfStageEntry {
  readonly stage: PerfStage;
  /** `performance.now()` (or `Date.now()` when the Performance API is unavailable). */
  readonly atMs: number;
  /** One short word of context, e.g. "nonce warm, fees cold". Never required. */
  readonly note?: string;
}

export interface PerfAction {
  readonly id: string;
  /** Wall-clock time the tap happened, for display — `atMs` above is a monotonic clock. */
  readonly startedAt: number;
  readonly stages: PerfStageEntry[];
}

const MAX_ACTIONS = 20;

/** Module-level ring buffer, newest first. Client-side only; nothing here reaches a server. */
const actions: PerfAction[] = [];
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function hasPerf(): boolean {
  return typeof performance !== 'undefined' && typeof performance.mark === 'function';
}

function now(): number {
  return hasPerf() ? performance.now() : Date.now();
}

/**
 * Starts a new action and records its `tap` stage in the same call — `tap` is "the
 * moment the user presses the action button, before anything else runs", so there is
 * no separate step between creating the record and marking it.
 *
 * Returns the action id to thread through `run()`/`send()`/`onPlaced()` so later
 * stages land on the same record rather than a newer one that superseded it.
 */
export function beginPerfAction(): string {
  const id = `order-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const action: PerfAction = { id, startedAt: Date.now(), stages: [] };
  actions.unshift(action);
  actions.length = Math.min(actions.length, MAX_ACTIONS);
  recordPerfStage(id, 'tap');
  return id;
}

/**
 * Records one stage for the given action id. A stale id — an action that fell off the
 * ring buffer — is silently ignored, since the whole point is "the last action", not
 * a promise that every id ever handed out stays retrievable forever.
 */
export function recordPerfStage(id: string, stage: PerfStage, note?: string): void {
  const action = actions.find((a) => a.id === id);
  if (!action) return;

  const markName = `${id}:${stage}`;
  if (hasPerf()) {
    try {
      performance.mark(markName);
      const previous = action.stages[action.stages.length - 1];
      if (previous) {
        performance.measure(`${id}:${previous.stage}->${stage}`, `${id}:${previous.stage}`, markName);
      }
    } catch {
      // A Performance API hiccup must never affect the order itself — the ring
      // buffer entry below is recorded either way, from `now()`'s own fallback.
    }
  }

  action.stages.push({ stage, atMs: now(), ...(note ? { note } : {}) });
  notify();
}

/** Newest first. */
export function getPerfActions(): readonly PerfAction[] {
  return actions;
}

export function subscribePerf(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test-only: empties the ring buffer so tests don't leak state into each other. */
export function resetPerfActionsForTest(): void {
  actions.length = 0;
}

export interface PerfRow {
  readonly stage: PerfStage;
  /** Milliseconds since the previous recorded stage. `undefined` for the first row (tap). */
  readonly sinceLastMs: number | undefined;
  /** Milliseconds since `tap`. */
  readonly sinceTapMs: number;
  readonly note?: string;
}

/**
 * Pure: stage name, ms since the previous stage, and cumulative ms since tap — exactly
 * what the `/dev/perf` table renders. Kept separate from the page component so it can
 * be tested directly against a fixture, the same way this codebase already tests its
 * other rendering math as data (see `vitest.config.ts`'s note on
 * `activityDetailLines.ts`).
 */
export function rowsFor(action: PerfAction | undefined): PerfRow[] {
  if (!action || action.stages.length === 0) return [];
  const tapAt = action.stages[0]!.atMs;
  let previousAt = tapAt;
  return action.stages.map((entry, i) => {
    const row: PerfRow = {
      stage: entry.stage,
      sinceLastMs: i === 0 ? undefined : entry.atMs - previousAt,
      sinceTapMs: entry.atMs - tapAt,
      ...(entry.note ? { note: entry.note } : {}),
    };
    previousAt = entry.atMs;
    return row;
  });
}
