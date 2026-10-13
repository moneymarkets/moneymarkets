import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAddress, type Address, type Hex } from 'viem';
import type * as CoreModule from '@tradepro/core';

/**
 * The quote route's own decisions (rules 1.3 to 1.8): which route is offered, what the
 * screen is told when nothing routes or a route reverts, the tax-token path and the
 * reserve sentence. The vendors and the chain are stubbed; each vendor's own parsing is
 * tested against recorded responses in packages/core/src/swap/swap.test.ts.
 */

type Tx = CoreModule.SwapTx;
type Sim =
  | { status: 'ok'; delivered: bigint }
  | { status: 'reverted'; reason: string }
  | { status: 'unchecked'; detail: string };

const TAKER = getAddress('0x670269f8bD8c326a96Fb5c557Cce606F47BcF59f');
const USDC = getAddress('0x754704Bc059F8C67012fEd69BC8A327a5aafb603');
const WMON = getAddress('0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A');
const TAX = getAddress('0x1111111111111111111111111111111111111111');
const NATIVE = '0x0000000000000000000000000000000000000000' as Address;
const ROUTER = getAddress('0x6131B5fae19EA4f9D964eAc0408E4408b66337b5');

let answers: Record<string, (req: CoreModule.SwapQuoteRequest) => Tx | Error> = {};
let simByData: Record<string, Sim> = {};
let nativeBalance = 0n;

function tx(vendor: Tx['vendor'], tokenIn: Address, tokenOut: Address, amountIn: bigint, expectedOut: bigint, bps: number, tag: string): Tx {
  return {
    vendor,
    router: ROUTER,
    to: ROUTER,
    data: `0x${tag}` as Hex,
    value: 0n,
    tokenIn,
    tokenOut,
    amountIn,
    recipient: TAKER,
    expectedOut,
    minOut: (expectedOut * BigInt(10_000 - bps)) / 10_000n,
  };
}

function vendor(id: Tx['vendor']): CoreModule.SwapVendor {
  return {
    id,
    displayName: id === 'kyberswap' ? 'KyberSwap' : 'Kuru Flow',
    async quote(request) {
      return { vendor: id, request, expectedOut: 0n, minOut: 0n, handle: undefined };
    },
    async buildTx(quote) {
      const answer = answers[id]?.(quote.request);
      if (!answer) throw new Error(`${id} has no route`);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

vi.mock('@tradepro/core', async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  return { ...actual, kyberSwapVendor: () => vendor('kyberswap'), flowVendor: () => vendor('kuru-flow') };
});
vi.mock('../../../../../lib/server/chain', () => ({
  readClient: () => ({ getBalance: async () => nativeBalance }),
}));
vi.mock('../../../../../lib/server/simulateDelivery', () => ({
  simulateDelivery: async (_client: unknown, _sender: Address, calls: { data: Hex }[]) => {
    const swapCall = calls.find((c) => c.data in simByData);
    // Unlisted routes deliver in full, so only the cases a test names are short.
    return swapCall ? simByData[swapCall.data] : { status: 'ok', delivered: 10n ** 30n };
  },
}));

const { GET } = await import('./route');

async function quote(params: Record<string, string>) {
  const qs = new URLSearchParams({ address: TAKER, source: 'wallet', ...params });
  const res = await GET(new Request(`https://x/api/wallet/swap/quote?${qs.toString()}`));
  return (await res.json()) as {
    routes: { vendor: string; minOut: string; simulation: { status: string } }[];
    offered: number | null;
    message?: string;
    revert?: string;
    reserve?: { maxSpend: string };
    feeOnTransfer?: { delivered: string };
    kind: string;
    holdSeconds: number;
  };
}

beforeEach(() => {
  answers = {};
  simByData = {};
  nativeBalance = 20n * 10n ** 18n;
});

describe('GET /api/wallet/swap/quote', () => {
  it('rule 1.3: the highest minimum out is offered, every answering vendor listed', async () => {
    answers.kyberswap = (r) => tx('kyberswap', r.tokenIn, r.tokenOut, r.amountIn, 1_000n, r.slippageBps, 'aa');
    answers['kuru-flow'] = (r) => tx('kuru-flow', r.tokenIn, r.tokenOut, r.amountIn, 900n, r.slippageBps, 'bb');
    const body = await quote({ tokenIn: USDC, tokenOut: WMON, amount: '500000' });
    expect(body.routes.map((r) => r.vendor)).toEqual(['kyberswap', 'kuru-flow']);
    expect(body.offered).toBe(0);
    expect(body.routes[0]?.minOut).toBe('995');
    expect(body.holdSeconds).toBe(20);
  });

  it('rule 1.2: the user\'s slippage is what every vendor is asked for', async () => {
    const asked: number[] = [];
    answers.kyberswap = (r) => {
      asked.push(r.slippageBps);
      return tx('kyberswap', r.tokenIn, r.tokenOut, r.amountIn, 1_000n, r.slippageBps, 'aa');
    };
    const body = await quote({ tokenIn: USDC, tokenOut: WMON, amount: '1', slippageBps: '300' });
    expect(asked).toEqual([300]);
    expect(body.routes[0]?.minOut).toBe('970');
  });

  it('refuses a slippage that is not one of the four choices', async () => {
    const res = await GET(new Request(`https://x/api/wallet/swap/quote?tokenIn=${USDC}&tokenOut=${WMON}&amount=1&address=${TAKER}&slippageBps=75`));
    expect(res.status).toBe(400);
  });

  it('rule 1.4: one vendor down still quotes; all down says so in one sentence', async () => {
    answers['kuru-flow'] = (r) => tx('kuru-flow', r.tokenIn, r.tokenOut, r.amountIn, 900n, r.slippageBps, 'bb');
    const one = await quote({ tokenIn: USDC, tokenOut: WMON, amount: '1' });
    expect(one.routes.map((r) => r.vendor)).toEqual(['kuru-flow']);
    answers = {};
    const none = await quote({ tokenIn: USDC, tokenOut: WMON, amount: '1' });
    expect(none.routes).toEqual([]);
    expect(none.message).toBe('No aggregator on Monad has a route for this pair right now.');
  });

  it('rule 1.6: the winner reverting offers the next vendor; all reverting shows the best one\'s revert', async () => {
    answers.kyberswap = (r) => tx('kyberswap', r.tokenIn, r.tokenOut, r.amountIn, 1_000n, r.slippageBps, 'aa');
    answers['kuru-flow'] = (r) => tx('kuru-flow', r.tokenIn, r.tokenOut, r.amountIn, 900n, r.slippageBps, 'bb');
    simByData = { '0xaa': { status: 'reverted', reason: 'Return amount is not enough' } };
    const next = await quote({ tokenIn: USDC, tokenOut: WMON, amount: '1' });
    expect(next.offered).toBe(1);
    simByData['0xbb'] = { status: 'reverted', reason: 'Kuru Flow reverted' };
    const all = await quote({ tokenIn: USDC, tokenOut: WMON, amount: '1' });
    expect(all.offered).toBeNull();
    expect(all.revert).toBe('Return amount is not enough');
  });

  it('rule 1.7: a fee-on-transfer token is quoted again with the minimum set from what really arrives', async () => {
    // Asked for the user's 50 bps, the route reverts (the token keeps 5%); asked for the
    // probe's widest slippage it passes and delivers 950 of 1000.
    answers.kyberswap = (r) =>
      tx('kyberswap', r.tokenIn, r.tokenOut, r.amountIn, 1_000n, r.slippageBps, r.slippageBps === 50 ? 'aa' : r.slippageBps === 2000 ? 'cc' : 'dd');
    simByData = {
      '0xaa': { status: 'reverted', reason: 'Return amount is not enough' },
      '0xcc': { status: 'ok', delivered: 950n },
      '0xdd': { status: 'ok', delivered: 950n },
    };
    const body = await quote({ tokenIn: USDC, tokenOut: TAX, amount: '1' });
    expect(body.offered).toBe(0);
    expect(body.feeOnTransfer?.delivered).toBe('950');
    // One entry per vendor, and its minimum is at or under the delivered amount less slippage.
    expect(body.routes.filter((r) => r.vendor === 'kyberswap')).toHaveLength(1);
    expect(BigInt(body.routes[0]!.minOut)).toBeLessThanOrEqual((950n * 9950n) / 10000n);
  });

  it('rule 1.8: MON in that would leave the wallet under 10 MON says how much can be swapped', async () => {
    nativeBalance = 11n * 10n ** 18n;
    const body = await quote({ tokenIn: NATIVE, tokenOut: USDC, amount: (2n * 10n ** 18n).toString() });
    expect(body.reserve?.maxSpend).toBe((1n * 10n ** 18n).toString());
    expect(body.offered).toBeNull();
  });

  it('rule 1.8: MON in asks the aggregators for WMON, never native', async () => {
    const asked: string[] = [];
    answers.kyberswap = (r) => {
      asked.push(`${r.tokenIn}>${r.tokenOut}`);
      return tx('kyberswap', r.tokenIn, r.tokenOut, r.amountIn, 5n, r.slippageBps, 'aa');
    };
    await quote({ tokenIn: NATIVE, tokenOut: USDC, amount: '1' });
    await quote({ tokenIn: USDC, tokenOut: NATIVE, amount: '1' });
    expect(asked).toEqual([`${WMON}>${USDC}`, `${USDC}>${WMON}`]);
  });

  it('rule 1.8: WMON to MON and MON to WMON never call an aggregator', async () => {
    let called = false;
    answers.kyberswap = () => {
      called = true;
      return new Error('should not be asked');
    };
    answers['kuru-flow'] = answers.kyberswap;
    const unwrap = await quote({ tokenIn: WMON, tokenOut: NATIVE, amount: '5' });
    const wrap = await quote({ tokenIn: NATIVE, tokenOut: WMON, amount: '5' });
    expect([unwrap.kind, wrap.kind]).toEqual(['unwrap', 'wrap']);
    expect(called).toBe(false);
  });
});
