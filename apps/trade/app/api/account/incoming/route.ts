import { NextResponse } from 'next/server';
import { getAddress, isAddress, type Address } from 'viem';
import { addresses, readClient } from '../../../../lib/server/chain';
import { findMostRecentTransferUnattributed } from '../../../../lib/server/deposits/destination';

/**
 * The transaction that most recently moved a token INTO this account.
 *
 * A direct deposit is noticed by the wallet balance going up, which tells the app that
 * something arrived but not what transaction brought it. This finds that transaction so
 * the arrival can carry a real explorer link instead of an amount with no provenance.
 *
 * ## The window is small, and it is stated rather than hidden
 *
 * The public Monad RPC caps `eth_getLogs` at a **100-block range** — measured, recorded
 * as C2 and pinned in `PUBLIC_RPC_GET_LOGS_MAX_RANGE`. At ~400 ms blocks that is about
 * forty seconds of history per request. This route scans a few of those windows back
 * from the head and no further. It is the right tool for "the deposit that landed while
 * the card was open" and the wrong one for history — which is why nothing here builds
 * one. The activity feed is written at the moment each thing happens (`lib/activity.ts`);
 * this route only ever names a transaction the app already knows arrived, and an
 * arrival it cannot name is still recorded, marked as having no known hash.
 *
 * `Transfer(address,address,uint256)` indexes `to`, so the filter is a topic match and
 * the node does the work — no scanning of unrelated logs.
 *
 * Returns `{ txHash: null }` when nothing matched. That is not an error: a balance can
 * rise from a transfer older than the window, and saying "no transaction found in the
 * last N blocks" is true where inventing one would not be.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const accountRaw = url.searchParams.get('address') ?? '';
  const tokenRaw = url.searchParams.get('token') ?? '';
  if (!isAddress(accountRaw) || !isAddress(tokenRaw)) {
    return NextResponse.json({ error: 'BAD_REQUEST' }, { status: 400 });
  }
  const account = getAddress(accountRaw);
  const token = getAddress(tokenRaw);

  // Only tokens this app actually offers. An arbitrary address here would turn this
  // into a log-scanning proxy for anything.
  const chain = addresses();
  const known = Object.values(chain.tokens)
    .map((t) => (t as { address?: Address }).address)
    .filter(
      (a): a is Address =>
        typeof a === 'string' && a !== '0x0000000000000000000000000000000000000000',
    )
    .map((a) => a.toLowerCase());
  if (!known.includes(token.toLowerCase())) {
    return NextResponse.json({ error: 'UNKNOWN_TOKEN' }, { status: 404 });
  }

  try {
    const client = readClient();
    // Deliberately the unattributed scan (`destination.ts`), not the deposit
    // tracker's `findIncomingTransfer` — this route already knows a balance rose some
    // other way and only wants a transaction to link to it, so it carries none of the
    // tracker's amount-tolerance attribution requirement and must never be used as
    // deposit-tracker evidence (security review finding H1).
    const found = await findMostRecentTransferUnattributed(client, account, token);
    if (found) {
      return NextResponse.json(
        {
          txHash: found.hash,
          blockNumber: found.block,
          value: found.amount ?? null,
        },
        { headers: { 'cache-control': 'no-store' } },
      );
    }

    return NextResponse.json(
      { txHash: null },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    console.error('incoming transfer lookup failed', account, token, error);
    // The upstream's own words, never a substitute sentence (D124).
    return NextResponse.json(
      {
        error: 'INCOMING_LOOKUP_FAILED',
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
