import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import {
  buildDepositTo,
  decideTopUp,
  ENTRYPOINT_TOPUP_WEI,
  GAS_PER_OP_WEI,
  MIN_ENTRYPOINT_DEPOSIT_WEI,
  requiredPrefund,
} from './deposit.js';
import { ENTRY_POINT_V08 } from './delegate.js';
import { MAX_RELAYER_FLOAT_WEI, PREFUND_BUDGETS } from '../chain/caps.js';

/** One address's rolling-day budget: the figure the old lifetime cap used to be. */
const DAY = PREFUND_BUDGETS.perAddressDay;

const ACCOUNT = '0x43a275C3Eb0BE7313f847FFA4fb6Bd366606A961' as Address;
const MON = 10n ** 18n;

/**
 * Every threshold in the deposit policy is derived from one measured number, so that
 * re-measuring means changing `GAS_PER_OP_WEI` and reading what this suite says about
 * the rest — rather than hand-adjusting four constants and hoping they still agree.
 */
describe('the policy is consistent with the measured cost per operation', () => {
  it('records what the M0 gate actually charged', () => {
    // 0.1432099984 MON for two operations on 2026-09-02.
    expect(GAS_PER_OP_WEI).toBe(71_600_000_000_000_000n);
    const measuredTotal = 143_209_998_400_000_000n;
    const measuredPerOp = measuredTotal / 2n;
    // The recorded constant is the measurement, rounded — within 0.1%.
    const drift =
      measuredPerOp > GAS_PER_OP_WEI
        ? measuredPerOp - GAS_PER_OP_WEI
        : GAS_PER_OP_WEI - measuredPerOp;
    expect((drift * 1000n) / measuredPerOp).toBeLessThanOrEqual(1n);
  });

  it('gives a judge a full session every day: ~27 operations per address', () => {
    expect(DAY / GAS_PER_OP_WEI).toBe(27n);
    expect(DAY / GAS_PER_OP_WEI).toBeGreaterThanOrEqual(25n);
  });

  it('allows several operations inside one hour', () => {
    // 0.5 MON an hour is six whole operations (6.98 at the measured cost): an hour of
    // active trading, not a trickle.
    expect(PREFUND_BUDGETS.perAddressHour / GAS_PER_OP_WEI).toBe(6n);
    expect(PREFUND_BUDGETS.perAddressHour).toBeGreaterThan(ENTRYPOINT_TOPUP_WEI);
  });

  it('serves ten concurrent demo users from the relayer float', () => {
    expect(MAX_RELAYER_FLOAT_WEI / DAY).toBe(10n);
  });

  it('tops up in useful increments: a few operations at a time', () => {
    expect(ENTRYPOINT_TOPUP_WEI / GAS_PER_OP_WEI).toBe(4n);
    // A top-up must be worth more than the threshold that triggers it, or an account
    // would sit permanently just under the line.
    expect(ENTRYPOINT_TOPUP_WEI).toBeGreaterThan(MIN_ENTRYPOINT_DEPOSIT_WEI);
  });

  it('never lets the minimum fall below one operation', () => {
    expect(MIN_ENTRYPOINT_DEPOSIT_WEI).toBeGreaterThan(GAS_PER_OP_WEI);
  });

  it('divides the daily budget into whole top-ups', () => {
    expect(DAY % ENTRYPOINT_TOPUP_WEI).toBe(200_000_000_000_000_000n);
    // 6 full top-ups plus a trimmed 0.2 — decideTopUp handles the remainder.
    expect(DAY / ENTRYPOINT_TOPUP_WEI).toBe(6n);
  });
});

describe('the thresholds clear a real prefund', () => {
  it('is 0.15 MON minimum, 0.30 MON per top-up, 2.0 MON a day', () => {
    expect(MIN_ENTRYPOINT_DEPOSIT_WEI).toBe((MON / 1000n) * 150n);
    expect(ENTRYPOINT_TOPUP_WEI).toBe((MON / 1000n) * 300n);
    expect(DAY).toBe(2n * MON);
  });

  it('covers a deposit-plus-order batch at twice the observed gas price', () => {
    // 102 gwei observed on 2026-09-02.
    const prefund = requiredPrefund({
      callGasLimit: 400_000n,
      verificationGasLimit: 100_000n,
      preVerificationGas: 60_000n,
      maxFeePerGas: 204n * 10n ** 9n,
    });
    expect(prefund).toBe(114_240_000_000_000_000n); // 0.11424 MON
    expect(MIN_ENTRYPOINT_DEPOSIT_WEI).toBeGreaterThan(prefund);
  });

  it('shows why 0.02 / 0.05 MON could not work', () => {
    // The values first proposed. A single order at 2x gas needs more than both.
    const oneOrder = requiredPrefund({
      callGasLimit: 250_000n,
      verificationGasLimit: 100_000n,
      preVerificationGas: 60_000n,
      maxFeePerGas: 204n * 10n ** 9n,
    });
    expect(oneOrder).toBe(83_640_000_000_000_000n); // 0.08364 MON
    expect(oneOrder).toBeGreaterThan(20_000_000_000_000_000n); // > MIN_DEPOSIT 0.02
    expect(oneOrder).toBeGreaterThan(50_000_000_000_000_000n); // > TOPUP 0.05
  });
});

describe('depositTo call', () => {
  it('targets the EntryPoint and carries the top-up as value', () => {
    const call = buildDepositTo(ACCOUNT);
    expect(call.to).toBe(ENTRY_POINT_V08);
    expect(call.value).toBe(ENTRYPOINT_TOPUP_WEI);
    expect(call.data.slice(0, 10)).toBe('0xb760faf9'); // depositTo(address)
    expect(call.data.toLowerCase()).toContain(ACCOUNT.slice(2).toLowerCase());
  });
});

describe('top-up decisions', () => {
  const base = { budgetRemaining: DAY, relayerBalance: MAX_RELAYER_FLOAT_WEI };

  it('tops up an account below the minimum', () => {
    const d = decideTopUp({ ...base, deposit: 0n });
    expect(d.topUp).toBe(true);
    expect(d.amount).toBe(ENTRYPOINT_TOPUP_WEI);
  });

  it('leaves an account that is already funded alone', () => {
    const d = decideTopUp({ ...base, deposit: MIN_ENTRYPOINT_DEPOSIT_WEI });
    expect(d.topUp).toBe(false);
    expect(d.refusal).toBe('NOT_NEEDED');
  });

  it('allows a judge’s whole day before refusing', () => {
    // Six full top-ups plus a trimmed seventh, then the day's budget holds.
    let taken = 0n;
    let rounds = 0;
    for (let i = 0; i < 20; i++) {
      const d = decideTopUp({ ...base, deposit: 0n, budgetRemaining: DAY - taken });
      if (!d.topUp) break;
      taken += d.amount;
      rounds++;
    }
    expect(taken).toBe(DAY);
    expect(rounds).toBe(7);
    expect(taken / GAS_PER_OP_WEI).toBe(27n);
  });

  it('refuses with a code, not a sentence, once the budget has nothing left', () => {
    const d = decideTopUp({ ...base, deposit: 0n, budgetRemaining: 0n });
    expect(d.topUp).toBe(false);
    expect(d.refusal).toBe('BUDGET_EXHAUSTED');
    // The operator reason must never carry the words the user-facing copy forbids.
    expect(d.reason).not.toMatch(/lifetime/i);
    expect(d.reason).not.toMatch(/\d{6,}/);
  });

  it('trims the last top-up to the budget rather than refusing it', () => {
    const d = decideTopUp({ ...base, deposit: 0n, budgetRemaining: 200_000_000_000_000_000n });
    expect(d.topUp).toBe(true);
    expect(d.amount).toBe(200_000_000_000_000_000n);
  });

  it('never exceeds the budget across repeated calls', () => {
    let taken = 0n;
    for (let i = 0; i < 10; i++) {
      const d = decideTopUp({ ...base, deposit: 0n, budgetRemaining: DAY - taken });
      if (!d.topUp) break;
      taken += d.amount;
    }
    expect(taken).toBe(DAY);
  });

  it('refuses when the relayer cannot afford it', () => {
    const d = decideTopUp({ ...base, deposit: 0n, relayerBalance: 1n });
    expect(d.topUp).toBe(false);
    expect(d.refusal).toBe('FLOAT_TOO_LOW');
    expect(d.reason).toMatch(/float is too low/);
  });

  it('bounds one day of one address against the float', () => {
    // 20 MON float, 2.0 MON per address per day -> ten addresses fully funded for a day.
    expect(MAX_RELAYER_FLOAT_WEI / DAY).toBe(10n);
  });
});
