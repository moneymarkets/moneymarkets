import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDebridgeRail, DEBRIDGE_MONAD_CHAIN_ID } from './debridge.js';
import { createMayanRail } from './mayan.js';
import { UNAVAILABLE_RAILS } from './unavailable.js';
import { isQuote, type Decline, type FundingRequest, type Quote } from './types.js';
import type { Address } from 'viem';

/**
 * deBridge and Mayan, and the mistake that put them on the screen as unavailable.
 *
 * Both were written into `UNAVAILABLE_RAILS` on 2026-09-11 as permanently unable to
 * carry Monad, each with a raw response attached, and both were wrong within hours. The
 * tests below pin the two facts that made them wrong, because those are the facts that
 * would silently rot back if someone "simplified" either rail.
 */

const ACCOUNT = '0x714f169Fe2D3990961B534D573f9646c037586E6' as Address;

const BASE_USDC: FundingRequest = {
  sourceChain: { id: 8453, key: 'base', displayName: 'Base', vm: 'evm' },
  sourceAsset: {
    symbol: 'USDC',
    address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    decimals: 6,
  },
  amount: 5_000_000n,
  recipient: ACCOUNT,
  senderAddress: ACCOUNT,
  wantsMargin: false,
};

/** Verbatim from `create-tx`, Base USDC 5.000000, prependOperatingExpenses=false. */
const DEBRIDGE_5 = {
  estimation: {
    srcChainTokenIn: { amount: '5000000', symbol: 'USDC', decimals: 6 },
    dstChainTokenOut: { amount: '4988053', symbol: 'USDC', decimals: 6 },
    costsDetails: [
      {
        chain: '8453',
        type: 'DlnProtocolFee',
        payload: { feeAmount: '2000', feeBps: '4', feeApproximateUsdValue: '0.002' },
      },
      { chain: '100000030', type: 'TakerMargin', payload: { feeAmount: '1996', feeBps: '4' } },
    ],
    recommendedSlippage: 0,
  },
  tx: {
    to: '0xeF4fB24aD0916217251F553c0596F8Edc630EB66',
    data: '0xb9303701deadbeef',
    value: '1000000000000000',
  },
  order: { approximateFulfillmentDelay: 1 },
  orderId: '0x42914c865ce453ed12ed2de59f56b3a7b1cb1f31cd3fd9e9a6b82b2b738d8ab0',
  fixFee: '1000000000000000',
};

/** Verbatim shape from `POST /v3/quote`, Base USDC 20.000000. HTTP 201. */
const MAYAN_20 = {
  quotes: [
    {
      type: 'FAST_MCTP',
      meta: { title: 'Fast MCTP' },
      expectedAmountOutBaseUnits: '19990327',
      minAmountOutBaseUnits: '19981471',
      etaSeconds: 35,
      slippageBps: 0,
      circleMaxFee64: '2861',
      redeemRelayerFee64: '813',
    },
  ],
};

function stubFetch(status: number, body: unknown) {
  const spy = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('nothing is declared permanently unavailable that was not re-checked today', () => {
  it('the unavailable list is empty', () => {
    expect(UNAVAILABLE_RAILS).toEqual([]);
  });

  it('neither deBridge nor Mayan is in it', () => {
    const ids = UNAVAILABLE_RAILS.map((r) => r.id);
    expect(ids).not.toContain('debridge');
    expect(ids).not.toContain('mayan');
  });
});

describe('deBridge addresses Monad by its own id, which is why it was missed', () => {
  it('uses 100000030, not 143', () => {
    expect(DEBRIDGE_MONAD_CHAIN_ID).toBe(100_000_030);
  });

  it('sends that id as the destination chain', async () => {
    const spy = stubFetch(200, DEBRIDGE_5);
    await createDebridgeRail().quote(BASE_USDC, new AbortController().signal);
    const url = String(spy.mock.calls[0]?.[0]);
    expect(url).toContain('dstChainId=100000030');
    expect(url).not.toContain('dstChainId=143');
  });

  it('asks the host its own interface asks', async () => {
    const spy = stubFetch(200, DEBRIDGE_5);
    await createDebridgeRail().quote(BASE_USDC, new AbortController().signal);
    expect(String(spy.mock.calls[0]?.[0])).toContain('deswap.debridge.finance');
  });

  it('quotes the input the user typed, not one inflated to round the output', async () => {
    const spy = stubFetch(200, DEBRIDGE_5);
    const q = (await createDebridgeRail().quote(BASE_USDC, new AbortController().signal)) as Quote;
    expect(String(spy.mock.calls[0]?.[0])).toContain('prependOperatingExpenses=false');
    expect(q.amountIn).toBe(5_000_000n);
    expect(q.amountOut).toBe(4_988_053n);
  });
});

describe('deBridge’s fixed fee is surfaced, not buried', () => {
  it('names the 0.001 native fee that is absent from costsDetails', async () => {
    stubFetch(200, DEBRIDGE_5);
    const q = (await createDebridgeRail().quote(BASE_USDC, new AbortController().signal)) as Quote;
    const fixed = q.fees.find((f) => f.token === 'ETH');
    expect(fixed?.amount).toBe(1_000_000_000_000_000n);
    expect(fixed?.label).toMatch(/fixed fee/);
  });

  it('carries the fee into the transaction’s value unchanged', async () => {
    stubFetch(200, DEBRIDGE_5);
    const rail = createDebridgeRail();
    const q = (await rail.quote(BASE_USDC, new AbortController().signal)) as Quote;
    const plan = await rail.buildSourceTx!(q);
    expect(plan.txs.at(-1)?.value).toBe('1000000000000000');
  });

  it('puts an approval in front of deBridge’s own calldata, and does not re-encode it', async () => {
    stubFetch(200, DEBRIDGE_5);
    const rail = createDebridgeRail();
    const q = (await rail.quote(BASE_USDC, new AbortController().signal)) as Quote;
    const plan = await rail.buildSourceTx!(q);
    expect(plan.txs).toHaveLength(2);
    expect(plan.txs[0]?.data.startsWith('0x095ea7b3')).toBe(true);
    // deBridge's own bytes, passed through exactly.
    expect(plan.txs[1]?.data).toBe('0xb9303701deadbeef');
  });
});

describe('a quoted deBridge order does not exist yet, and that is not a failure', () => {
  it('reads 422 Order not found as awaiting the source transaction', async () => {
    stubFetch(422, { message: 'Order not found', errorCode: 422 });
    const s = await createDebridgeRail().status({ rail: 'debridge', ref: '0xabc' });
    expect(s.state).toBe('awaiting-source');
    expect(s.message).toBe('Order not found');
  });
});

describe('Mayan answers 201, and its stale chain list is not what gates it', () => {
  it('accepts a 201 as success', async () => {
    stubFetch(201, MAYAN_20);
    const result = await createMayanRail().quote(
      { ...BASE_USDC, amount: 20_000_000n },
      new AbortController().signal,
    );
    expect(isQuote(result)).toBe(true);
    expect((result as Quote).amountOut).toBe(19_990_327n);
  });

  it('names chains by string, as Mayan’s own interface does', async () => {
    const spy = stubFetch(201, MAYAN_20);
    await createMayanRail().quote({ ...BASE_USDC, amount: 20_000_000n }, new AbortController().signal);
    const body = JSON.parse(String((spy.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.fromChain).toBe('base');
    expect(body.toChain).toBe('monad');
  });

  it('supports Base, which the stale /v3/chains list omits entirely', () => {
    expect(createMayanRail().supports(BASE_USDC)).toBe(true);
  });

  it('picks the best of Mayan’s own offers on what arrives', async () => {
    stubFetch(201, {
      quotes: [
        { type: 'SWIFT', expectedAmountOutBaseUnits: '19982686', etaSeconds: 3 },
        { type: 'FAST_MCTP', expectedAmountOutBaseUnits: '19990327', etaSeconds: 35 },
      ],
    });
    const q = (await createMayanRail().quote(
      { ...BASE_USDC, amount: 20_000_000n },
      new AbortController().signal,
    )) as Quote;
    expect(q.amountOut).toBe(19_990_327n);
  });

  it('is not executable: it prices, and this app cannot build its order', async () => {
    stubFetch(201, MAYAN_20);
    const q = (await createMayanRail().quote(
      { ...BASE_USDC, amount: 20_000_000n },
      new AbortController().signal,
    )) as Quote;
    expect(q.executable).toBe(false);
    expect(createMayanRail().buildSourceTx).toBeUndefined();
  });

  it('passes Mayan’s own refusal through', async () => {
    stubFetch(400, { message: 'Route not found' });
    const result = await createMayanRail().quote(
      { ...BASE_USDC, amount: 20_000_000n },
      new AbortController().signal,
    );
    expect((result as Decline).reason).toBe('Route not found');
  });
});
