import { KuruFlowClient } from '@tradepro/core';
import type { Address } from 'viem';

/**
 * A live Kuru Flow quote's implied dollar price for one whole unit of a token, by
 * address (spec A4: "every other token from a Kuru Flow quote of one unit to USDC,
 * cached 30 seconds, requested lazily when the row is on screen"). Whether or not any
 * list names the token: Flow routes by address.
 *
 * Same stale-while-revalidate shape as `kuruMarketMeta.ts`, both so a slow or
 * rate-limited Flow API (documented 1 rps, burst 1, in `kuru/flow.ts`) never blocks
 * a balance read, and so two requests in the same tick cannot fire two quotes for the
 * same token. `awaitFlowUsdPerWhole` is for the lazy per-row price route, which is
 * asked precisely because the row is on screen and waiting.
 *
 * Moved out of `/api/account/balances` unchanged.
 */
export const FLOW_PRICE_TTL_MS = 30_000;
const flowPriceCache = new Map<string, { at: number; usdPerWhole: bigint | undefined }>();
const flowPriceInflight = new Map<string, Promise<bigint | undefined>>();

async function fetchFlowUsdPerWhole(
  token: Address,
  decimals: number,
  account: Address,
  usdcAddress: Address,
): Promise<bigint | undefined> {
  try {
    const client = new KuruFlowClient();
    const quote = await client.quote({
      userAddress: account,
      tokenIn: token,
      tokenOut: usdcAddress,
      amount: 10n ** BigInt(decimals),
    });
    // Flow quotes USDC out, six decimals: already the cap unit, no rescale needed.
    return quote.output;
  } catch {
    return undefined;
  }
}

function refresh(token: Address, decimals: number, account: Address, usdcAddress: Address): Promise<bigint | undefined> {
  const key = token.toLowerCase();
  const inflight = flowPriceInflight.get(key);
  if (inflight) return inflight;
  const next = fetchFlowUsdPerWhole(token, decimals, account, usdcAddress)
    .then((usdPerWhole) => {
      flowPriceCache.set(key, { at: Date.now(), usdPerWhole });
      return usdPerWhole;
    })
    .finally(() => {
      flowPriceInflight.delete(key);
    });
  flowPriceInflight.set(key, next);
  return next;
}

/**
 * Read-only: whatever the lazy price route last learned for this token, fresh or
 * stale, without asking Flow. The balance read uses this so a row that was priced on
 * screen keeps its figure in the total between polls, while the polling itself never
 * fires a Flow quote for every token of every account (the API allows one request a
 * second).
 */
export function flowUsdPerWholePeek(token: Address): bigint | undefined {
  return flowPriceCache.get(token.toLowerCase())?.usdPerWhole;
}

/** Non-blocking: the cached price if any, refreshing in the background when stale. */
export function flowUsdPerWholeCached(
  token: Address,
  decimals: number,
  account: Address,
  usdcAddress: Address,
): bigint | undefined {
  const hit = flowPriceCache.get(token.toLowerCase());
  if (hit && Date.now() - hit.at < FLOW_PRICE_TTL_MS) return hit.usdPerWhole;
  void refresh(token, decimals, account, usdcAddress);
  return hit?.usdPerWhole;
}

/** Blocking on a cold cache: for the lazy per-row price route. */
export async function awaitFlowUsdPerWhole(
  token: Address,
  decimals: number,
  account: Address,
  usdcAddress: Address,
): Promise<bigint | undefined> {
  const hit = flowPriceCache.get(token.toLowerCase());
  if (hit && Date.now() - hit.at < FLOW_PRICE_TTL_MS) return hit.usdPerWhole;
  return refresh(token, decimals, account, usdcAddress);
}
