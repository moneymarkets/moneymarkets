import { z } from 'zod';

/**
 * Where a deposit has got to, from `GET https://1click.chaindefuser.com/v0/status`.
 *
 * ## The published statuses, and the one that is not published
 *
 * Seven values are documented (near-intents.org, `api-reference/oneclick/
 * check-swap-execution-status`, read 2026-09-03) and one is not:
 *
 * | status              | meaning                                    | terminal |
 * |---------------------|--------------------------------------------|----------|
 * | `PENDING_DEPOSIT`   | address is live, nothing has arrived       | no       |
 * | `KNOWN_DEPOSIT_TX`  | a deposit transaction has been seen        | no       |
 * | `INCOMPLETE_DEPOSIT`| less arrived than the quote was for        | no       |
 * | `PROCESSING`        | solvers are executing the swap             | no       |
 * | `SUCCESS`           | delivered on Monad                         | yes      |
 * | `REFUNDED`          | returned to the refund address             | yes      |
 * | `FAILED`            | did not execute and was not refunded       | yes      |
 * | `EXPIRED`           | **not in the published enum** — see below  | no       |
 *
 * `EXPIRED` is handled because a deposit window does close: a real quote carries a
 * `timeWhenInactive`, and after it passes an address that never received anything is
 * finished. Whether the API ever *says* `EXPIRED` is UNVERIFIED — it is not in the
 * documented list and this build has never seen one — so the app does not wait to be
 * told. `expiryFrom` below derives the same state from the deadline the quote itself
 * carried, and both routes land on the same answer: **non-terminal**. Nothing was
 * sent, nothing was spent, and the way out is a new quote rather than a support
 * ticket. An unrecognised status is treated the same way as `PROCESSING` — something
 * is happening, we do not know what — rather than thrown away.
 *
 * ## Why the step index lives here
 *
 * Design §5.3 draws five steps. Which step a status lights is a property of the
 * status, not of the screen, so a second screen cannot disagree with the first.
 */

export const SWAP_STATUSES = [
  'PENDING_DEPOSIT',
  'KNOWN_DEPOSIT_TX',
  'INCOMPLETE_DEPOSIT',
  'PROCESSING',
  'SUCCESS',
  'REFUNDED',
  'FAILED',
  'EXPIRED',
] as const;

export type SwapStatus = (typeof SWAP_STATUSES)[number];

/** Anything the network sends that this build does not know a name for. */
export const UNKNOWN_SWAP_STATUS = 'UNKNOWN' as const;

export type KnownOrUnknownStatus = SwapStatus | typeof UNKNOWN_SWAP_STATUS;

const txHashSchema = z.object({
  hash: z.string(),
  explorerUrl: z.string().optional(),
});

export const oneClickStatusSchema = z.object({
  status: z.string(),
  updatedAt: z.string().optional(),
  correlationId: z.string().optional(),
  swapDetails: z
    .object({
      depositedAmount: z.string().nullable().optional(),
      depositedAmountFormatted: z.string().nullable().optional(),
      amountOut: z.string().nullable().optional(),
      amountOutFormatted: z.string().nullable().optional(),
      refundedAmount: z.string().nullable().optional(),
      refundedAmountFormatted: z.string().nullable().optional(),
      refundReason: z.string().nullable().optional(),
      originChainTxHashes: z.array(txHashSchema).optional(),
      destinationChainTxHashes: z.array(txHashSchema).optional(),
    })
    .optional(),
});

export type OneClickStatus = z.infer<typeof oneClickStatusSchema>;

/**
 * `refundReason` in the network's own words, next to the sentence design §6 requires
 * for it: the fact and nothing invented past it. Read 2026-09-03 from two real
 * refunds this build produced (`NO_LIQUIDITY` both times); other values are
 * UNVERIFIED and get the generic line rather than a guessed one.
 */
export function refundReasonCopy(reason: string | null | undefined): string {
  if (reason === 'NO_LIQUIDITY') {
    return 'The solver network declined this swap — no solver took a trade this small right now.';
  }
  if (!reason) return 'The swap could not complete and was returned.';
  return `The swap could not complete and was returned (${reason}).`;
}

export function asSwapStatus(raw: string): KnownOrUnknownStatus {
  return (SWAP_STATUSES as readonly string[]).includes(raw)
    ? (raw as SwapStatus)
    : UNKNOWN_SWAP_STATUS;
}

/**
 * A swap is over only when the money has landed, come back, or stopped. `EXPIRED` is
 * deliberately not in that list: an address whose window closed with nothing sent is
 * a price that lapsed.
 */
export function isTerminalSwapStatus(status: KnownOrUnknownStatus): boolean {
  return status === 'SUCCESS' || status === 'REFUNDED' || status === 'FAILED';
}

/** True when the user can simply ask for a new price and carry on. */
export function isRequotable(status: KnownOrUnknownStatus): boolean {
  return status === 'EXPIRED';
}

/**
 * What the swap itself can prove, read from chain rather than from the solver network.
 *
 * The last two steps are claims about Kuru's MarginAccount, and the swap has no
 * opinion about it: a delivered swap puts USDC in the user's **wallet** and stops.
 */
export interface SettlementProgress {
  /** The move transaction — permit, deposit, convert — is confirmed on Monad. */
  readonly moveConfirmed: boolean;
  /** `MarginAccount.getBalance(user, AUSD)` has actually increased. */
  readonly marginIncreased: boolean;
}

/**
 * Which of the five steps in design §5.3 is currently happening.
 *
 * `-1` means none has started.
 *
 * **`SUCCESS` stops at step 2.** It used to return 4, which lit "Landing in your Kuru
 * balance" and "Ready to trade" the moment the solver network delivered — while the
 * money was still sitting in the wallet, untouched, and the user had not moved
 * anything. Those two steps are assertions about the margin account, so they are
 * driven by `settlement`, which comes from chain reads:
 *
 *   step 3  the move transaction is confirmed
 *   step 4  MarginAccount.getBalance(user, AUSD) has risen
 *
 * A tick that says money is somewhere it is not is worse than no tick at all.
 */
export function swapStepIndex(
  status: KnownOrUnknownStatus,
  settlement?: SettlementProgress,
): number {
  if (settlement?.marginIncreased) return 4;
  if (settlement?.moveConfirmed) return 3;
  switch (status) {
    case 'PENDING_DEPOSIT':
    case 'EXPIRED':
      return 0;
    case 'KNOWN_DEPOSIT_TX':
    case 'INCOMPLETE_DEPOSIT':
      return 1;
    case 'PROCESSING':
    case UNKNOWN_SWAP_STATUS:
      return 2;
    // Delivered — into the wallet. Everything past here needs a chain read.
    case 'SUCCESS':
      return 2;
    // A refund or a failure stopped where the swap stopped. Lighting a later step
    // would say the money moved on when it did not.
    case 'REFUNDED':
    case 'FAILED':
      return 2;
    default:
      return -1;
  }
}

/**
 * The deposit window, derived rather than waited for.
 *
 * Returns `EXPIRED` when the address's own deadline has passed and nothing has
 * arrived. Once anything has arrived the deadline stops mattering — the swap is in
 * flight and its own status governs.
 */
export function expiryFrom(
  status: KnownOrUnknownStatus,
  expiresAt: number | undefined,
  now: number,
): KnownOrUnknownStatus {
  if (status !== 'PENDING_DEPOSIT') return status;
  if (expiresAt === undefined) return status;
  return now >= expiresAt ? 'EXPIRED' : status;
}

export const ONE_CLICK_STATUS_ENDPOINT = 'https://1click.chaindefuser.com/v0/status';

export function statusUrl(depositAddress: string): string {
  return `${ONE_CLICK_STATUS_ENDPOINT}?depositAddress=${encodeURIComponent(depositAddress)}`;
}
