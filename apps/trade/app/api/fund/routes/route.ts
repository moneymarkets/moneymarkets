import { NextResponse } from 'next/server';
import { getAddress, isAddress } from 'viem';
import {
  destinationAsset,
  resolveSources,
  RouteListUnavailable,
} from '../../../../lib/server/aurora';
import { probeSource, type RouteProbe } from '../../../../lib/server/probe';

/**
 * Which funding routes the solver network can actually deliver right now.
 *
 * The screen calls this before it draws a single tile. A source with no live asset
 * id is returned with the reason rather than dropped, because a tile that quietly
 * disappears teaches the user nothing — and a tile that appears without a live id
 * behind it would be an offer the app cannot keep.
 *
 * With `?recipient=<Monad address>`, each Intents source is additionally probed with
 * one dry quote (60-second cached, see `lib/server/probe.ts`) so the tiles carry the
 * route's live state — available, a minimum in the network's own words, or
 * unavailable with its verbatim reason — before the user types anything
 * (error-handling rule, 2026-09-08 items 2-3).
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const recipientRaw = url.searchParams.get('recipient')?.trim();
  const recipient =
    recipientRaw && isAddress(recipientRaw) ? getAddress(recipientRaw) : undefined;

  try {
    const sources = await resolveSources();
    const probes = new Map<string, RouteProbe>();
    if (recipient) {
      await Promise.all(
        sources
          .filter((s) => s.route === 'intents' && s.assetId)
          .map(async (s) => {
            probes.set(s.key, await probeSource(s, recipient));
          }),
      );
    }
    return NextResponse.json(
      {
        sources: sources.map((s) => {
          const probe = probes.get(s.key);
          return probe ? { ...s, probe } : s;
        }),
        destination: destinationAsset(),
        readAt: Date.now(),
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    if (error instanceof RouteListUnavailable) {
      console.error('1Click token list unavailable', error.message);
      return NextResponse.json(
        {
          error: 'ROUTE_LIST_UNAVAILABLE',
          upstream: { message: error.message },
        },
        { status: 502 },
      );
    }
    console.error('route list failed', error);
    return NextResponse.json(
      {
        error: 'ROUTE_LIST_UNAVAILABLE',
        upstream: { message: error instanceof Error ? error.message : String(error) },
      },
      { status: 502 },
    );
  }
}
