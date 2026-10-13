import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  createPublicClient,
  encodeFunctionData,
  getAddress,
  http,
  parseAbi,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import {
  formatUserOperationRequest,
  getUserOperationTypedData,
  toSimple7702SmartAccount,
  type UserOperation,
} from 'viem/account-abstraction';
import {
  buildDeposit,
  buildFeeLeg,
  buildMarketOrder,
  decodeMarketParams,
  delegationCodeFor,
  ENTRY_POINT_V08,
  MAINNET,
  monad,
  operationGasFee,
  PREFUND_BUDGETS,
  SIMPLE_7702_DELEGATE,
} from '@tradepro/core';
import {
  MON_USDC,
  RECORDED_TUPLES,
} from '../../../packages/core/src/kuru/__fixtures__/liveMarketsHarness.js';
import { isolateEnv } from './testEnv.js';
import { buildServer } from './server.js';
import { TargetAllowlist } from './allowlist.js';
import { RelayerDb } from './db.js';
import type { RelayerConfig } from './config.js';
import type { TopUpExecutor } from './prefund.js';
import { FakeEntryPoint } from './testEntryPoint.js';

/**
 * Finding 1 of the independent review (2026-09-24), reproduced end to end: can a signed
 * operation get the relayer to top up a deposit the EntryPoint will still refuse, and then
 * be replayed for another top-up?
 *
 * The bundler here answers as the EntryPoint does: AA21 when the deposit is short of the
 * prefund of the limits and max fee AS SIGNED, AA25 for a used nonce, and otherwise runs the
 * operation, using its nonce. Between replays the attacker withdraws the deposit, as
 * `EntryPoint.withdrawTo` from their own account would. The chain answers from recorded
 * mainnet data: MON/USDC params and touch at block 107,310,277, Monad's 100 gwei base fee,
 * the browser's 244 / 4 gwei fees, and the recorded inner estimate of a market sell.
 *
 * Each scenario logs one `REPRO` line: top-ups paid, their total, and whether an honest
 * account was refused afterwards. This same file was run against the code before the fix
 * (on a throwaway copy) and after it; the assertions are the fixed behaviour.
 */

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/selfBundle.mainnet.json', import.meta.url), 'utf8'),
) as {
  rpc: Record<string, { result?: unknown }>;
  bundles: Array<{ pimlicoReceipt: { actualGasUsed: Hex } }>;
};

const GWEI = 10n ** 9n;
const MON = 10n ** 18n;
const MARGIN = MAINNET.kuru.marginAccount as Address;
const USDC = getAddress(MAINNET.tokens.USDC.address);
const BOOK = getAddress(MON_USDC);
const FEE_TO = getAddress('0x000000000000000000000000000000000000fee5');
const HOT = getAddress('0x000000000000000000000000000000000000beef');
const NOW_MS = 1_756_800_000_000 + 20 * 60_000;
const BASE_FEE = 100n * GWEI;
const OP_MAX_FEE = 244n * GWEI;
const OP_TIP = 4n * GWEI;
const INNER_ESTIMATE = BigInt(fixture.rpc.estimateOkMarketSell!.result as Hex);
const TOUCH = [25_853_000_000_000_000n, 25_869_000_000_000_000n] as const;

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

/**
 * The EntryPoint model shared with `gasFee.test.ts`: AA25 for a used nonce, AA23 for
 * starved validation, AA21 for a short deposit, in both the bundler and the relayer's own
 * deposit-then-handleOps simulation. The second review round's model knew only AA21 and
 * AA25, which is why scenario F was not seen until a third refusal was modelled.
 */
class Chain extends FakeEntryPoint {
  readonly margin = new Map<string, bigint>();
  override nowSeconds = BigInt(Math.floor(NOW_MS / 1000));

  client(): PublicClient {
    const answers: Record<string, (params: unknown[]) => unknown> = {
      eth_estimateGas: () => ({ result: toHex(INNER_ESTIMATE) }),
      eth_getCode: () => ({ result: delegationCodeFor(SIMPLE_7702_DELEGATE) }),
      eth_getBlockByNumber: () => ({ result: { number: '0x1', baseFeePerGas: toHex(BASE_FEE) } }),
      eth_simulateV1: (params) => this.simulate(params),
      eth_blockNumber: () => ({ result: toHex(this.blockNumber) }),
      eth_getLogs: (params) => this.logs(params),
    };
    const fetchFn = async (_url: unknown, init?: { body?: unknown }) => {
      const request = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
      const answer = answers[request.method]?.(request.params) ?? { error: { code: -32601, message: 'no' } };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...(answer as object) }), {
        headers: { 'content-type': 'application/json' },
      });
    };
    const base = createPublicClient({
      chain: monad,
      transport: http('http://chain.test', { retryCount: 0, fetchFn: fetchFn as typeof fetch }),
    });
    return Object.assign({}, base, {
      readContract: async ({ address, functionName, args }: { address: Address; functionName: string; args?: readonly unknown[] }) => {
        if (functionName === 'balanceOf') return this.deposit(String(args?.[0]));
        if (functionName === 'getNonce') {
          const [sender, key] = args as [Address, bigint];
          return this.nonceFor(sender, key);
        }
        if (functionName === 'getBalance' && address.toLowerCase() === MARGIN.toLowerCase()) {
          const [user, token] = args as [Address, Address];
          return this.margin.get(`${user.toLowerCase()}:${token.toLowerCase()}`) ?? 0n;
        }
        if (functionName === 'getMarketParams') return RECORDED_TUPLES[MON_USDC];
        if (functionName === 'bestBidAsk') return TOUCH;
        throw new Error(`unexpected ${functionName}`);
      },
      // The relayer's own float; every user account holds zero native MON, which is
      // what this product's gasless accounts really hold — a test of B2a's own-MON
      // lane sets a balance on its own harness, never here.
      getBalance: async ({ address }: { address: Address }) =>
        address.toLowerCase() === HOT.toLowerCase() ? 20n * MON : 0n,
      getBlockNumber: async () => 107_310_277n,
    }) as unknown as PublicClient;
  }
}

async function harness() {
  const chain = new Chain();
  const db = new RelayerDb(':memory:');
  const paid: bigint[] = [];
  const executor: TopUpExecutor = {
    relayerAddress: () => HOT,
    async depositTo(account, amount) {
      paid.push(amount);
      chain.deposits.set(account.toLowerCase(), chain.deposit(account) + amount);
      return `0x${paid.length.toString(16).padStart(64, '0')}` as Hex;
    },
    async waitForReceipt() {
      return 'success';
    },
  };
  const allowlist = new TargetAllowlist(undefined as never, 'mainnet');
  allowlist.seed([{ address: MARGIN, kind: 'marginAccount', symbol: 'MarginAccount', trustsForwarder: true }]);
  const app = await buildServer({
    config,
    gate: { mode: 'mainnet', runMode: 'live', realFundsAcknowledged: true },
    client: chain.client(),
    allowlist,
    db,
    now: () => NOW_MS,
    topUpExecutor: executor,
    bundlerUpstream: async (payload) => {
      const p = JSON.parse(payload) as { id: number; method: string; params: unknown[] };
      const answer =
        p.method === 'eth_sendUserOperation'
          ? chain.bundle(p.params[0] as Record<string, string>)
          : { result: '0x' };
      return JSON.stringify({ jsonrpc: '2.0', id: p.id, ...answer });
    },
    bundleExecutor: null,
    feeRecipient: FEE_TO,
    relayerAddress: async () => HOT,
  });
  return { app, chain, db, paid };
}
type H = Awaited<ReturnType<typeof harness>>;

const order = (() => {
  const b = buildMarketOrder({
    market: BOOK,
    params: decodeMarketParams(RECORDED_TUPLES[MON_USDC] as never),
    side: 'buy',
    amount: 1_000_000n,
    minAmountOut: 0n,
  });
  return { to: b.to, data: b.data };
})();

let n = 1;
const freshUser = () => privateKeyToAccount(`0x${(0x7e00 + n++).toString(16).padStart(64, '0')}` as Hex);

/** Twenty free actions used, five hours ago. */
function useFreeActions(db: RelayerDb, user: Address) {
  for (let i = 0; i < 20; i++) {
    const r = db.reserveFreeAction({ address: user, purpose: 'other', limit: 1_000, now: NOW_MS - 5 * 3_600_000 });
    if (r.ok) db.settleFreeAction(r.id, 'used', NOW_MS);
  }
}

async function sign(
  user: PrivateKeyAccount,
  calls: ReadonlyArray<{ to: Address; data: Hex }>,
  gas: { callGasLimit: bigint; verificationGasLimit: bigint; preVerificationGas: bigint },
  fees: { maxFeePerGas: bigint; tip: bigint },
) {
  const account = await toSimple7702SmartAccount({ client: { chain: { id: 143 } } as never, owner: user });
  const userOperation: UserOperation<'0.8'> = {
    sender: user.address,
    nonce: BigInt(n++) << 64n,
    callData: await account.encodeCalls(calls.map((c) => ({ ...c, value: 0n }))),
    ...gas,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.tip,
    signature: '0x',
  };
  const signature = await user.signTypedData(
    getUserOperationTypedData({ chainId: 143, entryPointAddress: ENTRY_POINT_V08, userOperation }),
  );
  return formatUserOperationRequest({ ...userOperation, signature });
}

async function send(h: H, wire: unknown) {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/bundler',
    payload: { jsonrpc: '2.0', id: 1, method: 'eth_sendUserOperation', params: [wire, ENTRY_POINT_V08] },
  });
  return JSON.parse(res.body) as { result?: string; error?: { message: string; data?: { reason?: string } } };
}

async function quote(h: H, user: Address) {
  return quoteCalls(h, user, [order]);
}

async function quoteCalls(h: H, user: Address, calls: ReadonlyArray<{ to: Address; data: Hex }>) {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/gas/quote',
    payload: { sender: user, calls, maxFeePerGas: toHex(OP_MAX_FEE), maxPriorityFeePerGas: toHex(OP_TIP) },
  });
  const q = JSON.parse(res.body) as {
    fee: { amount: string; gas: Record<string, Hex>; pricing: { monUsdMid: string } };
  };
  return {
    amount: BigInt(q.fee.amount),
    gas: {
      callGasLimit: BigInt(q.fee.gas.callGasLimit!),
      verificationGasLimit: BigInt(q.fee.gas.verificationGasLimit!),
      preVerificationGas: BigInt(q.fee.gas.preVerificationGas!),
    },
    mid: BigInt(q.fee.pricing.monUsdMid),
  };
}

/**
 * Replay one signed operation, the attacker withdrawing the deposit between replays, until
 * the relayer stops paying or 30 replays (enough to reach the 5 MON shared hour at any
 * top-up size seen here). Then one honest free-tier user with an empty deposit tries an
 * ordinary order.
 */
async function drain(h: H, attacker: Address, wire: unknown) {
  const outcomes: string[] = [];
  for (let i = 0; i < 30; i++) {
    const before = h.paid.length;
    const body = await send(h, wire);
    outcomes.push(body.result ? 'ran' : (body.error?.data?.reason ?? body.error?.message.slice(0, 24) ?? '?'));
    if (h.paid.length === before) break;
    h.chain.deposits.set(attacker.toLowerCase(), 0n); // EntryPoint.withdrawTo, by the attacker
  }
  const attackerPaid = [...h.paid];
  const honest = freshUser();
  const honestWire = await sign(honest, [order], { callGasLimit: 334_745n, verificationGasLimit: 118_624n, preVerificationGas: 300_000n }, { maxFeePerGas: OP_MAX_FEE, tip: OP_TIP });
  const honestBody = await send(h, honestWire);
  const total = attackerPaid.reduce((a, b) => a + b, 0n);
  return {
    topUps: attackerPaid.length,
    totalMon: Number(total) / 1e18,
    largestMon: Number(attackerPaid.reduce((a, b) => (b > a ? b : a), 0n)) / 1e18,
    replays: outcomes.length,
    firstOutcome: outcomes[0],
    lastOutcome: outcomes[outcomes.length - 1],
    honestRefused: honestBody.error !== undefined,
    attackerPaid,
  };
}

isolateEnv();
beforeEach(() => {
  process.env.LOG_LEVEL = 'silent';
  process.env.PIMLICO_API_KEY = 'test-key-not-a-secret';
});

describe('finding 1, reproduced: a signed operation funded short of its own prefund, replayed', () => {
  async function payingAttacker(h: H) {
    const attacker = freshUser();
    useFreeActions(h.db, attacker.address);
    h.chain.margin.set(`${attacker.address.toLowerCase()}:${USDC.toLowerCase()}`, 100_000_000n);
    return attacker;
  }

  it('A: max fee signed at 10x the base fee, limits the plan’s, fee the plan’s', async () => {
    const h = await harness();
    const attacker = await payingAttacker(h);
    const q = await quote(h, attacker.address);
    // min(1000, 100 + 4) gwei per gas is what the EntryPoint would charge, so the fee for
    // this envelope is the plan's fee; its prefund is 10x.
    const fees = { maxFeePerGas: 1_000n * GWEI, tip: OP_TIP };
    const fee = operationGasFee({ ...q.gas, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.tip }, { baseFeePerGas: BASE_FEE, monUsdMid: q.mid })!;
    const wire = await sign(attacker, [order, ...buildFeeLeg(MARGIN, USDC, FEE_TO, fee)], q.gas, fees);
    const r = await drain(h, attacker.address, wire);
    console.log(`REPRO A ${JSON.stringify({ ...r, attackerPaid: undefined })}`);
    expect(r.topUps).toBe(0);
    expect(r.firstOutcome).toBe('GAS_ENVELOPE_REFUSED');
    expect(r.honestRefused).toBe(false);
  });

  it('B: limits signed above the plan, fee computed on the plan', async () => {
    const h = await harness();
    const attacker = await payingAttacker(h);
    const q = await quote(h, attacker.address);
    const inflated = { ...q.gas, callGasLimit: 2_000_000n, preVerificationGas: 1_300_000n };
    const wire = await sign(attacker, [order, ...buildFeeLeg(MARGIN, USDC, FEE_TO, q.amount)], inflated, {
      maxFeePerGas: OP_MAX_FEE,
      tip: OP_TIP,
    });
    const r = await drain(h, attacker.address, wire);
    console.log(`REPRO B ${JSON.stringify({ ...r, attackerPaid: undefined })}`);
    expect(r.topUps).toBe(0);
    expect(r.firstOutcome).toBe('GAS_ENVELOPE_REFUSED');
    expect(r.honestRefused).toBe(false);
  });

  it('C: the free path, max fee signed at 20x the base fee', async () => {
    const h = await harness();
    const attacker = freshUser(); // free actions left: the sponsored path
    const wire = await sign(attacker, [order], { callGasLimit: 334_745n, verificationGasLimit: 118_624n, preVerificationGas: 300_000n }, { maxFeePerGas: 2_000n * GWEI, tip: OP_TIP });
    const r = await drain(h, attacker.address, wire);
    console.log(`REPRO C ${JSON.stringify({ ...r, attackerPaid: undefined })}`);
    expect(r.topUps).toBe(0);
    expect(r.honestRefused).toBe(false);
  });

  it('D: an honest paid operation is funded to exactly its prefund, runs, and cannot be replayed', async () => {
    const h = await harness();
    const user = await payingAttacker(h);
    const q = await quote(h, user.address);
    const wire = await sign(user, [order, ...buildFeeLeg(MARGIN, USDC, FEE_TO, q.amount)], q.gas, {
      maxFeePerGas: OP_MAX_FEE,
      tip: OP_TIP,
    });
    const r = await drain(h, user.address, wire);
    console.log(`REPRO D ${JSON.stringify({ ...r, attackerPaid: undefined })}`);
    const prefund = (q.gas.callGasLimit + q.gas.verificationGasLimit + q.gas.preVerificationGas) * OP_MAX_FEE;
    expect(r.firstOutcome).toBe('ran');
    expect(r.attackerPaid).toEqual([prefund]);
    expect(r.topUps).toBe(1);
  });

  it('E: the attacker wins the race to withdraw before every bundle: one top-up, then the backstop holds', async () => {
    const h = await harness();
    const user = await payingAttacker(h);
    const q = await quote(h, user.address);
    const wire = await sign(user, [order, ...buildFeeLeg(MARGIN, USDC, FEE_TO, q.amount)], q.gas, {
      maxFeePerGas: OP_MAX_FEE,
      tip: OP_TIP,
    });
    h.chain.frontRunBy = user.address.toLowerCase();
    const r = await drain(h, user.address, wire);
    console.log(`REPRO E ${JSON.stringify({ ...r, attackerPaid: undefined })}`);
    const prefund = (q.gas.callGasLimit + q.gas.verificationGasLimit + q.gas.preVerificationGas) * OP_MAX_FEE;
    // The first top-up is paid: nothing can tell an honest operation from this one until
    // the race is run. Then the durable backstop (D172): that operation's event never
    // appears, so no second fee-paid top-up goes to this address. Before the backstop this
    // was 21 top-ups, 4.918 MON, and honest accounts refused for the rest of the hour.
    expect(r.attackerPaid).toEqual([prefund]);
    expect(r.lastOutcome).toBe('PRIOR_FEE_UNCONFIRMED');
    expect(r.honestRefused).toBe(false);
    expect(h.db.feePaidTopUps(user.address)).toMatchObject([{ status: 'outstanding' }]);
    expect(r.attackerPaid.reduce((a, b) => a + b, 0n)).toBeLessThanOrEqual(PREFUND_BUDGETS.allAddressesHour);
  });

  /**
   * F, found by the final review: a verificationGasLimit BELOW what validateUserOp uses
   * (5,000 against the recorded 7,314). The prefund is small, so every bound of the second
   * round passed; the top-up was paid; the EntryPoint refused AA23; nothing mined, no fee,
   * the nonce unused; the same signature replayed.
   */
  it('F: verification gas signed below what validation uses', async () => {
    const h = await harness();
    const attacker = await payingAttacker(h);
    const q = await quote(h, attacker.address);
    const starved = { ...q.gas, verificationGasLimit: 5_000n };
    const fees = { maxFeePerGas: OP_MAX_FEE, tip: OP_TIP };
    const fee = operationGasFee(
      { ...starved, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.tip },
      { baseFeePerGas: BASE_FEE, monUsdMid: q.mid },
    )!;
    const wire = await sign(attacker, [order, ...buildFeeLeg(MARGIN, USDC, FEE_TO, fee)], starved, fees);
    const r = await drain(h, attacker.address, wire);
    console.log(`REPRO F ${JSON.stringify({ ...r, attackerPaid: undefined })}`);
    expect(r.topUps).toBe(0);
    expect(r.firstOutcome).toBe('GAS_ENVELOPE_REFUSED');
    expect(r.honestRefused).toBe(false);
  });

  /**
   * The siblings the final review named but could not confirm: a preVerificationGas under a
   * bundler's own minimum, and a fee pair under what a bundler will include. This model has
   * no recorded figure for either minimum, so it cannot show them draining before the fix;
   * what it shows is that, signed that way, they are refused before any top-up now.
   */
  /**
   * G, found by the fourth review round: time. The funded-run check simulated "now", the
   * bundle runs a second or two later, so an operation good for only the next second passed
   * the check, was funded, then could not run. No race needed, just a well-chosen deadline.
   *
   * G1 is the reviewer's own case, a permit expiring one second out, which the policy can
   * see. G2 is the same trick where the policy cannot see it (a deadline inside a Flow
   * route): modelled as a call that works until now + 1 s and reverts after.
   */
  it('G1: a permit deadline one second out', async () => {
    const h = await harness();
    const attacker = await payingAttacker(h);
    // The policy reads permit deadlines against the wall clock, as in production, so this
    // scenario runs on the wall clock: the chain model’s too.
    const nowS = BigInt(Math.floor(Date.now() / 1000));
    h.chain.nowSeconds = nowS;
    const permitAbi = parseAbi([
      'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
    ]);
    const funding = (deadline: bigint) => [
      {
        to: USDC,
        data: encodeFunctionData({
          abi: permitAbi,
          functionName: 'permit',
          args: [attacker.address, MARGIN, 1_000_000n, deadline, 27, `0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`],
        }),
      },
      { to: MARGIN, data: buildDeposit(MARGIN, attacker.address, USDC, 1_000_000n).data },
    ];
    // The plan for this shape, from a quote of the same calls with an ordinary deadline:
    // same call count and call data length, so the same plan.
    const q = await quoteCalls(h, attacker.address, funding(nowS + 300n));
    h.chain.callWorksUntil.set(attacker.address.toLowerCase(), nowS + 1n); // the permit, after its deadline
    const wire = await sign(attacker, [...funding(nowS + 1n), ...buildFeeLeg(MARGIN, USDC, FEE_TO, q.amount)], q.gas, {
      maxFeePerGas: OP_MAX_FEE,
      tip: OP_TIP,
    });
    const r = await drain(h, attacker.address, wire);
    console.log(`REPRO G1 ${JSON.stringify({ ...r, attackerPaid: undefined })}`);
    expect(r.topUps).toBe(0);
    expect(r.honestRefused).toBe(false);
  });

  it('G2: a deadline the policy cannot read, one second out', async () => {
    const h = await harness();
    const attacker = await payingAttacker(h);
    const q = await quote(h, attacker.address);
    h.chain.callWorksUntil.set(attacker.address.toLowerCase(), BigInt(Math.floor(NOW_MS / 1000)) + 1n);
    const wire = await sign(attacker, [order, ...buildFeeLeg(MARGIN, USDC, FEE_TO, q.amount)], q.gas, {
      maxFeePerGas: OP_MAX_FEE,
      tip: OP_TIP,
    });
    const r = await drain(h, attacker.address, wire);
    console.log(`REPRO G2 ${JSON.stringify({ ...r, attackerPaid: undefined })}`);
    expect(r.topUps).toBe(0);
    expect(r.honestRefused).toBe(false);
  });

  /**
   * H, found in the fourth round's self-review: the operation LANDS, and the attacker
   * withdraws after it instead of before. A fee-paid top-up is the full signed prefund, at
   * the signed max fee; the EntryPoint charges only `actualGasCost`, at
   * min(max fee, base + tip), and credits the rest back to the sender's own deposit. The
   * backstop sees a landed `UserOperationEvent`, so it lets the next top-up through.
   *
   * The model charges every signed gas unit at the EntryPoint's price, the most any
   * operation can draw, so what is left is the smallest possible remainder: only the price
   * slack. Real orders draw less (the five recorded ones drew 466,653 to 494,081 gas).
   *
   * Before D172's fixes: H 21 top-ups, 4.918 MON, 2.822 MON recovered; H3x 17, 4.895 MON,
   * 3.198 recovered; Hrev 21, 4.918 MON, 2.822 recovered with $0 in fees; honest accounts
   * refused for the rest of the hour in all three. Now a later paid top-up only replaces
   * burned gas, and what was withdrawn is never put back: one top-up per address, then
   * `TOP_UP_ABOVE_GAS_USED`.
   */
  it('H: the operation lands and the attacker withdraws what it did not use: one top-up, never another', async () => {
    const lockedOut: string[] = [];
    for (const [name, maxFeePerGas, revertsInside] of [
      ['H', OP_MAX_FEE, false],
      ['H3x', 3n * BASE_FEE, false],
      ['Hrev', OP_MAX_FEE, true],
    ] as const) {
      const h = await harness();
      const attacker = await payingAttacker(h);
      // Hrev: the attacker empties its own margin between the check and the bundle, so the
      // batch reverts on chain, fee leg with it; the event still lands, success false.
      if (revertsInside) h.chain.landsRevertedFor.add(attacker.address.toLowerCase());
      let feesPaid = 0n;
      let withdrawn = 0n;
      let cycles = 0;
      let last = '';
      for (let i = 0; i < 40; i++) {
        const res = await h.app.inject({
          method: 'POST',
          url: '/v1/gas/quote',
          payload: { sender: attacker.address, calls: [order], maxFeePerGas: toHex(maxFeePerGas), maxPriorityFeePerGas: toHex(OP_TIP) },
        });
        const qb = JSON.parse(res.body) as { fee: { amount: string; gas: Record<string, Hex> } };
        const gas = {
          callGasLimit: BigInt(qb.fee.gas.callGasLimit!),
          verificationGasLimit: BigInt(qb.fee.gas.verificationGasLimit!),
          preVerificationGas: BigInt(qb.fee.gas.preVerificationGas!),
        };
        const limits = gas.callGasLimit + gas.verificationGasLimit + gas.preVerificationGas;
        const price = maxFeePerGas < BASE_FEE + OP_TIP ? maxFeePerGas : BASE_FEE + OP_TIP;
        h.chain.chargeOnExecute = limits * price;
        const before = h.paid.length;
        const wire = await sign(attacker, [order, ...buildFeeLeg(MARGIN, USDC, FEE_TO, BigInt(qb.fee.amount))], gas, {
          maxFeePerGas,
          tip: OP_TIP,
        });
        const body = await send(h, wire);
        last = body.result ? 'ran' : (body.error?.data?.reason ?? body.error?.message.slice(0, 24) ?? '?');
        if (!body.result || h.paid.length === before) break;
        cycles++;
        if (!revertsInside) feesPaid += BigInt(qb.fee.amount);
        withdrawn += h.chain.deposit(attacker.address); // EntryPoint.withdrawTo, after the run
        h.chain.deposits.set(attacker.address.toLowerCase(), 0n);
      }
      const attackerPaid = [...h.paid];
      const honest = freshUser();
      const honestWire = await sign(honest, [order], { callGasLimit: 334_745n, verificationGasLimit: 118_624n, preVerificationGas: 300_000n }, { maxFeePerGas: OP_MAX_FEE, tip: OP_TIP });
      const honestRefused = (await send(h, honestWire)).error !== undefined;
      const toppedUp = attackerPaid.reduce((a, b) => a + b, 0n);
      const mid = (TOUCH[0] + TOUCH[1]) / 2n;
      console.log(
        `REPRO ${name} ${JSON.stringify({
          topUps: attackerPaid.length,
          cycles,
          totalMon: Number(toppedUp) / 1e18,
          withdrawnMon: Number(withdrawn) / 1e18,
          withdrawnUsdAtMid: Number((withdrawn * mid) / 10n ** 18n) / 1e18,
          feesPaidUsd: Number(feesPaid) / 1e6,
          lastOutcome: last,
          honestRefused,
        })}`,
      );
      if (honestRefused) lockedOut.push(name);
      expect(attackerPaid, name).toHaveLength(1);
      expect(cycles, name).toBe(1);
      expect(last, name).toBe('TOP_UP_ABOVE_GAS_USED');
      // What left was the first top-up's own remainder, once.
      expect(withdrawn, name).toBe(attackerPaid[0]! - h.chain.chargeOnExecute);
    }
    expect(lockedOut).toEqual([]);
  });

  /**
   * The owner's required test for the refill rule. The attacker tops the deposit back up
   * from its own MON each cycle to exactly what the relayer will still replace, so every
   * cycle is funded, and withdraws everything after each landed run. Burns are the five
   * recorded mainnet orders' gas, at the EntryPoint's price. Every top-up after the first is
   * exactly what the previous run burned, and the attacker's net take after twelve cycles is
   * the first top-up's headroom, once: it does not grow with the cycles.
   */
  it('H, refill loop: after the first top-up, each is exactly the last run’s burn; the net take never regenerates', async () => {
    const h = await harness();
    const attacker = await payingAttacker(h);
    const key = attacker.address.toLowerCase();
    const recorded = fixture.bundles.map((b) => BigInt(b.pimlicoReceipt.actualGasUsed));
    const price = BASE_FEE + OP_TIP; // min(244, 100 + 4) gwei: what the EntryPoint charges
    const burns: bigint[] = [];
    let ownIn = 0n;
    let withdrawn = 0n;
    let prefund = 0n;
    for (let i = 0; i < 12; i++) {
      const q = await quote(h, attacker.address);
      prefund = (q.gas.callGasLimit + q.gas.verificationGasLimit + q.gas.preVerificationGas) * OP_MAX_FEE;
      if (i > 0) {
        // Put back from its own MON everything the relayer will not: all but the last burn.
        const own = prefund - burns[i - 1]! - h.chain.deposit(attacker.address);
        ownIn += own;
        h.chain.deposits.set(key, h.chain.deposit(attacker.address) + own);
      }
      h.chain.chargeOnExecute = recorded[i % recorded.length]! * price;
      const wire = await sign(attacker, [order, ...buildFeeLeg(MARGIN, USDC, FEE_TO, q.amount)], q.gas, {
        maxFeePerGas: OP_MAX_FEE,
        tip: OP_TIP,
      });
      const body = await send(h, wire);
      expect(body.error, `cycle ${i}`).toBeUndefined();
      burns.push(h.chain.chargeOnExecute);
      withdrawn += h.chain.deposit(attacker.address);
      h.chain.deposits.set(key, 0n); // withdrawTo, everything
    }
    const net = withdrawn - ownIn;
    console.log(
      `REPRO Hloop ${JSON.stringify({
        cycles: burns.length,
        topUps: h.paid.length,
        firstTopUpMon: Number(h.paid[0]!) / 1e18,
        laterTopUpsMon: h.paid.slice(1).map((p) => Number(p) / 1e18),
        attackerNetMon: Number(net) / 1e18,
        firstHeadroomMon: Number(h.paid[0]! - burns[0]!) / 1e18,
      })}`,
    );
    expect(h.paid[0]).toBe(prefund);
    expect(h.paid.slice(1)).toEqual(burns.slice(0, -1));
    // Conservation: the attacker keeps what the relayer put in and nothing burned.
    expect(net).toBe(h.paid[0]! - burns[burns.length - 1]!);
    expect(net).toBeLessThan(h.paid[0]!);
  });

  it('F2-F4: preVerificationGas under the plan, max fee under 1.2x base, tip under 1 gwei', async () => {
    type Gas = Awaited<ReturnType<typeof quote>>['gas'];
    const variants: Array<[string, (g: Gas) => Gas, { maxFeePerGas: bigint; tip: bigint }]> = [
      ['F2', (g) => ({ ...g, preVerificationGas: g.preVerificationGas / 2n }), { maxFeePerGas: OP_MAX_FEE, tip: OP_TIP }],
      ['F3', (g) => g, { maxFeePerGas: BASE_FEE + OP_TIP, tip: OP_TIP }],
      ['F4', (g) => g, { maxFeePerGas: OP_MAX_FEE, tip: GWEI / 2n }],
    ];
    for (const [name, edit, fees] of variants) {
      const h = await harness();
      const attacker = await payingAttacker(h);
      const q = await quote(h, attacker.address);
      const gas = edit(q.gas);
      const fee = operationGasFee(
        { ...gas, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.tip },
        { baseFeePerGas: BASE_FEE, monUsdMid: q.mid },
      )!;
      const wire = await sign(attacker, [order, ...buildFeeLeg(MARGIN, USDC, FEE_TO, fee)], gas, fees);
      const r = await drain(h, attacker.address, wire);
      console.log(`REPRO ${name} ${JSON.stringify({ ...r, attackerPaid: undefined })}`);
      expect(r.topUps, name).toBe(0);
      expect(r.firstOutcome, name).toBe('GAS_ENVELOPE_REFUSED');
    }
  });
});
