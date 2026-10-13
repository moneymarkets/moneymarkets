import type { Address, Hex } from 'viem';

/**
 * Swap aggregators behind one interface, the same shape as funding's `Rail`
 * (`funding/types.ts`): quote, then build. Each vendor answers for itself; the
 * orchestrator (`aggregate.ts`) ranks what answered and never trusts one vendor's
 * figure for another's.
 *
 * Verified before build: reports/SWAP-VERIFY.md.
 */

export type SwapVendorId = 'kyberswap' | 'kuru-flow';

export interface SwapQuoteRequest {
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  /** Base units of `tokenIn`. */
  readonly amountIn: bigint;
  /** The signed-in account. Always the taker and always the recipient (R4). */
  readonly taker: Address;
  /** The user's chosen slippage, in basis points. Minimum out is computed from it here,
   *  never taken from a vendor default. */
  readonly slippageBps: number;
}

/** What a vendor answered before any transaction was built. */
export interface VendorQuote {
  readonly vendor: SwapVendorId;
  readonly request: SwapQuoteRequest;
  /** The vendor's own expected output, base units of `tokenOut`. */
  readonly expectedOut: bigint;
  /** This app's minimum, `minOutFor(expectedOut, request.slippageBps)`. */
  readonly minOut: bigint;
  /** The vendor's own gas estimate, when it gives one. Ranking tiebreak only. */
  readonly gasEstimate?: bigint;
  /** Vendor-private state `buildTx` needs (Kyber's routeSummary, Flow's calldata). */
  readonly handle: unknown;
}

/** A signable swap call, checked against the request before it leaves the vendor. */
export interface SwapTx {
  readonly vendor: SwapVendorId;
  /** The pinned router this call targets. Equal to `to`, asserted. */
  readonly router: Address;
  readonly to: Address;
  readonly data: Hex;
  /** Always 0: native value is never sent to an aggregator by this app. */
  readonly value: bigint;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountIn: bigint;
  readonly recipient: Address;
  readonly expectedOut: bigint;
  /** The minimum the calldata itself enforces, read back from the bytes. */
  readonly minOut: bigint;
  readonly gasEstimate?: bigint;
}

export interface SwapVendor {
  readonly id: SwapVendorId;
  /** As the user sees it: "via KyberSwap". */
  readonly displayName: string;
  quote(request: SwapQuoteRequest, signal: AbortSignal): Promise<VendorQuote>;
  buildTx(quote: VendorQuote, signal: AbortSignal): Promise<SwapTx>;
}

/** Thrown by a vendor for a response that must not be used. Carries the raw body so
 *  the server can log it (rule 1.4) without ever showing a fragment to a user. */
export class VendorResponseError extends Error {
  constructor(
    readonly vendor: SwapVendorId,
    message: string,
    readonly rawBody?: string,
  ) {
    super(message);
    this.name = 'VendorResponseError';
  }
}

export const SWAP_VENDOR_NAMES: Readonly<Record<SwapVendorId, string>> = {
  kyberswap: 'KyberSwap',
  'kuru-flow': 'Kuru Flow',
};

/** R4: taker and recipient are the signed-in account, checked before a quote is used
 *  and again before a transaction is returned. */
export function assertSwapRecipient(recipient: Address, taker: Address, vendor: SwapVendorId): void {
  if (recipient.toLowerCase() !== taker.toLowerCase()) {
    throw new VendorResponseError(
      vendor,
      `${SWAP_VENDOR_NAMES[vendor]} built a swap paying ${recipient}, not the signed-in account ${taker}`,
    );
  }
}
