import { MARKET_CANDIDATES } from '@tradepro/core';
import type { Address } from 'viem';
import { z } from 'zod';

/**
 * Kuru's own per-market data (`GET /api/v1/markets/<address>`): icons and
 * `priceChange24h` for the tokens each market names as its base and quote.
 *
 * Confirmed live 2026-09-24 by curl against every trading and disabled candidate:
 * the response carries a real `priceChange24h` and `basetoken.imageurl` /
 * `quotetoken.imageurl`. There is no candles or OHLC endpoint (every guessable path
 * answered Express's "Cannot GET"), so no sparkline is built anywhere.
 *
 * Cached and refreshed in the background, never awaited by a balance read: the same
 * stale-while-revalidate shape `listedByKuru` uses in `@tradepro/core`'s
 * `liveMarkets.ts`, so a slow or unreachable Kuru never adds latency to a chain read.
 * `undefined` on a cold cache; callers render `null` for what they do not have.
 *
 * Moved out of `/api/account/balances` unchanged so the token registry can share it.
 */
export interface KuruMarketMeta {
  readonly priceChange24h: number | null;
  readonly baseIconUrl: string | null;
  readonly quoteIconUrl: string | null;
}

const kuruMarketMetaSchema = z.object({
  success: z.literal(true),
  data: z.object({
    priceChange24h: z.number().optional(),
    basetoken: z.object({ imageurl: z.string().nullable().optional() }).optional(),
    quotetoken: z.object({ imageurl: z.string().nullable().optional() }).optional(),
  }),
});

export const KURU_META_TTL_MS = 30_000;
const KURU_META_TIMEOUT_MS = 5_000;
const kuruMetaCache = new Map<string, { at: number; meta: KuruMarketMeta }>();
const kuruMetaInflight = new Map<string, Promise<void>>();

async function fetchKuruMarketMeta(market: Address, restApi: string): Promise<KuruMarketMeta | undefined> {
  try {
    const res = await fetch(`${restApi}/api/v1/markets/${market.toLowerCase()}`, {
      signal: AbortSignal.timeout(KURU_META_TIMEOUT_MS),
    });
    if (res.status !== 200) return undefined;
    const parsed = kuruMarketMetaSchema.safeParse(await res.json());
    if (!parsed.success) return undefined;
    return {
      priceChange24h: parsed.data.data.priceChange24h ?? null,
      baseIconUrl: parsed.data.data.basetoken?.imageurl ?? null,
      quoteIconUrl: parsed.data.data.quotetoken?.imageurl ?? null,
    };
  } catch {
    return undefined;
  }
}

export function kuruMarketMetaCached(market: Address, restApi: string): KuruMarketMeta | undefined {
  const key = market.toLowerCase();
  const hit = kuruMetaCache.get(key);
  if (hit && Date.now() - hit.at < KURU_META_TTL_MS) return hit.meta;
  if (!kuruMetaInflight.has(key)) {
    const inflight = fetchKuruMarketMeta(market, restApi)
      .then((meta) => {
        if (meta) kuruMetaCache.set(key, { at: Date.now(), meta });
      })
      .finally(() => {
        kuruMetaInflight.delete(key);
      });
    kuruMetaInflight.set(key, inflight);
  }
  return hit?.meta;
}

/**
 * Logo URL by lowercased token address, from whatever market metadata is cached right
 * now. Never blocks: a cold entry is simply absent this time and present once its
 * background refresh lands.
 */
export function logoByAddressFromMarkets(restApi: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const candidate of MARKET_CANDIDATES) {
    const meta = kuruMarketMetaCached(candidate.address, restApi);
    if (!meta) continue;
    if (meta.baseIconUrl) out.set(candidate.params.baseAsset.toLowerCase(), meta.baseIconUrl);
    if (meta.quoteIconUrl) out.set(candidate.params.quoteAsset.toLowerCase(), meta.quoteIconUrl);
  }
  return out;
}
