import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { encodeFunctionData, parseAbi } from 'viem';
import {
  callGasFloor,
  MAX_CALL_GAS_LIMIT,
  planUserOperationGas,
  PRE_VERIFICATION_GAS,
  preVerificationGasFor,
  totalGasFloor,
  VERIFICATION_GAS_LIMIT,
  withHeadroom,
  ESTIMATE_HEADROOM,
} from './opGas.js';
import { requiredPrefund } from './deposit.js';
import { orderBookAbi } from '../abi/orderBook.js';

/**
 * Real inputs only. Every estimate below is an `eth_estimateGas` that rpc.monad.xyz
 * returned on 2026-09-24 for the gate account `0x43a2…A961` sending its own call data to
 * itself, which is how the relayer measures an operation's inner call:
 *
 *   market sell 1 MON on MON/USDC, one call        257,496
 *   two market sells on MON/USDC, `executeBatch`    284,595
 *
 * The gate account held 20.55 MON and 0 USDC in margin at the time, so these are the
 * shapes it could actually run. A USDC buy reverted with InsufficientBalance.
 */
const MARKET_SELL_ESTIMATE = 257_496n;
const TWO_CALL_BATCH_ESTIMATE = 284_595n;

/** The call data of those two shapes, encoded as the account encodes them. */
const MON_USDC = '0x065C9d28E428A0db40191a54d33d5b7c71a9C394';
const sell = (size: bigint) =>
  encodeFunctionData({
    abi: orderBookAbi,
    functionName: 'placeAndExecuteMarketSell',
    args: [size, 0n, true, false],
  });
const accountAbi = parseAbi([
  'function execute(address target, uint256 value, bytes data)',
  'function executeBatch((address target, uint256 value, bytes data)[] calls)',
]);
const bytesOf = (hex: string) => BigInt((hex.length - 2) / 2);
const SINGLE_CALLDATA_BYTES = bytesOf(
  encodeFunctionData({
    abi: accountAbi,
    functionName: 'execute',
    args: [MON_USDC, 0n, sell(10n ** 10n)],
  }),
);
const BATCH_CALLDATA_BYTES = bytesOf(
  encodeFunctionData({
    abi: accountAbi,
    functionName: 'executeBatch',
    args: [
      [
        { target: MON_USDC, value: 0n, data: sell(2n * 10n ** 10n) },
        { target: MON_USDC, value: 0n, data: sell(10n ** 10n) },
      ],
    ],
  }),
);

/**
 * Pimlico's own answers, through production's `/api/submit`, 2026-09-24 (the relayer's
 * fixture `selfBundle.mainnet.json` holds the same figures with their source).
 */
const PIMLICO = [
  {
    shape: 'one market sell',
    callDataBytes: 292n,
    callGasLimit: 259_653n,
    preVerificationGas: 208_496n,
  },
  {
    shape: 'permit + deposit + buy',
    callDataBytes: 1_092n,
    callGasLimit: 404_673n,
    preVerificationGas: 276_893n,
  },
  // The five profiling bundles: one order, 292 bytes, Pimlico's own limits.
  {
    shape: 'profiling bundle',
    callDataBytes: 292n,
    callGasLimit: 227_427n,
    preVerificationGas: 194_592n,
  },
  {
    shape: 'profiling bundle',
    callDataBytes: 292n,
    callGasLimit: 251_597n,
    preVerificationGas: 204_992n,
  },
];

// Owner item 3 (2026-09-29, D191): 15% headroom and the floor at the measured minimum,
// replacing 30% and 1.5x. Monad charges the whole limit, so every figure below is paid for.
describe('the constants are the measured figures plus 15%, rounded up', () => {
  it('verificationGasLimit 91,249 -> 104,937 and the least preVerificationGas 204,992 -> 235,741', () => {
    expect(VERIFICATION_GAS_LIMIT).toBe(104_937n);
    expect(PRE_VERIFICATION_GAS).toBe(235_741n);
  });

  it('the floors keep an operation at its measured total, no more', () => {
    expect(totalGasFloor('single')).toBe(410_000n);
    expect(totalGasFloor('batch')).toBe(560_000n);
    expect(callGasFloor('single') + VERIFICATION_GAS_LIMIT + PRE_VERIFICATION_GAS).toBe(410_000n);
    expect(callGasFloor('batch') + VERIFICATION_GAS_LIMIT + PRE_VERIFICATION_GAS).toBe(560_000n);
  });

  it('the call data sizes above are the ones Pimlico was asked about', () => {
    expect(SINGLE_CALLDATA_BYTES).toBe(292n);
  });
});

describe('callGasLimit = max(floor, estimate x 1.15), capped at 2,000,000', () => {
  it('a typical order gets its own estimate x 1.15: not the floor, not the ceiling', () => {
    const result = planUserOperationGas({
      innerEstimate: MARKET_SELL_ESTIMATE,
      callCount: 1,
      callDataBytes: SINGLE_CALLDATA_BYTES,
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.plan.basis).toBe('estimate');
    expect(result.plan.callGasLimit).toBe(296_121n); // ceil(257,496 x 1.15)
    expect(result.plan.callGasLimit).toBeGreaterThan(callGasFloor('single'));
    expect(result.plan.callGasLimit).toBeLessThan(MAX_CALL_GAS_LIMIT);
  });

  it('a two-call batch now gets its own estimate x 1.15, above the measured batch floor', () => {
    // ceil(284,595 x 1.15) = 327,285, above the batch floor of 219,322.
    const result = planUserOperationGas({
      innerEstimate: TWO_CALL_BATCH_ESTIMATE,
      callCount: 2,
      callDataBytes: BATCH_CALLDATA_BYTES,
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.plan.basis).toBe('estimate');
    expect(result.plan.callGasLimit).toBe(327_285n);
  });

  it('an estimate at the intrinsic minimum gets the measured floor', () => {
    // 21,000 is the least any call can estimate; ceil(21,000 x 1.15) = 24,150 < 69,322.
    const result = planUserOperationGas({ innerEstimate: 21_000n, callCount: 1, callDataBytes: 292n });
    if (!result.ok) throw new Error(result.reason);
    expect(result.plan.basis).toBe('floor');
    expect(result.plan.callGasLimit).toBe(69_322n);
  });

  it('an estimate whose headroom crosses the ceiling is held at the ceiling', () => {
    const result = planUserOperationGas({
      innerEstimate: MAX_CALL_GAS_LIMIT,
      callCount: 1,
      callDataBytes: 292n,
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.plan.basis).toBe('ceiling');
    expect(result.plan.callGasLimit).toBe(MAX_CALL_GAS_LIMIT);
  });

  it('an estimate the ceiling cannot hold is refused, never capped below what it needs', () => {
    const result = planUserOperationGas({
      innerEstimate: MAX_CALL_GAS_LIMIT + 1n,
      callCount: 1,
      callDataBytes: 292n,
    });
    expect(result.ok).toBe(false);
  });

  it('property: never above the ceiling, never below the floor, never below the estimate', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 21_000n, max: MAX_CALL_GAS_LIMIT }),
        fc.integer({ min: 1, max: 6 }),
        (innerEstimate, callCount) => {
          const result = planUserOperationGas({ innerEstimate, callCount, callDataBytes: 292n });
          if (!result.ok) return false;
          const shape = callCount > 1 ? 'batch' : 'single';
          const { callGasLimit } = result.plan;
          return (
            callGasLimit <= MAX_CALL_GAS_LIMIT &&
            callGasLimit >= callGasFloor(shape) &&
            callGasLimit >= innerEstimate
          );
        },
      ),
    );
  });

  it('property: headroom rounds up, so a limit is never a fraction short', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 12n }), (value) => {
        const out = withHeadroom(value, ESTIMATE_HEADROOM);
        return out * 100n >= value * 115n && (out - 1n) * 100n < value * 115n;
      }),
    );
  });
});

describe('preVerificationGas scales with the call limit and call data, as Pimlico’s does', () => {
  it('at Pimlico’s own limits, never below what Pimlico itself asked for, on every recorded answer', () => {
    for (const p of PIMLICO) {
      expect(preVerificationGasFor(p.callGasLimit, p.callDataBytes)).toBeGreaterThanOrEqual(
        p.preVerificationGas,
      );
    }
  });

  it('at this relayer’s own limits, above Pimlico’s send check for both shapes', () => {
    /*
     * Alto refuses a send whose preVerificationGas is below 90% of its Monad figure for the
     * limits the sender signed. That figure is the measured line at those limits, plus up to
     * about one gas per unit of verificationGasLimit above Pimlico's 91,249: this relayer's
     * is 104,937, so at most 13,688 more.
     */
    const line = (cgl: bigint, bytes: bigint) =>
      208_496n + ((cgl - 259_653n) * 13_904n) / 32_226n + ((bytes - 292n) * 5_828n) / 800n;
    const sendCheck = (cgl: bigint, bytes: bigint) => ((line(cgl, bytes) + 13_688n) * 9n) / 10n;
    const single = planUserOperationGas({
      innerEstimate: MARKET_SELL_ESTIMATE,
      callCount: 1,
      callDataBytes: 292n,
    });
    // The batch Pimlico was asked about, planned from its own inner-call estimate: 395,685,
    // the gate account's permit + deposit + buy sent to itself on 2026-09-24 with the same
    // USDC balance override Pimlico's estimate used.
    const batch = planUserOperationGas({
      innerEstimate: 395_685n,
      callCount: 3,
      callDataBytes: 1_092n,
    });
    if (!single.ok || !batch.ok) throw new Error('no plan');
    expect(single.plan.preVerificationGas).toBeGreaterThan(
      sendCheck(single.plan.callGasLimit, 292n),
    );
    expect(batch.plan.preVerificationGas).toBeGreaterThan(
      sendCheck(batch.plan.callGasLimit, 1_092n),
    );
    // The old single constant did not clear it for a batch. This is the regression.
    expect(PRE_VERIFICATION_GAS).toBeLessThan(sendCheck(batch.plan.callGasLimit, 1_092n));
  });

  it('never below the least figure, and never falls as the call limit or call data grows', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 21_000n, max: MAX_CALL_GAS_LIMIT }),
        fc.bigInt({ min: 0n, max: 20_000n }),
        fc.bigInt({ min: 0n, max: 100_000n }),
        fc.bigInt({ min: 0n, max: 2_000n }),
        (cgl, bytes, dCgl, dBytes) => {
          const here = preVerificationGasFor(cgl, bytes);
          return (
            here >= PRE_VERIFICATION_GAS &&
            preVerificationGasFor(cgl + dCgl, bytes) >= here &&
            preVerificationGasFor(cgl, bytes + dBytes) >= here
          );
        },
      ),
    );
  });
});

describe('what the new limits reserve against a deposit', () => {
  it('at the browser’s 244 gwei, a market sell reserves more than MIN_ENTRYPOINT_DEPOSIT', () => {
    // Why prefund.ts must top up to the operation's own prefund and not only to the
    // 0.15 MON minimum: 296,121 + 104,937 + 257,866 = 658,924 gas x 244 gwei.
    const result = planUserOperationGas({
      innerEstimate: MARKET_SELL_ESTIMATE,
      callCount: 1,
      callDataBytes: 292n,
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.plan.preVerificationGas).toBe(257_866n);
    const reserve = requiredPrefund({ ...result.plan, maxFeePerGas: 244_000_000_000n });
    expect(reserve).toBe(160_777_456_000_000_000n);
  });
});
