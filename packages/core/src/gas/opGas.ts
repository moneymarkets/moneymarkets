import { MEASURED_TOTAL_GAS_DEPOSIT_AND_ORDER, MEASURED_TOTAL_GAS_ONE_ORDER } from './deposit.js';

/**
 * A user operation's three gas limits, decided by the relayer rather than by asking a
 * bundler (speed pass, 2026-09-24).
 *
 * Pimlico's `eth_estimateUserOperationGas` took 1,000 to 1,300 ms of a 6.7 s order
 * (median of five real MON/USDC market buys, `scripts/profile-order-path-buy.ts`). The
 * relayer can answer the same question with one `eth_estimateGas` of the operation's own
 * inner call, plus two constants measured from real bundles.
 *
 * ## Where the constants come from
 *
 * The five profiling operations mined on 2026-09-24 through Pimlico, sender
 * `0x43a275C3Eb0BE7313f847FFA4fb6Bd366606A961`, re-read from chain on the same day:
 *
 *   0x71df0a2149384ea53e69119f2d85ab0f74666033143a49db9887a30bd96be976
 *   0x1111dda69607c2fbd7b94aaeb39bdaacf248b99a947efb899383df6e14147958
 *   0x067e81987bf9f99924dbb692aa057ca12c9ac1430ef99a163e7c9f4e38cf53d4
 *   0x0ab91613ffbeaee8d22db916a413635e2238de8ba2c15668f35c340f58684857
 *   0x705b2c155b9b5cb6f271e5fb8ca0329db680804151826ad8e37b3c7b939a2eec
 *
 * Decoded from each `handleOps` calldata's packed `accountGasLimits`:
 * `verificationGasLimit` was 91,249 on all five. `preVerificationGas` was 204,992 on the
 * first and 194,579 to 194,592 on the other four. The highest is used, so every one of
 * the five would have fitted. A trace of the second shows the account's own
 * `validateUserOp` using 7,314 of its 91,249, so the verification figure is generous
 * before any headroom is added.
 *
 * The owner's headroom was 30% on both until 2026-09-29, when it became 15%: Monad charges
 * the whole gas limit, so every point of headroom is paid for (owner item 3, D191). `selfBundle.test.ts` in the relayer re-derives the
 * two figures from the recorded transactions, so a change here that the chain does not
 * support fails a test.
 */
export const MEASURED_VERIFICATION_GAS_LIMIT = 91_249n;
export const MEASURED_PRE_VERIFICATION_GAS = 204_992n;

export interface Headroom {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

/** 15%, on the measured constants and on the inner-call estimate. Owner's figure (2026-09-29;
 *  30% before). Monad charges the whole limit, so headroom is a cost, not a safety margin. */
export const ESTIMATE_HEADROOM: Headroom = { numerator: 115n, denominator: 100n };

/** None: the floor is the measured minimum itself (owner item 3, 2026-09-29; 50% before). */
export const FLOOR_HEADROOM: Headroom = { numerator: 1n, denominator: 1n };

/**
 * The most gas an operation's own call may be given. Owner's ceiling, and the same
 * 2,000,000 the relayer's `RELAYER_MAX_GAS` default already applies to a forwarded call.
 */
export const MAX_CALL_GAS_LIMIT = 2_000_000n;

/** `value * headroom`, rounded up. A limit rounded down is a limit that can run out. */
export function withHeadroom(value: bigint, headroom: Headroom): bigint {
  return (value * headroom.numerator + headroom.denominator - 1n) / headroom.denominator;
}

/** 104,937: the measured 91,249 plus 15%. */
export const VERIFICATION_GAS_LIMIT = withHeadroom(
  MEASURED_VERIFICATION_GAS_LIMIT,
  ESTIMATE_HEADROOM,
);

/**
 * 235,741: the least preVerificationGas this relayer hands out. What an operation actually
 * gets scales with its call limit and call data; see `preVerificationGasFor`.
 */
export const PRE_VERIFICATION_GAS = withHeadroom(MEASURED_PRE_VERIFICATION_GAS, ESTIMATE_HEADROOM);

/**
 * Pimlico's own preVerificationGas on Monad, as a line through its real answers
 * (2026-09-24, `fixtures/selfBundle.mainnet.json` in the relayer).
 *
 * Pimlico's bundler (Alto, `calcMonadPvg`) prices preVerificationGas on Monad as the
 * bundle's gas limit minus 70% of the operation's own limits, because Monad charges the
 * whole limit. So it rises with callGasLimit, and it checks a send against the limits the
 * sender signed: 90% of that figure, or the send is refused. Measured:
 *
 *   one order, 292 bytes of call data:  callGasLimit 227,427 -> 194,592
 *                                       callGasLimit 251,597 -> 204,992
 *                                       callGasLimit 259,653 -> 208,496
 *   permit + deposit + order, 1,092 B:  callGasLimit 404,673 -> 276,893
 *
 * Slope 13,904 / 32,226 (0.431) per unit of callGasLimit, from the first and third; the
 * other two sit on the line within 120 gas. The batch then prices 800 more bytes of call
 * data at 5,828 / 800 (7.3) gas a byte.
 *
 * A single constant for every shape was wrong: a batch at this relayer's own limits would
 * have met Pimlico's "preVerificationGas is not enough" on every fallback.
 */
export const PVG_ANCHOR = {
  callGasLimit: 259_653n,
  callDataBytes: 292n,
  preVerificationGas: 208_496n,
} as const;
export const PVG_PER_CALL_GAS: Headroom = { numerator: 13_904n, denominator: 32_226n };
export const PVG_PER_CALLDATA_BYTE: Headroom = { numerator: 5_828n, denominator: 800n };

/**
 * The measured line at this operation's own limits, plus the owner's 15% (D191), and never
 * below `PRE_VERIFICATION_GAS`.
 *
 * The 15% also covers the one term the measurements hold constant: this relayer's
 * verificationGasLimit (104,937) is 13,688 above Pimlico's (91,249), which Alto's formula
 * can count at up to about one gas each. 15% of the smallest line value (~195,000) is
 * about twice that.
 */
export function preVerificationGasFor(callGasLimit: bigint, callDataBytes: bigint): bigint {
  const dCall = callGasLimit - PVG_ANCHOR.callGasLimit;
  const dBytes = callDataBytes - PVG_ANCHOR.callDataBytes;
  // Rounded away from the anchor on the rising side, so the line is never under-read.
  const ceilDiv = (n: bigint, d: bigint) => (n >= 0n ? (n + d - 1n) / d : n / d);
  const line =
    PVG_ANCHOR.preVerificationGas +
    ceilDiv(dCall * PVG_PER_CALL_GAS.numerator, PVG_PER_CALL_GAS.denominator) +
    ceilDiv(dBytes * PVG_PER_CALLDATA_BYTE.numerator, PVG_PER_CALLDATA_BYTE.denominator);
  const scaled = withHeadroom(line > 0n ? line : 0n, ESTIMATE_HEADROOM);
  return scaled > PRE_VERIFICATION_GAS ? scaled : PRE_VERIFICATION_GAS;
}

/**
 * Which measured total an operation is floored against.
 *
 * `deposit.ts` measured two shapes: one order (410,000) and a deposit plus an order
 * (560,000). A single call is the first. Anything batched, a funding batch included, is
 * floored against the larger, which is the conservative side for a floor.
 */
export type CallShape = 'single' | 'batch';

export function callShapeOf(callCount: number): CallShape {
  return callCount > 1 ? 'batch' : 'single';
}

/** 410,000 for a single call, 560,000 for a batch: the measured totals. */
export function totalGasFloor(shape: CallShape): bigint {
  const measured =
    shape === 'single' ? MEASURED_TOTAL_GAS_ONE_ORDER : MEASURED_TOTAL_GAS_DEPOSIT_AND_ORDER;
  return withHeadroom(measured, FLOOR_HEADROOM);
}

/**
 * The smallest `callGasLimit` this relayer hands out: 69,322 single, 219,322 batched.
 *
 * ## Why the floor is on the total, not on `callGasLimit` alone
 *
 * The owner's rule since D191 is "floor at the measured minimum" (it was "the measured
 * total x 1.5" before). `deposit.ts` documents 410,000 and 560,000 as whole-operation
 * totals, the three limits summed. So the floor here keeps the whole operation at or above
 * its measured total, and the call limit is what is left after the two constants above.
 * Floored on `callGasLimit` alone (under the earlier x1.5 rule, 615,000), it was measured
 * against real estimates before choosing:
 *
 *   - every real order would get the floor. A MON/USDC market sell estimates 257,496
 *     (x1.3 = 334,745). An order would need to estimate above 473,077 before its own
 *     estimate counted. The owner's own test ("a typical order gets estimate x 1.3") could
 *     not pass on any shape measured;
 *   - on Monad a bundler is charged its transaction's whole gas LIMIT (all five receipts
 *     above report `gasUsed == gas`, and Pimlico's balance moved by exactly
 *     `actualGasCost - gas * effectiveGasPrice`). Worked from the trace of the second
 *     transaction (about 103,000 gas spent before the inner call, 205,662 inside it), a
 *     615,000 call limit forces a `handleOps` gas limit near 748,000 against about 580,000
 *     the EntryPoint would repay, the 10% unused-gas penalty included. Self-bundling
 *     would lose about 0.017 MON on every order, and the relayer's net-zero check would
 *     send every order back to Pimlico.
 *
 * Switching to the literal reading is one line: drop the two subtractions below.
 */
export function callGasFloor(shape: CallShape): bigint {
  return totalGasFloor(shape) - VERIFICATION_GAS_LIMIT - PRE_VERIFICATION_GAS;
}

export interface GasPlan {
  readonly callGasLimit: bigint;
  readonly verificationGasLimit: bigint;
  readonly preVerificationGas: bigint;
  /** Which term decided `callGasLimit`. For logs and tests. */
  readonly basis: 'estimate' | 'floor' | 'ceiling';
}

export type GasPlanResult =
  { readonly ok: true; readonly plan: GasPlan } | { readonly ok: false; readonly reason: string };

/**
 * `callGasLimit = max(floor, estimate x 1.15)`, capped at 2,000,000.
 *
 * `innerEstimate` is `eth_estimateGas` of the operation's call data, sent by the account
 * to itself: exactly what the EntryPoint runs as the operation's call. It includes the
 * 21,000 and the calldata a top-level transaction pays and an inner call does not, so it
 * errs high.
 *
 * An estimate above the ceiling is refused rather than capped. A call limit below what
 * the call needs runs out of gas on chain, and the user pays for that.
 */
export function planUserOperationGas(input: {
  readonly innerEstimate: bigint;
  readonly callCount: number;
  /** The operation's `callData` length in bytes, for its preVerificationGas. */
  readonly callDataBytes: bigint;
}): GasPlanResult {
  if (input.innerEstimate > MAX_CALL_GAS_LIMIT) {
    return {
      ok: false,
      reason: `this operation needs ${input.innerEstimate} gas, above the ${MAX_CALL_GAS_LIMIT} this relayer allows one operation`,
    };
  }
  const fromEstimate = withHeadroom(input.innerEstimate, ESTIMATE_HEADROOM);
  const floor = callGasFloor(callShapeOf(input.callCount));
  let callGasLimit = fromEstimate > floor ? fromEstimate : floor;
  let basis: GasPlan['basis'] = fromEstimate > floor ? 'estimate' : 'floor';
  if (callGasLimit > MAX_CALL_GAS_LIMIT) {
    callGasLimit = MAX_CALL_GAS_LIMIT;
    basis = 'ceiling';
  }
  return {
    ok: true,
    plan: {
      callGasLimit,
      verificationGasLimit: VERIFICATION_GAS_LIMIT,
      preVerificationGas: preVerificationGasFor(callGasLimit, input.callDataBytes),
      basis,
    },
  };
}
