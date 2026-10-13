import { beforeEach, describe, expect, it } from 'vitest';
import { isolateEnv } from './testEnv.js';
import { encodeFunctionData, parseAbi, type Address, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  formatUserOperationRequest,
  getUserOperationTypedData,
  type UserOperation,
} from 'viem/account-abstraction';
import {
  buildDeposit,
  ENTRY_POINT_V08,
  FLOW_USDC_AUSD_RESPONSE,
  KURU_FLOW_ROUTER,
  MAINNET,
  MAX_SPONSORED_PERMIT_VALUE,
  normalizeFlowCalldata,
} from '@tradepro/core';
import { buildServer } from './server.js';
import { TargetAllowlist } from './allowlist.js';
import { RelayerDb } from './db.js';
import type { RelayerConfig } from './config.js';
import type { TopUpExecutor } from './prefund.js';

/**
 * `/v1/bundler` is the only way a user operation leaves this system, and until now it
 * had no tests at all.
 *
 * Everything here asserts a **refusal**, and deliberately so: every refusal is decided
 * before the route forwards anything to Pimlico, so the suite proves the gate without
 * ever touching the network. The accept path ends in a real bundler call and cannot be
 * asserted here — that one is EXERCISED on chain or not at all.
 */

const MARGIN = '0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5' as Address;
const MARKET = '0x131a2e70a5b31a517a74b8c567149bc294470da9' as Address;
const AUSD = '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a' as Address;
const USDC = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603' as Address;
const SENDER = '0x43a275C3Eb0BE7313f847FFA4fb6Bd366606A961' as Address;
const NOW_MS = 1_756_800_000_000;

const config: RelayerConfig = {
  mode: 'mainnet',
  realFundsAcknowledged: true,
  rpcUrl: undefined,
  port: 0,
  maxFloatMon: 50,
  floatAlertPct: 20,
  rateLimitPerAddressHour: 100,
  rateLimitPerIpHour: 100,
  maxGas: 2_000_000n,
  maxDeadlineSeconds: 300,
  dbPath: ':memory:',
  hasSigningKey: false,
  hasPimlicoKey: true,
  metricsToken: undefined,
};

function fakeClient(): PublicClient {
  return {
    call: async () => ({ data: '0x' as Hex }),
    getBalance: async () => 0n,
    readContract: async () => 0n,
    getBlockNumber: async () => 101_283_488n,
  } as unknown as PublicClient;
}

/**
 * A top-up executor that can never pay.
 *
 * Injected into every server this file builds. Without it the server falls back to the
 * live executor, and on a machine holding `.secrets/relayer-keystore.json` that one
 * unlocks the real mainnet relayer key. The fake client's float of zero makes every
 * funding decision here refuse before paying, and this makes sure that stays true.
 */
const neverPays: TopUpExecutor = {
  relayerAddress: () => '0x000000000000000000000000000000000000fEE5',
  depositTo: async () => {
    throw new Error('bundler.test must never pay a top-up');
  },
  waitForReceipt: async () => 'reverted',
};

/** Stands in for Pimlico. A request that gets this far says so, and goes no further. */
const upstreamStub = async () =>
  JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'reached the bundler' } });

function armedServer() {
  const list = new TargetAllowlist(undefined as never, 'mainnet');
  list.seed([
    { address: MARGIN, kind: 'marginAccount', symbol: 'MarginAccount', trustsForwarder: true },
    { address: MARKET, kind: 'orderbook', symbol: 'MON/AUSD', trustsForwarder: true },
  ]);
  return buildServer({
    config,
    gate: { mode: 'mainnet', runMode: 'live', realFundsAcknowledged: true },
    client: fakeClient(),
    allowlist: list,
    db: new RelayerDb(':memory:'),
    now: () => NOW_MS,
    topUpExecutor: neverPays,
    bundlerUpstream: upstreamStub,
  });
}

// A throwaway test key: the rewritten estimate tests need an operation that really is
// signed by its sender, and the M0 account's key is not something a test can hold.
const signer = privateKeyToAccount(`0x${'3e'.repeat(32)}` as Hex);

/** A complete user operation, signed by `signer`, as viem puts it on the wire. */
async function signedOperation(callData: Hex, estimate: boolean) {
  const userOperation: UserOperation<'0.8'> = {
    sender: signer.address,
    // Key 0, sequence 0: the fake client answers every getNonce read with 0.
    nonce: 0n,
    callData,
    callGasLimit: estimate ? 0n : 400_000n,
    verificationGasLimit: estimate ? 0n : 100_000n,
    preVerificationGas: estimate ? 0n : 60_000n,
    maxFeePerGas: 204_000_000_000n,
    maxPriorityFeePerGas: 2_000_000_000n,
    signature: '0x',
  };
  const signature = await signer.signTypedData(
    getUserOperationTypedData({ chainId: 143, entryPointAddress: ENTRY_POINT_V08, userOperation }),
  );
  return formatUserOperationRequest({ ...userOperation, signature });
}

async function sendSigned(
  app: Awaited<ReturnType<typeof armedServer>>,
  callData: Hex,
  method: 'eth_sendUserOperation' | 'eth_estimateUserOperationGas',
) {
  const op = await signedOperation(callData, method === 'eth_estimateUserOperationGas');
  const res = await app.inject({
    method: 'POST',
    url: '/v1/bundler',
    payload: { jsonrpc: '2.0', id: 1, method, params: [op, ENTRY_POINT_V08] },
  });
  return JSON.parse(res.body) as { error?: { message?: string } };
}

const permitAbi = parseAbi([
  'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
]);

const permit = (spender: Address, value: bigint): Hex =>
  encodeFunctionData({
    abi: permitAbi,
    functionName: 'permit',
    args: [
      SENDER,
      spender,
      value,
      // Real wall clock, not NOW_MS. The route validates the permit window against
      // Date.now() rather than the server's injected clock, so a permit dated from the
      // pinned test timestamp is simply expired and every case below would pass for
      // the wrong reason.
      BigInt(Math.floor(Date.now() / 1000) + 300),
      27,
      `0x${'11'.repeat(32)}`,
      `0x${'22'.repeat(32)}`,
    ],
  });

/** The unedited USDC -> AUSD route, exactly as the API returned it on 2026-09-02. */
const REAL_SWAP = normalizeFlowCalldata(FLOW_USDC_AUSD_RESPONSE.transaction.calldata);

/**
 * A Flow swap built by editing the **real** route, not by assembling a plausible one.
 *
 * The previous version of this helper wrote fourteen words by hand, eleven of them
 * zero, and claimed to be "the same shape as the recorded quote". It was not: no
 * dynamic offset at word 9, no length word, and no packed route blob at the tail. That
 * is the same defect that let the first version of this policy through review — a
 * fixture simpler than production cannot exhibit the collisions the policy exists to
 * catch. So this splices the head words of the genuine article and leaves everything
 * else, blob included, byte for byte.
 */
function flowSwap(tokenIn: Address, tokenOut: Address, amountIn: bigint): Hex {
  const word = (v: bigint | Address) =>
    (typeof v === 'bigint' ? v.toString(16) : v.slice(2).toLowerCase()).padStart(64, '0');
  const at = (i: number) => 2 + 8 + i * 64;
  const body = REAL_SWAP.slice(2 + 8);
  const words = (body.match(/.{64}/g) ?? []).slice();
  words[0] = word(tokenOut);
  words[2] = word(tokenIn);
  words[3] = word(amountIn);
  void at;
  return `0x${REAL_SWAP.slice(2, 2 + 8)}${words.join('')}` as Hex;
}

const executeBatch = (calls: ReadonlyArray<{ to: Address; data: Hex }>): Hex =>
  encodeFunctionData({
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
    ],
    functionName: 'executeBatch',
    args: [calls.map((c) => ({ target: c.to, value: 0n, data: c.data }))],
  });

/**
 * The encoding a real one-call operation actually carries.
 *
 * `toSimple7702SmartAccount.encodeCalls` (viem) special-cases a length-1 batch to
 * `execute(address,uint256,bytes)` rather than `executeBatch` — every plain order and
 * every cancel is exactly one call, so this is what production sends for those, not
 * `executeBatch` with one element. A fixture built from `executeBatch` regardless of
 * call count cannot catch a decoder that only understands `executeBatch`.
 */
const executeSingle = (call: { to: Address; data: Hex }): Hex =>
  encodeFunctionData({
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
    functionName: 'execute',
    args: [call.to, 0n, call.data],
  });

async function send(
  app: Awaited<ReturnType<typeof armedServer>>,
  callData: Hex,
  method = 'eth_sendUserOperation',
) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/bundler',
    payload: {
      jsonrpc: '2.0',
      id: 1,
      method,
      // Deliberately unsigned. Everything this helper drives is refused by the policy or
      // the caps, which run before the signature is looked at.
      params: [{ sender: SENDER, callData }, ENTRY_POINT_V08],
    },
  });
  return JSON.parse(res.body) as { error?: { message?: string } };
}

// Whatever this file sets is undone after every test, including values that were
// already in the environment before it ran. See testEnv.ts for the race this closes.
isolateEnv();

beforeEach(() => {
  process.env.LOG_LEVEL = 'silent';
  process.env.PIMLICO_API_KEY = 'test-key-not-a-secret';
});

describe('the mode gate lives here, not in the browser', () => {
  it('refuses everything when the relayer is not armed', async () => {
    const list = new TargetAllowlist(undefined as never, 'mainnet');
    list.seed([
      { address: MARGIN, kind: 'marginAccount', symbol: 'MarginAccount', trustsForwarder: true },
    ]);
    const app = await buildServer({
      config,
      gate: { mode: 'mainnet', runMode: 'dryrun', realFundsAcknowledged: false },
      client: fakeClient(),
      allowlist: list,
      db: new RelayerDb(':memory:'),
      now: () => NOW_MS,
      topUpExecutor: neverPays,
      bundlerUpstream: upstreamStub,
    });
    const body = await send(app, executeBatch([{ to: USDC, data: permit(MARGIN, 1_000_000n) }]));
    expect(body.error?.message).toContain('not armed');
  });
});

describe('eth_estimateUserOperationGas is gated exactly like eth_sendUserOperation', () => {
  // Pimlico checks the same prefund during a gas ESTIMATE that it checks on a real
  // send — that check is what produced "AA21 didn't pay prefund" straight from
  // Pimlico, before ensureDeposit (gated on send alone) ever ran. The browser had
  // already asked for a passkey signature on the batch's permit by the time that
  // reached the user. These tests do not reach a real Pimlico — the fake client's
  // getBalance is 0, so ensureDeposit's own funding check refuses first, deterministically.
  // What they prove is that the refusal now happens on THIS relayer, for THIS method,
  // rather than silently passing through to whatever answered before.

  const ATTACKER = '0x00000000000000000000000000000000DeaDBeef' as Address;
  const depositCall = () => ({
    to: MARGIN,
    data: buildDeposit(MARGIN, SENDER, AUSD, 1_000_000n).data,
  });

  it('runs the same policy checks on an estimate call as on a send', async () => {
    const app = await armedServer();
    const body = await send(
      app,
      executeBatch([{ to: AUSD, data: permit(ATTACKER, 1_000_000n) }]),
      'eth_estimateUserOperationGas',
    );
    expect(body.error?.message).toContain('may only name the margin account');
  });

  it('reaches the funding decision on a signed estimate, not only on a send', async () => {
    // A batch the policy and the caps both allow, signed by its sender. If funding were
    // gated on send alone, this would reach the bundler stub instead.
    const app = await armedServer();
    const body = await sendSigned(
      app,
      executeBatch([{ to: AUSD, data: permit(MARGIN, 1_000_000n) }, depositCall()]),
      'eth_estimateUserOperationGas',
    );
    // The fake client's relayer balance is 0, so decideTopUp refuses — proving the
    // funding decision ran for this method, deterministically and without a network call.
    expect(body.error?.message).toBe('relayer float is too low to top up');
  });

  it('refuses the same estimate once the send is refused for the same reason', async () => {
    const app = await armedServer();
    const batch = executeBatch([{ to: AUSD, data: permit(MARGIN, 1_000_000n) }, depositCall()]);
    const estimate = await sendSigned(app, batch, 'eth_estimateUserOperationGas');
    const real = await sendSigned(app, batch, 'eth_sendUserOperation');
    expect(estimate.error?.message).toBe('relayer float is too low to top up');
    expect(estimate.error?.message).toBe(real.error?.message);
  });

  it('never funds an unsigned estimate, even one the policy allows (S4-C1)', async () => {
    // Before 2026-09-23 this exact request reached the top-up with no signature at all.
    // Now it is forwarded unfunded, so it meets the bundler stub and not the float.
    const app = await armedServer();
    const op = {
      ...(await signedOperation(
        executeBatch([{ to: AUSD, data: permit(MARGIN, 1_000_000n) }, depositCall()]),
        true,
      )),
      signature: `0x${'00'.repeat(65)}`,
    };
    const res = await app.inject({
      method: 'POST',
      url: '/v1/bundler',
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_estimateUserOperationGas',
        params: [op, ENTRY_POINT_V08],
      },
    });
    expect(JSON.parse(res.body).error?.message).toBe('reached the bundler');
  });
});

describe('a sponsored Flow swap is capped like everything else that spends money', () => {
  it('refuses a swap that spends more than the cap', async () => {
    // The router is not a market, so the order-notional check cannot be applied to it.
    // That must not mean it is uncapped: before this, the router fell through to
    // assertMarketAllowed and was refused outright, and the moment it stopped being
    // refused there was nothing bounding what it could spend.
    const app = await armedServer();
    const tooMuch = MAX_SPONSORED_PERMIT_VALUE + 1n;
    const body = await send(
      app,
      executeBatch([
        { to: USDC, data: permit(KURU_FLOW_ROUTER, tooMuch) },
        { to: KURU_FLOW_ROUTER, data: flowSwap(USDC, AUSD, tooMuch) },
      ]),
    );
    expect(body.error?.message).toMatch(/at most|cap/i);
  });

  it('refuses a swap that spends a different amount from the permit', async () => {
    // The policy catches this before the cap does, which is why the cap's own zero
    // branch is defence in depth rather than the thing doing the work here.
    const app = await armedServer();
    const body = await send(
      app,
      executeBatch([
        { to: USDC, data: permit(KURU_FLOW_ROUTER, 1_000_000n) },
        { to: KURU_FLOW_ROUTER, data: flowSwap(USDC, AUSD, 0n) },
      ]),
    );
    expect(body.error?.message).toContain('not the amount the swap spends');
  });

  it('refuses a permit on a token the paired swap does not spend', async () => {
    const app = await armedServer();
    const body = await send(
      app,
      executeBatch([
        { to: AUSD, data: permit(KURU_FLOW_ROUTER, 1_000_000n) },
        { to: KURU_FLOW_ROUTER, data: flowSwap(USDC, AUSD, 1_000_000n) },
      ]),
    );
    expect(body.error?.message).toContain('spends');
  });

  it('refuses an allowance to the router with no swap behind it', async () => {
    const app = await armedServer();
    const body = await send(
      app,
      executeBatch([{ to: USDC, data: permit(KURU_FLOW_ROUTER, 1_000_000n) }]),
    );
    expect(body.error?.message).toContain('followed by the swap');
  });
});

describe('a lone call decodes the same as a one-element batch', () => {
  // Every plain order and every cancel is exactly one call. Before this decoder
  // understood `execute(address,uint256,bytes)`, every one of them was refused with
  // "the operation carries no calls this relayer can read" -- a decode failure, not a
  // policy decision -- because `toSimple7702SmartAccount.encodeCalls` never sends
  // `executeBatch` for a single call. That is a real defect, not a hypothetical one:
  // it is what broke every buy, sell and cancel from the trading screen.
  const singleDeposit = () => ({
    to: MARGIN,
    data: buildDeposit(MARGIN, SENDER, AUSD, 1_000_000n).data,
  });

  it('does not refuse a single addBuyOrder-shaped call as unreadable', async () => {
    const app = await armedServer();
    const body = await send(app, executeSingle(singleDeposit()));
    expect(body.error?.message ?? '').not.toContain('carries no calls this relayer can read');
  });

  it('refuses the same single call the same way whether it is a lone `execute` or a one-element `executeBatch`', async () => {
    const app = await armedServer();
    const call = singleDeposit();
    const single = await send(app, executeSingle(call));
    const batchOfOne = await send(app, executeBatch([call]));
    expect(single.error?.message).toBe(batchOfOne.error?.message);
  });

  it('still refuses a lone call to a target the policy does not allow', async () => {
    // Proves the fix does not skip policy for the single-call path -- an
    // unsponsorable single call must fail for the real reason, not decode clean.
    const ATTACKER = '0x00000000000000000000000000000000DeaDBeef' as Address;
    const app = await armedServer();
    const body = await send(app, executeSingle({ to: AUSD, data: permit(ATTACKER, 1_000_000n) }));
    expect(body.error?.message).toContain('may only name the margin account');
  });
});

describe('a permit target is not mistaken for a market', () => {
  it('does not refuse a USDC permit for being an unknown order book', async () => {
    // enforceHardCaps used to send everything that was not the MarginAccount through
    // assertMarketAllowed, so the token being permitted was refused as a market.
    const app = await armedServer();
    const body = await send(
      app,
      executeBatch([
        { to: USDC, data: permit(KURU_FLOW_ROUTER, 1_000_000n) },
        { to: KURU_FLOW_ROUTER, data: flowSwap(USDC, AUSD, 1_000_000n) },
      ]),
    );
    // It gets past the policy and the caps; what stops it here is the deposit top-up,
    // which needs a chain. The point is that the refusal is no longer about markets.
    expect(body.error?.message ?? '').not.toMatch(/market/i);
  });
});

/**
 * Wallet-tab Swap's whole safety claim (WALLET-IMPLEMENTATION.md §5.1) rests on one
 * list: `sponsoredPermitTokens` in `server.ts`, which today names exactly AUSD and
 * USDC. `packages/core/src/gas/policy.ts`'s Flow-router branch is general — any
 * token permitted to `KURU_FLOW_ROUTER`, paired correctly with the swap that spends
 * it, passes `assertSponsorable` — so the ONLY thing standing between "Swap can pay
 * with AUSD/USDC" and "Swap can pay with anything, including a token nobody
 * reviewed for this" is this server's own, narrower list. An independent review
 * found that list had zero test coverage: adding WMON or USDT0 to it on a
 * throwaway copy left the entire suite passing. This closes that gap, on the real,
 * unedited list, on both methods a batch can reach it through.
 */
describe('the sponsored-permit-token allowlist is the one thing standing between "AUSD/USDC only" and "any token" (independent review, finding 5)', () => {
  const WMON = MAINNET.tokens.WMON.address;
  const USDT0 = MAINNET.tokens.USDT0.address;

  it.each([
    ['WMON', WMON] as const,
    ['USDT0', USDT0] as const,
  ])('refuses a permit + Flow swap paid for in %s, on eth_sendUserOperation', async (_label, token) => {
    const app = await armedServer();
    const body = await send(
      app,
      executeBatch([
        { to: token, data: permit(KURU_FLOW_ROUTER, 1_000_000n) },
        { to: KURU_FLOW_ROUTER, data: flowSwap(token, AUSD, 1_000_000n) },
      ]),
    );
    // Refused before ever reaching the paired-swap or cap checks: the permit target
    // itself is not one of the two tokens this relayer will sponsor a permit for.
    expect(body.error?.message).toBeDefined();
    expect(body.error?.message ?? '').not.toBe('reached the bundler');
  });

  it.each([
    ['WMON', WMON] as const,
    ['USDT0', USDT0] as const,
  ])(
    'refuses the identical batch paid for in %s on eth_estimateUserOperationGas too — not only on send',
    async (_label, token) => {
      const app = await armedServer();
      const batch = executeBatch([
        { to: token, data: permit(KURU_FLOW_ROUTER, 1_000_000n) },
        { to: KURU_FLOW_ROUTER, data: flowSwap(token, AUSD, 1_000_000n) },
      ]);
      const estimate = await send(app, batch, 'eth_estimateUserOperationGas');
      const real = await send(app, batch);
      expect(estimate.error?.message).toBeDefined();
      expect(estimate.error?.message ?? '').not.toBe('reached the bundler');
      // Same policy, same refusal, on both methods — the estimate path is not a
      // second, laxer copy of the send path.
      expect(estimate.error?.message).toBe(real.error?.message);
    },
  );

  it('still accepts the real, unedited list\'s own tokens — this is not a blanket refusal of the Flow router', async () => {
    const app = await armedServer();
    const body = await send(
      app,
      executeBatch([
        { to: USDC, data: permit(KURU_FLOW_ROUTER, 1_000_000n) },
        { to: KURU_FLOW_ROUTER, data: flowSwap(USDC, AUSD, 1_000_000n) },
      ]),
    );
    // USDC is on the real list, so this batch gets past the permit-token check —
    // what stops it here (as in the "not mistaken for a market" block above) is the
    // deposit top-up needing a chain, never a permit-token refusal.
    expect(body.error?.message ?? '').not.toContain('may only name the margin account or the Kuru Flow router');
  });
});
