import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  createPublicClient,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  http,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import {
  entryPoint08Abi,
  formatUserOperationRequest,
  getUserOperationTypedData,
  toSimple7702SmartAccount,
  type UserOperation,
} from 'viem/account-abstraction';
import {
  buildCancelOrders,
  buildDeposit,
  buildErc20Transfer,
  buildFeeLeg,
  buildMarketOrder,
  buildWithdraw,
  decodeMarketParams,
  delegationCodeFor,
  FLOW_USDC_AUSD_RESPONSE,
  KURU_FLOW_ROUTER,
  KYBER_ROUTER,
  KYBER_SWAP_ABI,
  normalizeFlowCalldata,
  effectiveExemptAllAddressesHourCap,
  effectiveExemptPerAddressDayCap,
  effectiveExemptPerAddressHourCap,
  effectiveFeePaidPerAddressHourCap,
  ENTRY_POINT_V08,
  ENTRYPOINT_TOPUP_WEI,
  FEE_PAID_MAX_WEI_PER_ADDRESS_HOUR,
  FREE_ACTIONS_USED_MESSAGE,
  SPONSORSHIP_PAUSED_MESSAGE,
  GAS_FEE_MINIMUM,
  PRIOR_FEE_NEVER_LANDED_MESSAGE,
  PRIOR_FEE_PENDING_MESSAGE,
  HOUR_MS,
  MAINNET,
  monad,
  operationGasFee,
  planUserOperationGas,
  PREFUND_BUDGETS,
  prefundBudgets,
  SIMPLE_7702_DELEGATE,
  SPONSORSHIP_ALLOWANCE_USED,
  sponsorshipAllowanceMessage,
  TOP_UP_ABOVE_GAS_USED_MESSAGE,
  userOpGasPrice,
  utcClock,
  windowStartOf,
} from '@tradepro/core';
import {
  MON_USDC,
  RECORDED_TUPLES,
} from '../../../packages/core/src/kuru/__fixtures__/liveMarketsHarness.js';
import { isolateEnv } from './testEnv.js';
import { buildServer, resolveFeeRecipient } from './server.js';
import { TargetAllowlist } from './allowlist.js';
import { EXEMPT_PURPOSE, FEE_PAID_PURPOSE_PREFIX, RelayerDb } from './db.js';
import { relayerEnvSchema, type RelayerConfig } from './config.js';
import {
  budgetsFor,
  FEE_PAID_MAX_PREFUND_WEI,
  feePaidDepositNeeded,
  PrefundGate,
  UNFUNDABLE_MESSAGE,
  type FeePaidWatch,
  type TopUpExecutor,
} from './prefund.js';
import { assertFeeRecipient, FEE_PRICING_TTL_MS, liveFeePaidWatch } from './gasCharge.js';
import { FakeEntryPoint, VALIDATION_GAS_USED } from './testEntryPoint.js';

/**
 * Free actions, then gas at cost (owner's policy, 2026-09-24), through the real routes.
 *
 * Every operation is encoded by viem's own `toSimple7702SmartAccount.encodeCalls` and signed
 * the way the browser signs one. Every call in it is built by the builders production uses:
 * the ticket's market order and cancel, the withdraw screen's `buildWithdraw`, the send
 * screen's `buildErc20Transfer`, and `buildFeeLeg`, which is those two. Attack batches are
 * edits of those, never hand-assembled lookalikes.
 *
 * The chain answers from recorded mainnet data: the MON/USDC params and touch read at block
 * 107,310,277 (the same recording `capValuation.test.ts` uses), Monad's 100 gwei base fee
 * and the browser's 244 / 4 gwei fees from the five profiling bundles, and the recorded
 * inner-call estimate of a market sell (257,234 gas). That estimate is for one call, and
 * these batches are three; it is simpler than production. It changes nothing measured here:
 * a three-call batch is planned at the batch floor (454,886 call gas) unless its own
 * estimate x 1.3 is above that, and a real order plus a fee leg estimates well under it.
 *
 * Nothing here can move money or reach a network. The top-up executor is a recording fake,
 * the bundler is a recording fake, self-bundling is off, and the chain is a function.
 */

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/selfBundle.mainnet.json', import.meta.url), 'utf8'),
) as {
  bundles: Array<{
    baseFeePerGas: Hex;
    transaction: { input: Hex };
    pimlicoReceipt: { actualGasCost: Hex; actualGasUsed: Hex };
  }>;
  rpc: Record<string, { result?: unknown; error?: unknown }>;
};

const GWEI = 10n ** 9n;
const MON = 10n ** 18n;
const MARGIN = MAINNET.kuru.marginAccount as Address;
const USDC = getAddress(MAINNET.tokens.USDC.address);
const AUSD = getAddress(MAINNET.tokens.AUSD.address);
const MON_USDC_BOOK = getAddress(MON_USDC);
/** The relayer's fee address in these tests. A throwaway: it holds nothing. */
const FEE_TO = getAddress('0x000000000000000000000000000000000000fee5');
/** The relayer's own signing address in these tests: not the fee address, as after D169. */
const HOT_KEY = getAddress('0x000000000000000000000000000000000000beef');
const SOMEONE = getAddress('0x43a275c3eb0be7313f847ffa4fb6bd366606a961');
/** 2025-09-02T08:20:00Z: twenty minutes into its hourly window. */
const NOW_MS = 1_756_800_000_000 + 20 * 60_000;
/** Recorded, block 107,310,277. */
const MON_USDC_TOUCH = [25_853_000_000_000_000n, 25_869_000_000_000_000n] as const;
const BASE_FEE = 100n * GWEI;
const OP_MAX_FEE = 244n * GWEI;
const OP_TIP = 4n * GWEI;
const INNER_ESTIMATE = BigInt(fixture.rpc.estimateOkMarketSell!.result as Hex);

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

// ---------------------------------------------------------------------------------------
// The chain, the bundler and the top-ups, all fakes that record
// ---------------------------------------------------------------------------------------

/**
 * The chain: the EntryPoint model shared with `feeDrain.test.ts` (AA21, AA23, AA25, and the
 * deposit-then-handleOps simulation the relayer asks before paying a charged top-up), plus
 * the reads the fee path makes.
 */
class Chain extends FakeEntryPoint {
  // `nativeBalances` lives on FakeEntryPoint now: the AA21 model reads it too.
  /** `${user}:${token}` -> trading balance. */
  readonly margin = new Map<string, bigint>();
  override defaultDeposit = 1n * MON;
  override nowSeconds = BigInt(Math.floor(NOW_MS / 1000));
  midReads = 0;
  touch: readonly [bigint, bigint] = MON_USDC_TOUCH;
  /** The inner-call estimate fails as an RPC error (not a revert), as a timeout would. */
  innerFails = false;
  /** The inner-call estimate answers Monad's reserve refusal, verbatim as rpc.monad.xyz
   *  gave it on 2026-09-29 for a delegated account wrapping more MON than it can spare. */
  innerReserveViolation = false;
  innerEstimate = INNER_ESTIMATE;
  /** Accounts not delegated yet (lower-case): `eth_getCode` answers `0x` for them. */
  readonly undelegated = new Set<string>();
  /**
   * Hold every inner-call read until `count` requests have made one, then release them all
   * at once. The inner read comes after a send has read its free-action count and before it
   * reserves one, so this puts every request past the first read with none reserved yet.
   */
  innerGate: { count: number; arrived: number; open: Promise<void>; release: () => void } | undefined;

  gateInnerReads(count: number) {
    let release!: () => void;
    const open = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.innerGate = { count, arrived: 0, open, release };
  }

  setMargin(user: Address, balances: { USDC?: bigint; AUSD?: bigint }) {
    this.margin.set(`${user.toLowerCase()}:${USDC.toLowerCase()}`, balances.USDC ?? 0n);
    this.margin.set(`${user.toLowerCase()}:${AUSD.toLowerCase()}`, balances.AUSD ?? 0n);
  }

  client(): PublicClient {
    const answers: Record<string, (params: unknown[]) => unknown> = {
      eth_estimateGas: async () => {
        const gate = this.innerGate;
        if (gate) {
          gate.arrived += 1;
          if (gate.arrived >= gate.count) gate.release();
          await gate.open;
        }
        if (this.innerReserveViolation) {
          return { error: { code: -32000, message: 'reserve balance violation' } };
        }
        return this.innerFails
          ? { error: { code: -32603, message: 'internal error' } }
          : { result: toHex(this.innerEstimate) };
      },
      // Per address, as on mainnet: an account in `undelegated` has no code yet.
      eth_getCode: (params) => ({
        result: this.undelegated.has(String(params[0]).toLowerCase())
          ? '0x'
          : delegationCodeFor(SIMPLE_7702_DELEGATE),
      }),
      // A fresh account has sent nothing: its 7702 authorization nonce is 0.
      eth_getTransactionCount: () => ({ result: '0x0' }),
      eth_getBlockByNumber: () => ({ result: { number: '0x1', baseFeePerGas: toHex(BASE_FEE) } }),
      eth_blockNumber: () => ({ result: toHex(this.blockNumber) }),
      eth_simulateV1: (params) => this.simulate(params),
      eth_getLogs: (params) => this.logs(params),
    };
    const fetchFn = async (_url: unknown, init?: { body?: unknown }) => {
      const request = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
      const handler = answers[request.method];
      const answer = handler
        ? await handler(request.params)
        : { error: { code: -32601, message: `the test chain does not answer ${request.method}` } };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...(answer as object) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const base = createPublicClient({
      chain: monad,
      transport: http('http://chain.test', { retryCount: 0, fetchFn: fetchFn as typeof fetch }),
    });
    return Object.assign({}, base, {
      readContract: async ({
        address,
        functionName,
        args,
      }: {
        address: Address;
        functionName: string;
        args?: readonly unknown[];
      }) => {
        if (functionName === 'balanceOf') return this.deposit(String(args?.[0]));
        if (functionName === 'getNonce') {
          const [sender, key] = args as [Address, bigint];
          return this.nonceFor(sender, key);
        }
        if (functionName === 'getBalance' && address.toLowerCase() === MARGIN.toLowerCase()) {
          const [user, token] = args as [Address, Address];
          return this.margin.get(`${user.toLowerCase()}:${token.toLowerCase()}`) ?? 0n;
        }
        if (functionName === 'getMarketParams' && address.toLowerCase() === MON_USDC) {
          return RECORDED_TUPLES[MON_USDC];
        }
        if (functionName === 'bestBidAsk' && address.toLowerCase() === MON_USDC) {
          this.midReads += 1;
          return this.touch;
        }
        throw new Error(`the test chain was not expecting ${functionName} on ${address}`);
      },
      // The relayer's own float, or a user account's native MON (B2a): senders start
      // at zero — the whole product is gasless — and a test that wants the own-MON
      // lane sets a balance explicitly.
      getBalance: async ({ address }: { address: Address }) =>
        this.nativeBalances.get(address.toLowerCase()) ??
        (address.toLowerCase() === '0x000000000000000000000000000000000000beef' ? 20n * MON : 0n),
      getBlockNumber: async () => 107_310_277n,
    }) as unknown as PublicClient;
  }
}

function recordingTopUps(chain: Chain) {
  const paid: Array<{ account: Address; amount: bigint }> = [];
  const executor: TopUpExecutor = {
    relayerAddress: () => getAddress('0x000000000000000000000000000000000000beef'),
    async depositTo(account, amount) {
      paid.push({ account, amount });
      return `0x${paid.length.toString(16).padStart(64, '0')}` as Hex;
    },
    async waitForReceipt() {
      const last = paid[paid.length - 1]!;
      const key = last.account.toLowerCase();
      chain.deposits.set(key, (chain.deposits.get(key) ?? chain.defaultDeposit) + last.amount);
      return 'success';
    },
  };
  return { executor, paid };
}

async function harness(
  options: {
    db?: RelayerDb;
    feeRecipient?: Address | null;
    /** Take the fee address from config (RELAYER_FEE_ADDRESS) instead of the test override. */
    configFeeAddress?: Address;
    upstream?: 'ok' | 'error';
    configOverride?: Partial<RelayerConfig>;
    /** The relayer's own signing address. Default: HOT, which is not the fee address. */
    relayerSelf?: Address | undefined;
  } = {},
) {
  const chain = new Chain();
  const db = options.db ?? new RelayerDb(':memory:');
  const { executor, paid } = recordingTopUps(chain);
  const forwarded: Array<{ method: string; params: unknown[] }> = [];
  const time = { t: NOW_MS };
  const allowlist = new TargetAllowlist(undefined as never, 'mainnet');
  allowlist.seed([
    { address: MARGIN, kind: 'marginAccount', symbol: 'MarginAccount', trustsForwarder: true },
  ]);
  const app = await buildServer({
    config: {
      ...config,
      ...(options.configFeeAddress ? { feeAddress: options.configFeeAddress } : {}),
      ...options.configOverride,
    },
    gate: { mode: 'mainnet', runMode: 'live', realFundsAcknowledged: true },
    client: chain.client(),
    allowlist,
    db,
    now: () => time.t,
    relayerAddress: async () => ('relayerSelf' in options ? options.relayerSelf : HOT_KEY),
    topUpExecutor: executor,
    bundlerUpstream: async (payload) => {
      const parsed = JSON.parse(payload) as { id: number; method: string; params: unknown[] };
      forwarded.push({ method: parsed.method, params: parsed.params });
      if (options.upstream === 'error') {
        return JSON.stringify({
          jsonrpc: '2.0',
          id: parsed.id,
          error: { code: -32500, message: 'bundler said no' },
        });
      }
      const answer =
        parsed.method === 'eth_sendUserOperation'
          ? chain.bundle(parsed.params[0] as Record<string, string>)
          : { result: `0x${'ab'.repeat(32)}` };
      return JSON.stringify({ jsonrpc: '2.0', id: parsed.id, ...answer });
    },
    bundleExecutor: null,
    ...(options.configFeeAddress
      ? {}
      : { feeRecipient: options.feeRecipient === undefined ? FEE_TO : options.feeRecipient }),
  });
  return { app, chain, db, paid, forwarded, time };
}
type Harness = Awaited<ReturnType<typeof harness>>;

// ---------------------------------------------------------------------------------------
// Calls and operations, the way production builds them
// ---------------------------------------------------------------------------------------

interface Call {
  readonly to: Address;
  readonly data: Hex;
  /** Native value: only the D3 WMON wrap ever carries one. */
  readonly value?: bigint;
}

const order: Call = (() => {
  const built = buildMarketOrder({
    market: MON_USDC_BOOK,
    params: decodeMarketParams(RECORDED_TUPLES[MON_USDC] as never),
    side: 'buy',
    amount: 1_000_000n,
    minAmountOut: 0n,
  });
  return { to: built.to, data: built.data };
})();
const cancel: Call = (() => {
  const built = buildCancelOrders(MON_USDC_BOOK, [7n]);
  return { to: built.to, data: built.data };
})();
const withdrawOwn = (amount = 1_000_000n): Call => {
  const w = buildWithdraw(MARGIN, USDC, amount);
  return { to: w.to, data: w.data };
};
const sendOwn = (amount = 1_000_000n): Call => {
  const t = buildErc20Transfer(USDC, SOMEONE, amount);
  return { to: t.to, data: t.data };
};
const feeLeg = (token: Address, amount: bigint, to: Address = FEE_TO): Call[] =>
  buildFeeLeg(MARGIN, token, to, amount).map((c) => ({ to: c.to, data: c.data }));

let keyCounter = 1;
const freshUser = () =>
  privateKeyToAccount(`0x${(0x6e00 + keyCounter++).toString(16).padStart(64, '0')}` as Hex);
let nonceKey = 1n;

async function callDataFor(user: PrivateKeyAccount, calls: readonly Call[]): Promise<Hex> {
  const account = await toSimple7702SmartAccount({
    client: { chain: { id: 143 } } as never,
    owner: user,
  });
  return account.encodeCalls(calls.map((c) => ({ to: c.to, data: c.data, value: c.value ?? 0n })));
}

/** The limits this relayer's own estimate would give these calls. */
function planned(callData: Hex, callCount: number) {
  const plan = planUserOperationGas({
    innerEstimate: INNER_ESTIMATE,
    callCount,
    callDataBytes: BigInt((callData.length - 2) / 2),
  });
  if (!plan.ok) throw new Error(plan.reason);
  return plan.plan;
}

async function operation(
  user: PrivateKeyAccount,
  calls: readonly Call[],
  options: {
    estimate?: boolean;
    gas?: { callGasLimit: bigint; verificationGasLimit: bigint; preVerificationGas: bigint };
    maxFeePerGas?: bigint;
    tip?: bigint;
  } = {},
) {
  const callData = await callDataFor(user, calls);
  const gas = options.gas ?? planned(callData, calls.length);
  const userOperation: UserOperation<'0.8'> = {
    sender: user.address,
    nonce: nonceKey++ << 64n,
    callData,
    callGasLimit: options.estimate ? 0n : gas.callGasLimit,
    verificationGasLimit: options.estimate ? 0n : gas.verificationGasLimit,
    preVerificationGas: options.estimate ? 0n : gas.preVerificationGas,
    maxFeePerGas: options.maxFeePerGas ?? OP_MAX_FEE,
    maxPriorityFeePerGas: options.tip ?? OP_TIP,
    signature: '0x',
  };
  const signature = await user.signTypedData(
    getUserOperationTypedData({ chainId: 143, entryPointAddress: ENTRY_POINT_V08, userOperation }),
  );
  return { wire: formatUserOperationRequest({ ...userOperation, signature }), gas };
}

async function rpc(h: Harness, method: string, op: unknown) {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/bundler',
    payload: { jsonrpc: '2.0', id: 1, method, params: [op, ENTRY_POINT_V08] },
  });
  return JSON.parse(res.body) as {
    result?: unknown;
    error?: { code: number; message: string; data?: Record<string, unknown> };
  };
}
const send = (h: Harness, op: unknown) => rpc(h, 'eth_sendUserOperation', op);
const estimate = (h: Harness, op: unknown) => rpc(h, 'eth_estimateUserOperationGas', op);

interface QuoteAnswer {
  sender: string;
  freeActions: { limit: number; used: number; remaining: number; resetsAt: number | null; allFreeAt: number | null };
  charge: 'sponsored' | 'own-mon' | 'fee' | 'refused';
  reason: string;
  message?: string;
  ownMon?: { gasWei: string; balanceWei: string; reserveWei: string; depositWei: string };
  fee?: {
    token: Address;
    symbol: string;
    decimals: number;
    recipient: Address;
    amount?: string;
    calls?: Call[];
    gas?: { callGasLimit: Hex; verificationGasLimit: Hex; preVerificationGas: Hex };
    maxFeePerGas?: Hex;
    maxPriorityFeePerGas?: Hex;
    minimum: string;
    step: string;
    marginPct: number;
    pricing: { baseFeePerGas: string; monUsdMid: string; quotedAt: number; expiresAt: number };
  };
}

async function quote(h: Harness, user: Address, calls: readonly Call[]) {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/gas/quote',
    payload: {
      sender: user,
      // Value as the browser sends it (`requestGasQuote`): decimal wei, only when positive.
      calls: calls.map((c) => ({
        to: c.to,
        data: c.data,
        ...(c.value !== undefined && c.value > 0n ? { value: c.value.toString() } : {}),
      })),
      maxFeePerGas: toHex(OP_MAX_FEE),
      maxPriorityFeePerGas: toHex(OP_TIP),
    },
  });
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body) as QuoteAnswer;
}

async function allowance(h: Harness, user: Address) {
  const res = await h.app.inject({ method: 'GET', url: `/v1/gas/allowance?address=${user}` });
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body) as { freeActions: QuoteAnswer['freeActions']; charging: boolean };
}

/** Put `count` used free actions into the ledger, in the window `hoursAgo` before now. */
function useFreeActions(db: RelayerDb, user: Address, entries: ReadonlyArray<[number, number]>) {
  for (const [hoursAgo, count] of entries) {
    for (let i = 0; i < count; i++) {
      const at = NOW_MS - hoursAgo * HOUR_MS;
      const reserved = db.reserveFreeAction({ address: user, purpose: 'other', limit: 1_000, now: at });
      if (!reserved.ok) throw new Error('fixture could not reserve');
      db.settleFreeAction(reserved.id, 'used', at);
    }
  }
}

/** The calls a forwarded operation carries, decoded from its callData. */
function forwardedCalls(h: Harness, index = -1): Call[] {
  const entry = h.forwarded.at(index)!;
  const op = entry.params[0] as { callData: Hex };
  const decoded = decodeFunctionData({
    abi: [
      {
        type: 'function',
        name: 'executeBatch',
        stateMutability: 'payable',
        inputs: [
          {
            name: 'calls',
            type: 'tuple[]',
            components: [
              { name: 'target', type: 'address' },
              { name: 'value', type: 'uint256' },
              { name: 'data', type: 'bytes' },
            ],
          },
        ],
        outputs: [],
      },
      {
        type: 'function',
        name: 'execute',
        stateMutability: 'payable',
        inputs: [
          { name: 'target', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'data', type: 'bytes' },
        ],
        outputs: [],
      },
    ],
    data: op.callData,
  });
  if (decoded.functionName === 'execute') {
    const [target, , data] = decoded.args as unknown as [Address, bigint, Hex];
    return [{ to: getAddress(target), data }];
  }
  const [calls] = decoded.args as unknown as [ReadonlyArray<{ target: Address; data: Hex }>];
  return calls.map((c) => ({ to: getAddress(c.target), data: c.data }));
}

const gasOf = (fee: NonNullable<QuoteAnswer['fee']>) => ({
  callGasLimit: BigInt(fee.gas!.callGasLimit),
  verificationGasLimit: BigInt(fee.gas!.verificationGasLimit),
  preVerificationGas: BigInt(fee.gas!.preVerificationGas),
});

isolateEnv();

beforeEach(() => {
  process.env.LOG_LEVEL = 'silent';
  process.env.PIMLICO_API_KEY = 'test-key-not-a-secret';
});

// ---------------------------------------------------------------------------------------

describe('free tier used up, trading balance present: the fee leg is appended and sponsored', () => {
  it('quote, append the relayer’s own fee leg, sign its limits, send: the batch forwarded is that batch', async () => {
    const h = await harness();
    const user = freshUser();
    useFreeActions(h.db, user.address, [[5, 20]]);
    h.chain.setMargin(user.address, { USDC: 10_000_000n });

    const q = await quote(h, user.address, [order]);
    expect(q.charge).toBe('fee');
    expect(q.freeActions).toMatchObject({ limit: 20, used: 20, remaining: 0 });
    const fee = q.fee!;
    expect(fee.token).toBe(USDC);
    expect(fee.recipient).toBe(FEE_TO);
    // At today's recorded prices a whole order plus its fee is under the minimum.
    expect(fee.amount).toBe(GAS_FEE_MINIMUM.toString());
    expect(fee.calls).toEqual(feeLeg(USDC, GAS_FEE_MINIMUM));
    // The limits are the relayer's own plan for the three calls, exactly as its estimate
    // would answer them.
    const batch = [order, ...fee.calls!];
    expect(gasOf(fee)).toEqual({
      callGasLimit: planned(await callDataFor(user, batch), 3).callGasLimit,
      verificationGasLimit: planned(await callDataFor(user, batch), 3).verificationGasLimit,
      preVerificationGas: planned(await callDataFor(user, batch), 3).preVerificationGas,
    });

    h.chain.deposits.set(user.address.toLowerCase(), 0n); // so the funding path runs too
    const { wire } = await operation(user, batch, { gas: gasOf(fee) });
    const body = await send(h, wire);

    expect(body.error).toBeUndefined();
    expect(body.result).toMatch(/^0x[0-9a-f]{64}$/);
    expect(h.forwarded).toHaveLength(1);
    // What reached the bundler is exactly the action and the fee leg the relayer computed.
    expect(forwardedCalls(h)).toEqual([order, ...feeLeg(USDC, GAS_FEE_MINIMUM)]);
    // A paid action takes no free action.
    expect(h.db.freeActionLedger(user.address)).toHaveLength(20);
    // Its top-up was paid, and recorded as fee-paid.
    expect(h.paid).toHaveLength(1);
    expect(h.db.prefundLedger(user.address)[0]?.purpose).toBe('fee-paid:other');
  });

  it('the per-address budgets bound the free path only: a paid send is funded past them', async () => {
    const h = await harness();
    const user = freshUser();
    useFreeActions(h.db, user.address, [[5, 20]]);
    h.chain.setMargin(user.address, { USDC: 10_000_000n });
    // The account's own rolling day is spent, as it would be after its free actions.
    for (const hoursAgo of [4, 3, 2, 1]) {
      const r = h.db.reservePrefund({
        address: user.address,
        amountWei: PREFUND_BUDGETS.perAddressHour,
        purpose: 'deposit',
        budgets: PREFUND_BUDGETS,
        now: NOW_MS - hoursAgo * HOUR_MS,
      });
      if (!r.ok) throw new Error('fixture could not reserve');
      h.db.settlePrefund(r.id, 'paid', { now: NOW_MS - hoursAgo * HOUR_MS });
    }
    h.chain.deposits.set(user.address.toLowerCase(), 0n);

    const q = await quote(h, user.address, [order]);
    const { wire } = await operation(user, [order, ...q.fee!.calls!], { gas: gasOf(q.fee!) });
    const body = await send(h, wire);

    expect(body.error).toBeUndefined();
    expect(h.paid).toHaveLength(1);
    // It does not eat into the account's own budget for its next free actions...
    expect(h.db.prefundUsage(user.address, NOW_MS).addressDay).toBe(PREFUND_BUDGETS.perAddressDay);
    // ...and it does count in the one budget every address shares.
    expect(h.db.prefundUsage(user.address, NOW_MS).allAddressesHour).toBe(h.paid[0]!.amount);
  });

  it('a charged estimate is answered but never funded: only a verified send is', async () => {
    const h = await harness();
    const user = freshUser();
    useFreeActions(h.db, user.address, [[5, 20]]);
    h.chain.setMargin(user.address, { USDC: 10_000_000n });
    h.chain.deposits.set(user.address.toLowerCase(), 0n);

    // The browser estimates with a placeholder amount; the send is what is priced.
    const { wire } = await operation(user, [order, ...feeLeg(USDC, 1n)], { estimate: true });
    const body = await estimate(h, wire);

    expect(body.error).toBeUndefined();
    expect(body.result).toMatchObject({ callGasLimit: expect.any(String) });
    expect(h.paid).toHaveLength(0);
  });
});

describe('free tier used up, nothing in margin, and the batch adds funds first', () => {
  it('“Add funds” is itself an action: its fee is paid out of the deposit it makes', async () => {
    const h = await harness();
    const user = freshUser();
    useFreeActions(h.db, user.address, [[5, 20]]);
    h.chain.setMargin(user.address, { USDC: 0n, AUSD: 0n });
    const deposit: Call = { to: MARGIN, data: buildDeposit(MARGIN, user.address, USDC, 1_000_000n).data };

    // Without its fee leg it is refused (the client is expected to have quoted first
    // and attached one) — the one gas message, same as any other charged refusal.
    const bare = await operation(user, [deposit]);
    expect((await send(h, bare.wire)).error?.data).toMatchObject({ reason: 'FREE_ACTIONS_USED' });

    const q = await quote(h, user.address, [deposit]);
    expect(q.charge).toBe('fee');
    expect(q.fee).toMatchObject({ token: USDC, amount: GAS_FEE_MINIMUM.toString() });
    const { wire } = await operation(user, [deposit, ...q.fee!.calls!], { gas: gasOf(q.fee!) });
    expect((await send(h, wire)).error).toBeUndefined();
    expect(forwardedCalls(h)).toEqual([deposit, ...feeLeg(USDC, GAS_FEE_MINIMUM)]);
  });

  it('a deposit crediting someone else pays nothing toward this sender’s fee', async () => {
    const h = await harness();
    const user = freshUser();
    useFreeActions(h.db, user.address, [[5, 20]]);
    h.chain.setMargin(user.address, { USDC: 0n, AUSD: 0n });
    const forOther: Call = { to: MARGIN, data: buildDeposit(MARGIN, SOMEONE, USDC, 1_000_000n).data };
    const { wire } = await operation(user, [forOther]);
    expect((await send(h, wire)).error?.message).toBe(FREE_ACTIONS_USED_MESSAGE);
  });
});

describe('free tier used up, nothing in the trading balance: the honest refusal', () => {
  it('the owner’s exact sentence, on the estimate and on the send, and nothing spent', async () => {
    const h = await harness();
    const user = freshUser();
    useFreeActions(h.db, user.address, [[5, 20]]);
    h.chain.setMargin(user.address, { USDC: 0n, AUSD: 0n });
    h.chain.deposits.set(user.address.toLowerCase(), 0n);

    for (const estimateIt of [true, false]) {
      const { wire } = await operation(user, [order], { estimate: estimateIt });
      const body = estimateIt ? await estimate(h, wire) : await send(h, wire);
      // B2c's exact sentence, spelled out so a reworded constant fails here first.
      expect(body.error?.message).toBe(
        'Free actions for today are used. Swap into MON, or add money, and you can keep going.',
      );
      expect(body.error?.message).toBe(FREE_ACTIONS_USED_MESSAGE);
      expect(body.error?.data).toMatchObject({
        reason: 'FREE_ACTIONS_USED',
        // B2c: the refusal names its two live ways forward, machine-readably.
        choices: ['swap-into-mon', 'add-money'],
        freeActions: { limit: 20, used: 20, remaining: 0 },
      });
    }
    const q = await quote(h, user.address, [order]);
    expect(q).toMatchObject({ charge: 'refused', reason: 'no-trading-balance', message: FREE_ACTIONS_USED_MESSAGE });
    expect(h.forwarded).toHaveLength(0);
    expect(h.paid).toHaveLength(0);
  });

  it('a balance above zero but below the least fee cannot pay it either', async () => {
    const h = await harness();
    const user = freshUser();
    useFreeActions(h.db, user.address, [[5, 20]]);
    h.chain.setMargin(user.address, { USDC: GAS_FEE_MINIMUM - 1n, AUSD: GAS_FEE_MINIMUM - 1n });
    const { wire } = await operation(user, [order]);
    expect((await send(h, wire)).error?.message).toBe(FREE_ACTIONS_USED_MESSAGE);
  });

  it('with money in margin but no fee leg, the refusal is the one gas message, same as any other', async () => {
    const h = await harness();
    const user = freshUser();
    useFreeActions(h.db, user.address, [[5, 20]]);
    h.chain.setMargin(user.address, { USDC: 10_000_000n });
    const { wire } = await operation(user, [order]);
    const body = await send(h, wire);
    expect(body.error?.message).toBe(FREE_ACTIONS_USED_MESSAGE);
    expect(body.error?.data).toMatchObject({ reason: 'FREE_ACTIONS_USED' });
    expect(h.forwarded).toHaveLength(0);
  });
});

/**
 * Security review of D181, finding 1: the mainnet hard caps (`enforceHardCaps`, a
 * second allowlist that runs on every `/v1/bundler` call before the policy) refused
 * every phase-2 shape, and no route test reached it — the suites were green while
 * nothing worked. These run each new shape through the REAL route, estimate and
 * send, in mainnet mode (this harness's own mode), so the caps can never silently
 * disagree with the policy again.
 */
describe('mainnet hard caps admit every phase-2 shape (security review of D181, finding 1)', () => {
  const WMON_TOKEN = getAddress(MAINNET.tokens.WMON.address);
  const NATIVE = '0x0000000000000000000000000000000000000000' as Address;
  const REAL_SWAP = normalizeFlowCalldata(FLOW_USDC_AUSD_RESPONSE.transaction.calldata as Hex);
  const wordOf = (a: string) => a.slice(2).toLowerCase().padStart(64, '0');
  const rewriteWord = (data: Hex, index: number, word: string): Hex => {
    const start = 10 + index * 64;
    return (data.slice(0, start) + word + data.slice(start + 64)) as Hex;
  };
  const approveData = (_token: Address, spender: Address, value: bigint): Hex =>
    `0x095ea7b3${wordOf(spender)}${value.toString(16).padStart(64, '0')}` as Hex;
  const flowWord = (data: Hex, i: number) => data.slice(10 + i * 64, 10 + (i + 1) * 64);
  // 5 WMON: an 18-decimal amount astronomically above the 6e6 dollar figure — the
  // exact case the old unconditional swap cap refused.
  const AMOUNT_18DP = 5n * 10n ** 18n;
  const swapWmon = rewriteWord(
    rewriteWord(rewriteWord(REAL_SWAP, 0, wordOf(WMON_TOKEN)), 2, wordOf(WMON_TOKEN)),
    3,
    AMOUNT_18DP.toString(16).padStart(64, '0'),
  );

  it('D1: a non-dollar token transfer forwards, estimate and send', async () => {
    const h = await harness();
    const user = freshUser();
    const t: Call = { to: WMON_TOKEN, data: buildErc20Transfer(WMON_TOKEN, SOMEONE, 123n).data };
    const est = await estimate(h, (await operation(user, [t], { estimate: true })).wire);
    expect(est.error).toBeUndefined();
    const body = await send(h, (await operation(user, [t])).wire);
    expect(body.error).toBeUndefined();
    // Really forwarded — not a swallowed server error with no `.error` field.
    expect(h.forwarded.filter((f) => f.method === 'eth_sendUserOperation')).toHaveLength(1);
  });

  it('C1/B3: the approve triple paying 5 WMON into a WMON swap, unwrap behind it, forwards uncapped', async () => {
    const h = await harness();
    const user = freshUser();
    const calls: Call[] = [
      { to: WMON_TOKEN, data: approveData(WMON_TOKEN, KURU_FLOW_ROUTER, AMOUNT_18DP) },
      { to: KURU_FLOW_ROUTER, data: swapWmon },
      { to: WMON_TOKEN, data: approveData(WMON_TOKEN, KURU_FLOW_ROUTER, 0n) },
      { to: WMON_TOKEN, data: `0x2e1a7d4d${AMOUNT_18DP.toString(16).padStart(64, '0')}` as Hex },
    ];
    const est = await estimate(h, (await operation(user, calls, { estimate: true })).wire);
    expect(est.error).toBeUndefined();
    const body = await send(h, (await operation(user, calls)).wire);
    expect(body.error).toBeUndefined();
    expect(h.forwarded.filter((f) => f.method === 'eth_sendUserOperation')).toHaveLength(1);
    // Swap-into-MON: exempt, so no free action was drawn for it.
    expect(h.db.freeActionLedger(user.address)).toHaveLength(0);
  });

  it('D2: approve, deposit, revoke on a non-permit token forwards as a counted action', async () => {
    const h = await harness();
    const user = freshUser();
    const calls: Call[] = [
      { to: WMON_TOKEN, data: approveData(WMON_TOKEN, MARGIN, AMOUNT_18DP) },
      { to: MARGIN, data: buildDeposit(MARGIN, user.address, WMON_TOKEN, AMOUNT_18DP).data },
      { to: WMON_TOKEN, data: approveData(WMON_TOKEN, MARGIN, 0n) },
    ];
    const body = await send(h, (await operation(user, calls)).wire);
    expect(body.error).toBeUndefined();
    expect(h.forwarded.filter((f) => f.method === 'eth_sendUserOperation')).toHaveLength(1);
    expect(h.db.freeActionLedger(user.address)).toHaveLength(1);
  });

  it('D3: withdraw native MON plus the wrap, value and all, forwards uncounted', async () => {
    const h = await harness();
    const user = freshUser();
    const amt = 7n * 10n ** 17n;
    const w = buildWithdraw(MARGIN, NATIVE, amt);
    const calls: Call[] = [
      { to: w.to, data: w.data },
      { to: WMON_TOKEN, data: '0xd0e30db0' as Hex, value: amt },
    ];
    const body = await send(h, (await operation(user, calls)).wire);
    expect(body.error).toBeUndefined();
    expect(h.forwarded.filter((f) => f.method === 'eth_sendUserOperation')).toHaveLength(1);
    expect(h.db.freeActionLedger(user.address)).toHaveLength(0);
  });

  it('the dollar swap cap still binds: a USDC swap above 1,000,000,000 base units ($1,000) is refused, paired or bare', async () => {
    const h = await harness();
    const user = freshUser();
    const overCap = rewriteWord(REAL_SWAP, 3, (1_000_000_001n).toString(16).padStart(64, '0'));
    // Bare: refused for its missing allowance pairing before any cap is even asked.
    const bare = await send(h, (await operation(user, [{ to: KURU_FLOW_ROUTER, data: overCap }])).wire);
    expect(bare.error).toBeDefined();
    // Paired as the C1 triple: the dollar par cap (C2) refuses it — an over-cap
    // dollar swap cannot pass however it is dressed.
    const tokenIn = getAddress(`0x${flowWord(overCap, 2).slice(24)}`);
    const triple: Call[] = [
      { to: tokenIn, data: approveData(tokenIn, KURU_FLOW_ROUTER, 1_000_000_001n) },
      { to: KURU_FLOW_ROUTER, data: overCap },
      { to: tokenIn, data: approveData(tokenIn, KURU_FLOW_ROUTER, 0n) },
    ];
    const paired = await send(h, (await operation(user, triple)).wire);
    expect(paired.error?.message).toMatch(/cap|at most/i);
    expect(h.forwarded).toHaveLength(0);
  });
});

/**
 * Rules 1.8 and 1.9 through the REAL routes, estimate, send and quote (D182 F1's lesson:
 * the policy tests passed while the route caps refused). The KyberSwap calldata is the
 * recorded build (`packages/core/src/swap/__fixtures__`, 2026-09-29), re-encoded only
 * where a test says so: `dstReceiver`, because the policy binds the receiver to the
 * operation's own sender and every test here signs as a fresh account.
 */
describe('rule 1.8/1.9 shapes through the real routes: KyberSwap, the MON wrap and unwrap', () => {
  const WMON_TOKEN = getAddress(MAINNET.tokens.WMON.address);
  const ZERO = '0x0000000000000000000000000000000000000000' as Address;
  const kyberBuild = (name: string) =>
    (
      JSON.parse(
        readFileSync(new URL(`../../../packages/core/src/swap/__fixtures__/${name}`, import.meta.url), 'utf8'),
      ) as { data: { data: Hex } }
    ).data.data;
  /** Recorded: 500,000 USDC base units into WMON, and 0.1 WMON into USDC. */
  const USDC_TO_WMON = kyberBuild('kyberBuild.usdcToWmon.fixture.json');
  const WMON_TO_USDC = kyberBuild('kyberBuild.wmonToUsdc.fixture.json');
  const USDC_IN = 500_000n;
  const WMON_IN = 100_000_000_000_000_000n;
  const rewrite = (data: Hex, desc: Record<string, unknown>): Hex => {
    const [execution] = decodeFunctionData({ abi: KYBER_SWAP_ABI, data }).args;
    return encodeFunctionData({
      abi: KYBER_SWAP_ABI,
      functionName: 'swap',
      args: [{ ...execution, desc: { ...execution.desc, ...desc } }],
    });
  };
  const paying = (data: Hex, receiver: Address) => rewrite(data, { dstReceiver: receiver });
  const approveData = (spender: Address, value: bigint): Hex =>
    `0x095ea7b3${spender.slice(2).toLowerCase().padStart(64, '0')}${value.toString(16).padStart(64, '0')}` as Hex;
  const triple = (token: Address, amount: bigint, swap: Hex): Call[] => [
    { to: token, data: approveData(KYBER_ROUTER, amount) },
    { to: KYBER_ROUTER, data: swap },
    { to: token, data: approveData(KYBER_ROUTER, 0n) },
  ];
  const wrap = (value: bigint): Call => ({ to: WMON_TOKEN, data: '0xd0e30db0' as Hex, value });
  const unwrap = (amount: bigint): Call => ({
    to: WMON_TOKEN,
    data: `0x2e1a7d4d${amount.toString(16).padStart(64, '0')}` as Hex,
  });
  const sends = (h: Harness) => h.forwarded.filter((f) => f.method === 'eth_sendUserOperation');
  const rawQuote = (h: Harness, user: Address, calls: ReadonlyArray<Record<string, string>>) =>
    h.app.inject({
      method: 'POST',
      url: '/v1/gas/quote',
      payload: { sender: user, calls, maxFeePerGas: toHex(OP_MAX_FEE), maxPriorityFeePerGas: toHex(OP_TIP) },
    });

  it('KyberSwap USDC to WMON by the approve triple, unwrap behind it: quoted, estimated and sent as a swap into MON', async () => {
    const h = await harness();
    const user = freshUser();
    const calls = [...triple(USDC, USDC_IN, paying(USDC_TO_WMON, user.address)), unwrap(1n)];
    expect(await quote(h, user.address, calls)).toMatchObject({ charge: 'sponsored', reason: 'swap-into-mon' });
    expect((await estimate(h, (await operation(user, calls, { estimate: true })).wire)).error).toBeUndefined();
    expect((await send(h, (await operation(user, calls)).wire)).error).toBeUndefined();
    // Really forwarded, not a swallowed server error with no `.error` field.
    expect(sends(h)).toHaveLength(1);
    expect(h.db.freeActionLedger(user.address)).toHaveLength(0);
  });

  it('KyberSwap WMON to USDC, an 18-decimal amount far above the dollar figure, forwards as a counted action', async () => {
    const h = await harness();
    const user = freshUser();
    const calls = triple(WMON_TOKEN, WMON_IN, paying(WMON_TO_USDC, user.address));
    expect((await send(h, (await operation(user, calls)).wire)).error).toBeUndefined();
    expect(sends(h)).toHaveLength(1);
    expect(h.db.freeActionLedger(user.address)).toHaveLength(1);
  });

  it('a zero dstReceiver, which the verified router reads as the caller, forwards', async () => {
    const h = await harness();
    const user = freshUser();
    const calls = triple(USDC, USDC_IN, paying(USDC_TO_WMON, ZERO));
    expect((await send(h, (await operation(user, calls)).wire)).error).toBeUndefined();
    expect(sends(h)).toHaveLength(1);
  });

  /**
   * Owner item 1 (2026-09-29, D191): a fresh account's FIRST operation, carrying its
   * EIP-7702 authorization, being a swap into MON. Before D191 its estimate went to
   * Pimlico unfunded and failed AA21 (D190 finding 1).
   */
  async function firstOperation(
    user: PrivateKeyAccount,
    calls: readonly Call[],
    options: {
      estimate?: boolean;
      signer?: PrivateKeyAccount | 'stub';
      /** Who signs the 7702 authorization; 'junk' is an unsigned r/s pair. Default: the user. */
      authSigner?: PrivateKeyAccount | 'junk';
      nonce?: bigint;
    } = {},
  ) {
    const callData = await callDataFor(user, calls);
    const gas = planned(callData, calls.length);
    const authSigner = options.authSigner ?? user;
    const authorization =
      authSigner === 'junk'
        ? {
            address: SIMPLE_7702_DELEGATE,
            chainId: 143,
            nonce: 0,
            r: `0x${'11'.repeat(32)}` as Hex,
            s: `0x${'22'.repeat(32)}` as Hex,
            yParity: 0,
          }
        : await authSigner.signAuthorization({ address: SIMPLE_7702_DELEGATE, chainId: 143, nonce: 0 });
    const userOperation: UserOperation<'0.8'> = {
      sender: user.address,
      nonce: options.nonce ?? nonceKey++ << 64n,
      callData,
      factory: '0x7702',
      factoryData: '0x',
      authorization,
      callGasLimit: options.estimate ? 0n : gas.callGasLimit,
      verificationGasLimit: options.estimate ? 0n : gas.verificationGasLimit,
      preVerificationGas: options.estimate ? 0n : gas.preVerificationGas,
      maxFeePerGas: OP_MAX_FEE,
      maxPriorityFeePerGas: OP_TIP,
      signature: '0x',
    };
    const signer = options.signer ?? user;
    // A signature-shaped placeholder that recovers to nobody who signed it.
    const signature =
      signer === 'stub'
        ? (`0x${'11'.repeat(32)}${'22'.repeat(32)}1b` as Hex)
        : await signer.signTypedData(
            getUserOperationTypedData({ chainId: 143, entryPointAddress: ENTRY_POINT_V08, userOperation }),
          );
    return { wire: formatUserOperationRequest({ ...userOperation, signature }), gas };
  }

  it('item 1: a fresh account whose first operation is a swap into MON is estimated here and funded on its signed send', async () => {
    const h = await harness();
    const user = freshUser();
    h.chain.deposits.set(user.address.toLowerCase(), 0n);
    const calls = [...triple(USDC, USDC_IN, paying(USDC_TO_WMON, user.address)), unwrap(1n)];

    const est = await estimate(h, (await firstOperation(user, calls, { estimate: true })).wire);
    // Answered by this relayer from the delegated simulation: no AA21, no Pimlico, and
    // an estimate is still never funded (D177).
    expect(est.error).toBeUndefined();
    expect(est.result).toMatchObject({ callGasLimit: expect.any(String), preVerificationGas: expect.any(String) });
    expect(h.forwarded).toHaveLength(0);
    expect(h.paid).toHaveLength(0);

    const body = await send(h, (await firstOperation(user, calls)).wire);
    expect(body.error).toBeUndefined();
    expect(sends(h)).toHaveLength(1);
    expect(h.paid).toHaveLength(1);
    // Exempt: never counted.
    expect(h.db.freeActionLedger(user.address)).toHaveLength(0);
    // The backstop's marker, on the exempt lane, for exactly this operation.
    expect(h.db.outstandingFeePaidTopUp(user.address, 'exempt') ?? h.db.feePaidTopUps(user.address)[0]).toBeDefined();
    expect(h.db.outstandingFeePaidTopUp(user.address, 'fee-paid')).toBeUndefined();
  });

  it('item 1: the same first operation unsigned, or signed by another key, funds nothing', async () => {
    const h = await harness();
    const user = freshUser();
    h.chain.deposits.set(user.address.toLowerCase(), 0n);
    const calls = [...triple(USDC, USDC_IN, paying(USDC_TO_WMON, user.address)), unwrap(1n)];

    for (const signer of ['stub', freshUser()] as const) {
      const est = await estimate(h, (await firstOperation(user, calls, { estimate: true, signer })).wire);
      expect(h.paid).toHaveLength(0);
      void est;
      const sent = await send(h, (await firstOperation(user, calls, { signer })).wire);
      expect(sent.error?.message).toBe('the operation is not signed by its sender');
    }
    expect(h.paid).toHaveLength(0);
    expect(sends(h)).toHaveLength(0);
    expect(h.db.feePaidTopUps(user.address)).toHaveLength(0);
  });

  it('re-review finding A: an undelegated fresh account is quoted sponsored for its first swap into MON, and it goes through', async () => {
    const h = await harness();
    const user = freshUser();
    h.chain.undelegated.add(user.address.toLowerCase());
    h.chain.deposits.set(user.address.toLowerCase(), 0n);
    const calls = [...triple(USDC, USDC_IN, paying(USDC_TO_WMON, user.address)), unwrap(1n)];
    expect(await quote(h, user.address, calls)).toMatchObject({ charge: 'sponsored', reason: 'swap-into-mon' });
    expect((await estimate(h, (await firstOperation(user, calls, { estimate: true })).wire)).error).toBeUndefined();
    expect((await send(h, (await firstOperation(user, calls)).wire)).error).toBeUndefined();
    expect(h.paid).toHaveLength(1);
    expect(sends(h)).toHaveLength(1);
  });

  // Security review of D191, finding 1: a same-nonce resend is a second operation.
  it('finding 1: a same-nonce resend while the first never landed is not funded again, and the marker does not move', async () => {
    const h = await harness();
    h.chain.holdBundles = true;
    const user = freshUser();
    h.chain.deposits.set(user.address.toLowerCase(), 0n);
    const calls = [...triple(USDC, USDC_IN, paying(USDC_TO_WMON, user.address)), unwrap(1n)];
    const nonce = nonceKey++ << 64n;
    expect((await send(h, (await firstOperation(user, calls, { nonce })).wire)).error).toBeUndefined();
    const marker = h.db.outstandingFeePaidTopUp(user.address, 'exempt');
    expect(h.paid).toHaveLength(1);

    // The deposit withdrawn before the first is bundled, then the same nonce, new calldata.
    h.chain.deposits.set(user.address.toLowerCase(), 0n);
    const resend = await send(h, (await firstOperation(user, [...calls.slice(0, 3), unwrap(2n)], { nonce })).wire);
    expect(resend.error).toBeDefined();
    expect(h.paid).toHaveLength(1);
    expect(h.db.outstandingFeePaidTopUp(user.address, 'exempt')?.userOpHash).toBe(marker?.userOpHash);
  });

  // Finding 2: only a verified first operation is one, and none is ever charged-funded.
  it('finding 2: a charged operation carrying an authorization, junk or real, is refused unpriced; nothing paid', async () => {
    const h = await harness();
    const user = freshUser();
    useFreeActions(h.db, user.address, [[1, 20]]);
    h.chain.setMargin(user.address, { USDC: 10_000_000n });
    h.chain.deposits.set(user.address.toLowerCase(), 0n);
    const action = triple(WMON_TOKEN, WMON_IN, paying(WMON_TO_USDC, user.address));
    // A fresh fee pricing on record, as the browser's quote leaves one.
    expect((await quote(h, user.address, action)).charge).toBe('fee');
    const calls = [...action, ...feeLeg(USDC, GAS_FEE_MINIMUM)];
    for (const authSigner of ['junk', user] as const) {
      const body = await send(h, (await firstOperation(user, calls, { authSigner })).wire);
      expect(body.error?.data).toMatchObject({ reason: 'GAS_FEE_UNPRICED' });
    }
    expect(h.paid).toHaveLength(0);
    expect(h.forwarded).toHaveLength(0);
  });

  it('finding 2: an authorization signed by another key is not a first operation: Pimlico estimates it, nothing is read', async () => {
    const h = await harness();
    const user = freshUser();
    const calls = [...triple(USDC, USDC_IN, paying(USDC_TO_WMON, user.address)), unwrap(1n)];
    const est = await estimate(h, (await firstOperation(user, calls, { estimate: true, authSigner: freshUser() })).wire);
    expect(est.result).toBe(`0x${'ab'.repeat(32)}`);
    expect(h.forwarded.map((f) => f.method)).toEqual(['eth_estimateUserOperationGas']);
  });

  // Finding 5: a node that ignores the override answers the bare call's intrinsic gas.
  it('finding 5: a first-operation estimate no larger than the intrinsic gas is not an answer: Pimlico estimates it', async () => {
    const h = await harness();
    const user = freshUser();
    h.chain.innerEstimate = 21_000n;
    const calls = [...triple(USDC, USDC_IN, paying(USDC_TO_WMON, user.address)), unwrap(1n)];
    const est = await estimate(h, (await firstOperation(user, calls, { estimate: true })).wire);
    expect(est.result).toBe(`0x${'ab'.repeat(32)}`);
    expect(h.forwarded).toHaveLength(1);
  });

  // Findings 3 and 4: an exempt operation someone else bundled refills nothing, and the
  // quote and the send fall through instead of promising sponsorship.
  it('findings 3 and 4: after a Pimlico-bundled exempt op, the next exempt top-up is not sponsored; quote and send fall through', async () => {
    const h = await harness();
    h.chain.chargeOnExecute = 50_000_000_000_000_000n;
    const user = freshUser();
    h.chain.deposits.set(user.address.toLowerCase(), 0n);
    const calls = [...triple(USDC, USDC_IN, paying(USDC_TO_WMON, user.address)), unwrap(1n)];
    expect((await send(h, (await firstOperation(user, calls)).wire)).error).toBeUndefined();
    expect(h.paid).toHaveLength(1);

    // The leftover withdrawn: a new top-up would be needed, and nothing counted was burned.
    h.chain.deposits.set(user.address.toLowerCase(), 0n);
    h.chain.setMargin(user.address, { USDC: 10_000_000n });
    const q = await quote(h, user.address, [withdrawOwn()]);
    expect(q.charge).not.toBe('sponsored');

    const body = await send(h, (await operation(user, [withdrawOwn()])).wire);
    expect(body.error?.message).toBe(SPONSORSHIP_PAUSED_MESSAGE);
    expect(body.error?.data).toMatchObject({ reason: 'FREE_ACTIONS_USED' });
    expect(h.paid).toHaveLength(1);
  });

  it('item 1: the exempt lane holds one outstanding top-up per address, keyed by its operation', async () => {
    const h = await harness();
    h.chain.holdBundles = true; // the first operation has not landed yet
    const user = freshUser();
    h.chain.deposits.set(user.address.toLowerCase(), 0n);
    const calls = [...triple(USDC, USDC_IN, paying(USDC_TO_WMON, user.address)), unwrap(1n)];
    expect((await send(h, (await firstOperation(user, calls)).wire)).error).toBeUndefined();
    expect(h.paid).toHaveLength(1);

    // A second exempt operation (a new nonce) while the first is unseen: nothing advanced.
    h.chain.deposits.set(user.address.toLowerCase(), 0n);
    const second = await send(h, (await operation(user, calls)).wire);
    expect(second.error?.data).toMatchObject({ reason: 'PRIOR_FEE_UNCONFIRMED' });
    expect(h.paid).toHaveLength(1);
  });

  /**
   * Owner item 2 (2026-09-29, D191): a MON budget being reached never refuses while free
   * actions remain. It falls through to the account's own MON, then the trading-balance
   * fee; "Free actions for today are used" appears only when the free tier is at 0.
   */
  const spendOwnHour = (h: Harness, user: Address, scope: 'sponsored' | 'exempt') => {
    const budgets = budgetsFor(PREFUND_BUDGETS, scope);
    const r = h.db.reservePrefund({
      address: user,
      amountWei: budgets.perAddressHour,
      purpose: scope === 'exempt' ? EXEMPT_PURPOSE : 'deposit',
      budgets,
      now: NOW_MS,
    });
    if (!r.ok) throw new Error('fixture could not spend the hour');
    h.db.settlePrefund(r.id, 'paid', { now: NOW_MS });
  };

  it('item 2: 19 of 20 left and the hourly budget spent, a counted KyberSwap swap proceeds on the trading-balance fee', async () => {
    const h = await harness();
    const user = freshUser();
    useFreeActions(h.db, user.address, [[1, 1]]); // 19 of 20 left
    spendOwnHour(h, user.address, 'sponsored');
    h.chain.setMargin(user.address, { USDC: 10_000_000n });
    h.chain.deposits.set(user.address.toLowerCase(), 0n);
    const calls = triple(WMON_TOKEN, WMON_IN, paying(WMON_TO_USDC, user.address));

    const q = await quote(h, user.address, calls);
    expect(q).toMatchObject({ charge: 'fee', reason: 'sponsorship-budget-used' });
    expect(q.freeActions.remaining).toBe(19);
    const body = await send(h, (await operation(user, [...calls, ...q.fee!.calls!], { gas: gasOf(q.fee!) })).wire);
    expect(body.error).toBeUndefined();
    expect(sends(h)).toHaveLength(1);
  });

  it('item 2: 19 of 20 left and the exempt hour spent, a swap into MON proceeds on the trading-balance fee', async () => {
    const h = await harness();
    const user = freshUser();
    useFreeActions(h.db, user.address, [[1, 1]]);
    spendOwnHour(h, user.address, 'exempt');
    h.chain.setMargin(user.address, { USDC: 10_000_000n });
    h.chain.deposits.set(user.address.toLowerCase(), 0n);
    const calls = [...triple(USDC, USDC_IN, paying(USDC_TO_WMON, user.address)), unwrap(1n)];

    const q = await quote(h, user.address, calls);
    expect(q).toMatchObject({ charge: 'fee', reason: 'sponsorship-budget-used' });
    const body = await send(h, (await operation(user, [...calls, ...q.fee!.calls!], { gas: gasOf(q.fee!) })).wire);
    expect(body.error).toBeUndefined();
    expect(sends(h)).toHaveLength(1);
    expect(h.db.freeActionLedger(user.address)).toHaveLength(1); // still uncounted
  });

  it('item 2: 19 of 20 left and the hourly budget spent, the swap proceeds on the account’s own MON first', async () => {
    const h = await harness();
    const user = freshUser();
    useFreeActions(h.db, user.address, [[1, 1]]);
    spendOwnHour(h, user.address, 'sponsored');
    h.chain.nativeBalances.set(user.address.toLowerCase(), 12n * MON);
    h.chain.deposits.set(user.address.toLowerCase(), 0n);
    const calls = triple(WMON_TOKEN, WMON_IN, paying(WMON_TO_USDC, user.address));

    expect(await quote(h, user.address, calls)).toMatchObject({ charge: 'own-mon' });
    const body = await send(h, (await operation(user, calls)).wire);
    expect(body.error).toBeUndefined();
    expect(sends(h)).toHaveLength(1);
    expect(h.paid).toHaveLength(0);
  });

  it('item 2: 19 of 20 left and nothing can pay: the budget sentence, never "Free actions for today are used"', async () => {
    const h = await harness();
    const user = freshUser();
    useFreeActions(h.db, user.address, [[1, 1]]);
    spendOwnHour(h, user.address, 'sponsored');
    h.chain.deposits.set(user.address.toLowerCase(), 0n);
    const calls = triple(WMON_TOKEN, WMON_IN, paying(WMON_TO_USDC, user.address));

    const q = await quote(h, user.address, calls);
    expect(q).toMatchObject({ charge: 'refused', message: SPONSORSHIP_PAUSED_MESSAGE });
    const body = await send(h, (await operation(user, calls)).wire);
    expect(body.error?.message).toBe(SPONSORSHIP_PAUSED_MESSAGE);
    expect(body.error?.message).not.toBe(FREE_ACTIONS_USED_MESSAGE);
    expect(h.forwarded).toHaveLength(0);
  });

  it('item 2: the free-actions sentence still appears when the free tier really is at 0', async () => {
    const h = await harness();
    const user = freshUser();
    useFreeActions(h.db, user.address, [[1, 20]]);
    h.chain.deposits.set(user.address.toLowerCase(), 0n);
    const calls = triple(WMON_TOKEN, WMON_IN, paying(WMON_TO_USDC, user.address));
    const q = await quote(h, user.address, calls);
    expect(q).toMatchObject({ charge: 'refused', message: FREE_ACTIONS_USED_MESSAGE });
  });

  it('a KyberSwap swap paying anyone but the signer is refused on quote, estimate and send; nothing forwarded or paid', async () => {
    const h = await harness();
    const user = freshUser();
    h.chain.deposits.set(user.address.toLowerCase(), 0n);
    // The recorded build, untouched: it pays the acceptance account, not this signer.
    const calls = triple(USDC, USDC_IN, USDC_TO_WMON);
    const q = await rawQuote(h, user.address, calls.map((c) => ({ to: c.to, data: c.data })));
    expect(q.statusCode).toBe(400);
    expect(q.body).toMatch(/must pay the account that signs it/);
    const est = await estimate(h, (await operation(user, calls, { estimate: true })).wire);
    expect(est.error?.message).toMatch(/must pay the account that signs it/);
    const body = await send(h, (await operation(user, calls)).wire);
    expect(body.error?.message).toMatch(/must pay the account that signs it/);
    expect(h.forwarded).toHaveLength(0);
    expect(h.paid).toHaveLength(0);
  });

  it('the dollar cap binds a KyberSwap USDC swap above 1,000,000,000 base units ($1,000), and a bare swap is refused', async () => {
    const h = await harness();
    const user = freshUser();
    const overCap = rewrite(USDC_TO_WMON, { dstReceiver: user.address, amount: 1_000_000_001n });
    const paired = await send(h, (await operation(user, triple(USDC, 1_000_000_001n, overCap))).wire);
    expect(paired.error?.message).toMatch(/cap|at most/i);
    const bare = await send(
      h,
      (await operation(user, [{ to: KYBER_ROUTER, data: paying(USDC_TO_WMON, user.address) }])).wire,
    );
    expect(bare.error?.message).toMatch(/directly after the permit or exact approval/);
    expect(h.forwarded).toHaveLength(0);
  });

  it('MON to WMON: the lone wrap is quoted with its value, then forwards value and all, counted', async () => {
    const h = await harness();
    const user = freshUser();
    h.chain.nativeBalances.set(user.address.toLowerCase(), 20n * MON);
    const calls = [wrap(MON)];
    expect(await quote(h, user.address, calls)).toMatchObject({ charge: 'sponsored', reason: 'free-action' });
    // Quoted without its value it is a bare deposit() on WMON, which the policy refuses:
    // why `/v1/gas/quote` has to carry value at all.
    expect((await rawQuote(h, user.address, [{ to: WMON_TOKEN, data: '0xd0e30db0' }])).statusCode).toBe(400);
    expect((await send(h, (await operation(user, calls)).wire)).error).toBeUndefined();
    expect(sends(h)).toHaveLength(1);
    const op = sends(h)[0]!.params[0] as { callData: Hex };
    const [, value] = decodeFunctionData({
      abi: [
        {
          type: 'function',
          name: 'execute',
          stateMutability: 'payable',
          inputs: [
            { name: 'target', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'data', type: 'bytes' },
          ],
          outputs: [],
        },
      ],
      data: op.callData,
    }).args;
    expect(value).toBe(MON);
    expect(h.db.freeActionLedger(user.address)).toHaveLength(1);
  });

  it('MON as swap input: the exact wrap, then the WMON triple into KyberSwap, forwards counted; the wrap before anything else is refused', async () => {
    const h = await harness();
    const user = freshUser();
    h.chain.nativeBalances.set(user.address.toLowerCase(), 20n * MON);
    const calls = [wrap(WMON_IN), ...triple(WMON_TOKEN, WMON_IN, paying(WMON_TO_USDC, user.address))];
    expect(await quote(h, user.address, calls)).toMatchObject({ charge: 'sponsored', reason: 'free-action' });
    expect((await send(h, (await operation(user, calls)).wire)).error).toBeUndefined();
    expect(sends(h)).toHaveLength(1);
    expect(h.db.freeActionLedger(user.address)).toHaveLength(1);
    // One wei short of the swap it heads, or ahead of a send: refused, nothing more forwarded.
    const short = [wrap(WMON_IN - 1n), ...triple(WMON_TOKEN, WMON_IN, paying(WMON_TO_USDC, user.address))];
    expect((await send(h, (await operation(user, short)).wire)).error?.message).toMatch(/may be wrapped only/);
    expect((await send(h, (await operation(user, [wrap(WMON_IN), sendOwn()])).wire)).error?.message).toMatch(
      /may be wrapped only/,
    );
    expect(sends(h)).toHaveLength(1);
  });

  it('WMON to MON: the lone unwrap, and the margin withdrawal of WMON with its unwrap, forward uncounted', async () => {
    const h = await harness();
    const user = freshUser();
    expect(await quote(h, user.address, [unwrap(5n)])).toMatchObject({
      charge: 'sponsored',
      reason: 'swap-into-mon',
    });
    expect((await send(h, (await operation(user, [unwrap(5n)])).wire)).error).toBeUndefined();
    const w = buildWithdraw(MARGIN, WMON_TOKEN, 5n);
    const fromMargin: Call[] = [{ to: w.to, data: w.data }, unwrap(5n)];
    expect((await send(h, (await operation(user, fromMargin)).wire)).error).toBeUndefined();
    expect(sends(h)).toHaveLength(2);
    expect(h.db.freeActionLedger(user.address)).toHaveLength(0);
  });

  it('a wrap the chain refuses for the 10 MON reserve is refused by the relayer before any top-up, estimate and send', async () => {
    const h = await harness();
    const user = freshUser();
    // Deposit empty, so an operation this relayer let through would be topped up first.
    h.chain.deposits.set(user.address.toLowerCase(), 0n);
    h.chain.innerReserveViolation = true;
    const calls = [wrap(MON)];
    const est = await estimate(h, (await operation(user, calls, { estimate: true })).wire);
    expect(est.error?.message).toMatch(/needs at least 10 MON/);
    const body = await send(h, (await operation(user, calls)).wire);
    expect(body.error?.code).toBe(-32521);
    expect(body.error?.message).toMatch(/needs at least 10 MON/);
    expect(h.paid).toHaveLength(0);
    expect(h.forwarded).toHaveLength(0);
    expect(h.db.freeActionLedger(user.address)).toHaveLength(0);
  });
});

describe('B2a: after the free tier, the account’s own MON pays — no top-up, nothing charged', () => {
  it('the 21st action with 20 MON in the wallet pays from MON: quoted own-mon, forwarded, relayer advances nothing', async () => {
    const h = await harness();
    const user = freshUser();
    useFreeActions(h.db, user.address, [[5, 20]]);
    h.chain.setMargin(user.address, { USDC: 0n, AUSD: 0n });
    h.chain.deposits.set(user.address.toLowerCase(), 0n);
    h.chain.nativeBalances.set(user.address.toLowerCase(), 20n * MON);

    const q = await quote(h, user.address, [order]);
    expect(q.charge).toBe('own-mon');
    expect(q.reason).toBe('own-mon');
    // The real read figures (B2a's own screen line), never estimates of estimates.
    expect(q.ownMon).toMatchObject({
      balanceWei: (20n * MON).toString(),
      reserveWei: (10n * MON).toString(),
      depositWei: '0',
    });
    expect(BigInt(q.ownMon!.gasWei)).toBeGreaterThan(0n);

    const { wire } = await operation(user, [order]);
    const body = await send(h, wire);
    expect(body.error).toBeUndefined();
    // Forwarded unfunded: the EntryPoint draws the prefund from the account itself.
    expect(h.forwarded.length).toBeGreaterThan(0);
    expect(h.paid).toHaveLength(0);
    // Still the 21st action: no free action was taken for it and nothing was charged.
    expect(h.db.freeActionLedger(user.address)).toHaveLength(20);
  });

  it('with the wallet under reserve-plus-prefund the lane is not offered: USDC in margin charges instead', async () => {
    const h = await harness();
    const user = freshUser();
    useFreeActions(h.db, user.address, [[5, 20]]);
    h.chain.setMargin(user.address, { USDC: 10_000_000n });
    h.chain.deposits.set(user.address.toLowerCase(), 0n);
    // 10.1 MON: above the bare reserve, below reserve + this operation's ~0.23 MON
    // prefund — the owner's rule is the wallet holds BOTH, so the fee lane is next.
    h.chain.nativeBalances.set(user.address.toLowerCase(), 10n * MON + MON / 10n);

    const q = await quote(h, user.address, [order]);
    expect(q.charge).toBe('fee');
    expect(q.fee).toMatchObject({ token: USDC });
  });

  it('with no MON and nothing in margin: the one refusal, both live choices, on quote and send', async () => {
    const h = await harness();
    const user = freshUser();
    useFreeActions(h.db, user.address, [[5, 20]]);
    h.chain.setMargin(user.address, { USDC: 0n, AUSD: 0n });
    h.chain.deposits.set(user.address.toLowerCase(), 0n);

    const q = await quote(h, user.address, [order]);
    expect(q).toMatchObject({ charge: 'refused', reason: 'no-trading-balance', message: FREE_ACTIONS_USED_MESSAGE });

    const { wire } = await operation(user, [order]);
    const body = await send(h, wire);
    expect(body.error?.message).toBe(FREE_ACTIONS_USED_MESSAGE);
    expect(body.error?.data).toMatchObject({ choices: ['swap-into-mon', 'add-money'] });
    expect(h.forwarded).toHaveLength(0);
    expect(h.paid).toHaveLength(0);
  });
});

describe('sends and withdraws of the user’s own funds are never counted and never charged', () => {
  it('fifty of them move nothing on the counter, show no fee, and forward as signed', async () => {
    const h = await harness();
    const user = freshUser();
    h.chain.setMargin(user.address, { USDC: 100_000_000n });

    for (let i = 0; i < 25; i++) {
      for (const call of [withdrawOwn(), sendOwn()]) {
        const q = await quote(h, user.address, [call]);
        expect(q).toMatchObject({ charge: 'sponsored', reason: 'own-funds' });
        expect(q.fee).toBeUndefined();
        const { wire } = await operation(user, [call]);
        const body = await send(h, wire);
        expect(body.error).toBeUndefined();
        expect(forwardedCalls(h)).toEqual([call]);
      }
    }
    expect(h.forwarded).toHaveLength(50);
    expect(h.db.freeActionLedger(user.address)).toHaveLength(0);
    expect((await allowance(h, user.address)).freeActions).toMatchObject({ used: 0, remaining: 20 });
  });

  it('still free, and still uncounted, with every free action already used', async () => {
    const h = await harness();
    const user = freshUser();
    useFreeActions(h.db, user.address, [[5, 20]]);
    h.chain.setMargin(user.address, { USDC: 0n, AUSD: 0n }); // could not pay a fee anyway

    for (const call of [withdrawOwn(), sendOwn(), withdrawOwn(), sendOwn()]) {
      const q = await quote(h, user.address, [call]);
      expect(q).toMatchObject({ charge: 'sponsored', reason: 'own-funds' });
      const { wire } = await operation(user, [call]);
      expect((await send(h, wire)).error).toBeUndefined();
    }
    // Withdrawing and then sending on, in one batch, is still the user's own funds.
    const { wire } = await operation(user, [withdrawOwn(), sendOwn()]);
    expect((await send(h, wire)).error).toBeUndefined();
    expect(h.forwarded).toHaveLength(5);
    expect(h.db.freeActionLedger(user.address)).toHaveLength(20);
  });

  it('a withdraw past the exempt pool is not refused: it falls through to a charged fee, still uncounted (B2d)', async () => {
    const h = await harness();
    const user = freshUser();
    useFreeActions(h.db, user.address, [[5, 20]]);
    h.chain.setMargin(user.address, { USDC: 100_000_000n });
    h.chain.deposits.set(user.address.toLowerCase(), 0n);
    // Drain this account's exempt per-address hour with real, sponsored withdraws.
    for (let i = 0; i < 20; i += 1) {
      const { wire } = await operation(user, [withdrawOwn()]);
      const body = await send(h, wire);
      if (body.error) break;
      h.chain.deposits.set(user.address.toLowerCase(), 0n);
    }
    expect(h.paid.length).toBeGreaterThan(0);
    const sponsoredTopUps = h.paid.length;

    // The pool's edge bounds SPONSORSHIP, not the action: the quote steers the same
    // withdraw to the fee lane (no native MON here, so own-MON is skipped)...
    const q = await quote(h, user.address, [withdrawOwn()]);
    expect(q.charge).toBe('fee');
    // ...and the withdraw, carrying the quoted fee leg, still goes.
    const { wire } = await operation(user, [withdrawOwn(), ...q.fee!.calls!], { gas: gasOf(q.fee!) });
    const body = await send(h, wire);
    expect(body.error).toBeUndefined();
    expect(h.paid.length).toBe(sponsoredTopUps + 1);
    // Charged now, but still never counted: the free-action counter has not moved.
    expect(h.db.freeActionLedger(user.address)).toHaveLength(20);
  });
});

describe('rebuild, 2026-09-25: the reported bug — a withdraw refused with 18 of 20 free actions left', () => {
  /** Exhausts the SPONSORED per-address rolling day for `user` — the exact shape of the
   *  reported bug's own log line, `"exhausted":["ADDRESS_DAY"]`. Exempt (withdraw/send/
   *  cancel) runs on its own separate, bounded ledger (security review finding 1) and is
   *  untouched by this — that separation is exactly what these tests check.
   *
   *  A further reservation for the current hour, once tried here, always failed silently
   *  (security review finding 2): the day being spent already zeroes `headroom.remaining`
   *  (the minimum of all three budgets), so any later `reservePrefund` call, for any
   *  amount, is refused — there is no separate "hour, on top of an already-spent day"
   *  state to put the ledger into. `ADDRESS_DAY` alone is what the real bug exhausted. */
  function exhaustEveryPerAddressBudget(db: RelayerDb, user: Address) {
    // Four windows summing to the full 2 MON day, none in the current hour.
    for (const hoursAgo of [4, 3, 2, 1]) {
      const at = NOW_MS - hoursAgo * HOUR_MS;
      const r = db.reservePrefund({
        address: user,
        amountWei: PREFUND_BUDGETS.perAddressDay / 4n,
        purpose: 'deposit',
        budgets: PREFUND_BUDGETS,
        now: at,
      });
      if (!r.ok) throw new Error('fixture could not reserve the day');
      db.settlePrefund(r.id, 'paid', { now: at });
    }
  }

  it('withdraw with every MON budget exhausted still succeeds, sponsored, uncounted — never the allowance sentence', async () => {
    const h = await harness();
    const user = freshUser();
    // The reported symptom exactly: most of a day's free actions already used, well
    // short of the 20 limit — the free tier is not what is tight here.
    useFreeActions(h.db, user.address, [[1, 2]]);
    exhaustEveryPerAddressBudget(h.db, user.address);
    h.chain.setMargin(user.address, { USDC: 100_000_000n });
    // The harness's default deposit (1 MON) would otherwise answer `ensure()` with
    // 'not-needed' before any budget is ever read, so the exempt path itself would
    // never run — exactly the gap security review finding 2 caught in the first draft.
    h.chain.deposits.set(user.address.toLowerCase(), 0n);

    const q = await quote(h, user.address, [withdrawOwn()]);
    expect(q).toMatchObject({ charge: 'sponsored', reason: 'own-funds' });
    const { wire, gas } = await operation(user, [withdrawOwn()]);
    const body = await send(h, wire);
    expect(body.error).toBeUndefined();
    expect(forwardedCalls(h)).toEqual([withdrawOwn()]);
    // A real top-up went out, on the exempt path, sized to exactly this operation's own
    // signed prefund — never the flat 0.30 MON a sponsored top-up otherwise uses
    // (security review finding 1, sizing).
    const prefund = (gas.callGasLimit + gas.verificationGasLimit + gas.preVerificationGas) * OP_MAX_FEE;
    expect(h.paid).toEqual([{ account: user.address, amount: prefund }]);
    expect(h.db.prefundLedger(user.address)[0]?.purpose).toBe('exempt');
    // Still uncounted — a withdraw never touches the free-action ledger, exhausted
    // MON budget or not.
    expect(h.db.freeActionLedger(user.address)).toHaveLength(2);
    expect((await allowance(h, user.address)).freeActions).toMatchObject({ used: 2, remaining: 18 });
  });

  it('send with every MON budget exhausted also succeeds, sponsored, uncounted', async () => {
    const h = await harness();
    const user = freshUser();
    useFreeActions(h.db, user.address, [[1, 2]]);
    exhaustEveryPerAddressBudget(h.db, user.address);
    h.chain.setMargin(user.address, { USDC: 100_000_000n });
    h.chain.deposits.set(user.address.toLowerCase(), 0n);

    const { wire } = await operation(user, [sendOwn()]);
    const body = await send(h, wire);
    expect(body.error).toBeUndefined();
    expect(h.paid).toHaveLength(1);
    expect(h.db.freeActionLedger(user.address)).toHaveLength(2);
  });

  it('cancel with every MON budget exhausted also succeeds, sponsored, uncounted', async () => {
    const h = await harness();
    const user = freshUser();
    useFreeActions(h.db, user.address, [[1, 2]]);
    exhaustEveryPerAddressBudget(h.db, user.address);
    h.chain.setMargin(user.address, { USDC: 100_000_000n });
    h.chain.deposits.set(user.address.toLowerCase(), 0n);

    const q = await quote(h, user.address, [cancel]);
    expect(q).toMatchObject({ charge: 'sponsored', reason: 'cancel' });
    const { wire } = await operation(user, [cancel]);
    expect((await send(h, wire)).error).toBeUndefined();
    expect(h.paid).toHaveLength(1);
    expect(h.db.freeActionLedger(user.address)).toHaveLength(2);
  });

  it('an estimate for a withdraw is never funded, even signed — only a real send is (security review finding 1)', async () => {
    const h = await harness();
    const user = freshUser();
    h.chain.setMargin(user.address, { USDC: 100_000_000n });
    h.chain.deposits.set(user.address.toLowerCase(), 0n);

    const { wire } = await operation(user, [withdrawOwn()], { estimate: true });
    const body = await estimate(h, wire);
    expect(body.error).toBeUndefined();
    // No top-up: an estimate never has to run or land, so funding one for free let a
    // stream of fresh addresses draw MON with no cost to them at all.
    expect(h.paid).toHaveLength(0);
  });

  it("the exempt pool has its own bound: exhausting it refuses further withdraws, and never spills into the sponsored or fee-paid budgets", async () => {
    const h = await harness();
    const attacker = freshUser();
    h.chain.setMargin(attacker.address, { USDC: 100_000_000n });
    h.chain.deposits.set(attacker.address.toLowerCase(), 0n);
    // Draw the exempt per-address hour cap down with real sends, each a fresh nonce.
    for (let i = 0; i < 20; i += 1) {
      const { wire } = await operation(attacker, [withdrawOwn()]);
      const body = await send(h, wire);
      if (body.error) break;
      h.chain.deposits.set(attacker.address.toLowerCase(), 0n);
    }
    expect(h.paid.length).toBeGreaterThan(0);
    const spentOnExempt = h.paid.reduce((sum, p) => sum + p.amount, 0n);
    // A percentage of the exempt POOL itself (third review round, finding 1) — not a
    // fixed wei figure, which happened to equal the whole pool at the default budgets.
    const exemptPool = effectiveExemptAllAddressesHourCap(PREFUND_BUDGETS.allAddressesHour);
    const perAddressCeiling = effectiveExemptPerAddressHourCap(exemptPool);
    expect(perAddressCeiling).toBeLessThan(exemptPool);
    expect(spentOnExempt).toBeLessThanOrEqual(perAddressCeiling);

    // A second, unrelated address's own sponsored and fee-paid budgets are untouched —
    // the exempt pool is its own ledger, never anyone else's.
    const other = freshUser();
    expect(h.db.prefundUsage(other.address, NOW_MS, 'sponsored').allAddressesHour).toBe(0n);
  });

  it('the exempt SHARED hour has its own bound too: many fresh addresses cannot together draw past it (security review finding 1, second round)', async () => {
    const h = await harness();
    let refusedAt: number | undefined;
    for (let i = 0; i < 40; i += 1) {
      const addr = freshUser();
      h.chain.setMargin(addr.address, { USDC: 100_000_000n });
      h.chain.deposits.set(addr.address.toLowerCase(), 0n);
      const { wire } = await operation(addr, [withdrawOwn()]);
      const body = await send(h, wire);
      if (body.error) {
        // B2c: the wire carries the one gas sentence; the exhausted shared scope is
        // asserted below from the ledger itself, where the truth now lives.
        expect(body.error.data).toMatchObject({ reason: 'FREE_ACTIONS_USED' });
        refusedAt = i;
        break;
      }
    }
    expect(refusedAt).toBeDefined();
    const exemptCeiling = effectiveExemptAllAddressesHourCap(PREFUND_BUDGETS.allAddressesHour);
    const spentOnExempt = h.paid.reduce((sum, p) => sum + p.amount, 0n);
    expect(spentOnExempt).toBeLessThanOrEqual(exemptCeiling);
    // The pool actually got close to full, not refused for some other reason early.
    expect(spentOnExempt).toBeGreaterThan((exemptCeiling * 9n) / 10n);
    const lastAddr = h.paid[h.paid.length - 1]!.account;
    expect(h.db.prefundUsage(lastAddr, NOW_MS, 'exempt').allAddressesHour).toBe(spentOnExempt);
  });

  it("the exempt shared hour is carved out of the existing ceiling, not added to it: sponsored plus exempt spend together never exceed the one number the owner reviewed (security review finding 1, second round — the first bound doubled the relayer's hourly payout)", async () => {
    const h = await harness();
    // Spend the SPONSORED shared hour down with ordinary paid orders from several
    // addresses (mirrors the F4 `spendHour`/nine-others pattern used elsewhere in this
    // file), then draw the EXEMPT shared hour down too, and check the combined total.
    // Reserved against the carved-down sponsored ceiling `ensure` itself uses
    // (`budgetsFor`), not the raw total — otherwise this fixture could over-reserve
    // past what production code would ever actually allow on the sponsored ledger.
    const sponsoredBudgets = budgetsFor(PREFUND_BUDGETS, 'sponsored');
    for (let i = 0; i < 12; i++) {
      const addr = getAddress(`0x${(0xc000 + i).toString(16).padStart(40, '0')}`);
      const r = h.db.reservePrefund({
        address: addr,
        amountWei: PREFUND_BUDGETS.perAddressHour,
        purpose: 'deposit',
        budgets: sponsoredBudgets,
        now: NOW_MS,
      });
      if (r.ok) h.db.settlePrefund(r.id, 'paid', { now: NOW_MS });
    }
    const sponsoredSpent = h.db.prefundUsage(
      getAddress(`0x${(0xc000).toString(16).padStart(40, '0')}`),
      NOW_MS,
      'sponsored',
    ).allAddressesHour;
    for (let i = 0; i < 40; i += 1) {
      const addr = freshUser();
      h.chain.setMargin(addr.address, { USDC: 100_000_000n });
      h.chain.deposits.set(addr.address.toLowerCase(), 0n);
      const { wire } = await operation(addr, [withdrawOwn()]);
      const body = await send(h, wire);
      if (body.error) break;
    }
    const exemptSpent = h.paid.reduce((sum, p) => sum + p.amount, 0n);
    // The two ledgers together never exceed the single number the owner has seen —
    // reproduced without this carve-out: 9.86 MON in one hour against a 5 MON ceiling.
    expect(sponsoredSpent + exemptSpent).toBeLessThanOrEqual(PREFUND_BUDGETS.allAddressesHour);
  });

  it('CHARGED plus exempt spend together, both driven through the real routes (not manual ledger writes), never exceed the one reviewed total (third review round, finding 2 — this exact combination had no test and survived being uncarved)', async () => {
    const h = await harness();
    // Several charged (fee-paid) orders from different addresses, each with its free
    // tier already exhausted, exactly the F4 pattern used elsewhere in this file.
    for (let i = 0; i < 8; i++) {
      const user = freshUser();
      useFreeActions(h.db, user.address, [[5, 20]]);
      h.chain.setMargin(user.address, { USDC: 10_000_000n });
      h.chain.deposits.set(user.address.toLowerCase(), 0n);
      const q = await quote(h, user.address, [order]);
      if (!q.fee) break;
      const { wire } = await operation(user, [order, ...q.fee.calls!], { gas: gasOf(q.fee) });
      const body = await send(h, wire);
      if (body.error) break;
    }
    const chargedSpent = h.paid.reduce((sum, p) => sum + p.amount, 0n);
    // Now exempt withdraws from fresh addresses, same hour, same harness.
    for (let i = 0; i < 40; i += 1) {
      const addr = freshUser();
      h.chain.setMargin(addr.address, { USDC: 100_000_000n });
      h.chain.deposits.set(addr.address.toLowerCase(), 0n);
      const { wire } = await operation(addr, [withdrawOwn()]);
      const body = await send(h, wire);
      if (body.error) break;
    }
    const total = h.paid.reduce((sum, p) => sum + p.amount, 0n);
    expect(total).toBeGreaterThan(chargedSpent); // exempt actually added something
    expect(total).toBeLessThanOrEqual(PREFUND_BUDGETS.allAddressesHour);
  });

  it("the exempt per-address DAY cap holds across many hours from one address, driven through the real routes (third review round, finding 2 — mutating this cap away left the suite green)", async () => {
    const h = await harness();
    const attacker = freshUser();
    h.chain.setMargin(attacker.address, { USDC: 100_000_000n });
    const dayCeiling = effectiveExemptPerAddressDayCap();
    // Sampled every hour (D191): the exempt backstop's refill-only-burned rule now stops
    // this attacker well before the day cap, and the ledger prunes rows older than a day,
    // so a single read at the end can find an empty window.
    let maxDay = 0n;
    for (let hour = 0; hour < 30; hour++) {
      h.time.t = NOW_MS + hour * HOUR_MS;
      h.chain.deposits.set(attacker.address.toLowerCase(), 0n);
      const { wire } = await operation(attacker, [withdrawOwn()]);
      await send(h, wire);
      const day = h.db.prefundUsage(attacker.address, h.time.t, 'exempt').addressDay;
      if (day > maxDay) maxDay = day;
    }
    // Across the rolling day the ledger actually enforces, never more than the day cap —
    // whatever the hourly cap alone would have allowed over 30 hours (which is larger).
    expect(maxDay).toBeLessThanOrEqual(dayCeiling);
    expect(maxDay).toBeGreaterThan(0n);
  });

  it('an order in the same state (free actions left, MON budget exhausted) is charged, not refused', async () => {
    const h = await harness();
    const user = freshUser();
    useFreeActions(h.db, user.address, [[1, 2]]);
    exhaustEveryPerAddressBudget(h.db, user.address);
    h.chain.setMargin(user.address, { USDC: 10_000_000n });
    h.chain.deposits.set(user.address.toLowerCase(), 0n);

    const q = await quote(h, user.address, [order]);
    expect(q).toMatchObject({ charge: 'fee', reason: 'sponsorship-budget-used' });
    const { wire } = await operation(user, [order, ...q.fee!.calls!], { gas: gasOf(q.fee!) });
    const body = await send(h, wire);
    expect(body.error).toBeUndefined();
    expect(h.forwarded).toHaveLength(1);
    // Charged, not sponsored: no free action was spent.
    expect(h.db.freeActionLedger(user.address)).toHaveLength(2);
  });

  it('an order with zero free actions and nothing to pay with gets the one refusal message, never the allowance sentence', async () => {
    const h = await harness();
    const user = freshUser();
    useFreeActions(h.db, user.address, [[1, 20]]);
    exhaustEveryPerAddressBudget(h.db, user.address);
    h.chain.setMargin(user.address, { USDC: 0n, AUSD: 0n });

    const { wire } = await operation(user, [order]);
    const body = await send(h, wire);
    expect(body.error?.message).toBe(FREE_ACTIONS_USED_MESSAGE);
    expect(body.error?.data).toMatchObject({ reason: 'FREE_ACTIONS_USED' });
    expect(h.forwarded).toHaveLength(0);
  });
});

describe('the free-action counter', () => {
  it('a free send takes one: an order counts, a cancel does not (F3)', async () => {
    const h = await harness();
    const user = freshUser();
    for (const call of [order, cancel]) {
      const { wire } = await operation(user, [call]);
      expect((await send(h, wire)).error).toBeUndefined();
    }
    const rows = h.db.freeActionLedger(user.address);
    expect(rows.map((r) => r.status)).toEqual(['used']);
    expect((await allowance(h, user.address)).freeActions).toMatchObject({ used: 1, remaining: 19 });
  });

  it('a send the bundler refused gives its free action back', async () => {
    const h = await harness({ upstream: 'error' });
    const user = freshUser();
    const { wire } = await operation(user, [order]);
    expect((await send(h, wire)).error?.message).toBe('bundler said no');
    expect(h.db.freeActionLedger(user.address).map((r) => r.status)).toEqual(['released']);
    expect((await allowance(h, user.address)).freeActions.remaining).toBe(20);
  });

  it('an estimate takes nothing', async () => {
    const h = await harness();
    const user = freshUser();
    const { wire } = await operation(user, [order], { estimate: true });
    expect((await estimate(h, wire)).error).toBeUndefined();
    expect(h.db.freeActionLedger(user.address)).toHaveLength(0);
  });

  it('twenty-one concurrent sends at zero used: exactly twenty are free, the last is charged', async () => {
    const h = await harness();
    const user = freshUser();
    h.chain.setMargin(user.address, { USDC: 10_000_000n });
    const ops = await Promise.all(Array.from({ length: 21 }, () => operation(user, [order])));
    const bodies = await Promise.all(ops.map((o) => send(h, o.wire)));
    expect(bodies.filter((b) => b.error === undefined)).toHaveLength(20);
    const refused = bodies.filter((b) => b.error !== undefined);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.error?.data).toMatchObject({ reason: 'FREE_ACTIONS_USED' });
    expect(h.db.freeActionLedger(user.address).filter((r) => r.status === 'used')).toHaveLength(20);
  });
});

describe('when free actions come back is read from the ledger, not guessed', () => {
  it('the allowance, the quote and the refusal all name the hour the ledger frees one', async () => {
    const h = await harness();
    const user = freshUser();
    // 8 used 20 hours ago and 12 used 10 hours ago: the ledger frees the first 8 when the
    // hour 20 hours ago leaves the rolling day.
    useFreeActions(h.db, user.address, [
      [20, 8],
      [10, 12],
    ]);
    const expected = windowStartOf(NOW_MS - 20 * HOUR_MS) + 24 * HOUR_MS;

    const a = await allowance(h, user.address);
    expect(a.freeActions).toEqual({
      limit: 20,
      used: 20,
      remaining: 0,
      resetsAt: expected,
      allFreeAt: windowStartOf(NOW_MS - 10 * HOUR_MS) + 24 * HOUR_MS,
    });
    expect(a.charging).toBe(true);
    // Not "a day from now", and not a rounded midnight: 12:00 UTC, when the 08:00 hour of
    // the day before leaves the window. NOW_MS is 08:20 UTC.
    expect(expected).not.toBe(NOW_MS + 24 * HOUR_MS);
    expect(new Date(expected).toISOString()).toBe('2025-09-02T12:00:00.000Z');

    expect((await quote(h, user.address, [order])).freeActions.resetsAt).toBe(expected);
    h.chain.setMargin(user.address, { USDC: 0n, AUSD: 0n });
    const { wire } = await operation(user, [order]);
    expect((await send(h, wire)).error?.data).toMatchObject({ freeActions: { resetsAt: expected } });

    // And the ledger really does free them then.
    h.time.t = expected;
    expect((await allowance(h, user.address)).freeActions).toMatchObject({ used: 12, remaining: 8 });
  });
});

describe('the fee leg is checked against the relayer’s own figure, and a mismatch refuses the whole batch', () => {
  async function chargedUser(h: Harness, balances: { USDC?: bigint; AUSD?: bigint } = { USDC: 10_000_000n }) {
    const user = freshUser();
    useFreeActions(h.db, user.address, [[5, 20]]);
    h.chain.setMargin(user.address, balances);
    return user;
  }

  it('one base unit over the computed fee: refused, nothing forwarded, nothing funded', async () => {
    const h = await harness();
    const user = await chargedUser(h);
    h.chain.deposits.set(user.address.toLowerCase(), 0n);
    const q = await quote(h, user.address, [order]);
    const { wire } = await operation(user, [order, ...feeLeg(USDC, BigInt(q.fee!.amount!) + 1n)], {
      gas: gasOf(q.fee!),
    });
    const body = await send(h, wire);
    expect(body.error?.data).toEqual({
      reason: 'FEE_LEG_MISMATCH',
      expectedFee: { token: USDC, amount: q.fee!.amount },
    });
    expect(h.forwarded).toHaveLength(0);
    expect(h.paid).toHaveLength(0);
  });

  it('one base unit under it: refused the same way', async () => {
    const h = await harness();
    const user = await chargedUser(h);
    const q = await quote(h, user.address, [order]);
    const { wire } = await operation(user, [order, ...feeLeg(USDC, BigInt(q.fee!.amount!) - 1n)], {
      gas: gasOf(q.fee!),
    });
    expect((await send(h, wire)).error?.data).toMatchObject({ reason: 'FEE_LEG_MISMATCH' });
    expect(h.forwarded).toHaveLength(0);
  });

  it('F5: inflated limits are refused outright, whatever fee they carry; nothing is funded or forwarded', async () => {
    const h = await harness();
    const user = await chargedUser(h);
    h.chain.deposits.set(user.address.toLowerCase(), 0n);
    const q = await quote(h, user.address, [order]);
    const plan = gasOf(q.fee!);
    const pricing = { baseFeePerGas: BASE_FEE, monUsdMid: BigInt(q.fee!.pricing.monUsdMid) };
    // What a compromised frontend asks the user to sign.
    const inflated = { ...plan, callGasLimit: 2_000_000n, preVerificationGas: 1_300_000n };
    const inflatedFee = operationGasFee(
      { ...inflated, maxFeePerGas: OP_MAX_FEE, maxPriorityFeePerGas: OP_TIP },
      pricing,
    )!;
    const planFee = BigInt(q.fee!.amount!);
    expect(inflatedFee).toBeGreaterThan(planFee);

    // Carrying the fee for the inflated envelope (the user would overpay), or the fee for the
    // plan (the relayer would once have funded the plan's prefund, short of the signed one,
    // and the operation failed AA21 unpaid): refused either way, before anything is spent.
    for (const fee of [inflatedFee, planFee]) {
      const signed = await operation(user, [order, ...feeLeg(USDC, fee)], { gas: inflated });
      const body = await send(h, signed.wire);
      expect(body.error?.data).toEqual({
        reason: 'GAS_ENVELOPE_REFUSED',
        envelope: {
          // Its signed prefund (about 3.4M gas at 244 gwei, 0.83 MON) is over the ceiling too.
          outside: ['callGasLimit', 'preVerificationGas', 'prefund'],
          plan: {
            callGasLimit: toHex(plan.callGasLimit),
            verificationGasLimit: toHex(plan.verificationGasLimit),
            preVerificationGas: toHex(plan.preVerificationGas),
          },
          maxFeePerGasFloor: toHex((BASE_FEE * 6n) / 5n),
          maxFeePerGasCeiling: toHex(3n * BASE_FEE),
          minPriorityFeePerGas: toHex(GWEI),
        },
      });
    }
    expect(h.forwarded).toHaveLength(0);
    expect(h.paid).toHaveLength(0);

    // Signed within the plan, the same account goes through, funded to exactly its prefund,
    // and the bundler (which refuses a short deposit, as the EntryPoint does) runs it.
    const fair = await operation(user, [order, ...q.fee!.calls!], { gas: plan });
    expect((await send(h, fair.wire)).result).toMatch(/^0x[0-9a-f]{64}$/);
    const prefund = (plan.callGasLimit + plan.verificationGasLimit + plan.preVerificationGas) * OP_MAX_FEE;
    expect(h.paid).toEqual([{ account: user.address, amount: prefund }]);
  });

  it('F5: a charged send the relayer cannot estimate itself is not priced at all', async () => {
    const h = await harness();
    const user = await chargedUser(h);
    const q = await quote(h, user.address, [order]);
    h.chain.innerFails = true;
    const { wire } = await operation(user, [order, ...q.fee!.calls!], { gas: gasOf(q.fee!) });
    expect((await send(h, wire)).error?.data).toMatchObject({ reason: 'GAS_FEE_UNPRICED' });
    expect(h.forwarded).toHaveLength(0);
  });

  it('a fee leg paying any address but the pinned one is not a fee: the charged batch is refused', async () => {
    const h = await harness();
    const user = await chargedUser(h);
    const q = await quote(h, user.address, [order]);
    const { wire } = await operation(
      user,
      [order, ...feeLeg(USDC, BigInt(q.fee!.amount!), SOMEONE)],
      { gas: gasOf(q.fee!) },
    );
    const body = await send(h, wire);
    expect(body.error).toBeDefined();
    expect(h.forwarded).toHaveLength(0);
    expect(h.paid).toHaveLength(0);
  });

  it('a transfer to the fee address with no computed fee behind it is refused, alone or riding along', async () => {
    const h = await harness();
    const user = freshUser(); // free actions left: nothing is being charged
    h.chain.setMargin(user.address, { USDC: 10_000_000n });
    const standalone = buildErc20Transfer(USDC, FEE_TO, GAS_FEE_MINIMUM);
    for (const calls of [
      [{ to: standalone.to, data: standalone.data }],
      feeLeg(USDC, GAS_FEE_MINIMUM),
      [order, ...feeLeg(USDC, GAS_FEE_MINIMUM)],
    ]) {
      const { wire } = await operation(user, calls);
      expect((await send(h, wire)).error?.data).toMatchObject({ reason: 'FEE_LEG_MISMATCH' });
    }
    expect(h.forwarded).toHaveLength(0);
    expect(h.db.freeActionLedger(user.address)).toHaveLength(0);
  });

  it('a quote someone else asks for, naming this sender, cannot invalidate the sender’s own pricing', async () => {
    const h = await harness();
    const user = await chargedUser(h);
    // The user's quote, at the touch recorded at block 107,310,277.
    const mine = await quote(h, user.address, [order]);
    // Then the book moves (the touch recorded at block 101,317,067), and anyone at all
    // asks for a quote naming the user's address. `/v1/gas/quote` is unauthenticated.
    h.chain.touch = [25_432_000_000_000_000n, 25_439_000_000_000_000n];
    const theirs = await quote(h, user.address, [order]);
    expect(theirs.fee!.pricing.monUsdMid).not.toBe(mine.fee!.pricing.monUsdMid);

    // A fee pair high enough that the two pricings give different fees, so this test can
    // tell which one the relayer checked against. The limits stay the plan's (F5 caps them).
    const pricingOf = (q: QuoteAnswer) => ({
      baseFeePerGas: BigInt(q.fee!.pricing.baseFeePerGas),
      monUsdMid: BigInt(q.fee!.pricing.monUsdMid),
    });
    const gas = gasOf(mine.fee!);
    let tip = OP_TIP;
    const feeAt = (q: QuoteAnswer) =>
      operationGasFee({ ...gas, maxFeePerGas: BASE_FEE + tip, maxPriorityFeePerGas: tip }, pricingOf(q))!;
    while (feeAt(mine) === feeAt(theirs)) tip += GWEI;
    // Still inside the 3x-base-fee ceiling a charged operation is held to.
    expect(BASE_FEE + tip).toBeLessThanOrEqual(3n * BASE_FEE);
    const fees = { maxFeePerGas: BASE_FEE + tip, tip };

    // The fee at the user's own pricing still goes through...
    const own = await operation(user, [order, ...feeLeg(USDC, feeAt(mine))], { gas, ...fees });
    expect((await send(h, own.wire)).error).toBeUndefined();
    // ...a figure at neither pricing does not.
    const neither = await operation(user, [order, ...feeLeg(USDC, feeAt(mine) + GAS_FEE_MINIMUM)], {
      gas,
      ...fees,
    });
    expect((await send(h, neither.wire)).error?.data).toMatchObject({ reason: 'FEE_LEG_MISMATCH' });
  });

  it('a fee leg with no fresh pricing for this sender is refused until the client asks again', async () => {
    const h = await harness();
    const user = await chargedUser(h);
    // Never quoted at all.
    const unquoted = await operation(user, [order, ...feeLeg(USDC, GAS_FEE_MINIMUM)]);
    expect((await send(h, unquoted.wire)).error?.data).toMatchObject({ reason: 'GAS_FEE_QUOTE_EXPIRED' });
    // Quoted, then too late.
    const q = await quote(h, user.address, [order]);
    h.time.t += FEE_PRICING_TTL_MS;
    const late = await operation(user, [order, ...q.fee!.calls!], { gas: gasOf(q.fee!) });
    expect((await send(h, late.wire)).error?.data).toMatchObject({ reason: 'GAS_FEE_QUOTE_EXPIRED' });
    expect(h.forwarded).toHaveLength(0);
  });
});

describe('AUSD pays, one for one, only when the USDC in margin cannot', () => {
  it('no USDC in margin: the fee is charged in AUSD, for the same number of base units', async () => {
    const h = await harness();
    const user = freshUser();
    useFreeActions(h.db, user.address, [[5, 20]]);
    h.chain.setMargin(user.address, { USDC: 0n, AUSD: 2_000_000n });

    const q = await quote(h, user.address, [order]);
    expect(q.fee).toMatchObject({ token: AUSD, symbol: 'AUSD', amount: GAS_FEE_MINIMUM.toString() });
    expect(q.fee!.calls).toEqual(feeLeg(AUSD, GAS_FEE_MINIMUM));

    // Paying in USDC instead is not the relayer's figure: USDC cannot cover it.
    const usdc = await operation(user, [order, ...feeLeg(USDC, GAS_FEE_MINIMUM)], { gas: gasOf(q.fee!) });
    expect((await send(h, usdc.wire)).error?.data).toMatchObject({
      reason: 'FEE_LEG_MISMATCH',
      expectedFee: { token: AUSD, amount: GAS_FEE_MINIMUM.toString() },
    });

    const ausd = await operation(user, [order, ...q.fee!.calls!], { gas: gasOf(q.fee!) });
    expect((await send(h, ausd.wire)).error).toBeUndefined();
    expect(forwardedCalls(h)).toEqual([order, ...feeLeg(AUSD, GAS_FEE_MINIMUM)]);
  });

  it('with USDC that covers it, AUSD is not accepted: the user cannot choose the cheaper-to-them token', async () => {
    const h = await harness();
    const user = freshUser();
    useFreeActions(h.db, user.address, [[5, 20]]);
    h.chain.setMargin(user.address, { USDC: 10_000_000n, AUSD: 10_000_000n });
    const q = await quote(h, user.address, [order]);
    expect(q.fee!.token).toBe(USDC);
    const ausd = await operation(user, [order, ...feeLeg(AUSD, BigInt(q.fee!.amount!))], {
      gas: gasOf(q.fee!),
    });
    expect((await send(h, ausd.wire)).error?.data).toMatchObject({ reason: 'FEE_LEG_MISMATCH' });
  });
});

describe('the price per gas the fee uses is the one the chain charged', () => {
  it('userOpGasPrice reproduces what all five recorded operations were charged', () => {
    for (const bundle of fixture.bundles) {
      const [ops] = decodeFunctionData({ abi: entryPoint08Abi, data: bundle.transaction.input })
        .args as unknown as [ReadonlyArray<{ gasFees: Hex }>];
      const gasFees = BigInt(ops[0]!.gasFees);
      const maxFee = gasFees & ((1n << 128n) - 1n);
      const tip = gasFees >> 128n;
      const price = userOpGasPrice(maxFee, tip, BigInt(bundle.baseFeePerGas));
      expect(BigInt(bundle.pimlicoReceipt.actualGasUsed) * price).toBe(
        BigInt(bundle.pimlicoReceipt.actualGasCost),
      );
    }
  });
});

describe('a relayer with nowhere to be paid charges nothing', () => {
  it('out of free actions it gives the one gas message, and never asks for a fee', async () => {
    const h = await harness({ feeRecipient: null });
    const user = freshUser();
    useFreeActions(h.db, user.address, [[5, 20]]);
    h.chain.setMargin(user.address, { USDC: 10_000_000n });
    const { wire } = await operation(user, [order]);
    const body = await send(h, wire);
    expect(body.error?.message).toBe(FREE_ACTIONS_USED_MESSAGE);
    expect(body.error?.data).toMatchObject({ reason: 'FREE_ACTIONS_USED' });
    expect((await allowance(h, user.address)).charging).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
// Owner decisions of 2026-09-24: D168, D169, and findings F1, F3, F4 (F5 is above)
// ---------------------------------------------------------------------------------------

describe('D168: RELAYER_FEE_ADDRESS receives nothing but the verified fee leg of a charging batch', () => {
  it('configured the production way, every other payment to it is refused, and the one fee leg is not', async () => {
    // Not the test override: the fee address comes from config, as RELAYER_FEE_ADDRESS does.
    const h = await harness({ configFeeAddress: FEE_TO });
    const free = freshUser(); // free actions left: nothing is being charged
    const paying = freshUser();
    useFreeActions(h.db, paying.address, [[5, 20]]);
    for (const u of [free, paying]) h.chain.setMargin(u.address, { USDC: 10_000_000n });

    const plain = buildErc20Transfer(USDC, FEE_TO, GAS_FEE_MINIMUM);
    const toRelayer: Call = { to: plain.to, data: plain.data };
    const credit: Call = { to: MARGIN, data: buildDeposit(MARGIN, FEE_TO, USDC, 1_000_000n).data };
    const refused: Array<[PrivateKeyAccount, Call[]]> = [
      [free, [toRelayer]], // standalone
      [free, [order, toRelayer]], // riding along
      [free, [order, ...feeLeg(USDC, GAS_FEE_MINIMUM)]], // a fee on a batch that is not charged
      [free, [credit]], // by another road
      [paying, [toRelayer]],
      [paying, [order, toRelayer]], // a charging batch, but not in the fee-leg shape
      [paying, [order, toRelayer, ...feeLeg(USDC, GAS_FEE_MINIMUM)]], // a second payment
      [paying, [order, ...feeLeg(USDC, GAS_FEE_MINIMUM + 1n)]], // not the computed figure
    ];
    await quote(h, paying.address, [order]); // so the paying account has a fresh pricing
    for (const [user, calls] of refused) {
      const { wire } = await operation(user, calls);
      const body = await send(h, wire);
      expect(body.error?.data, JSON.stringify(calls.map((c) => c.data.slice(0, 10)))).toMatchObject({
        reason: 'FEE_LEG_MISMATCH',
      });
    }
    expect(h.forwarded).toHaveLength(0);
    expect(h.paid).toHaveLength(0);

    const q = await quote(h, paying.address, [order]);
    const ok = await operation(paying, [order, ...q.fee!.calls!], { gas: gasOf(q.fee!) });
    expect((await send(h, ok.wire)).error).toBeUndefined();
    expect(forwardedCalls(h)).toEqual([order, ...feeLeg(USDC, GAS_FEE_MINIMUM)]);
  });
});

describe('D169: the fee address may be the hot key for testing, and says so; unset, nothing starts', () => {
  const HOT = getAddress('0x000000000000000000000000000000000000beef');
  const COLD = getAddress('0x000000000000000000000000000000000000c01d');

  it('resolveFeeRecipient: unset refuses, the hot key does not, a known contract does', () => {
    expect(() => resolveFeeRecipient({ feeAddress: undefined, harness: false })).toThrow(
      /RELAYER_FEE_ADDRESS is not set/,
    );
    expect(resolveFeeRecipient({ feeAddress: HOT, harness: false })).toBe(HOT);
    expect(() => resolveFeeRecipient({ feeAddress: MARGIN, harness: false })).toThrow(/fees would be lost/);
  });

  it('a production server (no injected chain) with RELAYER_FEE_ADDRESS unset refuses to start', async () => {
    await expect(
      buildServer({
        config: { ...config, feeAddress: undefined },
        gate: { mode: 'mainnet', runMode: 'live', realFundsAcknowledged: true },
        db: new RelayerDb(':memory:'),
        topUpExecutor: recordingTopUps(new Chain()).executor,
        bundleExecutor: null,
      }),
    ).rejects.toThrow(/RELAYER_FEE_ADDRESS is not set/);
  });

  it('a production server with RELAYER_FEE_ADDRESS equal to its own signing address starts, and warns at boot', async () => {
    process.env.LOG_LEVEL = 'warn';
    const lines: string[] = [];
    const app = await buildServer({
      config: { ...config, feeAddress: HOT },
      gate: { mode: 'mainnet', runMode: 'live', realFundsAcknowledged: true },
      db: new RelayerDb(':memory:'),
      topUpExecutor: recordingTopUps(new Chain()).executor,
      bundleExecutor: null,
      relayerAddress: async () => HOT,
      logStream: { write: (line) => lines.push(line) },
    });
    const warnings = lines.map((l) => JSON.parse(l) as { level: number; msg: string; feeAddressIsHotKey?: boolean });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ level: 40, feeAddressIsHotKey: true });
    expect(warnings[0]!.msg).toMatch(/gas fees land on the hot key/);
    expect(warnings[0]!.msg).toMatch(/D169/);
    // The address itself is not in the log line.
    expect(lines.join('')).not.toMatch(/beef/i);
    await app.close();
  });

  it('/v1/health reports feeAddressIsHotKey live, and there is no warning when they differ', async () => {
    process.env.LOG_LEVEL = 'warn';
    let own: Address = HOT;
    const lines: string[] = [];
    const chain = new Chain();
    const allowlist = new TargetAllowlist(undefined as never, 'mainnet');
    allowlist.seed([
      { address: MARGIN, kind: 'marginAccount', symbol: 'MarginAccount', trustsForwarder: true },
    ]);
    const app = await buildServer({
      config: { ...config, feeAddress: COLD },
      gate: { mode: 'mainnet', runMode: 'live', realFundsAcknowledged: true },
      client: chain.client(),
      allowlist,
      db: new RelayerDb(':memory:'),
      topUpExecutor: recordingTopUps(chain).executor,
      bundleExecutor: null,
      relayerAddress: async () => own,
      logStream: { write: (line) => lines.push(line) },
    });
    expect(lines).toHaveLength(0);
    const health = async () =>
      (JSON.parse((await app.inject({ method: 'GET', url: '/v1/health' })).body) as {
        feeAddressIsHotKey: boolean;
      }).feeAddressIsHotKey;
    expect(await health()).toBe(false);
    own = COLD; // the key changes, or the fee address is set to it
    expect(await health()).toBe(true);
    own = HOT;
    expect(await health()).toBe(false);
    await app.close();
  });
});

describe('F1: a fee-paid top-up is the operation’s own prefund, not a fixed 0.30 MON', () => {
  it('an empty deposit is brought to exactly what this operation must hold, and no higher', async () => {
    const h = await harness();
    const user = freshUser();
    useFreeActions(h.db, user.address, [[5, 20]]);
    h.chain.setMargin(user.address, { USDC: 10_000_000n });
    h.chain.deposits.set(user.address.toLowerCase(), 0n);
    const q = await quote(h, user.address, [order]);
    const gas = gasOf(q.fee!);
    const prefund = (gas.callGasLimit + gas.verificationGasLimit + gas.preVerificationGas) * OP_MAX_FEE;

    const { wire } = await operation(user, [order, ...q.fee!.calls!], { gas });
    expect((await send(h, wire)).error).toBeUndefined();

    expect(h.paid).toEqual([{ account: user.address, amount: prefund }]);
    // What sits in the deposit for the user to withdraw is this operation's own maximum
    // gas cost, which its fee is charged on, not 0.30 MON on top of whatever was there.
    expect(h.chain.deposits.get(user.address.toLowerCase())).toBe(prefund);
    expect(prefund).toBeLessThan(ENTRYPOINT_TOPUP_WEI);
    // Against the recorded real cost of an order (0x1111dda6…, 0.04854772 MON drawn), what
    // is left afterwards is the prefund less that, no longer the fixed top-up less it.
    const realCost = BigInt(fixture.bundles[1]!.pimlicoReceipt.actualGasCost);
    expect(prefund - realCost).toBeLessThan(ENTRYPOINT_TOPUP_WEI - realCost);
  });

  it('a deposit part-way there gets only the shortfall', async () => {
    const h = await harness();
    const user = freshUser();
    useFreeActions(h.db, user.address, [[5, 20]]);
    h.chain.setMargin(user.address, { USDC: 10_000_000n });
    h.chain.deposits.set(user.address.toLowerCase(), MON / 20n); // 0.05 MON
    const q = await quote(h, user.address, [order]);
    const gas = gasOf(q.fee!);
    const prefund = (gas.callGasLimit + gas.verificationGasLimit + gas.preVerificationGas) * OP_MAX_FEE;
    const { wire } = await operation(user, [order, ...q.fee!.calls!], { gas });
    expect((await send(h, wire)).error).toBeUndefined();
    expect(h.paid).toEqual([{ account: user.address, amount: prefund - MON / 20n }]);
    expect(h.chain.deposits.get(user.address.toLowerCase())).toBe(prefund);
  });

  it('an operation whose prefund is under the sponsored 0.15 MON minimum is funded to its prefund, not the minimum', async () => {
    const h = await harness();
    const user = freshUser();
    useFreeActions(h.db, user.address, [[5, 20]]);
    h.chain.setMargin(user.address, { USDC: 10_000_000n });
    h.chain.deposits.set(user.address.toLowerCase(), 0n);
    // Signed at the fee floor, 1.2x the base fee, rather than the browser's 2.44x: a prefund
    // around 0.12 MON, under the sponsored path's 0.15 MON minimum.
    const maxFeePerGas = (BASE_FEE * 6n) / 5n;
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/gas/quote',
      payload: {
        sender: user.address,
        calls: [order],
        maxFeePerGas: toHex(maxFeePerGas),
        maxPriorityFeePerGas: toHex(OP_TIP),
      },
    });
    const q = JSON.parse(res.body) as QuoteAnswer;
    const gas = gasOf(q.fee!);
    const prefund = (gas.callGasLimit + gas.verificationGasLimit + gas.preVerificationGas) * maxFeePerGas;
    expect(prefund).toBeLessThan(150_000_000_000_000_000n);
    const { wire } = await operation(user, [order, ...q.fee!.calls!], { gas, maxFeePerGas, tip: OP_TIP });
    expect((await send(h, wire)).error).toBeUndefined();
    expect(h.paid).toEqual([{ account: user.address, amount: prefund }]);
  });

  it('a free action is still topped up the sponsored way, a fixed 0.30 MON', async () => {
    const h = await harness();
    const user = freshUser();
    h.chain.deposits.set(user.address.toLowerCase(), 0n);
    const { wire } = await operation(user, [order]);
    expect((await send(h, wire)).error).toBeUndefined();
    expect(h.paid).toEqual([{ account: user.address, amount: ENTRYPOINT_TOPUP_WEI }]);
  });
});

describe('F4: free actions left but the account’s own budget spent: charged, not refused', () => {
  /** This account's hourly sponsorship budget, spent in the current window. */
  function spendHour(db: RelayerDb, user: Address) {
    const r = db.reservePrefund({
      address: user,
      amountWei: PREFUND_BUDGETS.perAddressHour,
      purpose: 'deposit',
      budgets: PREFUND_BUDGETS,
      now: NOW_MS,
    });
    if (!r.ok) throw new Error('fixture could not reserve');
    db.settlePrefund(r.id, 'paid', { now: NOW_MS });
  }

  it('the send without a fee is told to carry one; with the quoted fee it goes, and takes no free action', async () => {
    const h = await harness();
    const user = freshUser();
    useFreeActions(h.db, user.address, [[5, 5]]);
    spendHour(h.db, user.address);
    h.chain.setMargin(user.address, { USDC: 10_000_000n });
    h.chain.deposits.set(user.address.toLowerCase(), 0n);

    const bare = await operation(user, [order]);
    const refusal = await send(h, bare.wire);
    expect(refusal.error?.message).toBe(SPONSORSHIP_PAUSED_MESSAGE);
    expect(refusal.error?.data).toMatchObject({ reason: 'FREE_ACTIONS_USED' });
    expect(h.forwarded).toHaveLength(0);

    const q = await quote(h, user.address, [order]);
    expect(q).toMatchObject({
      charge: 'fee',
      reason: 'sponsorship-budget-used',
      sponsorshipResetsAt: windowStartOf(NOW_MS) + HOUR_MS,
    });
    const { wire } = await operation(user, [order, ...q.fee!.calls!], { gas: gasOf(q.fee!) });
    expect((await send(h, wire)).error).toBeUndefined();
    expect(h.forwarded).toHaveLength(1);
    // Funded from the shared budget alone, as a paid operation, and no free action taken.
    expect(h.paid).toHaveLength(1);
    expect(h.db.prefundLedger(user.address)[0]?.purpose).toMatch(/^fee-paid:/);
    expect(h.db.freeActionLedger(user.address)).toHaveLength(5);
  });

  it('with nothing to pay with, the refusal is the one gas message — not the budget’s own words (the wrong-refusal bug this rebuild fixes)', async () => {
    const h = await harness();
    const user = freshUser();
    useFreeActions(h.db, user.address, [[5, 5]]);
    spendHour(h.db, user.address);
    h.chain.setMargin(user.address, { USDC: 0n, AUSD: 0n });
    h.chain.deposits.set(user.address.toLowerCase(), 0n);
    const { wire } = await operation(user, [order]);
    const body = await send(h, wire);
    expect(body.error?.message).toBe(SPONSORSHIP_PAUSED_MESSAGE);
    expect(body.error?.data).toMatchObject({ reason: 'FREE_ACTIONS_USED' });
    expect(await quote(h, user.address, [order])).toMatchObject({
      charge: 'refused',
      message: SPONSORSHIP_PAUSED_MESSAGE,
    });
  });

  it('a deposit that already covers the operation needs no top-up, so nothing is charged', async () => {
    const h = await harness();
    const user = freshUser();
    spendHour(h.db, user.address);
    h.chain.setMargin(user.address, { USDC: 10_000_000n });
    h.chain.deposits.set(user.address.toLowerCase(), MON); // 1 MON on deposit
    const { wire } = await operation(user, [order]);
    expect((await send(h, wire)).error).toBeUndefined();
    expect(h.paid).toHaveLength(0);
    expect(h.db.freeActionLedger(user.address)).toHaveLength(1);
  });

  it('when the budget every account shares is spent too, charging would not fund it: the ordinary refusal', async () => {
    const h = await harness();
    const user = freshUser();
    // The account's own hour spent, and nine others', so the shared hour is spent as well.
    spendHour(h.db, user.address);
    for (let i = 0; i < 9; i++) {
      spendHour(h.db, getAddress(`0x${(0xa000 + i).toString(16).padStart(40, '0')}`));
    }
    h.chain.setMargin(user.address, { USDC: 10_000_000n });
    h.chain.deposits.set(user.address.toLowerCase(), 0n);
    const { wire } = await operation(user, [order]);
    const body = await send(h, wire);
    // B2c: one sentence with its live choices, whatever bound internally. Finding 3's
    // true-blocker naming (scope 'shared', not the account's own hour) survives in the
    // ledger refusal `convertBudgetRefusal` consumes, in the operator log line, and in
    // the data's `resetsAt` — the sooner, true blocker's own reset.
    expect(body.error?.message).toBe(SPONSORSHIP_PAUSED_MESSAGE);
    expect(body.error?.data).toEqual({
      reason: 'FREE_ACTIONS_USED',
      choices: ['swap-into-mon', 'add-money'],
      resetsAt: windowStartOf(NOW_MS) + HOUR_MS,
    });
    expect(h.forwarded).toHaveLength(0);
  });

  it("finding 3's own example: the account's day is spent (resets ~20h out) but the shared hour is also spent (resets within the hour) — the sooner, true blocker is named, not the day", async () => {
    const h = await harness();
    const user = freshUser();
    useFreeActions(h.db, user.address, [[1, 2]]); // 18 of 20 free actions left
    // The account's own rolling day, fully spent, in windows outside the current hour —
    // so ADDRESS_DAY is exhausted but ADDRESS_HOUR, this account's, is not.
    for (const hoursAgo of [4, 3, 2, 1]) {
      const at = NOW_MS - hoursAgo * HOUR_MS;
      const r = h.db.reservePrefund({
        address: user.address,
        amountWei: PREFUND_BUDGETS.perAddressDay / 4n,
        purpose: 'deposit',
        budgets: PREFUND_BUDGETS,
        now: at,
      });
      if (!r.ok) throw new Error('fixture could not reserve the day');
      h.db.settlePrefund(r.id, 'paid', { now: at });
    }
    // Ten other addresses spend the shared hour in the current window.
    for (let i = 0; i < 10; i++) {
      spendHour(h.db, getAddress(`0x${(0xb000 + i).toString(16).padStart(40, '0')}`));
    }
    h.chain.setMargin(user.address, { USDC: 10_000_000n });
    h.chain.deposits.set(user.address.toLowerCase(), 0n);

    const q = await quote(h, user.address, [order]);
    // Owner item 2 (D191): the quote no longer says 'sponsored' for an operation the
    // spent shared hour will refuse; it falls through, and with no own MON and no fee
    // lane (the fee lane draws the same hour) it refuses in the budget's own sentence.
    expect(q).toMatchObject({ charge: 'refused', message: SPONSORSHIP_PAUSED_MESSAGE });
    const { wire } = await operation(user, [order]);
    const body = await send(h, wire);
    // B2c collapsed finding 3's whole class: no scope in the words, no chance of
    // naming the wrong one — the same sentence and the same live choices either way.
    // The data's `resetsAt` is THIS account's true earliest sponsored moment: its own
    // day (spent, frees ~20h out) binds it even after the shared hour resets, so the
    // shared hour's sooner tick would be a false promise for this account.
    expect(body.error?.message).toBe(SPONSORSHIP_PAUSED_MESSAGE);
    expect(body.error?.data).toEqual({
      reason: 'FREE_ACTIONS_USED',
      choices: ['swap-into-mon', 'add-money'],
      // The rolling day is window-quantized: it frees when its oldest hour window
      // (the 4-hours-ago fixture entry) ages out of the 24-hour ring.
      resetsAt: windowStartOf(NOW_MS - 4 * HOUR_MS) + 24 * HOUR_MS,
    });
  });
});

describe('F3: cancelling is never counted and never charged', () => {
  it('no free actions and nothing in margin: a cancel still goes, and the counter does not move', async () => {
    const h = await harness();
    const user = freshUser();
    useFreeActions(h.db, user.address, [[5, 20]]);
    h.chain.setMargin(user.address, { USDC: 0n, AUSD: 0n });
    expect(await quote(h, user.address, [cancel])).toMatchObject({ charge: 'sponsored', reason: 'cancel' });
    for (const calls of [[cancel], [cancel, withdrawOwn()], [cancel, cancel]]) {
      const { wire } = await operation(user, calls);
      expect((await send(h, wire)).error).toBeUndefined();
    }
    expect(h.forwarded).toHaveLength(3);
    expect(h.db.freeActionLedger(user.address)).toHaveLength(20);
  });

  it('a cancel riding with an order is an order: counted, and charged once free actions are used', async () => {
    const h = await harness();
    const user = freshUser();
    useFreeActions(h.db, user.address, [[5, 20]]);
    h.chain.setMargin(user.address, { USDC: 0n, AUSD: 0n });
    const { wire } = await operation(user, [cancel, order]);
    expect((await send(h, wire)).error?.message).toBe(FREE_ACTIONS_USED_MESSAGE);
  });

  it('a cancel carrying an unquoted fee leg rides the charged lane, fails its quote check, and stays uncounted', async () => {
    const h = await harness();
    const user = freshUser();
    useFreeActions(h.db, user.address, [[5, 20]]);
    h.chain.setMargin(user.address, { USDC: 10_000_000n });
    // B2d: a fee leg beside an exempt action is no longer a policy mismatch — it is the
    // charged lane, so it must clear the same fee-quote check every charged send does.
    const { wire } = await operation(user, [cancel, ...feeLeg(USDC, GAS_FEE_MINIMUM)]);
    expect((await send(h, wire)).error?.data).toMatchObject({ reason: 'GAS_FEE_QUOTE_EXPIRED' });
    expect(h.forwarded).toHaveLength(0);
    expect(h.db.freeActionLedger(user.address)).toHaveLength(20);
  });
});

// ---------------------------------------------------------------------------------------
// Independent review of 2026-09-24: findings 1 to 5
// ---------------------------------------------------------------------------------------

describe('review 1: a charged operation signed for more than the relayer will fund is refused, never funded short', () => {
  async function paying(h: Harness) {
    const user = freshUser();
    useFreeActions(h.db, user.address, [[5, 20]]);
    h.chain.setMargin(user.address, { USDC: 10_000_000n });
    h.chain.deposits.set(user.address.toLowerCase(), 0n);
    return user;
  }

  it('a max fee above 3x the freshly read base fee', async () => {
    const h = await harness();
    const user = await paying(h);
    const q = await quote(h, user.address, [order]);
    const maxFeePerGas = 3n * BASE_FEE + 1n;
    const fee = operationGasFee(
      { ...gasOf(q.fee!), maxFeePerGas, maxPriorityFeePerGas: OP_TIP },
      { baseFeePerGas: BASE_FEE, monUsdMid: BigInt(q.fee!.pricing.monUsdMid) },
    )!;
    const { wire } = await operation(user, [order, ...feeLeg(USDC, fee)], { gas: gasOf(q.fee!), maxFeePerGas });
    const body = await send(h, wire);
    expect(body.error?.data).toMatchObject({
      reason: 'GAS_ENVELOPE_REFUSED',
      envelope: { outside: ['maxFeePerGas'], maxFeePerGasCeiling: toHex(3n * BASE_FEE) },
    });
    // Exactly at the ceiling is allowed.
    const atCeiling = operationGasFee(
      { ...gasOf(q.fee!), maxFeePerGas: 3n * BASE_FEE, maxPriorityFeePerGas: OP_TIP },
      { baseFeePerGas: BASE_FEE, monUsdMid: BigInt(q.fee!.pricing.monUsdMid) },
    )!;
    const ok = await operation(user, [order, ...feeLeg(USDC, atCeiling)], {
      gas: gasOf(q.fee!),
      maxFeePerGas: 3n * BASE_FEE,
    });
    expect((await send(h, ok.wire)).error).toBeUndefined();
    expect(h.paid).toHaveLength(1);
  });

  it('a signed prefund above 0.45 MON, even with limits inside the plan and the max fee inside 3x', async () => {
    const h = await harness();
    h.chain.innerEstimate = 1_400_000n; // a large batch: the plan itself is big
    const user = await paying(h);
    const q = await quote(h, user.address, [order]);
    const gas = gasOf(q.fee!);
    const prefund = (gas.callGasLimit + gas.verificationGasLimit + gas.preVerificationGas) * OP_MAX_FEE;
    expect(prefund).toBeGreaterThan(450_000_000_000_000_000n);
    const { wire } = await operation(user, [order, ...q.fee!.calls!], { gas });
    const body = await send(h, wire);
    expect(body.error?.data).toMatchObject({ reason: 'GAS_ENVELOPE_REFUSED', envelope: { outside: ['prefund'] } });
    expect(h.paid).toHaveLength(0);
    expect(h.forwarded).toHaveLength(0);
  });

  it('what passes is funded to exactly its signed prefund, runs, and the same signed operation cannot ask again', async () => {
    const h = await harness();
    const user = await paying(h);
    const q = await quote(h, user.address, [order]);
    const gas = gasOf(q.fee!);
    const { wire } = await operation(user, [order, ...q.fee!.calls!], { gas });
    expect((await send(h, wire)).result).toMatch(/^0x[0-9a-f]{64}$/);
    const prefund = (gas.callGasLimit + gas.verificationGasLimit + gas.preVerificationGas) * OP_MAX_FEE;
    expect(h.paid).toEqual([{ account: user.address, amount: prefund }]);
    // The attacker empties the deposit and replays: the nonce is used, nothing is paid.
    h.chain.deposits.set(user.address.toLowerCase(), 0n);
    expect((await send(h, wire)).error?.message).toBe('the operation does not carry this account’s next nonce');
    expect(h.paid).toHaveLength(1);
  });

  it('the #fund fail-safe: a free action signed at an absurd max fee gets no top-up it cannot run on', async () => {
    const h = await harness();
    const user = freshUser(); // free actions left: the sponsored path, which is not checked above
    h.chain.deposits.set(user.address.toLowerCase(), 0n);
    const { wire } = await operation(user, [order], { maxFeePerGas: 2_000n * GWEI });
    const body = await send(h, wire);
    expect(body.error?.message).toBe(UNFUNDABLE_MESSAGE);
    expect(h.paid).toHaveLength(0);
    // And its free action is given back: nothing reached a bundler.
    expect(h.db.freeActionLedger(user.address).map((r) => r.status)).toEqual(['released']);
  });

  it('feePaidDepositNeeded: exactly the signed prefund, and nothing at all above 0.45 MON or with none known', () => {
    expect(feePaidDepositNeeded(234_195_592_000_000_000n)).toBe(234_195_592_000_000_000n);
    expect(feePaidDepositNeeded(FEE_PAID_MAX_PREFUND_WEI)).toBe(FEE_PAID_MAX_PREFUND_WEI);
    expect(feePaidDepositNeeded(FEE_PAID_MAX_PREFUND_WEI + 1n)).toBeUndefined();
    expect(feePaidDepositNeeded(undefined)).toBeUndefined();
    expect(FEE_PAID_MAX_PREFUND_WEI).toBe(450_000_000_000_000_000n);
  });

  it('the #fund fail-safe, directly: a fee-paid prefund over the ceiling is never funded, whatever the caller passed', async () => {
    const h = await harness();
    const user = freshUser();
    h.chain.deposits.set(user.address.toLowerCase(), 0n);
    const gate = new PrefundGate({
      db: h.db,
      client: h.chain.client(),
      executor: recordingTopUps(h.chain).executor,
      budgets: PREFUND_BUDGETS,
      now: () => NOW_MS,
      log: { info: () => {}, warn: () => {} },
    });
    const outcome = await gate.ensure(user.address, {
      prove: async () => true,
      purpose: 'other',
      budgetScope: 'fee-paid',
      requiredPrefund: 450_000_000_000_000_001n,
    });
    expect(outcome).toEqual({ kind: 'refused', refusal: { message: UNFUNDABLE_MESSAGE } });
  });
});

describe('review 1, second round: signed exactly as quoted, inside the fee band, and shown to run before it is funded', () => {
  async function paying(h: Harness) {
    const user = freshUser();
    useFreeActions(h.db, user.address, [[5, 20]]);
    h.chain.setMargin(user.address, { USDC: 10_000_000n });
    h.chain.deposits.set(user.address.toLowerCase(), 0n);
    return user;
  }
  const feeFor = (q: QuoteAnswer, gas: ReturnType<typeof gasOf>, maxFeePerGas = OP_MAX_FEE, tip = OP_TIP) =>
    operationGasFee(
      { ...gas, maxFeePerGas, maxPriorityFeePerGas: tip },
      { baseFeePerGas: BASE_FEE, monUsdMid: BigInt(q.fee!.pricing.monUsdMid) },
    )!;

  it('any limit BELOW the plan is refused too: a starved validation (5,000 of the 7,314 it uses), a short preVerificationGas, a short call', async () => {
    const h = await harness();
    const user = await paying(h);
    const q = await quote(h, user.address, [order]);
    const plan = gasOf(q.fee!);
    expect(plan.verificationGasLimit).toBeGreaterThan(VALIDATION_GAS_USED);
    const cases: Array<[ReturnType<typeof gasOf>, string]> = [
      [{ ...plan, verificationGasLimit: 5_000n }, 'verificationGasLimit'],
      [{ ...plan, preVerificationGas: plan.preVerificationGas - 1n }, 'preVerificationGas'],
      [{ ...plan, callGasLimit: plan.callGasLimit - 1n }, 'callGasLimit'],
    ];
    for (const [gas, field] of cases) {
      const { wire } = await operation(user, [order, ...feeLeg(USDC, feeFor(q, gas))], { gas });
      expect((await send(h, wire)).error?.data).toMatchObject({
        reason: 'GAS_ENVELOPE_REFUSED',
        envelope: { outside: [field] },
      });
    }
    expect(h.paid).toHaveLength(0);
    expect(h.chain.simulations).toHaveLength(0);
    expect(h.forwarded).toHaveLength(0);
  });

  it('a max fee under 1.2x the base fee, a tip under 1 gwei, or a tip above the max fee is refused', async () => {
    const h = await harness();
    const user = await paying(h);
    const q = await quote(h, user.address, [order]);
    const gas = gasOf(q.fee!);
    const cases: Array<[bigint, bigint, string]> = [
      [(BASE_FEE * 6n) / 5n - 1n, OP_TIP, 'maxFeePerGas'],
      [OP_MAX_FEE, GWEI - 1n, 'maxPriorityFeePerGas'],
      [OP_MAX_FEE, OP_MAX_FEE + 1n, 'maxPriorityFeePerGas'],
    ];
    for (const [maxFeePerGas, tip, field] of cases) {
      const { wire } = await operation(user, [order, ...feeLeg(USDC, feeFor(q, gas, maxFeePerGas, tip))], {
        gas,
        maxFeePerGas,
        tip,
      });
      expect((await send(h, wire)).error?.data).toMatchObject({
        reason: 'GAS_ENVELOPE_REFUSED',
        envelope: { outside: expect.arrayContaining([field]) },
      });
    }
    expect(h.paid).toHaveLength(0);
    // The band's edges are allowed.
    const floor = (BASE_FEE * 6n) / 5n;
    const { wire } = await operation(user, [order, ...feeLeg(USDC, feeFor(q, gas, floor, GWEI))], {
      gas,
      maxFeePerGas: floor,
      tip: GWEI,
    });
    expect((await send(h, wire)).error).toBeUndefined();
  });

  it('a top-up is paid only after deposit-then-handleOps is simulated and the operation runs, with the exact amount', async () => {
    const h = await harness();
    const user = await paying(h);
    const q = await quote(h, user.address, [order]);
    const { wire } = await operation(user, [order, ...q.fee!.calls!], { gas: gasOf(q.fee!) });
    expect((await send(h, wire)).error).toBeUndefined();
    expect(h.chain.simulations).toEqual([{ topUp: h.paid[0]!.amount, outcome: 'ran' }]);
  });

  it('when the simulation says the funded operation would fail, nothing is paid, reserved or forwarded', async () => {
    const h = await harness();
    const user = await paying(h);
    const q = await quote(h, user.address, [order]);
    // Something no bound above names: the chain simply says no.
    h.chain.simulateFailure = 'AA24 signature error';
    const { wire } = await operation(user, [order, ...q.fee!.calls!], { gas: gasOf(q.fee!) });
    const body = await send(h, wire);
    expect(body.error?.code).toBe(-32521);
    expect(body.error?.message).toBe(
      'This would fail on chain, so nothing was sent. The chain answered: FailedOp: AA24 signature error',
    );
    expect(h.paid).toHaveLength(0);
    expect(h.db.prefundLedger(user.address)).toHaveLength(0);
    expect(h.forwarded).toHaveLength(0);
  });

  it('when the funded operation would validate but its own call would revert (so no fee is paid), nothing is funded', async () => {
    const h = await harness();
    const user = await paying(h);
    const q = await quote(h, user.address, [order]);
    // Kuru's InsufficientBalance, as the recorded batch revert carries it (`selfBundle.test.ts`).
    h.chain.simulateInnerRevert = '0xf4d678b8';
    const { wire } = await operation(user, [order, ...q.fee!.calls!], { gas: gasOf(q.fee!) });
    const body = await send(h, wire);
    expect(body.error?.code).toBe(-32521);
    expect(body.error?.message).toMatch(/^This would fail on chain, so nothing was sent\. The chain answered: /);
    expect(body.error?.message).toContain('0xf4d678b8');
    expect(h.chain.simulations).toEqual([{ topUp: expect.any(BigInt), outcome: 'call reverted' }]);
    expect(h.paid).toHaveLength(0);
    expect(h.forwarded).toHaveLength(0);
  });

  it('when the simulation cannot be read, nothing is paid either', async () => {
    const h = await harness();
    const user = await paying(h);
    const q = await quote(h, user.address, [order]);
    const { wire } = await operation(user, [order, ...q.fee!.calls!], { gas: gasOf(q.fee!) });
    h.chain.simulate = () => ({ error: { code: -32603, message: 'internal error' } });
    const body = await send(h, wire);
    expect(body.error?.message).toBe(UNFUNDABLE_MESSAGE);
    expect(h.paid).toHaveLength(0);
  });

  it('a deposit that already covers the operation needs no top-up, and so no simulation', async () => {
    const h = await harness();
    const user = await paying(h);
    h.chain.deposits.set(user.address.toLowerCase(), MON);
    const q = await quote(h, user.address, [order]);
    const { wire } = await operation(user, [order, ...q.fee!.calls!], { gas: gasOf(q.fee!) });
    expect((await send(h, wire)).error).toBeUndefined();
    expect(h.paid).toHaveLength(0);
    expect(h.chain.simulations).toHaveLength(0);
  });

  it('a quote without the fee pair is refused: it could not say whether the send would be charged', async () => {
    const h = await harness();
    const user = freshUser();
    for (const payload of [
      { sender: user.address, calls: [order] },
      { sender: user.address, calls: [order], maxFeePerGas: toHex(OP_MAX_FEE) },
    ]) {
      const res = await h.app.inject({ method: 'POST', url: '/v1/gas/quote', payload });
      expect(res.statusCode).toBe(400);
    }
  });
});

describe('review 4: the durable backstop: one fee-paid top-up per address until its operation is seen to land', () => {
  async function paying(h: Harness) {
    const user = freshUser();
    useFreeActions(h.db, user.address, [[5, 20]]);
    h.chain.setMargin(user.address, { USDC: 10_000_000n });
    h.chain.deposits.set(user.address.toLowerCase(), 0n);
    return user;
  }
  async function paidOp(h: Harness, user: PrivateKeyAccount) {
    const q = await quote(h, user.address, [order]);
    return operation(user, [order, ...q.fee!.calls!], { gas: gasOf(q.fee!) });
  }

  it('a second top-up is refused while the first operation is pending, and paid once it lands', async () => {
    const h = await harness();
    const user = await paying(h);
    h.chain.holdBundles = true; // taken by the bundler, not yet mined
    const first = await paidOp(h, user);
    expect((await send(h, first.wire)).error).toBeUndefined();
    expect(h.paid).toHaveLength(1);
    expect(h.db.feePaidTopUps(user.address)).toMatchObject([{ status: 'outstanding' }]);

    // The deposit is emptied (withdrawTo), and a second paid operation asks for a top-up.
    h.chain.deposits.set(user.address.toLowerCase(), 0n);
    const second = await paidOp(h, user);
    const refused = await send(h, second.wire);
    expect(refused.error?.message).toBe(PRIOR_FEE_PENDING_MESSAGE);
    expect(refused.error?.data).toEqual({ reason: 'PRIOR_FEE_UNCONFIRMED' });
    expect(h.paid).toHaveLength(1);

    // The honest version of the same account: nothing withdrawn after all. The first
    // operation lands, burning the recorded gas of a real order at the EntryPoint's price.
    h.chain.holdBundles = false;
    h.chain.deposits.set(user.address.toLowerCase(), h.paid[0]!.amount);
    const burn = BigInt(fixture.bundles[0]!.pimlicoReceipt.actualGasUsed) * (BASE_FEE + OP_TIP);
    h.chain.chargeOnExecute = burn;
    h.chain.mineHeld();
    // Paid once it has landed, and (D172, the refill rule) exactly what it burned.
    expect((await send(h, second.wire)).error).toBeUndefined();
    expect(h.paid).toHaveLength(2);
    expect(h.paid[1]!.amount).toBe(burn);
    expect(h.db.feePaidTopUps(user.address)).toMatchObject([
      { status: 'outstanding' },
      { status: 'confirmed', success: true },
    ]);
  });

  it('a first operation that never lands inside its window holds the address for good, and says so', async () => {
    const h = await harness();
    const user = await paying(h);
    h.chain.holdBundles = true;
    const first = await paidOp(h, user);
    expect((await send(h, first.wire)).error).toBeUndefined();
    h.chain.deposits.set(user.address.toLowerCase(), 0n);
    h.chain.blockNumber += 150n; // past the 100-block window, never mined
    const second = await paidOp(h, user);
    const refused = await send(h, second.wire);
    expect(refused.error?.message).toBe(PRIOR_FEE_NEVER_LANDED_MESSAGE);
    expect(h.paid).toHaveLength(1);
  });

  it('an operation whose deposit already covers it needs no top-up, so the backstop never holds it', async () => {
    const h = await harness();
    const user = await paying(h);
    h.chain.holdBundles = true;
    const first = await paidOp(h, user);
    expect((await send(h, first.wire)).error).toBeUndefined();
    // Honest: the unconfirmed top-up is still in the deposit, and it covers the next one.
    const second = await paidOp(h, user);
    expect((await send(h, second.wire)).error).toBeUndefined();
    expect(h.paid).toHaveLength(1);
  });

  it('the free path is not held by it: a sponsored top-up is bounded by the per-address budgets instead', async () => {
    const h = await harness();
    const user = freshUser();
    h.chain.deposits.set(user.address.toLowerCase(), 0n);
    h.db.openFeePaidTopUp({ address: user.address, userOpHash: `0x${'77'.repeat(32)}`, fromBlock: h.chain.blockNumber, now: NOW_MS });
    const { wire } = await operation(user, [order]);
    expect((await send(h, wire)).error).toBeUndefined();
    expect(h.paid).toEqual([{ account: user.address, amount: ENTRYPOINT_TOPUP_WEI }]);
  });

  it('a top-up that never went out releases the address; one that could not be read is not paid', async () => {
    const h = await harness();
    const user = freshUser();
    h.chain.deposits.set(user.address.toLowerCase(), 0n);
    const gateWith = (executor: TopUpExecutor, watch: FeePaidWatch) =>
      new PrefundGate({
        db: h.db,
        client: h.chain.client(),
        executor,
        budgets: PREFUND_BUDGETS,
        now: () => NOW_MS,
        log: { info: () => {}, warn: () => {} },
        feePaidWatch: watch,
      });
    const request = {
      prove: async () => true,
      purpose: 'other',
      budgetScope: 'fee-paid' as const,
      requiredPrefund: 200_000_000_000_000_000n,
      feePaidOp: { userOpHash: `0x${'aa'.repeat(32)}` as Hex },
    };
    const watch: FeePaidWatch = {
      latestBlock: async () => 1_000n,
      findEvent: async () => ({ status: 'pending' }),
    };
    const failing: TopUpExecutor = {
      relayerAddress: () => HOT_KEY,
      depositTo: async () => {
        throw new Error('nonce too low');
      },
      waitForReceipt: async () => 'success',
    };
    const outcome = await gateWith(failing, watch).ensure(user.address, request);
    expect(outcome.kind).toBe('refused');
    expect(h.db.feePaidTopUps(user.address)).toMatchObject([{ status: 'released' }]);

    // No latest block: nothing is recorded, so nothing is paid.
    const blind: FeePaidWatch = { latestBlock: async () => undefined, findEvent: async () => ({ status: 'unavailable' }) };
    const { executor, paid } = recordingTopUps(h.chain);
    expect((await gateWith(executor, blind).ensure(user.address, request)).kind).toBe('refused');
    expect(paid).toHaveLength(0);
  });
});

describe('review 4: the backstop’s own parts', () => {
  const HASH_A = `0x${'a1'.repeat(32)}` as Hex;
  const HASH_B = `0x${'b2'.repeat(32)}` as Hex;
  const SENDER = getAddress('0x00000000000000000000000000000000000a11ce');

  it('the ledger holds one outstanding row per address even if asked twice (no in-process lock needed)', () => {
    const db = new RelayerDb(':memory:');
    const first = db.openFeePaidTopUp({ address: SENDER, userOpHash: HASH_A, fromBlock: 10n, now: NOW_MS });
    expect(first).toBeTypeOf('number');
    expect(db.openFeePaidTopUp({ address: SENDER, userOpHash: HASH_B, fromBlock: 11n, now: NOW_MS })).toBeUndefined();
    db.settleFeePaidTopUp(first!, 'confirmed', { success: true, now: NOW_MS });
    expect(db.openFeePaidTopUp({ address: SENDER, userOpHash: HASH_B, fromBlock: 11n, now: NOW_MS })).toBeTypeOf('number');
  });

  function watchOver(chain: FakeEntryPoint, options: { ignoreTopicFilter?: boolean } = {}) {
    const client = {
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        if (method === 'eth_blockNumber') return toHex(chain.blockNumber);
        if (method === 'eth_getLogs') {
          const [filter] = params as [{ topics: Hex[] }];
          const topics = options.ignoreTopicFilter ? [filter.topics[0]!] : filter.topics;
          return chain.logs([{ ...filter, topics }]).result;
        }
        throw new Error(`unexpected ${method}`);
      },
    } as unknown as PublicClient;
    return liveFeePaidWatch(client);
  }

  it('a node that returns some other operation’s event is not taken as this one landing', async () => {
    const chain = new FakeEntryPoint();
    const from = chain.blockNumber;
    chain.blockNumber += 1n;
    chain.events.push({ block: chain.blockNumber, userOpHash: HASH_B, sender: SENDER, nonce: 0n, success: true });
    expect(await watchOver(chain, { ignoreTopicFilter: true }).findEvent(HASH_A, from)).toEqual({ status: 'pending' });
    expect(await watchOver(chain).findEvent(HASH_B, from)).toMatchObject({ status: 'landed', success: true });
  });

  it('reads success, the gas burned and where it landed from the event, a reverted batch included', async () => {
    const chain = new FakeEntryPoint();
    const from = chain.blockNumber;
    chain.blockNumber += 1n;
    // The recorded actualGasCost of a real mainnet order (fixture, block 0x668bcce).
    const actualGasCost = BigInt(fixture.bundles[2]!.pimlicoReceipt.actualGasCost);
    chain.events.push({ block: chain.blockNumber, userOpHash: HASH_A, sender: SENDER, nonce: 0n, success: false, actualGasCost });
    const seen = await watchOver(chain).findEvent(HASH_A, from);
    expect(seen).toMatchObject({ status: 'landed', success: false, actualGasCost, block: chain.blockNumber });
    expect(seen.status === 'landed' && /^0x[0-9a-f]{64}$/.test(seen.txHash)).toBe(true);
  });

  it('a log with no block or transaction is not taken as landed', async () => {
    const chain = new FakeEntryPoint();
    const from = chain.blockNumber;
    chain.blockNumber += 1n;
    chain.events.push({ block: chain.blockNumber, userOpHash: HASH_A, sender: SENDER, nonce: 0n, success: true, actualGasCost: 1n });
    const client = {
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        if (method === 'eth_blockNumber') return toHex(chain.blockNumber);
        const logs = chain.logs(params as unknown[]).result as Array<Record<string, unknown>>;
        return logs.map(({ blockNumber: _b, transactionHash: _t, ...rest }) => rest);
      },
    } as unknown as PublicClient;
    expect(await liveFeePaidWatch(client).findEvent(HASH_A, from)).toEqual({ status: 'unavailable' });
  });
});

describe('D172: a later paid top-up only replaces burned gas, and the charged path has its own hourly cap', () => {
  const P = 234_195_592_000_000_000n; // a market order plus fee leg at the browser's 244 gwei (scenario D)
  // The recorded actualGasCost of a real mainnet order (fixture, block 0x668bcce).
  const BURN = BigInt(fixture.bundles[2]!.pimlicoReceipt.actualGasCost);
  let seq = 0;
  const opHash = () => `0x${(0xd172000 + ++seq).toString(16).padStart(64, '0')}` as Hex;

  function gate(h: Harness) {
    const { executor, paid } = recordingTopUps(h.chain);
    const watch: FeePaidWatch = {
      latestBlock: async () => h.chain.blockNumber,
      findEvent: async () => ({ status: 'pending' }),
    };
    const g = new PrefundGate({
      db: h.db,
      client: h.chain.client(),
      executor,
      budgets: PREFUND_BUDGETS,
      now: () => NOW_MS,
      log: { info: () => {}, warn: () => {} },
      feePaidWatch: watch,
    });
    const ask = (sender: Address, userOpHash = opHash(), requiredPrefund = P) =>
      g.ensure(sender, {
        prove: async () => true,
        purpose: 'other',
        budgetScope: 'fee-paid',
        requiredPrefund,
        feePaidOp: { userOpHash },
      });
    return { ask, paid };
  }

  /** The operation a top-up was for lands: what the self-bundler's receipt (or the event) records. */
  function lands(h: Harness, sender: Address, how: { success: boolean; ownBundle: boolean; burn?: bigint }) {
    const marker = h.db.outstandingFeePaidTopUp(sender)!;
    h.chain.blockNumber += 2n;
    h.db.recordGasBurn({
      userOpHash: marker.userOpHash,
      address: sender,
      block: h.chain.blockNumber,
      actualGasCost: how.burn ?? BURN,
      success: how.success,
      ownBundle: how.ownBundle,
      now: NOW_MS,
    });
    h.db.confirmFeePaidTopUpByHash(marker.userOpHash, how.success, NOW_MS);
    const key = sender.toLowerCase();
    h.chain.deposits.set(key, h.chain.deposit(sender) - (how.burn ?? BURN));
  }

  it('the first top-up is sized to the need; after it lands and the rest is withdrawn, none is paid', async () => {
    const h = await harness();
    const user = freshUser().address;
    h.chain.deposits.set(user.toLowerCase(), 0n);
    const { ask, paid } = gate(h);
    expect(await ask(user)).toMatchObject({ kind: 'funded', amount: P });
    lands(h, user, { success: true, ownBundle: false });
    h.chain.deposits.set(user.toLowerCase(), 0n); // withdrawTo: P - BURN leaves
    const refused = await ask(user);
    expect(refused).toEqual({
      kind: 'refused',
      refusal: { message: TOP_UP_ABOVE_GAS_USED_MESSAGE, data: { reason: 'TOP_UP_ABOVE_GAS_USED' } },
    });
    expect(paid).toHaveLength(1);
  });

  it('Hrev in our own bundle: the reverted run’s real actualGasCost bounds the next top-up, not zero, not the prefund', async () => {
    const h = await harness();
    const user = freshUser().address;
    h.chain.deposits.set(user.toLowerCase(), 0n);
    const { ask, paid } = gate(h);
    await ask(user);
    lands(h, user, { success: false, ownBundle: true });
    expect(h.db.gasBurns(user)).toMatchObject([{ actualGasCost: BURN, success: false, counted: true }]);
    h.chain.deposits.set(user.toLowerCase(), 0n); // the remainder, withdrawn
    expect((await ask(user)).kind).toBe('refused'); // P needed, BURN may be replaced
    h.chain.deposits.set(user.toLowerCase(), P - BURN); // refilled from the owner's own MON
    expect(await ask(user)).toMatchObject({ kind: 'funded', amount: BURN });
    expect(paid.map((p) => p.amount)).toEqual([P, BURN]);
  });

  it('Hrev in someone else’s bundle: its gas is read and kept, but never replaced; its fee never ran', async () => {
    const h = await harness();
    const user = freshUser().address;
    h.chain.deposits.set(user.toLowerCase(), 0n);
    const { ask, paid } = gate(h);
    await ask(user);
    lands(h, user, { success: false, ownBundle: false });
    expect(h.db.gasBurns(user)).toMatchObject([{ actualGasCost: BURN, success: false, counted: false }]);
    h.chain.deposits.set(user.toLowerCase(), P - BURN);
    expect((await ask(user)).kind).toBe('refused');
    expect(paid).toHaveLength(1);
  });

  it('a succeeded fee-paid run in someone else’s bundle is replaced: its fee leg ran', async () => {
    const h = await harness();
    const user = freshUser().address;
    h.chain.deposits.set(user.toLowerCase(), 0n);
    const { ask, paid } = gate(h);
    await ask(user);
    lands(h, user, { success: true, ownBundle: false });
    expect(await ask(user)).toMatchObject({ kind: 'funded', amount: BURN });
    expect(paid.map((p) => p.amount)).toEqual([P, BURN]);
  });

  it('an honest account’s other operations count too: a send between two paid orders does not lock it out', async () => {
    const h = await harness();
    const user = freshUser().address;
    h.chain.deposits.set(user.toLowerCase(), 0n);
    const { ask } = gate(h);
    await ask(user);
    lands(h, user, { success: true, ownBundle: true });
    // A free send, bundled by us, burns from the same deposit.
    const sendBurn = BigInt(fixture.bundles[3]!.pimlicoReceipt.actualGasCost);
    h.chain.blockNumber += 1n;
    h.db.recordGasBurn({ userOpHash: opHash(), address: user, block: h.chain.blockNumber, actualGasCost: sendBurn, success: true, ownBundle: true, now: NOW_MS });
    h.chain.deposits.set(user.toLowerCase(), h.chain.deposit(user) - sendBurn);
    expect(await ask(user)).toMatchObject({ kind: 'funded', amount: BURN + sendBurn });
  });

  it('a burn in the block the last top-up was sized at, or with no block, is not counted', async () => {
    const h = await harness();
    const user = freshUser().address;
    h.chain.deposits.set(user.toLowerCase(), 0n);
    const { ask } = gate(h);
    await ask(user);
    const marker = h.db.outstandingFeePaidTopUp(user)!;
    h.db.recordGasBurn({ userOpHash: opHash(), address: user, block: marker.fromBlock, actualGasCost: 7n, success: true, ownBundle: true, now: NOW_MS });
    h.db.recordGasBurn({ userOpHash: opHash(), address: user, block: undefined, actualGasCost: 11n, success: true, ownBundle: true, now: NOW_MS });
    h.db.recordGasBurn({ userOpHash: marker.userOpHash, address: user, block: marker.fromBlock + 1n, actualGasCost: BURN, success: true, ownBundle: true, now: NOW_MS });
    h.db.confirmFeePaidTopUpByHash(marker.userOpHash, true, NOW_MS);
    expect(h.db.gasBurnedSince(user, marker.fromBlock)).toBe(BURN);
  });

  it('a free operation that succeeded in someone else’s bundle is not replaced: it carried no fee', () => {
    const db = new RelayerDb(':memory:');
    const user = freshUser().address;
    db.recordGasBurn({ userOpHash: opHash(), address: user, block: 10n, actualGasCost: BURN, success: true, ownBundle: false, now: NOW_MS });
    expect(db.gasBurns(user)).toMatchObject([{ success: true, counted: false }]);
    expect(db.gasBurnedSince(user, 0n)).toBe(0n);
  });

  it('the same operation seen by two readers is one burn; proof it was ours only ever upgrades it', () => {
    const db = new RelayerDb(':memory:');
    const user = freshUser().address;
    const hash = opHash();
    db.recordGasBurn({ userOpHash: hash, address: user, block: 10n, actualGasCost: BURN, success: false, ownBundle: false, now: NOW_MS });
    expect(db.gasBurnedSince(user, 0n)).toBe(0n);
    db.recordGasBurn({ userOpHash: hash, address: user, block: 10n, actualGasCost: BURN, success: false, ownBundle: true, now: NOW_MS });
    expect(db.gasBurnedSince(user, 0n)).toBe(BURN);
    db.recordGasBurn({ userOpHash: hash, address: user, block: 10n, actualGasCost: BURN, success: false, ownBundle: false, now: NOW_MS });
    expect(db.gasBurnedSince(user, 0n)).toBe(BURN);
    expect(db.gasBurns(user)).toHaveLength(1);
  });

  describe('fix 2: 1 MON per address per hour on the charged path', () => {
    function spent(h: Harness, user: Address, amount: bigint, now = NOW_MS) {
      const r = h.db.reservePrefund({
        address: user,
        amountWei: amount,
        purpose: `${FEE_PAID_PURPOSE_PREFIX}other`,
        budgets: budgetsFor(PREFUND_BUDGETS, 'fee-paid'),
        now,
      });
      if (!r.ok) throw new Error('seed refused');
      h.db.settlePrefund(r.id, 'paid', { now });
    }

    it('is a code constant of 1 MON, and what the charged path is held to', () => {
      expect(FEE_PAID_MAX_WEI_PER_ADDRESS_HOUR).toBe(10n ** 18n);
      expect(budgetsFor(PREFUND_BUDGETS, 'fee-paid').perAddressHour).toBe(10n ** 18n);
      // The shared hour is now carved (security review finding 1, second round): the
      // sponsored ceiling is the total minus the exempt slice, not the full total.
      expect(budgetsFor(PREFUND_BUDGETS, 'sponsored')).toEqual({
        ...PREFUND_BUDGETS,
        allAddressesHour:
          PREFUND_BUDGETS.allAddressesHour -
          effectiveExemptAllAddressesHourCap(PREFUND_BUDGETS.allAddressesHour),
      });
      expect(effectiveFeePaidPerAddressHourCap(2n * 10n ** 18n)).toBe(10n ** 18n); // cannot be raised
      expect(effectiveFeePaidPerAddressHourCap(10n ** 17n)).toBe(10n ** 17n); // can be lowered
    });

    it('a top-up that fits exactly is paid; one wei over is refused as the free tier’s hourly cap is', async () => {
      const h = await harness();
      const fits = freshUser().address;
      const over = freshUser().address;
      for (const u of [fits, over]) h.chain.deposits.set(u.toLowerCase(), 0n);
      spent(h, fits, FEE_PAID_MAX_WEI_PER_ADDRESS_HOUR - P);
      spent(h, over, FEE_PAID_MAX_WEI_PER_ADDRESS_HOUR - P + 1n);
      const { ask, paid } = gate(h);
      expect(await ask(fits)).toMatchObject({ kind: 'funded', amount: P });
      const refused = await ask(over);
      const resetsAt = windowStartOf(NOW_MS) + HOUR_MS;
      expect(refused).toEqual({
        kind: 'refused',
        refusal: {
          message: sponsorshipAllowanceMessage('account-hour', resetsAt, { now: NOW_MS, clock: utcClock }),
          data: { reason: SPONSORSHIP_ALLOWANCE_USED, scope: 'account-hour', resetsAt },
        },
      });
      expect(paid).toHaveLength(1);
    });

    it('a used-up hour is refused before anything is proven, and is free again next hour', async () => {
      const h = await harness();
      const user = freshUser().address;
      h.chain.deposits.set(user.toLowerCase(), 0n);
      spent(h, user, FEE_PAID_MAX_WEI_PER_ADDRESS_HOUR);
      const { ask, paid } = gate(h);
      const refused = await ask(user);
      expect(refused.kind === 'refused' && refused.refusal.data).toMatchObject({ scope: 'account-hour' });
      expect(paid).toHaveLength(0);
      const later = new PrefundGate({
        db: h.db,
        client: h.chain.client(),
        executor: recordingTopUps(h.chain).executor,
        budgets: PREFUND_BUDGETS,
        now: () => NOW_MS + HOUR_MS,
        log: { info: () => {}, warn: () => {} },
        feePaidWatch: { latestBlock: async () => h.chain.blockNumber, findEvent: async () => ({ status: 'pending' }) },
      });
      expect(
        await later.ensure(user, {
          prove: async () => true,
          purpose: 'other',
          budgetScope: 'fee-paid',
          requiredPrefund: P,
          feePaidOp: { userOpHash: opHash() },
        }),
      ).toMatchObject({ kind: 'funded', amount: P });
    });

    it('the two per-address ledgers are separate: charged top-ups never use up free ones, nor the reverse', async () => {
      const h = await harness();
      const user = freshUser().address;
      spent(h, user, FEE_PAID_MAX_WEI_PER_ADDRESS_HOUR);
      expect(h.db.prefundUsage(user, NOW_MS, 'fee-paid').addressHour).toBe(FEE_PAID_MAX_WEI_PER_ADDRESS_HOUR);
      expect(h.db.prefundUsage(user, NOW_MS, 'sponsored').addressHour).toBe(0n);
      expect(h.db.prefundUsage(user, NOW_MS).allAddressesHour).toBe(FEE_PAID_MAX_WEI_PER_ADDRESS_HOUR);
      const r = h.db.reservePrefund({ address: user, amountWei: ENTRYPOINT_TOPUP_WEI, purpose: 'other', budgets: PREFUND_BUDGETS, now: NOW_MS });
      expect(r.ok).toBe(true);
      expect(h.db.prefundUsage(user, NOW_MS, 'fee-paid').addressHour).toBe(FEE_PAID_MAX_WEI_PER_ADDRESS_HOUR);
      // The reservation itself re-checks the charged ledger, in its own transaction.
      const oneMore = h.db.reservePrefund({
        address: user,
        amountWei: 1n,
        purpose: `${FEE_PAID_PURPOSE_PREFIX}other`,
        budgets: budgetsFor(PREFUND_BUDGETS, 'fee-paid'),
        now: NOW_MS,
      });
      expect(oneMore.ok).toBe(false);
    });
  });
});

describe('review 4: the funded run is simulated two minutes ahead, and on the free path too', () => {
  it('the simulation asks for now + 120 s, and a node that ignores that is no answer', async () => {
    const h = await harness();
    const user = freshUser();
    useFreeActions(h.db, user.address, [[5, 20]]);
    h.chain.setMargin(user.address, { USDC: 10_000_000n });
    h.chain.deposits.set(user.address.toLowerCase(), 0n);
    const q = await quote(h, user.address, [order]);
    h.chain.ignoreTimeOverride = true;
    const { wire } = await operation(user, [order, ...q.fee!.calls!], { gas: gasOf(q.fee!) });
    expect((await send(h, wire)).error?.message).toBe(UNFUNDABLE_MESSAGE);
    expect(h.chain.lastRequestedTime).toBe(BigInt(Math.floor(NOW_MS / 1000) + 120));
    expect(h.paid).toHaveLength(0);
  });

  it('a free send is funded only if its funded run succeeds, like a charged one', async () => {
    const h = await harness();
    const user = freshUser(); // free actions left
    h.chain.deposits.set(user.address.toLowerCase(), 0n);
    h.chain.simulateFailure = 'AA23 reverted';
    const { wire } = await operation(user, [order]);
    const body = await send(h, wire);
    expect(body.error?.message).toBe('This would fail on chain, so nothing was sent. The chain answered: FailedOp: AA23 reverted');
    expect(h.paid).toHaveLength(0);
    // Its free action is given back: nothing reached a bundler.
    expect(h.db.freeActionLedger(user.address).map((r) => r.status)).toEqual(['released']);
    h.chain.simulateFailure = undefined;
    const ok = await operation(user, [order]);
    expect((await send(h, ok.wire)).error).toBeUndefined();
    expect(h.chain.simulations.at(-1)).toEqual({ topUp: ENTRYPOINT_TOPUP_WEI, outcome: 'ran' });
  });
});

describe('review 2: the relayer’s own signing address is forbidden everywhere, not only while it is the fee address', () => {
  it('fee address and hot key apart (as D169 requires before production): naming the hot key is refused', async () => {
    const h = await harness(); // fee address FEE_TO, signing address HOT_KEY
    const user = freshUser();
    h.chain.setMargin(user.address, { USDC: 10_000_000n });
    const toHot = buildErc20Transfer(USDC, HOT_KEY, 1_000_000n);
    const creditHot: Call = { to: MARGIN, data: buildDeposit(MARGIN, HOT_KEY, USDC, 1_000_000n).data };
    for (const calls of [[{ to: toHot.to, data: toHot.data }], [order, creditHot], [{ to: HOT_KEY, data: order.data }]]) {
      const { wire } = await operation(user, calls);
      expect((await send(h, wire)).error?.data).toMatchObject({ reason: 'FEE_LEG_MISMATCH' });
      const res = await h.app.inject({
        method: 'POST',
        url: '/v1/gas/quote',
        payload: { sender: user.address, calls, maxFeePerGas: toHex(OP_MAX_FEE), maxPriorityFeePerGas: toHex(OP_TIP) },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toMatchObject({ code: 'FEE_LEG_MISMATCH' });
    }
    expect(h.forwarded).toHaveLength(0);
    // While the fee leg to the fee address is untouched by it.
    useFreeActions(h.db, user.address, [[5, 20]]);
    const q = await quote(h, user.address, [order]);
    const { wire } = await operation(user, [order, ...q.fee!.calls!], { gas: gasOf(q.fee!) });
    expect((await send(h, wire)).error).toBeUndefined();
  });

  it('a relayer charging nothing still refuses its own hot key', async () => {
    const h = await harness({ feeRecipient: null });
    const user = freshUser();
    const toHot = buildErc20Transfer(USDC, HOT_KEY, 1_000_000n);
    const { wire } = await operation(user, [{ to: toHot.to, data: toHot.data }]);
    expect((await send(h, wire)).error?.data).toMatchObject({ reason: 'FEE_LEG_MISMATCH' });
  });
});

describe('review 3a: concurrent sends race for the last free action at the reservation itself', () => {
  it('21 sends all read "0 used", all reach the reservation, and exactly 20 win it', async () => {
    const h = await harness();
    const user = freshUser();
    h.chain.setMargin(user.address, { USDC: 10_000_000n });
    const attempts: boolean[] = [];
    const reserve = h.db.reserveFreeAction.bind(h.db);
    h.db.reserveFreeAction = (entry) => {
      const result = reserve(entry);
      attempts.push(result.ok);
      return result;
    };
    const ops = await Promise.all(Array.from({ length: 21 }, () => operation(user, [order])));
    h.chain.gateInnerReads(21);
    const bodies = await Promise.all(ops.map((o) => send(h, o.wire)));

    // Every one of the 21 got past the free-action read and reached the reservation.
    expect(attempts).toHaveLength(21);
    expect(attempts.filter(Boolean)).toHaveLength(20);
    const refused = bodies.filter((b) => b.error !== undefined);
    expect(refused).toHaveLength(1);
    // The loser gets the one gas message, from the ledger as it stands after the race.
    expect(refused[0]!.error?.data).toMatchObject({
      reason: 'FREE_ACTIONS_USED',
      freeActions: { used: 20, remaining: 0 },
    });
    expect(h.db.freeActionLedger(user.address).filter((r) => r.status === 'used')).toHaveLength(20);
    expect(h.forwarded).toHaveLength(20);
  });
});

describe('review 3b: fee-paid top-ups count against, and are bounded by, the all-accounts hourly budget', () => {
  it('paid sends from several accounts stop at the shared hour, a short last top-up is not paid, and the free path then sees it spent', async () => {
    // RELAYER_PREFUND_MAX_MON = 0.2: 0.05 an address-hour, 0.5 shared before any carve.
    // A paid operation's prefund (~0.234 MON) is above any one address's hour, which
    // fee-paid ignores. The fee-paid/sponsored ceiling is now the carved-down remainder
    // (security review finding 1, second round), not the raw 0.5 — computed here, not
    // hardcoded, so this test does not silently drift from `budgetsFor`'s own math.
    const h = await harness({ configOverride: { prefundMaxMon: 0.2 } });
    const shared = budgetsFor(prefundBudgets(2n * 10n ** 17n), 'fee-paid').allAddressesHour;
    const results: Array<string | undefined> = [];
    for (let i = 0; i < 6; i++) {
      const user = freshUser();
      useFreeActions(h.db, user.address, [[5, 20]]);
      h.chain.setMargin(user.address, { USDC: 10_000_000n });
      h.chain.deposits.set(user.address.toLowerCase(), 0n);
      const q = await quote(h, user.address, [order]);
      const { wire } = await operation(user, [order, ...q.fee!.calls!], { gas: gasOf(q.fee!) });
      const body = await send(h, wire);
      // B2c: the wire never names a scope any more — a refused paid top-up answers
      // the one gas sentence. The loop stops at the first refusal; that it was the
      // SHARED hour that bound is asserted from the ledger below, not from the words.
      results.push(body.error?.data && 'reason' in body.error.data ? String(body.error.data.reason) : undefined);
      if (body.error) break;
    }
    const total = h.paid.reduce((sum, p) => sum + p.amount, 0n);
    expect(total).toBeLessThanOrEqual(shared);
    expect(total).toBeGreaterThan(0n);
    expect(results[results.length - 1]).toBe('FREE_ACTIONS_USED');
    // The shared fee-paid hour really is what bound: what remains cannot pay another
    // top-up of the size every paid send here actually drew.
    expect(shared - total).toBeLessThan(h.paid[0]!.amount);
    // Counted in the shared hour, where the free path reads it too.
    expect(h.db.prefundUsage(freshUser().address, NOW_MS).allAddressesHour).toBe(total);
    // A fresh address's own order, after the shared pool has been drawn down this far,
    // is still refused for a budget reason — never silently sponsored past the shared
    // ceiling. Which exact wording depends on whether this address's OWN per-address
    // hourly cap or the shared remainder binds first (a numeric coincidence of the
    // carve fraction and this test's tightened config, not something this test is
    // about) — D175 shows the single consolidated message unless the shared pool
    // itself, specifically, is what is empty.
    const free = freshUser();
    h.chain.deposits.set(free.address.toLowerCase(), 0n);
    const { wire } = await operation(free, [order]);
    const freeBody = await send(h, wire);
    expect(freeBody.error?.data).toMatchObject({
      reason: expect.stringMatching(/^(FREE_ACTIONS_USED|SPONSORSHIP_ALLOWANCE_USED)$/),
    });
  });
});

describe('review 4: feeAddressIsHotKey says "unknown" when it cannot tell, never false', () => {
  it('no readable signing address: /v1/health reports unknown, and boot warns', async () => {
    process.env.LOG_LEVEL = 'warn';
    const lines: string[] = [];
    const chain = new Chain();
    const allowlist = new TargetAllowlist(undefined as never, 'mainnet');
    allowlist.seed([{ address: MARGIN, kind: 'marginAccount', symbol: 'MarginAccount', trustsForwarder: true }]);
    const app = await buildServer({
      config: { ...config, feeAddress: FEE_TO },
      gate: { mode: 'mainnet', runMode: 'live', realFundsAcknowledged: true },
      client: chain.client(),
      allowlist,
      db: new RelayerDb(':memory:'),
      topUpExecutor: recordingTopUps(chain).executor,
      bundleExecutor: null,
      relayerAddress: async () => undefined,
      logStream: { write: (line) => lines.push(line) },
    });
    const health = JSON.parse((await app.inject({ method: 'GET', url: '/v1/health' })).body) as {
      feeAddressIsHotKey: unknown;
    };
    expect(health.feeAddressIsHotKey).toBe('unknown');
    const warnings = lines.map((l) => JSON.parse(l) as { level: number; feeAddressIsHotKey?: unknown });
    expect(warnings).toEqual([expect.objectContaining({ level: 40, feeAddressIsHotKey: 'unknown' })]);
    await app.close();
  });
});

describe('review 5: a Flow referrer that is a relayer address is flagged at boot', () => {
  async function boot(flowReferrer: string | undefined) {
    process.env.LOG_LEVEL = 'warn';
    const lines: string[] = [];
    const chain = new Chain();
    const app = await buildServer({
      config: { ...config, feeAddress: FEE_TO, ...(flowReferrer ? { flowReferrer } : {}) },
      gate: { mode: 'mainnet', runMode: 'live', realFundsAcknowledged: true },
      client: chain.client(),
      db: new RelayerDb(':memory:'),
      topUpExecutor: recordingTopUps(chain).executor,
      bundleExecutor: null,
      relayerAddress: async () => HOT_KEY,
      logStream: { write: (line) => lines.push(line) },
    });
    await app.close();
    return lines.map((l) => JSON.parse(l) as { flowReferrerIsRelayerAddress?: boolean; msg: string });
  }

  it('equal to the fee address, or to the hot key: one warning; anything else: none', async () => {
    for (const referrer of [FEE_TO, HOT_KEY.toLowerCase()]) {
      const lines = await boot(referrer);
      expect(lines.filter((l) => l.flowReferrerIsRelayerAddress)).toHaveLength(1);
      expect(lines[0]!.msg).toMatch(/KURU_FLOW_REFERRER/);
    }
    expect(await boot(SOMEONE)).toEqual([]);
    expect(await boot(undefined)).toEqual([]);
  });

  it('config reads KURU_FLOW_REFERRER, and a malformed one is ignored rather than fatal', () => {
    expect(relayerEnvSchema.parse({ KURU_FLOW_REFERRER: FEE_TO }).KURU_FLOW_REFERRER).toBe(FEE_TO);
    expect(relayerEnvSchema.parse({ KURU_FLOW_REFERRER: 'not-an-address' }).KURU_FLOW_REFERRER).toBeUndefined();
  });
});

describe('where fees are paid is configuration the relayer checks at boot', () => {
  it('RELAYER_FEE_ADDRESS: blank, as .env.example ships it, is unset; malformed refuses to boot', () => {
    expect(relayerEnvSchema.parse({ RELAYER_FEE_ADDRESS: '' }).RELAYER_FEE_ADDRESS).toBeUndefined();
    expect(() => relayerEnvSchema.parse({ RELAYER_FEE_ADDRESS: '0x1234' })).toThrow();
  });

  it('a known contract, the zero address or a malformed one is never a fee address', () => {
    expect(() => assertFeeRecipient(MAINNET.tokens.USDC.address)).toThrow(/fees would be lost/);
    expect(() => assertFeeRecipient(MARGIN)).toThrow(/fees would be lost/);
    expect(() => assertFeeRecipient(ENTRY_POINT_V08)).toThrow(/fees would be lost/);
    expect(() => assertFeeRecipient(`0x${'0'.repeat(40)}`)).toThrow();
    expect(() => assertFeeRecipient('0x1234')).toThrow();
    expect(assertFeeRecipient(FEE_TO.toLowerCase())).toBe(FEE_TO);
  });
});

describe('/v1/health reports the policy and nothing key-shaped', () => {
  it('free actions per day, the minimum and the ceiling', async () => {
    const h = await harness();
    const res = await h.app.inject({ method: 'GET', url: '/v1/health' });
    const body = JSON.parse(res.body) as { gasFee: Record<string, unknown> };
    expect(body.gasFee).toEqual({
      freeActionsPerDay: 20,
      charging: true,
      tokens: ['USDC', 'AUSD'],
      decimals: 6,
      minimum: '5000',
      step: '1000',
      max: '100000',
      marginPct: 20,
    });
    expect(res.body).not.toMatch(/0x[0-9a-fA-F]{64}/);
  });
});

describe('security review of D191, finding 3: one burn refills one lane', () => {
  it('an own-bundle burn of an exempt-marked operation counts for the exempt lane only; any other counted burn for fee-paid only', () => {
    const db = new RelayerDb(':memory:');
    const who = getAddress('0x00000000000000000000000000000000000d1910');
    const exemptHash = `0x${'e1'.repeat(32)}`;
    const feeHash = `0x${'f1'.repeat(32)}`;
    db.openFeePaidTopUp({ address: who, userOpHash: exemptHash, fromBlock: 10n, now: NOW_MS, scope: 'exempt', nonce: 1n });
    db.openFeePaidTopUp({ address: who, userOpHash: feeHash, fromBlock: 10n, now: NOW_MS });
    db.recordGasBurn({ userOpHash: exemptHash, address: who, block: 11n, actualGasCost: 7n, success: true, ownBundle: true, now: NOW_MS });
    db.recordGasBurn({ userOpHash: feeHash, address: who, block: 12n, actualGasCost: 5n, success: true, ownBundle: false, now: NOW_MS });
    expect(db.gasBurnedSince(who, 10n, 'exempt')).toBe(7n);
    expect(db.gasBurnedSince(who, 10n, 'fee-paid')).toBe(5n);
  });

  it('an exempt-marked operation someone else bundled counts for neither lane', () => {
    const db = new RelayerDb(':memory:');
    const who = getAddress('0x00000000000000000000000000000000000d1911');
    const hash = `0x${'e2'.repeat(32)}`;
    db.openFeePaidTopUp({ address: who, userOpHash: hash, fromBlock: 10n, now: NOW_MS, scope: 'exempt', nonce: 1n });
    db.recordGasBurn({ userOpHash: hash, address: who, block: 11n, actualGasCost: 9n, success: true, ownBundle: false, now: NOW_MS });
    expect(db.gasBurnedSince(who, 10n, 'exempt')).toBe(0n);
    expect(db.gasBurnedSince(who, 10n, 'fee-paid')).toBe(0n);
  });
});
