import { NextResponse } from 'next/server';
import { getAddress, isAddress } from 'viem';
import { runDiscoveryTick } from '../../../../../lib/server/tokens/tokenDiscoveryLive';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * One bounded tick of holdings discovery for an account (spec A2b). Called by the
 * balances hook on its own cadence, never inline in a balance read, so a slow log
 * scan can never delay the figures on screen. Idempotent: the cursor is persisted per
 * page, so calling it again continues where the last call stopped.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const raw = url.searchParams.get('address') ?? '';
  if (!isAddress(raw)) return NextResponse.json({ error: 'NOT_AN_ADDRESS' }, { status: 400 });
  const account = getAddress(raw);
  try {
    const result = await runDiscoveryTick(account);
    return NextResponse.json(
      {
        address: account,
        pagesScanned: result.pagesScanned,
        discovered: result.discovered,
        nextBlock: result.nextBlock.toString(),
        caughtUp: result.caughtUp,
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    console.error('token discovery tick failed', account, error);
    return NextResponse.json(
      { error: 'SCAN_FAILED', upstream: { message: error instanceof Error ? error.message : String(error), source: 'Monad RPC' } },
      { status: 502 },
    );
  }
}
