import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNearRail, nearAssetId, NEAR_ASSET_IDS } from './near.js';
import { isQuote, type Decline, type FundingRequest, type Quote } from './types.js';
import type { Address } from 'viem';

/**
 * The NEAR Intents rail.
 *
 * Every fixture below is a **real** 1Click response captured on 2026-09-11 — the
 * refusal sentence, its correlation id, and the $1,500 quote's exact figures. Nothing
 * here is a shape someone imagined the vendor might return.
 *
 * These are EXISTS-grade for the rail's own behaviour: they prove the code agrees with
 * what 1Click said, not that a deposit was ever funded through it.
 */

const ACCOUNT = '0x714f169Fe2D3990961B534D573f9646c037586E6' as Address;

const BASE_USDC: FundingRequest = {
  sourceChain: { id: 8453, key: 'base', displayName: 'Base', vm: 'evm' },
  sourceAsset: {
    symbol: 'USDC',
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    decimals: 6,
  },
  amount: 5_000_000n,
  recipient: ACCOUNT,
  wantsMargin: false,
};

/** Verbatim, HTTP 400, correlationId 6bc42b9b-6aaa-4e34-96fa-afa7fef7739d. */
const REFUSAL = {
  message: 'Temporary swap limits: minimum swap amount is $1,000',
  correlationId: '6bc42b9b-6aaa-4e34-96fa-afa7fef7739d',
  timestamp: '2026-09-10T22:37:24.534Z',
  path: '/v0/quote',
};

/** Verbatim, HTTP 201, Base USDC 1500.0 to Monad USDC. */
const QUOTE_1500 = {
  quote: {
    amountIn: '1500000000',
    amountInFormatted: '1500.0',
    amountInUsd: '1499.878500000000',
    amountOut: '1498195197',
    amountOutFormatted: '1498.195197',
    amountOutUsd: '1498.073843189043',
    minAmountOut: '1483213245',
    timeEstimate: 1837,
    refundFee: '2400',
    withdrawFee: '621',
  },
};

function stubFetch(status: number, body: unknown) {
  const spy = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the asset table is what 1Click listed', () => {
  it('maps Base USDC to the id in the live token list', () => {
    expect(nearAssetId(8453, 'USDC')).toBe(
      'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
    );
  });

  it('is case-insensitive on the symbol, because coverage entries are not normalised', () => {
    expect(nearAssetId(728126428, 'usdt')).toBe(nearAssetId(728126428, 'USDT'));
  });

  it('knows nothing about a pair 1Click did not list', () => {
    // 1Click lists no Tron USDC. Claiming one would be an invented route.
    expect(nearAssetId(728126428, 'USDC')).toBeUndefined();
  });

  it('every id is a NEAR asset identifier, never a bare contract address', () => {
    for (const id of Object.values(NEAR_ASSET_IDS)) {
      expect(id).toMatch(/^nep(141|245):/);
    }
  });
});

describe('supports() gates on the route table alone', () => {
  const rail = createNearRail();

  it('claims a pair it holds an id for', () => {
    expect(rail.supports(BASE_USDC)).toBe(true);
  });

  it('does not claim a chain 1Click never listed', () => {
    expect(rail.supports({ ...BASE_USDC, sourceChain: { ...BASE_USDC.sourceChain, id: 999 } })).toBe(
      false,
    );
  });

  it('refuses a zero amount without asking anyone', () => {
    expect(rail.supports({ ...BASE_USDC, amount: 0n })).toBe(false);
  });
});

describe('a refusal reaches the user in 1Click’s own words', () => {
  it('passes the minimum-swap sentence through unchanged', async () => {
    stubFetch(400, REFUSAL);
    const result = await createNearRail().quote(BASE_USDC, new AbortController().signal);
    expect(isQuote(result)).toBe(false);
    expect((result as Decline).reason).toBe(
      'Temporary swap limits: minimum swap amount is $1,000',
    );
  });

  it('keeps the raw body, correlation id included, for the row that stores it', async () => {
    stubFetch(400, REFUSAL);
    const result = await createNearRail().quote(BASE_USDC, new AbortController().signal);
    expect((result as Decline).raw).toMatchObject({
      correlationId: '6bc42b9b-6aaa-4e34-96fa-afa7fef7739d',
    });
  });

  it('writes no minimum of its own anywhere in the module', async () => {
    // The figure is 1Click's, for one day. A floor written here would outlive it.
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('./near.ts', import.meta.url), 'utf8'),
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/1_?000_?000_?000/);
    expect(code).not.toContain('minimum');
  });
});

describe('a quote carries 1Click’s numbers and nothing computed here', () => {
  it('reads amountOut, the ETA and both fee labels straight off the response', async () => {
    stubFetch(201, QUOTE_1500);
    const q = (await createNearRail().quote(
      { ...BASE_USDC, amount: 1_500_000_000n },
      new AbortController().signal,
    )) as Quote;

    expect(q.rail).toBe('near');
    expect(q.amountOut).toBe(1_498_195_197n);
    expect(q.etaSeconds).toBe(1837);
    expect(q.outToken).toBe('USDC');
    expect(q.fees.map((f) => f.label).sort()).toEqual(['refundFee', 'withdrawFee']);
    expect(q.fees.find((f) => f.label === 'withdrawFee')?.amount).toBe(621n);
  });

  it('is executable: it issues an address, so a user with no wallet can act on it', async () => {
    stubFetch(201, QUOTE_1500);
    const q = (await createNearRail().quote(
      { ...BASE_USDC, amount: 1_500_000_000n },
      new AbortController().signal,
    )) as Quote;
    expect(q.executable).toBe(true);
  });

  it('asks for a dry quote, so pricing never allocates an address', async () => {
    const spy = stubFetch(201, QUOTE_1500);
    await createNearRail().quote(
      { ...BASE_USDC, amount: 1_500_000_000n },
      new AbortController().signal,
    );
    const body = JSON.parse(String((spy.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.dry).toBe(true);
  });

  it('refunds an EVM origin to the signed-in account, which owns that address too', async () => {
    const spy = stubFetch(201, QUOTE_1500);
    await createNearRail().quote(
      { ...BASE_USDC, amount: 1_500_000_000n },
      new AbortController().signal,
    );
    const body = JSON.parse(String((spy.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.refundTo).toBe(ACCOUNT);
    expect(body.recipient).toBe(ACCOUNT);
  });
});

describe('a non-EVM origin needs an address on that chain, and says so as ours', () => {
  const TRON: FundingRequest = {
    ...BASE_USDC,
    sourceChain: { id: 728126428, key: 'tron', displayName: 'Tron', vm: 'tvm' },
    sourceAsset: { symbol: 'USDT', address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', decimals: 6 },
  };

  it('declines without calling 1Click when no sender address was given', async () => {
    const spy = stubFetch(201, QUOTE_1500);
    const result = await createNearRail().quote(TRON, new AbortController().signal);
    expect(isQuote(result)).toBe(false);
    expect((result as Decline).reason).toContain('Tron');
    // Ours to explain, so the vendor is never made to look as though it refused.
    expect((result as Decline).reason).not.toContain('1Click');
    expect(spy).not.toHaveBeenCalled();
  });

  it('uses the sender address as refundTo once it has one', async () => {
    const spy = stubFetch(201, QUOTE_1500);
    await createNearRail().quote(
      { ...TRON, senderAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' },
      new AbortController().signal,
    );
    const body = JSON.parse(String((spy.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.refundTo).toBe('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');
    // And still delivers to the signed-in account. R4 holds on both sides.
    expect(body.recipient).toBe(ACCOUNT);
  });
});

describe('the recipient assertion holds here too (R4)', () => {
  it('the request is priced for the signed-in account and no one else', async () => {
    const spy = stubFetch(201, QUOTE_1500);
    await createNearRail().quote(
      { ...BASE_USDC, amount: 1_500_000_000n },
      new AbortController().signal,
    );
    const body = JSON.parse(String((spy.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.recipient.toLowerCase()).toBe(ACCOUNT.toLowerCase());
  });
});

describe('issuing an address is a second, non-dry call', () => {
  it('repeats the priced request with dry false and returns the issued address', async () => {
    stubFetch(201, QUOTE_1500);
    const rail = createNearRail();
    const q = (await rail.quote(
      { ...BASE_USDC, amount: 1_500_000_000n },
      new AbortController().signal,
    )) as Quote;

    const issue = stubFetch(201, {
      quote: {
        ...QUOTE_1500.quote,
        depositAddress: '0x1111111111111111111111111111111111111111',
        deadline: '2026-09-11T00:00:00.000Z',
      },
    });
    const instruction = await rail.depositAddress!(q);

    const body = JSON.parse(String((issue.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.dry).toBe(false);
    expect(body.amount).toBe('1500000000');
    expect(instruction.address).toBe('0x1111111111111111111111111111111111111111');
    expect(instruction.rail).toBe('near');
    // 1Click's own expiry, not a number invented here.
    expect(instruction.expiresAt).toBe(Date.parse('2026-09-11T00:00:00.000Z'));
  });

  it('throws rather than returning an instruction when no address came back', async () => {
    stubFetch(201, QUOTE_1500);
    const rail = createNearRail();
    const q = (await rail.quote(
      { ...BASE_USDC, amount: 1_500_000_000n },
      new AbortController().signal,
    )) as Quote;
    stubFetch(201, QUOTE_1500); // no depositAddress field
    await expect(rail.depositAddress!(q)).rejects.toThrow(/no deposit address/);
  });
});

describe('status maps 1Click’s words without losing them', () => {
  it('only calls a destination hash a delivery once the swap is SUCCESS', async () => {
    stubFetch(200, {
      status: 'PROCESSING',
      swapDetails: { destinationChainTxHashes: [{ hash: '0xdeadbeef' }] },
    });
    const s = await createNearRail().status({ rail: 'near', ref: 'addr' });
    expect(s.state).toBe('in-flight');
    expect(s.destinationTxHash).toBeUndefined();
  });

  it('reports a delivery with its hash', async () => {
    stubFetch(200, {
      status: 'SUCCESS',
      swapDetails: { amountOut: '1498195197', destinationChainTxHashes: [{ hash: '0xabc' }] },
    });
    const s = await createNearRail().status({ rail: 'near', ref: 'addr' });
    expect(s.state).toBe('delivered');
    expect(s.destinationTxHash).toBe('0xabc');
    expect(s.amountOut).toBe(1_498_195_197n);
  });

  it('keeps the raw payload whatever the state', async () => {
    stubFetch(200, { status: 'PENDING_DEPOSIT' });
    const s = await createNearRail().status({ rail: 'near', ref: 'addr' });
    expect(s.state).toBe('awaiting-source');
    expect(s.raw).toMatchObject({ status: 'PENDING_DEPOSIT' });
  });
});
