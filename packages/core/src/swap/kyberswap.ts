import { z } from 'zod';
import { getAddress, isAddress, isHex, type Address, type Hex } from 'viem';
import { decodeKyberSwap, KYBER_ROUTER, KYBER_SWAP_SELECTOR } from './kyberRouter.js';
import { minOutFor } from './minOut.js';
import {
  assertSwapRecipient,
  VendorResponseError,
  type SwapQuoteRequest,
  type SwapTx,
  type SwapVendor,
  type VendorQuote,
} from './types.js';

/**
 * KyberSwap aggregator on Monad, keyless (reports/SWAP-VERIFY.md): `GET routes`, then
 * `POST route/build`. The client id is a free-form identifier the docs ask for to get a
 * rate limit above the anonymous one; it is not a credential.
 *
 * Nothing Kyber returns is trusted on its word. The built calldata is decoded against
 * the router's verified ABI (`kyberRouter.ts`) and must carry this request's tokenIn,
 * tokenOut, amountIn, the taker as receiver, and this app's own minimum.
 */
export const KYBER_API = 'https://aggregator-api.kyberswap.com/monad/api/v1';
export const KYBER_CLIENT_ID = 'tradepro';
/** KyberSwap's documented maximum `slippageTolerance`. */
export const KYBER_MAX_SLIPPAGE_BPS = 2_000;

const addressString = z.string().refine((v) => isAddress(v), 'not an address');
const uintString = z.string().regex(/^\d+$/);

const routesSchema = z.object({
  code: z.literal(0),
  data: z.object({
    routerAddress: addressString,
    routeSummary: z
      .object({
        tokenIn: addressString,
        tokenOut: addressString,
        amountIn: uintString,
        amountOut: uintString,
        gas: uintString.optional(),
      })
      .passthrough(),
  }),
});

const buildSchema = z.object({
  code: z.literal(0),
  data: z.object({
    routerAddress: addressString,
    amountIn: uintString,
    amountOut: uintString,
    gas: uintString.optional(),
    transactionValue: uintString,
    data: z.string().refine((v) => isHex(v), 'not hex'),
  }),
});

interface KyberHandle {
  readonly routeSummary: Record<string, unknown>;
  readonly routerAddress: Address;
}

async function readJson(res: Response): Promise<{ body: unknown; raw: string }> {
  const raw = await res.text();
  try {
    return { body: JSON.parse(raw) as unknown, raw };
  } catch {
    throw new VendorResponseError('kyberswap', `KyberSwap returned HTTP ${res.status} with a body that is not JSON`, raw);
  }
}

export function kyberSwapVendor(options: { readonly fetchImpl?: typeof fetch } = {}): SwapVendor {
  const doFetch = options.fetchImpl ?? fetch;
  const headers = { 'X-Client-Id': KYBER_CLIENT_ID };

  return {
    id: 'kyberswap',
    displayName: 'KyberSwap',

    async quote(request: SwapQuoteRequest, signal: AbortSignal): Promise<VendorQuote> {
      const url = new URL(`${KYBER_API}/routes`);
      url.searchParams.set('tokenIn', request.tokenIn);
      url.searchParams.set('tokenOut', request.tokenOut);
      url.searchParams.set('amountIn', request.amountIn.toString());
      const res = await doFetch(url, { headers, signal });
      const { body, raw } = await readJson(res);
      const parsed = routesSchema.safeParse(body);
      if (!res.ok || !parsed.success) {
        throw new VendorResponseError('kyberswap', `KyberSwap routes answered HTTP ${res.status} without a usable route`, raw);
      }
      const { routeSummary, routerAddress } = parsed.data.data;
      if (getAddress(routerAddress) !== KYBER_ROUTER) {
        throw new VendorResponseError('kyberswap', `KyberSwap named router ${routerAddress}, not the pinned router`, raw);
      }
      if (
        getAddress(routeSummary.tokenIn) !== getAddress(request.tokenIn) ||
        getAddress(routeSummary.tokenOut) !== getAddress(request.tokenOut) ||
        BigInt(routeSummary.amountIn) !== request.amountIn
      ) {
        throw new VendorResponseError('kyberswap', 'KyberSwap quoted a different pair or amount than was asked', raw);
      }
      const expectedOut = BigInt(routeSummary.amountOut);
      if (expectedOut <= 0n) {
        throw new VendorResponseError('kyberswap', 'KyberSwap quoted zero output', raw);
      }
      return {
        vendor: 'kyberswap',
        request,
        expectedOut,
        minOut: minOutFor(expectedOut, request.slippageBps),
        ...(routeSummary.gas !== undefined ? { gasEstimate: BigInt(routeSummary.gas) } : {}),
        handle: { routeSummary, routerAddress: KYBER_ROUTER } satisfies KyberHandle,
      };
    },

    async buildTx(quote: VendorQuote, signal: AbortSignal): Promise<SwapTx> {
      const { request } = quote;
      const handle = quote.handle as KyberHandle;
      const res = await doFetch(`${KYBER_API}/route/build`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        signal,
        body: JSON.stringify({
          routeSummary: handle.routeSummary,
          sender: request.taker,
          recipient: request.taker,
          slippageTolerance: request.slippageBps,
          source: KYBER_CLIENT_ID,
        }),
      });
      const { body, raw } = await readJson(res);
      const parsed = buildSchema.safeParse(body);
      if (!res.ok || !parsed.success) {
        throw new VendorResponseError('kyberswap', `KyberSwap build answered HTTP ${res.status} without a transaction`, raw);
      }
      const built = parsed.data.data;
      if (getAddress(built.routerAddress) !== KYBER_ROUTER) {
        throw new VendorResponseError('kyberswap', `KyberSwap built for router ${built.routerAddress}, not the pinned router`, raw);
      }
      if (BigInt(built.transactionValue) !== 0n) {
        throw new VendorResponseError('kyberswap', 'KyberSwap built a swap that needs native MON sent with the call', raw);
      }
      const data = built.data as Hex;
      if (data.slice(0, 10).toLowerCase() !== KYBER_SWAP_SELECTOR) {
        throw new VendorResponseError('kyberswap', `KyberSwap built an unexpected call ${data.slice(0, 10)}`, raw);
      }
      const decoded = decodeKyberSwap(data);
      assertSwapRecipient(decoded.recipient, request.taker, 'kyberswap');
      if (
        decoded.tokenIn !== getAddress(request.tokenIn) ||
        decoded.tokenOut !== getAddress(request.tokenOut) ||
        decoded.amountIn !== request.amountIn
      ) {
        throw new VendorResponseError('kyberswap', 'KyberSwap calldata swaps a different pair or amount than was asked', raw);
      }
      const expectedOut = BigInt(built.amountOut);
      const minOut = minOutFor(expectedOut, request.slippageBps);
      if (decoded.minOut !== minOut) {
        throw new VendorResponseError(
          'kyberswap',
          `KyberSwap calldata enforces ${decoded.minOut}, not this app's minimum ${minOut}`,
          raw,
        );
      }
      return {
        vendor: 'kyberswap',
        router: KYBER_ROUTER,
        to: KYBER_ROUTER,
        data,
        value: 0n,
        tokenIn: decoded.tokenIn,
        tokenOut: decoded.tokenOut,
        amountIn: decoded.amountIn,
        recipient: decoded.recipient,
        expectedOut,
        minOut,
        ...(built.gas !== undefined ? { gasEstimate: BigInt(built.gas) } : {}),
      };
    },
  };
}
