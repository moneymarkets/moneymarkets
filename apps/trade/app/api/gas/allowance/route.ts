import { NextResponse } from 'next/server';
import { isAddress } from 'viem';

/**
 * `GET /api/gas/allowance?address=0x…` — a thin proxy to the relayer's
 * `GET /v1/gas/allowance`, following the same shape as `/api/limits`: same-origin so
 * the browser never talks cross-origin to the relayer directly, and `caps: null`
 * (here: a body with no `allowance`) rather than a guess when the relayer cannot be
 * reached.
 *
 * This is a read of the relayer's own free-action ledger, not a chain read — see
 * `/v1/gas/allowance`'s own doc comment in `apps/relayer/src/server.ts` ("no chain
 * read, so a banner can ask for it with every balance refresh"). No caching here
 * beyond what the relayer itself does: a banner or a ring that shows a stale "free
 * actions remaining" count is exactly the kind of wrong number this app does not
 * show (rule: never render an unread figure as a real one).
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const RELAYER = process.env.RELAYER_URL ?? 'http://127.0.0.1:8787';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const address = url.searchParams.get('address') ?? '';
  if (!isAddress(address)) {
    return NextResponse.json({ error: 'NOT_AN_ADDRESS' }, { status: 400 });
  }

  try {
    const upstream = await fetch(`${RELAYER}/v1/gas/allowance?address=${address}`, {
      cache: 'no-store',
    });
    if (!upstream.ok) {
      return NextResponse.json(
        { allowance: null, source: 'relayer', status: upstream.status },
        { headers: { 'cache-control': 'no-store' } },
      );
    }
    const body = (await upstream.json()) as unknown;
    return NextResponse.json(
      { allowance: body, source: 'relayer' },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    return NextResponse.json(
      {
        allowance: null,
        source: 'relayer',
        // The upstream's own words, never a substitute sentence (D124).
        upstream: {
          source: 'relayer',
          message:
            error instanceof Error
              ? (error.message.split('\n')[0]?.trim() ?? 'no reason given')
              : String(error),
        },
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  }
}
