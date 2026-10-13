import type { PrefundBudgets } from '../chain/caps.js';

/**
 * Rolling sponsorship budgets, as pure arithmetic.
 *
 * The relayer keeps the ledger and this module decides what the ledger means. It is kept
 * separate and free of I/O so the one question that spends money, "how much may this
 * address still draw right now?", can be read and tested without a database or a chain.
 *
 * ## Fixed hourly windows, summed
 *
 * Spend is bucketed into fixed hourly windows, the same unit `rate_limits` uses. "The
 * last 24 hours" is the current window plus the 23 before it. A sliding window would be
 * more exact, but what is being protected is a gas float, not a market. A bounded
 * overshoot at a window edge (at most one hour's budget) is a rounding error, and the
 * simpler code is easier to audit. That is the same trade `hitRateLimit` makes, for the
 * same reason.
 */

export const HOUR_MS = 3_600_000;

/** How many hourly windows make up the rolling day. */
export const WINDOWS_PER_DAY = 24;

/** The start of the hourly window `nowMs` falls in, in epoch milliseconds. */
export function windowStartOf(nowMs: number): number {
  return Math.floor(nowMs / HOUR_MS) * HOUR_MS;
}

/** The oldest window still inside the rolling day that `nowMs` falls in. */
export function oldestWindowInDay(nowMs: number): number {
  return windowStartOf(nowMs) - (WINDOWS_PER_DAY - 1) * HOUR_MS;
}

/** What the ledger holds for one address, read at one instant. */
export interface PrefundUsage {
  /** This address, current window. */
  readonly addressHour: bigint;
  /** This address, the rolling day. */
  readonly addressDay: bigint;
  /** Every address, current window. */
  readonly allAddressesHour: bigint;
  /** This address's spend per window across the rolling day, oldest first. */
  readonly addressWindows: ReadonlyArray<{ readonly windowStart: number; readonly amount: bigint }>;
}

export type PrefundScope = 'ADDRESS_DAY' | 'ADDRESS_HOUR' | 'ALL_ADDRESSES_HOUR';

export interface PrefundHeadroom {
  /** The most that may be drawn now: the smallest of the three remainders, never negative. */
  readonly remaining: bigint;
  /** Each budget with nothing left in it. Empty when a top-up is possible. */
  readonly exhausted: readonly PrefundScope[];
  /** When every exhausted budget has room again, in epoch ms. Absent when none is exhausted. */
  readonly resetsAt?: number;
  /** Per-budget remainders, for the server-side log only. */
  readonly detail: {
    readonly addressDayLeft: bigint;
    readonly addressHourLeft: bigint;
    readonly allAddressesHourLeft: bigint;
  };
}

const floorZero = (v: bigint): bigint => (v > 0n ? v : 0n);

/**
 * When the rolling day has room again for this address.
 *
 * As each hour passes, the oldest window leaves the day. The day has room once enough of
 * the oldest spend has left it to bring the total under the budget. That is usually the
 * moment the oldest window with any spend rolls off, and the loop covers the case where
 * a lowered budget means one window is not enough.
 */
function dayResetsAt(usage: PrefundUsage, budget: bigint): number {
  return rollingDayResetsAt(usage.addressWindows, usage.addressDay, budget);
}

/**
 * The rolling-day arithmetic behind `dayResetsAt`, over any per-window quantity: wei here,
 * a count of free actions in `gasFee.ts`. `windows` is oldest first and `total` is their
 * sum. Answers the start of the hour in which the day's total first falls below `budget`.
 */
export function rollingDayResetsAt(
  windows: ReadonlyArray<{ readonly windowStart: number; readonly amount: bigint }>,
  total: bigint,
  budget: bigint,
): number {
  let left = total;
  for (const w of windows) {
    if (w.amount <= 0n) continue;
    left -= w.amount;
    if (left < budget) return w.windowStart + WINDOWS_PER_DAY * HOUR_MS;
  }
  // Only reachable if the windows do not add up to the day total, which the ledger
  // guarantees they do. Fail toward the later answer rather than an earlier promise.
  const last = windows[windows.length - 1];
  return (last?.windowStart ?? 0) + WINDOWS_PER_DAY * HOUR_MS;
}

export function prefundHeadroom(
  usage: PrefundUsage,
  budgets: PrefundBudgets,
  nowMs: number,
): PrefundHeadroom {
  const addressDayLeft = floorZero(budgets.perAddressDay - usage.addressDay);
  const addressHourLeft = floorZero(budgets.perAddressHour - usage.addressHour);
  const allAddressesHourLeft = floorZero(budgets.allAddressesHour - usage.allAddressesHour);

  let remaining = addressDayLeft;
  if (addressHourLeft < remaining) remaining = addressHourLeft;
  if (allAddressesHourLeft < remaining) remaining = allAddressesHourLeft;

  const exhausted: PrefundScope[] = [];
  const resets: number[] = [];
  const nextWindow = windowStartOf(nowMs) + HOUR_MS;
  if (addressDayLeft === 0n) {
    exhausted.push('ADDRESS_DAY');
    resets.push(dayResetsAt(usage, budgets.perAddressDay));
  }
  if (addressHourLeft === 0n) {
    exhausted.push('ADDRESS_HOUR');
    resets.push(nextWindow);
  }
  if (allAddressesHourLeft === 0n) {
    exhausted.push('ALL_ADDRESSES_HOUR');
    resets.push(nextWindow);
  }

  return {
    remaining,
    exhausted,
    // A top-up needs room in every budget at once, so the answer is the latest reset.
    ...(resets.length > 0 ? { resetsAt: Math.max(...resets) } : {}),
    detail: { addressDayLeft, addressHourLeft, allAddressesHourLeft },
  };
}

/**
 * The refusal a user sees when sponsorship is used up.
 *
 * One sentence per kind of budget, each claiming only what is true:
 *
 *   - `account`: this address's rolling day is spent. "For today", with a clock time.
 *   - `account-hour`: only this address's hourly budget is spent. Its day is not, so the
 *     sentence says "this hour" and counts the minutes to the next window.
 *   - `shared`: the budget every address draws from is spent. The user did not use it up
 *     themselves, so the sentence does not say they did.
 *
 * None states an amount or says "lifetime": the allowance renews, and a number of wei
 * tells a user nothing they can act on.
 */
export type AllowanceScope = 'account' | 'account-hour' | 'shared';

export function allowanceScopeOf(exhausted: readonly PrefundScope[]): AllowanceScope {
  if (exhausted.includes('ADDRESS_DAY')) return 'account';
  if (exhausted.includes('ADDRESS_HOUR')) return 'account-hour';
  return 'shared';
}

/** Whole minutes until `resetsAt`, rounded up, and never less than one. */
export function minutesUntil(resetsAt: number, now: number): number {
  return Math.max(1, Math.ceil((resetsAt - now) / 60_000));
}

/**
 * `clock` renders a time: the relayer passes `utcClock` because it cannot know the
 * viewer's zone, and the browser passes its local clock. `now` is only read for the
 * hourly sentence, which counts minutes rather than naming a time.
 */
export function sponsorshipAllowanceMessage(
  scope: AllowanceScope,
  resetsAt: number,
  context: { readonly now: number; readonly clock: (epochMs: number) => string },
): string {
  switch (scope) {
    case 'account':
      return `Network fees are covered. This account's allowance for today is used up and resets at ${context.clock(resetsAt)}.`;
    case 'account-hour': {
      const minutes = minutesUntil(resetsAt, context.now);
      return `Network fees are covered. This account's allowance for this hour is used up and resets in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
    }
    case 'shared':
      return `Network fees are covered. The allowance shared by all accounts is used up for this hour and resets at ${context.clock(resetsAt)}.`;
  }
}

/**
 * The machine-readable half of the refusal, carried as the JSON-RPC error's `data`.
 *
 * The relayer cannot know the user's time zone, so its own sentence says UTC. The browser
 * reads `resetsAt` from here and rewrites the time in local terms using the same sentence
 * builder, so the two can never disagree about the words.
 */
export const SPONSORSHIP_ALLOWANCE_USED = 'SPONSORSHIP_ALLOWANCE_USED' as const;

export interface SponsorshipAllowanceData {
  readonly reason: typeof SPONSORSHIP_ALLOWANCE_USED;
  readonly scope: AllowanceScope;
  /** Epoch milliseconds. */
  readonly resetsAt: number;
}

export function isSponsorshipAllowanceData(value: unknown): value is SponsorshipAllowanceData {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.reason === SPONSORSHIP_ALLOWANCE_USED &&
    (v.scope === 'account' || v.scope === 'account-hour' || v.scope === 'shared') &&
    typeof v.resetsAt === 'number' &&
    Number.isFinite(v.resetsAt)
  );
}

/** `14:00 UTC`. The server's rendering, used only where no local time zone is known. */
export function utcClock(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(11, 16)} UTC`;
}
