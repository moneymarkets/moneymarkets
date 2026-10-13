import { NextResponse } from 'next/server';
import { z } from 'zod';
import { depositDb } from '../../../../lib/server/deposits/db';
import { sourceBalance } from '../../../../lib/server/deposits/chains';
import { resolveSources } from '../../../../lib/server/aurora';

/**
 * The refund wallet's balance right now — the "after" half of the terminal card's
 * before/after (D105 item 3). Read live rather than cached: this is called once,
 * when a deposit reaches a terminal state, not on a poll.
 *
 * `depositAddress` is validated with zod (audit M6). It is not always an EVM address —
 * a Solana or Tron deposit address has its own shape — so the check is a bound on
 * length and character set rather than `isAddress`, wide enough for every rail this
 * app issues and narrow enough that nothing absurd reaches `depositDb()`.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const querySchema = z.object({
  depositAddress: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[0-9a-zA-Z-]+$/),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    depositAddress: url.searchParams.get('depositAddress')?.trim() ?? '',
  });
  if (!parsed.success) {
    return NextResponse.json({ error: 'BAD_REQUEST' }, { status: 400 });
  }
  const attempt = depositDb().attempt(parsed.data.depositAddress);
  if (!attempt) return NextResponse.json({ error: 'UNKNOWN_DEPOSIT' }, { status: 404 });

  let after: string | null = null;
  try {
    let contract: string | undefined;
    if (attempt.chain !== 'Solana') {
      const sources = await resolveSources();
      contract = sources.find((s) => s.key === attempt.sourceKey)?.contractAddress;
    }
    const balance = await sourceBalance(attempt.chain, attempt.refundTo, contract);
    after = balance.toString();
  } catch (error) {
    console.error('balance read failed', error);
  }

  return NextResponse.json(
    { before: attempt.refundBalanceBefore, after, chain: attempt.chain, decimals: attempt.originDecimals },
    { headers: { 'cache-control': 'no-store' } },
  );
}
