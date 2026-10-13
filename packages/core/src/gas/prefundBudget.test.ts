import { describe, expect, it } from 'vitest';
import { PREFUND_BUDGETS, prefundBudgets } from '../chain/caps.js';
import {
  allowanceScopeOf,
  HOUR_MS,
  isSponsorshipAllowanceData,
  minutesUntil,
  oldestWindowInDay,
  prefundHeadroom,
  sponsorshipAllowanceMessage,
  utcClock,
  windowStartOf,
  type PrefundUsage,
} from './prefundBudget.js';

const MON = 10n ** 18n;
/** 2025-09-02T08:20:00Z, twenty minutes into its hourly window. */
const NOW = Date.UTC(2025, 8, 2, 8, 20, 0);
const THIS_WINDOW = Date.UTC(2025, 8, 2, 8, 0, 0);

function usage(parts: Partial<PrefundUsage>): PrefundUsage {
  return {
    addressHour: 0n,
    addressDay: 0n,
    allAddressesHour: 0n,
    addressWindows: [],
    ...parts,
  };
}

describe('hourly windows', () => {
  it('truncates to the hour in epoch milliseconds, the unit rate_limits uses', () => {
    expect(windowStartOf(NOW)).toBe(THIS_WINDOW);
    expect(windowStartOf(THIS_WINDOW)).toBe(THIS_WINDOW);
    expect(windowStartOf(THIS_WINDOW - 1)).toBe(THIS_WINDOW - HOUR_MS);
  });

  it('counts the current window and the 23 before it as the day', () => {
    expect(oldestWindowInDay(NOW)).toBe(THIS_WINDOW - 23 * HOUR_MS);
  });
});

describe('headroom', () => {
  it('is the full hourly budget for an address that has drawn nothing', () => {
    const h = prefundHeadroom(usage({}), PREFUND_BUDGETS, NOW);
    // The hour is the tightest of the three, so it is what a fresh address may draw.
    expect(h.remaining).toBe(PREFUND_BUDGETS.perAddressHour);
    expect(h.exhausted).toEqual([]);
    expect(h.resetsAt).toBeUndefined();
  });

  it('is the smallest of the three remainders', () => {
    const h = prefundHeadroom(
      usage({
        addressHour: 300_000_000_000_000_000n,
        addressDay: 1_900_000_000_000_000_000n,
        allAddressesHour: 0n,
        addressWindows: [{ windowStart: THIS_WINDOW, amount: 300_000_000_000_000_000n }],
      }),
      PREFUND_BUDGETS,
      NOW,
    );
    // 0.2 left in the hour, 0.1 left in the day -> 0.1.
    expect(h.remaining).toBe(100_000_000_000_000_000n);
  });

  it('never goes negative when a tightened budget sits below what was already drawn', () => {
    const h = prefundHeadroom(
      usage({ addressHour: MON, addressDay: MON }),
      prefundBudgets(MON / 2n),
      NOW,
    );
    expect(h.remaining).toBe(0n);
  });

  it('reopens an exhausted hour at the next window boundary', () => {
    const h = prefundHeadroom(
      usage({
        addressHour: PREFUND_BUDGETS.perAddressHour,
        addressDay: PREFUND_BUDGETS.perAddressHour,
        addressWindows: [{ windowStart: THIS_WINDOW, amount: PREFUND_BUDGETS.perAddressHour }],
      }),
      PREFUND_BUDGETS,
      NOW,
    );
    expect(h.exhausted).toEqual(['ADDRESS_HOUR']);
    expect(h.resetsAt).toBe(THIS_WINDOW + HOUR_MS);
  });

  it('reopens an exhausted day when its oldest spending hour rolls off', () => {
    // 0.5 in each of four hours: the oldest 20 hours ago, then 19, 18 and 17.
    const windows = [20, 19, 18, 17].map((h) => ({
      windowStart: THIS_WINDOW - h * HOUR_MS,
      amount: PREFUND_BUDGETS.perAddressHour,
    }));
    const h = prefundHeadroom(
      usage({ addressHour: 0n, addressDay: PREFUND_BUDGETS.perAddressDay, addressWindows: windows }),
      PREFUND_BUDGETS,
      NOW,
    );
    expect(h.exhausted).toEqual(['ADDRESS_DAY']);
    // The oldest hour with spend leaves the rolling day 24 hours after it began.
    expect(h.resetsAt).toBe(THIS_WINDOW - 20 * HOUR_MS + 24 * HOUR_MS);
  });

  it('skips empty windows when finding the oldest spend', () => {
    const windows = [
      { windowStart: THIS_WINDOW - 22 * HOUR_MS, amount: 0n },
      { windowStart: THIS_WINDOW - 5 * HOUR_MS, amount: PREFUND_BUDGETS.perAddressDay },
    ];
    const h = prefundHeadroom(
      usage({ addressDay: PREFUND_BUDGETS.perAddressDay, addressWindows: windows }),
      PREFUND_BUDGETS,
      NOW,
    );
    expect(h.resetsAt).toBe(THIS_WINDOW - 5 * HOUR_MS + 24 * HOUR_MS);
  });

  it('waits for every exhausted budget, not the first to reopen', () => {
    const windows = [{ windowStart: THIS_WINDOW - 3 * HOUR_MS, amount: PREFUND_BUDGETS.perAddressDay }];
    const h = prefundHeadroom(
      usage({
        addressHour: PREFUND_BUDGETS.perAddressHour,
        addressDay: PREFUND_BUDGETS.perAddressDay,
        allAddressesHour: PREFUND_BUDGETS.allAddressesHour,
        addressWindows: windows,
      }),
      PREFUND_BUDGETS,
      NOW,
    );
    expect(h.exhausted).toEqual(['ADDRESS_DAY', 'ADDRESS_HOUR', 'ALL_ADDRESSES_HOUR']);
    expect(h.resetsAt).toBe(THIS_WINDOW - 3 * HOUR_MS + 24 * HOUR_MS);
  });

  it('reports a shared exhaustion as shared, and never as the account’s own', () => {
    const h = prefundHeadroom(
      usage({ allAddressesHour: PREFUND_BUDGETS.allAddressesHour }),
      PREFUND_BUDGETS,
      NOW,
    );
    expect(h.exhausted).toEqual(['ALL_ADDRESSES_HOUR']);
    expect(allowanceScopeOf(h.exhausted)).toBe('shared');
    // The account's own budget is named first whenever it is one of those spent.
    expect(allowanceScopeOf(['ADDRESS_HOUR', 'ALL_ADDRESSES_HOUR'])).toBe('account-hour');
    expect(allowanceScopeOf(['ADDRESS_DAY', 'ADDRESS_HOUR'])).toBe('account');
  });

  it('reports an hour-only exhaustion as the hour, never as the day', () => {
    const h = prefundHeadroom(
      usage({
        addressHour: PREFUND_BUDGETS.perAddressHour,
        addressDay: PREFUND_BUDGETS.perAddressHour,
        addressWindows: [{ windowStart: THIS_WINDOW, amount: PREFUND_BUDGETS.perAddressHour }],
      }),
      PREFUND_BUDGETS,
      NOW,
    );
    expect(allowanceScopeOf(h.exhausted)).toBe('account-hour');
  });
});

describe('the refusal copy', () => {
  const at = { now: NOW, clock: utcClock };

  it('is exactly the owner’s sentence when the account’s day is spent', () => {
    expect(sponsorshipAllowanceMessage('account', Date.UTC(2025, 8, 2, 14, 0), at)).toBe(
      "Network fees are covered. This account's allowance for today is used up and resets at 14:00 UTC.",
    );
  });

  it('says "this hour" and counts minutes when only the hour is spent (F6)', () => {
    // NOW is 08:20, so the next window opens in 40 minutes.
    expect(sponsorshipAllowanceMessage('account-hour', THIS_WINDOW + HOUR_MS, at)).toBe(
      "Network fees are covered. This account's allowance for this hour is used up and resets in 40 minutes.",
    );
    expect(sponsorshipAllowanceMessage('account-hour', NOW + 30_000, at)).toMatch(
      /resets in 1 minute\.$/,
    );
    expect(sponsorshipAllowanceMessage('account-hour', NOW + HOUR_MS, at)).not.toMatch(/today/);
  });

  it('rounds minutes up and never says zero', () => {
    expect(minutesUntil(NOW + 60_001, NOW)).toBe(2);
    expect(minutesUntil(NOW + 60_000, NOW)).toBe(1);
    expect(minutesUntil(NOW - 5_000, NOW)).toBe(1);
  });

  it('never states an amount or says lifetime, for any scope', () => {
    const resetsAt = THIS_WINDOW + HOUR_MS;
    for (const scope of ['account', 'account-hour', 'shared'] as const) {
      const text = sponsorshipAllowanceMessage(scope, resetsAt, at);
      expect(text).not.toMatch(/lifetime/i);
      expect(text).not.toMatch(/wei|MON\b/);
      // The only digits in it are the clock, or the minute count.
      expect(text.replace(utcClock(resetsAt), '').replace('40 minutes', '')).not.toMatch(/\d/);
    }
  });

  it('renders the server clock in UTC, hours and minutes', () => {
    expect(utcClock(THIS_WINDOW + HOUR_MS)).toBe('09:00 UTC');
  });

  it('recognises only a well-formed allowance payload', () => {
    expect(
      isSponsorshipAllowanceData({
        reason: 'SPONSORSHIP_ALLOWANCE_USED',
        scope: 'account',
        resetsAt: NOW,
      }),
    ).toBe(true);
    expect(
      isSponsorshipAllowanceData({
        reason: 'SPONSORSHIP_ALLOWANCE_USED',
        scope: 'account-hour',
        resetsAt: NOW,
      }),
    ).toBe(true);
    expect(isSponsorshipAllowanceData({ reason: 'SPONSORSHIP_ALLOWANCE_USED', scope: 'x' })).toBe(
      false,
    );
    expect(isSponsorshipAllowanceData(null)).toBe(false);
    expect(isSponsorshipAllowanceData('SPONSORSHIP_ALLOWANCE_USED')).toBe(false);
  });
});
