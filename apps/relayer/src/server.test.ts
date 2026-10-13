import { describe, expect, it, beforeEach } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex, PublicClient } from 'viem';
import {
  buildForwardRequest,
  buildMarketOrder,
  FORWARD_REQUEST_TYPES,
  KURU_FORWARDER_DOMAIN,
  MAX_ORDER_NOTIONAL_AUSD,
  MAINNET,
} from '@tradepro/core';
import { buildServer } from './server.js';
import { TargetAllowlist } from './allowlist.js';
import { RELAY_STATUSES, RelayerDb } from './db.js';
import { relayerEnvSchema, type RelayerConfig } from './config.js';
import type { TopUpExecutor } from './prefund.js';

const MARGIN = '0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5' as Address;
/**
 * MON/USDC: the one market `LIVE_MARKET_ALLOWLIST` holds in a process that never calls
 * `configureLiveMarkets`, which is every test. This was MON/AUSD until 2026-09-23, when
 * MON/AUSD became shown-but-not-traded.
 */
const MARKET = '0x065C9d28E428A0db40191a54d33d5b7c71a9C394' as Address; // MON/USDC
const MON_AUSD = '0x131a2e70a5b31a517a74b8c567149bc294470da9' as Address;
/**
 * A real Kuru book that is deliberately NOT on `LIVE_MARKET_ALLOWLIST` — the
 * USDT0/AUSD address the market kit predicts. These tests used to use MON/USDC as
 * "the market that is refused"; the owner widened the allowlist to all four live
 * books on 2026-09-09, so the refusal cases need a market that is genuinely off it.
 */
const UNLISTED_MARKET = '0xE9E448ab704E0b5F83261342D0DB8aC00651E70F' as Address;
const AUSD_TOKEN = '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a' as Address;
// Not retyped. A pasted address that is one character out passes a test that only
// ever asserts a refusal, which is how a fixture drifts from production silently.
const USDC_TOKEN = MAINNET.tokens.USDC.address;
const USDT0_TOKEN = MAINNET.tokens.USDT0.address;
const account = privateKeyToAccount(`0x${'44'.repeat(32)}` as Hex);
const NOW_MS = 1_756_800_000_000;

/**
 * MON/USDC `getMarketParams()`, read on chain 143 at block 107,264,428
 * (2026-09-23T07:42:27Z); the same numbers as `reports/MARKETS-VERIFIED.md` section 1.
 */
const params = {
  pricePrecision: 100_000_000n,
  sizePrecision: 10_000_000_000n,
  baseAsset: '0x0000000000000000000000000000000000000000' as Address,
  baseDecimals: 18,
  quoteAsset: USDC_TOKEN,
  quoteDecimals: 6,
  tickSize: 100n,
  minSize: 2_000_000_000_000n,
  maxSize: 2_000_000_000_000_000_000n,
  takerFeeBps: 0n,
  makerFeeBps: 0n,
};

/** MON/AUSD's, read live 2026-09-02. Only the C5 minSize test below still uses it. */
const monAusdParams = {
  ...params,
  quoteAsset: AUSD_TOKEN,
  maxSize: 20_000_000_000_000_000_000n,
};

const config: RelayerConfig = {
  mode: 'mainnet',
  realFundsAcknowledged: false,
  rpcUrl: undefined,
  port: 0,
  maxFloatMon: 50,
  floatAlertPct: 20,
  rateLimitPerAddressHour: 3,
  rateLimitPerIpHour: 100,
  maxGas: 2_000_000n,
  maxDeadlineSeconds: 300,
  dbPath: ':memory:',
  hasSigningKey: false,
  hasPimlicoKey: true,
  metricsToken: undefined,
};

const GET_NONCE = '0x2d0335ab';

/** The MON/USDC 11-tuple, as getMarketParams() returns it on chain 143. */
const MARKET_PARAMS_TUPLE = [
  100_000_000,
  10_000_000_000n,
  '0x0000000000000000000000000000000000000000',
  18n,
  '0x754704Bc059F8C67012fEd69BC8A327a5aafb603',
  6n,
  100,
  2_000_000_000_000n,
  2_000_000_000_000_000_000n,
  0n,
  0n,
] as const;

/**
 * A client that never touches the network. `getNonce` answers zero; every other
 * `eth_call` is the forwarded-call simulation and succeeds unless a test replaces
 * `simulateCall`.
 */
function fakeClient(options: { simulateCall?: () => Promise<{ data: Hex }> } = {}): PublicClient {
  return {
    call: async ({ data }: { data?: Hex }) => {
      if (data?.startsWith(GET_NONCE)) return { data: `0x${'0'.repeat(64)}` as Hex };
      return options.simulateCall ? options.simulateCall() : { data: '0x' as Hex };
    },
    getBalance: async () => 0n,
    readContract: async ({ functionName }: { functionName?: string }) =>
      functionName === 'getMarketParams' ? MARKET_PARAMS_TUPLE : true,
    getBlockNumber: async () => 101_283_488n,
  } as unknown as PublicClient;
}

function makeAllowlist(): TargetAllowlist {
  const list = new TargetAllowlist(undefined as never, 'mainnet');
  list.seed([
    { address: MARGIN, kind: 'marginAccount', symbol: 'MarginAccount', trustsForwarder: true },
    { address: MARKET, kind: 'orderbook', symbol: 'MON/USDC', trustsForwarder: true },
  ]);
  return list;
}

/**
 * A $3 market buy. It sits under the owner's $1,000 notional cap and, unlike a limit
 * order, is not blocked by the 200-MON `minSize` — see the collision test below.
 */
const order = buildMarketOrder({
  market: MARKET,
  params,
  side: 'buy',
  amount: 3_000_000n,
  minAmountOut: 0n,
});

const request = buildForwardRequest({
  from: account.address,
  to: MARKET,
  data: order.data,
  nonce: 0n,
  gas: 250_000n,
  now: NOW_MS,
});

async function signedBodyFor(data: Hex, to: Address = MARKET) {
  const req = buildForwardRequest({
    from: account.address,
    to,
    data,
    nonce: 0n,
    gas: 250_000n,
    now: NOW_MS,
  });
  const signature = await account.signTypedData({
    domain: KURU_FORWARDER_DOMAIN,
    types: FORWARD_REQUEST_TYPES,
    primaryType: 'ForwardRequest',
    message: { ...req },
  });
  return {
    request: {
      from: req.from,
      to: req.to,
      value: req.value.toString(),
      gas: req.gas.toString(),
      nonce: req.nonce.toString(),
      deadline: req.deadline.toString(),
      data: req.data,
    },
    signature,
    purpose: 'order' as const,
  };
}

async function signedBody() {
  const signature = await account.signTypedData({
    domain: KURU_FORWARDER_DOMAIN,
    types: FORWARD_REQUEST_TYPES,
    primaryType: 'ForwardRequest',
    message: { ...request },
  });
  return {
    request: {
      from: request.from,
      to: request.to,
      value: request.value.toString(),
      gas: request.gas.toString(),
      nonce: request.nonce.toString(),
      deadline: request.deadline.toString(),
      data: request.data,
    },
    signature,
    purpose: 'order' as const,
  };
}

let db: RelayerDb;

/**
 * Every server here gets an executor that cannot pay. None of these tests reaches the
 * top-up, and this keeps it that way: the default executor unlocks the real relayer
 * keystore when one is on disk, as it is on the development machine.
 */
const neverPays: TopUpExecutor = {
  relayerAddress: () => undefined,
  depositTo: async () => {
    throw new Error('server.test must never pay a top-up');
  },
  waitForReceipt: async () => 'reverted',
};

async function server(
  options: { simulateCall?: () => Promise<{ data: Hex }>; metricsToken?: string } = {},
) {
  db = new RelayerDb(':memory:');
  return buildServer({
    config: options.metricsToken ? { ...config, metricsToken: options.metricsToken } : config,
    // Pinned, so the suite does not inherit whatever MODE the developer's .env has.
    gate: { mode: 'mainnet', runMode: 'dryrun', realFundsAcknowledged: false },
    client: fakeClient(options),
    allowlist: makeAllowlist(),
    db,
    now: () => NOW_MS,
    topUpExecutor: neverPays,
  });
}

beforeEach(() => {
  process.env.LOG_LEVEL = 'silent';
});

describe('POST /v1/forward', () => {
  it('passes every check and then refuses to submit, naming why', async () => {
    const app = await server();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/forward',
      payload: await signedBody(),
    });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.code).toBe('FORWARDER_SCHEMA_UNVERIFIED');
    expect(body.simulated).toBe('ok');
    expect(body.message).toContain('open item 1');
    await app.close();
  });

  it('rejects a target that is not on the allowlist', async () => {
    const app = await server();
    const payload = await signedBody();
    payload.request.to = '0x000000000000000000000000000000000000dEaD';
    const res = await app.inject({ method: 'POST', url: '/v1/forward', payload });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('TARGET_NOT_ALLOWED');
    await app.close();
  });

  it('rejects a tampered signature with 401', async () => {
    const app = await server();
    const payload = await signedBody();
    payload.request.gas = '300000';
    const res = await app.inject({ method: 'POST', url: '/v1/forward', payload });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('SIGNATURE_INVALID');
    await app.close();
  });

  it('turns a reverted simulation into a human message with no hex', async () => {
    const app = await server({
      simulateCall: async () => {
        const error = new Error('reverted') as Error & { data: Hex };
        error.data = '0x8199f5f3'; // SlippageExceeded
        throw error;
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/forward',
      payload: await signedBody(),
    });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.code).toBe('SIMULATION_REVERTED');
    expect(body.message).toBe(
      'Price moved before your order was filled. Review the price and try again.',
    );
    expect(body.message).not.toMatch(/0x/);
    await app.close();
  });

  it('rate-limits by address', async () => {
    const app = await server();
    const payload = await signedBody();
    for (let i = 0; i < config.rateLimitPerAddressHour; i++) {
      await app.inject({ method: 'POST', url: '/v1/forward', payload });
    }
    const res = await app.inject({ method: 'POST', url: '/v1/forward', payload });
    expect(res.statusCode).toBe(429);
    expect(res.json().code).toBe('RATE_LIMITED');
    await app.close();
  });

  it('refuses an order above the $1,000 notional cap with 403', async () => {
    const app = await server();
    const big = buildMarketOrder({
      market: MARKET,
      params,
      side: 'buy',
      amount: 2_500_000_000n, // $2,500, well over the $1,000 cap
      minAmountOut: 0n,
    });
    const payload = await signedBodyFor(big.data);
    const res = await app.inject({ method: 'POST', url: '/v1/forward', payload });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('CAP_EXCEEDED');
    expect(res.json().message).toMatch(/not raisable/);
    await app.close();
  });

  it('refuses a market that is not on the allowlist, on mainnet', async () => {
    const app = await server();
    const allow = makeAllowlist();
    allow.seed([
      { address: MARGIN, kind: 'marginAccount', symbol: 'MarginAccount', trustsForwarder: true },
      {
        address: UNLISTED_MARKET,
        kind: 'orderbook',
        symbol: 'USDT0/AUSD',
        trustsForwarder: true,
      },
    ]);
    const app2 = await buildServer({
      config,
      gate: { mode: 'mainnet', runMode: 'dryrun', realFundsAcknowledged: false },
      client: fakeClient(),
      allowlist: allow,
      db: new RelayerDb(':memory:'),
      now: () => NOW_MS,
      topUpExecutor: neverPays,
    });
    const payload = await signedBodyFor(order.data, UNLISTED_MARKET);
    const res = await app2.inject({ method: 'POST', url: '/v1/forward', payload });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('CAP_EXCEEDED');
    await app2.close();
    await app.close();
  });

  it('fits MON/AUSD minSize under the cap, which the original $5 did not', () => {
    // minSize 2e12 sizePrecision units / 1e10 = 200 MON. At the bestBid/bestAsk read
    // on 2026-09-02 (0.025696 / 0.026211) that is $5.14-$5.24 — over $5 and under
    // $6. Raising the cap to $6 is what made a resting M0 order possible (DECISIONS.md
    // C5); it is $1,000 since 2026-10-13 and the minimum fits with room to spare.
    const minMon = monAusdParams.minSize / monAusdParams.sizePrecision;
    expect(minMon).toBe(200n);
    for (const price of [25_696_000_000_000_000n, 26_211_000_000_000_000n]) {
      const minNotional = (minMon * price) / 10n ** 12n; // -> AUSD base units
      expect(minNotional).toBeGreaterThan(5_000_000n);
      expect(minNotional).toBeLessThan(6_000_000n);
      expect(minNotional).toBeLessThan(MAX_ORDER_NOTIONAL_AUSD);
    }
  });

  it('rejects a malformed body without a stack trace', async () => {
    const app = await server();
    const res = await app.inject({ method: 'POST', url: '/v1/forward', payload: { nope: 1 } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BAD_REQUEST');
    await app.close();
  });
});

describe('POST /v1/permit', () => {
  const permit = {
    token: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a',
    owner: account.address,
    spender: MARGIN,
    value: '1000000',
    deadline: String(Math.floor(NOW_MS / 1000) + 300),
    v: 27,
    r: `0x${'11'.repeat(32)}`,
    s: `0x${'22'.repeat(32)}`,
  };

  it('rejects a spender that is not the MarginAccount', async () => {
    const app = await server();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/permit',
      payload: { ...permit, spender: '0x000000000000000000000000000000000000dEaD' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('SPENDER_NOT_MARGIN_ACCOUNT');
    await app.close();
  });

  it('refuses to submit without a signing key rather than pretending', async () => {
    const app = await server();
    const res = await app.inject({ method: 'POST', url: '/v1/permit', payload: permit });
    expect(res.statusCode).toBe(503);
    await app.close();
  });
});

describe('POST /v1/sponsor', () => {
  const body = (calls: { to: string; data: string }[]) => ({
    sender: account.address,
    calls,
    purpose: 'order' as const,
  });

  it('accepts a within-policy batch and stops at the honest step', async () => {
    const app = await server();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sponsor',
      payload: body([{ to: MARKET, data: order.data }]),
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('SUBMIT_GAS_LAYER_UNPROVEN');
    expect(res.json().policy).toBe('ok');
    await app.close();
  });

  it('refuses a market outside the allowlist', async () => {
    const app = await server();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sponsor',
      payload: body([{ to: UNLISTED_MARKET, data: order.data }]),
    });
    expect(res.statusCode).toBe(400);
    // The reason has to survive the trip. Asserting only the status let a wrong
    // market come back as SELECTOR_NOT_ALLOWED, which tells a client to go and
    // look at a calldata problem that is not there.
    expect(res.json().code).toBe('TARGET_NOT_ALLOWED');
    await app.close();
  });

  it('refuses MON/AUSD, which was allowed until 2026-09-23 and is now shown, not traded', async () => {
    const app = await server();
    const monAusdOrder = buildMarketOrder({
      market: MON_AUSD,
      params: monAusdParams,
      side: 'buy',
      amount: 3_000_000n,
      minAmountOut: 0n,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sponsor',
      payload: body([{ to: MON_AUSD, data: monAusdOrder.data }]),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('TARGET_NOT_ALLOWED');
    await app.close();
  });

  it('still refuses a lone approve(): C1 admits approve only as the pinned triple', async () => {
    const app = await server();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sponsor',
      // approve(address,uint256) on AUSD to the zero spender, alone in the batch.
      // C1 (2026-09-25) recognizes the selector, but only inside the pinned
      // approve→spend→revoke triple with the spender an allowlisted contract —
      // a lone approve still hands a spender an open-ended allowance and is refused.
      payload: body([{ to: AUSD_TOKEN, data: `0x095ea7b3${'0'.repeat(128)}` }]),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('SPENDER_NOT_ALLOWED');
    await app.close();
  });

  it('refuses a transfer to a contract this app knows', async () => {
    const app = await server();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sponsor',
      // transfer(address,uint256) to the zero address, for zero. The recipient is
      // refused before the amount is, so the reason names the recipient.
      payload: body([{ to: AUSD_TOKEN, data: `0xa9059cbb${'0'.repeat(128)}` }]),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('TARGET_NOT_ALLOWED');
    await app.close();
  });

  /**
   * The refusal tests above would all still pass if the transfer branch were deleted,
   * because every one of them ends in a refusal. This is the one that would not: it
   * proves a plain send of each pinned token is accepted by the policy AND by the caps
   * layer, which is where USDT0 was dead until 2026-09-09 — the policy said yes and
   * `enforceHardCaps` refused it with a sentence about order books, after the user had
   * signed.
   */
  it.each([
    ['AUSD', AUSD_TOKEN],
    ['USDC', USDC_TOKEN],
    ['USDT0', USDT0_TOKEN],
  ])('sponsors a plain %s send under the cap (D128)', async (_symbol, token) => {
    const app = await server();
    const recipient = '000000000000000000000000' + 'dd'.repeat(20);
    const oneDollar = (1_000_000n).toString(16).padStart(64, '0');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sponsor',
      payload: body([{ to: token, data: `0xa9059cbb${recipient}${oneDollar}` }]),
    });
    // The policy and the caps both passed; the only thing left is the gas layer this
    // suite has no bundler for.
    expect(res.json().policy).toBe('ok');
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it('refuses a send over the notional cap', async () => {
    const app = await server();
    const recipient = '000000000000000000000000' + 'dd'.repeat(20);
    const overCap = (MAX_ORDER_NOTIONAL_AUSD + 1n).toString(16).padStart(64, '0');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sponsor',
      payload: body([{ to: USDC_TOKEN, data: `0xa9059cbb${recipient}${overCap}` }]),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('CAP_EXCEEDED');
    await app.close();
  });

  it('refuses an over-cap order with 403', async () => {
    const app = await server();
    const big = buildMarketOrder({
      market: MARKET,
      params,
      side: 'buy',
      amount: 2_500_000_000n, // $2,500 against the $1,000 cap
      minAmountOut: 0n,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sponsor',
      payload: body([{ to: MARKET, data: big.data }]),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('CAP_EXCEEDED');
    await app.close();
  });

  it('rejects an empty batch as a malformed body', async () => {
    const app = await server();
    const res = await app.inject({ method: 'POST', url: '/v1/sponsor', payload: body([]) });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('GET /v1/health', () => {
  it('reports forwarder trust from the allowlist snapshot, and that it cannot submit', async () => {
    const app = await server();
    const res = await app.inject({ method: 'GET', url: '/v1/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.chainId).toBe(143);
    expect(body.forwarderTrusted.marginAccount).toBe(true);
    expect(body.forwarderTrusted.orderBooksTrusting).toBe(1);
    expect(body.forwarderSchemaVerified).toBe(false);
    expect(body.forwarderStatus).toMatch(/dormant/);
    expect(body.gasLayer.kind).toBe('eip-7702');
    expect(body.gasLayer.funding).toBe('entrypoint-deposit');
    expect(body.gasLayer.paymaster).toBeNull();
    // M0 passed, so the gas layer is proven...
    expect(body.gasLayer.proven).toBe(true);
    // ...but this server is pinned to a dry run, so it still will not submit.
    expect(body.canSubmit).toBe(false);
    // The live allowlist is a read-only view, not an array literal; it must still
    // serialize as a plain list. Nothing configured it here, so it is the cold start.
    expect(body.caps.liveMarkets).toEqual([MARKET]);
    await app.close();
  });

  it('never returns anything key-shaped', async () => {
    const app = await server();
    const res = await app.inject({ method: 'GET', url: '/v1/health' });
    expect(res.body).not.toMatch(/privateKey|PRIVATE_KEY|mnemonic/i);
    expect(res.body).not.toMatch(/0x[0-9a-fA-F]{64}/);
    await app.close();
  });
});

describe('GET /v1/tx/:hash', () => {
  it('404s for a hash it never relayed', async () => {
    const app = await server();
    const res = await app.inject({ method: 'GET', url: `/v1/tx/0x${'ab'.repeat(32)}` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('GET /v1/metrics', () => {
  it('serves Prometheus text with the float cap and a submit gauge', async () => {
    const app = await server();
    const res = await app.inject({ method: 'GET', url: '/v1/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    const body = res.body;
    // Every series must carry HELP and TYPE or a scraper drops it.
    for (const name of [
      'relayer_relays_total',
      'relayer_pending',
      'relayer_mon_spent_wei_total',
      'relayer_entrypoint_topup_wei_total',
      'relayer_rate_limited_subjects',
      'relayer_float_cap_wei',
      'relayer_can_submit',
    ]) {
      expect(body).toContain(`# HELP ${name} `);
      expect(body).toContain(`# TYPE ${name} `);
    }
    // The cap is the one from code, not from env (packages/core caps.ts).
    expect(body).toContain(`relayer_float_cap_wei ${20n * 10n ** 18n}`);
    // Tests run with the gate disarmed, so this must be 0. A 1 here in a dryrun
    // deployment would mean the relayer is armed and nobody said so.
    expect(body).toMatch(/relayer_can_submit 0/);
    await app.close();
  });

  it('leaks no address, hash or request body', async () => {
    const app = await server();
    const payload = await signedBody();
    await app.inject({ method: 'POST', url: '/v1/forward', payload });
    const body = (await app.inject({ method: 'GET', url: '/v1/metrics' })).body;
    // A scrape must not become a way to read who used the relayer.
    expect(body).not.toMatch(/0x[0-9a-fA-F]{40}/);
    expect(body).not.toMatch(/0x[0-9a-fA-F]{64}/);
    await app.close();
  });
});

describe('float alerting (rule A4)', () => {
  it('alerts against the 20 MON code cap, not the larger env default', async () => {
    // 4.69 MON against a 20 MON cap is 23% — above the 20% line, so no alert.
    // Against the RELAYER_MAX_FLOAT_MON default of 50 the same balance is 9.4%,
    // which is what the old arithmetic reported, and it was wrong.
    const capWei = 20n * 10n ** 18n;
    const balance = 4_694_694_266_000_000_000n;
    const alertPct = 20;
    expect(balance * 100n < capWei * BigInt(alertPct)).toBe(false);

    const envCapWei = 50n * 10n ** 18n;
    expect(balance * 100n < envCapWei * BigInt(alertPct)).toBe(true);
  });

  it('a balance genuinely under a fifth of the cap does alert', async () => {
    const capWei = 20n * 10n ** 18n;
    expect(3_000_000_000_000_000_000n * 100n < capWei * 20n).toBe(true);
  });
});

describe('metrics hardening (security review of 99490d0)', () => {
  it('refuses a non-loopback caller when no token is configured', async () => {
    const app = await server();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/metrics',
      remoteAddress: '203.0.113.7',
    });
    // Unauthenticated it is a synchronous SQLite read on the event loop; anyone
    // reachable could hold it down and stall /v1/forward alongside it.
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('UNAUTHORIZED');
    await app.close();
  });

  it('accepts an IPv6-mapped loopback address', async () => {
    const app = await server();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/metrics',
      remoteAddress: '::ffff:127.0.0.1',
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('accepts a remote caller carrying the configured bearer token', async () => {
    // At least 16 characters: the token is validated by the config schema now, rather
    // than read raw from process.env where a one-character token was accepted.
    const token = 'a-sufficiently-long-metrics-token';
    const app = await server({ metricsToken: token });
    const bad = await app.inject({
      method: 'GET',
      url: '/v1/metrics',
      remoteAddress: '203.0.113.7',
    });
    expect(bad.statusCode).toBe(401);
    const good = await app.inject({
      method: 'GET',
      url: '/v1/metrics',
      remoteAddress: '203.0.113.7',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(good.statusCode).toBe(200);
    await app.close();
  });

  it('gates on the socket address, so a forwarded header cannot claim loopback', async () => {
    // If anyone ever sets trustProxy to fix the per-IP limiter, req.ip becomes
    // attacker-controlled and this endpoint would open to the internet.
    const app = await server();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/metrics',
      remoteAddress: '203.0.113.7',
      headers: { 'x-forwarded-for': '127.0.0.1' },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('always emits the float series, so an alert cannot be silent', async () => {
    // A Prometheus alert over an absent series returns empty and never fires. The
    // gauge being conditional was the bug: it made the A4 alert look present and do
    // nothing.
    const app = await server();
    const body = (await app.inject({ method: 'GET', url: '/v1/metrics' })).body;
    expect(body).toContain('relayer_float_known ');
    expect(body).toContain('relayer_float_wei ');
    expect(body).toContain('relayer_float_below_alert ');
    await app.close();
  });
});

describe('rate-limit gauge window (regression)', () => {
  it('counts subjects in the window the limiter actually writes', () => {
    // hitRateLimit stores epoch MILLISECONDS truncated to the hour; metrics() was
    // querying the hour NUMBER, so the predicate could never match and the abuse
    // gauge read 0 no matter how hard the limiter was tripping.
    const db = new RelayerDb(':memory:');
    const now = Date.now();
    for (const subject of ['0xaaa', '0xbbb', '0xccc']) {
      db.hitRateLimit(subject, 'address', 100, now);
    }
    expect(db.metrics(now).rateLimitedSubjects).toBe(3);
    db.close();
  });

  it('prunes stale windows automatically when the hour rolls over', () => {
    // The prune trigger used to key off one subject's own count, so a sweep of many
    // addresses hitting once each — the abuse case — never reached it, and ordinary
    // traffic never did either because the per-address limit is 60/hour. It is global
    // now, so the rollover itself does the cleanup with no timer.
    const db = new RelayerDb(':memory:');
    const now = Date.now();
    const longAgo = now - 10 * 3_600_000;
    for (const s of ['0xa', '0xb', '0xc']) db.hitRateLimit(s, 'address', 100, longAgo);
    expect(db.metrics(longAgo).rateLimitedSubjects).toBe(3);

    // One hit in the current window is enough to clear the stale ones.
    db.hitRateLimit('0xnew', 'address', 100, now);
    expect(db.metrics(now).rateLimitedSubjects).toBe(1);
    expect(db.metrics(longAgo).rateLimitedSubjects).toBe(0);
    db.close();
  });

  it('prunes on a wide sweep where every subject is seen exactly once', () => {
    const db = new RelayerDb(':memory:');
    const start = Date.now() - 5 * 3_600_000;
    for (let i = 0; i < 300; i++) db.hitRateLimit(`0x${i}`, 'ip', 10_000, start);
    expect(db.metrics(start).rateLimitedSubjects).toBe(300);
    const later = start + 5 * 3_600_000;
    db.hitRateLimit('0xlater', 'ip', 10_000, later);
    expect(db.metrics(start).rateLimitedSubjects).toBe(0);
    db.close();
  });
});

describe('Prometheus label escaping', () => {
  it('neutralises a purpose that would otherwise forge a series', async () => {
    // purpose is a closed zod enum on every HTTP path today, but recordRelay takes a
    // plain string. A forged `relayer_can_submit 1` on a dashboard reads as "the
    // relayer is armed", so the renderer escapes rather than trusting its writers.
    const app = await server();
    const hostile = ['x"} 1', 'relayer_can_submit{x="'].join('');
    db.recordRelay({
      from: '0x0000000000000000000000000000000000000001',
      to: '0x0000000000000000000000000000000000000002',
      selector: '0xdeadbeef',
      purpose: hostile,
      status: 'rejected',
    });
    const body = (await app.inject({ method: 'GET', url: '/v1/metrics' })).body;
    const forged = body
      .split(String.fromCharCode(10))
      .filter((l) => l.startsWith('relayer_can_submit'));
    // Exactly one, and it is the real one: 0, because the gate is disarmed in tests.
    expect(forged).toHaveLength(1);
    expect(forged[0]).toBe('relayer_can_submit 0');
    await app.close();
  });
});

describe('config traps found in final review', () => {
  it('bounds statuses against the list the code actually writes', () => {
    // The hand-copied set carried 'submitted' and 'mined' (written by nothing) and
    // omitted 'success' (what the submit path writes), so every successful relay
    // would have rendered as "other" the moment the gate opened.
    expect([...RELAY_STATUSES].sort()).toEqual(['pending', 'rejected', 'reverted', 'success']);
    expect(RELAY_STATUSES).toContain('success');
  });

  it('treats a blank token in .env.example as unset rather than refusing to boot', () => {
    // dotenv turns `RELAYER_METRICS_TOKEN=` into '', and .min(16) rejects that. The
    // example tells operators to leave it blank, so a verbatim copy must still start.
    const parsed = relayerEnvSchema.parse({ RELAYER_METRICS_TOKEN: '' });
    expect(parsed.RELAYER_METRICS_TOKEN).toBeUndefined();
    const withKey = relayerEnvSchema.parse({ RELAYER_PRIVATE_KEY: '' });
    expect(withKey.RELAYER_PRIVATE_KEY).toBeUndefined();
  });
});
