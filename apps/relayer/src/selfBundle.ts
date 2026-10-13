import {
  decodeErrorResult,
  decodeEventLog,
  encodeEventTopics,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  toFunctionSelector,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
  type PrivateKeyAccount,
  type PublicClient,
} from 'viem';
import { entryPoint08Abi, toPackedUserOperation } from 'viem/account-abstraction';
import { recoverAuthorizationAddress } from 'viem/utils';
import { z } from 'zod';
import {
  assertMainnetAllowed,
  delegationCodeFor,
  ENTRY_POINT_V08,
  isEip7702Marker,
  kuruDetailFor,
  MAX_CALL_GAS_LIMIT,
  readModeGate,
  SIMPLE_7702_DELEGATE,
  toUserOperationV08,
  type ChainMode,
  type RpcUserOperationV08,
} from '@tradepro/core';
import type { RelayerDb, SelfBundleRefusal } from './db.js';
import { loadRelayerAccount } from './keystore.js';
import type { PrefundLogger, SerialLock } from './prefund.js';

/**
 * Self-bundling: the relayer submits `EntryPoint.handleOps([op], relayer)` from its own
 * key instead of queueing the operation in Pimlico's bundler (speed pass, 2026-09-24).
 *
 * ## What the relayer signs, and what it does not
 *
 * It signs one transaction: `handleOps` on EntryPoint v0.8, value zero, carrying exactly
 * one user operation that its sender signed and this relayer has already verified, with
 * the beneficiary set to the relayer's own address. The target, the value, the function
 * and the beneficiary are all fixed inside `liveBundleExecutor`, the only code here that
 * touches the key. It never signs a user operation and never chooses what one does. What
 * the operation executes is decided by its sender's signature and bounded by the same
 * sponsor policy and caps as before, which run before anything here.
 *
 * ## Why the relayer cannot lose money on a successful bundle
 *
 * On Monad a transaction is charged its whole gas LIMIT, not the gas it uses. The five
 * profiling receipts from 2026-09-24 all report `gasUsed == gas`, and Pimlico's balance
 * moved by exactly `actualGasCost - gas * effectiveGasPrice` in each block (see
 * `fixtures/selfBundle.mainnet.json`). The EntryPoint repays the beneficiary the
 * operation's `actualGasCost`, which is `actualGasUsed * userOpGasPrice`.
 *
 * The relayer's transaction carries the operation's own `maxFeePerGas` and
 * `maxPriorityFeePerGas`. The EntryPoint prices the operation as
 * `min(maxFee, priority + basefee)`, which is exactly EIP-1559's effective price for the
 * relayer's transaction in the same block. So the two prices are the same number, and:
 *
 *     net = actualGasCost - gasLimit * effectiveGasPrice
 *         = (actualGasUsed - gasLimit) * price
 *
 * The relayer sends only when a simulation of this exact bundle shows
 * `actualGasUsed >= gasLimit`, and only inside a fee band that bounds what one bundle can
 * cost. What remains is state changing between the simulation and the block (a book
 * moving, the sender invalidating its own operation, or a copy of it lifted from our
 * pending transaction landing first).
 *
 * ## Self-bundling's own allowance, not the sender's sponsorship budget
 *
 * Every bundle reserves its worst case against self-bundling's own allowance
 * (`RelayerDb.reserveSelfBundle`), never against the sponsorship budgets that pay for
 * top-ups (2026-09-24). Sharing them meant an account that needed two ordinary top-ups in
 * one hour had no room left for a bundle's worst case, and every order it placed for the
 * rest of that hour went to Pimlico. The allowance has three bounds, all read from the
 * ledger inside the lock:
 *
 *   - `SELF_BUNDLE_LOSS_LIMIT_WEI`: the rolling hour's losses plus the worst case of every
 *     bundle not yet settled;
 *   - `SELF_BUNDLE_MAX_IN_FLIGHT`: bundles reserved or sent and not yet settled;
 *   - the float alert line: no bundle whose worst case could take the relayer's balance,
 *     less everything it has sent and not settled, to or below the line `/v1/health`
 *     alerts on.
 *
 * A loss is recorded against the sender's address in the ledger for operators, and charged
 * to no one's sponsorship.
 *
 * ## Once a transaction may have gone out, the operation is never handed to Pimlico
 *
 * If it were, and our bundle landed first, Pimlico would answer AA25, the browser would
 * show a rejection, and the user would sign the order again. So a send with no clear answer
 * is treated as sent, and a bundle that reverts is answered as `submitted` with the receipt
 * looked for on chain by hash. Only a definite refusal before broadcast goes to Pimlico.
 *
 * ## The caller is answered on the hash; the lock is held until the bundle settles
 *
 * `submit` resolves with `submitted` the moment the node has taken the transaction (or it
 * may have), exactly as Pimlico answers `eth_sendUserOperation`: accepted, not mined. The
 * browser then asks for the receipt block by block, as it does for Pimlico. The bundle's
 * own receipt wait and its settlement carry on inside the relayer key's lock after that
 * answer, as before, so the key still has one transaction in flight at a time and one
 * nonce manager (F5). Answering early changes when the caller hears, and nothing about
 * whether an operation can ever reach Pimlico after broadcast: it cannot.
 */

/** Gas added over `eth_estimateGas(handleOps)`. See `SelfBundler` for the arithmetic. */
export const SELF_BUNDLE_GAS_SLACK = 25_000n;

/**
 * How long a bundle's own receipt wait may hold the lock: fifty 400 ms blocks. The caller
 * has already been answered by then; this bounds the settlement, not the answer.
 */
export const SELF_BUNDLE_RECEIPT_TIMEOUT_MS = 20_000;
export const SELF_BUNDLE_RECEIPT_POLL_MS = 150;

/** An inner-call read that has not answered by now goes to Pimlico instead. */
export const INNER_SIMULATION_TIMEOUT_MS = 2_500;

/**
 * Every read made while holding the relayer key's lock gives up after this. viem's own
 * default is 10 s with three retries, and a slow RPC would otherwise hold the lock, and
 * every top-up and CCTP mint queued behind it, for most of a minute.
 */
export const LOCKED_READ_TIMEOUT_MS = 3_000;

/**
 * Self-bundling stops once the rolling hour's self-bundle losses, plus the worst case of
 * every bundle sent and not yet settled, reach 0.1 MON. Everything then goes to Pimlico.
 *
 * About two griefed bundles at the browser's usual price (a reverted ~490,000-gas bundle
 * costs ~0.051 MON at an effective 104 gwei). The check runs before a bundle reserves, so
 * the bundle that crosses it adds at most its own worst case, which
 * `SELF_BUNDLE_MAX_WORST_CASE_WEI` caps at 0.2 MON. The true bound is therefore just under
 * 0.3 MON of self-bundle losses in any rolling hour, whatever a signer chooses; ~0.22 MON
 * for an order at the browser's usual fees (worst case ~0.119 MON). Persisted in the
 * ledger, so a restart does not reset it. A daily latch that needs an operator to re-enable
 * is a separate owner decision, not built here.
 *
 * Self-bundling's own bound. Since 2026-09-24 it draws on no sponsorship budget, and no
 * sponsorship budget draws on it (`RelayerDb.reserveSelfBundle`).
 */
export const SELF_BUNDLE_LOSS_LIMIT_WEI = 100_000_000_000_000_000n;

/**
 * The largest worst case (gas limit x max fee) one bundle may carry: 0.2 MON. Anything
 * larger goes to Pimlico, unrefused.
 *
 * Without it, one bundle's worst case was bounded only by the call gas ceiling and the fee
 * ceiling: a 2,000,000 call gas limit at 300 gwei derives (as the batch row below does) to
 * a ~2,177,000-gas `handleOps`, about 0.65 MON, all of it lost if the sender empties its
 * deposit ahead of the bundle (review, 2026-09-24, which put it at ~0.61 MON). Until
 * self-bundles left the sponsorship budgets, their 0.5 MON per address hour capped this by
 * accident.
 *
 * Sized from the two real shapes, at the browser's 244 gwei (2x viem's estimate at Monad's
 * 100 gwei base fee):
 *
 *   | shape                                | handleOps gas limit | at 244 gwei | at 300 gwei |
 *   | one market order                     | 485,000 - 489,124   | 0.119 MON   | 0.147 MON   |
 *   | permit + deposit + market buy batch  | ~684,800 (derived)  | 0.167 MON   | 0.205 MON   |
 *
 * The order rows come from the recorded bundles: the 460,000 estimate the tests pin and the
 * live dry run's 464,124, plus `SELF_BUNDLE_GAS_SLACK`. The batch row is DERIVED, not
 * measured: the recorded inner-call estimate for that batch (395,685,
 * `fixtures/selfBundle.mainnet.json`) through `planUserOperationGas` gives a 514,391 call
 * gas limit, and the EntryPoint must hand the call 64/63 of that, on top of the order's own
 * measured overhead and 800 more bytes of call data at 16 gas each. 0.2 MON admits every
 * order anywhere in the fee band and the batch at the browser's usual price, 17% above its
 * derived figure. A batch signed at more than ~290 gwei goes to Pimlico. The 0.15 MON first
 * suggested would have sent every funding batch there.
 */
export const SELF_BUNDLE_MAX_WORST_CASE_WEI = 200_000_000_000_000_000n;

/**
 * At most one self-bundle reserved or sent and not yet settled at a time. Another goes to
 * Pimlico, unrefused, until the first settles.
 *
 * This is the guard against a nonce collision, stated rather than left to the loss limit.
 * A bundle holds the relayer key's lock until it settles, so in normal flow the next one
 * never sees it unsettled and this costs nothing. The only way one stays unsettled is a
 * receipt wait that runs out while the transaction is still unmined. The next bundle would
 * then read the relayer's nonce with `eth_getTransactionCount(.., 'pending')`, and on Monad
 * "the `pending` tag is supported but behaves the same as `latest`" (docs.monad.xyz,
 * reference/rpc-differences, read 2026-09-24): it would get the stuck transaction's nonce
 * again, and its send would be answered "already known" or "replacement", which the send
 * classifier must treat as sent. The loss limit happens to stop that at the browser's fees,
 * but not at the band's 120 gwei floor. Counted from the ledger, in the loss limit's own
 * rolling hour, so a row a stopped process left behind counts too.
 */
export const SELF_BUNDLE_MAX_IN_FLIGHT = 1;

/**
 * The fee band a bundle must fall in to be self-bundled. Outside it the operation goes to
 * Pimlico, unrefused: these protect the relayer key, not the order.
 *
 * Floor, 1.2x the current base fee: Monad's base-fee controller rises by at most
 * exp(max_step_size) = exp(1/28), about 3.6%, per block (docs.monad.xyz, gas pricing), so
 * 1.2x stays includable through five consecutive maximal-rise blocks, about 2 s, several
 * times the one or two blocks a bundle takes. viem's own fee estimate (1.2x base plus the
 * tip) clears it. Below it, the relayer's transaction could sit unmined holding the key's
 * nonce, and every top-up, mint and bundle queues behind it: there is no fee-bump loop.
 *
 * Ceiling, 3x the current base fee: 300 gwei at Monad's 100 gwei floor. It admits the
 * browser's 244 gwei (2x viem's estimate) with room, and bounds what one griefed bundle
 * costs per gas: the relayer pays at most maxFee per gas, so ~0.147 MON for a 490,000-gas
 * bundle at the ceiling rather than whatever a signer chooses. The gas itself is bounded
 * by `SELF_BUNDLE_MAX_WORST_CASE_WEI`. Relative to the base fee, so it does not switch
 * self-bundling off if the base fee ever rises.
 *
 * Tip, at least 1 gwei: Monad orders transactions by total price (a priority gas auction).
 * rpc.monad.xyz suggested 2 gwei on 2026-09-24 and the browser signs 4. 1 gwei turns away
 * zero and dust tips while admitting anything built from the node's own suggestion.
 */
export const SELF_BUNDLE_MIN_FEE_OVER_BASE = { numerator: 6n, denominator: 5n } as const;
export const SELF_BUNDLE_MAX_FEE_OVER_BASE = 3n;
export const SELF_BUNDLE_MIN_PRIORITY_FEE_WEI = 1_000_000_000n;

/**
 * How long a sent bundle with no receipt is left alone before the sweep may release it.
 * Past this it is released only once the relayer's finalized nonce has moved past the
 * bundle's own (so it can never be included) and a receipt read still finds nothing.
 * Monad includes a transaction within a block or two (about a second); a minute is
 * sixty times that.
 */
export const UNSEEN_RELEASE_MS = 60_000;
/** How long a rate-limited send waits before asking whether the node took it anyway. */
export const RATE_LIMITED_RECHECK_MS = 1_000;

/** How often unsettled bundles are re-read, at most, and how many at a time. */
export const RECONCILE_EVERY_MS = 15_000;
const RECONCILE_BATCH = 5;
const HOUR = 3_600_000;

export const HANDLE_OPS_SELECTOR = toFunctionSelector(
  'handleOps((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes)[],address)',
);

type PackedUserOperation = ReturnType<typeof toPackedUserOperation>;

/** The one encoding of `handleOps` the relayer ever simulates or signs. */
export function handleOpsCalldata(op: PackedUserOperation, beneficiary: Address): Hex {
  return encodeFunctionData({
    abi: entryPoint08Abi,
    functionName: 'handleOps',
    args: [[op], beneficiary],
  });
}

/** The operation exactly as `verifyUserOperationSignature` hashed it, packed for the chain. */
export function packUserOperation(op: RpcUserOperationV08): PackedUserOperation {
  return toPackedUserOperation(toUserOperationV08(op));
}

// ---------------------------------------------------------------------------------------
// Revert decoding
// ---------------------------------------------------------------------------------------

/**
 * `Simple7702Account.executeBatch` wraps a failing call as `ExecuteError(index, inner)`.
 * Confirmed against the deployed delegate on 2026-09-24: a two-call batch whose second
 * call reverted with `InsufficientBalance` came back as `0x5a154675`, index 1, inner
 * `0xf4d678b8`. A single `execute` returns the target's revert data unwrapped.
 */
const ACCOUNT_ERRORS = parseAbi(['error ExecuteError(uint256 index, bytes innerError)']);
const SOLIDITY_ERRORS = parseAbi(['error Error(string reason)', 'error Panic(uint256 code)']);

export function unwrapAccountRevert(revertData: Hex | undefined): {
  readonly data: Hex | undefined;
  readonly callIndex?: number;
} {
  if (!revertData) return { data: undefined };
  try {
    // viem adds Error(string) and Panic(uint256) to any ABI it decodes errors with, so
    // the name is checked, not assumed.
    const decoded = decodeErrorResult({ abi: ACCOUNT_ERRORS, data: revertData });
    if (decoded.errorName !== 'ExecuteError') return { data: revertData };
    const [index, inner] = decoded.args as readonly [bigint, Hex];
    return { data: inner, callIndex: Number(index) };
  } catch {
    return { data: revertData };
  }
}

/**
 * The chain's reason in one line, for the JSON-RPC error message.
 *
 * The browser shows this line verbatim as its detail (the 2026-09-08 rule), and matches
 * the raw selector in it to recognise Kuru's pause, so the selector is kept even when the
 * name is known.
 */
export function describeInnerRevert(revertData: Hex | undefined): string {
  const { data, callIndex } = unwrapAccountRevert(revertData);
  const where = callIndex === undefined ? '' : ` (call ${callIndex + 1} of the batch)`;
  const lead = `This would fail on chain, so nothing was sent${where}.`;
  if (!data || data === '0x') return `${lead} The chain gave no reason.`;
  try {
    const decoded = decodeErrorResult({ abi: SOLIDITY_ERRORS, data });
    if (decoded.errorName === 'Error')
      return `${lead} The chain answered: “${String(decoded.args[0])}”`;
    return `${lead} The chain answered: Panic(${String(decoded.args[0])})`;
  } catch {
    /* not a Solidity string or panic: read it as Kuru's */
  }
  const kuru = kuruDetailFor(data);
  if (!kuru) return `${lead} The chain answered with ${data}.`;
  const selector = data.slice(0, 10);
  return kuru.includes(selector) ? `${lead} ${kuru}` : `${lead} ${kuru} (${selector})`;
}

/** `FailedOp(0, "AA25 invalid account nonce")` and its kin, in words, for logs. */
export function describeHandleOpsRevert(revertData: Hex | undefined): string {
  if (!revertData) return 'reverted with no data';
  try {
    const decoded = decodeErrorResult({ abi: entryPoint08Abi, data: revertData });
    const args = (decoded.args ?? []) as readonly unknown[];
    const reason = args.find((a) => typeof a === 'string');
    return `${decoded.errorName}${reason ? `: ${String(reason)}` : ''}`;
  } catch {
    return `reverted with ${revertData.slice(0, 10)}`;
  }
}

// ---------------------------------------------------------------------------------------
// RPC failures: a revert is the chain's answer, anything else is not
// ---------------------------------------------------------------------------------------

interface WalkableError {
  walk?: (fn: (e: unknown) => boolean) => unknown;
  code?: unknown;
  data?: unknown;
  message?: unknown;
  details?: unknown;
  cause?: unknown;
}

/**
 * `{ reverted: true, data }` when the node executed the call and it reverted, whatever the
 * wrapping. rpc.monad.xyz answers a revert with JSON-RPC code 3, "execution reverted" and
 * the revert bytes in `data` (recorded in `fixtures/selfBundle.mainnet.json`). A timeout,
 * an HTTP failure, a rate limit or an internal error is not a revert.
 */
export function asRevert(
  error: unknown,
): { reverted: false } | { reverted: true; data: Hex | undefined } {
  const seen: WalkableError[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 10; depth += 1) {
    seen.push(current as WalkableError);
    current = (current as WalkableError).cause;
  }
  for (const e of seen) {
    const text = `${typeof e.message === 'string' ? e.message : ''} ${typeof e.details === 'string' ? e.details : ''}`;
    if (e.code === 3 || /execution reverted/i.test(text)) {
      const data = seen
        .map((x) => x.data)
        .find((d): d is Hex => typeof d === 'string' && /^0x[0-9a-fA-F]*$/.test(d));
      return { reverted: true, data };
    }
  }
  return { reverted: false };
}

/**
 * Monad's own refusal of a call that would take a 7702-delegated account below its 10 MON
 * reserve. Recorded from rpc.monad.xyz on 2026-09-29, from the delegated account
 * 0x43a2…A961 (0.014 MON) wrapping 1 wei: `eth_call` and `eth_estimateGas` both answer
 * JSON-RPC -32000 "reserve balance violation", with the relayer's own inner-call shape
 * (`execute` sent by the account to itself) as well. It is not code 3 and says nothing
 * about a revert, so `asRevert` does not see it, yet the node executed the call and
 * refused it: the chain's answer, exactly as a revert is.
 */
const RESERVE_VIOLATION = /reserve balance violation/i;

/** The refusal's sentence. Worded so the browser's existing reserve line matches it. */
export const RESERVE_VIOLATION_MESSAGE =
  'this account needs at least 10 MON left after the operation, and this one would take it below that (the network answered “reserve balance violation”)';

export function isReserveViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 10; depth += 1) {
    const e = current as WalkableError;
    const text = `${typeof e.message === 'string' ? e.message : ''} ${typeof e.details === 'string' ? e.details : ''}`;
    if (RESERVE_VIOLATION.test(text)) return true;
    current = e.cause;
  }
  return false;
}

/**
 * What a failed `eth_sendRawTransaction` says about whether the transaction went out.
 *
 *   refused   the node answered with a JSON-RPC error that is a validation refusal:
 *             it looked at the transaction and did not take it.
 *   not-sent  the connection was never made (refused, no DNS): nothing left this host.
 *             Or the RPC's rate limiter answered HTTP 429 (R9, 2026-10-07): a refusal
 *             before the request reached the node. The caller still reads the receipt and
 *             asks by hash: a 429 goes elsewhere only when both reads succeed and both
 *             find nothing; a connection never made goes elsewhere unless a read finds it.
 *   unknown   anything else: a timeout, an HTTP failure, a reset, an internal error, or
 *             an answer that says a transaction with this nonce is already in the pool.
 *             The transaction may be on its way, and must be treated as sent.
 *
 * Only `refused` and `not-sent` may let the operation go to Pimlico. Treating an unknown
 * as unsent is how an order executes twice: if our bundle lands and Pimlico then answers
 * AA25, the browser shows a rejection and the user signs again.
 */
export type SendFailure = 'refused' | 'not-sent' | 'unknown';

const REFUSAL_CODES = new Set([-32000, -32003, -32005, -32600, -32601, -32602]);
// Monad does not document its wording for a duplicate, so anything that reads like one is
// treated as possibly sent: the safe direction, since a miss here is a double execution.
const IN_POOL_ALREADY = /already|known transaction|nonce too low|replacement|exists/i;
const NEVER_CONNECTED = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

/** True when the connection was never made: the bytes did not leave this host. */
function neverConnected(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 10; depth += 1) {
    const code = (current as WalkableError).code;
    if (typeof code === 'string' && NEVER_CONNECTED.has(code)) return true;
    current = (current as WalkableError).cause;
  }
  return false;
}

export function classifySendFailure(error: unknown): SendFailure {
  const chain: WalkableError[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 10; depth += 1) {
    chain.push(current as WalkableError);
    current = (current as WalkableError).cause;
  }
  if (chain.some((e) => typeof e.code === 'string' && NEVER_CONNECTED.has(e.code))) {
    return 'not-sent';
  }
  // viem's HttpRequestError carries the HTTP status. 2026-10-07: rpc.monad.xyz rate-limited
  // a bundle's broadcast ("HTTP request failed."), it was booked as sent, never existed,
  // and its 0.19 MON worst case held self-bundling paused for an hour.
  if (isRateLimited(error)) return 'not-sent';
  const answered = chain.find((e) => typeof e.code === 'number' && e.code !== -1);
  if (!answered) return 'unknown';
  const text = chain
    .map(
      (e) =>
        `${typeof e.message === 'string' ? e.message : ''} ${typeof e.details === 'string' ? e.details : ''}`,
    )
    .join(' ');
  if (IN_POOL_ALREADY.test(text)) return 'unknown';
  return REFUSAL_CODES.has(answered.code as number) ? 'refused' : 'unknown';
}

/** True when an HTTP 429 sits anywhere in the error's cause chain. */
function isRateLimited(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 10; depth += 1) {
    if ((current as { status?: unknown }).status === 429) return true;
    current = (current as WalkableError).cause;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split('\n')[0] ?? 'unknown error';
}

async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------------------
// The inner call: Part A's estimate and the pre-flight simulation are one read
// ---------------------------------------------------------------------------------------

export type InnerSimulation =
  | { readonly kind: 'ok'; readonly gas: bigint }
  | { readonly kind: 'reverted'; readonly revertData: Hex | undefined; readonly message: string }
  | { readonly kind: 'unavailable'; readonly reason: string };

/**
 * `eth_estimateGas` of the operation's call data, sent by the account to itself.
 *
 * That is the EntryPoint's own inner call: the EntryPoint calls `sender` with `callData`,
 * and `Simple7702Account` runs `execute`/`executeBatch` for the EntryPoint or for itself
 * and refuses anyone else ("not from self or EntryPoint", read back from the deployed
 * delegate). Every target sees `msg.sender == sender` either way. It covers a batch as
 * one sequence, so an order that depends on a deposit earlier in the same batch is
 * estimated after that deposit, which estimating the order leg on its own would not do.
 *
 * Never rejects. A revert is the chain's answer and blocks the operation. Anything else
 * is `unavailable`, and the caller goes to Pimlico exactly as before.
 */
export async function simulateInnerCall(
  client: PublicClient,
  sender: Address,
  callData: Hex,
  timeoutMs = INNER_SIMULATION_TIMEOUT_MS,
  /**
   * A first operation's account is not delegated yet: its call is simulated with the
   * delegation it is about to authorize set by state override (owner item 1, 2026-09-29,
   * D191). `eth_estimateGas` on Monad honours it (probed: 24,832 gas without, 83,906 with,
   * for the same call through the delegate).
   */
  delegationCode?: Hex,
): Promise<InnerSimulation> {
  try {
    const result = await withTimeout(
      client.request({
        method: 'eth_estimateGas',
        params: [
          { from: sender, to: sender, data: callData },
          'latest',
          ...(delegationCode ? [{ [sender]: { code: delegationCode } }] : []),
        ],
      } as never) as Promise<unknown>,
      timeoutMs,
      'the inner-call estimate',
    );
    if (typeof result !== 'string' || !/^0x[0-9a-fA-F]+$/.test(result)) {
      return {
        kind: 'unavailable',
        reason: 'the node returned an estimate that is not a quantity',
      };
    }
    return { kind: 'ok', gas: BigInt(result) };
  } catch (error) {
    const revert = asRevert(error);
    if (revert.reverted) {
      return {
        kind: 'reverted',
        revertData: unwrapAccountRevert(revert.data).data,
        message: describeInnerRevert(revert.data),
      };
    }
    // Rule 1.8's wrap is the first sponsored shape that can lower the account's native
    // balance, so this answer is now reachable by a batch the policy passes. Read as
    // "unavailable" it let the relayer fund a top-up and forward an operation its own
    // simulation had just seen the chain refuse.
    if (isReserveViolation(error)) {
      return { kind: 'reverted', revertData: undefined, message: RESERVE_VIOLATION_MESSAGE };
    }
    return { kind: 'unavailable', reason: firstLine(error) };
  }
}

/**
 * Is this operation really a first operation for `sender`: the EIP-7702 marker, and an
 * authorization to exactly `SIMPLE_7702_DELEGATE` that recovers to `sender` itself, for
 * this chain (or any chain, 0), at `sender`'s current transaction count? (Security
 * review of D191, finding 2: the authorization's address alone was trusted.) Never
 * rejects; any failed read answers false, and the operation is handled as before.
 */
export async function isVerifiedFirstOperation(
  client: PublicClient,
  sender: Address,
  op: RpcUserOperationV08,
  chainId: number,
  timeoutMs = INNER_SIMULATION_TIMEOUT_MS,
): Promise<boolean> {
  const auth = op.eip7702Auth;
  if (!auth || !isEip7702Marker(op.factory)) return false;
  if (auth.address.toLowerCase() !== SIMPLE_7702_DELEGATE.toLowerCase()) return false;
  try {
    const authChain = Number(BigInt(auth.chainId));
    if (authChain !== chainId && authChain !== 0) return false;
    const authNonce = BigInt(auth.nonce);
    const [authority, txCount] = await Promise.all([
      recoverAuthorizationAddress({
        authorization: {
          address: getAddress(auth.address),
          chainId: authChain,
          nonce: Number(authNonce),
          r: auth.r as Hex,
          s: auth.s as Hex,
          yParity: Number(BigInt(auth.yParity)),
        },
      }),
      withTimeout(client.getTransactionCount({ address: sender }), timeoutMs, 'the transaction count'),
    ]);
    return authority.toLowerCase() === sender.toLowerCase() && BigInt(txCount) === authNonce;
  } catch {
    return false;
  }
}

/**
 * The least an `eth_estimateGas` can answer for this call: 21,000 plus its call data
 * (EIP-2028). A first operation's overridden estimate at or below it means the node ran
 * the call against an account with no code, i.e. ignored the override (security review of
 * D191, finding 5), and is not an answer.
 */
export function intrinsicGasOf(callData: Hex): bigint {
  let gas = 21_000n;
  for (let i = 2; i < callData.length; i += 2) gas += callData.slice(i, i + 2) === '00' ? 4n : 16n;
  return gas;
}

/** True only when `account`'s code is the delegation to `Simple7702Account`. */
export async function isSimple7702(client: PublicClient, account: Address): Promise<boolean> {
  try {
    const code = await withTimeout(
      client.getCode({ address: account }),
      LOCKED_READ_TIMEOUT_MS,
      'the code read',
    );
    return (code ?? '').toLowerCase() === delegationCodeFor(SIMPLE_7702_DELEGATE).toLowerCase();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------------------

const rawLogSchema = z.looseObject({
  address: z.string(),
  topics: z.array(z.string()),
  data: z.string(),
});
export type RawLog = z.infer<typeof rawLogSchema>;

const rawReceiptSchema = z.looseObject({
  transactionHash: z.string(),
  blockNumber: z.string().optional(),
  status: z.string(),
  gasUsed: z.string(),
  effectiveGasPrice: z.string(),
  logs: z.array(rawLogSchema),
});

/** A receipt's block, when it carries a well-formed one. */
function receiptBlock(receipt: RawReceipt): bigint | undefined {
  return receipt.blockNumber && /^0x[0-9a-fA-F]+$/.test(receipt.blockNumber)
    ? BigInt(receipt.blockNumber)
    : undefined;
}
export type RawReceipt = z.infer<typeof rawReceiptSchema>;

interface UserOperationEventArgs {
  readonly userOpHash: Hex;
  readonly sender: Address;
  readonly paymaster: Address;
  readonly nonce: bigint;
  readonly success: boolean;
  readonly actualGasCost: bigint;
  readonly actualGasUsed: bigint;
}

interface FoundEvent {
  readonly index: number;
  readonly args: UserOperationEventArgs;
  readonly revertReason?: Hex;
  /** Index of the EntryPoint log this operation's own logs start after. */
  readonly startAfter: number;
}

/** This operation's `UserOperationEvent` among `logs`, and where its own logs begin. */
export function findUserOperationEvent(
  logs: readonly RawLog[],
  userOpHash: Hex,
): FoundEvent | undefined {
  const target = userOpHash.toLowerCase();
  let startAfter = -1;
  let revertReason: Hex | undefined;
  for (let i = 0; i < logs.length; i += 1) {
    const log = logs[i]!;
    if (log.address.toLowerCase() !== ENTRY_POINT_V08.toLowerCase()) continue;
    let decoded: { eventName: string; args: unknown };
    try {
      decoded = decodeEventLog({
        abi: entryPoint08Abi,
        data: log.data as Hex,
        topics: log.topics as [Hex, ...Hex[]],
      }) as { eventName: string; args: unknown };
    } catch {
      continue;
    }
    // `BeforeExecution` has no arguments, and viem leaves `args` undefined for it.
    const args = (decoded.args ?? {}) as Record<string, unknown>;
    const isOurs = String(args.userOpHash ?? '').toLowerCase() === target;
    if (decoded.eventName === 'UserOperationEvent') {
      if (isOurs)
        return {
          index: i,
          args: args as unknown as UserOperationEventArgs,
          startAfter,
          ...(revertReason ? { revertReason } : {}),
        };
      startAfter = i;
    } else if (decoded.eventName === 'BeforeExecution') {
      startAfter = i;
    } else if (decoded.eventName === 'UserOperationRevertReason' && isOurs) {
      revertReason = args.revertReason as Hex;
    }
  }
  return undefined;
}

/**
 * `eth_getUserOperationReceipt`'s answer, shaped as Pimlico shapes it.
 *
 * Pinned to Pimlico's real answer for 0x1111dda6… (recorded through production's own
 * `/api/submit`): the EntryPoint address lowercased, the sender checksummed, quantities as
 * minimal hex, `logs` holding only the logs strictly between `BeforeExecution` and this
 * operation's `UserOperationEvent`, no `paymaster` when there is none, and `reason` only
 * when the operation reverted with one. `receipt` is the node's own receipt, as is.
 */
export function buildUserOperationReceipt(
  userOpHash: Hex,
  receipt: RawReceipt,
): Record<string, unknown> | undefined {
  const found = findUserOperationEvent(receipt.logs, userOpHash);
  if (!found) return undefined;
  const { args } = found;
  return {
    userOpHash,
    entryPoint: receipt.logs[found.index]!.address.toLowerCase(),
    sender: getAddress(args.sender),
    nonce: toHex(args.nonce),
    ...(args.paymaster && args.paymaster.toLowerCase() !== zeroAddress
      ? { paymaster: args.paymaster }
      : {}),
    actualGasUsed: toHex(args.actualGasUsed),
    actualGasCost: toHex(args.actualGasCost),
    success: args.success,
    ...(found.revertReason ? { reason: found.revertReason } : {}),
    logs: receipt.logs.slice(found.startAfter + 1, found.index),
    receipt,
  };
}

/**
 * What the relayer gained (positive) or lost (negative) on one bundle.
 *
 * `gasUsed * effectiveGasPrice` is what the chain charged the sender of the transaction.
 * On Monad `gasUsed` in a receipt is the gas limit, which is what is actually charged.
 * `actualGasCost` is what the EntryPoint paid the beneficiary, in the same transaction.
 * Integer wei on both sides: no rounding enters.
 */
export function relayerNetWei(input: {
  readonly actualGasCost: bigint;
  readonly gasUsed: bigint;
  readonly effectiveGasPrice: bigint;
}): bigint {
  return input.actualGasCost - input.gasUsed * input.effectiveGasPrice;
}

async function readRawReceipt(
  client: PublicClient,
  hash: Hex,
  timeoutMs: number = LOCKED_READ_TIMEOUT_MS,
): Promise<RawReceipt | undefined> {
  try {
    const raw = await withTimeout(
      client.request({
        method: 'eth_getTransactionReceipt',
        params: [hash],
      } as never) as Promise<unknown>,
      timeoutMs,
      'the receipt read',
    );
    if (!raw) return undefined;
    const parsed = rawReceiptSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** A receipt read that tells a failed read (`ok: false`) apart from "no receipt" (`null`). */
async function readReceiptStrict(
  client: PublicClient,
  hash: Hex,
  timeoutMs: number,
): Promise<{ ok: true; value: RawReceipt | null } | { ok: false }> {
  try {
    const raw = await withTimeout(
      client.request({ method: 'eth_getTransactionReceipt', params: [hash] } as never) as Promise<unknown>,
      timeoutMs,
      'the receipt read',
    );
    if (raw === null) return { ok: true, value: null };
    const parsed = rawReceiptSchema.safeParse(raw);
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
  } catch {
    return { ok: false };
  }
}

/**
 * Whether a thrown `eth_sendRawTransaction` error proves the broadcast it was for
 * never took: a definite refusal or an unmade connection, confirmed absent by both
 * a receipt read and a by-hash read, asked of `checkClient` (R9, 2026-10-07; D201
 * made this a shared function so the retry attempt is judged by exactly the same
 * rule as the primary, rather than any retry failure meaning "give up"). Any failed
 * read, or a failure this cannot classify, answers `false` — ambiguous is treated
 * as sent, never as proof nothing happened.
 */
async function provenNothingWentOut(
  checkClient: PublicClient,
  error: unknown,
  hash: Hex,
  timeoutMs: number,
): Promise<boolean> {
  const failure = classifySendFailure(error);
  if (failure === 'unknown') return false;
  if (isRateLimited(error)) {
    await sleep(RATE_LIMITED_RECHECK_MS);
  }
  const [receipt, known] = await Promise.all([
    readReceiptStrict(checkClient, hash, timeoutMs),
    read(
      () => checkClient.request({ method: 'eth_getTransactionByHash', params: [hash] } as never),
      timeoutMs,
    ),
  ]);
  const found = (receipt.ok && receipt.value !== null) || (known.ok && Boolean(known.value));
  const absent = receipt.ok && receipt.value === null && known.ok && !known.value;
  return !isRateLimited(error) && neverConnected(error) ? !found : absent;
}

/**
 * Poll for a receipt at a pace that suits a 400 ms chain.
 *
 * The relayer's client has viem's default 4 s polling interval (the chain definition has
 * no block time), so `waitForTransactionReceipt` would notice a bundle that mined in
 * 400 ms up to four seconds later, with the relayer key's lock held the whole time.
 */
export async function waitForRawReceipt(
  client: PublicClient,
  hash: Hex,
  options: { readonly timeoutMs: number; readonly pollMs: number; readonly readTimeoutMs?: number },
): Promise<RawReceipt | undefined> {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const receipt = await readRawReceipt(client, hash, options.readTimeoutMs);
    if (receipt) return receipt;
    if (Date.now() + options.pollMs > deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, options.pollMs));
  }
}

// ---------------------------------------------------------------------------------------
// The key boundary
// ---------------------------------------------------------------------------------------

export interface HandleOpsTransaction {
  readonly op: PackedUserOperation;
  readonly gas: bigint;
  readonly nonce: number;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
}

export interface SignedHandleOps {
  readonly serialized: Hex;
  readonly hash: Hex;
  /** The calldata that was signed, so the caller can check it is what it simulated. */
  readonly data: Hex;
}

/**
 * The only thing that signs a bundle. Injected in tests: on this machine the live one
 * unlocks the real mainnet relayer key from `.secrets/relayer-keystore.json`.
 */
export interface BundleExecutor {
  relayerAddress(): Address | undefined;
  signHandleOps(tx: HandleOpsTransaction): Promise<SignedHandleOps>;
}

/**
 * Signs `EntryPoint.handleOps([op], self)` and nothing else.
 *
 * The target, the zero value, the function and the beneficiary are fixed here, not passed
 * in, so no caller can point the relayer key at anything else through this path. On
 * mainnet it re-checks the A2.4 gate itself rather than trusting that its caller did.
 */
export function liveBundleExecutor(options: {
  readonly mode: ChainMode;
  readonly chainId: number;
  /** Tests pass a throwaway key. Production always unlocks the relayer's keystore. */
  readonly loadAccount?: () => PrivateKeyAccount | undefined;
}): BundleExecutor {
  const load = options.loadAccount ?? loadRelayerAccount;
  return {
    relayerAddress: () => load()?.address,
    async signHandleOps(tx) {
      if (options.mode === 'mainnet') {
        assertMainnetAllowed('self-bundling a user operation', readModeGate());
      }
      const account = load();
      if (!account) throw new Error('the relayer key cannot be unlocked');
      const data = handleOpsCalldata(tx.op, account.address);
      const serialized = await account.signTransaction({
        type: 'eip1559',
        chainId: options.chainId,
        nonce: tx.nonce,
        to: ENTRY_POINT_V08,
        value: 0n,
        data,
        gas: tx.gas,
        maxFeePerGas: tx.maxFeePerGas,
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      });
      return { serialized, hash: keccak256(serialized), data };
    },
  };
}

// ---------------------------------------------------------------------------------------
// The bundler
// ---------------------------------------------------------------------------------------

export type SelfBundleOutcome =
  /**
   * Sent, or may have been: answered as soon as the node took the transaction, before it
   * is mined, as Pimlico answers. The receipt is asked for separately (`receiptFor`).
   */
  | {
      readonly kind: 'submitted';
      readonly userOpHash: Hex;
      readonly txHash: Hex;
    }
  /** The operation itself would revert. The chain's reason; nothing was sent. */
  | { readonly kind: 'refused'; readonly message: string; readonly revertData?: Hex }
  /** Not self-bundled. Forward to Pimlico exactly as before. Nothing was spent. */
  | { readonly kind: 'fallback'; readonly reason: string };

export interface SelfBundleRequest {
  readonly op: RpcUserOperationV08;
  /** From `verifyUserOperationSignature`: the hash the sender's signature recovered over. */
  readonly userOpHash: Hex;
  readonly sender: Address;
  readonly purpose: string;
  /**
   * A free (sponsored) action: once it lands, its burn may be refilled from sponsorship in
   * the background (R9). A charged or exempt action never is.
   */
  readonly sponsored?: boolean;
}

/** A stage of the send path reached, for its timing line (R9, 2026-10-07). */
export type StageMark = (stage: string, detail?: Record<string, unknown>) => void;

/**
 * The bundle's chain reads, started outside the lock as soon as the route has a signed
 * send (R9, 2026-10-07), so they run alongside the route's own checks instead of after
 * them. Used inside the lock only when `snapshot` says the lock was idle as they started
 * and exactly one task, the bundle's own, has started since: then no relayer-key
 * transaction (a top-up, a mint, another bundle) went out between these reads and the
 * send, and they are the reads the lock would have made. Otherwise they are discarded and
 * read again inside the lock, exactly as before.
 */
export interface SelfBundlePrefetch {
  /** The very operation object the reads were made for; `submit` must be given the same. */
  readonly op: RpcUserOperationV08;
  readonly snapshot: { readonly generation: number; readonly idle: boolean };
  readonly reads: Promise<BundleReads>;
}

type BundleReads = Awaited<ReturnType<typeof readBundleInputs>>;

/**
 * The six reads a bundle needs: the outer gas estimate, the simulation, the relayer's
 * pending nonce (skipped when it is held in memory), the base fee, the relayer's balance,
 * and the sender's delegation. One round trip: none depends on another. Never rejects.
 */
async function readBundleInputs(
  client: PublicClient,
  timeout: number,
  args: {
    readonly relayer: Address;
    readonly sender: Address;
    readonly data: Hex;
    readonly fees: { readonly maxFeePerGas: bigint; readonly maxPriorityFeePerGas: bigint };
    readonly userOperation: ReturnType<typeof toUserOperationV08>;
    readonly skipNonce: boolean;
  },
) {
  const hex = (v: bigint) => toHex(v);
  const call = {
    from: args.relayer,
    to: ENTRY_POINT_V08,
    data: args.data,
    maxFeePerGas: hex(args.fees.maxFeePerGas),
    maxPriorityFeePerGas: hex(args.fees.maxPriorityFeePerGas),
  };
  // Generous on purpose. What the EntryPoint repays does not depend on the outer limit
  // once it clears the EntryPoint's own gas checks, so this only has to clear them.
  const simulationGas =
    (args.userOperation.verificationGasLimit +
      args.userOperation.callGasLimit +
      args.userOperation.preVerificationGas) *
    2n;
  return Promise.all([
    read(
      async () =>
        estimateResultSchema.parse(
          await client.request({ method: 'eth_estimateGas', params: [call, 'latest'] } as never),
        ),
      timeout,
    ),
    read(
      async () =>
        simulateSchema.parse(
          await client.request({
            method: 'eth_simulateV1',
            params: [
              {
                blockStateCalls: [{ calls: [{ ...call, gas: hex(simulationGas) }] }],
                validation: true,
              },
              'latest',
            ],
          } as never),
        ),
      timeout,
    ),
    args.skipNonce
      ? Promise.resolve(undefined)
      : read(
          async () =>
            estimateResultSchema.parse(
              await client.request({
                method: 'eth_getTransactionCount',
                params: [args.relayer, 'pending'],
              } as never),
            ),
          timeout,
        ),
    read(
      async () =>
        blockSchema.parse(
          await client.request({
            method: 'eth_getBlockByNumber',
            params: ['latest', false],
          } as never),
        ),
      timeout,
    ),
    // The float floor's input. The same read `/v1/health` makes for the same address.
    read(() => client.getBalance({ address: args.relayer }), timeout),
    isSimple7702(client, args.sender).catch(() => false),
  ] as const);
}

interface Tracked {
  readonly txHash: Hex;
  readonly reservationId: number;
  readonly worstCase: bigint;
  result?: Record<string, unknown>;
  /**
   * Our bundle reverted, or carried no event for this operation. The operation may still
   * have run in someone else's bundle, so its receipt is looked for by hash on chain.
   */
  bundleReverted?: boolean;
}

const MAX_TRACKED = 1_000;

interface BundleInput {
  readonly request: SelfBundleRequest;
  readonly relayer: Address;
  readonly packed: PackedUserOperation;
  readonly data: Hex;
  readonly fees: { readonly maxFeePerGas: bigint; readonly maxPriorityFeePerGas: bigint };
  readonly userOperation: ReturnType<typeof toUserOperationV08>;
  /** Answers the caller. Only the first call counts; later ones are ignored. */
  readonly answer: (outcome: SelfBundleOutcome) => void;
  readonly prefetch?: SelfBundlePrefetch;
  readonly mark?: StageMark;
}

/** What `#bundle` has done so far, so a failure part-way can be cleaned up honestly. */
interface BundleState {
  reservationId?: number;
  /**
   * Set just before `eth_sendRawTransaction` is called, and cleared only on a definite
   * refusal. While it is set, a transaction with this hash may exist, and every exit
   * answers `submitted`, never Pimlico.
   */
  txHash?: Hex;
  settled: boolean;
}

/** The ledger's refusal, in the words the fallback log carries. */
const POOL_REFUSAL: Record<SelfBundleRefusal, string> = {
  'loss-limit': 'self-bundling is paused: the hourly loss limit is reached',
  'in-flight': 'a self-bundle is already sent and unsettled; another would reuse its nonce',
  'float-floor': 'this bundle’s worst case could take the relayer float to its alert line',
  'too-large': 'this bundle’s worst case is above the most one self-bundle may carry',
  amount: 'the bundle’s worst case is not a positive amount',
};

const estimateResultSchema = z.string().regex(/^0x[0-9a-fA-F]+$/);
const blockSchema = z.looseObject({ baseFeePerGas: z.string().regex(/^0x[0-9a-fA-F]+$/) });
const simulateSchema = z.array(
  z.looseObject({
    calls: z.array(
      z.looseObject({
        status: z.string(),
        logs: z.array(rawLogSchema).optional(),
        returnData: z.string().optional(),
      }),
    ),
  }),
);
const logsSchema = z.array(rawLogSchema.extend({ transactionHash: z.string() }));

type Read<T> = { ok: true; value: T } | { ok: false; reason: string; revertData?: Hex };

async function read<T>(work: () => Promise<T>, timeoutMs: number): Promise<Read<T>> {
  try {
    return { ok: true, value: await withTimeout(work(), timeoutMs, 'a read under the lock') };
  } catch (error) {
    const revert = asRevert(error);
    return {
      ok: false,
      reason: revert.reverted ? describeHandleOpsRevert(revert.data) : firstLine(error),
      ...(revert.reverted && revert.data ? { revertData: revert.data } : {}),
    };
  }
}

/** The `userOpHash` of the first `UserOperationEvent` in `logs`. A self-bundle carries one. */
function firstUserOperationHash(logs: readonly RawLog[]): Hex | undefined {
  const [topic] = encodeEventTopics({ abi: entryPoint08Abi, eventName: 'UserOperationEvent' });
  const log = logs.find(
    (l) =>
      l.address.toLowerCase() === ENTRY_POINT_V08.toLowerCase() &&
      l.topics[0]?.toLowerCase() === topic?.toLowerCase(),
  );
  return log?.topics[1] as Hex | undefined;
}

/**
 * Does a top-up of `topUp` buy a real run of this exact operation? (Independent review,
 * 2026-09-24, the reviewer's preferred fix for the whole "funded but never runs" family.)
 *
 * One `eth_simulateV1` block, from the relayer's own address: `EntryPoint.depositTo(sender)`
 * carrying `topUp`, then `handleOps([op], relayer)` exactly as self-bundling would send it.
 * The answer is yes only when both calls succeed and the EntryPoint emits this operation's
 * `UserOperationEvent` with `success` true: validation passed (signature, nonce, enough
 * verification gas, a deposit that covers the SIGNED prefund) and the call ran, fee leg and
 * all. So a top-up is paid only for an operation that, on the chain as it stands, would
 * run and pay its fee: AA21, AA23, AA25 and an inner revert are all a no, without anyone
 * having had to name them. What it cannot see is state changing after it: a withdrawal
 * that lands between the top-up and the bundle (the race D170 recorded; since D172 an address gets one such top-up, not one per cycle).
 *
 * A read that fails any other way is `unavailable`, and the caller does not pay.
 */
export type FundedRunCheck =
  | { readonly kind: 'runs' }
  | { readonly kind: 'fails'; readonly reason: string }
  | { readonly kind: 'unavailable'; readonly reason: string };

/**
 * How far ahead the funded run is simulated: two minutes (fourth review round). The bundle
 * runs a second or more after this check, so an operation that is only good for the next
 * second (a permit deadline, a deadline inside a Flow route this policy cannot read) must
 * fail here rather than there. Monad honours the override: on 2026-09-24 at block
 * 107,619,360, `eth_simulateV1` with `blockOverrides.time` = latest + 120 answered a block
 * with exactly that timestamp, and latest + 2 without it.
 */
export const FUNDED_RUN_LOOKAHEAD_SECONDS = 120;

export async function simulateFundedRun(input: {
  readonly client: PublicClient;
  readonly relayer: Address;
  readonly op: RpcUserOperationV08;
  readonly userOpHash: Hex;
  readonly topUp: bigint;
  /** The wall clock, in epoch seconds. The run is simulated `FUNDED_RUN_LOOKAHEAD_SECONDS` later. */
  readonly nowSeconds: number;
  readonly timeoutMs?: number;
}): Promise<FundedRunCheck> {
  const at = BigInt(input.nowSeconds + FUNDED_RUN_LOOKAHEAD_SECONDS);
  const userOperation = toUserOperationV08(input.op);
  const data = handleOpsCalldata(toPackedUserOperation(userOperation), input.relayer);
  const fees = {
    maxFeePerGas: toHex(userOperation.maxFeePerGas),
    maxPriorityFeePerGas: toHex(userOperation.maxPriorityFeePerGas),
  };
  const gas =
    (userOperation.verificationGasLimit +
      userOperation.callGasLimit +
      userOperation.preVerificationGas) *
    2n;
  const simulated = await read(
    async () =>
      simulateSchema.parse(
        await input.client.request({
          method: 'eth_simulateV1',
          params: [
            {
              blockStateCalls: [
                {
                  blockOverrides: { time: toHex(at) },
                  calls: [
                    {
                      from: input.relayer,
                      to: ENTRY_POINT_V08,
                      data: encodeFunctionData({
                        abi: entryPoint08Abi,
                        functionName: 'depositTo',
                        args: [userOperation.sender],
                      }),
                      value: toHex(input.topUp),
                      ...fees,
                    },
                    { from: input.relayer, to: ENTRY_POINT_V08, data, gas: toHex(gas), ...fees },
                  ],
                },
              ],
              validation: true,
            },
            'latest',
          ],
        } as never),
      ),
    input.timeoutMs ?? LOCKED_READ_TIMEOUT_MS,
  );
  if (!simulated.ok) return { kind: 'unavailable', reason: simulated.reason };
  // A node that ignored the override simulated "now", which is exactly what this is for
  // not doing. Its answer is no answer.
  const timestamp = (simulated.value[0] as { timestamp?: unknown } | undefined)?.timestamp;
  if (typeof timestamp !== 'string' || !/^0x[0-9a-fA-F]+$/.test(timestamp) || BigInt(timestamp) !== at) {
    return { kind: 'unavailable', reason: 'the simulation did not run at the requested time' };
  }
  const [depositCall, handleCall] = simulated.value[0]?.calls ?? [];
  if (!depositCall || depositCall.status !== '0x1') {
    return { kind: 'unavailable', reason: 'the simulated top-up itself did not go through' };
  }
  if (!handleCall || handleCall.status !== '0x1') {
    return {
      kind: 'fails',
      reason: describeHandleOpsRevert(handleCall?.returnData as Hex | undefined),
    };
  }
  const event = findUserOperationEvent(handleCall.logs ?? [], input.userOpHash);
  if (!event) return { kind: 'fails', reason: 'the simulated bundle carried no event for this operation' };
  if (!event.args.success) {
    return { kind: 'fails', reason: describeInnerRevert(event.revertReason) };
  }
  return { kind: 'runs' };
}

export class SelfBundler {
  readonly #tracked = new Map<string, Tracked>();
  #lastReconcile = 0;

  constructor(
    private readonly deps: {
      readonly client: PublicClient;
      /** `null` turns self-bundling off: every operation goes to Pimlico. */
      readonly executor: BundleExecutor | null;
      readonly db: RelayerDb;
      /**
       * The float alert line in wei (`floatAlertThresholdWei`), the same line `/v1/health`
       * reports against. `undefined` when it could not be computed from the config: then
       * nothing is self-bundled, since the floor cannot be held.
       */
      readonly floatAlertWei: bigint | undefined;
      readonly now: () => number;
      readonly log: PrefundLogger & {
        error(detail: Record<string, unknown>, message: string): void;
      };
      /** The relayer key's one lock, shared with top-ups and CCTP mints (F5). */
      readonly lock: SerialLock;
      readonly receiptTimeoutMs?: number;
      readonly receiptPollMs?: number;
      /** Test hook for `LOCKED_READ_TIMEOUT_MS`. */
      readonly readTimeoutMs?: number;
      /**
       * A client against a second public RPC, to retry the broadcast on once (D201) —
       * only reached after two independent reads (a receipt, a by-hash lookup) both
       * confirm the primary never took the transaction, so a second broadcast is never a
       * double-send. Not a blanket retry: the deliberate choice below to run
       * `eth_sendRawTransaction` with viem's own retries off stands untouched for the
       * primary attempt. A client, not a URL, so a test can inject a fake one the same
       * way it already does for `client` itself.
       */
      readonly retryClient?: PublicClient;
      /**
       * Called once a bundle's receipt shows its operation ran, with what the EntryPoint
       * charged the sender (R9, 2026-10-07): the background refill's trigger. Runs inside
       * the lock, so whatever it starts must not wait on the lock itself.
       */
      readonly onLanded?: (landed: {
        readonly sender: Address;
        readonly userOpHash: Hex;
        readonly actualGasCost: bigint;
        readonly success: boolean;
      }) => void;
    },
  ) {}

  /**
   * The relayer key's next nonce, held after a bundle whose receipt this code saw (R9,
   * 2026-10-07). Trusted only by the task that starts directly after the one that set it
   * (`generation`), so any other relayer-key transaction in between means a fresh read;
   * dropped at the start of every bundle and set again only at a clean end, so any error
   * also means a fresh read.
   */
  #nonceMemory: { readonly next: number; readonly generation: number } | undefined;

  /**
   * The float alert line's last known side (D201): `undefined` until the first
   * balance read, then whether the relayer's float sat below `floatAlertWei` that
   * time. Logged only on the rare side it changes — the per-bundle `float-floor`
   * refusal below already logs every declined bundle; this instead marks the two
   * moments that matter operationally: self-bundling effectively turning off as
   * the float crosses the line, and turning back on once it recovers.
   */
  #floatBelowAlertLast: boolean | undefined;

  #logFloatTransition(balanceWei: bigint, floatAlertWei: bigint): void {
    const belowAlert = balanceWei < floatAlertWei;
    if (this.#floatBelowAlertLast === belowAlert) return;
    const first = this.#floatBelowAlertLast === undefined;
    this.#floatBelowAlertLast = belowAlert;
    if (first) return;
    this.deps.log.warn(
      { balanceWei: balanceWei.toString(), floatAlertWei: floatAlertWei.toString(), belowAlert },
      belowAlert
        ? 'self-bundling float alert: balance dropped to or below the alert line, self-bundling is effectively off'
        : 'self-bundling float alert: balance recovered above the alert line, self-bundling is back on',
    );
  }

  get enabled(): boolean {
    return this.deps.executor !== null;
  }

  get #readTimeoutMs(): number {
    return this.deps.readTimeoutMs ?? LOCKED_READ_TIMEOUT_MS;
  }

  /**
   * Why self-bundling's own allowance is closed right now, or undefined: the loss limit
   * (settled losses plus the worst case of every bundle not yet settled, over the rolling
   * hour) or the in-flight cap. Only ever consulted inside the lock, so no bundle can be
   * sent between another one crossing a bound and this seeing it. Read before the chain
   * reads so a closed pool costs no round trip; `reserveSelfBundle` checks both again, in
   * the same transaction as its insert, together with the float floor.
   */
  #closed(): string | undefined {
    const { db, now } = this.deps;
    if (db.selfBundleExposure(now(), HOUR) >= SELF_BUNDLE_LOSS_LIMIT_WEI) {
      return POOL_REFUSAL['loss-limit'];
    }
    if (db.selfBundlesInFlight(now(), HOUR) >= SELF_BUNDLE_MAX_IN_FLIGHT) {
      return POOL_REFUSAL['in-flight'];
    }
    return undefined;
  }

  #track(userOpHash: Hex, entry: Tracked): Tracked {
    this.#tracked.delete(userOpHash.toLowerCase());
    this.#tracked.set(userOpHash.toLowerCase(), entry);
    if (this.#tracked.size > MAX_TRACKED) {
      const oldest = this.#tracked.keys().next().value;
      if (oldest !== undefined) this.#tracked.delete(oldest);
    }
    return entry;
  }

  /**
   * Settle a sent bundle's reservation from its receipt, and mark its relay row mined.
   *
   * Idempotent: only a row still `reserved` or `unconfirmed` is moved, so a bundle
   * reconciled late by a receipt lookup and by the next bundle's sweep is settled once.
   * A reverted bundle, or one with no event for its operation, is a loss of the whole cost.
   * Otherwise the reservation is released when the relayer netted zero or better, and
   * charged the shortfall when it did not.
   */
  #settleFromReceipt(
    sent: { readonly reservationId: number; readonly worstCase: bigint; readonly txHash: Hex },
    receipt: RawReceipt,
    userOpHash: Hex | undefined,
  ): { bundleReverted: boolean; result?: Record<string, unknown>; net?: bigint; cost: bigint } {
    const { db, now } = this.deps;
    // Only a row still open is moved, and the relay row is marked mined only by whichever
    // call moved it. The condition sits in the write itself (`onlyFrom`), not in a status
    // read some lines earlier, so it holds even if an await is ever put in between.
    const OPEN = ['reserved', 'unconfirmed'] as const;
    const gasUsed = BigInt(receipt.gasUsed);
    const price = BigInt(receipt.effectiveGasPrice);
    const cost = gasUsed * price;
    const clamp = (loss: bigint) => (loss < sent.worstCase ? loss : sent.worstCase);
    const hash = userOpHash ?? firstUserOperationHash(receipt.logs);

    const result =
      receipt.status === '0x1' && hash ? buildUserOperationReceipt(hash, receipt) : undefined;
    if (!result) {
      const moved = db.settlePrefund(sent.reservationId, 'paid', {
        txHash: sent.txHash,
        now: now(),
        amountWei: clamp(cost),
        onlyFrom: OPEN,
      });
      if (moved) db.markMined(sent.txHash, 'reverted', { gasUsed, monSpent: cost, now: now() });
      return { bundleReverted: true, cost };
    }
    // The durable backstop's confirmation, from our own receipt: this operation landed, and
    // the gas it burned, paid to us as the beneficiary (D172, the refill rule).
    if (hash) {
      db.recordGasBurn({
        userOpHash: hash,
        address: String(result.sender),
        block: receiptBlock(receipt),
        actualGasCost: BigInt(result.actualGasCost as Hex),
        success: result.success === true,
        ownBundle: true,
        now: now(),
      });
      db.confirmFeePaidTopUpByHash(hash, result.success === true, now());
    }
    const net = relayerNetWei({
      actualGasCost: BigInt(result.actualGasCost as Hex),
      gasUsed,
      effectiveGasPrice: price,
    });
    const moved =
      net >= 0n
        ? db.settlePrefund(sent.reservationId, 'released', {
            txHash: sent.txHash,
            now: now(),
            onlyFrom: OPEN,
          })
        : db.settlePrefund(sent.reservationId, 'paid', {
            txHash: sent.txHash,
            now: now(),
            amountWei: clamp(-net),
            onlyFrom: OPEN,
          });
    if (moved) {
      db.markMined(sent.txHash, result.success ? 'success' : 'reverted', {
        gasUsed,
        monSpent: cost,
        now: now(),
      });
    }
    return { bundleReverted: false, result, net, cost };
  }

  /**
   * Re-read bundles that were sent without a receipt, and settle any that have one now.
   * Runs inside the lock, before the loss limit is read, at most every 15 s. Without it a
   * bundle that landed after its receipt wait left its worst case counted and its relay row
   * pending for good.
   */
  async #reconcile(): Promise<void> {
    const { db, client, now, log } = this.deps;
    if (now() - this.#lastReconcile < RECONCILE_EVERY_MS) return;
    this.#lastReconcile = now();
    const rows = db.unconfirmedSelfBundles(now() - HOUR, RECONCILE_BATCH);
    await Promise.all(
      rows.map(async (row) => {
        const receipt = await readRawReceipt(client, row.txHash as Hex, this.#readTimeoutMs);
        if (!receipt) {
          // Never mined, a minute after it was sent (R9, 2026-10-07): a broadcast that never
          // reached the node left its worst case counting against the loss limit, which
          // paused self-bundling for an hour. A lookup by hash proves nothing on a
          // load-balanced node, so the proof is the relayer's own finalized nonce: once it
          // has moved past this bundle's nonce, this transaction can never be included.
          // The nonce is read first, then the receipt, and both reads must succeed. Any
          // failed read changes nothing. The hash stays on the row.
          if (now() - row.createdAt < UNSEEN_RELEASE_MS || row.txNonce === null) return;
          const relayer = this.deps.executor?.relayerAddress();
          if (!relayer) return;
          const mined = await read(
            async () =>
              BigInt(
                estimateResultSchema.parse(
                  await client.request({
                    method: 'eth_getTransactionCount',
                    params: [relayer, 'finalized'],
                  } as never),
                ),
              ),
            this.#readTimeoutMs,
          );
          if (!mined.ok || mined.value <= BigInt(row.txNonce)) return;
          const again = await readReceiptStrict(client, row.txHash as Hex, this.#readTimeoutMs);
          if (!again.ok) return;
          if (again.value) {
            const settled = this.#settleFromReceipt(
              { reservationId: row.id, worstCase: row.amountWei, txHash: row.txHash as Hex },
              again.value,
              undefined,
            );
            log.info(
              { txHash: row.txHash, bundleReverted: settled.bundleReverted, netWei: settled.net?.toString() },
              'late self-bundle receipt reconciled on the re-read',
            );
            return;
          }
          const released = db.settlePrefund(row.id, 'released', {
            txHash: row.txHash,
            now: now(),
            onlyFrom: ['unconfirmed'],
          });
          if (released) {
            // Its relay row too, so nothing shows pending for a transaction that can never
            // be included (R9, 2026-10-07).
            db.markMined(row.txHash, 'rejected', {
              error: 'never mined; the relayer nonce moved past it',
              now: now(),
            });
            log.warn(
              { txHash: row.txHash, txNonce: row.txNonce, worstCaseWei: row.amountWei.toString() },
              'self-bundle was never mined and its nonce is used; released',
            );
          }
          return;
        }
        const settled = this.#settleFromReceipt(
          { reservationId: row.id, worstCase: row.amountWei, txHash: row.txHash as Hex },
          receipt,
          undefined,
        );
        log.info(
          {
            txHash: row.txHash,
            bundleReverted: settled.bundleReverted,
            netWei: settled.net?.toString(),
          },
          'late self-bundle receipt reconciled',
        );
      }),
    );
  }

  /**
   * A receipt for an operation this relayer bundled: the Pimlico-shaped object, `null`
   * while it is not mined yet, or `undefined` when this relayer did not bundle it (ask
   * Pimlico, as before).
   */
  async receiptFor(userOpHash: Hex): Promise<Record<string, unknown> | null | undefined> {
    const entry = this.#tracked.get(userOpHash.toLowerCase());
    if (!entry) return undefined;
    if (entry.result) return entry.result;
    if (!entry.bundleReverted) {
      const receipt = await readRawReceipt(this.deps.client, entry.txHash, this.#readTimeoutMs);
      if (!receipt) return null;
      const settled = this.#settleFromReceipt(entry, receipt, userOpHash);
      if (settled.result) {
        entry.result = settled.result;
        return settled.result;
      }
      entry.bundleReverted = true;
    }
    return this.#receiptFromElsewhere(userOpHash, entry);
  }

  /**
   * Our bundle reverted, so the operation did not run in it. It may have run in someone
   * else's (a copy lifted from our pending transaction, say), which is why ours reverted.
   * Look for its event on chain by hash, in the last 100 blocks the public RPC allows.
   * Found: that receipt, so the browser sees the order did execute and does not sign it
   * again. Not found: `null`, and the browser's wait ends in "sent, not confirmed".
   */
  async #receiptFromElsewhere(
    userOpHash: Hex,
    entry: Tracked,
  ): Promise<Record<string, unknown> | null> {
    const { client } = this.deps;
    const timeout = this.#readTimeoutMs;
    const head = await read(
      () => client.request({ method: 'eth_blockNumber' } as never) as Promise<Hex>,
      timeout,
    );
    if (!head.ok) return null;
    const [topic] = encodeEventTopics({ abi: entryPoint08Abi, eventName: 'UserOperationEvent' });
    const from = BigInt(head.value) > 99n ? BigInt(head.value) - 99n : 0n;
    const logs = await read(
      async () =>
        logsSchema.parse(
          await client.request({
            method: 'eth_getLogs',
            params: [
              {
                address: ENTRY_POINT_V08,
                topics: [topic, userOpHash],
                fromBlock: toHex(from),
                toBlock: head.value,
              },
            ],
          } as never),
        ),
      timeout,
    );
    const found = logs.ok ? logs.value[0] : undefined;
    if (!found) return null;
    const receipt = await readRawReceipt(client, found.transactionHash as Hex, timeout);
    const result = receipt ? buildUserOperationReceipt(userOpHash, receipt) : undefined;
    if (result && receipt) {
      entry.result = result;
      // Our bundle reverted, so this is someone else's unless the ledger says we sent it: its
      // gas counts toward a later paid top-up only as `recordGasBurn` allows.
      this.deps.db.recordGasBurn({
        userOpHash,
        address: String(result.sender),
        block: receiptBlock(receipt),
        actualGasCost: BigInt(result.actualGasCost as Hex),
        success: result.success === true,
        ownBundle: this.deps.db.isOwnBundleTx(String(found.transactionHash)),
        now: this.deps.now(),
      });
      this.deps.db.confirmFeePaidTopUpByHash(userOpHash, result.success === true, this.deps.now());
    }
    return result ?? null;
  }

  /**
   * Start the bundle's reads now, outside the lock (R9, 2026-10-07). Undefined when the
   * operation would not be self-bundled anyway; then `submit` declines it as before.
   */
  prefetch(request: Pick<SelfBundleRequest, 'op' | 'sender'>): SelfBundlePrefetch | undefined {
    const prepared = this.#prepare(request);
    if ('reason' in prepared) return undefined;
    const snapshot = this.deps.lock.snapshot();
    return {
      op: request.op,
      snapshot,
      reads: readBundleInputs(this.deps.client, this.#readTimeoutMs, {
        relayer: prepared.relayer,
        sender: request.sender,
        data: prepared.data,
        fees: prepared.fees,
        userOperation: prepared.userOperation,
        skipNonce: false,
      }),
    };
  }

  /** Everything `submit` checks and builds before the lock, or why it declines. */
  #prepare(request: Pick<SelfBundleRequest, 'op' | 'sender'>):
    | {
        readonly relayer: Address;
        readonly packed: PackedUserOperation;
        readonly data: Hex;
        readonly fees: { readonly maxFeePerGas: bigint; readonly maxPriorityFeePerGas: bigint };
        readonly userOperation: ReturnType<typeof toUserOperationV08>;
      }
    | { readonly reason: string } {
    const fallback = (reason: string) => ({ reason });
    const { executor } = this.deps;
    if (!executor) return fallback('self-bundling is off');

    const relayer = executor.relayerAddress();
    if (!relayer) return fallback('the relayer key cannot be unlocked');

    const userOperation = toUserOperationV08(request.op);
    // The route already sends these to Pimlico. Checked again here because this is the
    // code that signs, and a first operation needs a type-4 transaction this does not send.
    if (userOperation.factory !== undefined || userOperation.authorization !== undefined) {
      return fallback('the operation carries an EIP-7702 authorization');
    }
    if (request.op.paymaster !== undefined && request.op.paymaster !== '0x') {
      return fallback('the operation names a paymaster');
    }
    if (userOperation.sender.toLowerCase() !== request.sender.toLowerCase()) {
      return fallback('the operation does not name this sender');
    }
    const fees = {
      maxFeePerGas: userOperation.maxFeePerGas,
      maxPriorityFeePerGas: userOperation.maxPriorityFeePerGas,
    };
    if (fees.maxPriorityFeePerGas > fees.maxFeePerGas || fees.maxFeePerGas === 0n) {
      return fallback('the operation’s fees are not a valid EIP-1559 pair');
    }
    if (fees.maxPriorityFeePerGas < SELF_BUNDLE_MIN_PRIORITY_FEE_WEI) {
      return fallback('the operation’s priority fee is below the self-bundling minimum');
    }
    if (userOperation.callGasLimit > MAX_CALL_GAS_LIMIT) {
      return fallback('the operation’s call gas limit is above the ceiling');
    }
    if (this.deps.floatAlertWei === undefined) {
      return fallback('the float alert line is not known, so the float floor cannot be held');
    }

    const packed = toPackedUserOperation(userOperation);
    const data = handleOpsCalldata(packed, relayer);
    return { relayer, packed, data, fees, userOperation };
  }

  async submit(
    request: SelfBundleRequest,
    options: { readonly prefetch?: SelfBundlePrefetch; readonly mark?: StageMark } = {},
  ): Promise<SelfBundleOutcome> {
    const prepared = this.#prepare(request);
    if ('reason' in prepared) return { kind: 'fallback', reason: prepared.reason };
    const { relayer, packed, data, fees, userOperation } = prepared;

    /*
     * The caller's answer and the lock's task are two promises. The task answers as soon
     * as the node has taken the bundle (or may have), then carries on inside the lock to
     * wait for its receipt and settle it. Every earlier exit answers with the task's own
     * result. The allowance is read inside the lock, not here. Read here, every request
     * already queued when a bundle crossed it would still send (review, 2026-09-24).
     */
    const state: BundleState = { settled: false };
    let answer!: (outcome: SelfBundleOutcome) => void;
    const answered = new Promise<SelfBundleOutcome>((resolve) => {
      answer = resolve;
    });
    this.deps.lock
      .run(() =>
        this.#submitLocked(
          {
            request,
            relayer,
            packed,
            data,
            fees,
            userOperation,
            answer,
            ...(options.prefetch ? { prefetch: options.prefetch } : {}),
            ...(options.mark ? { mark: options.mark } : {}),
          },
          state,
        ),
      )
      .then(answer, (error: unknown) => {
        // `#submitLocked` never throws. Were it to, answer from what is known: a bundle
        // that may exist is `submitted`, whatever went wrong after it.
        answer(
          state.txHash
            ? { kind: 'submitted', userOpHash: request.userOpHash, txHash: state.txHash }
            : { kind: 'fallback', reason: 'self-bundling failed unexpectedly' },
        );
        try {
          this.deps.log.error(
            { sender: request.sender, userOpHash: request.userOpHash, err: firstLine(error) },
            'self-bundle task failed',
          );
        } catch {
          /* nothing may escape a task nobody awaits */
        }
      });
    return answered;
  }

  /**
   * Never throws. Before anything is sent, an unexpected failure releases what was
   * reserved and hands the operation to Pimlico. After a transaction may exist, it always
   * answers `submitted`: that transaction may still land, and giving the same operation to
   * Pimlico, or telling the browser it failed so the user signs it again, is how an order
   * would execute twice.
   */
  async #submitLocked(input: BundleInput, state: BundleState): Promise<SelfBundleOutcome> {
    try {
      return await this.#bundle(input, state);
    } catch (error) {
      const { db, now, log } = this.deps;
      const settle = (status: 'released' | 'unconfirmed') => {
        if (state.reservationId === undefined || state.settled) return;
        try {
          // Only a row this bundle still holds as 'reserved'. One already marked sent, or
          // settled from its receipt by a lookup, is left as it is.
          db.settlePrefund(state.reservationId, status, {
            ...(state.txHash ? { txHash: state.txHash } : {}),
            now: now(),
            onlyFrom: ['reserved'],
          });
        } catch {
          /* the row stays 'reserved', which still counts: fail closed */
        }
      };
      log.error(
        {
          sender: input.request.sender,
          userOpHash: input.request.userOpHash,
          err: firstLine(error),
        },
        'self-bundle failed unexpectedly',
      );
      if (state.txHash) {
        settle('unconfirmed');
        return { kind: 'submitted', userOpHash: input.request.userOpHash, txHash: state.txHash };
      }
      settle('released');
      return { kind: 'fallback', reason: 'self-bundling failed unexpectedly' };
    }
  }

  /**
   * Everything that has to see the chain as the relayer's previous transaction left it,
   * and everything that spends. Only ever runs inside the lock, through `#submitLocked`.
   */
  async #bundle(input: BundleInput, state: BundleState): Promise<SelfBundleOutcome> {
    const { client, db, now, log } = this.deps;
    const executor = this.deps.executor!;
    const floatAlertWei = this.deps.floatAlertWei!;
    const timeout = this.#readTimeoutMs;
    const { request, relayer, packed, data, fees, userOperation } = input;
    const fallback = (reason: string): SelfBundleOutcome => {
      log.info(
        { sender: request.sender, userOpHash: request.userOpHash, reason },
        'self-bundle declined, forwarding to Pimlico',
      );
      return { kind: 'fallback', reason };
    };

    input.mark?.('lock');
    const generation = this.deps.lock.generation;
    // The nonce held from the bundle just before this task, if nothing ran in between.
    const remembered =
      this.#nonceMemory !== undefined && generation === this.#nonceMemory.generation + 1
        ? this.#nonceMemory.next
        : undefined;
    this.#nonceMemory = undefined;

    // Settle what can be settled first, so a bundle that landed late is not still counted
    // against the allowance at its worst case. Then read the allowance, inside the lock.
    await this.#reconcile();
    const closed = this.#closed();
    if (closed) return fallback(closed);

    // The reads made outside the lock stand only if no relayer-key task ran between them
    // and this one (see `SelfBundlePrefetch`); otherwise read again, here.
    const pre = input.prefetch;
    const reused =
      pre !== undefined &&
      pre.op === request.op &&
      pre.snapshot.idle &&
      generation === pre.snapshot.generation + 1;
    const [estimate, simulation, nonceRead, block, balance, delegated] = reused
      ? await pre!.reads
      : await readBundleInputs(client, timeout, {
          relayer,
          sender: request.sender,
          data,
          fees,
          userOperation,
          skipNonce: false,
        });
    /*
     * The nonce is always read, alongside the other five reads, so it costs no round trip.
     * The higher of the read and the memory is signed (security review, R9): a read below
     * the memory is a node that has not caught up with the bundle just mined, and a read
     * above it is a transaction from outside this process's lock (an operator script, a
     * second process during a deploy), which a remembered nonce alone would collide with.
     */
    let nonce: Read<string> | undefined = nonceRead;
    if (remembered !== undefined) {
      const fresh = nonceRead?.ok ? BigInt(nonceRead.value) : undefined;
      if (fresh !== undefined && fresh > BigInt(remembered)) {
        log.warn(
          { remembered, read: fresh.toString() },
          'self-bundle nonce memory was behind the chain; using the chain',
        );
      } else {
        nonce = { ok: true, value: toHex(remembered) };
      }
    }
    input.mark?.('bundle-reads', { reused, nonceFromMemory: nonce !== nonceRead });

    if (!delegated) return fallback('the sender is not delegated to Simple7702Account');
    if (!block.ok) return fallback(`could not read the base fee: ${block.reason}`);
    const baseFee = BigInt(block.value.baseFeePerGas);
    const floor =
      (baseFee * SELF_BUNDLE_MIN_FEE_OVER_BASE.numerator) /
      SELF_BUNDLE_MIN_FEE_OVER_BASE.denominator;
    if (fees.maxFeePerGas < floor) {
      return fallback(
        'the operation’s max fee is too close to the base fee to be sure of inclusion',
      );
    }
    if (fees.maxFeePerGas > baseFee * SELF_BUNDLE_MAX_FEE_OVER_BASE) {
      return fallback('the operation’s max fee is above the self-bundling ceiling');
    }
    if (!nonce?.ok) return fallback(`could not read the relayer nonce: ${nonce?.reason ?? 'not read'}`);
    if (!balance.ok) return fallback(`could not read the relayer balance: ${balance.reason}`);
    this.#logFloatTransition(balance.value, floatAlertWei);
    // A handleOps revert is FailedOp: validation, nonce, prefund. Pimlico would meet the
    // same answer and word it its own way, which is what the browser has always seen.
    if (!estimate.ok) return fallback(`handleOps would revert: ${estimate.reason}`);
    if (!simulation.ok) return fallback(`the bundle could not be simulated: ${simulation.reason}`);

    const simulated = simulation.value[0]?.calls[0];
    if (!simulated || simulated.status !== '0x1') {
      return fallback(
        `the simulated bundle reverted: ${describeHandleOpsRevert(simulated?.returnData as Hex | undefined)}`,
      );
    }
    const event = findUserOperationEvent(simulated.logs ?? [], request.userOpHash);
    if (!event) return fallback('the simulated bundle carried no event for this operation');
    if (!event.args.success) {
      // The operation's own call reverts. It would be mined and charged, and fail. The
      // chain's own answer, as for a revert found during the estimate.
      const unwrapped = unwrapAccountRevert(event.revertReason).data;
      return {
        kind: 'refused',
        message: describeInnerRevert(event.revertReason),
        ...(unwrapped ? { revertData: unwrapped } : {}),
      };
    }

    /*
     * The outer gas limit. `eth_estimateGas(handleOps)` is the least that clears the
     * EntryPoint's check that the inner call can still be given its full callGasLimit
     * (AA95). It was found with the call using what it uses now. If the book moves and the
     * call uses up to its whole limit, the EntryPoint still has to update the deposit, emit
     * UserOperationEvent and pay the beneficiary (a 9,000-gas value transfer) out of what
     * the inner call hands back plus the 1/64 it kept. The slack covers that.
     *
     * Monad charges all of it, so it is also what the relayer pays.
     */
    const gasLimit = BigInt(estimate.value) + SELF_BUNDLE_GAS_SLACK;
    const repaid = event.args.actualGasUsed;
    if (repaid < gasLimit) {
      return fallback(
        `would not net zero: the EntryPoint repays ${repaid} gas against a ${gasLimit} gas limit`,
      );
    }

    // The most this transaction can cost: every unit of its limit at its max fee.
    const worstCase = gasLimit * fees.maxFeePerGas;
    // Self-bundling's own allowance: the per-bundle cap, the loss limit, the in-flight cap
    // and the float floor, read and reserved in one transaction. No sponsorship budget is
    // read or drawn on.
    const reservation = db.reserveSelfBundle({
      address: request.sender,
      amountWei: worstCase,
      maxWorstCaseWei: SELF_BUNDLE_MAX_WORST_CASE_WEI,
      lossLimitWei: SELF_BUNDLE_LOSS_LIMIT_WEI,
      maxInFlight: SELF_BUNDLE_MAX_IN_FLIGHT,
      relayerBalanceWei: balance.value,
      floatFloorWei: floatAlertWei,
      now: now(),
      windowMs: HOUR,
    });
    if (!reservation.ok) {
      if (reservation.reason === 'float-floor') {
        log.warn(
          {
            balanceWei: balance.value.toString(),
            unsettledWei: reservation.unsettledWei.toString(),
            worstCaseWei: worstCase.toString(),
            floatAlertWei: floatAlertWei.toString(),
          },
          'self-bundle would take the relayer float to its alert line',
        );
      }
      return fallback(POOL_REFUSAL[reservation.reason]);
    }
    state.reservationId = reservation.id;
    // Before anything is sent, only this code holds the row, so it is always 'reserved'.
    const release = () => {
      db.settlePrefund(reservation.id, 'released', { now: now(), onlyFrom: ['reserved'] });
      state.settled = true;
    };
    // D201: splits the fee/nonce/balance/simulation checks and the SQLite reservation
    // write above (bundle-reads -> reserved) from the actual signature below
    // (reserved -> signed) — previously one unlabelled span (R9, D198).
    input.mark?.('reserved');

    let signed: SignedHandleOps;
    try {
      signed = await executor.signHandleOps({
        op: packed,
        gas: gasLimit,
        nonce: Number(BigInt(nonce.value)),
        ...fees,
      });
    } catch (error) {
      release();
      return fallback(`the bundle could not be signed: ${firstLine(error)}`);
    }
    input.mark?.('signed');
    if (signed.data.toLowerCase() !== data.toLowerCase()) {
      // Never send anything other than what was simulated.
      release();
      log.error(
        { sender: request.sender },
        'signed handleOps differs from the simulated one; not sent',
      );
      return fallback('the signed bundle differs from the simulated one');
    }

    /*
     * Send once, with viem's retries off: a retry is a second broadcast this code did not
     * decide to make. What happens next depends only on whether the transaction may have
     * gone out, never on how the failure was worded (review finding 1, 2026-09-24).
     *
     * `state.txHash` is set before the call, not after it. From the moment the request is
     * made the transaction may exist, and anything that throws from here on, however
     * unlikely, then leaves through `#submitLocked` as `submitted`, never as a fallback. It
     * is cleared only on the one path that proves nothing went out.
     */
    state.txHash = signed.hash;
    try {
      await withTimeout(
        client.request({ method: 'eth_sendRawTransaction', params: [signed.serialized] } as never, {
          retryCount: 0,
        }) as Promise<unknown>,
        timeout,
        'sending the bundle',
      );
    } catch (error) {
      // Refused by the node, or never sent at all — confirmed by both a receipt read
      // and a by-hash read, in case the node took it and then reported an error
      // anyway (R9 review, 2026-10-07; `provenNothingWentOut`). Ambiguous failures
      // are treated as sent, never as proof nothing happened.
      if (await provenNothingWentOut(client, error, signed.hash, timeout)) {
        // D201: the primary definitely took nothing, so the same signed bytes to a
        // second public node is never a double-send — one retry before giving up on
        // self-bundling for this operation (R9, 2026-10-07: a top-up broadcast failed
        // the same way on rpc.monad.xyz and went straight to Pimlico with no second
        // attempt). The retry is judged by the exact same rule as the primary: only a
        // retry failure that ITSELF proves nothing went out gives up; anything else
        // (a timeout, "already known", a 429, an internal error) is treated as sent,
        // the same as it would be for the primary (security review finding, 2026-10-08
        // — an earlier version of this code treated any retry failure as proof).
        const retryClient = this.deps.retryClient;
        if (!retryClient) {
          delete state.txHash;
          release();
          return fallback(`the node did not take the bundle (${classifySendFailure(error)}): ${firstLine(error)}`);
        }
        try {
          await withTimeout(
            retryClient.request(
              { method: 'eth_sendRawTransaction', params: [signed.serialized] } as never,
              { retryCount: 0 },
            ) as Promise<unknown>,
            timeout,
            'sending the bundle (second public RPC)',
          );
          log.warn(
            { sender: request.sender, txHash: signed.hash },
            'self-bundle send retried on the second public RPC after the primary took nothing',
          );
        } catch (retryError) {
          if (await provenNothingWentOut(retryClient, retryError, signed.hash, timeout)) {
            delete state.txHash;
            release();
            return fallback(
              `the node did not take the bundle (${classifySendFailure(error)}), and neither did the retry: ${firstLine(retryError)}`,
            );
          }
          log.warn(
            {
              sender: request.sender,
              txHash: signed.hash,
              err: firstLine(retryError),
              httpStatus: (retryError as { status?: unknown }).status ?? null,
            },
            'self-bundle send retry had no clear answer; treating it as sent',
          );
        }
      } else {
        // No clear answer from the primary. The transaction may be in flight, and a
        // node behind a load balancer can miss it by hash, so a miss here proves
        // nothing. Treat it as sent.
        log.warn(
          { sender: request.sender, txHash: signed.hash, err: firstLine(error), httpStatus: (error as { status?: unknown }).status ?? null },
          'self-bundle send had no clear answer; treating it as sent',
        );
      }
    }
    input.mark?.('sent');

    // From here the transaction may be on its way. It is never handed to Pimlico.
    const txHash = signed.hash;
    const submitted: SelfBundleOutcome = {
      kind: 'submitted',
      userOpHash: request.userOpHash,
      txHash,
    };
    // Tracked before the answer, so the browser's first receipt lookup finds it here.
    const tracked = this.#track(request.userOpHash, {
      txHash,
      reservationId: reservation.id,
      worstCase,
    });
    // Answered now, on the hash, as Pimlico answers (2026-09-24). What follows still runs
    // inside the lock, and none of it can turn this answer into a fallback.
    input.answer(submitted);
    // Durable at once: sent and not yet seen, with its hash, so a restart before the
    // receipt leaves a row the reconciliation sweep can find, not an anonymous reservation.
    db.settlePrefund(reservation.id, 'unconfirmed', {
      txHash,
      txNonce: Number(BigInt(nonce.value)),
      now: now(),
      onlyFrom: ['reserved'],
    });
    db.recordRelay({
      from: request.sender,
      to: ENTRY_POINT_V08,
      selector: HANDLE_OPS_SELECTOR,
      purpose: request.purpose,
      status: 'pending',
      txHash,
      now: now(),
    });

    const receipt = await waitForRawReceipt(client, txHash, {
      timeoutMs: this.deps.receiptTimeoutMs ?? SELF_BUNDLE_RECEIPT_TIMEOUT_MS,
      pollMs: this.deps.receiptPollMs ?? SELF_BUNDLE_RECEIPT_POLL_MS,
      readTimeoutMs: timeout,
    });
    if (!receipt) {
      // Sent and not seen. It may still land, so the row stays 'unconfirmed' at its worst
      // case; a later receipt lookup or the next bundle's sweep settles it.
      log.warn(
        { sender: request.sender, txHash, userOpHash: request.userOpHash },
        'self-bundle sent without a receipt',
      );
      return submitted;
    }

    // Idempotent: if the browser's receipt lookup settled it first, this changes nothing.
    const settled = this.#settleFromReceipt(tracked, receipt, request.userOpHash);
    state.settled = true;
    if (settled.bundleReverted) {
      /*
       * The bundle reverted, or ran without this operation's event: the operation did not
       * run in it. It may have run elsewhere, which is the usual reason a bundle that
       * simulated cleanly reverts, so it is not handed to Pimlico either. The receipt
       * lookup finds it by hash wherever it ran. Charged to self-bundling's loss limit by
       * `#settleFromReceipt`.
       */
      tracked.bundleReverted = true;
      log.warn(
        { sender: request.sender, txHash, costWei: settled.cost.toString() },
        'self-bundle reverted; the relayer paid for it',
      );
      return submitted;
    }

    if (settled.result) tracked.result = settled.result;
    // Mined, as signed, with nothing in between: the next nonce is known (R9).
    this.#nonceMemory = { next: Number(BigInt(nonce.value)) + 1, generation };
    if (settled.result && request.sponsored && this.deps.onLanded) {
      try {
        this.deps.onLanded({
          sender: request.sender,
          userOpHash: request.userOpHash,
          actualGasCost: BigInt(settled.result.actualGasCost as Hex),
          success: settled.result.success === true,
        });
      } catch {
        /* a refill that could not be scheduled changes nothing here */
      }
    }
    const net = settled.net ?? 0n;
    const detail = {
      sender: request.sender,
      txHash,
      userOpHash: request.userOpHash,
      gasLimit: gasLimit.toString(),
      actualGasUsed: BigInt(settled.result!.actualGasUsed as Hex).toString(),
      costWei: settled.cost.toString(),
      netWei: net.toString(),
    };
    if (net >= 0n) log.info(detail, 'self-bundled user operation');
    else log.warn(detail, 'self-bundled user operation cost the relayer more than it was repaid');
    return submitted;
  }
}
