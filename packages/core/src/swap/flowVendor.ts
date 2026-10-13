import type { Address } from 'viem';
import { KuruFlowClient, KURU_FLOW_ROUTER, type FlowQuote } from '../kuru/flow.js';
import { minOutFor } from './minOut.js';
import {
  VendorResponseError,
  type SwapQuoteRequest,
  type SwapTx,
  type SwapVendor,
  type VendorQuote,
} from './types.js';

/**
 * Kuru Flow as a swap vendor. The existing client already refuses a quote whose
 * calldata words disagree with its JSON (`assertFlowQuoteMatchesRequest`: tokenIn,
 * tokenOut, amount, minOut). This adds the one thing rule 1.2 needs on top: the minimum
 * in those bytes is this app's own, `minOutFor(output, slippageBps)`, not Flow's.
 *
 * Recipient (R4): Flow pays the address that submits the call, which under EIP-7702 is
 * the account itself, and the quote is requested with `userAddress` = the taker. There is
 * no separate recipient word to read back, so the taker is the only address involved.
 */
export interface FlowVendorOptions {
  readonly referrerAddress?: Address;
  readonly referrerFeeBps?: number;
  readonly fetchImpl?: typeof fetch;
}

export function flowVendor(options: FlowVendorOptions = {}): SwapVendor {
  return {
    id: 'kuru-flow',
    displayName: 'Kuru Flow',

    async quote(request: SwapQuoteRequest, signal: AbortSignal): Promise<VendorQuote> {
      const baseFetch = options.fetchImpl ?? fetch;
      const client = new KuruFlowClient({
        ...(options.referrerAddress ? { referrerAddress: options.referrerAddress } : {}),
        ...(options.referrerFeeBps !== undefined ? { referrerFeeBps: options.referrerFeeBps } : {}),
        fetchImpl: (input, init) => baseFetch(input, { ...init, signal }),
      });
      let quote: FlowQuote;
      try {
        quote = await client.quote({
          userAddress: request.taker,
          tokenIn: request.tokenIn,
          tokenOut: request.tokenOut,
          amount: request.amountIn,
          slippageTolerance: request.slippageBps,
        });
      } catch (error) {
        throw new VendorResponseError('kuru-flow', error instanceof Error ? error.message : String(error));
      }
      if (quote.to.toLowerCase() !== KURU_FLOW_ROUTER.toLowerCase()) {
        throw new VendorResponseError('kuru-flow', `Kuru Flow routed to ${quote.to}, not the pinned router`);
      }
      if (quote.value !== 0n) {
        throw new VendorResponseError('kuru-flow', 'Kuru Flow returned a route that needs native MON sent with the call');
      }
      const minOut = minOutFor(quote.output, request.slippageBps);
      if (quote.minOut !== minOut) {
        throw new VendorResponseError(
          'kuru-flow',
          `Kuru Flow's minimum ${quote.minOut} is not this app's ${minOut} for ${request.slippageBps} bps`,
        );
      }
      return { vendor: 'kuru-flow', request, expectedOut: quote.output, minOut, handle: quote };
    },

    async buildTx(vendorQuote: VendorQuote): Promise<SwapTx> {
      const quote = vendorQuote.handle as FlowQuote;
      const { request } = vendorQuote;
      return {
        vendor: 'kuru-flow',
        router: KURU_FLOW_ROUTER,
        to: quote.to,
        data: quote.calldata,
        value: 0n,
        tokenIn: request.tokenIn,
        tokenOut: request.tokenOut,
        amountIn: request.amountIn,
        recipient: request.taker,
        expectedOut: vendorQuote.expectedOut,
        minOut: vendorQuote.minOut,
      };
    },
  };
}
