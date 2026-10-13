import { NextResponse } from 'next/server';

/**
 * `POST /api/gas/quote` — a thin proxy to the relayer's `POST /v1/gas/quote`.
 *
 * Same shape as `/api/submit`'s proxy to `/v1/bundler`: this route holds no key and
 * adds no authority, it only keeps the browser talking to its own origin and passes
 * the caller's real address through `x-forwarded-for` so the relayer's per-IP quote
 * budget (`db.hitRateLimit(clientIp(req), 'quote', …)`) is per caller rather than
 * collapsing into this server's one address.
 *
 * The request body is passed through byte-for-byte — `gasQuoteBodySchema` in the
 * relayer is what validates it, not this route.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const RELAYER = process.env.RELAYER_URL ?? 'http://127.0.0.1:8787';

export async function POST(request: Request) {
  const clientAddress =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip')?.trim() ||
    '';

  const body = await request.text();
  try {
    const upstream = await fetch(`${RELAYER}/v1/gas/quote`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(clientAddress ? { 'x-forwarded-for': clientAddress } : {}),
      },
      body,
    });
    return new NextResponse(await upstream.text(), {
      status: upstream.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  } catch (error) {
    // The relayer being unreachable is an operational fact, not something the quote
    // shape can express — the caller treats a non-2xx/unreadable body as "no quote"
    // and hides the fee line rather than fabricating one.
    return NextResponse.json(
      {
        error: 'RELAYER_UNREACHABLE',
        upstream: {
          source: 'relayer',
          message: error instanceof Error ? error.message.split('\n')[0] : String(error),
        },
      },
      { status: 502, headers: { 'cache-control': 'no-store' } },
    );
  }
}
