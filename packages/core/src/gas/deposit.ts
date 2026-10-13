import { encodeFunctionData, type Address, type Hex, type PublicClient } from 'viem';
import { entryPoint08Abi } from 'viem/account-abstraction';
import { ENTRY_POINT_V08 } from './delegate.js';

/**
 * Gas funding via EntryPoint deposits.
 *
 * There is no paymaster. Each account's user operations are paid from that account's
 * own deposit inside the EntryPoint, and the relayer tops that deposit up from its own
 * MON. Rationale (owner decision, 2026-09-02): no prepaid vendor balance, no new
 * contracts, and no vendor dependency for demo continuity — Pimlico is used as a
 * bundler only, on its free tier.
 *
 * ## Verified on Monad mainnet, 2026-09-02
 *
 * `eth_simulateV1`, one block, six sequential calls, with the gate account's code
 * overridden to a real 7702 delegation and its **own MON balance forced to zero**:
 *
 * | step | result |
 * |---|---|
 * | EOA own balance before | 0 MON |
 * | `EntryPoint.depositTo(EOA)` with 0.3 MON from the relayer | ok |
 * | `EntryPoint.balanceOf(EOA)` | 0.3 MON |
 * | `EntryPoint.handleOps([signedUserOp], relayer)` — **no paymaster** | ok |
 * | `EntryPoint.balanceOf(EOA)` | 0.2976811932 MON |
 * | EOA own balance after | 0 MON |
 *
 * So a signed user operation from an account holding no MON executes, paid entirely
 * from the deposit, and the account's own balance is never touched. One operation
 * consumed 0.0023188 MON.
 *
 * That last point also settles Monad's reserve rule: it bites only on a transaction
 * that **reduces** a delegated account's balance below 10 MON, and here the balance
 * does not change at all. Confirmed in the same simulation.
 *
 * ## Why the thresholds are not the ones first proposed
 *
 * The EntryPoint requires the deposit to cover the whole **prefund reservation** —
 * `(callGasLimit + verificationGasLimit + preVerificationGas) * maxFeePerGas` — at
 * validation time, not just the gas actually burned. At Monad's 102 gwei:
 *
 * | operation | total gas | prefund at 1x | at 2x |
 * |---|---|---|---|
 * | one order | 410,000 | 0.042 MON | 0.084 MON |
 * | deposit + order batch | 560,000 | 0.057 MON | 0.114 MON |
 *
 * The first proposal — `MIN_DEPOSIT` 0.02 MON, `TOPUP` 0.05 MON — is below all of
 * these, and was measured failing with `FailedOp(0, "AA21 didn't pay prefund")`
 * against a 0.05 MON deposit. The values below are the smallest that clear a
 * deposit-plus-order batch at twice the current gas price. See DECISIONS.md D31.
 */

/**
 * The two "total gas" figures in the table above, named so code can use them.
 *
 * Each is a whole operation's `callGasLimit + verificationGasLimit + preVerificationGas`,
 * the sum the prefund formula multiplies by `maxFeePerGas`. Neither is a call gas limit
 * on its own. `opGas.ts` floors an operation's total at 1.5x these.
 */
export const MEASURED_TOTAL_GAS_ONE_ORDER = 410_000n;
export const MEASURED_TOTAL_GAS_DEPOSIT_AND_ORDER = 560_000n;

/**
 * The measured cost of one user operation, from the M0 gate on 2026-09-02.
 *
 * Two operations charged 0.1432099984 MON against the deposit — 0.0866 MON for the
 * first (771,986 gas at 112 gwei, carrying the 7702 authorization plus a permit, a
 * deposit and an order) and 0.0451 for the cancel. That averages 0.0716049992 MON,
 * recorded here rounded to 0.0716.
 *
 * **This is the one number to re-measure.** Every threshold below is derived from it,
 * and `deposit.test.ts` asserts the derivations still hold, so a fresh measurement
 * means changing this constant and reading what the test says about the rest.
 */
export const GAS_PER_OP_WEI = 71_600_000_000_000_000n; // 0.0716 MON

/**
 * Top up when an account's EntryPoint deposit falls below this.
 * ~2 operations of headroom, and above the largest prefund a batch can reserve.
 */
export const MIN_ENTRYPOINT_DEPOSIT_WEI = 150_000_000_000_000_000n; // 0.15 MON

/** How much to add when topping up. ~4 operations. */
export const ENTRYPOINT_TOPUP_WEI = 300_000_000_000_000_000n; // 0.30 MON

/*
 * How much one address may draw is no longer a constant here. It is a set of rolling
 * budgets derived from `PREFUND_MAX_MON` in `chain/caps.ts`, and `decideTopUp` is handed
 * the headroom those budgets leave (`prefundHeadroom` in `prefundBudget.ts`). The lifetime
 * ceiling that used to live here refused an account forever after ~28 actions (B7,
 * 2026-09-23).
 */

export type TopUpRefusal = 'NOT_NEEDED' | 'BUDGET_EXHAUSTED' | 'FLOAT_TOO_LOW';

export class TopUpRefused extends Error {
  constructor(
    readonly reason: TopUpRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'TopUpRefused';
  }
}

export interface DepositState {
  readonly account: Address;
  readonly deposit: bigint;
  readonly needsTopUp: boolean;
}

export async function readEntryPointDeposit(
  client: PublicClient,
  account: Address,
  entryPoint: Address = ENTRY_POINT_V08,
): Promise<DepositState> {
  const deposit = (await client.readContract({
    address: entryPoint,
    abi: entryPoint08Abi,
    functionName: 'balanceOf',
    args: [account],
  })) as bigint;
  return { account, deposit, needsTopUp: deposit < MIN_ENTRYPOINT_DEPOSIT_WEI };
}

/** `EntryPoint.depositTo(account)`, to be sent with `value` = the top-up amount. */
export function buildDepositTo(account: Address): { to: Address; data: Hex; value: bigint } {
  return {
    to: ENTRY_POINT_V08,
    data: encodeFunctionData({
      abi: entryPoint08Abi,
      functionName: 'depositTo',
      args: [account],
    }),
    value: ENTRYPOINT_TOPUP_WEI,
  };
}

export interface TopUpDecision {
  readonly topUp: boolean;
  readonly amount: bigint;
  /** Why not, as a code. Callers branch on this, never on `reason`'s wording. */
  readonly refusal?: TopUpRefusal;
  /** Operator-facing. Never shown to a user; the relayer writes its own copy for that. */
  readonly reason?: string;
}

/**
 * Decide whether to top an account up, and by how much.
 *
 * `budgetRemaining` is what the rolling budgets still allow this address right now: the
 * smallest of its daily, its hourly and the all-addresses hourly remainder. The last
 * top-up before a budget runs out is trimmed to fit rather than refused. A partial top-up
 * still lets the account trade, and the budget is still respected exactly.
 */
export function decideTopUp(input: {
  readonly deposit: bigint;
  readonly budgetRemaining: bigint;
  readonly relayerBalance: bigint;
  readonly minDeposit?: bigint;
  readonly topUpAmount?: bigint;
}): TopUpDecision {
  const minDeposit = input.minDeposit ?? MIN_ENTRYPOINT_DEPOSIT_WEI;
  const topUpAmount = input.topUpAmount ?? ENTRYPOINT_TOPUP_WEI;

  if (input.deposit >= minDeposit) {
    return {
      topUp: false,
      amount: 0n,
      refusal: 'NOT_NEEDED',
      reason: 'deposit is already above the minimum',
    };
  }

  if (input.budgetRemaining <= 0n) {
    return {
      topUp: false,
      amount: 0n,
      refusal: 'BUDGET_EXHAUSTED',
      reason: 'the sponsorship budget has nothing left for this address right now',
    };
  }

  const amount = topUpAmount < input.budgetRemaining ? topUpAmount : input.budgetRemaining;
  if (input.relayerBalance < amount) {
    return {
      topUp: false,
      amount: 0n,
      refusal: 'FLOAT_TOO_LOW',
      reason: 'relayer float is too low to top up',
    };
  }
  return { topUp: true, amount };
}

/**
 * The prefund a user operation must have on deposit before the EntryPoint will run it.
 * Exposed so the relayer can refuse early with a readable reason rather than letting
 * the bundler return `AA21 didn't pay prefund`.
 */
export function requiredPrefund(op: {
  readonly callGasLimit: bigint;
  readonly verificationGasLimit: bigint;
  readonly preVerificationGas: bigint;
  readonly maxFeePerGas: bigint;
}): bigint {
  return (op.callGasLimit + op.verificationGasLimit + op.preVerificationGas) * op.maxFeePerGas;
}
