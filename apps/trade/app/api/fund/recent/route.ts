import { NextResponse } from 'next/server';
import { z } from 'zod';
import { depositDb } from '../../../../lib/server/deposits/db';

/**
 * "Recent deposits" (D105 item 3) — every attempt this account has made, in or out
 * of flight, with its outcome. Attempts never disappear from this list; a refund is
 * shown, not erased.
 *
 * `recipient` is validated with zod (audit M6) rather than a bare `isAddress` check —
 * the shape a malformed or oversized query param reaches `depositDb()` in is now
 * bounded before it gets there, one of the three routes named for it explicitly.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const querySchema = z.object({
  recipient: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({ recipient: url.searchParams.get('recipient')?.trim() ?? '' });
  if (!parsed.success) {
    return NextResponse.json({ error: 'BAD_REQUEST' }, { status: 400 });
  }
  const { recipient } = parsed.data;
  const rows = depositDb().recentFor(recipient, 20);
  return NextResponse.json(
    {
      attempts: rows.map((r) => ({
        depositAddress: r.depositAddress,
        sourceKey: r.sourceKey,
        chain: r.chain,
        amountIn: r.amountIn,
        originDecimals: r.originDecimals,
        originSymbol: r.originSymbol,
        createdAt: r.createdAt,
        sourceLandedAt: r.sourceLandedAt,
        detectedAt: r.detectedAt,
        terminalAt: r.terminalAt,
        lastStatus: r.lastStatus,
        terminalStatus: r.terminalStatus,
        refundReason: r.refundReason,
        refundAmount: r.refundAmount,
        refundTxHash: r.refundTxHash,
        refundExplorerUrl: r.refundExplorerUrl,
        refundTo: r.refundTo,
        amountOut: r.amountOut,
        destinationTxHash: r.destinationTxHash,
        destinationTxBlock: r.destinationTxBlock,
        destinationEvidenceSource: r.destinationEvidenceSource,
        destinationDetectedAt: r.destinationDetectedAt,
        sourceTxHash: r.sourceTxHash,
        sourceEvidenceSource: r.sourceEvidenceSource,
        sourceTxAt: r.sourceTxAt,
        vendorRawJson: r.vendorRawJson,
        vendorRawAt: r.vendorRawAt,
        etaSeconds: r.etaSeconds,
        outToken: r.outToken,
        landsIn: r.landsIn,
        expiresAt: r.expiresAt,
        refundEvidenceHash: r.refundEvidenceHash,
        refundEvidenceSource: r.refundEvidenceSource,
        refundEvidenceAmount: r.refundEvidenceAmount,
        refundEvidenceAt: r.refundEvidenceAt,
        lastChangeAt: r.lastChangeAt,
        rail: r.rail,
        quotedAmountOut: r.quotedAmountOut,
        stuckAt: r.stuckAt,
        recoveryJson: r.recoveryJson,
        // Carried so a client-side fallback poll (D202) can stand in for a missed SSE
        // push with the exact row `DepositProgress` would have gotten from the stream.
        marginBalanceBefore: r.marginBalanceBefore,
        marginBalanceBeforeBlock: r.marginBalanceBeforeBlock,
      })),
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
