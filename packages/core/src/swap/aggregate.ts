import { rankRoutes } from './rank.js';
import {
  VendorResponseError,
  type SwapQuoteRequest,
  type SwapTx,
  type SwapVendor,
  type SwapVendorId,
} from './types.js';

/** Rule 1.4: a vendor that has not answered within 2 s is absent. */
export const VENDOR_TIMEOUT_MS = 2_000;

/** Rule 1.4's sentence when nothing can route. */
export const NO_ROUTE_MESSAGE = 'No aggregator on Monad has a route for this pair right now.';

export interface VendorFailure {
  readonly vendor: SwapVendorId;
  readonly reason: string;
  /** The vendor's raw body when there was one. For the server log only, never a screen. */
  readonly rawBody?: string;
}

export interface AggregateResult {
  /** Every vendor that answered with a usable, checked transaction, best first. */
  readonly routes: readonly SwapTx[];
  /** Every vendor that did not, with why. Absent from the screen (rule 1.4). */
  readonly failures: readonly VendorFailure[];
}

/**
 * Ask every vendor at once. Each gets its own 2 s budget covering both its quote and its
 * build; one vendor's failure never delays or removes another's answer. A vendor that
 * throws, times out, or returns something that fails its own checks is recorded in
 * `failures` and left out of `routes`.
 */
export async function aggregateQuotes(
  vendors: readonly SwapVendor[],
  request: SwapQuoteRequest,
  options: { readonly timeoutMs?: number } = {},
): Promise<AggregateResult> {
  const timeoutMs = options.timeoutMs ?? VENDOR_TIMEOUT_MS;
  const settled = await Promise.all(
    vendors.map(async (vendor): Promise<SwapTx | VendorFailure> => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new VendorResponseError(vendor.id, `${vendor.displayName} did not answer within ${timeoutMs} ms`));
        }, timeoutMs);
      });
      try {
        const work = (async () => {
          const quote = await vendor.quote(request, controller.signal);
          return vendor.buildTx(quote, controller.signal);
        })();
        const tx = await Promise.race([work, deadline]);
        return tx;
      } catch (error) {
        return {
          vendor: vendor.id,
          reason: error instanceof Error ? error.message : String(error),
          ...(error instanceof VendorResponseError && error.rawBody !== undefined ? { rawBody: error.rawBody } : {}),
        };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }),
  );
  const routes: SwapTx[] = [];
  const failures: VendorFailure[] = [];
  for (const entry of settled) {
    if ('data' in entry) routes.push(entry);
    else failures.push(entry);
  }
  return { routes: rankRoutes(routes), failures };
}
