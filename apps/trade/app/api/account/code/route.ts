import { NextResponse } from 'next/server';
import { getAddress, isAddress } from 'viem';
import { readClient } from '../../../../lib/server/chain';

/**
 * Does this address have code?
 *
 * Asked before a send, so the user can be warned that the recipient is a contract and
 * may not be able to receive tokens. It is a **warning**, never a block — plenty of
 * contracts receive tokens perfectly well, and refusing them would be this app
 * deciding something the user is entitled to decide.
 *
 * A read that fails answers `null`, not `false`: "we could not tell" and "it is a
 * plain account" are different facts, and only one of them is safe to imply.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get('address') ?? '';
  if (!isAddress(raw)) return NextResponse.json({ error: 'NOT_AN_ADDRESS' }, { status: 400 });
  const address = getAddress(raw);
  try {
    const code = await readClient().getCode({ address });
    return NextResponse.json(
      { address, hasCode: code !== undefined && code !== '0x' },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    console.error('code read failed', address, error);
    return NextResponse.json(
      {
        address,
        hasCode: null,
        upstream: {
          source: 'Monad RPC',
          message:
            error instanceof Error
              ? (error.message.split('\n')[0]?.trim() ?? 'no reason given')
              : String(error),
        },
      },
      { status: 502 },
    );
  }
}
