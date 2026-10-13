import { formatUnits } from 'viem';
import { sourceTxExplorerUrl } from '../funding/chainParams.js';

/**
 * Stuck deposits (owner rule, 2026-09-30): the same definition, recovery record and help
 * report for every rail, so no deposit is ever handled by a hand-written ticket.
 *
 * A deposit is stuck when:
 *   - its funds are confirmed on the source chain (this app's own read, or the origin
 *     transaction the vendor reported, which is a chain transaction either way);
 *   - the vendor has shown no progress for 3 times its quoted ETA (measured from the
 *     row's last change of any kind, so any progress restarts the clock);
 *   - and neither chain shows the outcome: no delivery seen on Monad, no refund seen
 *     back on the source chain.
 */

/** The owner's multiple of the quoted ETA. */
export const STUCK_ETA_MULTIPLE = 3;

/**
 * The ETA used when the vendor quoted none (a Relay deposit-address quote carries no
 * time). This app's own decision, recorded in D195: 10 minutes, so the threshold is 30.
 */
export const STUCK_FALLBACK_ETA_SECONDS = 10 * 60;

export interface StuckInput {
  readonly sourceConfirmed: boolean;
  readonly etaSeconds: number | null | undefined;
  readonly lastChangeAt: number;
  readonly delivered: boolean;
  readonly refunded: boolean;
  readonly now: number;
}

export function stuckThresholdMs(etaSeconds: number | null | undefined): number {
  const eta = etaSeconds && etaSeconds > 0 ? etaSeconds : STUCK_FALLBACK_ETA_SECONDS;
  return eta * STUCK_ETA_MULTIPLE * 1000;
}

export function isStuck(input: StuckInput): boolean {
  if (!input.sourceConfirmed || input.delivered || input.refunded) return false;
  return input.now - input.lastChangeAt >= stuckThresholdMs(input.etaSeconds);
}

/** Minutes since `since`, rounded as the tracker's own slow message rounds them, never less than one. */
export function minutesSince(since: number, now: number): number {
  return Math.max(1, Math.round((now - since) / 60_000));
}

export type StuckRail = 'near' | 'relay' | 'cctp';

export interface VendorSupport {
  /** The provider's own name, as its docs write it. */
  readonly name: string;
  /** The provider's official support link, read from its own docs (D195). */
  readonly supportUrl: string | undefined;
}

/**
 * Per rail. A rail whose support link has not been read from the vendor's own docs has
 * none here, and the report says so rather than inventing one.
 */
export const VENDOR_SUPPORT: Record<StuckRail, VendorSupport> = {
  // docs.near-intents.org, going live: "Join our Telegram community for support."
  near: { name: 'NEAR Intents (1Click)', supportUrl: 'https://t.me/near_intents' },
  // docs.relay.link: the Relay support centre.
  relay: { name: 'Relay', supportUrl: 'https://support.relay.link/en/' },
  // developers.circle.com, CCTP migration guide: "contact the Circle team on the
  // BuildOnCircle Discord".
  cctp: { name: 'Circle CCTP', supportUrl: 'https://discord.com/invite/buildoncircle' },
};

export function vendorFor(rail: string | null | undefined): VendorSupport {
  if (rail === 'relay' || rail === 'cctp' || rail === 'near') return VENDOR_SUPPORT[rail];
  return { name: rail ?? 'the bridge', supportUrl: undefined };
}

/** One recovery call made for a stuck deposit, with the vendor's answer verbatim. */
export interface RecoveryAttempt {
  readonly at: number;
  /** What was called, as documented: e.g. "POST https://1click.chaindefuser.com/v0/deposit/submit". */
  readonly call: string;
  readonly httpStatus: number | null;
  /** The vendor's answer, verbatim (the response body as text, cut at 2,000 characters). */
  readonly answer: string;
}

export interface HelpReportInput {
  readonly rail: string | null;
  readonly depositAddress: string;
  readonly chain: string;
  readonly amountIn: string;
  readonly originDecimals: number;
  readonly originSymbol: string;
  readonly sourceTxHash: string | null;
  /** When the funds were confirmed on the source chain. */
  readonly landedAt: number | null;
  readonly quotedAmountOut: string | null;
  readonly outToken: string | null;
  /** Decimals of `outToken` on Monad, for the quoted amount. */
  readonly outDecimals?: number;
  readonly etaSeconds: number | null;
  readonly refundTo: string;
  readonly lastStatus: string;
  readonly vendorRawJson: string | null;
  readonly lastChangeAt: number;
  readonly now: number;
}

function amount(value: string, decimals: number): string {
  return formatUnits(BigInt(value), decimals);
}

function eta(seconds: number | null): string {
  if (!seconds || seconds <= 0) return 'no time quoted';
  return seconds < 120 ? `about ${seconds} seconds` : `about ${Math.round(seconds / 60)} minutes`;
}

/**
 * The prefilled help report: the same template for every rail, first person, plain
 * sentences, every fact the vendor's support needs to find the deposit, and the vendor's
 * last status verbatim.
 */
export function stuckHelpReport(input: HelpReportInput): string {
  const vendor = vendorFor(input.rail);
  const sourceLink = input.sourceTxHash ? sourceTxExplorerUrl(input.chain, input.sourceTxHash) : undefined;
  const sent = `${amount(input.amountIn, input.originDecimals)} ${input.originSymbol} on ${input.chain}`;
  const quoted =
    input.quotedAmountOut && input.outToken
      ? `${sent} to ${amount(input.quotedAmountOut, input.outDecimals ?? 6)} ${input.outToken} on Monad, ${eta(input.etaSeconds)}, via ${vendor.name}`
      : `${sent} to Monad, ${eta(input.etaSeconds)}, via ${vendor.name}`;
  const minutes = minutesSince(input.lastChangeAt, input.now);
  const lines = [
    `To: ${vendor.name} support${vendor.supportUrl ? `, ${vendor.supportUrl}` : ''}`,
    '',
    `Hello ${vendor.name} support. I sent a deposit that has not arrived and has not come back to me. Can you tell me where it is?`,
    '',
    `Provider: ${vendor.name}`,
    `Deposit address: ${input.depositAddress}`,
    `Source transaction: ${input.sourceTxHash ?? 'not known to me'}${sourceLink ? ` (${sourceLink})` : ''}`,
    `Amount: ${sent}`,
    `Landed on ${input.chain}: ${input.landedAt ? new Date(input.landedAt).toISOString() : 'not recorded'}`,
    `Route quoted: ${quoted}`,
    `Refund address: ${input.refundTo}`,
    `Last status from ${vendor.name}: ${input.lastStatus}`,
    `Last status payload, as ${vendor.name} sent it: ${input.vendorRawJson ?? 'none received'}`,
    '',
    `It has been ${minutes} minutes since anything changed. Nothing has arrived on Monad and nothing has come back to my refund address. Thank you.`,
  ];
  return lines.join('\n');
}
