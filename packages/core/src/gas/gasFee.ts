import type { Address } from 'viem';
import { MAINNET } from '../chain/addresses.js';
import {
  CAP_UNIT_DECIMALS,
  QUOTE_VALUATIONS,
  quoteAmountInCapUnits,
  type QuoteValuation,
} from '../chain/quoteValuation.js';
import { buildErc20Transfer, buildWithdraw } from '../kuru/orders.js';
import type { SponsoredCall } from './account.js';
import { HOUR_MS, rollingDayResetsAt, WINDOWS_PER_DAY } from './prefundBudget.js';

/**
 * Free actions, then gas at cost (owner's policy, 2026-09-24).
 *
 *   1. Every account gets `FREE_ACTIONS_PER_DAY` sponsored actions in any rolling 24 hours,
 *      counted in the same fixed hourly windows as the sponsorship budgets
 *      (`prefundBudget.ts`). Moving the user's own funds out, a send or a withdraw, is
 *      never counted and never charged.
 *   2. After that an action pays its own gas, at cost plus 20%, from the trading balance:
 *      the user's own batch ends with `MarginAccount.withdraw(fee, token)` and
 *      `token.transfer(feeRecipient, fee)`, in the one operation the user signs.
 *   3. An account with nothing to pay with and no free action left is refused, in
 *      `FREE_ACTIONS_USED_MESSAGE`.
 *
 * This module is the arithmetic both sides of the signing boundary share: the browser
 * builds the fee leg with it and the relayer recomputes the same figure from the operation
 * the user signed. Which batches may carry a fee leg is the policy's call (`policy.ts`,
 * `splitFeeLeg`), not this file's.
 */

/** Owner's figure. */
export const FREE_ACTIONS_PER_DAY = 20;

/** Owner's figure: cost plus 20%. */
export const GAS_FEE_MARGIN = { numerator: 12n, denominator: 10n } as const;

/** Owner's figure: fees are rounded up to 0.001 of a six-decimal dollar. */
export const GAS_FEE_STEP = 1_000n;

/** Owner's figure: 0.005 of a six-decimal dollar, whatever the computed cost. */
export const GAS_FEE_MINIMUM = 5_000n;

/**
 * The most one fee leg may ever move: 0.10 of a six-decimal dollar.
 *
 * The owner asked for a sane bound on the new transfer and gave no figure, so this one is
 * derived rather than chosen. The relayer tops a deposit up to at most
 * `MIN_ENTRYPOINT_DEPOSIT_WEI + ENTRYPOINT_TOPUP_WEI` = 0.45 MON (`depositNeeded`), and an
 * operation that needs more than that is not one it chases. At the recorded MON/USDC mid
 * of 0.0254355 (`l2book.ts`), 0.45 MON plus 20% is $0.0137, and one market order priced
 * on its signed limits (about 873,500 gas at 104 gwei, 0.091 MON) is $0.0028, under the
 * 0.005 minimum. $0.10 leaves MON room to rise about sevenfold before a fee is refused
 * rather than charged, and it stops any error upstream of the fee (a bad mid, a bad
 * limit) from authorising a large transfer to the relayer. Refusing is the direction a
 * wrong figure should fail in.
 */
export const MAX_GAS_FEE = 100_000n;

/** Native MON, priced by the MON/USDC mid: the valuation `quoteValuation.ts` already uses. */
export const GAS_VALUATION: QuoteValuation = (() => {
  const mon = QUOTE_VALUATIONS.find(
    (v) =>
      v.kind === 'priced' &&
      v.asset.toLowerCase() === MAINNET.tokens.MON.address.toLowerCase(),
  );
  if (!mon) throw new Error('quoteValuation.ts no longer prices native MON; gas cannot be charged');
  return mon;
})();

function dollar(address: string): QuoteValuation {
  const valuation = QUOTE_VALUATIONS.find(
    (v) => v.kind === 'dollar' && v.asset.toLowerCase() === address.toLowerCase(),
  );
  // `quoteValuation.ts` already refuses to load unless both are six-decimal dollars.
  if (!valuation || valuation.decimals !== CAP_UNIT_DECIMALS) {
    throw new Error(`${address} is not a six-decimal dollar in quoteValuation.ts`);
  }
  return valuation;
}

/**
 * The two tokens a fee may be paid in, in the order they are chosen: USDC, and AUSD when
 * the USDC in margin cannot cover the fee. Both are one-for-one dollars in
 * `quoteValuation.ts`, so a fee of N cap units is N base units of either.
 */
export const GAS_FEE_TOKENS: readonly QuoteValuation[] = [
  dollar(MAINNET.tokens.USDC.address),
  dollar(MAINNET.tokens.AUSD.address),
];

export function isGasFeeToken(token: string): boolean {
  return GAS_FEE_TOKENS.some((t) => t.asset.toLowerCase() === token.toLowerCase());
}

// ---------------------------------------------------------------------------------------
// What an operation costs, and what it is charged
// ---------------------------------------------------------------------------------------

/**
 * EntryPoint v0.8's `_getUserOpGasPrice`: what the operation pays per gas in a block with
 * this base fee. The legacy branch is the EntryPoint's own. `selfBundle.test.ts` checks
 * the formula against all five recorded mainnet operations.
 */
export function userOpGasPrice(
  maxFeePerGas: bigint,
  maxPriorityFeePerGas: bigint,
  baseFeePerGas: bigint,
): bigint {
  if (maxFeePerGas === maxPriorityFeePerGas) return maxFeePerGas;
  const market = maxPriorityFeePerGas + baseFeePerGas;
  return maxFeePerGas < market ? maxFeePerGas : market;
}

/** The fields of a signed operation the fee is computed from. */
export interface GasEnvelope {
  readonly callGasLimit: bigint;
  readonly verificationGasLimit: bigint;
  readonly preVerificationGas: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
}

/**
 * The gas cost an operation is charged for, in wei: every unit of gas it signed for, at
 * the price the EntryPoint will charge it at this base fee.
 *
 * `gasLimit x price`, one of the two figures the owner named. It is the most the operation
 * can draw from the deposit the relayer funds, so a fee on it is never under the relayer's
 * real outlay at that base fee. What an operation really draws (`actualGasCost`) is
 * lower: the five recorded orders drew 466,653 to 494,081 gas against signed limits that
 * summed higher. So this charges at the top of the operation's own envelope, never past it,
 * and at today's prices the 0.005 minimum is larger than either figure.
 *
 * Every input is either signed by the user or read by the relayer (the base fee), so the
 * relayer can recompute it exactly from the operation it was asked to submit.
 */
export function operationGasCostWei(op: GasEnvelope, baseFeePerGas: bigint): bigint {
  return (
    (op.callGasLimit + op.verificationGasLimit + op.preVerificationGas) *
    userOpGasPrice(op.maxFeePerGas, op.maxPriorityFeePerGas, baseFeePerGas)
  );
}

/**
 * The fee for `costWei` of gas, in base units of a six-decimal dollar:
 *
 *   cost + 20%, valued at the MON/USDC mid, rounded UP to 0.001, and never under 0.005.
 *
 * The margin is applied in wei (rounded up, so at most one wei), the conversion is
 * `quoteAmountInCapUnits` exactly as the order cap uses it (rounded up to the micro-dollar),
 * and the step rounding is last. `undefined` when there is no usable mid: the caller
 * refuses rather than charging at a guessed price.
 */
export function gasFeeFromCostWei(costWei: bigint, monUsdMid: bigint): bigint | undefined {
  if (costWei < 0n) return undefined;
  const withMargin =
    (costWei * GAS_FEE_MARGIN.numerator + GAS_FEE_MARGIN.denominator - 1n) /
    GAS_FEE_MARGIN.denominator;
  const dollars = quoteAmountInCapUnits(withMargin, GAS_VALUATION, monUsdMid);
  if (dollars === undefined) return undefined;
  const stepped = ((dollars + GAS_FEE_STEP - 1n) / GAS_FEE_STEP) * GAS_FEE_STEP;
  return stepped < GAS_FEE_MINIMUM ? GAS_FEE_MINIMUM : stepped;
}

/**
 * Which signed gas limits are not exactly the relayer's own fresh plan for the same call
 * data (F5, twice revised after independent review, 2026-09-24). A charged operation with
 * any is refused, never priced on a cap and never funded:
 *
 *   - above the plan, a relayer that funded the plan funded less than the EntryPoint
 *     demands for the limits AS SIGNED: AA21, nothing mines, no fee, the nonce unused, and
 *     the same signed operation replays for another top-up;
 *   - below it, the operation can fail the same way from the other side: a
 *     `verificationGasLimit` of 5,000 against the 7,314 `validateUserOp` really uses is
 *     AA23 (19 top-ups, 4.823 MON of the shared hour, from one signature), and a
 *     `preVerificationGas` under a bundler's own minimum is never included at all.
 *
 * The plan is what `/v1/gas/quote` hands out, so an honest client signs exactly it. Empty
 * when every limit equals the plan.
 */
export function limitsOffPlan(
  op: GasEnvelope,
  plan: {
    readonly callGasLimit: bigint;
    readonly verificationGasLimit: bigint;
    readonly preVerificationGas: bigint;
  },
): ReadonlyArray<'callGasLimit' | 'verificationGasLimit' | 'preVerificationGas'> {
  const off: Array<'callGasLimit' | 'verificationGasLimit' | 'preVerificationGas'> = [];
  if (op.callGasLimit !== plan.callGasLimit) off.push('callGasLimit');
  if (op.verificationGasLimit !== plan.verificationGasLimit) off.push('verificationGasLimit');
  if (op.preVerificationGas !== plan.preVerificationGas) off.push('preVerificationGas');
  return off;
}

/**
 * What the relayer read when it priced a fee, and hands back to the client verbatim.
 * Kept by the relayer for a short while so the figure it verifies at send is the figure
 * the client was shown, rather than whatever the book and the base fee say a block later.
 */
export interface GasFeePricing {
  readonly baseFeePerGas: bigint;
  /** MON/USDC mid, wire scale (human * 1e18). */
  readonly monUsdMid: bigint;
}

/** The fee for one signed operation at one pricing. The single formula both sides run. */
export function operationGasFee(op: GasEnvelope, pricing: GasFeePricing): bigint | undefined {
  return gasFeeFromCostWei(operationGasCostWei(op, pricing.baseFeePerGas), pricing.monUsdMid);
}

/**
 * Which token pays `fee`: USDC when the USDC in margin covers it, otherwise AUSD when the
 * AUSD in margin does, otherwise none, and the action is refused. A balance that is not
 * zero but is below the fee cannot pay it any more than zero can.
 */
export function gasFeeTokenFor(
  marginBalances: { readonly USDC: bigint; readonly AUSD: bigint },
  fee: bigint,
): QuoteValuation | undefined {
  const [usdc, ausd] = GAS_FEE_TOKENS;
  if (marginBalances.USDC >= fee) return usdc;
  if (marginBalances.AUSD >= fee) return ausd;
  return undefined;
}

/** The two calls a charged batch ends with. The browser appends exactly these. */
export function buildFeeLeg(
  marginAccount: Address,
  token: Address,
  recipient: Address,
  amount: bigint,
): readonly [SponsoredCall, SponsoredCall] {
  const withdraw = buildWithdraw(marginAccount, token, amount);
  const transfer = buildErc20Transfer(token, recipient, amount);
  return [
    { to: withdraw.to, data: withdraw.data, value: 0n },
    { to: transfer.to, data: transfer.data, value: 0n },
  ];
}

// ---------------------------------------------------------------------------------------
// Free actions: the rolling day, counted in actions instead of wei
// ---------------------------------------------------------------------------------------

/** One address's counted actions per hourly window across the rolling day, oldest first. */
export interface FreeActionUsage {
  readonly windows: ReadonlyArray<{ readonly windowStart: number; readonly count: number }>;
}

export interface FreeActionHeadroom {
  readonly limit: number;
  readonly used: number;
  readonly remaining: number;
  /**
   * When `remaining` next goes up: the moment the oldest counted hour leaves the rolling
   * day, or, with none left, the moment enough have left for one to be free again. Epoch
   * ms, always the start of an hour, because that is when the ledger frees it. Absent when
   * nothing is counted.
   */
  readonly resetsAt?: number;
  /** When every counted action has left the rolling day. Absent when nothing is counted. */
  readonly allFreeAt?: number;
}

export function freeActionHeadroom(
  usage: FreeActionUsage,
  limit: number = FREE_ACTIONS_PER_DAY,
): FreeActionHeadroom {
  const windows = usage.windows
    .filter((w) => w.count > 0)
    .map((w) => ({ windowStart: w.windowStart, amount: BigInt(w.count) }));
  const total = windows.reduce((sum, w) => sum + w.amount, 0n);
  const used = Number(total);
  const remaining = used >= limit ? 0 : limit - used;
  if (total === 0n) return { limit, used, remaining };
  const budget = total < BigInt(limit) ? total : BigInt(limit);
  const last = windows[windows.length - 1]!;
  return {
    limit,
    used,
    remaining,
    resetsAt: rollingDayResetsAt(windows, total, budget),
    allFreeAt: last.windowStart + WINDOWS_PER_DAY * HOUR_MS,
  };
}

// ---------------------------------------------------------------------------------------
// Refusals: the words, and the machine-readable half
// ---------------------------------------------------------------------------------------

/**
 * The owner's sentence, verbatim (rebuild, 2026-09-25) — the ONE gas refusal message
 * this codebase may ever show. It covers every reason a non-exempt action ends up
 * needing to be charged (free actions used, or its own per-address MON budget is
 * tight) once that account has nothing left to charge: zero free actions and no
 * USDC or AUSD in the trading balance to pay with. There used to be several
 * different sentences for the different reasons an action became "charged", and a
 * bug in which sentence was chosen for which reason showed a user with 18 of 20 free
 * actions left a message that told them their free tier was exhausted — it was not;
 * a per-address MON budget was, which per the owner's policy is never a refusal, it
 * is a reason to charge. Every other gas-refusal sentence that distinguished "why"
 * is gone with it, on the same reasoning: the user only needs to know whether they
 * can act (add funds) or not (nothing to do), not which internal ledger was tight.
 */
export const FREE_ACTIONS_USED_MESSAGE =
  'Free actions for today are used. Swap into MON, or add money, and you can keep going.';

/**
 * The refusal while free actions remain (owner item 2, 2026-09-29, D191): a MON
 * sponsorship budget was reached, the action fell through to the account's own MON
 * and then to the trading-balance fee, and neither could pay. "Free actions for today
 * are used" is reserved for a free tier that is really at 0.
 */
export const SPONSORSHIP_PAUSED_MESSAGE =
  "Free network fees are paused for this account for now, and your wallet can't cover this one. Add MON or money to your trading balance, and you can keep going.";

/** The one gas refusal sentence for an account with `freeRemaining` free actions left. */
export function gasRefusalMessage(freeRemaining: number): string {
  return freeRemaining <= 0 ? FREE_ACTIONS_USED_MESSAGE : SPONSORSHIP_PAUSED_MESSAGE;
}

/**
 * The two ways forward the one refusal can carry (B2c, 2026-09-25): a swap into MON
 * needs no free action and no trading balance, and adding money is adding money.
 * This is the FULL set; a refusal names only the choices that are really live where
 * it is built — a swap into MON is funded from the exempt sponsorship pool, so when
 * that pool is itself spent, offering it would be a fake value, not a choice (D181
 * security review, finding 6). The client renders what arrives as actions, never a
 * disabled button.
 */
export const GAS_REFUSAL_CHOICES = ['swap-into-mon', 'add-money'] as const;

export const GAS_FEE_QUOTE_EXPIRED_MESSAGE =
  'The network fee quote expired, so nothing was sent. Try again.';

export const GAS_ENVELOPE_REFUSED_MESSAGE =
  "This action's network-fee settings are not the ones it was quoted, so nothing was sent. Try again.";

/** The account's last paid top-up has not landed yet: nothing more is advanced until it does. */
export const PRIOR_FEE_PENDING_MESSAGE =
  "Your last paid action hasn't confirmed on chain yet, so this one can't be sent. Try again in a moment.";

/** It never landed: no more is advanced for this account until its free actions return. */
export const PRIOR_FEE_NEVER_LANDED_MESSAGE =
  "Your last paid action never confirmed on chain, so network fees can't be advanced for this account again. Free actions still work when they renew.";

/**
 * A later paid top-up may only replace gas this account's operations have been seen to burn
 * since its last one (D172, scenario H), and this action needs more than that.
 */
export const TOP_UP_ABOVE_GAS_USED_MESSAGE =
  'Network fees for this account can only be advanced to replace what its last actions used, and this action needs more, so nothing was sent. Free actions still work when they renew.';

/** The operation, funded, would still not run on chain: nothing was paid or sent. */
export function operationWouldFailMessage(reason: string): string {
  return `This would fail on chain, so nothing was sent. The chain answered: ${reason}`;
}

export const GAS_FEE_UNPRICED_MESSAGE =
  "The network fee can't be priced right now, so nothing was sent. Try again in a moment.";

export type GasChargeRefusalReason =
  /**
   * The one gas refusal (rebuild, 2026-09-25): zero free actions left and nothing in
   * margin to pay with. Also used, uniformly, for the rarer case where an action is
   * charged (its free tier or its own MON budget is used) and its batch simply has no
   * fee leg attached yet — the client is expected to have quoted first and attached
   * one, so this is a defensive path, not a distinct user-facing reason.
   */
  | 'FREE_ACTIONS_USED'
  /** The batch carries a fee leg but the relayer has no fresh pricing for this sender. */
  | 'GAS_FEE_QUOTE_EXPIRED'
  /** The MON/USDC mid or the base fee could not be read. */
  | 'GAS_FEE_UNPRICED'
  /**
   * A charged operation not signed the way the relayer will fund: a gas limit that is not
   * its fresh plan, a max fee outside 1.2x to 3x the base fee, a tip under 1 gwei, or a
   * prefund above 0.45 MON. (Named GAS_ENVELOPE_TOO_LARGE for one round, before "under"
   * was refused too.)
   */
  | 'GAS_ENVELOPE_REFUSED'
  /** The fee leg is not the one the relayer computed for this operation. */
  | 'FEE_LEG_MISMATCH'
  /**
   * This account's last paid top-up has not been seen to land (its operation's
   * `UserOperationEvent`), so no second one is advanced (D172, the durable backstop).
   */
  | 'PRIOR_FEE_UNCONFIRMED'
  /**
   * After an account's first paid top-up, a later one only replaces gas its operations have
   * been seen to burn since the last, and this one would need more (D172, scenario H).
   */
  | 'TOP_UP_ABOVE_GAS_USED';

/**
 * Why an action is charged: its free actions are used, or (F4) free actions remain but the
 * account's own sponsorship budget cannot fund this action right now.
 */
export type GasChargeCause = 'free-actions-used' | 'sponsorship-budget-used';

/** The JSON-RPC error's `data` for every refusal above. No amounts in wei; no hex. */
export interface GasChargeRefusalData {
  readonly reason: GasChargeRefusalReason;
  /** For FREE_ACTIONS_USED: the live ways forward the client renders as actions (B2c).
   *  Only choices that are really live are named: 'swap-into-mon' is included only
   *  while the exempt pool that would sponsor that swap has room (D181 review, F6 —
   *  a way out that would itself be refused is a fake value, not a choice). */
  readonly choices?: readonly ('swap-into-mon' | 'add-money')[];
  /** For FREE_ACTIONS_USED refusals converted from an internal budget bound: when
   *  that bound frees up, epoch ms — kept so the client can offer a real time to
   *  wait, since "add money" retries into the same shared ceiling (F6). */
  readonly resetsAt?: number;
  /** For GAS_FEE_REQUIRED: which of the two reasons the action is charged. */
  readonly chargedBecause?: GasChargeCause;
  readonly freeActions?: {
    readonly limit: number;
    readonly used: number;
    readonly remaining: number;
    /** Epoch ms. */
    readonly resetsAt?: number;
  };
  /** For FEE_LEG_MISMATCH: what the relayer computed, so the client can rebuild once. */
  readonly expectedFee?: { readonly token: string; readonly amount: string };
  /**
   * For GAS_ENVELOPE_REFUSED: which fields were wrong, and what the relayer will fund, so
   * the client can re-sign: exactly `plan`, a max fee from `maxFeePerGasFloor` to
   * `maxFeePerGasCeiling`, a tip of at least `minPriorityFeePerGas`. Quantities as 0x hex,
   * as the bundler RPC writes them.
   */
  readonly envelope?: {
    readonly outside: ReadonlyArray<
      | 'callGasLimit'
      | 'verificationGasLimit'
      | 'preVerificationGas'
      | 'maxFeePerGas'
      | 'maxPriorityFeePerGas'
      | 'prefund'
    >;
    readonly plan?: {
      readonly callGasLimit: string;
      readonly verificationGasLimit: string;
      readonly preVerificationGas: string;
    };
    readonly maxFeePerGasFloor?: string;
    readonly maxFeePerGasCeiling?: string;
    readonly minPriorityFeePerGas?: string;
  };
}

const REFUSAL_REASONS: readonly GasChargeRefusalReason[] = [
  'FREE_ACTIONS_USED',
  'GAS_FEE_QUOTE_EXPIRED',
  'GAS_FEE_UNPRICED',
  'GAS_ENVELOPE_REFUSED',
  'FEE_LEG_MISMATCH',
  'PRIOR_FEE_UNCONFIRMED',
  'TOP_UP_ABOVE_GAS_USED',
];

export function isGasChargeRefusalData(value: unknown): value is GasChargeRefusalData {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return REFUSAL_REASONS.includes(v.reason as GasChargeRefusalReason);
}
