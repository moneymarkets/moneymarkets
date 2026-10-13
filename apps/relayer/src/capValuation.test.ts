import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex, PublicClient } from 'viem';
import {
  buildLimitOrder,
  buildMarketOrder,
  configureLiveMarkets,
  decodeMarketParams,
  liveMarketsRefreshInFlight,
  resetLiveMarketsForTests,
} from '@tradepro/core';
import { buildServer } from './server.js';
import { TargetAllowlist } from './allowlist.js';
import { RelayerDb } from './db.js';
import type { RelayerConfig } from './config.js';
import type { TopUpExecutor } from './prefund.js';
// Recorded Kuru replies and recorded getMarketParams() tuples, the same harness core's own
// liveMarkets tests use, so the active set here is built from real answers.
import {
  EMO_MON,
  fakeChain,
  fakeKuru,
  MON_USDC,
  RECORDED_TUPLES,
} from '../../../packages/core/src/kuru/__fixtures__/liveMarketsHarness.js';

/**
 * `enforceHardCaps` end to end, through `/v1/sponsor`, for a market quoted in native MON.
 *
 * emo/MON is made active the way production makes it active — a `liveMarkets.ts` refresh
 * that finds it listed by Kuru and its params unchanged on chain — and the server's own
 * client answers `bestBidAsk()` with the touches read on chain 143 at block 107,310,277:
 * MON/USDC 0.025853 / 0.025869, emo/MON 0.031 with no ask.
 */

const MARGIN = '0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5' as Address;
const account = privateKeyToAccount(`0x${'55'.repeat(32)}` as Hex);
const NOW_MS = 1_756_800_000_000;

const MON_USDC_TOUCH = [25_853_000_000_000_000n, 25_869_000_000_000_000n] as const;
const EMO_MON_TOUCH = [31_000_000_000_000_000n, 0n] as const;

const emoMonParams = decodeMarketParams(RECORDED_TUPLES[EMO_MON] as never);
const monUsdcParams = decodeMarketParams(RECORDED_TUPLES[MON_USDC] as never);
const EMO_MON_ADDRESS = EMO_MON as Address;
const MON_USDC_ADDRESS = MON_USDC as Address;

const config: RelayerConfig = {
  mode: 'mainnet',
  realFundsAcknowledged: false,
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

const neverPays: TopUpExecutor = {
  relayerAddress: () => undefined,
  depositTo: async () => {
    throw new Error('capValuation.test must never pay a top-up');
  },
  waitForReceipt: async () => 'reverted',
};

/** Answers params and touches per address, and records every `bestBidAsk()` it is asked for. */
function chainClient(touches: Record<string, readonly [bigint, bigint] | 'revert'> = {}) {
  const touchReads: string[] = [];
  const client = {
    call: async () => ({ data: `0x${'0'.repeat(64)}` as Hex }),
    getBalance: async () => 0n,
    getBlockNumber: async () => 107_310_277n,
    readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
      const key = address.toLowerCase();
      if (functionName === 'getMarketParams') {
        const tuple = RECORDED_TUPLES[key];
        if (!tuple) throw new Error('execution reverted');
        return tuple;
      }
      if (functionName === 'bestBidAsk') {
        touchReads.push(key);
        const touch =
          touches[key] ??
          (key === MON_USDC ? MON_USDC_TOUCH : key === EMO_MON ? EMO_MON_TOUCH : 'revert');
        if (touch === 'revert') throw new Error('execution reverted');
        return touch;
      }
      return 0n;
    },
  } as unknown as PublicClient;
  return { client, touchReads };
}

async function server(touches?: Record<string, readonly [bigint, bigint] | 'revert'>) {
  const chain = chainClient(touches);
  const allowlist = new TargetAllowlist(undefined as never, 'mainnet');
  allowlist.seed([
    { address: MARGIN, kind: 'marginAccount', symbol: 'MarginAccount', trustsForwarder: true },
  ]);
  const app = await buildServer({
    config,
    gate: { mode: 'mainnet', runMode: 'dryrun', realFundsAcknowledged: false },
    client: chain.client,
    allowlist,
    db: new RelayerDb(':memory:'),
    now: () => NOW_MS,
    topUpExecutor: neverPays,
  });
  return { app, touchReads: chain.touchReads };
}

const sponsor = (to: Address, data: Hex) => ({
  method: 'POST' as const,
  url: '/v1/sponsor',
  payload: { sender: account.address, calls: [{ to, data }], purpose: 'order' as const },
});

const emo = (n: bigint) => n * 10n ** 18n;

beforeEach(async () => {
  process.env.LOG_LEVEL = 'silent';
  resetLiveMarketsForTests();
  configureLiveMarkets({ client: fakeChain().client, fetchImpl: fakeKuru().fetchImpl });
  await liveMarketsRefreshInFlight();
});

afterEach(() => resetLiveMarketsForTests());

describe('/v1/sponsor values an emo/MON order in dollars before the cap', () => {
  it('sponsors 200 emo at 0.031 (6.2 MON, $0.16), reading the MON/USDC touch to value it', async () => {
    const { app, touchReads } = await server();
    const order = buildLimitOrder({
      market: EMO_MON_ADDRESS,
      params: emoMonParams,
      side: 'buy',
      priceWire: EMO_MON_TOUCH[0],
      sizeBase: emo(200n),
    });
    const res = await app.inject(sponsor(EMO_MON_ADDRESS, order.data));
    expect(res.json().code).toBe('SUBMIT_GAS_LAYER_UNPROVEN');
    expect(res.json().policy).toBe('ok');
    expect(touchReads).toContain(MON_USDC);
    await app.close();
  });

  it('sponsors 10,000 emo at 0.025 (250 MON, $6.47), which the $6 cap refused', async () => {
    const { app, touchReads } = await server();
    const order = buildLimitOrder({
      market: EMO_MON_ADDRESS,
      params: emoMonParams,
      side: 'buy',
      priceWire: 25_000_000_000_000_000n,
      sizeBase: emo(10_000n),
    });
    const res = await app.inject(sponsor(EMO_MON_ADDRESS, order.data));
    expect(res.json().code).toBe('SUBMIT_GAS_LAYER_UNPROVEN');
    expect(res.json().policy).toBe('ok');
    expect(touchReads).toContain(MON_USDC);
    await app.close();
  });

  it('refuses 1,600,000 emo at 0.025 (40,000 MON, $1,034.44) with 403 CAP_EXCEEDED', async () => {
    const { app } = await server();
    const order = buildLimitOrder({
      market: EMO_MON_ADDRESS,
      params: emoMonParams,
      side: 'buy',
      priceWire: 25_000_000_000_000_000n,
      sizeBase: emo(1_600_000n),
    });
    const res = await app.inject(sponsor(EMO_MON_ADDRESS, order.data));
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('CAP_EXCEEDED');
    expect(res.json().message).toMatch(/exceeds the hard cap/);
    await app.close();
  });

  it('sponsors a 200 emo market sell, valued at emo/MON’s bid and then the MON/USDC mid', async () => {
    const { app, touchReads } = await server();
    const sell = buildMarketOrder({
      market: EMO_MON_ADDRESS,
      params: emoMonParams,
      side: 'sell',
      amount: emo(200n),
      minAmountOut: 0n,
    });
    const res = await app.inject(sponsor(EMO_MON_ADDRESS, sell.data));
    expect(res.json().policy).toBe('ok');
    expect(new Set(touchReads)).toEqual(new Set([EMO_MON, MON_USDC]));
    await app.close();
  });

  it('refuses an emo/MON order, however small, when MON/USDC has no ask to take a mid from', async () => {
    const { app } = await server({ [MON_USDC]: [MON_USDC_TOUCH[0], 0n] });
    const buy = buildMarketOrder({
      market: EMO_MON_ADDRESS,
      params: emoMonParams,
      side: 'buy',
      amount: 10n ** 18n,
      minAmountOut: 0n,
    });
    const res = await app.inject(sponsor(EMO_MON_ADDRESS, buy.data));
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('CAP_EXCEEDED');
    expect(res.json().message).toMatch(/no usable mid/);
    await app.close();
  });

  it('refuses an emo/MON order when the MON/USDC read fails', async () => {
    const { app } = await server({ [MON_USDC]: 'revert' });
    const buy = buildMarketOrder({
      market: EMO_MON_ADDRESS,
      params: emoMonParams,
      side: 'buy',
      amount: 10n ** 18n,
      minAmountOut: 0n,
    });
    const res = await app.inject(sponsor(EMO_MON_ADDRESS, buy.data));
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('CAP_EXCEEDED');
    await app.close();
  });
});

describe('/v1/sponsor on a USDC-quoted market is unchanged', () => {
  it('sponsors a $3 MON/USDC market buy without reading any price', async () => {
    const { app, touchReads } = await server();
    const buy = buildMarketOrder({
      market: MON_USDC_ADDRESS,
      params: monUsdcParams,
      side: 'buy',
      amount: 3_000_000n,
      minAmountOut: 0n,
    });
    const res = await app.inject(sponsor(MON_USDC_ADDRESS, buy.data));
    expect(res.json().policy).toBe('ok');
    expect(touchReads).toEqual([]);
    await app.close();
  });

  it('sponsors a $1,000.00 MON/USDC market buy, exactly at the cap', async () => {
    const { app } = await server();
    const buy = buildMarketOrder({
      market: MON_USDC_ADDRESS,
      params: monUsdcParams,
      side: 'buy',
      amount: 1_000_000_000n,
      minAmountOut: 0n,
    });
    const res = await app.inject(sponsor(MON_USDC_ADDRESS, buy.data));
    expect(res.json().policy).toBe('ok');
    await app.close();
  });

  it('refuses a $1,000.000001 MON/USDC market buy', async () => {
    const { app } = await server();
    const buy = buildMarketOrder({
      market: MON_USDC_ADDRESS,
      params: monUsdcParams,
      side: 'buy',
      amount: 1_000_000_001n,
      minAmountOut: 0n,
    });
    const res = await app.inject(sponsor(MON_USDC_ADDRESS, buy.data));
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('CAP_EXCEEDED');
    await app.close();
  });
});
