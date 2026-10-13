import { NextResponse } from 'next/server';

/**
 * The limits the relayer will actually enforce, asked of the relayer.
 *
 * A screen that refuses an amount has to refuse it for the real reason. The notional
 * cap is `MAX_ORDER_NOTIONAL_AUSD` in code, but the environment is allowed to *tighten*
 * it (`tighten()` in `packages/core/src/chain/caps.ts`), so a constant compiled into the
 * browser bundle would eventually say $6 while the deployment enforced $2. This asks the
 * process that does the enforcing.
 *
 * `/v1/health` rather than `/v1/status`: the relayer has no `/v1/status`, and asking
 * for one returned a 404 that this route dutifully reported as `caps: null` — correct
 * behaviour hiding a wrong URL, which is exactly why it was checked against the live
 * service rather than assumed.
 *
 * When the relayer cannot be reached this returns `caps: null` rather than a guess. The
 * caller then applies no limit of its own and lets the relayer's own refusal arrive
 * verbatim — late, but true. A made-up limit shown early would be neither.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const RELAYER = process.env.RELAYER_URL ?? 'http://127.0.0.1:8787';

export async function GET() {
  try {
    const upstream = await fetch(`${RELAYER}/v1/health`, { cache: 'no-store' });
    if (!upstream.ok) {
      return NextResponse.json(
        { caps: null, source: 'relayer', status: upstream.status },
        { headers: { 'cache-control': 'no-store' } },
      );
    }
    const body = (await upstream.json()) as {
      caps?: { maxOrderNotionalAusd?: string; liveMarkets?: string[] };
    };
    return NextResponse.json(
      { caps: body.caps ?? null, source: 'relayer' },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    return NextResponse.json(
      {
        caps: null,
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
