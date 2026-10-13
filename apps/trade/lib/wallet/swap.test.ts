import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { getAddress, type Address, type Hex } from 'viem';
import type * as CoreModule from '@tradepro/core';
import type * as TicketModule from '../ticket';
import type * as GasModule from './gasCharge';
import type { SwapRoute } from './swapPlan';
import kyberUsdcToWmon from '../../../../packages/core/src/swap/__fixtures__/kyberBuild.usdcToWmon.fixture.json';
import kyberWmonToUsdc from '../../../../packages/core/src/swap/__fixtures__/kyberBuild.wmonToUsdc.fixture.json';

const freshPasskey = vi.fn(async (_opts: { rpId: string; credentialId?: string }) => {});
vi.mock('@tradepro/core', async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  return { ...actual, assertFreshPasskey: freshPasskey };
});

// `run()` drives the real bundler transport over the network; ordering is what this
// file tests, so a stub proves nothing was signed or sent before every gate passed.
const runSpy = vi.fn(async (_opts: unknown) => ({ state: 'CONFIRMED' as const }));
vi.mock('../ticket', async (importOriginal) => {
  const actual = await importOriginal<typeof TicketModule>();
  return { ...actual, run: runSpy };
});

const planSpy = vi.fn(async (_input: unknown): Promise<GasModule.FeeLegPlan> => ({ kind: 'sponsored' }));
vi.mock('./gasCharge', async (importOriginal) => {
  const actual = await importOriginal<typeof GasModule>();
  return { ...actual, planFeeLeg: planSpy };
});

const { FLOW_QUOTE_AMOUNT_IN, FLOW_USDC_AUSD_RESPONSE, KURU_FLOW_ROUTER, KYBER_ROUTER, MAINNET, normalizeFlowCalldata } =
  await import('@tradepro/core');
const { swap, withStepTimeout, SWAP_STEP_TIMEOUT_MESSAGES, sponsorWouldAcceptSwap } = await import('./swap');
const { buildSwapBatch, NATIVE_MON, WMON, maxNativeSpend } = await import('./swapPlan');

/** Every calldata here is a real recorded vendor response (R3): Kuru Flow USDC to AUSD
 *  (core fixture, 2026-09-02) and KyberSwap USDC to WMON / WMON to USDC (2026-09-29,
 *  reports/SWAP-VERIFY.md), both built for the acceptance account below. */
const TAKER = getAddress('0x670269f8bD8c326a96Fb5c557Cce606F47BcF59f');
const MARGIN = MAINNET.kuru.marginAccount as Address;
const USDC = MAINNET.tokens.USDC.address;
const AUSD = MAINNET.tokens.AUSD.address;

const flowRoute: SwapRoute = {
  vendor: 'kuru-flow',
  displayName: 'Kuru Flow',
  to: getAddress(FLOW_USDC_AUSD_RESPONSE.transaction.to),
  data: normalizeFlowCalldata(FLOW_USDC_AUSD_RESPONSE.transaction.calldata),
  tokenIn: USDC,
  tokenOut: AUSD,
  amountIn: FLOW_QUOTE_AMOUNT_IN,
  expectedOut: BigInt(FLOW_USDC_AUSD_RESPONSE.output),
  minOut: BigInt(FLOW_USDC_AUSD_RESPONSE.minOut),
};

const kyberToWmon: SwapRoute = {
  vendor: 'kyberswap',
  displayName: 'KyberSwap',
  to: KYBER_ROUTER,
  data: kyberUsdcToWmon.data.data as Hex,
  tokenIn: USDC,
  tokenOut: WMON,
  amountIn: 500_000n,
  expectedOut: BigInt(kyberUsdcToWmon.data.amountOut),
  minOut: (BigInt(kyberUsdcToWmon.data.amountOut) * 9950n) / 10000n,
};

const kyberFromWmon: SwapRoute = {
  vendor: 'kyberswap',
  displayName: 'KyberSwap',
  to: KYBER_ROUTER,
  data: kyberWmonToUsdc.data.data as Hex,
  tokenIn: WMON,
  tokenOut: USDC,
  amountIn: 100_000_000_000_000_000n,
  expectedOut: BigInt(kyberWmonToUsdc.data.amountOut),
  minOut: (BigInt(kyberWmonToUsdc.data.amountOut) * 9950n) / 10000n,
};

const selector = (data: Hex) => data.slice(0, 10).toLowerCase();

describe('the batch for every swap shape (rule 1.8), and the relayer accepts each', () => {
  it('KyberSwap from the wallet: approve exact, the swap, approve zero', () => {
    const calls = buildSwapBatch({
      kind: 'aggregated',
      marginAccount: MARGIN,
      payToken: USDC,
      amountIn: 500_000n,
      source: 'wallet',
      route: kyberToWmon,
    });
    expect(calls.map((c) => [c.to, selector(c.data)])).toEqual([
      [USDC, '0x095ea7b3'],
      [KYBER_ROUTER, '0xe21fd0e9'],
      [USDC, '0x095ea7b3'],
    ]);
    expect(sponsorWouldAcceptSwap(MARGIN, USDC, TAKER, calls)).toBe(true);
  });

  it('never pays KyberSwap by permit', () => {
    expect(() =>
      buildSwapBatch({
        kind: 'aggregated',
        marginAccount: MARGIN,
        payToken: USDC,
        amountIn: 500_000n,
        source: 'wallet',
        route: kyberToWmon,
        allowance: { kind: 'permit', call: { to: USDC, data: '0xd505accf' } },
      }),
    ).toThrow(/Kuru Flow only/);
  });

  it('to native MON: the swap delivers WMON and the batch unwraps exactly the minimum', () => {
    const calls = buildSwapBatch({
      kind: 'aggregated',
      marginAccount: MARGIN,
      payToken: USDC,
      amountIn: 500_000n,
      source: 'wallet',
      route: kyberToWmon,
      deliverNative: true,
    });
    const last = calls[calls.length - 1]!;
    expect(last.to).toBe(WMON);
    expect(last.data).toBe(`0x2e1a7d4d${kyberToWmon.minOut.toString(16).padStart(64, '0')}`);
    expect(sponsorWouldAcceptSwap(MARGIN, USDC, TAKER, calls)).toBe(true);
  });

  it('MON input: WMON.deposit of exactly the amount first, then the WMON triple', () => {
    const calls = buildSwapBatch({
      kind: 'aggregated',
      marginAccount: MARGIN,
      payToken: NATIVE_MON,
      amountIn: kyberFromWmon.amountIn,
      source: 'wallet',
      route: kyberFromWmon,
    });
    expect(calls[0]).toEqual({ to: WMON, data: '0xd0e30db0', value: kyberFromWmon.amountIn });
    expect(calls.slice(1).map((c) => [c.to, selector(c.data)])).toEqual([
      [WMON, '0x095ea7b3'],
      [KYBER_ROUTER, '0xe21fd0e9'],
      [WMON, '0x095ea7b3'],
    ]);
    expect(sponsorWouldAcceptSwap(MARGIN, WMON, TAKER, calls)).toBe(true);
  });

  it('MON to WMON and WMON to MON call the wrapper and no aggregator, from either balance', () => {
    const wrap = buildSwapBatch({ kind: 'wrap', marginAccount: MARGIN, payToken: NATIVE_MON, amountIn: 7n, source: 'wallet' });
    expect(wrap).toEqual([{ to: WMON, data: '0xd0e30db0', value: 7n }]);
    const unwrap = buildSwapBatch({ kind: 'unwrap', marginAccount: MARGIN, payToken: WMON, amountIn: 7n, source: 'wallet' });
    expect(unwrap.map((c) => [c.to, selector(c.data)])).toEqual([[WMON, '0x2e1a7d4d']]);
    const tradingUnwrap = buildSwapBatch({
      kind: 'unwrap',
      marginAccount: MARGIN,
      payToken: WMON,
      amountIn: 7n,
      source: 'trading',
    });
    expect(tradingUnwrap.map((c) => [c.to, selector(c.data)])).toEqual([
      [MARGIN, '0x00f714ce'],
      [WMON, '0x2e1a7d4d'],
    ]);
    for (const calls of [wrap, unwrap, tradingUnwrap]) {
      for (const c of calls) expect([KYBER_ROUTER, KURU_FLOW_ROUTER]).not.toContain(c.to);
      expect(sponsorWouldAcceptSwap(MARGIN, WMON, TAKER, calls)).toBe(true);
    }
  });

  it('refuses a route for a different amount or token than the screen', () => {
    const base = { kind: 'aggregated' as const, marginAccount: MARGIN, source: 'wallet' as const, route: kyberToWmon };
    expect(() => buildSwapBatch({ ...base, payToken: USDC, amountIn: 499_999n })).toThrow(/different amount/);
    expect(() => buildSwapBatch({ ...base, payToken: AUSD, amountIn: 500_000n })).toThrow(/different token/);
  });

  it('the most native MON a wallet can spend keeps it at the 10 MON reserve', () => {
    const reserve = 10n * 10n ** 18n;
    expect(maxNativeSpend(12n * 10n ** 18n, reserve)).toBe(2n * 10n ** 18n);
    expect(maxNativeSpend(9n * 10n ** 18n, reserve)).toBe(0n);
  });
});

function account() {
  const key = privateKeyToAccount(generatePrivateKey());
  return { address: TAKER, credentialId: 'test', account: key } as unknown as Parameters<typeof swap>[0]['account'];
}

function simulateAnswering(answer: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(answer), { status: 200 })) as typeof fetch;
}

function input(over: Partial<Parameters<typeof swap>[0]> = {}): Parameters<typeof swap>[0] {
  return {
    account: account(),
    marginAccount: MARGIN,
    payToken: USDC,
    receiveToken: WMON,
    amountIn: 500_000n,
    source: 'wallet',
    quote: { kind: 'aggregated', routes: [kyberToWmon], offered: 0, receivedAt: Date.now() },
    rpId: 'moneymarkets.trade',
    quoteMaxAgeMs: 20_000,
    onProgress: () => {},
    fetchImpl: simulateAnswering({ chosen: 0 }),
    stepTimeoutMs: 50,
    ...over,
  };
}

describe('swap(): the five checks before anything is signed (item 4, rules 1.5 and 1.6)', () => {
  beforeEach(() => {
    freshPasskey.mockReset();
    freshPasskey.mockImplementation(async () => {});
    runSpy.mockClear();
    planSpy.mockReset();
    planSpy.mockImplementation(async () => ({ kind: 'sponsored' }));
  });

  it('runs the five in order, filling the bar one fifth each, then sends', async () => {
    const seen: number[] = [];
    const result = await swap(
      input({
        onProgress: (p) => {
          if (p.checking) seen.push(p.checking.done);
        },
      }),
    );
    expect(result.state).toBe('CONFIRMED');
    expect(freshPasskey).toHaveBeenCalledTimes(1);
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(seen[0]).toBe(0);
    expect(seen[seen.length - 1]).toBe(5);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });

  it('rule 1.5: a quote 20 s old is never signed, and no Face ID is asked for', async () => {
    const result = await swap(input({ quote: { kind: 'aggregated', routes: [kyberToWmon], offered: 0, receivedAt: Date.now() - 20_000 } }));
    expect(result.state).toBe('REJECTED');
    expect(result.message).toMatch(/more than 20 seconds old/);
    expect(freshPasskey).not.toHaveBeenCalled();
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('rule 1.6: when the offered route reverts, the next one that passes is used and named', async () => {
    const chosen: SwapRoute[] = [];
    const secondBest: SwapRoute = { ...kyberToWmon, displayName: 'KyberSwap (second)' };
    const result = await swap(
      input({
        quote: { kind: 'aggregated', routes: [kyberToWmon, secondBest], offered: 0, receivedAt: Date.now() },
        fetchImpl: simulateAnswering({ chosen: 1 }),
        onRouteChosen: (r) => chosen.push(r),
      }),
    );
    expect(result.state).toBe('CONFIRMED');
    expect(chosen.map((r) => r.displayName)).toEqual(['KyberSwap (second)']);
  });

  it('rule 1.6: every route reverting shows the best one\'s decoded revert, and asks for no Face ID', async () => {
    const result = await swap(input({ fetchImpl: simulateAnswering({ chosen: null, revert: 'Return amount is not enough' }) }));
    expect(result.state).toBe('REJECTED');
    expect(result.message).toBe('Return amount is not enough');
    expect(freshPasskey).not.toHaveBeenCalled();
  });

  it('item 4: a stuck simulation times out with its own sentence', async () => {
    const stuck = (() => new Promise<Response>(() => {})) as typeof fetch;
    const result = await swap(input({ fetchImpl: stuck }));
    expect(result.message).toBe(SWAP_STEP_TIMEOUT_MESSAGES.simulate);
    expect(freshPasskey).not.toHaveBeenCalled();
  });

  it('item 4: a stuck Face ID times out with its own sentence', async () => {
    freshPasskey.mockImplementation(() => new Promise<void>(() => {}));
    const result = await swap(input());
    expect(result.message).toBe(SWAP_STEP_TIMEOUT_MESSAGES.passkey);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('item 4: a stuck gas quote times out with its own sentence, after Face ID but before sending', async () => {
    planSpy.mockImplementation(() => new Promise(() => {}));
    const result = await swap(input());
    expect(result.message).toBe(SWAP_STEP_TIMEOUT_MESSAGES.gas);
    expect(freshPasskey).toHaveBeenCalledTimes(1);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('item 4: a stuck permit read times out with its own sentence (Kuru Flow paid by permit)', async () => {
    const result = await swap(
      input({
        receiveToken: AUSD,
        amountIn: FLOW_QUOTE_AMOUNT_IN,
        quote: { kind: 'aggregated', routes: [flowRoute], offered: 0, receivedAt: Date.now() },
        readPermit: () => new Promise(() => {}),
      }),
    );
    expect(result.message).toBe(SWAP_STEP_TIMEOUT_MESSAGES.permit);
    expect(freshPasskey).not.toHaveBeenCalled();
  });

  it('a cancelled Face ID signs and sends nothing', async () => {
    freshPasskey.mockImplementation(async () => {
      throw new Error('NotAllowedError');
    });
    const result = await swap(input());
    expect(result.message).toMatch(/Face ID was not confirmed/);
    expect(planSpy).not.toHaveBeenCalled();
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('a check that could not run is not evidence either way: it falls back to the offered route', async () => {
    const down = (async () => new Response('nope', { status: 502 })) as typeof fetch;
    const result = await swap(input({ fetchImpl: down }));
    expect(result.state).toBe('CONFIRMED');
  });

  it('the gas quote carries the wrap\'s value (MON input)', async () => {
    await swap(
      input({
        payToken: NATIVE_MON,
        receiveToken: USDC,
        amountIn: kyberFromWmon.amountIn,
        quote: { kind: 'aggregated', routes: [kyberFromWmon], offered: 0, receivedAt: Date.now() },
      }),
    );
    const planned = planSpy.mock.calls[0]?.[0] as { calls: { value?: bigint }[] };
    expect(planned.calls[0]?.value).toBe(kyberFromWmon.amountIn);
  });
});

describe('withStepTimeout', () => {
  it('passes a result through and aborts the step on timeout', async () => {
    await expect(withStepTimeout('prepare', async () => 7, 50)).resolves.toBe(7);
    let aborted = false;
    await expect(
      withStepTimeout(
        'prepare',
        (signal) =>
          new Promise(() => {
            signal.addEventListener('abort', () => {
              aborted = true;
            });
          }),
        20,
      ),
    ).rejects.toThrow(SWAP_STEP_TIMEOUT_MESSAGES.prepare);
    expect(aborted).toBe(true);
  });
});
