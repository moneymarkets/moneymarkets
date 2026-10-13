import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { entryPoint08Abi, getUserOperationHash } from 'viem/account-abstraction';
import { ENTRY_POINT_V08, MONAD_DELEGATED_RESERVE_WEI, toUserOperationV08 } from '@tradepro/core';

/** Monad's delegated-account reserve, judged on the ending balance (verified 2026-09-25). */
const DELEGATED_RESERVE = MONAD_DELEGATED_RESERVE_WEI;

/**
 * EntryPoint v0.8, as far as the relayer's paid path can reach it, for tests.
 *
 * It refuses an operation the ways the reviewer's reproductions found: AA25 for a nonce that
 * is not the next one, AA23 when `validateUserOp` would run out of verification gas, AA21
 * when the deposit is short of the prefund of the limits and max fee as SIGNED. The first
 * version of these tests used a bundler that accepted everything, and later one that knew
 * only AA21 and AA25; each hid a way to be topped up for an operation that could never run.
 *
 * `VALIDATION_GAS_USED` is the recorded figure: a trace of the second 2026-09-24 profiling
 * bundle shows the account's own `validateUserOp` using 7,314 gas (`opGas.ts`).
 *
 * Answers two ways, both from the same rules: `bundle` for an operation forwarded to a
 * bundler (it runs, mutating state), and `simulate` for the relayer's own `eth_simulateV1`
 * of deposit-then-`handleOps` (no state kept).
 */

export const VALIDATION_GAS_USED = 7_314n;
const LOW64 = (1n << 64n) - 1n;
const LOW128 = (1n << 128n) - 1n;

interface Envelope {
  readonly sender: Address;
  readonly nonce: bigint;
  readonly callGasLimit: bigint;
  readonly verificationGasLimit: bigint;
  readonly preVerificationGas: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
}

export class FakeEntryPoint {
  readonly deposits = new Map<string, bigint>();
  /** `${sender}:${nonceKey}` -> the next sequence the EntryPoint expects. */
  readonly nonces = new Map<string, bigint>();
  defaultDeposit = 0n;
  /** What an executed operation draws from its deposit. Zero unless a test models it. */
  chargeOnExecute = 0n;
  /** This account's `withdrawTo` lands before each of its own bundles: the race, won every time. */
  frontRunBy: string | undefined;
  /** Every `eth_simulateV1` of deposit-then-handleOps the relayer asked for. */
  readonly simulations: Array<{ topUp: bigint; outcome: string }> = [];
  /** Force the next simulations to report this FailedOp reason, whatever the operation. */
  simulateFailure: string | undefined;
  /**
   * Validation passes but the operation's own call reverts with these bytes: the EntryPoint
   * emits `UserOperationRevertReason` and a `UserOperationEvent` with success false. Gas is
   * charged and the nonce used, but the batch, fee leg included, never ran.
   */
  simulateInnerRevert: Hex | undefined;

  /** The chain's clock, epoch seconds. Tests set it from their own NOW. */
  nowSeconds = 0n;
  /** How long after the relayer's checks a bundle actually executes. */
  bundleDelaySeconds = 2n;
  /**
   * The operation's own call stops working after this time: a permit deadline, or one
   * inside a route the policy cannot read. Past it, a simulation shows the call reverting
   * and a bundler refuses to include the operation.
   */
  readonly callWorksUntil = new Map<string, bigint>();
  /** A node that ignores `blockOverrides.time` and simulates "now". */
  ignoreTimeOverride = false;
  /** The `blockOverrides.time` of the last simulation asked for, if any. */
  lastRequestedTime: bigint | undefined;
  /** Take bundles but do not mine them until `mineHeld()`: an operation still pending. */
  holdBundles = false;
  readonly #held: Array<Record<string, string>> = [];
  blockNumber = 107_310_277n;
  /** Every UserOperationEvent this chain has mined, for `eth_getLogs`. */
  readonly events: Array<{
    block: bigint;
    userOpHash: Hex;
    sender: Address;
    nonce: bigint;
    success: boolean;
    /** What the run drew from the deposit: `chargeOnExecute` at the time. */
    actualGasCost?: bigint;
  }> = [];

  deposit(sender: string): bigint {
    return this.deposits.get(sender.toLowerCase()) ?? this.defaultDeposit;
  }

  /**
   * Each account's native MON (B2a). Senders default to zero — the product is
   * gasless — and a test of the own-MON lane sets a balance explicitly. Verified on
   * mainnet 2026-09-25: the delegate's `_payPrefund` pays `missingAccountFunds`
   * (prefund minus deposit) from the account's own balance, so a funded wallet does
   * NOT AA21 just because its EntryPoint deposit is short.
   */
  readonly nativeBalances = new Map<string, bigint>();

  native(sender: string): bigint {
    return this.nativeBalances.get(sender.toLowerCase()) ?? 0n;
  }

  nonceFor(sender: string, key: bigint): bigint {
    return (key << 64n) | (this.nonces.get(`${sender.toLowerCase()}:${key}`) ?? 0n);
  }

  /** The FailedOp reason the EntryPoint would give, or undefined when it would run. */
  #refusal(op: Envelope, deposit: bigint): string | undefined {
    const expected = this.nonces.get(`${op.sender.toLowerCase()}:${op.nonce >> 64n}`) ?? 0n;
    if ((op.nonce & LOW64) !== expected) return 'AA25 invalid account nonce';
    if (op.verificationGasLimit < VALIDATION_GAS_USED) return 'AA23 reverted';
    const prefund =
      (op.callGasLimit + op.verificationGasLimit + op.preVerificationGas) * op.maxFeePerGas;
    // The verified v0.8 model: the deposit pays first, and the account's own native
    // balance pays `missingAccountFunds` — but a delegated account (every sender in
    // these harnesses) must END the transaction at or above Monad's 10 MON reserve,
    // so only the balance ABOVE the reserve can pay (D181 review, finding 7: without
    // this term, an account with 5 MON passed here and failed on chain).
    const spendable = this.native(op.sender) > DELEGATED_RESERVE ? this.native(op.sender) - DELEGATED_RESERVE : 0n;
    if (deposit + spendable < prefund) return "AA21 didn't pay prefund";
    return undefined;
  }

  /**
   * These senders' operations pass every simulation but revert inside when mined (state the
   * sender changed in between, e.g. its own margin emptied so the fee leg's withdraw fails):
   * gas charged, nonce used, `UserOperationEvent` with success false, and nothing in the
   * batch, fee leg included, ran.
   */
  readonly landsRevertedFor = new Set<string>();

  #run(op: Envelope, userOpHash: Hex): void {
    this.nonces.set(`${op.sender.toLowerCase()}:${op.nonce >> 64n}`, (op.nonce & LOW64) + 1n);
    this.deposits.set(op.sender.toLowerCase(), this.deposit(op.sender) - this.chargeOnExecute);
    this.blockNumber += 1n;
    const success = !this.landsRevertedFor.has(op.sender.toLowerCase());
    this.events.push({
      block: this.blockNumber,
      userOpHash,
      sender: op.sender,
      nonce: op.nonce,
      success,
      actualGasCost: this.chargeOnExecute,
    });
  }

  #envelopeOf(rpc: Record<string, string>): Envelope {
    return {
      sender: rpc.sender as Address,
      nonce: BigInt(rpc.nonce!),
      callGasLimit: BigInt(rpc.callGasLimit!),
      verificationGasLimit: BigInt(rpc.verificationGasLimit!),
      preVerificationGas: BigInt(rpc.preVerificationGas!),
      maxFeePerGas: BigInt(rpc.maxFeePerGas!),
      maxPriorityFeePerGas: BigInt(rpc.maxPriorityFeePerGas!),
    };
  }

  #hashOf(rpc: Record<string, string>, op: Envelope): Hex {
    return getUserOperationHash({
      chainId: 143,
      entryPointAddress: ENTRY_POINT_V08,
      entryPointVersion: '0.8',
      // The production conversion: a first operation's hash covers its 7702 initCode, as
      // the EntryPoint's does (D191).
      userOperation: { ...toUserOperationV08(rpc as never), ...op },
    });
  }

  /**
   * A bundler taking an operation in its RPC form, `bundleDelaySeconds` after the relayer's
   * checks: runs it (a `UserOperationEvent` at the next block), holds it, or refuses it
   * as the EntryPoint or the bundler's own simulation would. A refused operation never
   * mines: no event, no nonce used.
   */
  bundle(rpc: Record<string, string>): { result: string } | { error: { code: number; message: string } } {
    const op = this.#envelopeOf(rpc);
    if (this.frontRunBy === op.sender.toLowerCase()) this.deposits.set(op.sender.toLowerCase(), 0n);
    const refusal = this.#refusal(op, this.deposit(op.sender));
    if (refusal) {
      return { error: { code: -32500, message: `UserOperation reverted during simulation with reason: ${refusal}` } };
    }
    const until = this.callWorksUntil.get(op.sender.toLowerCase());
    if (until !== undefined && this.nowSeconds + this.bundleDelaySeconds > until) {
      return { error: { code: -32521, message: 'UserOperation reverted during execution phase' } };
    }
    if (this.holdBundles) {
      this.#held.push(rpc);
      return { result: this.#hashOf(rpc, op) };
    }
    this.#run(op, this.#hashOf(rpc, op));
    return { result: this.#hashOf(rpc, op) };
  }

  /** Mine every held operation that can still run. */
  mineHeld(): void {
    for (const rpc of this.#held.splice(0)) {
      const op = this.#envelopeOf(rpc);
      if (!this.#refusal(op, this.deposit(op.sender))) this.#run(op, this.#hashOf(rpc, op));
    }
  }

  /** `eth_getLogs` for UserOperationEvent, filtered by userOpHash topic and block range. */
  logs(params: unknown[]): { result: unknown } {
    const [filter] = params as [{ topics: Hex[]; fromBlock: Hex; toBlock: Hex }];
    const from = BigInt(filter.fromBlock);
    const to = BigInt(filter.toBlock);
    const want = filter.topics[1]?.toLowerCase();
    return {
      result: this.events
        .filter((e) => e.block >= from && e.block <= to && (!want || e.userOpHash.toLowerCase() === want))
        .map((e) => ({
          address: ENTRY_POINT_V08,
          topics: encodeEventTopics({
            abi: entryPoint08Abi,
            eventName: 'UserOperationEvent',
            args: { userOpHash: e.userOpHash, sender: e.sender, paymaster: zeroAddress },
          }),
          data: encodeAbiParameters(
            [{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }],
            [e.nonce, e.success, e.actualGasCost ?? 0n, 0n],
          ),
          blockNumber: `0x${e.block.toString(16)}`,
          transactionHash: `0x${e.block.toString(16).padStart(64, 'c')}`,
        })),
    };
  }

  /**
   * `eth_simulateV1` of `[EntryPoint.depositTo(sender){value}, EntryPoint.handleOps([op], b)]`
   * in one block: the relayer's own check that its top-up buys a real run. Nothing is kept.
   */
  simulate(params: unknown[]): { result: unknown } | { error: { code: number; message: string } } {
    const [{ blockStateCalls }] = params as [
      {
        blockStateCalls: Array<{ blockOverrides?: { time?: Hex }; calls: Array<{ data: Hex; value?: Hex }> }>;
      },
    ];
    const calls = blockStateCalls[0]?.calls ?? [];
    const requested = blockStateCalls[0]?.blockOverrides?.time;
    this.lastRequestedTime = requested === undefined ? undefined : BigInt(requested);
    const time = requested !== undefined && !this.ignoreTimeOverride ? BigInt(requested) : this.nowSeconds;
    const timestamp = `0x${time.toString(16)}`;
    if (calls.length !== 2) return { error: { code: -32602, message: 'expected deposit then handleOps' } };
    const deposit = decodeFunctionData({ abi: entryPoint08Abi, data: calls[0]!.data });
    const handle = decodeFunctionData({ abi: entryPoint08Abi, data: calls[1]!.data });
    if (deposit.functionName !== 'depositTo' || handle.functionName !== 'handleOps') {
      return { error: { code: -32602, message: 'expected deposit then handleOps' } };
    }
    const [account] = deposit.args as unknown as [Address];
    const topUp = BigInt(calls[0]!.value ?? '0x0');
    const [ops] = handle.args as unknown as [
      ReadonlyArray<{
        sender: Address;
        nonce: bigint;
        callData: Hex;
        accountGasLimits: Hex;
        preVerificationGas: bigint;
        gasFees: Hex;
        signature: Hex;
      }>,
    ];
    const packed = ops[0]!;
    const op: Envelope = {
      sender: packed.sender,
      nonce: packed.nonce,
      verificationGasLimit: BigInt(packed.accountGasLimits) >> 128n,
      callGasLimit: BigInt(packed.accountGasLimits) & LOW128,
      preVerificationGas: packed.preVerificationGas,
      maxPriorityFeePerGas: BigInt(packed.gasFees) >> 128n,
      maxFeePerGas: BigInt(packed.gasFees) & LOW128,
    };
    const after = this.deposit(account) + topUp;
    const refusal = this.simulateFailure ?? this.#refusal(op, after);
    this.simulations.push({ topUp, outcome: refusal ?? 'ran' });
    if (refusal) {
      return {
        result: [
          {
            timestamp,
            calls: [
              { status: '0x1', returnData: '0x', logs: [] },
              {
                status: '0x0',
                returnData: encodeErrorResult({ abi: entryPoint08Abi, errorName: 'FailedOp', args: [0n, refusal] }),
                logs: [],
              },
            ],
          },
        ],
      };
    }
    const userOpHash = getUserOperationHash({
      chainId: 143,
      entryPointAddress: ENTRY_POINT_V08,
      entryPointVersion: '0.8',
      userOperation: {
        sender: packed.sender,
        nonce: packed.nonce,
        callData: packed.callData,
        callGasLimit: op.callGasLimit,
        verificationGasLimit: op.verificationGasLimit,
        preVerificationGas: op.preVerificationGas,
        maxFeePerGas: op.maxFeePerGas,
        maxPriorityFeePerGas: op.maxPriorityFeePerGas,
        signature: packed.signature,
      },
    });
    const gasUsed = 466_805n; // the recorded order (0x1111dda6…)
    // Past its deadline the call reverts: `Error("expired")`, as a permit would answer.
    const expired =
      (this.callWorksUntil.get(packed.sender.toLowerCase()) ?? time) < time
        ? encodeErrorResult({ abi: [{ type: 'error', name: 'Error', inputs: [{ name: 'reason', type: 'string' }] }], errorName: 'Error', args: ['expired'] })
        : undefined;
    const inner = this.simulateInnerRevert ?? expired;
    const logs = [
      ...(inner
        ? [
            {
              address: ENTRY_POINT_V08,
              topics: encodeEventTopics({
                abi: entryPoint08Abi,
                eventName: 'UserOperationRevertReason',
                args: { userOpHash, sender: packed.sender },
              }),
              data: encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes' }], [packed.nonce, inner]),
            },
          ]
        : []),
      {
        address: ENTRY_POINT_V08,
        topics: encodeEventTopics({
          abi: entryPoint08Abi,
          eventName: 'UserOperationEvent',
          args: { userOpHash, sender: packed.sender, paymaster: zeroAddress },
        }),
        data: encodeAbiParameters(
          [{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }],
          [packed.nonce, inner === undefined, gasUsed * op.maxPriorityFeePerGas, gasUsed],
        ),
      },
    ];
    this.simulations[this.simulations.length - 1] = { topUp, outcome: inner ? 'call reverted' : 'ran' };
    return {
      result: [
        {
          timestamp,
          calls: [
            { status: '0x1', returnData: '0x', logs: [] },
            { status: '0x1', returnData: '0x', logs },
          ],
        },
      ],
    };
  }
}
