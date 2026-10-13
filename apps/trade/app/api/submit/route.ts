import { NextResponse } from 'next/server';

/**
 * The submission route — a thin forwarder to the relayer's `/v1/bundler`.
 *
 * ## Why this is three lines of proxying and not the real logic
 *
 * A user operation is signed by its sender, and the sender is the user's own
 * passkey-derived key, which exists only in their browser. This server cannot sign it.
 * So the browser keeps the exact sequence `scripts/m0-live.ts` proved on mainnet and
 * points its bundler transport here.
 *
 * Everything that must be enforced — the mode gate, the sponsor policy, the caps, the
 * EntryPoint top-up — happens in the **relayer**, because that is where the keys and
 * the ledgers already live. `apps/trade/next.config.mjs` copies an explicit allowlist
 * of environment variables precisely so that no key material enters the web server's
 * process, and putting the relayer key or the bundler key here to save a hop would
 * undo that on purpose.
 *
 * So this route exists for one reason: to keep the browser talking to its own origin.
 * It adds no authority of its own and can grant nothing the relayer would refuse.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const RELAYER = process.env.RELAYER_URL ?? 'http://127.0.0.1:8787';

export async function POST(request: Request) {
  // Next does not expose the socket address; the proxy in front sets these.
  const clientAddress =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip')?.trim() ||
    '';

  const body = await request.text();
  try {
    const upstream = await fetch(`${RELAYER}/v1/bundler`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        /**
         * The caller's address, so the relayer's per-IP limit is per caller.
         *
         * Without it every browser request reaches the relayer from this server's one
         * address, which collapses a per-IP budget into a global one: users throttle
         * each other and an attacker has the whole budget. The relayer reads only the
         * first hop and only from this header.
         */
        ...(clientAddress ? { 'x-forwarded-for': clientAddress } : {}),
      },
      body,
    });
    return new NextResponse(await upstream.text(), {
      status: upstream.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  } catch {
    // The relayer being down is an operational fact, not a user error, and the copy
    // says so rather than blaming the tap.
    return NextResponse.json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32000, message: 'The relayer is not reachable, so nothing was sent.' },
    });
  }
}
