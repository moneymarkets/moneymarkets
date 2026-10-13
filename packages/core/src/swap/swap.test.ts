import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeFunctionData, getAddress, type Address, type Hex } from 'viem';
import { MAINNET } from '../chain/addresses.js';
import { assertSponsorable, exemptionOf, type PolicyContext } from '../gas/policy.js';
import { buildWithdraw } from '../kuru/orders.js';
import { aggregateQuotes, NO_ROUTE_MESSAGE } from './aggregate.js';
import { decodeKyberSwap, KYBER_ROUTER, KYBER_SWAP_ABI } from './kyberRouter.js';
import { kyberSwapVendor } from './kyberswap.js';
import { bpsReaching, minOutFor } from './minOut.js';
import { rankRoutes } from './rank.js';
import { readPinnedSwap } from './routers.js';
import { VendorResponseError, type SwapQuoteRequest, type SwapTx, type SwapVendor } from './types.js';
import routesUsdcToWmon from './__fixtures__/kyberRoutes.usdcToWmon.fixture.json';
import buildUsdcToWmon from './__fixtures__/kyberBuild.usdcToWmon.fixture.json';
import buildWmonToUsdc from './__fixtures__/kyberBuild.wmonToUsdc.fixture.json';

/** Every fixture here is a real KyberSwap response recorded 2026-09-29 (R3), taker and
 *  recipient the v2.1 acceptance account. See reports/SWAP-VERIFY.md. */
const TAKER = getAddress('0x670269f8bD8c326a96Fb5c557Cce606F47BcF59f');
const USDC = MAINNET.tokens.USDC.address;
const WMON = MAINNET.tokens.WMON.address;
const MARGIN = MAINNET.kuru.marginAccount;

const usdcToWmon: SwapQuoteRequest = { tokenIn: USDC, tokenOut: WMON, amountIn: 500_000n, taker: TAKER, slippageBps: 50 };
function replay(routes: unknown, build: unknown): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes('/route/build') ? build : routes;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

const approve = (spender: Address, value: bigint): Hex =>
  `0x095ea7b3${spender.slice(2).toLowerCase().padStart(64, '0')}${value.toString(16).padStart(64, '0')}` as Hex;
const unwrap = (amount: bigint) => ({ to: WMON, data: `0x2e1a7d4d${amount.toString(16).padStart(64, '0')}` as Hex });
const wrap = (value: bigint) => ({ to: WMON, data: '0xd0e30db0' as Hex, value });
const context = (sender?: Address): PolicyContext => ({ marginAccount: MARGIN, ...(sender ? { sender } : {}) });

function reasonOf(fn: () => void): string {
  try {
    fn();
    return 'ALLOWED';
  } catch (error) {
    return (error as { reason?: string }).reason ?? String(error);
  }
}

describe('minimum out is computed here, to the unit the vendors compute it (rule 1.2)', () => {
  it('matches Kuru Flow and KyberSwap on their own live answers', () => {
    // Kuru Flow, slippageTolerance 50 and 100, reports/SWAP-VERIFY.md.
    expect(minOutFor(17_533_201_972_689_236_429n, 50)).toBe(17_445_535_962_825_790_246n);
    expect(minOutFor(17_533_201_972_689_236_429n, 100)).toBe(17_357_869_952_962_344_064n);
    // KyberSwap, the minReturnAmount decoded from the recorded build calldata.
    const decoded = decodeKyberSwap(buildUsdcToWmon.data.data as Hex);
    expect(decoded.minOut).toBe(minOutFor(BigInt(buildUsdcToWmon.data.amountOut), 50));
  });

  it('finds the whole-bps slippage that lands at or under a simulated delivery', () => {
    const bps = bpsReaching(1_000_000n, 950_000n, 2_000);
    expect(bps).toBe(500);
    expect(minOutFor(1_000_000n, bps!)).toBeLessThanOrEqual(950_000n);
    expect(bpsReaching(1_000_000n, 100_000n, 2_000)).toBeUndefined();
  });
});

describe('ranking (rule 1.3)', () => {
  const route = (minOut: bigint, gasEstimate?: bigint) => ({ minOut, ...(gasEstimate !== undefined ? { gasEstimate } : {}) });

  it('the highest minimum out wins', () => {
    expect(rankRoutes([route(10n), route(12n), route(11n)]).map((r) => r.minOut)).toEqual([12n, 11n, 10n]);
  });

  it('a tie goes to the lower gas estimate, and an estimate beats none', () => {
    expect(rankRoutes([route(10n, 900n), route(10n, 300n)])[0]?.gasEstimate).toBe(300n);
    expect(rankRoutes([route(10n), route(10n, 900n)])[0]?.gasEstimate).toBe(900n);
  });
});

describe('KyberSwap vendor, on recorded responses', () => {
  it('builds a checked transaction: pinned router, our minimum, the taker as receiver', async () => {
    const vendor = kyberSwapVendor({ fetchImpl: replay(routesUsdcToWmon, buildUsdcToWmon) });
    const quote = await vendor.quote(usdcToWmon, new AbortController().signal);
    const tx = await vendor.buildTx(quote, new AbortController().signal);
    expect(tx.to).toBe(KYBER_ROUTER);
    expect(tx.value).toBe(0n);
    expect(tx.recipient).toBe(TAKER);
    expect(tx.tokenIn).toBe(getAddress(USDC));
    expect(tx.tokenOut).toBe(getAddress(WMON));
    expect(tx.amountIn).toBe(500_000n);
    expect(tx.minOut).toBe(minOutFor(BigInt(buildUsdcToWmon.data.amountOut), 50));
  });

  it('R4: refuses a build that pays anyone but the signed-in account', async () => {
    const vendor = kyberSwapVendor({ fetchImpl: replay(routesUsdcToWmon, buildUsdcToWmon) });
    const other = { ...usdcToWmon, taker: getAddress('0x43a275C3Eb0BE7313f847FFA4fb6Bd366606A961') };
    const quote = await vendor.quote(other, new AbortController().signal);
    await expect(vendor.buildTx(quote, new AbortController().signal)).rejects.toThrow(/not the signed-in account/);
  });

  it('refuses a minimum other than ours (a different slippage than was asked)', async () => {
    const vendor = kyberSwapVendor({ fetchImpl: replay(routesUsdcToWmon, buildUsdcToWmon) });
    const quote = await vendor.quote({ ...usdcToWmon, slippageBps: 100 }, new AbortController().signal);
    await expect(vendor.buildTx(quote, new AbortController().signal)).rejects.toThrow(/not this app's minimum/);
  });

  it('keeps an invalid body for the log and never parses a fragment (rule 1.4)', async () => {
    const vendor = kyberSwapVendor({ fetchImpl: (async () => new Response('[', { status: 200 })) as typeof fetch });
    const error = await vendor.quote(usdcToWmon, new AbortController().signal).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VendorResponseError);
    expect((error as VendorResponseError).rawBody).toBe('[');
    expect((error as VendorResponseError).message).not.toContain('[');
  });

  it('refuses a route that names a router other than the pinned one', async () => {
    const tampered = { ...routesUsdcToWmon, data: { ...routesUsdcToWmon.data, routerAddress: TAKER } };
    const vendor = kyberSwapVendor({ fetchImpl: replay(tampered, buildUsdcToWmon) });
    await expect(vendor.quote(usdcToWmon, new AbortController().signal)).rejects.toThrow(/not the pinned router/);
  });
});

describe('aggregation (rule 1.4)', () => {
  const fixed = (id: SwapVendor['id'], minOut: bigint, delayMs = 0): SwapVendor => ({
    id,
    displayName: id,
    async quote(request) {
      await new Promise((r) => setTimeout(r, delayMs));
      return { vendor: id, request, expectedOut: minOut, minOut, handle: undefined };
    },
    async buildTx(q): Promise<SwapTx> {
      return {
        vendor: id,
        router: KYBER_ROUTER,
        to: KYBER_ROUTER,
        data: '0x' as Hex,
        value: 0n,
        tokenIn: USDC,
        tokenOut: WMON,
        amountIn: q.request.amountIn,
        recipient: TAKER,
        expectedOut: q.expectedOut,
        minOut: q.minOut,
      };
    },
  });
  const broken = (id: SwapVendor['id']): SwapVendor => ({
    id,
    displayName: id,
    quote: async () => {
      throw new VendorResponseError(id, 'vendor down', '<html>502</html>');
    },
    buildTx: async () => {
      throw new Error('unreachable');
    },
  });

  it('one vendor down still quotes from the other', async () => {
    const result = await aggregateQuotes([broken('kyberswap'), fixed('kuru-flow', 7n)], usdcToWmon);
    expect(result.routes.map((r) => r.vendor)).toEqual(['kuru-flow']);
    expect(result.failures).toEqual([{ vendor: 'kyberswap', reason: 'vendor down', rawBody: '<html>502</html>' }]);
  });

  it('all down: no routes, and the sentence the screen shows', async () => {
    const result = await aggregateQuotes([broken('kyberswap'), broken('kuru-flow')], usdcToWmon);
    expect(result.routes).toEqual([]);
    expect(NO_ROUTE_MESSAGE).toBe('No aggregator on Monad has a route for this pair right now.');
  });

  it('a vendor past its 2 s budget is absent, the other still answers', async () => {
    const result = await aggregateQuotes([fixed('kyberswap', 9n, 200), fixed('kuru-flow', 7n)], usdcToWmon, {
      timeoutMs: 50,
    });
    expect(result.routes.map((r) => r.vendor)).toEqual(['kuru-flow']);
    expect(result.failures[0]?.vendor).toBe('kyberswap');
  });

  it('ranks what answered, best minimum first', async () => {
    const result = await aggregateQuotes([fixed('kuru-flow', 7n), fixed('kyberswap', 9n)], usdcToWmon);
    expect(result.routes.map((r) => r.vendor)).toEqual(['kyberswap', 'kuru-flow']);
  });
});

describe('relayer policy on the pinned KyberSwap router (rule 1.9)', () => {
  const swapToWmon = buildUsdcToWmon.data.data as Hex;
  const swapToUsdc = buildWmonToUsdc.data.data as Hex;
  const triple = (token: Address, amount: bigint, data: Hex) => [
    { to: token, data: approve(KYBER_ROUTER, amount) },
    { to: KYBER_ROUTER, data },
    { to: token, data: approve(KYBER_ROUTER, 0n) },
  ];

  it('allows approve-exact, the swap, approve-zero, paying the signing account', () => {
    expect(reasonOf(() => assertSponsorable(triple(USDC, 500_000n, swapToWmon), context(TAKER)))).toBe('ALLOWED');
  });

  it('refuses the swap when its receiver is not the signing account, or unknown', () => {
    const stranger = getAddress('0x43a275C3Eb0BE7313f847FFA4fb6Bd366606A961');
    expect(reasonOf(() => assertSponsorable(triple(USDC, 500_000n, swapToWmon), context(stranger)))).toBe(
      'TARGET_NOT_ALLOWED',
    );
    expect(reasonOf(() => assertSponsorable(triple(USDC, 500_000n, swapToWmon), context()))).toBe('TARGET_NOT_ALLOWED');
  });

  it('refuses an approval that does not match the swap, and a swap with no approval before it', () => {
    expect(reasonOf(() => assertSponsorable(triple(USDC, 499_999n, swapToWmon), context(TAKER)))).toBe(
      'PERMIT_AMOUNT_INVALID',
    );
    expect(reasonOf(() => assertSponsorable([{ to: KYBER_ROUTER, data: swapToWmon }], context(TAKER)))).toBe(
      'TARGET_NOT_ALLOWED',
    );
  });

  it('refuses a KyberSwap swap carrying a native-value flag, a fee or a permit', () => {
    const args = decodeFunctionData({ abi: KYBER_SWAP_ABI, data: swapToWmon }).args[0];
    const tamper = (desc: Record<string, unknown>) =>
      encodeFunctionData({ abi: KYBER_SWAP_ABI, functionName: 'swap', args: [{ ...args, desc: { ...args.desc, ...desc } }] });
    for (const bad of [
      tamper({ flags: args.desc.flags | 2n }),
      tamper({ feeReceivers: [TAKER], feeAmounts: [1n] }),
      tamper({ permit: '0x01' }),
    ]) {
      // Refused at the approval, which cannot bind to a swap it cannot read.
      expect(reasonOf(() => assertSponsorable(triple(USDC, 500_000n, bad), context(TAKER)))).not.toBe('ALLOWED');
      expect(() => decodeKyberSwap(bad)).toThrow();
      expect(readPinnedSwap(KYBER_ROUTER, bad)).toBeUndefined();
    }
  });

  it('unwraps after a KyberSwap swap that delivered WMON, as a swap into MON', () => {
    const batch = [...triple(USDC, 500_000n, swapToWmon), unwrap(1n)];
    expect(reasonOf(() => assertSponsorable(batch, context(TAKER)))).toBe('ALLOWED');
    expect(exemptionOf(batch, MARGIN)).toBe('swap-into-mon');
  });

  it('MON input (rule 1.8): wrap exactly the amount, then the WMON triple', () => {
    const amount = 100_000_000_000_000_000n;
    const batch = [wrap(amount), ...triple(WMON, amount, swapToUsdc)];
    expect(reasonOf(() => assertSponsorable(batch, context(TAKER)))).toBe('ALLOWED');
    // A counted swap: it spends MON, it does not deliver it.
    expect(exemptionOf(batch, MARGIN)).toBeUndefined();
    const short = [wrap(amount - 1n), ...triple(WMON, amount, swapToUsdc)];
    expect(reasonOf(() => assertSponsorable(short, context(TAKER)))).toBe('VALUE_NOT_ZERO');
  });

  it('WMON to MON from the trading balance: the margin withdrawal of exactly that WMON, then the unwrap', () => {
    const withdraw = (token: Address, amount: bigint) => {
      const built = buildWithdraw(MARGIN, token, amount);
      return { to: built.to, data: built.data };
    };
    const ok = [withdraw(WMON, 5n), unwrap(5n)];
    expect(reasonOf(() => assertSponsorable(ok, context(TAKER)))).toBe('ALLOWED');
    expect(exemptionOf(ok, MARGIN)).toBe('swap-into-mon');
    expect(reasonOf(() => assertSponsorable([withdraw(WMON, 4n), unwrap(5n)], context(TAKER)))).toBe(
      'SELECTOR_NOT_ALLOWED',
    );
    expect(reasonOf(() => assertSponsorable([withdraw(USDC, 5n), unwrap(5n)], context(TAKER)))).toBe(
      'SELECTOR_NOT_ALLOWED',
    );
  });

  it('reads Kyber calldata exactly', () => {
    const read = readPinnedSwap(KYBER_ROUTER, swapToWmon);
    expect(read?.tokenIn).toBe(getAddress(USDC));
    expect(read?.tokenOut).toBe(getAddress(WMON));
    expect(read?.amountIn).toBe(500_000n);
    expect(read?.recipient).toBe(TAKER);
  });
});
