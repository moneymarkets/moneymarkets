import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  createPublicClient,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  http,
  keccak256,
  parseTransaction,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import {
  entryPoint08Abi,
  formatUserOperationRequest,
  formatUserOperationReceipt,
  getUserOperationHash,
  getUserOperationTypedData,
  toSimple7702SmartAccount,
  type UserOperation,
} from 'viem/account-abstraction';
import {
  buildDeposit,
  delegationCodeFor,
  ENTRY_POINT_V08,
  ENTRYPOINT_TOPUP_WEI,
  MAX_RELAYER_FLOAT_WEI,
  MEASURED_PRE_VERIFICATION_GAS,
  MEASURED_VERIFICATION_GAS_LIMIT,
  monad,
  planUserOperationGas,
  PREFUND_BUDGETS,
  prefundHeadroom,
  rpcUserOperationSchema,
  SIMPLE_7702_DELEGATE,
  tighten,
  userOperationHashOf,
} from '@tradepro/core';
import { isolateEnv } from './testEnv.js';
import { buildServer } from './server.js';
import { TargetAllowlist } from './allowlist.js';
import { RelayerDb } from './db.js';
import { floatAlertThresholdWei, type RelayerConfig } from './config.js';
import {
  liveTopUpExecutor,
  RECEIPT_POLL_MS,
  SerialLock,
  type TopUpExecutor,
} from './prefund.js';
import {
  buildUserOperationReceipt,
  classifySendFailure,
  RATE_LIMITED_RECHECK_MS,
  describeHandleOpsRevert,
  findUserOperationEvent,
  HANDLE_OPS_SELECTOR,
  handleOpsCalldata,
  liveBundleExecutor,
  packUserOperation,
  relayerNetWei,
  RESERVE_VIOLATION_MESSAGE,
  SELF_BUNDLE_GAS_SLACK,
  SELF_BUNDLE_LOSS_LIMIT_WEI,
  SELF_BUNDLE_MAX_IN_FLIGHT,
  SELF_BUNDLE_MAX_WORST_CASE_WEI,
  SelfBundler,
  simulateInnerCall,
  type BundleExecutor,
  type RawReceipt,
} from './selfBundle.js';

/**
 * Self-bundling, pinned to real chain data.
 *
 * `fixtures/selfBundle.mainnet.json` was recorded on 2026-09-24 from rpc.monad.xyz and,
 * for Pimlico's receipts, from production's own `/api/submit`. It holds the five
 * profiling bundles (transaction, raw receipt, the bundler's balance either side of the
 * block, Pimlico's receipt answer) and the node's exact answers to the reads this module
 * makes. The accounting, packing, hashing and receipt tests below run against those
 * bytes. The route tests build their chain answers by editing the recorded receipt, not
 * by writing a plausible one.
 *
 * Nothing here can sign with a real key or reach a network: every executor is built on a
 * throwaway key, every client's fetch is a function in this file.
 */

interface Bundle {
  readonly hash: Hex;
  readonly baseFeePerGas: Hex;
  readonly transaction: {
    readonly from: Address;
    readonly gas: Hex;
    readonly input: Hex;
  };
  readonly receipt: RawReceipt;
  readonly userOpHash: Hex;
  readonly bundlerBalanceBefore: string;
  readonly bundlerBalanceAfter: string;
  readonly pimlicoReceipt: Record<string, unknown> & { receipt: Record<string, unknown> };
}
interface RpcAnswer {
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: Hex };
}
const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/selfBundle.mainnet.json', import.meta.url), 'utf8'),
) as { bundles: Bundle[]; rpc: Record<string, RpcAnswer> };

const hi = (word: Hex) => BigInt(word) >> 128n;
const lo = (word: Hex) => BigInt(word) & ((1n << 128n) - 1n);
const GWEI = 10n ** 9n;
const MON = 10n ** 18n;

interface PackedOp {
  sender: Address;
  nonce: bigint;
  initCode: Hex;
  callData: Hex;
  accountGasLimits: Hex;
  preVerificationGas: bigint;
  gasFees: Hex;
  paymasterAndData: Hex;
  signature: Hex;
}

function decodeBundle(bundle: Bundle) {
  const decoded = decodeFunctionData({ abi: entryPoint08Abi, data: bundle.transaction.input });
  const [ops, beneficiary] = decoded.args as unknown as [readonly PackedOp[], Address];
  const packed = ops[0]!;
  const op = rpcUserOperationSchema.parse({
    sender: packed.sender,
    nonce: toHex(packed.nonce),
    callData: packed.callData,
    callGasLimit: toHex(lo(packed.accountGasLimits)),
    verificationGasLimit: toHex(hi(packed.accountGasLimits)),
    preVerificationGas: toHex(packed.preVerificationGas),
    maxFeePerGas: toHex(lo(packed.gasFees)),
    maxPriorityFeePerGas: toHex(hi(packed.gasFees)),
    signature: packed.signature,
  });
  return { packed, beneficiary, op, opsInBundle: ops.length };
}

/** EntryPoint v0.8 `_getUserOpGasPrice`. */
const userOpGasPrice = (maxFee: bigint, priority: bigint, baseFee: bigint) =>
  maxFee === priority ? maxFee : maxFee < priority + baseFee ? maxFee : priority + baseFee;
/** EIP-1559's effective gas price for a transaction. */
const effectiveGasPrice = (maxFee: bigint, priority: bigint, baseFee: bigint) =>
  maxFee < priority + baseFee ? maxFee : priority + baseFee;

describe('what the chain actually charges and repays (recorded 2026-09-24)', () => {
  it('Monad charges the bundler its gas LIMIT: every receipt reports gasUsed == gas', () => {
    for (const bundle of fixture.bundles) {
      expect(BigInt(bundle.receipt.gasUsed)).toBe(BigInt(bundle.transaction.gas));
    }
  });

  it('relayerNetWei equals the bundler’s real balance change, to the wei, on all five', () => {
    // Pimlico's bundler was its own beneficiary and sent one transaction in each block,
    // so its balance moved by exactly repayment minus charge.
    for (const bundle of fixture.bundles) {
      const event = findUserOperationEvent(bundle.receipt.logs, bundle.userOpHash);
      if (!event) throw new Error(`no UserOperationEvent in ${bundle.hash}`);
      const net = relayerNetWei({
        actualGasCost: event.args.actualGasCost,
        gasUsed: BigInt(bundle.receipt.gasUsed),
        effectiveGasPrice: BigInt(bundle.receipt.effectiveGasPrice),
      });
      expect(net).toBe(BigInt(bundle.bundlerBalanceAfter) - BigInt(bundle.bundlerBalanceBefore));
    }
  });

  it('the EntryPoint priced every operation at min(maxFee, priority + basefee)', () => {
    for (const bundle of fixture.bundles) {
      const { packed } = decodeBundle(bundle);
      const event = findUserOperationEvent(bundle.receipt.logs, bundle.userOpHash)!;
      const price = userOpGasPrice(
        lo(packed.gasFees),
        hi(packed.gasFees),
        BigInt(bundle.baseFeePerGas),
      );
      expect(event.args.actualGasCost).toBe(event.args.actualGasUsed * price);
    }
  });

  it('the measured constants are what the five operations carried', () => {
    const vgl = fixture.bundles.map((b) => hi(decodeBundle(b).packed.accountGasLimits));
    const pvg = fixture.bundles.map((b) => decodeBundle(b).packed.preVerificationGas);
    expect(new Set(vgl)).toEqual(new Set([MEASURED_VERIFICATION_GAS_LIMIT]));
    expect(pvg.reduce((a, b) => (b > a ? b : a))).toBe(MEASURED_PRE_VERIFICATION_GAS);
    expect(pvg.every((v) => v <= MEASURED_PRE_VERIFICATION_GAS)).toBe(true);
    expect(fixture.bundles.every((b) => decodeBundle(b).opsInBundle === 1)).toBe(true);
  });
});

describe('the relayer submits exactly the operation whose signature it checked', () => {
  it('packing the verified operation reproduces the mined bundle byte for byte', () => {
    for (const bundle of fixture.bundles) {
      const { packed, beneficiary, op } = decodeBundle(bundle);
      expect(packUserOperation(op)).toEqual(packed);
      expect(handleOpsCalldata(packUserOperation(op), beneficiary)).toBe(bundle.transaction.input);
    }
    expect(HANDLE_OPS_SELECTOR).toBe(fixture.bundles[0]!.transaction.input.slice(0, 10));
  });

  it('the hash the signature check computes is the hash the EntryPoint emitted', () => {
    for (const bundle of fixture.bundles) {
      const hashed = userOperationHashOf(decodeBundle(bundle).op, {
        chainId: 143,
        entryPoint: ENTRY_POINT_V08,
      });
      expect(hashed.ok && hashed.hash).toBe(bundle.userOpHash);
    }
  });
});

describe('eth_getUserOperationReceipt is answered in Pimlico’s shape', () => {
  const lowerHex = (value: unknown): unknown =>
    typeof value === 'string' && value.startsWith('0x')
      ? value.toLowerCase()
      : Array.isArray(value)
        ? value.map(lowerHex)
        : value && typeof value === 'object'
          ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, lowerHex(v)]))
          : value;

  it('matches Pimlico’s recorded answer for all five, field for field', () => {
    for (const bundle of fixture.bundles) {
      const ours = buildUserOperationReceipt(bundle.userOpHash, bundle.receipt);
      if (!ours) throw new Error('no receipt built');
      const {
        receipt: ourReceipt,
        logs: ourLogs,
        ...ourRest
      } = ours as {
        receipt: Record<string, unknown>;
        logs: Array<Record<string, unknown>>;
      };
      const {
        receipt: theirReceipt,
        logs: theirLogs,
        ...theirRest
      } = bundle.pimlicoReceipt as {
        receipt: Record<string, unknown>;
        logs: Array<Record<string, unknown>>;
      };
      expect(ourRest).toEqual(theirRest);
      // The node writes addresses lowercased and adds `removed` and `blockTimestamp`.
      // Every field Pimlico gives is present with the same value; consumers compare
      // addresses case-insensitively (`orderIdsCreatedFor`).
      const sameLogs = (
        ours: Array<Record<string, unknown>>,
        theirs: Array<Record<string, unknown>>,
      ) => {
        expect(ours).toHaveLength(theirs.length);
        theirs.forEach((log, i) => {
          for (const [key, value] of Object.entries(log)) {
            expect(lowerHex(ours[i]![key])).toEqual(lowerHex(value));
          }
        });
      };
      sameLogs(ourLogs, theirLogs);
      for (const [key, value] of Object.entries(theirReceipt)) {
        if (key === 'logs') {
          sameLogs(
            ourReceipt.logs as Array<Record<string, unknown>>,
            value as Array<Record<string, unknown>>,
          );
        } else {
          expect(lowerHex(ourReceipt[key])).toEqual(lowerHex(value));
        }
      }
      // And viem reads ours as it reads theirs.
      const formatted = formatUserOperationReceipt(ours as never);
      expect(formatted.success).toBe(true);
      expect(formatted.receipt.transactionHash).toBe(bundle.hash);
    }
  });
});

// ---------------------------------------------------------------------------------------
// A chain behind a real viem HTTP client
// ---------------------------------------------------------------------------------------

/**
 * `hang`: the request reached the chain and no answer ever comes back.
 * `refused-connection`: the connection was never made, as Node's fetch reports it.
 */
type Handler = (
  params: unknown[],
) => RpcAnswer | Promise<RpcAnswer> | 'hang' | 'refused-connection' | 'http-429';

function clientFor(
  handlers: Record<string, Handler>,
  log: string[] = [],
  retryCount = 0,
): PublicClient {
  const fetchFn = async (_url: unknown, init?: { body?: unknown }) => {
    const request = JSON.parse(String(init?.body)) as {
      id: number;
      method: string;
      params: unknown[];
    };
    log.push(request.method);
    const handler = handlers[request.method];
    const answer = handler
      ? await handler(request.params)
      : { error: { code: -32601, message: `the test chain does not answer ${request.method}` } };
    if (answer === 'hang') return new Promise<Response>(() => {});
    // A rate limiter in front of the node: viem turns this into a real HttpRequestError.
    if (answer === 'http-429') return new Response('Too Many Requests', { status: 429 });
    if (answer === 'refused-connection') {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8545'), {
          code: 'ECONNREFUSED',
        }),
      });
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...answer }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return createPublicClient({
    chain: monad,
    transport: http('http://chain.test', {
      retryCount,
      retryDelay: 1,
      fetchFn: fetchFn as typeof fetch,
    }),
  }) as PublicClient;
}

const GATE = '0x43a275C3Eb0BE7313f847FFA4fb6Bd366606A961' as Address;

describe('the inner-call read: a revert is the chain’s answer, anything else is not', () => {
  const read = (answer: RpcAnswer | 'hang', timeoutMs?: number) =>
    simulateInnerCall(clientFor({ eth_estimateGas: () => answer }), GATE, '0x1234', timeoutMs);

  it('a clean estimate', async () => {
    // 0x3ecd2: a 1 MON market sell on MON/USDC, estimated at recording time.
    expect(await read(fixture.rpc.estimateOkMarketSell!)).toEqual({ kind: 'ok', gas: 257_234n });
  });

  it('Kuru’s own revert, decoded, with the selector kept for the browser', async () => {
    const result = await read(fixture.rpc.estimateRevertKuru!);
    expect(result.kind).toBe('reverted');
    if (result.kind !== 'reverted') return;
    expect(result.revertData).toBe('0xf4d678b8');
    expect(result.message).toContain('InsufficientBalance');
    expect(result.message).toContain('0xf4d678b8');
  });

  it('a batch revert is unwrapped from ExecuteError to the call that failed', async () => {
    const result = await read(fixture.rpc.estimateRevertBatch!);
    if (result.kind !== 'reverted') throw new Error(result.kind);
    expect(result.revertData).toBe('0xf4d678b8');
    expect(result.message).toContain('call 2 of the batch');
    expect(result.message).toContain('InsufficientBalance');
  });

  it('a revert with no reason is still a revert', async () => {
    const result = await read(fixture.rpc.estimateRevertEmpty!);
    if (result.kind !== 'reverted') throw new Error(result.kind);
    expect(result.message).toContain('gave no reason');
  });

  it('the delegate’s own string revert reads as the chain’s words, not as Kuru’s', async () => {
    // Recorded from rpc.monad.xyz, 2026-09-24: `execute` sent to the gate account by a
    // stranger. Error(string) "not from self or EntryPoint".
    const result = await read({
      error: {
        code: 3,
        message: 'execution reverted: not from self or EntryPoint',
        data: '0x08c379a00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000001b6e6f742066726f6d2073656c66206f7220456e747279506f696e740000000000',
      },
    });
    if (result.kind !== 'reverted') throw new Error(result.kind);
    expect(result.message).toContain('“not from self or EntryPoint”');
    expect(result.message).not.toContain('Kuru');
  });

  it('Monad’s reserve refusal is the chain’s answer, not an RPC failure (rule 1.8 wrap)', async () => {
    // Recorded from rpc.monad.xyz, 2026-09-29: `execute(WMON, 1, deposit())` estimated by
    // the delegated gate account (0.014 MON) sent to itself.
    const result = await read({ error: { code: -32000, message: 'reserve balance violation' } });
    expect(result.kind).toBe('reverted');
    if (result.kind !== 'reverted') return;
    expect(result.message).toBe(RESERVE_VIOLATION_MESSAGE);
    // The browser's existing reserve line (`bundlerTransport.ts`) keys on this phrase.
    expect(result.message).toMatch(/needs at least \d+ MON/i);
  });

  it('an RPC error, an HTTP failure or a timeout is unavailable, never a revert', async () => {
    expect((await read({ error: { code: -32603, message: 'internal error' } })).kind).toBe(
      'unavailable',
    );
    expect((await read({ error: { code: -32005, message: 'limit exceeded' } })).kind).toBe(
      'unavailable',
    );
    expect((await read('hang', 30)).kind).toBe('unavailable');
    const failing = createPublicClient({
      chain: monad,
      transport: http('http://chain.test', {
        retryCount: 0,
        fetchFn: (async () => new Response('bad gateway', { status: 502 })) as typeof fetch,
      }),
    }) as PublicClient;
    expect((await simulateInnerCall(failing, GATE, '0x1234')).kind).toBe('unavailable');
  });

  it('a handleOps revert decodes to the EntryPoint’s own words', () => {
    expect(describeHandleOpsRevert(fixture.rpc.handleOpsStaleOp!.error!.data)).toBe(
      'FailedOp: AA25 invalid account nonce',
    );
  });
});

describe('net zero on the price axis is an identity, not a tolerance', () => {
  it('with the operation’s own fees, the relayer pays per gas exactly what it is repaid per gas', () => {
    // Every combination a valid transaction can carry, including the maxFee == priority
    // branch of the EntryPoint's formula. Monad's base fee was 100 gwei on all five blocks.
    const fees = [
      0n,
      1n,
      2n * GWEI,
      4n * GWEI,
      100n * GWEI,
      104n * GWEI,
      244n * GWEI,
      1_000n * GWEI,
    ];
    let checked = 0;
    for (const baseFee of [0n, 1n, 100n * GWEI, 150n * GWEI]) {
      for (const maxFee of fees) {
        for (const priority of fees) {
          if (priority > maxFee || maxFee < baseFee) continue; // not a includable transaction
          expect(effectiveGasPrice(maxFee, priority, baseFee)).toBe(
            userOpGasPrice(maxFee, priority, baseFee),
          );
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('so the net is (repaid gas - gas limit) x price, exactly', () => {
    const price = 104n * GWEI;
    for (const [repaidGas, gasLimit] of [
      [574_000n, 485_000n],
      [485_000n, 485_000n],
      [400_000n, 485_000n],
    ] as const) {
      const net = relayerNetWei({
        actualGasCost: repaidGas * price,
        gasUsed: gasLimit,
        effectiveGasPrice: price,
      });
      expect(net).toBe((repaidGas - gasLimit) * price);
    }
  });
});

// ---------------------------------------------------------------------------------------
// The route, end to end, against an edited copy of the recorded bundle
// ---------------------------------------------------------------------------------------

const MARGIN = '0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5' as Address;
const AUSD = '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a' as Address;
const NOW_MS = 1_756_800_000_000 + 20 * 60_000;
const BASE_FEE = BigInt(fixture.bundles[1]!.baseFeePerGas);
/** The browser's fees on all five recorded operations. */
const OP_MAX_FEE = 244n * GWEI;
const OP_PRIORITY = 4n * GWEI;
const INNER_ESTIMATE = BigInt(fixture.rpc.estimateOkMarketSell!.result as Hex);

/*
 * The two figures the simulated EntryPoint reports. Not measured for this operation (no
 * such operation exists); worked from the trace of 0x1111dda6…, and within 1% of the live
 * dry run's 464,124 and 575,781 for a real 0.01 MON market sell.
 */
const HANDLE_OPS_ESTIMATE = 460_000n;
const REPAID_GAS = 574_000n;
const GAS_LIMIT = HANDLE_OPS_ESTIMATE + SELF_BUNDLE_GAS_SLACK;
/** What one bundle that reverts on chain costs the relayer at the browser's fees. */
const REVERTED_BUNDLE_COST = GAS_LIMIT * effectiveGasPrice(OP_MAX_FEE, OP_PRIORITY, BASE_FEE);
/** What one bundle reserves against self-bundling's allowance: its limit at its max fee. */
const WORST_CASE = GAS_LIMIT * OP_MAX_FEE;
/** The float alert line for `config` below: 20% of the 20 MON code cap. */
const FLOAT_ALERT_WEI = 4n * MON;

const config: RelayerConfig = {
  mode: 'mainnet',
  realFundsAcknowledged: true,
  rpcUrl: undefined,
  port: 0,
  maxFloatMon: 20,
  floatAlertPct: 20,
  rateLimitPerAddressHour: 10_000,
  rateLimitPerIpHour: 10_000,
  maxGas: 2_000_000n,
  maxDeadlineSeconds: 300,
  dbPath: ':memory:',
  hasSigningKey: false,
  hasPimlicoKey: true,
  metricsToken: undefined,
};

const relayerKey = privateKeyToAccount(`0x${'6b'.repeat(32)}` as Hex);
let keyCounter = 1;
const freshUser = () =>
  privateKeyToAccount(`0x${(0x5a00 + keyCounter++).toString(16).padStart(64, '0')}` as Hex);

type SendMode =
  | 'ok'
  /** The node refuses it with a validation error: nothing went out. */
  | 'refused'
  /** The node refuses it, yet it is findable by hash afterwards. */
  | 'refused-but-known'
  /** The request reaches the node, which takes the transaction and never answers. */
  | 'broadcast-then-hang'
  /** The node says a transaction with this nonce is already in its pool. */
  | 'already-known'
  /** The connection is never made. */
  | 'refused-connection'
  /** A JSON-RPC internal error, which viem retries by default, after the node took it. */
  | 'internal-error'
  /** HTTP 429 from a rate limiter; the node never saw it. */
  | 'rate-limited'
  /** HTTP 429 from a rate limiter, after the node took it anyway. */
  | 'rate-limited-but-taken';

interface Scenario {
  inner: RpcAnswer;
  handleOpsEstimate: RpcAnswer;
  simulated: { success: boolean; repaidGas: bigint; revertReason?: Hex } | RpcAnswer;
  mined: { status: '0x1' | '0x0'; repaidGas: bigint; success: boolean } | 'never';
  sendRaw: SendMode;
  /** `eth_getTransactionByHash` misses even a transaction it has, as a load-balanced node can. */
  hashLookupMisses: boolean;
  /** The relayer's finalized nonce, `eth_getTransactionCount(.., 'finalized')`. */
  minedNonce: bigint;
  /** Every `eth_getTransactionReceipt` fails. */
  receiptReadFails: boolean;
  /** The finalized nonce read fails. */
  nonceReadFails: boolean;
  /** Every `eth_getTransactionByHash` fails. */
  hashReadFails: boolean;
  delegated: boolean;
  deposit: bigint;
  /** The relayer key's own MON balance, as `eth_getBalance` reports it. */
  relayerBalance: bigint;
}

const happy = (): Scenario => ({
  inner: fixture.rpc.estimateOkMarketSell!,
  handleOpsEstimate: { result: toHex(HANDLE_OPS_ESTIMATE) },
  simulated: { success: true, repaidGas: REPAID_GAS },
  mined: { status: '0x1', repaidGas: REPAID_GAS, success: true },
  sendRaw: 'ok',
  hashLookupMisses: false,
  minedNonce: 7n,
  receiptReadFails: false,
  nonceReadFails: false,
  hashReadFails: false,
  delegated: true,
  deposit: 1n * MON,
  relayerBalance: 20n * MON,
});

/** Who an EntryPoint `handleOps` calldata is for, read the way the EntryPoint reads it. */
function operationIn(data: Hex): { userOpHash: Hex; sender: Address; nonce: bigint } {
  const [ops] = decodeFunctionData({ abi: entryPoint08Abi, data }).args as unknown as [
    readonly PackedOp[],
  ];
  const packed = ops[0]!;
  const userOpHash = getUserOperationHash({
    chainId: 143,
    entryPointAddress: ENTRY_POINT_V08,
    entryPointVersion: '0.8',
    userOperation: {
      sender: packed.sender,
      nonce: packed.nonce,
      callData: packed.callData,
      callGasLimit: lo(packed.accountGasLimits),
      verificationGasLimit: hi(packed.accountGasLimits),
      preVerificationGas: packed.preVerificationGas,
      maxFeePerGas: lo(packed.gasFees),
      maxPriorityFeePerGas: hi(packed.gasFees),
      signature: packed.signature,
    },
  });
  return { userOpHash, sender: packed.sender, nonce: packed.nonce };
}

/** The recorded receipt of 0x1111dda6…, with this operation's hash, sender and figures. */
function editedLogs(input: {
  userOpHash: Hex;
  sender: Address;
  nonce: bigint;
  success: boolean;
  repaidGas: bigint;
  price: bigint;
  txHash: Hex;
  revertReason?: Hex;
}) {
  const recorded = structuredClone(fixture.bundles[1]!.receipt.logs) as Array<
    Record<string, unknown>
  >;
  const [eventTopic] = encodeEventTopics({ abi: entryPoint08Abi, eventName: 'UserOperationEvent' });
  const out: Array<Record<string, unknown>> = [];
  for (const log of recorded) {
    log.transactionHash = input.txHash;
    if ((log.topics as Hex[])[0] === eventTopic) {
      if (input.revertReason) {
        out.push({
          ...log,
          topics: encodeEventTopics({
            abi: entryPoint08Abi,
            eventName: 'UserOperationRevertReason',
            args: { userOpHash: input.userOpHash, sender: input.sender },
          }),
          data: encodeAbiParameters(
            [{ type: 'uint256' }, { type: 'bytes' }],
            [input.nonce, input.revertReason],
          ),
        });
      }
      out.push({
        ...log,
        topics: encodeEventTopics({
          abi: entryPoint08Abi,
          eventName: 'UserOperationEvent',
          args: { userOpHash: input.userOpHash, sender: input.sender, paymaster: zeroAddress },
        }),
        data: encodeAbiParameters(
          [{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }],
          [input.nonce, input.success, input.repaidGas * input.price, input.repaidGas],
        ),
      });
    } else {
      out.push(log);
    }
  }
  return out;
}

class TestChain {
  scenario: Scenario = happy();
  readonly rpcLog: string[] = [];
  /** The third `eth_estimateGas` param of every read: its state override, when one was sent. */
  readonly estimateOverrides: unknown[] = [];
  /** Raw transactions the node has taken, whatever it answered. */
  readonly sent: Hex[] = [];
  /** Money-moving events in order: top-ups (from the harness) and bundle sends. */
  readonly events: string[] = [];
  readonly deposits = new Map<string, bigint>();
  /** How many times the client's transport retries, as a real one would. */
  retries = 0;
  /** An operation that ran in somebody else's bundle: its tx hash and figures. */
  readonly elsewhere = new Map<Hex, { txHash: Hex; data: Hex }>();
  /** While true, a bundle this relayer sent has no receipt yet: it is not mined. */
  receiptsHidden = false;
  /** Called on every finalized nonce read, between the sweep's two receipt reads. */
  onFinalizedNonceRead: (() => void) | undefined;
  /**
   * The next receipt read is held: `arrived` fires when it reaches the chain, and it
   * answers "no receipt" only once `until` resolves. Every read after it is answered as
   * normal. Lets one reader (the bundle's own wait) see nothing while another (the
   * browser's lookup) sees the receipt.
   */
  holdNextReceiptRead: { arrived: () => void; until: Promise<void> } | undefined;

  #receiptFor(
    txHash: Hex,
    data: Hex,
    mined: Exclude<Scenario['mined'], 'never'>,
    maxFee: bigint,
    tip: bigint,
  ) {
    const price = effectiveGasPrice(maxFee, tip, BASE_FEE);
    const { userOpHash, sender, nonce } = operationIn(data);
    return {
      ...fixture.bundles[1]!.receipt,
      transactionHash: txHash,
      status: mined.status,
      gasUsed: toHex(GAS_LIMIT), // Monad: the limit
      effectiveGasPrice: toHex(price),
      logs:
        mined.status === '0x1'
          ? editedLogs({
              userOpHash,
              sender,
              nonce,
              success: mined.success,
              repaidGas: mined.repaidGas,
              price,
              txHash,
            })
          : [],
    };
  }

  client(): PublicClient {
    const base = clientFor(
      {
        eth_getTransactionCount: () => ({ result: '0x0' }),
        eth_getCode: () => ({
          result: this.scenario.delegated ? delegationCodeFor(SIMPLE_7702_DELEGATE) : '0x',
        }),
        eth_estimateGas: (params) => {
          const tx = params[0] as { to: string };
          this.estimateOverrides.push(params[2]);
          return tx.to.toLowerCase() === ENTRY_POINT_V08.toLowerCase()
            ? this.scenario.handleOpsEstimate
            : this.scenario.inner;
        },
        eth_simulateV1: (params) => {
          const s = this.scenario.simulated;
          if ('error' in s || 'result' in s) return s as RpcAnswer;
          const sim = s as { success: boolean; repaidGas: bigint; revertReason?: Hex };
          const block = (
            params[0] as {
              blockStateCalls: Array<{ blockOverrides?: { time?: Hex }; calls: Array<{ data: Hex }> }>;
            }
          ).blockStateCalls[0]!;
          // Two shapes: self-bundling's own `[handleOps]`, and the relayer's funded-run check
          // before a top-up, `[depositTo, handleOps]` two minutes ahead (2026-09-24). The
          // bundle is the last call either way; the deposit call before it simply succeeds.
          const data = block.calls[block.calls.length - 1]!.data;
          const { userOpHash, sender, nonce } = operationIn(data);
          // Monad simulates at base fee zero (recorded): the repayment is priced at the
          // priority fee alone, which is why the relayer compares gas, not wei.
          const handle = {
            status: '0x1',
            returnData: '0x',
            logs: editedLogs({
              userOpHash,
              sender,
              nonce,
              success: sim.success,
              repaidGas: sim.repaidGas,
              price: OP_PRIORITY,
              txHash: `0x${'00'.repeat(32)}`,
              ...(sim.revertReason ? { revertReason: sim.revertReason } : {}),
            }),
          };
          return {
            result: [
              {
                // Monad honours blockOverrides.time (probed 2026-09-24, block 107,619,360).
                ...(block.blockOverrides?.time ? { timestamp: block.blockOverrides.time } : {}),
                calls:
                  block.calls.length === 2
                    ? [{ status: '0x1', returnData: '0x', logs: [] }, handle]
                    : [handle],
              },
            ],
          };
        },
        eth_getTransactionCount: (params) => {
          if (params[1] !== 'finalized') {
            // On Monad 'pending' equals 'latest', never behind what is finalized.
            const next = this.scenario.minedNonce > 7n ? this.scenario.minedNonce : 7n;
            return { result: toHex(next) };
          }
          if (this.scenario.nonceReadFails) return { error: { code: -32603, message: 'internal error' } };
          this.onFinalizedNonceRead?.();
          return { result: toHex(this.scenario.minedNonce) };
        },
        eth_getBlockByNumber: () => ({ result: { number: '0x1', baseFeePerGas: toHex(BASE_FEE) } }),
        eth_blockNumber: () => ({ result: '0x1000' }),
        eth_sendRawTransaction: (params) => {
          const raw = params[0] as Hex;
          this.events.push('bundle');
          switch (this.scenario.sendRaw) {
            case 'ok':
              this.sent.push(raw);
              return { result: keccak256(raw) };
            case 'refused':
              return {
                error: { code: -32000, message: 'insufficient funds for gas * price + value' },
              };
            case 'refused-but-known':
              this.sent.push(raw);
              return { error: { code: -32000, message: 'the node did not answer in time' } };
            case 'broadcast-then-hang':
              this.sent.push(raw);
              return 'hang';
            case 'already-known':
              this.sent.push(raw);
              return { error: { code: -32000, message: 'already known' } };
            case 'refused-connection':
              return 'refused-connection';
            case 'internal-error':
              this.sent.push(raw);
              return { error: { code: -32603, message: 'internal error' } };
            case 'rate-limited':
              return 'http-429';
            case 'rate-limited-but-taken':
              this.sent.push(raw);
              return 'http-429';
          }
        },
        eth_getTransactionByHash: (params) => {
          if (this.scenario.hashReadFails) return { error: { code: -32603, message: 'internal error' } };
          const known = this.sent.find((raw) => keccak256(raw) === params[0]);
          return { result: known && !this.scenario.hashLookupMisses ? { hash: params[0] } : null };
        },
        eth_getLogs: (params) => {
          const topics = (params[0] as { topics: Hex[] }).topics;
          const ran = this.elsewhere.get(topics[1]!.toLowerCase() as Hex);
          return {
            result: ran
              ? [{ address: ENTRY_POINT_V08, topics, data: '0x', transactionHash: ran.txHash }]
              : [],
          };
        },
        eth_getTransactionReceipt: async (params) => {
          if (this.scenario.receiptReadFails) return { error: { code: -32603, message: 'internal error' } };
          const hold = this.holdNextReceiptRead;
          if (hold) {
            this.holdNextReceiptRead = undefined;
            hold.arrived();
            await hold.until;
            return { result: null };
          }
          const hash = params[0] as Hex;
          const other = [...this.elsewhere.values()].find((e) => e.txHash === hash);
          if (other) {
            return {
              result: this.#receiptFor(
                hash,
                other.data,
                { status: '0x1', repaidGas: REPAID_GAS, success: true },
                OP_MAX_FEE,
                OP_PRIORITY,
              ),
            };
          }
          const raw = this.sent.find((r) => keccak256(r) === hash);
          const mined = this.scenario.mined;
          if (!raw || mined === 'never' || this.receiptsHidden) return { result: null };
          const tx = parseTransaction(raw);
          return {
            result: this.#receiptFor(
              hash,
              tx.data!,
              mined,
              tx.maxFeePerGas!,
              tx.maxPriorityFeePerGas!,
            ),
          };
        },
      },
      this.rpcLog,
      this.retries,
    );
    return Object.assign({}, base, {
      readContract: async ({
        functionName,
        args,
      }: {
        functionName: string;
        args: readonly unknown[];
      }) => {
        if (functionName === 'balanceOf') {
          return this.deposits.get(String(args[0]).toLowerCase()) ?? this.scenario.deposit;
        }
        if (functionName === 'getNonce') return (args[1] as bigint) << 64n;
        throw new Error(`the test chain was not expecting ${functionName}`);
      },
      getBalance: async () => this.scenario.relayerBalance,
    }) as unknown as PublicClient;
  }
}

function recordingTopUps(chain: TestChain, events: string[]) {
  const paid: Array<{ account: Address; amount: bigint }> = [];
  const executor: TopUpExecutor = {
    relayerAddress: () => relayerKey.address,
    async depositTo(account, amount) {
      events.push('top-up');
      paid.push({ account, amount });
      return `0x${paid.length.toString(16).padStart(64, '0')}` as Hex;
    },
    async waitForReceipt() {
      const last = paid[paid.length - 1]!;
      const key = last.account.toLowerCase();
      chain.deposits.set(key, (chain.deposits.get(key) ?? chain.scenario.deposit) + last.amount);
      return 'success';
    },
  };
  return { executor, paid };
}

function recordingUpstream() {
  const forwarded: Array<{ method: string; params: unknown[] }> = [];
  const upstream = async (payload: string) => {
    const parsed = JSON.parse(payload) as { id: number; method: string; params: unknown[] };
    forwarded.push({ method: parsed.method, params: parsed.params });
    return JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: 'pimlico' });
  };
  return { forwarded, upstream };
}

/** A clock the tests can move, so reconciliation's 15 s pace can be crossed. */
function clock() {
  const state = { t: NOW_MS };
  return { now: () => state.t, advance: (ms: number) => (state.t += ms) };
}

async function harness(
  options: {
    scenario?: Partial<Scenario>;
    executor?: 'live' | null;
    db?: RelayerDb;
    chain?: TestChain;
    timing?: { receiptTimeoutMs: number; receiptPollMs: number; readTimeoutMs?: number };
    /** The R9 background refill; off here unless a test is about it. */
    backgroundRefill?: boolean;
    /** D201: the second-RPC send retry, off (no client) unless a test is about it. */
    retryClient?: PublicClient;
  } = {},
) {
  const chain = options.chain ?? new TestChain();
  chain.scenario = { ...happy(), ...options.scenario };
  const db = options.db ?? new RelayerDb(':memory:');
  const events = chain.events;
  const time = clock();
  const { executor: topUps, paid } = recordingTopUps(chain, events);
  const { forwarded, upstream } = recordingUpstream();
  const allowlist = new TargetAllowlist(undefined as never, 'mainnet');
  allowlist.seed([
    { address: MARGIN, kind: 'marginAccount', symbol: 'MarginAccount', trustsForwarder: true },
  ]);
  const lock = new SerialLock();
  const app = await buildServer({
    config,
    gate: { mode: 'mainnet', runMode: 'live', realFundsAcknowledged: true },
    client: chain.client(),
    ...(options.retryClient ? { retryClient: options.retryClient } : {}),
    allowlist,
    db,
    now: time.now,
    topUpExecutor: topUps,
    backgroundRefill: options.backgroundRefill ?? false,
    bundlerUpstream: upstream,
    bundleExecutor:
      options.executor === null
        ? null
        : liveBundleExecutor({ mode: 'testnet', chainId: 143, loadAccount: () => relayerKey }),
    selfBundleTiming: options.timing ?? {
      receiptTimeoutMs: 100,
      receiptPollMs: 5,
      readTimeoutMs: 200,
    },
    relayerTxLock: lock,
  });
  /**
   * A self-bundle answers on its hash and then settles inside the relayer key's lock. This
   * resolves once everything queued on that lock, the settlement included, has finished.
   */
  const settled = () => lock.run(async () => {});
  return { app, chain, db, forwarded, paid, events, time, lock, settled };
}

/** A deposit call, encoded the way the 7702 account encodes one call. */
async function oneCall(user: PrivateKeyAccount): Promise<Hex> {
  const account = await toSimple7702SmartAccount({
    client: { chain: { id: 143 } } as never,
    owner: user,
  });
  return account.encodeCalls([
    { to: MARGIN, data: buildDeposit(MARGIN, user.address, AUSD, 1_000_000n).data, value: 0n },
  ]);
}

/** The limits this relayer's own estimate gives for the recorded inner estimate. */
function plannedLimits(callData: Hex) {
  const planned = planUserOperationGas({
    innerEstimate: INNER_ESTIMATE,
    callCount: 1,
    callDataBytes: BigInt((callData.length - 2) / 2),
  });
  if (!planned.ok) throw new Error(planned.reason);
  return planned.plan;
}

async function operation(
  user: PrivateKeyAccount,
  options: {
    estimate?: boolean;
    signer?: PrivateKeyAccount;
    maxFeePerGas?: bigint;
    tip?: bigint;
  } = {},
) {
  const callData = await oneCall(user);
  const limits = plannedLimits(callData);
  const nonce = BigInt(keyCounter++) << 64n;
  const userOperation: UserOperation<'0.8'> = {
    sender: user.address,
    nonce,
    callData,
    callGasLimit: options.estimate ? 0n : limits.callGasLimit,
    verificationGasLimit: options.estimate ? 0n : limits.verificationGasLimit,
    preVerificationGas: options.estimate ? 0n : limits.preVerificationGas,
    maxFeePerGas: options.maxFeePerGas ?? OP_MAX_FEE,
    maxPriorityFeePerGas: options.tip ?? OP_PRIORITY,
    signature: '0x',
  };
  const signature = await (options.signer ?? user).signTypedData(
    getUserOperationTypedData({ chainId: 143, entryPointAddress: ENTRY_POINT_V08, userOperation }),
  );
  const wire = formatUserOperationRequest({ ...userOperation, signature });
  const hashed = userOperationHashOf(rpcUserOperationSchema.parse(wire), {
    chainId: 143,
    entryPoint: ENTRY_POINT_V08,
  });
  if (!hashed.ok) throw new Error(hashed.reason);
  return { wire, userOpHash: hashed.hash, limits };
}

async function rpc(
  app: Awaited<ReturnType<typeof harness>>['app'],
  method: string,
  params: unknown[],
) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/bundler',
    payload: { jsonrpc: '2.0', id: 1, method, params },
  });
  return JSON.parse(res.body) as {
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
  };
}

const send = async (h: Awaited<ReturnType<typeof harness>>, wire: unknown) =>
  rpc(h.app, 'eth_sendUserOperation', [wire, ENTRY_POINT_V08]);

isolateEnv();

beforeEach(() => {
  process.env.LOG_LEVEL = 'silent';
  process.env.PIMLICO_API_KEY = 'test-key-not-a-secret';
});

describe('Part A: the relayer answers the estimate itself', () => {
  it('max(floor, inner estimate x 1.3) and a preVerificationGas scaled to them; Pimlico is never asked', async () => {
    const h = await harness();
    const { wire, limits } = await operation(freshUser(), { estimate: true });
    const body = await rpc(h.app, 'eth_estimateUserOperationGas', [wire, ENTRY_POINT_V08]);
    expect(body.result).toEqual({
      preVerificationGas: toHex(limits.preVerificationGas),
      verificationGasLimit: toHex(limits.verificationGasLimit),
      callGasLimit: toHex(limits.callGasLimit),
    });
    expect(limits.basis).toBe('estimate');
    expect(h.forwarded).toHaveLength(0);
  });

  it('a reverting inner call is refused with the chain’s reason, before any top-up, never via Pimlico', async () => {
    // An empty deposit: had the funding decision run first, it would have paid.
    const h = await harness({ scenario: { inner: fixture.rpc.estimateRevertKuru!, deposit: 0n } });
    for (const method of ['eth_estimateUserOperationGas', 'eth_sendUserOperation']) {
      const { wire } = await operation(freshUser(), { estimate: method.includes('estimate') });
      const body = await rpc(h.app, method, [wire, ENTRY_POINT_V08]);
      expect(body.error?.code).toBe(-32521);
      expect(body.error?.message).toContain('InsufficientBalance');
      expect(body.error?.data).toBe('0xf4d678b8');
    }
    expect(h.paid).toHaveLength(0);
    expect(h.forwarded).toHaveLength(0);
    expect(h.chain.sent).toHaveLength(0);
  });

  it('an RPC failure on the inner call goes to Pimlico exactly as before', async () => {
    const h = await harness({
      scenario: { inner: { error: { code: -32603, message: 'internal error' } } },
    });
    const { wire } = await operation(freshUser(), { estimate: true });
    const body = await rpc(h.app, 'eth_estimateUserOperationGas', [wire, ENTRY_POINT_V08]);
    expect(body.result).toBe('pimlico');
    expect(h.forwarded.map((f) => f.method)).toEqual(['eth_estimateUserOperationGas']);
  });

  it('an account not delegated to Simple7702Account is left to Pimlico, revert or not', async () => {
    const h = await harness({
      scenario: { delegated: false, inner: fixture.rpc.estimateRevertKuru! },
    });
    const { wire } = await operation(freshUser(), { estimate: true });
    expect((await rpc(h.app, 'eth_estimateUserOperationGas', [wire, ENTRY_POINT_V08])).result).toBe(
      'pimlico',
    );
  });

  it('a first operation, carrying its 7702 authorization, is planned here from a delegated simulation (owner items 1 and 3, D191)', async () => {
    const h = await harness();
    const user = freshUser();
    const { wire } = await operation(user, { estimate: true });
    // A real authorization by the account itself, at the transaction count this chain
    // reports: only a verified first operation is planned here (security review of D191,
    // finding 2).
    const count = await h.chain.client().getTransactionCount({ address: user.address });
    const auth = await user.signAuthorization({ address: SIMPLE_7702_DELEGATE, chainId: 143, nonce: count });
    const first = {
      ...wire,
      factory: '0x7702',
      eip7702Auth: {
        address: SIMPLE_7702_DELEGATE,
        chainId: '0x8f',
        nonce: `0x${count.toString(16)}`,
        r: auth.r,
        s: auth.s,
        yParity: `0x${(auth.yParity ?? 0).toString(16)}`,
      },
    };
    const body = await rpc(h.app, 'eth_estimateUserOperationGas', [first, ENTRY_POINT_V08]);
    // Answered here, not by Pimlico: the account's own call, simulated with the
    // delegation set by state override, since the account is not delegated yet.
    expect(body.result).toMatchObject({ callGasLimit: expect.any(String) });
    expect(h.forwarded).toHaveLength(0);
    expect(h.chain.rpcLog).toContain('eth_estimateGas');
    const override = h.chain.estimateOverrides.at(-1) as Record<string, { code: string }>;
    expect(Object.values(override)[0]?.code).toBe(delegationCodeFor(SIMPLE_7702_DELEGATE));
  });
});

describe('Part B: the relayer bundles the operation itself', () => {
  it('sends exactly handleOps([the verified op], relayer) at the op’s own fees, and nets >= 0', async () => {
    const h = await harness();
    const { wire, userOpHash } = await operation(freshUser());
    const body = await send(h, wire);

    expect(body.result).toBe(userOpHash);
    expect(h.forwarded).toHaveLength(0);
    expect(h.chain.sent).toHaveLength(1);

    const tx = parseTransaction(h.chain.sent[0]!);
    expect(tx.to?.toLowerCase()).toBe(ENTRY_POINT_V08.toLowerCase());
    expect(tx.value ?? 0n).toBe(0n);
    expect(tx.chainId).toBe(143);
    expect(tx.maxFeePerGas).toBe(OP_MAX_FEE);
    expect(tx.maxPriorityFeePerGas).toBe(OP_PRIORITY);
    expect(tx.gas).toBe(GAS_LIMIT);
    const [ops, beneficiary] = decodeFunctionData({ abi: entryPoint08Abi, data: tx.data! })
      .args as unknown as [readonly unknown[], Address];
    expect(beneficiary).toBe(relayerKey.address);
    expect(ops).toEqual([packUserOperation(rpcUserOperationSchema.parse(wire))]);

    // Net zero, from the receipt the relayer read: (repaid - limit) x price, not below 0.
    const receipt = (await rpc(h.app, 'eth_getUserOperationReceipt', [userOpHash])).result as {
      actualGasCost: Hex;
      receipt: { gasUsed: Hex; effectiveGasPrice: Hex };
    };
    const price = effectiveGasPrice(OP_MAX_FEE, OP_PRIORITY, BASE_FEE);
    const net = relayerNetWei({
      actualGasCost: BigInt(receipt.actualGasCost),
      gasUsed: BigInt(receipt.receipt.gasUsed),
      effectiveGasPrice: BigInt(receipt.receipt.effectiveGasPrice),
    });
    expect(net).toBe((REPAID_GAS - GAS_LIMIT) * price);
    expect(net).toBeGreaterThanOrEqual(0n);

    // The worst case was reserved against self-bundling's own allowance and released.
    await h.settled();
    const ledger = h.db.prefundLedger();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.purpose).toBe('self-bundle');
    expect(ledger[0]!.status).toBe('released');
    expect(h.db.findByTxHash(keccak256(h.chain.sent[0]!))?.status).toBe('success');
    // And the receipt was answered here, not by Pimlico.
    expect(h.forwarded).toHaveLength(0);
  });

  it('D172: the gas an operation burned in our own bundle is recorded from our receipt, a reverted batch included', async () => {
    for (const success of [true, false]) {
      const h = await harness({ scenario: { mined: { status: '0x1', repaidGas: REPAID_GAS, success } } });
      const user = freshUser();
      const { wire, userOpHash } = await operation(user);
      expect((await send(h, wire)).result).toBe(userOpHash);
      await h.settled();
      const price = effectiveGasPrice(OP_MAX_FEE, OP_PRIORITY, BASE_FEE);
      // Paid to us as the beneficiary, so a later paid top-up may replace it either way.
      expect(h.db.gasBurns(user.address)).toEqual([
        {
          userOpHash: userOpHash.toLowerCase(),
          block: BigInt(fixture.bundles[1]!.receipt.blockNumber as Hex),
          actualGasCost: REPAID_GAS * price,
          success,
          counted: true,
        },
      ]);
    }
  });

  it('a handleOps that would revert (the recorded AA25) goes to Pimlico, and nothing is sent or reserved', async () => {
    const h = await harness({ scenario: { handleOpsEstimate: fixture.rpc.handleOpsStaleOp! } });
    const { wire } = await operation(freshUser());
    expect((await send(h, wire)).result).toBe('pimlico');
    expect(h.chain.sent).toHaveLength(0);
    expect(h.db.prefundLedger()).toHaveLength(0);
    expect(h.forwarded.map((f) => f.method)).toEqual(['eth_sendUserOperation']);
  });

  it('a bundle the EntryPoint would repay less than it costs is not sent', async () => {
    const h = await harness({
      scenario: { simulated: { success: true, repaidGas: GAS_LIMIT - 1n } },
    });
    const { wire } = await operation(freshUser());
    expect((await send(h, wire)).result).toBe('pimlico');
    expect(h.chain.sent).toHaveLength(0);
  });

  it('an operation whose own call reverts in the bundle simulation is refused with the reason', async () => {
    const h = await harness({
      scenario: {
        simulated: { success: false, repaidGas: REPAID_GAS, revertReason: '0xf4d678b8' },
      },
    });
    const { wire } = await operation(freshUser());
    const body = await send(h, wire);
    expect(body.error?.code).toBe(-32521);
    expect(body.error?.message).toContain('InsufficientBalance');
    expect(h.chain.sent).toHaveLength(0);
    expect(h.forwarded).toHaveLength(0);
  });

  it('a send signed by someone else never reaches the signer', async () => {
    const h = await harness();
    const { wire } = await operation(freshUser(), { signer: freshUser() });
    const body = await send(h, wire);
    expect(body.error?.message).toBe('the operation is not signed by its sender');
    expect(h.chain.sent).toHaveLength(0);
  });

  it('the funding decision still runs first: a deposit below this op’s own prefund is topped up, then bundled', async () => {
    // 0.16 MON is above the old 0.15 minimum, below this operation's own prefund.
    const h = await harness({ scenario: { deposit: 160_000_000_000_000_000n } });
    const user = freshUser();
    const { wire, userOpHash } = await operation(user);
    const body = await send(h, wire);
    expect(body.result).toBe(userOpHash);
    expect(h.paid).toEqual([{ account: user.address, amount: 300_000_000_000_000_000n }]);
    expect(h.events).toEqual(['top-up', 'bundle']);
  });

  it('a server built around an injected client never gets a live signer by default', async () => {
    const chain = new TestChain();
    const allowlist = new TargetAllowlist(undefined as never, 'mainnet');
    allowlist.seed([
      { address: MARGIN, kind: 'marginAccount', symbol: 'MarginAccount', trustsForwarder: true },
    ]);
    const { forwarded, upstream } = recordingUpstream();
    const app = await buildServer({
      config,
      gate: { mode: 'mainnet', runMode: 'live', realFundsAcknowledged: true },
      client: chain.client(),
      allowlist,
      db: new RelayerDb(':memory:'),
      now: () => NOW_MS,
      topUpExecutor: recordingTopUps(chain, []).executor,
      bundlerUpstream: upstream,
    });
    const { wire } = await operation(freshUser());
    const res = await app.inject({
      method: 'POST',
      url: '/v1/bundler',
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_sendUserOperation',
        params: [wire, ENTRY_POINT_V08],
      },
    });
    // Everything passed and it went to Pimlico, because there was nothing to sign with.
    expect(JSON.parse(res.body).result).toBe('pimlico');
    expect(forwarded.map((f) => f.method)).toEqual(['eth_sendUserOperation']);
    expect(chain.sent).toHaveLength(0);
    const health = await app.inject({ method: 'GET', url: '/v1/health' });
    expect(JSON.parse(health.body).gasLayer.selfBundling).toBe(false);
  });
});

describe('review finding 1: once a bundle may have gone out, the operation never reaches Pimlico', () => {
  it('a send that times out after the node took it, and a hash lookup that misses, is treated as sent', async () => {
    // The reviewer's case exactly: the RPC is slow, the send times out, and a
    // load-balanced node misses the hash. Before the fix this went to Pimlico; if our
    // bundle landed first, Pimlico answered AA25 and the user signed the order again.
    const h = await harness({
      scenario: { sendRaw: 'broadcast-then-hang', hashLookupMisses: true },
    });
    const { wire, userOpHash } = await operation(freshUser());
    const body = await send(h, wire);
    expect(body.result).toBe(userOpHash);
    expect(h.forwarded).toHaveLength(0);
    expect(h.chain.sent).toHaveLength(1);
    // It did land: the receipt is answered here, and the reservation settled on it.
    const receipt = (await rpc(h.app, 'eth_getUserOperationReceipt', [userOpHash])).result as {
      success: boolean;
    };
    expect(receipt.success).toBe(true);
    await h.settled();
    expect(h.db.prefundLedger()[0]?.status).toBe('released');
    expect(h.forwarded).toHaveLength(0);
  });

  it('…and the same when it never lands: submitted, not confirmed, still never Pimlico', async () => {
    const h = await harness({
      scenario: { sendRaw: 'broadcast-then-hang', hashLookupMisses: true, mined: 'never' },
    });
    const { wire, userOpHash } = await operation(freshUser());
    expect((await send(h, wire)).result).toBe(userOpHash);
    expect((await rpc(h.app, 'eth_getUserOperationReceipt', [userOpHash])).result).toBeNull();
    await h.settled();
    expect(h.db.prefundLedger()[0]?.status).toBe('unconfirmed');
    expect(h.forwarded).toHaveLength(0);
  });

  it('“already known” means a transaction with this nonce is in the pool: treated as sent', async () => {
    const h = await harness({ scenario: { sendRaw: 'already-known', hashLookupMisses: true } });
    const { wire, userOpHash } = await operation(freshUser());
    expect((await send(h, wire)).result).toBe(userOpHash);
    expect(h.forwarded).toHaveLength(0);
  });

  it('a definite refusal from the node, before anything went out, goes to Pimlico with nothing held', async () => {
    const h = await harness({ scenario: { sendRaw: 'refused' } });
    const { wire } = await operation(freshUser());
    expect((await send(h, wire)).result).toBe('pimlico');
    expect(h.chain.sent).toHaveLength(0);
    expect(h.db.prefundLedger()[0]?.status).toBe('released');
  });

  it('D201: a refusal that proves nothing went out retries once on the second public RPC, and that one lands', async () => {
    const retryLog: string[] = [];
    const retryClient = clientFor(
      {
        eth_sendRawTransaction: () => ({ result: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
      },
      retryLog,
    );
    const h = await harness({ scenario: { sendRaw: 'refused' }, retryClient });
    const { wire, userOpHash } = await operation(freshUser());
    expect((await send(h, wire)).result).toBe(userOpHash);
    // The primary's own send still ran exactly once (the deliberate no-retry choice is
    // untouched); the retry client is the one that actually took the broadcast.
    expect(h.chain.rpcLog.filter((m) => m === 'eth_sendRawTransaction')).toHaveLength(1);
    expect(retryLog.filter((m) => m === 'eth_sendRawTransaction')).toHaveLength(1);
    expect(h.db.prefundLedger()[0]?.status).not.toBe('released');
  });

  it('D201: when the second public RPC also proves it took nothing, it still falls back to Pimlico with nothing held', async () => {
    const retryClient = clientFor({
      eth_sendRawTransaction: () => ({ error: { code: -32003, message: 'transaction rejected' } }),
      eth_getTransactionReceipt: () => ({ result: null }),
      eth_getTransactionByHash: () => ({ result: null }),
    });
    const h = await harness({ scenario: { sendRaw: 'refused' }, retryClient });
    const { wire } = await operation(freshUser());
    expect((await send(h, wire)).result).toBe('pimlico');
    expect(h.chain.sent).toHaveLength(0);
    expect(h.db.prefundLedger()[0]?.status).toBe('released');
  });

  it('D201 (security review): a retry failure that proves nothing, unlike one that is merely ambiguous, is the only one that still goes to Pimlico', async () => {
    // Same primary failure, same retry-side send error, but no receipt/hash handlers
    // on the retry client — every retry-side read fails, same as the primary's own
    // "no clear answer" path, which is treated as sent rather than as proof of
    // anything. An earlier version of this code treated any retry failure as proof
    // nothing went out, which would have sent this operation to Pimlico too —
    // risking the exact double-submission review finding 1 (2026-09-24) forbids.
    const retryClient = clientFor({
      eth_sendRawTransaction: () => ({ error: { code: -32003, message: 'transaction rejected' } }),
    });
    const h = await harness({ scenario: { sendRaw: 'refused' }, retryClient });
    const { wire, userOpHash } = await operation(freshUser());
    expect((await send(h, wire)).result).toBe(userOpHash);
    expect(h.db.prefundLedger()[0]?.status).not.toBe('released');
  });

  it('a connection never made goes to Pimlico with nothing held', async () => {
    const h = await harness({ scenario: { sendRaw: 'refused-connection' } });
    const { wire } = await operation(freshUser());
    expect((await send(h, wire)).result).toBe('pimlico');
    expect(h.db.prefundLedger()[0]?.status).toBe('released');
  });

  it('a refusal that turns out to be findable by hash is treated as sent', async () => {
    const h = await harness({ scenario: { sendRaw: 'refused-but-known' } });
    const { wire, userOpHash } = await operation(freshUser());
    expect((await send(h, wire)).result).toBe(userOpHash);
    expect(h.forwarded).toHaveLength(0);
  });

  it('the send goes out once, even through a transport that retries: a retry is a second broadcast', async () => {
    // viem retries a JSON-RPC internal error by default. The transport here retries three
    // times, as the relayer's real one does; the send turns that off for itself.
    const chain = new TestChain();
    chain.retries = 3;
    const h = await harness({ chain, scenario: { sendRaw: 'internal-error' } });
    const { wire, userOpHash } = await operation(freshUser());
    expect((await send(h, wire)).result).toBe(userOpHash);
    expect(h.chain.rpcLog.filter((m) => m === 'eth_sendRawTransaction')).toHaveLength(1);
    expect(h.forwarded).toHaveLength(0);
  });

  it('a bundle that reverts on chain is charged, answered as submitted, and never handed to Pimlico', async () => {
    const h = await harness({
      scenario: { mined: { status: '0x0', repaidGas: 0n, success: false } },
    });
    const { wire, userOpHash } = await operation(freshUser());
    expect((await send(h, wire)).result).toBe(userOpHash);
    expect(h.forwarded).toHaveLength(0);
    await h.settled();
    const [row] = h.db.prefundLedger();
    expect(row?.status).toBe('paid');
    expect(row?.amountWei).toBe(REVERTED_BUNDLE_COST);
    // It ran nowhere: no receipt, so the browser's wait ends in "sent, not confirmed".
    expect((await rpc(h.app, 'eth_getUserOperationReceipt', [userOpHash])).result).toBeNull();
  });

  it('when it reverted because a copy ran in someone else’s bundle, the receipt shows where it ran', async () => {
    const h = await harness({
      scenario: { mined: { status: '0x0', repaidGas: 0n, success: false } },
    });
    const { wire, userOpHash } = await operation(freshUser());
    expect((await send(h, wire)).result).toBe(userOpHash);
    const theirs = `0x${'ab'.repeat(32)}` as Hex;
    const ourData = parseTransaction(h.chain.sent[0]!).data!;
    h.chain.elsewhere.set(userOpHash.toLowerCase() as Hex, { txHash: theirs, data: ourData });
    const receipt = (await rpc(h.app, 'eth_getUserOperationReceipt', [userOpHash])).result as {
      success: boolean;
      receipt: { transactionHash: Hex };
    };
    expect(receipt.success).toBe(true);
    expect(receipt.receipt.transactionHash).toBe(theirs);
    expect(h.forwarded).toHaveLength(0);
  });
});

describe('review finding 2: the loss limit is read inside the lock, so it holds under concurrency', () => {
  it('concurrent requests queued before the limit is crossed do not send after it', async () => {
    // Every bundle reverts on chain: 0.05044 MON lost each. Two reach the 0.1 MON limit.
    // All six pass everything outside the lock at once and queue on it. Read outside the
    // lock, all six would have sent.
    expect(REVERTED_BUNDLE_COST * 2n).toBeGreaterThanOrEqual(SELF_BUNDLE_LOSS_LIMIT_WEI);
    expect(REVERTED_BUNDLE_COST).toBeLessThan(SELF_BUNDLE_LOSS_LIMIT_WEI);
    const h = await harness({
      scenario: { mined: { status: '0x0', repaidGas: 0n, success: false } },
    });
    const ops = await Promise.all(Array.from({ length: 6 }, () => operation(freshUser())));
    const answers = await Promise.all(ops.map((o) => send(h, o.wire)));
    expect(h.chain.sent).toHaveLength(2);
    expect(answers.filter((a) => a.result === 'pimlico')).toHaveLength(4);
  });

  it('the limit survives a restart: it is read from the ledger, not from memory', async () => {
    const db = new RelayerDb(':memory:');
    const first = await harness({
      db,
      scenario: { mined: { status: '0x0', repaidGas: 0n, success: false } },
    });
    for (let i = 0; i < 2; i += 1) await send(first, (await operation(freshUser())).wire);
    expect(first.chain.sent).toHaveLength(2);
    await first.settled();
    const restarted = await harness({ db });
    expect((await send(restarted, (await operation(freshUser())).wire)).result).toBe('pimlico');
    expect(restarted.chain.sent).toHaveLength(0);
  });

  it('a bundle sent and not yet settled counts at its worst case', async () => {
    // One bundle with no receipt: its worst case (485,000 x 244 gwei = 0.118 MON) is over
    // the limit on its own, so nothing else self-bundles until it is settled.
    const h = await harness({ scenario: { mined: 'never' } });
    await send(h, (await operation(freshUser())).wire);
    await h.settled();
    expect(h.db.prefundLedger()[0]?.status).toBe('unconfirmed');
    expect((await send(h, (await operation(freshUser())).wire)).result).toBe('pimlico');
    expect(h.chain.sent).toHaveLength(1);
  });
});

describe('review finding 3: only a sane fee is self-bundled; anything else goes to Pimlico, unrefused', () => {
  const cases: Array<[string, { maxFeePerGas?: bigint; tip?: bigint }]> = [
    ['a max fee under 1.2x the base fee', { maxFeePerGas: 119n * GWEI, tip: 2n * GWEI }],
    ['a max fee over 3x the base fee', { maxFeePerGas: 301n * GWEI }],
    ['a tip under 1 gwei', { tip: GWEI / 2n }],
  ];
  for (const [label, fees] of cases) {
    it(label, async () => {
      const h = await harness();
      const { wire } = await operation(freshUser(), fees);
      expect((await send(h, wire)).result).toBe('pimlico');
      expect(h.chain.sent).toHaveLength(0);
      expect(h.forwarded.map((f) => f.method)).toEqual(['eth_sendUserOperation']);
    });
  }

  it('the edges themselves are inside the band', async () => {
    const h = await harness();
    for (const fees of [{ maxFeePerGas: 120n * GWEI, tip: GWEI }, { maxFeePerGas: 300n * GWEI }]) {
      const { wire, userOpHash } = await operation(freshUser(), fees);
      expect((await send(h, wire)).result).toBe(userOpHash);
    }
    expect(h.chain.sent).toHaveLength(2);
  });
});

describe('review finding 6: a bundle that lands after its receipt wait is settled when it is seen', () => {
  it('through the receipt lookup', async () => {
    const h = await harness({ scenario: { mined: 'never' } });
    const { wire, userOpHash } = await operation(freshUser());
    await send(h, wire);
    await h.settled();
    const txHash = keccak256(h.chain.sent[0]!);
    expect(h.db.prefundLedger()[0]?.status).toBe('unconfirmed');
    expect(h.db.findByTxHash(txHash)?.status).toBe('pending');
    h.chain.scenario = {
      ...h.chain.scenario,
      mined: { status: '0x1', repaidGas: REPAID_GAS, success: true },
    };
    const receipt = (await rpc(h.app, 'eth_getUserOperationReceipt', [userOpHash])).result as {
      success: boolean;
    };
    expect(receipt.success).toBe(true);
    expect(h.db.prefundLedger()[0]?.status).toBe('released');
    expect(h.db.findByTxHash(txHash)?.status).toBe('success');
  });

  it('through the next bundle’s sweep, which then finds the loss limit clear again', async () => {
    const h = await harness({ scenario: { mined: 'never' } });
    await send(h, (await operation(freshUser())).wire);
    // Its own receipt wait has run out, so only the sweep can settle it now.
    await h.settled();
    const late = keccak256(h.chain.sent[0]!);
    h.chain.scenario = {
      ...h.chain.scenario,
      mined: { status: '0x1', repaidGas: REPAID_GAS, success: true },
    };
    h.time.advance(16_000);
    const { wire, userOpHash } = await operation(freshUser());
    expect((await send(h, wire)).result).toBe(userOpHash);
    expect(h.db.findByTxHash(late)?.status).toBe('success');
    await h.settled();
    expect(h.db.prefundLedger().every((row) => row.status === 'released')).toBe(true);
  });
});

describe('R9 (2026-10-07): a bundle the node never received does not pause self-bundling for an hour', () => {
  it('a rate-limited broadcast (HTTP 429) is not sent', () => {
    // viem's HttpRequestError, as rpc.monad.xyz's rate limiter produced it on 2026-10-07.
    const limited = Object.assign(new Error('HTTP request failed.'), { status: 429, details: 'Too Many Requests' });
    expect(classifySendFailure(limited)).toBe('not-sent');
    // Any other HTTP failure still proves nothing.
    expect(classifySendFailure(Object.assign(new Error('HTTP request failed.'), { status: 502 }))).toBe('unknown');
  });

  it('a real HTTP 429 on the send waits, reads twice, and only then goes to Pimlico with nothing held', async () => {
    const h = await harness({ scenario: { sendRaw: 'rate-limited' } });
    const { wire } = await operation(freshUser());
    const started = Date.now();
    expect((await send(h, wire)).result).toBe('pimlico');
    expect(Date.now() - started).toBeGreaterThanOrEqual(RATE_LIMITED_RECHECK_MS - 50);
    expect(h.chain.sent).toHaveLength(0);
    expect(h.db.prefundLedger()[0]?.status).toBe('released');
    expect(h.chain.rpcLog).toContain('eth_getTransactionReceipt');
    expect(h.chain.rpcLog).toContain('eth_getTransactionByHash');
  });

  it('a 429 after the node took it is treated as sent, never Pimlico', async () => {
    const h = await harness({ scenario: { sendRaw: 'rate-limited-but-taken', mined: 'never' } });
    const { wire, userOpHash } = await operation(freshUser());
    expect((await send(h, wire)).result).toBe(userOpHash);
    expect(h.forwarded).toHaveLength(0);
  });

  it('a 429 whose follow-up reads fail is treated as sent, never Pimlico', async () => {
    const h = await harness({ scenario: { sendRaw: 'rate-limited', receiptReadFails: true } });
    const { wire, userOpHash } = await operation(freshUser());
    expect((await send(h, wire)).result).toBe(userOpHash);
    expect(h.forwarded).toHaveLength(0);
  });

  it('never mined: released only after a minute AND once the relayer nonce has moved past it, keeping its hash', async () => {
    const h = await harness({ scenario: { sendRaw: 'broadcast-then-hang', hashLookupMisses: true, mined: 'never' } });
    await send(h, (await operation(freshUser())).wire);
    await h.settled();
    const first = h.db.prefundLedger().find((r) => r.id === 1);
    expect(first?.status).toBe('unconfirmed');
    const hash = first?.txHash;
    expect(hash).toBeTruthy();
    // Inside the minute, nonce used: left alone.
    h.chain.scenario = { ...h.chain.scenario, sendRaw: 'ok', minedNonce: 8n };
    h.time.advance(16_000);
    await send(h, (await operation(freshUser())).wire);
    await h.settled();
    expect(h.db.prefundLedger().find((r) => r.id === 1)?.status).toBe('unconfirmed');
    // Past the minute, nonce not yet used: still left alone, it may yet land.
    h.chain.scenario = { ...h.chain.scenario, minedNonce: 7n };
    h.time.advance(50_000);
    await send(h, (await operation(freshUser())).wire);
    await h.settled();
    expect(h.db.prefundLedger().find((r) => r.id === 1)?.status).toBe('unconfirmed');
    // Past the minute and the nonce is used: it can never be included. Released, hash kept.
    h.chain.scenario = { ...h.chain.scenario, minedNonce: 8n };
    h.time.advance(16_000);
    await send(h, (await operation(freshUser())).wire);
    await h.settled();
    const row = h.db.prefundLedger().find((r) => r.id === 1);
    expect(row?.status).toBe('released');
    expect(row?.txHash).toBe(hash);
  });

  it('a failed receipt read in the sweep never releases the row', async () => {
    const h = await harness({ scenario: { sendRaw: 'broadcast-then-hang', hashLookupMisses: true, mined: 'never' } });
    await send(h, (await operation(freshUser())).wire);
    await h.settled();
    h.chain.scenario = { ...h.chain.scenario, sendRaw: 'refused', minedNonce: 8n, receiptReadFails: true };
    h.time.advance(120_000);
    await send(h, (await operation(freshUser())).wire);
    await h.settled();
    expect(h.db.prefundLedger().find((r) => r.id === 1)?.status).toBe('unconfirmed');
  });

  it('a bundle that landed late is charged from its receipt, not released', async () => {
    const h = await harness({ scenario: { sendRaw: 'broadcast-then-hang', hashLookupMisses: true, mined: 'never' } });
    await send(h, (await operation(freshUser())).wire);
    await h.settled();
    const late = keccak256(h.chain.sent[0]!);
    h.chain.scenario = {
      ...h.chain.scenario,
      sendRaw: 'ok',
      minedNonce: 8n,
      mined: { status: '0x1', repaidGas: REPAID_GAS, success: true },
    };
    h.time.advance(120_000);
    await send(h, (await operation(freshUser())).wire);
    await h.settled();
    expect(h.db.findByTxHash(late)?.status).toBe('success');
  });

  it('stores the signed nonce on the ledger row', async () => {
    const h = await harness({ scenario: { sendRaw: 'broadcast-then-hang', mined: 'never' } });
    await send(h, (await operation(freshUser())).wire);
    await h.settled();
    expect(h.db.prefundLedger().find((r) => r.id === 1)?.txNonce).toBe(7);
  });

  it('a bundle that lands between the nonce read and the receipt re-read is charged from that receipt', async () => {
    const h = await harness({ scenario: { sendRaw: 'broadcast-then-hang', hashLookupMisses: true, mined: 'never' } });
    await send(h, (await operation(freshUser())).wire);
    await h.settled();
    const late = keccak256(h.chain.sent[0]!);
    h.chain.scenario = { ...h.chain.scenario, sendRaw: 'refused', minedNonce: 8n };
    // Only the re-read, after the nonce read, can see it.
    h.chain.onFinalizedNonceRead = () => {
      h.chain.scenario = { ...h.chain.scenario, mined: { status: '0x0', repaidGas: 0n, success: false } };
    };
    h.time.advance(120_000);
    await send(h, (await operation(freshUser())).wire);
    await h.settled();
    const row = h.db.prefundLedger().find((r) => r.id === 1);
    expect(row?.status).toBe('paid');
    expect(row?.amountWei).toBe(REVERTED_BUNDLE_COST);
    expect(h.db.findByTxHash(late)?.status).toBe('reverted');
  });

  it('a failed nonce read in the sweep never releases the row', async () => {
    const h = await harness({ scenario: { sendRaw: 'broadcast-then-hang', hashLookupMisses: true, mined: 'never' } });
    await send(h, (await operation(freshUser())).wire);
    await h.settled();
    h.chain.scenario = { ...h.chain.scenario, sendRaw: 'refused', minedNonce: 8n, nonceReadFails: true };
    h.time.advance(120_000);
    await send(h, (await operation(freshUser())).wire);
    await h.settled();
    expect(h.db.prefundLedger().find((r) => r.id === 1)?.status).toBe('unconfirmed');
  });

  it('a 429 whose by-hash read fails is treated as sent, never Pimlico', async () => {
    const h = await harness({ scenario: { sendRaw: 'rate-limited', hashReadFails: true } });
    const { wire, userOpHash } = await operation(freshUser());
    expect((await send(h, wire)).result).toBe(userOpHash);
    expect(h.forwarded).toHaveLength(0);
  });

  it('a 429 for a bundle that already landed, which the by-hash read misses, is treated as sent', async () => {
    const h = await harness({ scenario: { sendRaw: 'rate-limited-but-taken', hashLookupMisses: true } });
    const { wire, userOpHash } = await operation(freshUser());
    expect((await send(h, wire)).result).toBe(userOpHash);
    expect(h.forwarded).toHaveLength(0);
  });

  it('a connection never made goes to Pimlico even when the follow-up reads fail: nothing left this host', async () => {
    const h = await harness({ scenario: { sendRaw: 'refused-connection', receiptReadFails: true, hashReadFails: true } });
    const { wire } = await operation(freshUser());
    expect((await send(h, wire)).result).toBe('pimlico');
    expect(h.db.prefundLedger()[0]?.status).toBe('released');
  });

  it('a bundle whose nonce the node has not used is never released, however long it waits', async () => {
    const h = await harness({ scenario: { sendRaw: 'broadcast-then-hang', hashLookupMisses: false, mined: 'never' } });
    await send(h, (await operation(freshUser())).wire);
    await h.settled();
    h.time.advance(120_000);
    await send(h, (await operation(freshUser())).wire);
    await h.settled();
    expect(h.db.prefundLedger().find((r) => r.id === 1)?.status).toBe('unconfirmed');
  });
});

describe('the key boundary', () => {
  it('on mainnet the executor checks the A2.4 gate itself, before it touches a key', async () => {
    process.env.CHAIN = 'mainnet';
    process.env.MODE = 'dryrun';
    process.env.I_UNDERSTAND_THIS_USES_REAL_FUNDS = 'false';
    let loads = 0;
    const executor = liveBundleExecutor({
      mode: 'mainnet',
      chainId: 143,
      loadAccount: () => {
        loads += 1;
        return relayerKey;
      },
    });
    const { packed } = decodeBundle(fixture.bundles[1]!);
    await expect(
      executor.signHandleOps({
        op: packed as never,
        gas: 500_000n,
        nonce: 0,
        maxFeePerGas: OP_MAX_FEE,
        maxPriorityFeePerGas: OP_PRIORITY,
      }),
    ).rejects.toThrow();
    expect(loads).toBe(0);
  });

  it('the beneficiary is the signing key’s own address, whatever the caller wanted', async () => {
    const executor = liveBundleExecutor({
      mode: 'testnet',
      chainId: 143,
      loadAccount: () => relayerKey,
    });
    const { packed } = decodeBundle(fixture.bundles[1]!);
    const signed = await executor.signHandleOps({
      op: packed as never,
      gas: 500_000n,
      nonce: 3,
      maxFeePerGas: OP_MAX_FEE,
      maxPriorityFeePerGas: OP_PRIORITY,
    });
    const tx = parseTransaction(signed.serialized);
    const [, beneficiary] = decodeFunctionData({ abi: entryPoint08Abi, data: tx.data! })
      .args as unknown as [unknown, Address];
    expect(beneficiary).toBe(relayerKey.address);
    expect(tx.to?.toLowerCase()).toBe(ENTRY_POINT_V08.toLowerCase());
    expect(signed.hash).toBe(keccak256(signed.serialized));
  });

  const bundlerOn = (
    chain: TestChain,
    db: RelayerDb,
    lock: SerialLock,
    executor = liveBundleExecutor({
      mode: 'testnet',
      chainId: 143,
      loadAccount: () => relayerKey,
    }) as BundleExecutor,
  ) =>
    new SelfBundler({
      client: chain.client(),
      executor,
      db,
      floatAlertWei: FLOAT_ALERT_WEI,
      now: () => NOW_MS,
      log: { info: () => {}, warn: () => {}, error: () => {} },
      lock,
      receiptTimeoutMs: 100,
      receiptPollMs: 5,
      readTimeoutMs: 200,
    });

  it('self-bundles wait for the relayer key’s one lock (F5), and read nothing until they hold it', async () => {
    const chain = new TestChain();
    const user = freshUser();
    const { wire, userOpHash } = await operation(user);
    const lock = new SerialLock();
    let release!: () => void;
    const held = lock.run(() => new Promise<void>((resolve) => (release = resolve)));
    const bundler = bundlerOn(chain, new RelayerDb(':memory:'), lock);
    const pending = bundler.submit({
      op: rpcUserOperationSchema.parse(wire),
      userOpHash,
      sender: user.address,
      purpose: 'other',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(chain.rpcLog).not.toContain('eth_simulateV1');
    expect(chain.sent).toHaveLength(0);
    release();
    await held;
    expect((await pending).kind).toBe('submitted');
    expect(chain.sent).toHaveLength(1);
  });

  it('a failure after the node took the bundle still answers submitted, never Pimlico', async () => {
    class FailingAfterSend extends RelayerDb {
      override recordRelay(): number {
        throw new Error('disk I/O error');
      }
    }
    const chain = new TestChain();
    const user = freshUser();
    const { wire, userOpHash } = await operation(user);
    const db = new FailingAfterSend(':memory:');
    const lock = new SerialLock();
    const bundler = bundlerOn(chain, db, lock);
    const outcome = await bundler.submit({
      op: rpcUserOperationSchema.parse(wire),
      userOpHash,
      sender: user.address,
      purpose: 'other',
    });
    expect(outcome).toMatchObject({ kind: 'submitted', userOpHash });
    expect(chain.sent).toHaveLength(1);
    await lock.run(async () => {});
    expect(db.prefundLedger()[0]?.status).toBe('unconfirmed');
    // And the receipt is still answered from the chain, which settles the reservation.
    expect(await bundler.receiptFor(userOpHash)).toMatchObject({ success: true });
    expect(db.prefundLedger()[0]?.status).toBe('released');
  });

  it('a failure before anything was sent falls back with nothing left reserved', async () => {
    const chain = new TestChain();
    const user = freshUser();
    const { wire, userOpHash } = await operation(user);
    const db = new RelayerDb(':memory:');
    const bundler = bundlerOn(chain, db, new SerialLock(), {
      relayerAddress: () => relayerKey.address,
      signHandleOps: async () => {
        throw new Error('keystore unreadable');
      },
    });
    const outcome = await bundler.submit({
      op: rpcUserOperationSchema.parse(wire),
      userOpHash,
      sender: user.address,
      purpose: 'other',
    });
    expect(outcome.kind).toBe('fallback');
    expect(chain.sent).toHaveLength(0);
    expect(db.prefundLedger()[0]?.status).toBe('released');
  });

  it('with no executor nothing is self-bundled', async () => {
    const h = await harness({ executor: null });
    const { wire } = await operation(freshUser());
    expect((await send(h, wire)).result).toBe('pimlico');
    expect(h.chain.sent).toHaveLength(0);
  });
});

describe('how a failed send is read', () => {
  const rpcError = (code: number, message: string) =>
    Object.assign(new Error(message), { code, details: message });
  it('a validation refusal is a refusal; a pool collision, a timeout or an internal error is not proof of anything', () => {
    expect(
      classifySendFailure(rpcError(-32000, 'insufficient funds for gas * price + value')),
    ).toBe('refused');
    expect(classifySendFailure(rpcError(-32003, 'transaction rejected'))).toBe('refused');
    expect(classifySendFailure(rpcError(-32000, 'already known'))).toBe('unknown');
    expect(classifySendFailure(rpcError(-32000, 'nonce too low'))).toBe('unknown');
    expect(classifySendFailure(rpcError(-32603, 'internal error'))).toBe('unknown');
    expect(classifySendFailure(new Error('sending the bundle timed out after 3000 ms'))).toBe(
      'unknown',
    );
    expect(
      classifySendFailure(
        Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }),
        }),
      ),
    ).toBe('not-sent');
    expect(
      classifySendFailure(
        Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('x'), { code: 'ECONNRESET' }),
        }),
      ),
    ).toBe('unknown');
  });
});

describe('review item 7: receipt waits under the lock poll at 500 ms, not viem’s 4 s default', () => {
  it('the top-up executor asks for it', async () => {
    let asked: Record<string, unknown> | undefined;
    const executor = liveTopUpExecutor({
      client: {
        waitForTransactionReceipt: async (args: Record<string, unknown>) => {
          asked = args;
          return { status: 'success' };
        },
      } as unknown as PublicClient,
      mode: 'mainnet',
      rpcUrl: undefined,
    });
    await executor.waitForReceipt(`0x${'cd'.repeat(32)}`);
    expect(asked?.pollingInterval).toBe(RECEIPT_POLL_MS);
    expect(RECEIPT_POLL_MS).toBe(500);
  });
});

// ---------------------------------------------------------------------------------------
// 2026-09-24, second pass: self-bundling's own allowance, and the answer on the hash
// ---------------------------------------------------------------------------------------

/** A SelfBundler on its own, for the refusal reasons the route does not pass through. */
function standalone(
  chain: TestChain,
  db: RelayerDb,
  options: {
    lock?: SerialLock;
    floatAlertWei?: bigint | undefined;
    warn?: (detail: Record<string, unknown>, message: string) => void;
    timing?: { receiptTimeoutMs: number; receiptPollMs: number; readTimeoutMs: number };
    onLanded?: ConstructorParameters<typeof SelfBundler>[0]['onLanded'];
  } = {},
) {
  const timing = options.timing ?? { receiptTimeoutMs: 100, receiptPollMs: 5, readTimeoutMs: 200 };
  return new SelfBundler({
    ...(options.onLanded ? { onLanded: options.onLanded } : {}),
    client: chain.client(),
    executor: liveBundleExecutor({ mode: 'testnet', chainId: 143, loadAccount: () => relayerKey }),
    db,
    floatAlertWei: 'floatAlertWei' in options ? options.floatAlertWei : FLOAT_ALERT_WEI,
    now: () => NOW_MS,
    log: { info: () => {}, warn: options.warn ?? (() => {}), error: () => {} },
    lock: options.lock ?? new SerialLock(),
    ...timing,
  });
}

async function submitDirect(bundler: SelfBundler, user = freshUser()) {
  const { wire, userOpHash } = await operation(user);
  const outcome = await bundler.submit({
    op: rpcUserOperationSchema.parse(wire),
    userOpHash,
    sender: user.address,
    purpose: 'other',
  });
  return { outcome, userOpHash };
}

/** `n` self-bundles sent and not yet seen, 1 wei each, as another relayer run left them. */
function seedInFlight(db: RelayerDb, n: number): void {
  for (let i = 0; i < n; i += 1) {
    const r = db.reserveSelfBundle({
      address: freshUser().address,
      amountWei: 1n,
      maxWorstCaseWei: MON,
      lossLimitWei: MON,
      maxInFlight: 1_000,
      relayerBalanceWei: 20n * MON,
      floatFloorWei: 0n,
      now: NOW_MS,
    });
    if (!r.ok) throw new Error('fixture could not reserve');
    db.settlePrefund(r.id, 'unconfirmed', {
      txHash: `0x${'ee'.repeat(31)}${i.toString(16).padStart(2, '0')}`,
      now: NOW_MS,
    });
  }
}

describe('Fix 1: self-bundling draws on its own allowance, never on the sponsorship budgets', () => {
  it('an account whose two top-ups this hour used up its hourly sponsorship still self-bundles (the live regression)', async () => {
    // 0.16 MON is below this operation's own prefund, so each order needs a top-up.
    const low = 160_000_000_000_000_000n;
    const h = await harness({ scenario: { deposit: low } });
    const user = freshUser();

    const first = await operation(user);
    expect((await send(h, first.wire)).result).toBe(first.userOpHash);
    await h.settled();
    // The deposit is spent down again by trading, and the next order needs a second top-up.
    h.chain.deposits.set(user.address.toLowerCase(), low);
    const second = await operation(user);
    expect((await send(h, second.wire)).result).toBe(second.userOpHash);
    await h.settled();

    // The two top-ups used the whole hourly budget: 0.3, then the 0.2 that was left.
    expect(h.paid.map((p) => p.amount)).toEqual([
      ENTRYPOINT_TOPUP_WEI,
      PREFUND_BUDGETS.perAddressHour - ENTRYPOINT_TOPUP_WEI,
    ]);
    const headroom = prefundHeadroom(
      h.db.prefundUsage(user.address, NOW_MS),
      PREFUND_BUDGETS,
      NOW_MS,
    );
    expect(headroom.remaining).toBe(0n);
    expect(headroom.exhausted).toContain('ADDRESS_HOUR');
    // A bundle's worst case has nowhere to go in that budget. It never needed to.
    expect(WORST_CASE).toBeGreaterThan(headroom.remaining);

    // With the sponsorship budget spent, the next order self-bundles anyway.
    const third = await operation(user);
    expect((await send(h, third.wire)).result).toBe(third.userOpHash);
    await h.settled();

    expect(h.events).toEqual(['top-up', 'bundle', 'top-up', 'bundle', 'bundle']);
    expect(h.chain.sent).toHaveLength(3);
    expect(h.forwarded).toHaveLength(0);
    const bundles = h.db.prefundLedger().filter((r) => r.purpose === 'self-bundle');
    expect(bundles.map((r) => r.status)).toEqual(['released', 'released', 'released']);
  });

  it('with the all-addresses hourly sponsorship spent by other accounts, a self-bundle still goes', async () => {
    const h = await harness();
    const accounts = Number(PREFUND_BUDGETS.allAddressesHour / PREFUND_BUDGETS.perAddressHour);
    for (let i = 0; i < accounts; i += 1) {
      const r = h.db.reservePrefund({
        address: freshUser().address,
        amountWei: PREFUND_BUDGETS.perAddressHour,
        purpose: 'deposit',
        budgets: PREFUND_BUDGETS,
        now: NOW_MS,
      });
      if (!r.ok) throw new Error('fixture could not reserve');
      h.db.settlePrefund(r.id, 'paid', { now: NOW_MS });
    }
    const user = freshUser();
    const headroom = prefundHeadroom(
      h.db.prefundUsage(user.address, NOW_MS),
      PREFUND_BUDGETS,
      NOW_MS,
    );
    expect(headroom.exhausted).toEqual(['ALL_ADDRESSES_HOUR']);
    const { wire, userOpHash } = await operation(user);
    expect((await send(h, wire)).result).toBe(userOpHash);
    expect(h.chain.sent).toHaveLength(1);
    expect(h.forwarded).toHaveLength(0);
  });

  it('a self-bundle’s loss is charged to self-bundling’s loss limit alone, never to anyone’s sponsorship', async () => {
    const h = await harness({
      scenario: { mined: { status: '0x0', repaidGas: 0n, success: false } },
    });
    const user = freshUser();
    expect((await send(h, (await operation(user)).wire)).result).not.toBe('pimlico');
    await h.settled();
    expect(h.db.selfBundleExposure(NOW_MS)).toBe(REVERTED_BUNDLE_COST);
    const usage = h.db.prefundUsage(user.address, NOW_MS);
    expect([usage.addressHour, usage.addressDay, usage.allAddressesHour]).toEqual([0n, 0n, 0n]);
  });
});

describe('Fix 1: at most one self-bundle unsettled at a time (the nonce guard)', () => {
  it('is one', () => {
    expect(SELF_BUNDLE_MAX_IN_FLIGHT).toBe(1);
  });

  it('with nothing unsettled a bundle goes; with one unsettled the next goes to Pimlico, unrefused', async () => {
    const none = new RelayerDb(':memory:');
    const allowed = await submitDirect(standalone(new TestChain(), none));
    expect(allowed.outcome.kind).toBe('submitted');

    const one = new RelayerDb(':memory:');
    seedInFlight(one, 1);
    const chain = new TestChain();
    const declined = await submitDirect(standalone(chain, one));
    expect(declined.outcome).toEqual({
      kind: 'fallback',
      reason: 'a self-bundle is already sent and unsettled; another would reuse its nonce',
    });
    expect(chain.sent).toHaveLength(0);
    // Nothing reserved for the one that did not go.
    expect(one.prefundLedger()).toHaveLength(1);
  });

  it('the review’s case: at the 120 gwei fee floor the loss limit does not stop a second bundle behind a stuck one; this does', async () => {
    // 485,000 gas at 120 gwei is 0.058 MON, under the 0.1 MON loss limit. The first
    // bundle's receipt wait runs out with it unmined. On Monad `pending` reads as `latest`,
    // so a second bundle would be signed with the stuck one's nonce.
    const h = await harness({ scenario: { mined: 'never' } });
    const floorFees = { maxFeePerGas: 120n * GWEI, tip: GWEI };
    await send(h, (await operation(freshUser(), floorFees)).wire);
    await h.settled();
    expect(h.db.prefundLedger()[0]?.status).toBe('unconfirmed');
    expect(h.db.selfBundleExposure(NOW_MS)).toBeLessThan(SELF_BUNDLE_LOSS_LIMIT_WEI);

    const { wire } = await operation(freshUser(), floorFees);
    expect((await send(h, wire)).result).toBe('pimlico');
    expect(h.chain.sent).toHaveLength(1);
    expect(h.forwarded.map((f) => f.method)).toEqual(['eth_sendUserOperation']);
  });

  it('through the route, a second while one is unsettled is forwarded to Pimlico exactly as before', async () => {
    const db = new RelayerDb(':memory:');
    seedInFlight(db, 1);
    const h = await harness({ db });
    const { wire } = await operation(freshUser());
    expect((await send(h, wire)).result).toBe('pimlico');
    expect(h.chain.sent).toHaveLength(0);
    expect(h.forwarded.map((f) => f.method)).toEqual(['eth_sendUserOperation']);
  });
});

describe('Fix 1: no one bundle carries more than 0.2 MON of worst case', () => {
  it('is 0.2 MON, above the largest real shape at the browser’s usual price', () => {
    expect(SELF_BUNDLE_MAX_WORST_CASE_WEI).toBe(MON / 5n);
    // One market order, at the browser's 244 gwei and at the band's 300 gwei ceiling.
    expect(WORST_CASE).toBeLessThan(SELF_BUNDLE_MAX_WORST_CASE_WEI);
    expect(GAS_LIMIT * 300n * GWEI).toBeLessThan(SELF_BUNDLE_MAX_WORST_CASE_WEI);
  });

  it('exactly at the cap it self-bundles; one gas more and it goes to Pimlico, unrefused', async () => {
    // 800,000 gas at 250 gwei is exactly 0.2 MON.
    const fees = { maxFeePerGas: 250n * GWEI };
    const at = await harness({
      scenario: {
        handleOpsEstimate: { result: toHex(800_000n - SELF_BUNDLE_GAS_SLACK) },
        simulated: { success: true, repaidGas: 900_000n },
      },
    });
    const ok = await operation(freshUser(), fees);
    expect((await send(at, ok.wire)).result).toBe(ok.userOpHash);
    expect(at.chain.sent).toHaveLength(1);

    const over = await harness({
      scenario: {
        handleOpsEstimate: { result: toHex(800_001n - SELF_BUNDLE_GAS_SLACK) },
        simulated: { success: true, repaidGas: 900_000n },
      },
    });
    expect((await send(over, (await operation(freshUser(), fees)).wire)).result).toBe('pimlico');
    expect(over.chain.sent).toHaveLength(0);
    expect(over.db.prefundLedger()).toHaveLength(0);
    expect(over.forwarded.map((f) => f.method)).toEqual(['eth_sendUserOperation']);
  });

  it('refuses in the ledger itself, before the loss limit is even read', () => {
    const db = new RelayerDb(':memory:');
    expect(
      db.reserveSelfBundle({
        address: freshUser().address,
        amountWei: MON / 5n + 1n,
        maxWorstCaseWei: MON / 5n,
        lossLimitWei: MON,
        maxInFlight: 1,
        relayerBalanceWei: 20n * MON,
        floatFloorWei: 0n,
        now: NOW_MS,
      }),
    ).toMatchObject({ ok: false, reason: 'too-large' });
    expect(db.prefundLedger()).toHaveLength(0);
  });
});

describe('Fix 1: never toward the float alert line', () => {
  it('a bundle whose worst case would take the float exactly to the line goes to Pimlico; one wei more and it self-bundles', async () => {
    const at = await harness({ scenario: { relayerBalance: FLOAT_ALERT_WEI + WORST_CASE } });
    expect((await send(at, (await operation(freshUser())).wire)).result).toBe('pimlico');
    expect(at.chain.sent).toHaveLength(0);
    expect(at.db.prefundLedger()).toHaveLength(0);

    const above = await harness({
      scenario: { relayerBalance: FLOAT_ALERT_WEI + WORST_CASE + 1n },
    });
    const { wire, userOpHash } = await operation(freshUser());
    expect((await send(above, wire)).result).toBe(userOpHash);
    expect(above.chain.sent).toHaveLength(1);
  });

  it('what is sent and unsettled counts against the balance, an unconfirmed top-up included', async () => {
    const db = new RelayerDb(':memory:');
    const topUp = db.reservePrefund({
      address: freshUser().address,
      amountWei: ENTRYPOINT_TOPUP_WEI,
      purpose: 'deposit',
      budgets: PREFUND_BUDGETS,
      now: NOW_MS,
    });
    if (!topUp.ok) throw new Error('fixture could not reserve');
    db.settlePrefund(topUp.id, 'unconfirmed', { txHash: `0x${'dd'.repeat(32)}`, now: NOW_MS });
    const chain = new TestChain();
    chain.scenario = { ...happy(), relayerBalance: FLOAT_ALERT_WEI + WORST_CASE + 1n };
    const { outcome } = await submitDirect(standalone(chain, db));
    expect(outcome).toEqual({
      kind: 'fallback',
      reason: 'this bundle’s worst case could take the relayer float to its alert line',
    });
    expect(chain.sent).toHaveLength(0);
  });

  it('the line is the one /v1/health alerts on: 20% of the 20 MON cap', () => {
    expect(floatAlertThresholdWei(config)).toBe(FLOAT_ALERT_WEI);
  });

  it('D201: logs once when the float crosses the alert line, not on every bundle, and once more when it recovers', async () => {
    const chain = new TestChain();
    chain.scenario = { ...happy(), relayerBalance: FLOAT_ALERT_WEI + WORST_CASE + 1n };
    const db = new RelayerDb(':memory:');
    const warnings: { detail: Record<string, unknown>; message: string }[] = [];
    const bundler = standalone(chain, db, {
      warn: (detail, message) => warnings.push({ detail, message }),
    });
    // Isolates this log from the pre-existing per-bundle `float-floor` warning
    // (`reserveSelfBundle`'s own reason, logged every time that bundle is declined,
    // by design) — a balance at or below the line triggers both; this test is
    // about the edge-triggered transition log only.
    const transitions = () =>
      warnings.filter((w) => /self-bundling is (effectively off|back on)/.test(w.message));

    // Above the line, twice: the first read sets the baseline silently, the second
    // (still above) logs nothing — this is an edge, not a per-bundle warning.
    await submitDirect(bundler);
    await submitDirect(bundler);
    expect(transitions()).toHaveLength(0);

    // Drops below the alert line (the line itself is not "below" it — `/v1/health`'s
    // own `floatBelowAlert` is a strict less-than too).
    chain.scenario = { ...chain.scenario, relayerBalance: FLOAT_ALERT_WEI - 1n };
    await submitDirect(bundler);
    expect(transitions()).toHaveLength(1);
    expect(transitions()[0]!.message).toMatch(/self-bundling is effectively off/);
    expect(transitions()[0]!.detail.belowAlert).toBe(true);

    // Stays below: no second log for the same side.
    await submitDirect(bundler);
    expect(transitions()).toHaveLength(1);

    // Recovers above the line.
    chain.scenario = { ...chain.scenario, relayerBalance: FLOAT_ALERT_WEI + WORST_CASE + 1n };
    await submitDirect(bundler);
    expect(transitions()).toHaveLength(2);
    expect(transitions()[1]!.message).toMatch(/self-bundling is back on/);
    expect(transitions()[1]!.detail.belowAlert).toBe(false);
  });

  it('`balance < line` is exactly the comparison /v1/health made before the line was shared', () => {
    // The old inline form, verbatim: balance * 100 < effectiveCap * pct.
    const before = (balance: bigint, maxFloatMon: number, pct: number) =>
      balance * 100n <
      tighten(MAX_RELAYER_FLOAT_WEI, BigInt(Math.round(maxFloatMon * 1e6)) * 10n ** 12n) *
        BigInt(pct);
    let checked = 0;
    for (const maxFloatMon of [20, 50, 7.333333, 0.000001, 13]) {
      for (const pct of [1, 7, 20, 33, 99, 100]) {
        const line = floatAlertThresholdWei({ maxFloatMon, floatAlertPct: pct });
        for (const balance of [0n, 1n, line - 2n, line - 1n, line, line + 1n, 20n * MON]) {
          if (balance < 0n) continue;
          expect(balance < line).toBe(before(balance, maxFloatMon, pct));
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(150);
  });

  it('a line that cannot be computed turns self-bundling off rather than the floor', async () => {
    const chain = new TestChain();
    const { outcome } = await submitDirect(
      standalone(chain, new RelayerDb(':memory:'), { floatAlertWei: undefined }),
    );
    expect(outcome.kind).toBe('fallback');
    expect(chain.rpcLog).toHaveLength(0);
    expect(chain.sent).toHaveLength(0);
  });
});

describe('Fix 2: answered on the hash, settled afterwards, never Pimlico after broadcast', () => {
  it('the answer comes while the bundle is unmined; the receipt poll reads "not yet" here, then the receipt', async () => {
    const h = await harness({
      timing: { receiptTimeoutMs: 10_000, receiptPollMs: 5, readTimeoutMs: 200 },
    });
    h.chain.receiptsHidden = true;
    const { wire, userOpHash } = await operation(freshUser());
    const body = await send(h, wire);

    // Answered with the operation hash while no receipt exists.
    expect(body.result).toBe(userOpHash);
    expect(h.chain.sent).toHaveLength(1);
    const txHash = keccak256(h.chain.sent[0]!);
    const [row] = h.db.prefundLedger();
    expect(row).toMatchObject({ purpose: 'self-bundle', status: 'unconfirmed', txHash });
    expect(h.db.findByTxHash(txHash)?.status).toBe('pending');

    // The bundle's own receipt wait is still running inside the lock.
    let drained = false;
    const drain = h.settled().then(() => {
      drained = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(drained).toBe(false);

    // What the browser's block-by-block poll sees: null, answered here, not by Pimlico.
    expect((await rpc(h.app, 'eth_getUserOperationReceipt', [userOpHash])).result).toBeNull();
    expect(h.forwarded).toHaveLength(0);

    // Mined. The browser's lookup and the bundle's own wait race to settle it: once.
    h.chain.receiptsHidden = false;
    const receipt = (await rpc(h.app, 'eth_getUserOperationReceipt', [userOpHash])).result as {
      success: boolean;
      receipt: { transactionHash: Hex; gasUsed: Hex; effectiveGasPrice: Hex };
    };
    await drain;
    expect(receipt.success).toBe(true);
    expect(receipt.receipt.transactionHash).toBe(txHash);
    expect(h.db.prefundLedger()[0]?.status).toBe('released');
    expect(h.db.findByTxHash(txHash)?.status).toBe('success');
    expect(h.db.counter('mon_spent_wei')).toBe(
      BigInt(receipt.receipt.gasUsed) * BigInt(receipt.receipt.effectiveGasPrice),
    );
    expect(h.forwarded).toHaveLength(0);
  });

  it('a receipt wait that runs out after the browser’s lookup settled the bundle leaves it settled, and counts its gas once', async () => {
    // The race fixed in this pass: the bundle's own wait sees no receipt, the browser's
    // lookup sees one and settles the row, then the wait runs out. The timeout path must
    // not write the row back to 'unconfirmed' (which would count the worst case again and
    // let the sweep settle it, and count its gas, a second time).
    const chain = new TestChain();
    const db = new RelayerDb(':memory:');
    const lock = new SerialLock();
    const warnings: string[] = [];
    let arrived!: () => void;
    const waitAsked = new Promise<void>((resolve) => (arrived = resolve));
    let release!: () => void;
    const until = new Promise<void>((resolve) => (release = resolve));
    chain.holdNextReceiptRead = { arrived, until };
    const bundler = standalone(chain, db, {
      lock,
      warn: (_detail, message) => warnings.push(message),
      // A 50 ms deadline, and a read timeout long enough that only `release` ends the read.
      timing: { receiptTimeoutMs: 50, receiptPollMs: 5, readTimeoutMs: 5_000 },
    });

    const { outcome, userOpHash } = await submitDirect(bundler);
    expect(outcome.kind).toBe('submitted');
    // The bundle's own wait has asked for its receipt, and is held with no answer.
    await waitAsked;

    // The browser's lookup: a receipt, which settles the row and counts the gas.
    expect(await bundler.receiptFor(userOpHash)).toMatchObject({ success: true });
    const txHash = keccak256(chain.sent[0]!);
    const cost = GAS_LIMIT * effectiveGasPrice(OP_MAX_FEE, OP_PRIORITY, BASE_FEE);
    expect(db.prefundLedger()[0]).toMatchObject({ status: 'released', txHash });
    expect(db.counter('mon_spent_wei')).toBe(cost);

    // Past its deadline, the wait is answered "no receipt": the timeout path runs.
    await new Promise((resolve) => setTimeout(resolve, 60));
    release();
    await lock.run(async () => {});
    expect(warnings).toContain('self-bundle sent without a receipt');

    // Still settled, counted once, and nothing left for the sweep to settle again.
    expect(db.prefundLedger()[0]).toMatchObject({ status: 'released', txHash });
    expect(db.counter('mon_spent_wei')).toBe(cost);
    expect(db.unconfirmedSelfBundles(0, 10)).toHaveLength(0);
    expect(db.selfBundleExposure(NOW_MS)).toBe(0n);
    expect(db.findByTxHash(txHash)?.status).toBe('success');
  });

  it('answered, then the bundle reverts on chain: still never Pimlico, and charged to the loss limit', async () => {
    const h = await harness({
      scenario: { mined: { status: '0x0', repaidGas: 0n, success: false } },
      timing: { receiptTimeoutMs: 10_000, receiptPollMs: 5, readTimeoutMs: 200 },
    });
    h.chain.receiptsHidden = true;
    const { wire, userOpHash } = await operation(freshUser());
    expect((await send(h, wire)).result).toBe(userOpHash);
    h.chain.receiptsHidden = false;
    await h.settled();
    const [row] = h.db.prefundLedger();
    expect(row).toMatchObject({ status: 'paid', amountWei: REVERTED_BUNDLE_COST });
    expect((await rpc(h.app, 'eth_getUserOperationReceipt', [userOpHash])).result).toBeNull();
    expect(h.forwarded).toHaveLength(0);
  });

  it('answered, then the relay row cannot be written: the answer stands and the ledger holds it', async () => {
    class FailingAfterSend extends RelayerDb {
      override recordRelay(): number {
        throw new Error('disk I/O error');
      }
    }
    const db = new FailingAfterSend(':memory:');
    const h = await harness({ db });
    const { wire, userOpHash } = await operation(freshUser());
    expect((await send(h, wire)).result).toBe(userOpHash);
    await h.settled();
    expect(db.prefundLedger()[0]?.status).toBe('unconfirmed');
    expect(h.forwarded).toHaveLength(0);
    // The receipt is still answered here, and settles the row.
    const receipt = (await rpc(h.app, 'eth_getUserOperationReceipt', [userOpHash])).result as {
      success: boolean;
    };
    expect(receipt.success).toBe(true);
    expect(db.prefundLedger()[0]?.status).toBe('released');
    expect(h.forwarded).toHaveLength(0);
  });

  it('anything that throws between the send and the answer still answers submitted, never a fallback', async () => {
    // The send hangs past its timeout (the node took it) and the very next line throws.
    // The hash is recorded before the send is attempted, so the failure path sees it.
    const chain = new TestChain();
    chain.scenario = { ...happy(), sendRaw: 'broadcast-then-hang', hashLookupMisses: true };
    const db = new RelayerDb(':memory:');
    const lock = new SerialLock();
    const bundler = standalone(chain, db, {
      lock,
      warn: () => {
        throw new Error('the logger failed');
      },
    });
    const { outcome, userOpHash } = await submitDirect(bundler);
    expect(outcome).toMatchObject({ kind: 'submitted', userOpHash });
    expect(chain.sent).toHaveLength(1);
    await lock.run(async () => {});
    expect(db.prefundLedger()[0]).toMatchObject({
      status: 'unconfirmed',
      txHash: keccak256(chain.sent[0]!),
    });
  });

  it('a definite refusal before broadcast is still the only way to Pimlico, and holds nothing', async () => {
    const h = await harness({ scenario: { sendRaw: 'refused' } });
    const { wire } = await operation(freshUser());
    expect((await send(h, wire)).result).toBe('pimlico');
    await h.settled();
    expect(h.db.prefundLedger()[0]).toMatchObject({ status: 'released', txHash: null });
    expect(h.db.selfBundlesInFlight(NOW_MS)).toBe(0);
  });
});

describe('R9 speed (2026-10-07): the send path', () => {
  const count = (h: Awaited<ReturnType<typeof harness>>, method: string) =>
    h.chain.rpcLog.filter((m) => m === method).length;
  const signedNonce = (raw: Hex) => parseTransaction(raw).nonce;

  it('a send’s bundle reads are made once, outside the lock, and used inside it', async () => {
    const h = await harness();
    const { wire, userOpHash } = await operation(freshUser());
    expect((await send(h, wire)).result).toBe(userOpHash);
    await h.settled();
    expect(count(h, 'eth_simulateV1')).toBe(1);
    expect(h.chain.sent).toHaveLength(1);
  });

  it('a top-up between the reads and the lock voids them: the bundle reads again inside the lock', async () => {
    // Below the operation's own prefund, so the send tops up first, under the same lock.
    const h = await harness({ scenario: { deposit: 160_000_000_000_000_000n } });
    const { wire, userOpHash } = await operation(freshUser());
    expect((await send(h, wire)).result).toBe(userOpHash);
    await h.settled();
    expect(h.events).toEqual(['top-up', 'bundle']);
    // The prefetch (discarded), the top-up's own run check, and the bundle's own re-read.
    expect(count(h, 'eth_simulateV1')).toBe(3);
  });

  it('a bundle queued behind another uses the remembered nonce, one past the bundle before it', async () => {
    const chain = new TestChain();
    const h = await harness({ chain });
    // Hold A's first receipt read, so A's task is still inside the lock when B arrives.
    let arrived!: () => void;
    let release!: () => void;
    const atReceipt = new Promise<void>((r) => (arrived = r));
    chain.holdNextReceiptRead = { arrived: () => arrived(), until: new Promise<void>((r) => (release = r)) };
    const a = await operation(freshUser());
    expect((await send(h, a.wire)).result).toBe(a.userOpHash);
    await atReceipt;
    const b = await operation(freshUser());
    const sentB = send(h, b.wire);
    // B's prefetch is taken while A holds the lock, so it cannot be reused.
    await new Promise((r) => setTimeout(r, 20));
    release();
    expect((await sentB).result).toBe(b.userOpHash);
    await h.settled();
    // The fake chain's pending nonce never moves past 7; B signed 8 from memory alone.
    expect(h.chain.sent.map(signedNonce)).toEqual([7, 8]);
    // A's reads once; B's prefetch once (discarded) and once inside the lock.
    expect(count(h, 'eth_simulateV1')).toBe(3);
  });

  it('when the chain and the remembered nonce disagree, the chain wins', async () => {
    const h = await harness();
    const a = await operation(freshUser());
    expect((await send(h, a.wire)).result).toBe(a.userOpHash);
    // Wait for A's task to end without queueing one of our own on the lock (that would
    // be a task in between, and void the memory for the right reason, proving nothing).
    await vi.waitFor(() => expect(h.lock.snapshot().idle).toBe(true));
    // Something this code did not see used nonce 8.
    h.chain.scenario = { ...h.chain.scenario, minedNonce: 9n };
    const b = await operation(freshUser());
    expect((await send(h, b.wire)).result).toBe(b.userOpHash);
    await h.settled();
    expect(h.chain.sent.map(signedNonce)).toEqual([7, 9]);
  });

  it('any relayer-key task between two bundles voids the memory: a top-up in between means a fresh read', async () => {
    const h = await harness();
    const a = await operation(freshUser());
    expect((await send(h, a.wire)).result).toBe(a.userOpHash);
    await vi.waitFor(() => expect(h.lock.snapshot().idle).toBe(true));
    // B's deposit is short, so its send tops up first, under the same lock: that top-up
    // used nonce 8 on the real chain.
    const userB = freshUser();
    h.chain.deposits.set(userB.address.toLowerCase(), 160_000_000_000_000_000n);
    h.chain.scenario = { ...h.chain.scenario, minedNonce: 9n };
    const b = await operation(userB);
    expect((await send(h, b.wire)).result).toBe(b.userOpHash);
    await h.settled();
    expect(h.events).toEqual(['bundle', 'top-up', 'bundle']);
    expect(h.chain.sent.map(signedNonce)).toEqual([7, 9]);
  });

  it('a key transaction from outside the lock is never collided with: the higher of read and memory is signed', async () => {
    const chain = new TestChain();
    const h = await harness({ chain });
    let arrived!: () => void;
    let release!: () => void;
    const atReceipt = new Promise<void>((r) => (arrived = r));
    chain.holdNextReceiptRead = { arrived: () => arrived(), until: new Promise<void>((r) => (release = r)) };
    const a = await operation(freshUser());
    expect((await send(h, a.wire)).result).toBe(a.userOpHash);
    await atReceipt;
    // An operator script, outside this process's lock, uses nonce 8 while A settles.
    h.chain.scenario = { ...h.chain.scenario, minedNonce: 9n };
    const b = await operation(freshUser());
    const sentB = send(h, b.wire);
    await new Promise((r) => setTimeout(r, 20));
    release();
    expect((await sentB).result).toBe(b.userOpHash);
    await h.settled();
    expect(h.chain.sent.map(signedNonce)).toEqual([7, 9]);
  });

  it('an unsigned send costs no bundle reads', async () => {
    const h = await harness();
    const { wire } = await operation(freshUser(), { signer: freshUser() });
    const body = await send(h, wire);
    expect(body.error?.message).toBe('the operation is not signed by its sender');
    expect(count(h, 'eth_simulateV1')).toBe(0);
  });

  it('reads made for one operation are never used for another', async () => {
    const chain = new TestChain();
    chain.scenario = happy();
    const db = new RelayerDb(':memory:');
    const bundler = standalone(chain, db);
    const userA = freshUser();
    const userB = freshUser();
    const a = await operation(userA);
    const b = await operation(userB);
    const prefetchA = bundler.prefetch({ op: rpcUserOperationSchema.parse(a.wire), sender: userA.address })!;
    const outcome = await bundler.submit(
      { op: rpcUserOperationSchema.parse(b.wire), userOpHash: b.userOpHash, sender: userB.address, purpose: 'other' },
      { prefetch: prefetchA },
    );
    expect(outcome).toMatchObject({ kind: 'submitted', userOpHash: b.userOpHash });
    expect(chain.rpcLog.filter((m) => m === 'eth_simulateV1')).toHaveLength(2);
  });

  it('only a free action’s landing asks for a refill', async () => {
    const chain = new TestChain();
    chain.scenario = happy();
    const landed: Array<{ sender: Address; actualGasCost: bigint }> = [];
    const bundler = standalone(chain, new RelayerDb(':memory:'), { onLanded: (l) => landed.push(l) });
    const charged = freshUser();
    const chargedOp = await operation(charged);
    await bundler.submit({
      op: rpcUserOperationSchema.parse(chargedOp.wire),
      userOpHash: chargedOp.userOpHash,
      sender: charged.address,
      purpose: 'other',
      sponsored: false,
    });
    const free = freshUser();
    const freeOp = await operation(free);
    await bundler.submit({
      op: rpcUserOperationSchema.parse(freeOp.wire),
      userOpHash: freeOp.userOpHash,
      sender: free.address,
      purpose: 'other',
      sponsored: true,
    });
    await vi.waitFor(() => expect(landed).toHaveLength(1));
    expect(landed[0]!.sender).toBe(free.address);
    expect(landed[0]!.actualGasCost).toBeGreaterThan(0n);
  });

  it('an error drops the remembered nonce: the next bundle reads it fresh', async () => {
    const h = await harness();
    const a = await operation(freshUser());
    expect((await send(h, a.wire)).result).toBe(a.userOpHash);
    await h.settled();
    // A refused send: nothing goes out, and the memory is gone.
    h.chain.scenario = { ...h.chain.scenario, sendRaw: 'refused' };
    expect((await send(h, (await operation(freshUser())).wire)).result).toBe('pimlico');
    await h.settled();
    h.chain.scenario = { ...h.chain.scenario, sendRaw: 'ok' };
    const c = await operation(freshUser());
    expect((await send(h, c.wire)).result).toBe(c.userOpHash);
    await h.settled();
    // The fake chain answers 7 for a fresh read; memory would have said 8.
    expect(h.chain.sent.map(signedNonce)).toEqual([7, 7]);
  });

  it('a send whose deposit covers its signed prefund goes first, and its burn is refilled after it lands', async () => {
    const user = freshUser();
    // A fee inside self-bundling's band that puts the prefund under the 0.15 MON minimum,
    // which before R9 forced a top-up ahead of the send even though the deposit covered it.
    const maxFeePerGas = (BASE_FEE * 13n) / 10n;
    const op = await operation(user, { maxFeePerGas });
    const prefund =
      (op.limits.callGasLimit + op.limits.verificationGasLimit + op.limits.preVerificationGas) * maxFeePerGas;
    expect(prefund).toBeLessThan(150_000_000_000_000_000n);
    const h = await harness({ scenario: { deposit: prefund }, backgroundRefill: true });
    expect((await send(h, op.wire)).result).toBe(op.userOpHash);
    await h.settled();
    await vi.waitFor(() => expect(h.paid).toHaveLength(1));
    expect(h.events).toEqual(['bundle', 'top-up']);
    const receipt = (await rpc(h.app, 'eth_getUserOperationReceipt', [op.userOpHash])).result as {
      actualGasCost: Hex;
    };
    expect(h.paid[0]!.amount).toBe(BigInt(receipt.actualGasCost));
  });

  it('an estimate the relayer answers itself never pays a top-up, however thin the deposit', async () => {
    const h = await harness({ scenario: { deposit: 0n }, backgroundRefill: true });
    const { wire } = await operation(freshUser(), { estimate: true });
    const body = await rpc(h.app, 'eth_estimateUserOperationGas', [wire, ENTRY_POINT_V08]);
    expect(body.result).toBeDefined();
    expect(h.paid).toHaveLength(0);
  });

  it('a released bundle’s relay row is marked rejected, so nothing shows pending forever', async () => {
    const h = await harness({ scenario: { sendRaw: 'broadcast-then-hang', hashLookupMisses: true, mined: 'never' } });
    await send(h, (await operation(freshUser())).wire);
    await h.settled();
    const hash = h.db.prefundLedger().find((r) => r.id === 1)!.txHash!;
    expect(h.db.findByTxHash(hash)?.status).toBe('pending');
    h.chain.scenario = { ...h.chain.scenario, sendRaw: 'refused', minedNonce: 8n };
    h.time.advance(120_000);
    await send(h, (await operation(freshUser())).wire);
    await h.settled();
    expect(h.db.prefundLedger().find((r) => r.id === 1)?.status).toBe('released');
    expect(h.db.findByTxHash(hash)?.status).toBe('rejected');
  });
});
