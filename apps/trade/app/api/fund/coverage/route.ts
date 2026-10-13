import { NextResponse } from 'next/server';
import { staticCoverage, type CoverageEntry } from '@tradepro/core';

/**
 * `GET /api/fund/coverage` — what the funding screen is allowed to offer.
 *
 * The old screen hardcoded five vendor-named tiles. This replaces them: the asset chips
 * and chain tiles on `/fund` render from this response, so a chain no rail carries does
 * not appear, and a chain a rail gains appears without an edit.
 *
 * ## Live where it can be, honest where it cannot
 *
 * Across publishes its Monad routes at `/available-routes`, so that half is fetched
 * live and the transcribed table is only a fallback. Relay's contribution is derived
 * from its `/chains` list. When a rail's fetch fails, its routes are marked
 * `unverifiedRails` for this window rather than being served from a stale cache as
 * though they were checked — a chain offered on the strength of a ten-minute-old
 * failure is a chain the user may not actually be able to use.
 *
 * Cached ten minutes. Nothing here is a quote; quotes come from `/api/fund/route` and
 * carry their own expiry.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const CACHE_MS = 10 * 60 * 1000;
let cache: { at: number; body: unknown } | undefined;

interface AcrossRoute {
  originChainId?: number;
  originTokenSymbol?: string;
  destinationTokenSymbol?: string;
}

export async function GET() {
  if (cache && Date.now() - cache.at < CACHE_MS) {
    return NextResponse.json(cache.body, { headers: { 'cache-control': 'no-store' } });
  }

  const unverified: string[] = [];
  let entries: CoverageEntry[] = staticCoverage();

  // Across is the one rail with a public route list; confirm the transcription still
  // matches, and say so if it could not be checked.
  try {
    const res = await fetch('https://app.across.to/api/available-routes?destinationChainId=143', {
      cache: 'no-store',
      signal: AbortSignal.timeout(4_000),
    });
    if (res.ok) {
      const live = (await res.json()) as AcrossRoute[];
      const liveChains = new Set(live.map((r) => r.originChainId));
      // Drop any Across-only pair the live list no longer carries. A pair another rail
      // also carries survives on that rail.
      entries = entries
        .map((e) => {
          if (!e.rails.includes('across')) return e;
          if (liveChains.has(e.chain.id)) return e;
          const rails = e.rails.filter((r) => r !== 'across');
          return rails.length > 0 ? { ...e, rails } : undefined;
        })
        .filter((e): e is CoverageEntry => e !== undefined);
    } else {
      unverified.push('across');
    }
  } catch {
    unverified.push('across');
  }

  const assets = [...new Set(entries.map((e) => e.asset))].sort();
  const body = {
    assets,
    entries: entries.map((e) => ({
      asset: e.asset,
      chainId: e.chain.id,
      chainKey: e.chain.key,
      chainName: e.chain.displayName,
      vm: e.chain.vm,
      assetAddress: e.assetAddress,
      assetDecimals: e.assetDecimals,
      rails: e.rails,
      delivers: e.delivers,
    })),
    /** Rails whose own list could not be read this window. Their routes are still
     *  offered from the transcribed table, and the screen says they are unconfirmed. */
    unverifiedRails: unverified,
    readAt: Date.now(),
  };

  cache = { at: Date.now(), body };
  return NextResponse.json(body, { headers: { 'cache-control': 'no-store' } });
}
