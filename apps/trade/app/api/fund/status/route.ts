import { NextResponse } from 'next/server';
import {
  asSwapStatus,
  expiryFrom,
  isRequotable,
  isTerminalSwapStatus,
  oneClickStatusSchema,
  refundReasonCopy,
  statusUrl,
  swapStepIndex,
} from '@tradepro/core';
import { depositDb } from '../../../../lib/server/deposits/db';

/**
 * Where a deposit has got to.
 *
 * A thin read-through to `GET https://1click.chaindefuser.com/v0/status`, with the
 * status classified server-side so the screen never has to know the network's
 * vocabulary. It is a read: nothing here can move, reserve or refund anything.
 *
 * The deposit address is the only identifier the status endpoint takes, and it is
 * public by construction — it is the address the user is told to send to. It is
 * still not logged with the account it belongs to.
 *
 * `expiresAt` is passed in by the caller because the deadline lives on the quote, not
 * on the status. Once it passes with nothing received, the answer is `EXPIRED`, which
 * is **non-terminal**: nothing was sent, and the way out is a new quote.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const depositAddress = url.searchParams.get('depositAddress')?.trim() ?? '';
  if (depositAddress === '' || depositAddress.length > 128 || /[\s?&#]/.test(depositAddress)) {
    return NextResponse.json({ error: 'BAD_REQUEST' }, { status: 400 });
  }
  const expiresRaw = url.searchParams.get('expiresAt');
  const expiresAt =
    expiresRaw && /^\d+$/.test(expiresRaw) ? Number.parseInt(expiresRaw, 10) : undefined;

  let res: Response;
  try {
    res = await fetch(statusUrl(depositAddress), {
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
    });
  } catch (error) {
    console.error('1Click status request failed', error);
    return NextResponse.json({ error: 'STATUS_UNAVAILABLE' }, { status: 504 });
  }

  if (res.status === 404) {
    // The network does not know this address. That is not a swap in trouble; it is an
    // address that was never issued, or one that has aged out of its records.
    return NextResponse.json({ error: 'UNKNOWN_DEPOSIT_ADDRESS' }, { status: 404 });
  }
  if (!res.ok) {
    console.error('1Click status returned', res.status);
    return NextResponse.json({ error: 'STATUS_UNAVAILABLE' }, { status: 502 });
  }

  let parsedBody;
  try {
    parsedBody = oneClickStatusSchema.parse(await res.json());
  } catch (error) {
    console.error('1Click status returned a shape we do not recognise', error);
    return NextResponse.json({ error: 'STATUS_UNAVAILABLE' }, { status: 502 });
  }

  const reported = asSwapStatus(parsedBody.status);
  const status = expiryFrom(reported, expiresAt, Date.now());
  const refundReason = parsedBody.swapDetails?.refundReason ?? null;
  const refundTx = parsedBody.swapDetails?.originChainTxHashes?.at(-1);

  // The watcher's own row, when the address was issued through /api/fund/quote
  // (always, in this build) — what supplies the elapsed-time-since-arrival and the
  // before/after balances the terminal card needs, without a second poll target.
  const tracked = depositDb().attempt(depositAddress);

  return NextResponse.json(
    {
      status,
      /** What the network itself said, before the deadline was taken into account. */
      reported: parsedBody.status,
      step: swapStepIndex(status),
      terminal: isTerminalSwapStatus(status),
      requotable: isRequotable(status),
      depositedAmount: parsedBody.swapDetails?.depositedAmount ?? null,
      amountOut: parsedBody.swapDetails?.amountOut ?? null,
      refundedAmount: parsedBody.swapDetails?.refundedAmount ?? null,
      refundReason,
      refundReasonCopy: refundReason ? refundReasonCopy(refundReason) : null,
      refundTxHash: refundTx?.hash ?? null,
      refundExplorerUrl: refundTx?.explorerUrl ?? null,
      sourceLandedAt: tracked?.sourceLandedAt ?? null,
      refundBalanceBefore: tracked?.refundBalanceBefore ?? null,
      updatedAt: parsedBody.updatedAt ?? null,
      readAt: Date.now(),
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
