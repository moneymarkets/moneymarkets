import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { decodeFunctionData, erc20Abi, getAddress, type Address } from 'viem';
import { MAINNET } from '../chain/addresses.js';
import { marginAccountAbi } from '../abi/marginAccount.js';
import { MON_USDC_L2_BEST_ASK_WIRE, MON_USDC_L2_BEST_BID_WIRE } from '../kuru/__fixtures__/l2book.js';
import { buildErc20Transfer, buildWithdraw } from '../kuru/orders.js';
import {
  buildFeeLeg,
  limitsOffPlan,
  FREE_ACTIONS_PER_DAY,
  FREE_ACTIONS_USED_MESSAGE,
  freeActionHeadroom,
  GAS_FEE_MINIMUM,
  GAS_FEE_STEP,
  gasFeeFromCostWei,
  gasFeeTokenFor,
  isGasChargeRefusalData,
  MAX_GAS_FEE,
  operationGasCostWei,
  operationGasFee,
  userOpGasPrice,
} from './gasFee.js';
import { HOUR_MS, windowStartOf } from './prefundBudget.js';

const GWEI = 10n ** 9n;
const MARGIN = MAINNET.kuru.marginAccount as Address;
const USDC = MAINNET.tokens.USDC.address as Address;
const AUSD = MAINNET.tokens.AUSD.address as Address;
/** A throwaway recipient. It holds nothing and is never sent to. */
const RECIPIENT = getAddress('0x000000000000000000000000000000000000fee5');

/**
 * The MON/USDC mid of the recorded `bestBidAsk()` read (block 101,317,067, `l2book.ts`):
 * 0.025432 / 0.025439, so 0.0254355 at the 1e18 wire scale.
 */
const RECORDED_MID = (MON_USDC_L2_BEST_BID_WIRE + MON_USDC_L2_BEST_ASK_WIRE) / 2n;

/**
 * The second of the five profiling operations mined on 2026-09-24
 * (0x1111dda6…, `apps/relayer/src/fixtures/selfBundle.mainnet.json`): the browser's fees
 * of 244 / 4 gwei at Monad's 100 gwei base fee, 466,805 gas used, 0.04854772 MON drawn.
 * The relayer's own test re-reads all five from the fixture; these are that one, copied.
 */
const RECORDED = {
  maxFeePerGas: 244n * GWEI,
  maxPriorityFeePerGas: 4n * GWEI,
  baseFeePerGas: 100n * GWEI,
  actualGasUsed: 466_805n,
  actualGasCost: 48_547_720_000_000_000n,
};

describe('what an operation is charged for', () => {
  it('prices gas the way EntryPoint v0.8 does: min(maxFee, tip + base fee)', () => {
    const price = userOpGasPrice(
      RECORDED.maxFeePerGas,
      RECORDED.maxPriorityFeePerGas,
      RECORDED.baseFeePerGas,
    );
    expect(price).toBe(104n * GWEI);
    // The recorded operation was charged exactly that per gas.
    expect(RECORDED.actualGasUsed * price).toBe(RECORDED.actualGasCost);
    // A max fee under the market is the price; the legacy branch is the max fee itself.
    expect(userOpGasPrice(101n * GWEI, 4n * GWEI, 100n * GWEI)).toBe(101n * GWEI);
    expect(userOpGasPrice(50n * GWEI, 50n * GWEI, 100n * GWEI)).toBe(50n * GWEI);
  });

  it('charges every unit of gas the operation signed for, at that price', () => {
    const op = {
      callGasLimit: 454_886n,
      verificationGasLimit: 118_624n,
      preVerificationGas: 300_000n,
      maxFeePerGas: RECORDED.maxFeePerGas,
      maxPriorityFeePerGas: RECORDED.maxPriorityFeePerGas,
    };
    expect(operationGasCostWei(op, RECORDED.baseFeePerGas)).toBe(873_510n * 104n * GWEI);
    // Raising any limit or the tip raises the cost: a signer cannot lower its own fee
    // without lowering what its operation can draw.
    expect(
      operationGasCostWei({ ...op, callGasLimit: op.callGasLimit + 1n }, RECORDED.baseFeePerGas),
    ).toBeGreaterThan(operationGasCostWei(op, RECORDED.baseFeePerGas));
    expect(
      operationGasCostWei({ ...op, maxPriorityFeePerGas: 5n * GWEI }, RECORDED.baseFeePerGas),
    ).toBeGreaterThan(operationGasCostWei(op, RECORDED.baseFeePerGas));
  });
});

describe('the fee: cost + 20%, at the MON/USDC mid, up to 0.001, at least 0.005', () => {
  it('a real order costs under the minimum, so it is charged the minimum', () => {
    // 0.04854772 MON * 1.2 * 0.0254355 = $0.0014818.
    expect(gasFeeFromCostWei(RECORDED.actualGasCost, RECORDED_MID)).toBe(GAS_FEE_MINIMUM);
    expect(GAS_FEE_MINIMUM).toBe(5_000n);
  });

  it('a fee that falls between two 0.001 steps rounds UP to the next one', () => {
    // 0.2 MON * 1.2 = 0.24 MON; * 0.0254355 = $0.00610452: between 0.006 and 0.007.
    expect(gasFeeFromCostWei(200_000_000_000_000_000n, RECORDED_MID)).toBe(7_000n);
  });

  it('a fee on a step stays on it, and one wei over it rounds up to the next step', () => {
    // 0.006 / 1.2 / 0.0254355 = 0.19657565... MON. The largest cost that is still worth
    // at most $0.006000 with the margin, and the wei after it.
    const onTheStep = 196_575_652_139_725_973n;
    expect(gasFeeFromCostWei(onTheStep, RECORDED_MID)).toBe(6_000n);
    expect(gasFeeFromCostWei(onTheStep + 1n, RECORDED_MID)).toBe(7_000n);
  });

  it('never charges less than the minimum, even for no gas at all', () => {
    expect(gasFeeFromCostWei(0n, RECORDED_MID)).toBe(GAS_FEE_MINIMUM);
    expect(gasFeeFromCostWei(1n, RECORDED_MID)).toBe(GAS_FEE_MINIMUM);
  });

  it('has no fee without a usable mid: no default price', () => {
    expect(gasFeeFromCostWei(RECORDED.actualGasCost, 0n)).toBeUndefined();
    expect(gasFeeFromCostWei(-1n, RECORDED_MID)).toBeUndefined();
  });

  it('for any cost: a whole step, at least the minimum, never under the value, never a step too many', () => {
    const MICRO_PER = 10n ** 30n; // 1e18 MON decimals * 1e18 wire scale / 1e6 cap decimals
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 5n * 10n ** 18n }), (cost) => {
        const fee = gasFeeFromCostWei(cost, RECORDED_MID)!;
        expect(fee % GAS_FEE_STEP).toBe(0n);
        expect(fee >= GAS_FEE_MINIMUM).toBe(true);
        // The exact value with the margin, in micro-dollars, as a rational n / d.
        const n = cost * 12n * RECORDED_MID;
        const d = 10n * MICRO_PER;
        expect(fee * d >= n).toBe(true); // never under the value
        if (fee > GAS_FEE_MINIMUM) {
          // One step less would be under the value, allowing for the conversion's own
          // documented round-up to the micro-dollar and the margin's to the wei.
          expect((fee - GAS_FEE_STEP) * d < n + 2n * d).toBe(true);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('the formula both sides run is the pricing of the signed limits', () => {
    const op = {
      callGasLimit: 454_886n,
      verificationGasLimit: 118_624n,
      preVerificationGas: 300_000n,
      maxFeePerGas: RECORDED.maxFeePerGas,
      maxPriorityFeePerGas: RECORDED.maxPriorityFeePerGas,
    };
    const pricing = { baseFeePerGas: RECORDED.baseFeePerGas, monUsdMid: RECORDED_MID };
    expect(operationGasFee(op, pricing)).toBe(
      gasFeeFromCostWei(operationGasCostWei(op, pricing.baseFeePerGas), RECORDED_MID),
    );
    // 873,510 gas at 104 gwei is 0.0908 MON, $0.00277 with the margin: the minimum.
    expect(operationGasFee(op, pricing)).toBe(GAS_FEE_MINIMUM);
  });

  it('the ceiling on one fee sits well above any fee the relayer computes today', () => {
    // 0.45 MON is the most a deposit is ever topped up to (depositNeeded's ceiling).
    const ceilingCost = 450_000_000_000_000_000n;
    expect(gasFeeFromCostWei(ceilingCost, RECORDED_MID)!).toBeLessThan(MAX_GAS_FEE);
  });
});

describe('F5, revised twice: a signed limit that is not exactly the relayer’s own plan is named, so the operation can be refused', () => {
  const plan = { callGasLimit: 454_886n, verificationGasLimit: 118_624n, preVerificationGas: 300_000n };
  const fees = { maxFeePerGas: RECORDED.maxFeePerGas, maxPriorityFeePerGas: RECORDED.maxPriorityFeePerGas };

  it('names each limit above the plan AND each below it; none when all three are the plan', () => {
    expect(
      limitsOffPlan(
        { callGasLimit: 2_000_000n, verificationGasLimit: 100_000n, preVerificationGas: 1_300_000n, ...fees },
        plan,
      ),
    ).toEqual(['callGasLimit', 'verificationGasLimit', 'preVerificationGas']);
    expect(limitsOffPlan({ ...plan, ...fees }, plan)).toEqual([]);
    expect(limitsOffPlan({ ...plan, verificationGasLimit: 118_625n, ...fees }, plan)).toEqual([
      'verificationGasLimit',
    ]);
    // Final review, scenario F: 5,000 of verification gas against the 7,314 validation uses.
    expect(limitsOffPlan({ ...plan, verificationGasLimit: 5_000n, ...fees }, plan)).toEqual([
      'verificationGasLimit',
    ]);
    expect(limitsOffPlan({ ...plan, preVerificationGas: plan.preVerificationGas - 1n, ...fees }, plan)).toEqual([
      'preVerificationGas',
    ]);
  });

  it('within the plan, the fee is exactly the pricing of the signed limits; inflating them would raise it', () => {
    const pricing = { baseFeePerGas: RECORDED.baseFeePerGas, monUsdMid: RECORDED_MID };
    const inflated = { callGasLimit: 2_000_000n, verificationGasLimit: 500_000n, preVerificationGas: 1_300_000n, ...fees };
    expect(operationGasFee(inflated, pricing)).toBeGreaterThan(operationGasFee({ ...plan, ...fees }, pricing)!);
  });
});

describe('AUSD pays only when the USDC in margin cannot', () => {
  const fee = 5_000n;

  it('USDC first, whenever it covers the fee', () => {
    expect(gasFeeTokenFor({ USDC: 5_000n, AUSD: 1_000_000n }, fee)?.asset).toBe(USDC);
  });

  it('AUSD, one-for-one, when there is no USDC in margin', () => {
    const token = gasFeeTokenFor({ USDC: 0n, AUSD: 1_000_000n }, fee);
    expect(token?.asset).toBe(AUSD);
    expect(token?.kind).toBe('dollar');
    expect(token?.decimals).toBe(6);
    // One-for-one: the leg moves the same number of base units in either token.
    const [withdraw, transfer] = buildFeeLeg(MARGIN, token!.asset, RECIPIENT, fee);
    const w = decodeFunctionData({ abi: marginAccountAbi, data: withdraw.data });
    const t = decodeFunctionData({ abi: erc20Abi, data: transfer.data });
    expect(w.args).toEqual([fee, AUSD]);
    expect(t.args).toEqual([RECIPIENT, fee]);
  });

  it('AUSD too when the USDC in margin is not zero but is under the fee', () => {
    expect(gasFeeTokenFor({ USDC: 4_999n, AUSD: 1_000_000n }, fee)?.asset).toBe(AUSD);
  });

  it('nothing, when neither covers the fee: the account is refused', () => {
    expect(gasFeeTokenFor({ USDC: 0n, AUSD: 0n }, fee)).toBeUndefined();
    expect(gasFeeTokenFor({ USDC: 4_999n, AUSD: 4_999n }, fee)).toBeUndefined();
  });
});

describe('the fee leg is built with the same builders production uses', () => {
  it('MarginAccount.withdraw(fee, token), then token.transfer(recipient, fee)', () => {
    const [withdraw, transfer] = buildFeeLeg(MARGIN, USDC, RECIPIENT, 7_000n);
    const w = buildWithdraw(MARGIN, USDC, 7_000n);
    const t = buildErc20Transfer(USDC, RECIPIENT, 7_000n);
    expect(withdraw).toEqual({ to: w.to, data: w.data, value: 0n });
    expect(transfer).toEqual({ to: t.to, data: t.data, value: 0n });
  });
});

describe('free actions: a rolling day of hourly windows, counted in actions', () => {
  /** 2025-09-02T08:20:00Z, twenty minutes into its hourly window. */
  const NOW = Date.UTC(2025, 8, 2, 8, 20, 0);
  const hoursAgo = (h: number) => windowStartOf(NOW - h * HOUR_MS);

  it('twenty a day, all free, nothing to reset', () => {
    expect(FREE_ACTIONS_PER_DAY).toBe(20);
    const h = freeActionHeadroom({ windows: [] });
    expect(h).toEqual({ limit: 20, used: 0, remaining: 20 });
  });

  it('counts what the ledger holds, and says when the oldest counted hour leaves the day', () => {
    const h = freeActionHeadroom({
      windows: [
        { windowStart: hoursAgo(5), count: 3 },
        { windowStart: hoursAgo(1), count: 2 },
      ],
    });
    expect(h.used).toBe(5);
    expect(h.remaining).toBe(15);
    expect(h.resetsAt).toBe(hoursAgo(5) + 24 * HOUR_MS);
    expect(h.allFreeAt).toBe(hoursAgo(1) + 24 * HOUR_MS);
  });

  it('used up: free again when enough of the oldest hours have left the day, read from the ledger', () => {
    const h = freeActionHeadroom({
      windows: [
        { windowStart: hoursAgo(20), count: 8 },
        { windowStart: hoursAgo(10), count: 12 },
      ],
    });
    expect(h.remaining).toBe(0);
    // Removing the 20-hours-ago window leaves 12 < 20.
    expect(h.resetsAt).toBe(hoursAgo(20) + 24 * HOUR_MS);
    // Not a guessed "now + 24 h", and not a rounded midnight: the ledger's own hour.
    expect(h.resetsAt).not.toBe(NOW + 24 * HOUR_MS);
    expect(new Date(h.resetsAt!).toISOString()).toBe('2025-09-02T12:00:00.000Z');
  });

  it('when the first hour to leave still leaves the day full, the answer is a later hour', () => {
    const h = freeActionHeadroom({
      windows: [
        { windowStart: hoursAgo(20), count: 1 },
        { windowStart: hoursAgo(15), count: 1 },
        { windowStart: hoursAgo(2), count: 19 },
      ],
    });
    // 21 counted (a race can overshoot by the concurrency). Remove 1 -> 20, not under 20;
    // remove another -> 19.
    expect(h.remaining).toBe(0);
    expect(h.resetsAt).toBe(hoursAgo(15) + 24 * HOUR_MS);
  });
});

describe('the refusal', () => {
  it('is the owner’s sentence, word for word, with no hex and no wei', () => {
    // B2c (2026-09-25 spec) replaced the trading-balance wording: one sentence,
    // naming the two live ways forward.
    expect(FREE_ACTIONS_USED_MESSAGE).toBe(
      'Free actions for today are used. Swap into MON, or add money, and you can keep going.',
    );
    expect(FREE_ACTIONS_USED_MESSAGE).not.toMatch(/0x/);
  });

  it('carries a machine-readable reason the browser can recognise', () => {
    expect(isGasChargeRefusalData({ reason: 'FREE_ACTIONS_USED' })).toBe(true);
    expect(isGasChargeRefusalData({ reason: 'SPONSORSHIP_ALLOWANCE_USED' })).toBe(false);
    expect(isGasChargeRefusalData(null)).toBe(false);
  });
});
