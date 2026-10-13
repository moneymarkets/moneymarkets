import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Address, Hex, PublicClient } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import {
  formatUserOperationRequest,
  getUserOperationTypedData,
  toSimple7702SmartAccount,
  type UserOperation,
} from 'viem/account-abstraction';
import {
  buildDeposit,
  ENTRY_POINT_V08,
  ENTRYPOINT_TOPUP_WEI,
  SPONSORSHIP_PAUSED_MESSAGE,
  HOUR_MS,
  MIN_ENTRYPOINT_DEPOSIT_WEI,
  nonExemptAllAddressesHour,
  PREFUND_BUDGETS,
  windowStartOf,
} from '@tradepro/core';
import { isolateEnv } from './testEnv.js';
import { buildServer } from './server.js';
import { TargetAllowlist } from './allowlist.js';
import { RelayerDb } from './db.js';
import { relayerEnvSchema, type RelayerConfig } from './config.js';
import {
  depositNeeded,
  isPrefundFailure,
  PrefundGate,
  REFILL_THRESHOLD_WEI,
  SerialLock,
  type TopUpExecutor,
} from './prefund.js';

/**
 * The three proofs S4-C1, S4-C2 and B7 are closed by, driven through the real
 * `/v1/bundler` route.
 *
 * Every operation is signed the way the browser signs one. `getUserOperationTypedData`
 * plus the owner's `signTypedData` is exactly `toSimple7702SmartAccount.signUserOperation`,
 * and it goes on the wire through viem's own `formatUserOperationRequest`. The dummy
 * signature is viem's real placeholder, read from the account, not copied into this file.
 *
 * Nothing here can move money. The top-up executor is a fake that records what it was
 * asked to pay, and the chain is a fake that answers from a map. That is deliberate:
 * this machine holds `.secrets/relayer-keystore.json`, and the live executor would sign
 * with the real mainnet key.
 */

const MARGIN = '0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5' as Address;
const AUSD = '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a' as Address;
const RELAYER = '0x000000000000000000000000000000000000fEE5' as Address;
const CHAIN_ID = 143;
/** 2025-09-02T08:20:00Z: twenty minutes into its hourly window. */
const NOW_MS = 1_756_800_000_000 + 20 * 60_000;
const MON = 10n ** 18n;

// Throwaway test keys. They hold nothing and never touch a network.
const user = privateKeyToAccount(`0x${'7c'.repeat(32)}` as Hex);
const attacker = privateKeyToAccount(`0x${'8d'.repeat(32)}` as Hex);

const config: RelayerConfig = {
  mode: 'mainnet',
  realFundsAcknowledged: true,
  rpcUrl: undefined,
  port: 0,
  maxFloatMon: 20,
  floatAlertPct: 20,
  // High enough that 60 concurrent requests are limited by the budgets under test,
  // not by the rate limiter.
  rateLimitPerAddressHour: 10_000,
  rateLimitPerIpHour: 10_000,
  maxGas: 2_000_000n,
  maxDeadlineSeconds: 300,
  dbPath: ':memory:',
  hasSigningKey: false,
  hasPimlicoKey: true,
  metricsToken: undefined,
};

/** The chain, as far as the funding path reads it. */
class FakeChain {
  readonly deposits = new Map<string, bigint>();
  /** sender:key -> operations already executed under that key. */
  readonly executed = new Map<string, bigint>();
  relayerBalance = 20n * MON;
  nativeBalances = new Map<string, bigint>();
  nonceReads = 0;

  client(): PublicClient {
    return {
      readContract: async ({
        functionName,
        args,
      }: {
        functionName: string;
        args: readonly unknown[];
      }) => {
        if (functionName === 'balanceOf') {
          return this.deposits.get(String(args[0]).toLowerCase()) ?? 0n;
        }
        if (functionName === 'getNonce') {
          this.nonceReads += 1;
          const [sender, key] = args as [Address, bigint];
          const seq = this.executed.get(`${sender.toLowerCase()}:${key}`) ?? 0n;
          return (key << 64n) | seq;
        }
        throw new Error(`the fake chain was not expecting ${functionName}`);
      },
      // The relayer's own float; user accounts hold zero native MON unless a test of
      // the own-MON lane sets one — the gasless product's real resting state.
      getBalance: async ({ address }: { address: Address }) =>
        this.nativeBalances.get(String(address).toLowerCase()) ??
        (String(address).toLowerCase() === RELAYER.toLowerCase() ? this.relayerBalance : 0n),
      call: async () => ({ data: '0x' as Hex }),
      getBlockNumber: async () => 1n,
    } as unknown as PublicClient;
  }
}

/**
 * Records every payment, and lands it on the fake chain only when its receipt is read,
 * after a real async gap. That gap is what the S4-C2 race lived in: without the lock,
 * every concurrent request read the deposit before any payment had landed.
 */
function recordingExecutor(
  chain: FakeChain,
  behaviour: { send?: 'ok' | 'throw'; receipt?: 'success' | 'reverted' | 'throw' } = {},
) {
  const sent: Array<{ account: Address; amount: bigint }> = [];
  const pending = new Map<Hex, { account: Address; amount: bigint }>();
  const executor: TopUpExecutor = {
    relayerAddress: () => RELAYER,
    async depositTo(account, amount) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      if (behaviour.send === 'throw') throw new Error('nonce too low');
      sent.push({ account, amount });
      const hash = `0x${sent.length.toString(16).padStart(64, '0')}` as Hex;
      pending.set(hash, { account, amount });
      return hash;
    },
    async waitForReceipt(hash) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (behaviour.receipt === 'throw') throw new Error('timed out');
      if (behaviour.receipt === 'reverted') return 'reverted';
      const paid = pending.get(hash);
      if (paid) {
        const key = paid.account.toLowerCase();
        chain.deposits.set(key, (chain.deposits.get(key) ?? 0n) + paid.amount);
      }
      return 'success';
    },
  };
  return { executor, sent };
}

/** How the fake bundler answers. Default: a plain result. */
type UpstreamAnswer = (method: string, id: number) => unknown;

function recordingUpstream(answer?: UpstreamAnswer) {
  const forwarded: Array<{ method: string }> = [];
  const payloads: Array<{ method: string; params: unknown[] }> = [];
  const upstream = async (payload: string) => {
    const parsed = JSON.parse(payload) as { id: number; method: string; params: unknown[] };
    forwarded.push({ method: parsed.method });
    payloads.push({ method: parsed.method, params: parsed.params });
    return JSON.stringify(
      answer?.(parsed.method, parsed.id) ?? { jsonrpc: '2.0', id: parsed.id, result: 'forwarded' },
    );
  };
  return { forwarded, payloads, upstream };
}

/** The bundler's answer when a deposit cannot cover the prefund, as Pimlico words it. */
const aa21 = (_method: string, id: number) => ({
  jsonrpc: '2.0',
  id,
  error: { code: -32500, message: "UserOperation reverted during simulation with reason: AA21 didn't pay prefund" },
});

async function harness(
  options: {
    db?: RelayerDb;
    behaviour?: Parameters<typeof recordingExecutor>[1];
    configOverride?: Partial<RelayerConfig>;
    upstreamAnswer?: UpstreamAnswer;
  } = {},
) {
  const chain = new FakeChain();
  const db = options.db ?? new RelayerDb(':memory:');
  const { executor, sent } = recordingExecutor(chain, options.behaviour);
  const { forwarded, payloads, upstream } = recordingUpstream(options.upstreamAnswer);
  const allowlist = new TargetAllowlist(undefined as never, 'mainnet');
  allowlist.seed([
    { address: MARGIN, kind: 'marginAccount', symbol: 'MarginAccount', trustsForwarder: true },
  ]);
  const app = await buildServer({
    config: { ...config, ...options.configOverride },
    gate: { mode: 'mainnet', runMode: 'live', realFundsAcknowledged: true },
    client: chain.client(),
    allowlist,
    db,
    now: () => NOW_MS,
    topUpExecutor: executor,
    bundlerUpstream: upstream,
  });
  return { app, chain, db, sent, forwarded, payloads };
}

/** A MarginAccount deposit for `owner`, encoded the way the 7702 account encodes it. */
async function depositCallData(owner: Address): Promise<Hex> {
  const account = await toSimple7702SmartAccount({
    client: { chain: { id: CHAIN_ID } } as never,
    owner: user,
  });
  return account.encodeCalls([
    { to: MARGIN, data: buildDeposit(MARGIN, owner, AUSD, 1_000_000n).data, value: 0n },
  ]);
}

/** viem's own placeholder signature for this account type — the "dummy". */
async function viemStubSignature(): Promise<Hex> {
  const account = await toSimple7702SmartAccount({
    client: { chain: { id: CHAIN_ID } } as never,
    owner: user,
  });
  return account.getStubSignature();
}

let keyCounter = 1n;
/**
 * A user operation for `sender`, signed by `signer`, in its wire form.
 * `estimate` zeroes the gas limits, as viem's estimate does.
 */
async function signedOp(options: {
  sender: Address;
  signer: PrivateKeyAccount;
  estimate: boolean;
  nonceKey?: bigint;
  signature?: Hex;
  /** A send's limits. Default: a deposit-plus-order batch, 560,000 gas. */
  gas?: { call: bigint; verification: bigint; preVerification: bigint };
}) {
  const nonceKey = options.nonceKey ?? keyCounter++;
  const gas = options.gas ?? { call: 400_000n, verification: 100_000n, preVerification: 60_000n };
  const userOperation: UserOperation<'0.8'> = {
    sender: options.sender,
    nonce: nonceKey << 64n,
    callData: await depositCallData(options.sender),
    callGasLimit: options.estimate ? 0n : gas.call,
    verificationGasLimit: options.estimate ? 0n : gas.verification,
    preVerificationGas: options.estimate ? 0n : gas.preVerification,
    maxFeePerGas: 204_000_000_000n,
    maxPriorityFeePerGas: 2_000_000_000n,
    signature: '0x',
  };
  const signature =
    options.signature ??
    (await options.signer.signTypedData(
      getUserOperationTypedData({
        chainId: CHAIN_ID,
        entryPointAddress: ENTRY_POINT_V08,
        userOperation,
      }),
    ));
  return formatUserOperationRequest({ ...userOperation, signature });
}

async function call(
  app: Awaited<ReturnType<typeof harness>>['app'],
  method: 'eth_estimateUserOperationGas' | 'eth_sendUserOperation',
  op: unknown,
  entryPoint: string = ENTRY_POINT_V08,
) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/bundler',
    payload: { jsonrpc: '2.0', id: 1, method, params: [op, entryPoint] },
  });
  return JSON.parse(res.body) as {
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
  };
}

isolateEnv();

beforeEach(() => {
  process.env.LOG_LEVEL = 'silent';
  process.env.PIMLICO_API_KEY = 'test-key-not-a-secret';
  keyCounter = 1n;
});

describe('S4-C1: a request that does not prove the sender’s key funds nothing', () => {
  it('a dummy-signature estimate: zero top-ups, zero ledger rows', async () => {
    const h = await harness();
    const op = await signedOp({
      sender: user.address,
      signer: user,
      estimate: true,
      signature: await viemStubSignature(),
    });
    const body = await call(h.app, 'eth_estimateUserOperationGas', op);

    expect(h.sent).toHaveLength(0);
    expect(h.db.prefundLedger()).toHaveLength(0);
    expect(h.chain.deposits.get(user.address.toLowerCase()) ?? 0n).toBe(0n);
    // Still forwarded, unfunded: a funded account estimates with this dummy every time,
    // and the bundler's own prefund check is what answers an unfunded one.
    expect(body.result).toBe('forwarded');
    expect(h.forwarded).toEqual([{ method: 'eth_estimateUserOperationGas' }]);
  });

  it('a dummy-signature send is refused outright and never reaches the bundler', async () => {
    const h = await harness();
    const op = await signedOp({
      sender: user.address,
      signer: user,
      estimate: false,
      signature: await viemStubSignature(),
    });
    const body = await call(h.app, 'eth_sendUserOperation', op);

    expect(body.error?.message).toBe('the operation is not signed by its sender');
    expect(h.sent).toHaveLength(0);
    expect(h.db.prefundLedger()).toHaveLength(0);
    expect(h.forwarded).toHaveLength(0);
  });

  it('a real signature by someone else funds nothing, on either method', async () => {
    const h = await harness();
    const estimate = await signedOp({ sender: user.address, signer: attacker, estimate: true });
    const send = await signedOp({ sender: user.address, signer: attacker, estimate: false });

    await call(h.app, 'eth_estimateUserOperationGas', estimate);
    const sent = await call(h.app, 'eth_sendUserOperation', send);

    expect(sent.error?.message).toBe('the operation is not signed by its sender');
    expect(h.sent).toHaveLength(0);
    expect(h.db.prefundLedger()).toHaveLength(0);
  });

  it('a replayed operation whose nonce is already used funds nothing', async () => {
    const h = await harness();
    const op = await signedOp({ sender: user.address, signer: user, estimate: false, nonceKey: 9n });
    // The chain has already executed the operation under key 9.
    h.chain.executed.set(`${user.address.toLowerCase()}:9`, 1n);

    const estimate = await call(h.app, 'eth_estimateUserOperationGas', op);
    const send = await call(h.app, 'eth_sendUserOperation', op);

    expect(estimate.result).toBe('forwarded'); // unproven: forwarded, never funded
    expect(send.error?.message).toBe('the operation does not carry this account’s next nonce');
    expect(h.sent).toHaveLength(0);
    expect(h.db.prefundLedger()).toHaveLength(0);
  });

  it('an operation for another entry point is refused before any funding', async () => {
    const h = await harness();
    const op = await signedOp({ sender: user.address, signer: user, estimate: true });
    const body = await call(
      h.app,
      'eth_estimateUserOperationGas',
      op,
      '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
    );
    expect(body.error?.message).toBe('this relayer carries operations for EntryPoint v0.8 only');
    expect(h.sent).toHaveLength(0);
    expect(h.db.prefundLedger()).toHaveLength(0);
  });

  it('a properly signed estimate is funded, once, into the sender’s own deposit', async () => {
    const h = await harness();
    const op = await signedOp({ sender: user.address, signer: user, estimate: true });
    const body = await call(h.app, 'eth_estimateUserOperationGas', op);

    expect(body.result).toBe('forwarded');
    expect(h.sent).toEqual([{ account: user.address, amount: ENTRYPOINT_TOPUP_WEI }]);
    const [row] = h.db.prefundLedger();
    expect(row?.status).toBe('paid');
    expect(row?.amountWei).toBe(ENTRYPOINT_TOPUP_WEI);
    expect(h.chain.deposits.get(user.address.toLowerCase())).toBe(ENTRYPOINT_TOPUP_WEI);
  });

  it('a funded account is never topped up again, signed or not', async () => {
    const h = await harness();
    h.chain.deposits.set(user.address.toLowerCase(), MIN_ENTRYPOINT_DEPOSIT_WEI);
    await call(
      h.app,
      'eth_sendUserOperation',
      await signedOp({ sender: user.address, signer: user, estimate: false }),
    );
    expect(h.sent).toHaveLength(0);
    expect(h.forwarded).toHaveLength(1);
  });

  it('a funded account pays no nonce read: the proof is read only when it could decide a spend', async () => {
    const h = await harness();
    h.chain.deposits.set(user.address.toLowerCase(), MIN_ENTRYPOINT_DEPOSIT_WEI);
    await call(
      h.app,
      'eth_estimateUserOperationGas',
      await signedOp({ sender: user.address, signer: user, estimate: true }),
    );
    expect(h.chain.nonceReads).toBe(0);

    // A thin deposit is the case the read exists for.
    h.chain.deposits.set(user.address.toLowerCase(), 0n);
    await call(
      h.app,
      'eth_estimateUserOperationGas',
      await signedOp({ sender: user.address, signer: user, estimate: true }),
    );
    expect(h.chain.nonceReads).toBe(1);
  });
});

describe('S4-C2: concurrent requests reserve before they spend', () => {
  it('60 concurrent requests for one address pay exactly once', async () => {
    const h = await harness();
    // Fifteen sends and forty-five estimates. Since 2026-09-24 an account's counted actions
    // past twenty in a day are charged or refused (free actions, then gas at cost), and
    // once all twenty are used even an estimate of one is refused. Fifteen keeps every
    // request inside the free tier, so this still tests the one thing it is for.
    const isEstimate = (i: number) => i % 4 !== 0;
    const ops = await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        signedOp({ sender: user.address, signer: user, estimate: isEstimate(i) }),
      ),
    );

    const bodies = await Promise.all(
      ops.map((op, i) =>
        call(h.app, isEstimate(i) ? 'eth_estimateUserOperationGas' : 'eth_sendUserOperation', op),
      ),
    );

    // One payment of one top-up, where the audit measured sixty (18 MON).
    expect(h.sent).toEqual([{ account: user.address, amount: ENTRYPOINT_TOPUP_WEI }]);
    expect(h.db.prefundLedger().filter((r) => r.status !== 'released')).toHaveLength(1);
    expect(h.chain.deposits.get(user.address.toLowerCase())).toBe(ENTRYPOINT_TOPUP_WEI);
    // And none of the 59 others was refused for it: they waited, re-read, and forwarded.
    expect(bodies.every((b) => b.result === 'forwarded')).toBe(true);
    expect(h.forwarded).toHaveLength(60);
  });

  it('60 concurrent fresh addresses cannot draw past the all-addresses hourly budget', async () => {
    const h = await harness();
    const keys = Array.from({ length: 60 }, (_, i) =>
      privateKeyToAccount(`0x${(i + 1).toString(16).padStart(64, '0')}` as Hex),
    );
    const ops = await Promise.all(
      keys.map((k) => signedOp({ sender: k.address, signer: k, estimate: true })),
    );

    const bodies = await Promise.all(ops.map((op) => call(h.app, 'eth_estimateUserOperationGas', op)));

    // The sponsored ceiling is now the carved-down remainder of the shared hour
    // (security review finding 1, second round: exempt's own slice is set aside first,
    // not added on top), not the raw total — computed here, not hardcoded.
    const ceiling = nonExemptAllAddressesHour(PREFUND_BUDGETS.allAddressesHour);
    const fullTopUps = ceiling / ENTRYPOINT_TOPUP_WEI;
    const remainder = ceiling % ENTRYPOINT_TOPUP_WEI;
    const expectedCount = remainder > 0n ? fullTopUps + 1n : fullTopUps;

    const paid = h.sent.reduce((sum, s) => sum + s.amount, 0n);
    expect(paid).toBe(ceiling);
    expect(BigInt(h.sent.length)).toBe(expectedCount);
    const refused = bodies.filter((b) => b.error);
    expect(BigInt(refused.length)).toBe(60n - expectedCount);
    // B2c: whatever internal scope bound, the route answers the ONE gas sentence with
    // its live choices — which ledger was tight is a log line, not a sentence. The
    // bound's own reset survives machine-readably (review of D181, finding 6).
    for (const b of refused) {
      expect(b.error?.message).toBe(SPONSORSHIP_PAUSED_MESSAGE);
      expect(b.error?.data).toEqual({
        reason: 'FREE_ACTIONS_USED',
        choices: ['swap-into-mon', 'add-money'],
        resetsAt: windowStartOf(NOW_MS) + HOUR_MS,
      });
    }
  });
});

describe('B7: an exhausted budget is refused in words, with a time, and nothing else', () => {
  /** Put `amounts` into the ledger as paid, in the windows `hoursAgo` before now. */
  function spend(db: RelayerDb, address: Address, entries: ReadonlyArray<[number, bigint]>) {
    for (const [hoursAgo, amount] of entries) {
      const at = NOW_MS - hoursAgo * HOUR_MS;
      const reserved = db.reservePrefund({
        address,
        amountWei: amount,
        purpose: 'deposit',
        budgets: PREFUND_BUDGETS,
        now: at,
      });
      if (!reserved.ok) throw new Error('fixture could not reserve');
      db.settlePrefund(reserved.id, 'paid', { now: at });
    }
  }

  it('the day’s allowance being spent falls through to the one gas message, not a distinct sentence (rebuild, 2026-09-25)', async () => {
    const db = new RelayerDb(':memory:');
    // 2 MON across four hours, the oldest 20 hours ago.
    spend(db, user.address, [
      [20, MON / 2n],
      [19, MON / 2n],
      [18, MON / 2n],
      [17, MON / 2n],
    ]);
    const h = await harness({ db });
    const before = h.db.prefundLedger().length;

    const body = await call(
      h.app,
      'eth_estimateUserOperationGas',
      await signedOp({ sender: user.address, signer: user, estimate: true }),
    );

    // A per-address budget alone (the shared hour has room) is an anti-drain bound,
    // not a refusal (a, d): it falls through to the one gas message, the same one
    // shown for an exhausted free tier. Before this rebuild it showed the budget's
    // own sentence, "this account's allowance for today is used up" — confusing when,
    // as here, free actions remain — which is the wrong-refusal bug this fixes.
    expect(body.error?.message).toBe(SPONSORSHIP_PAUSED_MESSAGE);
    expect(body.error?.data).toMatchObject({ reason: 'FREE_ACTIONS_USED' });
    // Refused on the estimate, before the user signs: nothing paid, nothing reserved,
    // nothing forwarded.
    expect(h.sent).toHaveLength(0);
    expect(h.db.prefundLedger()).toHaveLength(before);
    expect(h.forwarded).toHaveLength(0);
  });

  it('the hour’s allowance being spent falls through the same way — the refusal spends nothing, so it needs no proof', async () => {
    const db = new RelayerDb(':memory:');
    spend(db, user.address, [[0, PREFUND_BUDGETS.perAddressHour]]);
    const h = await harness({ db });
    const body = await call(
      h.app,
      'eth_estimateUserOperationGas',
      await signedOp({
        sender: user.address,
        signer: user,
        estimate: true,
        signature: await viemStubSignature(),
      }),
    );
    expect(body.error?.message).toBe(SPONSORSHIP_PAUSED_MESSAGE);
    expect(body.error?.data).toMatchObject({ reason: 'FREE_ACTIONS_USED' });
    expect(h.sent).toHaveLength(0);
  });

  it('the rolling day really rolls: an allowance used up yesterday is available again', async () => {
    const db = new RelayerDb(':memory:');
    spend(db, user.address, [
      [27, MON / 2n],
      [26, MON / 2n],
      [25, MON / 2n],
      [24, MON / 2n],
    ]);
    const h = await harness({ db });
    const body = await call(
      h.app,
      'eth_estimateUserOperationGas',
      await signedOp({ sender: user.address, signer: user, estimate: true }),
    );
    expect(body.result).toBe('forwarded');
    expect(h.sent).toHaveLength(1);
  });

  it('the old lifetime total no longer refuses anyone', async () => {
    const db = new RelayerDb(':memory:');
    // What a judge who hit the old wall has on disk: a lifetime total at the old cap.
    db.recordTopUp(user.address, 2n * MON, 'deposit', NOW_MS - 3 * 24 * HOUR_MS);
    const h = await harness({ db });
    const body = await call(
      h.app,
      'eth_estimateUserOperationGas',
      await signedOp({ sender: user.address, signer: user, estimate: true }),
    );
    expect(body.result).toBe('forwarded');
    expect(h.sent).toHaveLength(1);
  });
});

describe('F1: a spent budget refuses only an operation the deposit cannot pay for itself', () => {
  /** Another address's spend in the current window, to drain the all-addresses hour. */
  function drainSharedHour(db: RelayerDb) {
    for (let i = 0; i < 10; i++) {
      const r = db.reservePrefund({
        address: `0x${(0xa000 + i).toString(16).padStart(40, '0')}`,
        amountWei: PREFUND_BUDGETS.perAddressHour,
        purpose: 'deposit',
        budgets: PREFUND_BUDGETS,
        now: NOW_MS,
      });
      if (!r.ok) throw new Error('fixture could not reserve');
      db.settlePrefund(r.id, 'paid', { now: NOW_MS });
    }
  }
  /** One order: 410,000 gas at 204 gwei = 0.08364 MON of prefund. */
  const ORDER_GAS = { call: 250_000n, verification: 100_000n, preVerification: 60_000n };
  const TEN_CENTS_OF_MON = MON / 10n;

  it('the reviewer’s case: all-addresses hour drained, 0.10 MON on deposit, a 0.084 MON order goes through', async () => {
    const db = new RelayerDb(':memory:');
    drainSharedHour(db);
    const h = await harness({ db });
    h.chain.deposits.set(user.address.toLowerCase(), TEN_CENTS_OF_MON);

    const body = await call(
      h.app,
      'eth_sendUserOperation',
      await signedOp({ sender: user.address, signer: user, estimate: false, gas: ORDER_GAS }),
    );

    expect(body.result).toBe('forwarded');
    expect(h.forwarded).toEqual([{ method: 'eth_sendUserOperation' }]);
    expect(h.sent).toHaveLength(0);
    expect(h.db.prefundLedger(user.address)).toHaveLength(0);
  });

  it('refuses the same send when the deposit is below that operation’s own prefund', async () => {
    const db = new RelayerDb(':memory:');
    drainSharedHour(db);
    const h = await harness({ db });
    h.chain.deposits.set(user.address.toLowerCase(), MON / 20n); // 0.05 < 0.08364

    const body = await call(
      h.app,
      'eth_sendUserOperation',
      await signedOp({ sender: user.address, signer: user, estimate: false, gas: ORDER_GAS }),
    );

    // B2c: the user sees the one gas sentence; the shared-hour scope is internal.
    expect(body.error?.message).toBe(SPONSORSHIP_PAUSED_MESSAGE);
    expect(body.error?.data).toEqual({
      reason: 'FREE_ACTIONS_USED',
      choices: ['swap-into-mon', 'add-money'],
      resetsAt: windowStartOf(NOW_MS) + HOUR_MS,
    });
    expect(h.forwarded).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
  });

  it('an estimate with some deposit is asked of the bundler, and passes when the bundler says it can pay', async () => {
    const db = new RelayerDb(':memory:');
    drainSharedHour(db);
    const h = await harness({ db });
    h.chain.deposits.set(user.address.toLowerCase(), TEN_CENTS_OF_MON);

    const body = await call(
      h.app,
      'eth_estimateUserOperationGas',
      await signedOp({ sender: user.address, signer: user, estimate: true }),
    );

    expect(body.result).toBe('forwarded');
    expect(h.sent).toHaveLength(0);
  });

  it('…and when the bundler answers AA21, the user gets the allowance refusal, not AA21', async () => {
    const db = new RelayerDb(':memory:');
    drainSharedHour(db);
    const h = await harness({ db, upstreamAnswer: aa21 });
    h.chain.deposits.set(user.address.toLowerCase(), TEN_CENTS_OF_MON);

    const body = await call(
      h.app,
      'eth_estimateUserOperationGas',
      await signedOp({ sender: user.address, signer: user, estimate: true }),
    );

    expect(h.forwarded).toHaveLength(1); // the bundler was asked
    // B2c: even surfaced via AA21, the refusal is the one gas sentence, no scope.
    expect(body.error?.message).toBe(SPONSORSHIP_PAUSED_MESSAGE);
    expect(body.error?.data).toEqual({
      reason: 'FREE_ACTIONS_USED',
      choices: ['swap-into-mon', 'add-money'],
      resetsAt: windowStartOf(NOW_MS) + HOUR_MS,
    });
    expect(JSON.stringify(body)).not.toMatch(/AA21/);
    expect(h.sent).toHaveLength(0);
  });

  it('applies to the account’s own day as well as the shared hour', async () => {
    const db = new RelayerDb(':memory:');
    for (const hoursAgo of [5, 4, 3, 2]) {
      const r = db.reservePrefund({
        address: user.address,
        amountWei: PREFUND_BUDGETS.perAddressHour,
        purpose: 'deposit',
        budgets: PREFUND_BUDGETS,
        now: NOW_MS - hoursAgo * HOUR_MS,
      });
      if (!r.ok) throw new Error('fixture could not reserve');
    }
    const h = await harness({ db });
    h.chain.deposits.set(user.address.toLowerCase(), TEN_CENTS_OF_MON);
    const body = await call(
      h.app,
      'eth_sendUserOperation',
      await signedOp({ sender: user.address, signer: user, estimate: false, gas: ORDER_GAS }),
    );
    expect(body.result).toBe('forwarded');
  });

  it('never rewrites AA21 when a top-up was possible and simply was not proven', async () => {
    // Budget has room; the estimate carries the placeholder, so nothing is funded, and
    // the bundler's AA21 is the honest answer — there is no allowance to blame.
    const h = await harness({ upstreamAnswer: aa21 });
    h.chain.deposits.set(user.address.toLowerCase(), TEN_CENTS_OF_MON);
    const body = await call(
      h.app,
      'eth_estimateUserOperationGas',
      await signedOp({
        sender: user.address,
        signer: user,
        estimate: true,
        signature: await viemStubSignature(),
      }),
    );
    expect(body.error?.message).toMatch(/AA21/);
    expect(body.error?.data).toBeUndefined();
  });

  it('recognises AA21 in the message or the data, and nothing else', () => {
    const rpc = (error: unknown) => JSON.stringify({ jsonrpc: '2.0', id: 1, error });
    expect(isPrefundFailure(rpc({ code: -32500, message: "AA21 didn't pay prefund" }))).toBe(true);
    expect(isPrefundFailure(rpc({ code: -32500, message: 'x', data: { reason: 'AA21 ...' } }))).toBe(
      true,
    );
    expect(isPrefundFailure(rpc({ code: -32500, message: 'AA25 invalid account nonce' }))).toBe(
      false,
    );
    expect(isPrefundFailure(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'AA21' }))).toBe(false);
    expect(isPrefundFailure('not json')).toBe(false);
    expect(isPrefundFailure('[{"error":{"message":"AA21"}}]')).toBe(false);
  });
});

describe('F4: what reaches the bundler is the operation that was verified', () => {
  it('forwards the parsed operation, not the raw object, and keeps the entry point', async () => {
    const h = await harness();
    h.chain.deposits.set(user.address.toLowerCase(), MIN_ENTRYPOINT_DEPOSIT_WEI);
    const op = await signedOp({ sender: user.address, signer: user, estimate: false });
    await call(h.app, 'eth_sendUserOperation', { ...op, smuggled: 'not part of any operation' });

    const [sent] = h.payloads;
    expect(sent?.params[1]).toBe(ENTRY_POINT_V08);
    const forwardedOp = sent?.params[0] as Record<string, unknown>;
    expect(forwardedOp.smuggled).toBeUndefined();
    expect(forwardedOp.signature).toBe(op.signature);
    expect(forwardedOp.callData).toBe(op.callData);
  });
});

describe('F5: top-ups run under a lock the caller can share', () => {
  it('waits for whatever else holds the relayer key’s lock before paying', async () => {
    const chain = new FakeChain();
    const { executor, sent } = recordingExecutor(chain);
    const lock = new SerialLock();
    const gate = new PrefundGate({
      db: new RelayerDb(':memory:'),
      client: chain.client(),
      executor,
      budgets: PREFUND_BUDGETS,
      now: () => NOW_MS,
      log: { info: () => {}, warn: () => {} },
      lock,
    });

    // Something else (in production, a CCTP mint) holds the key.
    let release!: () => void;
    const held = lock.run(() => new Promise<void>((resolve) => (release = resolve)));

    const funding = gate.ensure(user.address, { prove: async () => true, purpose: 'deposit' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sent).toHaveLength(0); // still waiting on the other transaction

    release();
    await held;
    expect((await funding).kind).toBe('funded');
    expect(sent).toHaveLength(1);
  });
});

describe('what happens to a reservation when the payment itself fails', () => {
  it('a payment that could not be sent releases its reservation', async () => {
    const h = await harness({ behaviour: { send: 'throw' } });
    const body = await call(
      h.app,
      'eth_estimateUserOperationGas',
      await signedOp({ sender: user.address, signer: user, estimate: true }),
    );
    expect(body.error?.message).toBe('the EntryPoint top-up could not be sent');
    expect(h.db.prefundLedger().map((r) => r.status)).toEqual(['released']);
    expect(h.db.prefundUsage(user.address, NOW_MS).addressDay).toBe(0n);
  });

  it('a payment that reverted releases its reservation', async () => {
    const h = await harness({ behaviour: { receipt: 'reverted' } });
    await call(
      h.app,
      'eth_estimateUserOperationGas',
      await signedOp({ sender: user.address, signer: user, estimate: true }),
    );
    expect(h.db.prefundLedger().map((r) => r.status)).toEqual(['released']);
  });

  it('a payment sent without a receipt stays counted — it may still land', async () => {
    const h = await harness({ behaviour: { receipt: 'throw' } });
    const body = await call(
      h.app,
      'eth_estimateUserOperationGas',
      await signedOp({ sender: user.address, signer: user, estimate: true }),
    );
    expect(body.error?.message).toBe('the EntryPoint top-up has not confirmed yet');
    expect(h.db.prefundLedger().map((r) => r.status)).toEqual(['unconfirmed']);
    expect(h.db.prefundUsage(user.address, NOW_MS).addressDay).toBe(ENTRYPOINT_TOPUP_WEI);
  });

  it('a relayer that cannot afford it refuses without reserving', async () => {
    const h = await harness();
    h.chain.relayerBalance = 1n;
    const body = await call(
      h.app,
      'eth_estimateUserOperationGas',
      await signedOp({ sender: user.address, signer: user, estimate: true }),
    );
    expect(body.error?.message).toBe('relayer float is too low to top up');
    expect(h.db.prefundLedger()).toHaveLength(0);
  });
});

describe('RELAYER_PREFUND_MAX_MON parses the way .env.example ships it', () => {
  it('treats the blank value the example ships as unset, not as a refusal to boot', () => {
    // dotenv turns `KEY=` into ''. The same trap has already bitten the metrics token
    // and the private key in this schema.
    expect(relayerEnvSchema.parse({ RELAYER_PREFUND_MAX_MON: '' }).RELAYER_PREFUND_MAX_MON).toBe(
      undefined,
    );
    expect(relayerEnvSchema.parse({}).RELAYER_PREFUND_MAX_MON).toBeUndefined();
  });

  it('reads a decimal, and refuses zero or a value that rounds to zero wei', () => {
    expect(relayerEnvSchema.parse({ RELAYER_PREFUND_MAX_MON: '0.5' }).RELAYER_PREFUND_MAX_MON).toBe(
      0.5,
    );
    expect(() => relayerEnvSchema.parse({ RELAYER_PREFUND_MAX_MON: '0' })).toThrow();
    expect(() => relayerEnvSchema.parse({ RELAYER_PREFUND_MAX_MON: '-1' })).toThrow();
    expect(() => relayerEnvSchema.parse({ RELAYER_PREFUND_MAX_MON: '1e-12' })).toThrow();
  });
});

describe('the budget cannot be widened from the environment', () => {
  it('a lower RELAYER_PREFUND_MAX_MON tightens; a higher one is ignored', async () => {
    const tight = await harness({ configOverride: { prefundMaxMon: 1 } });
    const health = (await tight.app.inject({ method: 'GET', url: '/v1/health' })).json();
    expect(health.gasLayer.prefundBudgetsWei.perAddressDay).toBe(MON.toString());

    const loose = await harness({ configOverride: { prefundMaxMon: 50 } });
    const wide = (await loose.app.inject({ method: 'GET', url: '/v1/health' })).json();
    expect(wide.gasLayer.prefundBudgetsWei.perAddressDay).toBe(
      PREFUND_BUDGETS.perAddressDay.toString(),
    );
    expect(JSON.stringify(wide)).not.toMatch(/lifetime/i);
  });
});

describe('the ledger survives a restart', () => {
  it('a reopened database still counts what was spent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relayer-prefund-'));
    try {
      const path = join(dir, 'relayer.sqlite');
      const first = new RelayerDb(path);
      const r = first.reservePrefund({
        address: user.address,
        amountWei: ENTRYPOINT_TOPUP_WEI,
        purpose: 'deposit',
        budgets: PREFUND_BUDGETS,
        now: NOW_MS,
      });
      if (!r.ok) throw new Error('could not reserve');
      first.settlePrefund(r.id, 'paid', { now: NOW_MS });
      first.close();

      const second = new RelayerDb(path);
      expect(second.prefundUsage(user.address, NOW_MS).addressDay).toBe(ENTRYPOINT_TOPUP_WEI);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('F3: two processes on one ledger file cannot both spend the same room', () => {
  // Two connections stand in for two processes: node:sqlite is synchronous, so one
  // thread cannot interleave inside a reservation. What can be shown is that each sees
  // the other's committed reservations, and that a reservation never reads around a
  // write lock another connection holds. Together those are what keep the check and
  // the insert atomic across processes.
  it('a second connection sees the first one’s reservations and is refused past the budget', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relayer-two-conn-'));
    const path = join(dir, 'relayer.sqlite');
    const a = new RelayerDb(path);
    const b = new RelayerDb(path);
    try {
      const reserve = (db: RelayerDb, amountWei: bigint) =>
        db.reservePrefund({
          address: user.address,
          amountWei,
          purpose: 'deposit',
          budgets: PREFUND_BUDGETS,
          now: NOW_MS,
        });
      expect(reserve(a, ENTRYPOINT_TOPUP_WEI).ok).toBe(true); // 0.3 of the 0.5 hour
      expect(reserve(b, ENTRYPOINT_TOPUP_WEI).ok).toBe(false); // 0.3 more would exceed it
      expect(reserve(b, PREFUND_BUDGETS.perAddressHour - ENTRYPOINT_TOPUP_WEI).ok).toBe(true);
      expect(reserve(a, 1n).ok).toBe(false); // the hour is exactly spent, seen from either side
      expect(a.prefundUsage(user.address, NOW_MS).addressHour).toBe(PREFUND_BUDGETS.perAddressHour);
    } finally {
      a.close();
      b.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to reserve while another connection holds the write lock, and writes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relayer-locked-'));
    const path = join(dir, 'relayer.sqlite');
    const db = new RelayerDb(path);
    const other = new DatabaseSync(path);
    try {
      other.exec('BEGIN IMMEDIATE');
      expect(() =>
        db.reservePrefund({
          address: user.address,
          amountWei: ENTRYPOINT_TOPUP_WEI,
          purpose: 'deposit',
          budgets: PREFUND_BUDGETS,
          now: NOW_MS,
        }),
      ).toThrow(/locked|busy/i);
      other.exec('ROLLBACK');
      // Fail closed: nothing was reserved, so nothing could have been paid.
      expect(db.prefundLedger()).toHaveLength(0);
      // And the connection is usable again once the other lets go.
      expect(
        db.reservePrefund({
          address: user.address,
          amountWei: ENTRYPOINT_TOPUP_WEI,
          purpose: 'deposit',
          budgets: PREFUND_BUDGETS,
          now: NOW_MS,
        }).ok,
      ).toBe(true);
    } finally {
      other.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('2026-09-24: a top-up is due when the deposit cannot cover the operation’s own prefund', () => {
  /**
   * The batch floor the relayer's own estimate now hands out: 454,886 + 118,624 + 266,490
   * = 840,000 gas. At this suite's 204 gwei that is 0.17136 MON of prefund, above the old
   * 0.15 MON minimum, so a deposit between the two used to be left alone and meet AA21.
   */
  const BATCH_FLOOR_GAS = { call: 454_886n, verification: 118_624n, preVerification: 266_490n };
  const SIXTEEN_CENTS_OF_MON = 160_000_000_000_000_000n;

  it('depositNeeded: the minimum, the operation’s own prefund, or at most one top-up above the minimum', () => {
    expect(depositNeeded(undefined)).toBe(MIN_ENTRYPOINT_DEPOSIT_WEI);
    expect(depositNeeded(MIN_ENTRYPOINT_DEPOSIT_WEI - 1n)).toBe(MIN_ENTRYPOINT_DEPOSIT_WEI);
    expect(depositNeeded(171_360_000_000_000_000n)).toBe(171_360_000_000_000_000n);
    expect(depositNeeded(10n * MON)).toBe(MIN_ENTRYPOINT_DEPOSIT_WEI + ENTRYPOINT_TOPUP_WEI);
  });

  it('a signed send above its 0.16 MON deposit is topped up once, into the sender’s own deposit', async () => {
    const h = await harness();
    h.chain.deposits.set(user.address.toLowerCase(), SIXTEEN_CENTS_OF_MON);
    const body = await call(
      h.app,
      'eth_sendUserOperation',
      await signedOp({ sender: user.address, signer: user, estimate: false, gas: BATCH_FLOOR_GAS }),
    );
    expect(body.result).toBe('forwarded');
    expect(h.sent).toEqual([{ account: user.address, amount: ENTRYPOINT_TOPUP_WEI }]);
  });

  it('the same state with an operation that fits its deposit spends nothing', async () => {
    const h = await harness();
    h.chain.deposits.set(user.address.toLowerCase(), SIXTEEN_CENTS_OF_MON);
    await call(
      h.app,
      'eth_sendUserOperation',
      await signedOp({ sender: user.address, signer: user, estimate: false }),
    );
    expect(h.sent).toHaveLength(0);
  });

  it('a signature from someone else is still worth nothing, however large the prefund', async () => {
    const h = await harness();
    h.chain.deposits.set(user.address.toLowerCase(), SIXTEEN_CENTS_OF_MON);
    await call(
      h.app,
      'eth_sendUserOperation',
      await signedOp({ sender: user.address, signer: attacker, estimate: false, gas: BATCH_FLOOR_GAS }),
    );
    expect(h.sent).toHaveLength(0);
  });

  it('an enormous signed prefund is not chased past one top-up above the minimum', async () => {
    const h = await harness();
    h.chain.deposits.set(user.address.toLowerCase(), MIN_ENTRYPOINT_DEPOSIT_WEI + ENTRYPOINT_TOPUP_WEI);
    await call(
      h.app,
      'eth_sendUserOperation',
      await signedOp({
        sender: user.address,
        signer: user,
        estimate: false,
        gas: { call: 2_000_000n, verification: 118_624n, preVerification: 266_490n },
      }),
    );
    expect(h.sent).toHaveLength(0);
  });
});

describe('settling a reservation for less than was reserved', () => {
  it('lowers the counted amount, and refuses to raise it or make it negative', () => {
    const db = new RelayerDb(':memory:');
    const reserved = db.reservePrefund({
      address: user.address,
      amountWei: MON / 10n,
      purpose: 'deposit',
      budgets: PREFUND_BUDGETS,
      now: NOW_MS,
    });
    if (!reserved.ok) throw new Error('fixture could not reserve');
    expect(() => db.settlePrefund(reserved.id, 'paid', { amountWei: MON / 10n + 1n })).toThrow();
    expect(() => db.settlePrefund(reserved.id, 'paid', { amountWei: -1n })).toThrow();
    db.settlePrefund(reserved.id, 'paid', { amountWei: MON / 100n, now: NOW_MS });
    expect(db.prefundLedger(user.address)[0]?.amountWei).toBe(MON / 100n);
    expect(db.prefundUsage(user.address, NOW_MS).addressHour).toBe(MON / 100n);
  });

  it('the same for a self-bundle, whose loss counts in its own pool and no sponsorship budget', () => {
    const db = new RelayerDb(':memory:');
    const reserved = db.reserveSelfBundle({
      address: user.address,
      amountWei: MON / 10n,
      maxWorstCaseWei: MON,
      lossLimitWei: MON,
      maxInFlight: 8,
      relayerBalanceWei: 20n * MON,
      floatFloorWei: 4n * MON,
      now: NOW_MS,
    });
    if (!reserved.ok) throw new Error('fixture could not reserve');
    expect(() => db.settlePrefund(reserved.id, 'paid', { amountWei: MON / 10n + 1n })).toThrow();
    expect(() => db.settlePrefund(reserved.id, 'paid', { amountWei: -1n })).toThrow();
    db.settlePrefund(reserved.id, 'paid', { amountWei: MON / 100n, now: NOW_MS });
    expect(db.prefundLedger(user.address)[0]?.amountWei).toBe(MON / 100n);
    expect(db.selfBundleExposure(NOW_MS)).toBe(MON / 100n);
    const usage = db.prefundUsage(user.address, NOW_MS);
    expect([usage.addressHour, usage.addressDay, usage.allAddressesHour]).toEqual([0n, 0n, 0n]);
  });
});

describe('the self-bundle pool and the sponsorship budgets never share a row', () => {
  const bundle = (
    db: RelayerDb,
    overrides: Partial<Parameters<RelayerDb['reserveSelfBundle']>[0]> = {},
  ) =>
    db.reserveSelfBundle({
      address: user.address,
      amountWei: MON / 10n,
      maxWorstCaseWei: MON,
      lossLimitWei: MON / 10n,
      maxInFlight: 8,
      relayerBalanceWei: 20n * MON,
      floatFloorWei: 4n * MON,
      now: NOW_MS,
      ...overrides,
    });

  it('a sponsorship reservation cannot be written with the self-bundle purpose', () => {
    const db = new RelayerDb(':memory:');
    expect(() =>
      db.reservePrefund({
        address: user.address,
        amountWei: MON / 10n,
        purpose: 'self-bundle',
        budgets: PREFUND_BUDGETS,
        now: NOW_MS,
      }),
    ).toThrow(/reserveSelfBundle/);
    expect(db.prefundLedger()).toHaveLength(0);
  });

  it('a self-bundle reserves with the sponsorship budgets already spent, and leaves them as they were', () => {
    const db = new RelayerDb(':memory:');
    const spent = db.reservePrefund({
      address: user.address,
      amountWei: PREFUND_BUDGETS.perAddressHour,
      purpose: 'deposit',
      budgets: PREFUND_BUDGETS,
      now: NOW_MS,
    });
    if (!spent.ok) throw new Error('fixture could not reserve');
    db.settlePrefund(spent.id, 'paid', { now: NOW_MS });
    const before = db.prefundUsage(user.address, NOW_MS);
    expect(bundle(db).ok).toBe(true);
    expect(db.prefundUsage(user.address, NOW_MS)).toEqual(before);
  });

  it('refuses at the loss limit: losses plus unsettled worst cases', () => {
    const db = new RelayerDb(':memory:');
    const first = bundle(db, { amountWei: MON / 20n });
    if (!first.ok) throw new Error('first should reserve');
    db.settlePrefund(first.id, 'paid', { amountWei: MON / 20n, now: NOW_MS });
    expect(bundle(db, { amountWei: MON / 20n }).ok).toBe(true); // 0.05 < 0.1: may reserve
    const third = bundle(db);
    expect(third).toMatchObject({ ok: false, reason: 'loss-limit', exposureWei: MON / 10n });
  });

  it('refuses past maxInFlight unsettled bundles (8 here, whatever production uses), counting rows a stopped process left reserved', () => {
    const db = new RelayerDb(':memory:');
    for (let i = 0; i < 8; i += 1) {
      const r = bundle(db, { amountWei: 1n, lossLimitWei: MON });
      if (!r.ok) throw new Error(`bundle ${i + 1} should reserve`);
      // Half sent and unseen, half never moved past 'reserved'.
      if (i % 2 === 0) db.settlePrefund(r.id, 'unconfirmed', { txHash: `0x${i}`, now: NOW_MS });
    }
    expect(db.selfBundlesInFlight(NOW_MS)).toBe(8);
    expect(bundle(db, { amountWei: 1n, lossLimitWei: MON })).toMatchObject({
      ok: false,
      reason: 'in-flight',
      inFlight: 8,
    });
  });

  it('refuses a bundle that could take the float to the alert line, counting what is unsettled', () => {
    const db = new RelayerDb(':memory:');
    const worst = MON / 10n;
    // Exactly at the line: refused ("to or below"). One wei above it: reserved.
    expect(bundle(db, { relayerBalanceWei: 4n * MON + worst })).toMatchObject({
      ok: false,
      reason: 'float-floor',
    });
    const ok = bundle(db, { relayerBalanceWei: 4n * MON + worst + 1n });
    if (!ok.ok) throw new Error('one wei above the line should reserve');
    db.settlePrefund(ok.id, 'released', { now: NOW_MS });
    // An unconfirmed top-up may still leave the balance, so it is counted against it.
    const topUp = db.reservePrefund({
      address: attacker.address,
      amountWei: MON / 4n,
      purpose: 'deposit',
      budgets: PREFUND_BUDGETS,
      now: NOW_MS,
    });
    if (!topUp.ok) throw new Error('fixture could not reserve');
    db.settlePrefund(topUp.id, 'unconfirmed', { txHash: '0xfeed', now: NOW_MS });
    expect(bundle(db, { relayerBalanceWei: 4n * MON + worst + 1n })).toMatchObject({
      ok: false,
      reason: 'float-floor',
      unsettledWei: MON / 4n,
    });
    expect(bundle(db, { relayerBalanceWei: 4n * MON + worst + MON / 4n + 1n }).ok).toBe(true);
  });

  it('settles conditionally: a row already moved on is left as it is', () => {
    const db = new RelayerDb(':memory:');
    const r = bundle(db);
    if (!r.ok) throw new Error('should reserve');
    const sent = { txHash: '0xab', onlyFrom: ['reserved'] as const };
    const seen = { txHash: '0xab', onlyFrom: ['reserved', 'unconfirmed'] as const };
    expect(db.settlePrefund(r.id, 'unconfirmed', sent)).toBe(true);
    expect(db.settlePrefund(r.id, 'released', seen)).toBe(true);
    // A late timeout, or a second settlement, finds it released and changes nothing.
    expect(db.settlePrefund(r.id, 'unconfirmed', sent)).toBe(false);
    expect(db.settlePrefund(r.id, 'paid', seen)).toBe(false);
    expect(db.prefundRow(r.id)?.status).toBe('released');
  });
});

describe('R9 (2026-10-07): the background refill', () => {
  const gateFor = (chain: FakeChain, executor: TopUpExecutor, db = new RelayerDb(':memory:')) =>
    new PrefundGate({
      db,
      client: chain.client(),
      executor,
      budgets: PREFUND_BUDGETS,
      now: () => NOW_MS,
      log: { info: () => {}, warn: () => {} },
    });
  const burned = 90_000_000_000_000_000n; // 0.09 MON, a sponsored swap's measured burn

  it('puts back exactly what was burned, and no more', async () => {
    const chain = new FakeChain();
    chain.deposits.set(user.address.toLowerCase(), 200_000_000_000_000_000n);
    const { executor, sent } = recordingExecutor(chain);
    const outcome = await gateFor(chain, executor).refill(user.address, burned);
    expect(outcome.kind).toBe('funded');
    expect(sent).toEqual([{ account: user.address, amount: burned }]);
  });

  it('never past the refill line, however much was burned', async () => {
    const chain = new FakeChain();
    const deposit = REFILL_THRESHOLD_WEI - 10n ** 16n;
    chain.deposits.set(user.address.toLowerCase(), deposit);
    const { executor, sent } = recordingExecutor(chain);
    await gateFor(chain, executor).refill(user.address, burned);
    expect(sent).toEqual([{ account: user.address, amount: REFILL_THRESHOLD_WEI - deposit }]);
  });

  it('a deposit already at the line is not refilled', async () => {
    const chain = new FakeChain();
    chain.deposits.set(user.address.toLowerCase(), REFILL_THRESHOLD_WEI);
    const { executor, sent } = recordingExecutor(chain);
    expect((await gateFor(chain, executor).refill(user.address, burned)).kind).toBe('not-needed');
    expect(sent).toHaveLength(0);
  });

  it('one refill per address at a time: a second, while the first is outstanding, is skipped', async () => {
    const chain = new FakeChain();
    const { executor, sent } = recordingExecutor(chain);
    const gate = gateFor(chain, executor);
    const [a, b] = await Promise.all([gate.refill(user.address, burned), gate.refill(user.address, burned)]);
    expect([a.kind, b.kind].sort()).toEqual(['funded', 'skipped']);
    expect(sent).toHaveLength(1);
  });

  it('a spent hourly budget means no refill, and nothing throws or is refused to anyone', async () => {
    const chain = new FakeChain();
    const db = new RelayerDb(':memory:');
    const { executor, sent } = recordingExecutor(chain);
    const gate = gateFor(chain, executor, db);
    // Spend the address's whole hour on refills.
    for (let i = 0; i < 20 && sent.length < 20; i += 1) {
      chain.deposits.set(user.address.toLowerCase(), 0n);
      const out = await gate.refill(user.address, PREFUND_BUDGETS.perAddressHour);
      if (out.kind !== 'funded') break;
    }
    const before = sent.length;
    chain.deposits.set(user.address.toLowerCase(), 0n);
    const out = await gate.refill(user.address, burned);
    expect(out.kind === 'refused' || out.kind === 'forward-without-top-up').toBe(true);
    expect(sent).toHaveLength(before);
  });

  it('a refill never takes the shared hour below two top-ups: those are kept for users waiting on one', async () => {
    const chain = new FakeChain();
    const { executor, sent } = recordingExecutor(chain);
    const gate = new PrefundGate({
      db: new RelayerDb(':memory:'),
      client: chain.client(),
      executor,
      // The shared hour holds less than the reserve.
      budgets: { ...PREFUND_BUDGETS, allAddressesHour: 2n * ENTRYPOINT_TOPUP_WEI - 1n },
      now: () => NOW_MS,
      log: { info: () => {}, warn: () => {} },
    });
    expect((await gate.refill(user.address, burned)).kind).toBe('refused');
    expect(sent).toHaveLength(0);
  });

  it('a refill starting just above the reserve is cut to what keeps the shared hour at it', async () => {
    const chain = new FakeChain();
    const { executor, sent } = recordingExecutor(chain);
    // The smallest shared hour whose sponsored share sits just above the reserve.
    const reserve = 2n * ENTRYPOINT_TOPUP_WEI;
    let shared = reserve;
    while (nonExemptAllAddressesHour(shared) <= reserve) shared += 10n ** 15n;
    const above = nonExemptAllAddressesHour(shared) - reserve;
    expect(above).toBeLessThan(burned);
    const gate = new PrefundGate({
      db: new RelayerDb(':memory:'),
      client: chain.client(),
      executor,
      budgets: { ...PREFUND_BUDGETS, allAddressesHour: shared },
      now: () => NOW_MS,
      log: { info: () => {}, warn: () => {} },
    });
    expect((await gate.refill(user.address, burned)).kind).toBe('funded');
    expect(sent).toEqual([{ account: user.address, amount: above }]);
  });

  it('nothing burned, nothing refilled', async () => {
    const chain = new FakeChain();
    const { executor, sent } = recordingExecutor(chain);
    expect((await gateFor(chain, executor).refill(user.address, 0n)).kind).toBe('skipped');
    expect(sent).toHaveLength(0);
  });

  it('a send whose deposit covers its own signed prefund goes first; one that does not, tops up first', async () => {
    const chain = new FakeChain();
    const { executor, sent } = recordingExecutor(chain);
    const gate = gateFor(chain, executor);
    const prefund = 100_000_000_000_000_000n; // under the 0.15 minimum
    chain.deposits.set(user.address.toLowerCase(), prefund);
    const covered = await gate.ensure(user.address, {
      prove: async () => true,
      purpose: 'order',
      requiredPrefund: prefund,
      sendFirst: true,
    });
    expect(covered.kind).toBe('not-needed');
    expect(sent).toHaveLength(0);
    chain.deposits.set(user.address.toLowerCase(), prefund - 1n);
    const short = await gate.ensure(user.address, {
      prove: async () => true,
      purpose: 'order',
      requiredPrefund: prefund,
      sendFirst: true,
    });
    expect(short.kind).toBe('funded');
    expect(sent).toHaveLength(1);
  });

  it('a fee-paid send whose deposit covers its own signed prefund goes first too (D201, widened from sponsored-only)', async () => {
    const chain = new FakeChain();
    const { executor, sent } = recordingExecutor(chain);
    const gate = gateFor(chain, executor);
    const prefund = 100_000_000_000_000_000n;
    chain.deposits.set(user.address.toLowerCase(), prefund);
    const covered = await gate.ensure(user.address, {
      prove: async () => true,
      purpose: 'order',
      requiredPrefund: prefund,
      sendFirst: true,
      budgetScope: 'fee-paid',
    });
    expect(covered.kind).toBe('not-needed');
    expect(sent).toHaveLength(0);
  });

  it('a fee-paid send whose deposit falls short still tops up first, send-first or not', async () => {
    const chain = new FakeChain();
    const { executor, sent } = recordingExecutor(chain);
    const gate = gateFor(chain, executor);
    chain.deposits.set(user.address.toLowerCase(), 100_000_000_000_000_000n);
    const out = await gate.ensure(user.address, {
      prove: async () => true,
      purpose: 'order',
      requiredPrefund: 200_000_000_000_000_000n,
      sendFirst: true,
      budgetScope: 'fee-paid',
    });
    expect(out.kind).not.toBe('not-needed');
    expect(sent).toHaveLength(0);
  });

  it('send-first never applies to the exempt scope, even when the deposit covers the prefund', async () => {
    const chain = new FakeChain();
    const { executor, sent } = recordingExecutor(chain);
    const gate = gateFor(chain, executor);
    const prefund = 100_000_000_000_000_000n;
    chain.deposits.set(user.address.toLowerCase(), prefund);
    // `exemptDepositNeeded` is exactly `requiredPrefund` too (no floor above it, same as
    // fee-paid), so this covered deposit answers 'not-needed' regardless of `sendFirst` —
    // what this proves is narrower: `sendFirst`'s own scope gate still excludes 'exempt'
    // by name, so a future floor added to `exemptDepositNeeded` cannot silently start
    // relying on `sendFirst` to paper over it.
    const covered = await gate.ensure(user.address, {
      prove: async () => true,
      purpose: 'order',
      requiredPrefund: prefund,
      sendFirst: true,
      budgetScope: 'exempt',
    });
    expect(covered.kind).toBe('not-needed');
    expect(sent).toHaveLength(0);
  });
});
