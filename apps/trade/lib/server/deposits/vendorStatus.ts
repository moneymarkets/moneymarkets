import {
  asSwapStatus,
  isTerminalSwapStatus,
  oneClickStatusSchema,
  type OneClickStatus,
} from '@tradepro/core';

/**
 * How each vendor's status word becomes a row update. Shared by the watcher and
 * `scripts/reconcile-deposit-tracker.ts`, so a reconcile writes exactly what the live
 * watcher would have written for the same payload. Pure: no network, no database.
 */

/**
 * The genuine refund transaction, or nothing.
 *
 * `originChainTxHashes` carries the deposit tx first and, only once a refund has
 * actually happened, the refund tx second: confirmed against the real refunded
 * deposit `7uNPTMxP...uw5u` (its event 6 payload: two entries, the second matching the
 * recorded refund amount). `REFUNDED` is the only status this label is ever true for.
 */
export function refundTxFrom(status: string, details: OneClickStatus['swapDetails']) {
  if (status !== 'REFUNDED') return undefined;
  const hashes = details?.originChainTxHashes ?? [];
  // One entry is the deposit itself: the vendor has not reported the refund tx yet.
  return hashes.length > 1 ? hashes.at(-1) : undefined;
}

/**
 * The Monad transaction that actually credited the recipient, only once 1Click says
 * the swap is genuinely delivered: a candidate only, confirmed on chain before use.
 */
export function destinationTxFrom(status: string, details: OneClickStatus['swapDetails']) {
  if (status !== 'SUCCESS') return undefined;
  return details?.destinationChainTxHashes?.at(-1);
}

export interface VendorUpdate {
  readonly status: string;
  readonly terminal: boolean;
  readonly refundReason: string | null;
  readonly refundAmount: string | null;
  readonly refundTxHash: string | null;
  readonly refundExplorerUrl: string | null;
  readonly amountOut: string | null;
  readonly originHash?: string;
}

export function oneClickUpdate(raw: unknown): { parsed: OneClickStatus; update: VendorUpdate } {
  const parsed = oneClickStatusSchema.parse(raw);
  const status = asSwapStatus(parsed.status);
  const details = parsed.swapDetails;
  const refundTx = refundTxFrom(status, details);
  const originHash = details?.originChainTxHashes?.[0]?.hash;
  return {
    parsed,
    update: {
      status,
      terminal: isTerminalSwapStatus(status),
      refundReason: details?.refundReason ?? null,
      refundAmount: details?.refundedAmount ?? null,
      refundTxHash: refundTx?.hash ?? null,
      refundExplorerUrl: refundTx?.explorerUrl ? refundTx.explorerUrl : null,
      amountOut: details?.amountOut ?? null,
      ...(originHash ? { originHash } : {}),
    },
  };
}

/**
 * Relay's vocabulary, as observed rather than as documented. `unknown` is what Relay
 * answers for an address nothing has been sent to (observed 2026-09-11 and again
 * 2026-09-29 on every unfunded Relay row), which is `PENDING_DEPOSIT`. A word not
 * seen before maps to nothing and is only recorded.
 */
export function relayMapped(status: string | undefined): string | undefined {
  const s = (status ?? '').toLowerCase();
  return s === 'success'
    ? 'SUCCESS'
    : s === 'refund'
      ? 'REFUNDED'
      : s === 'failure'
        ? 'FAILED'
        : s === 'pending'
          ? 'PROCESSING'
          : s === 'unknown' || s === 'waiting'
            ? 'PENDING_DEPOSIT'
            : undefined;
}
