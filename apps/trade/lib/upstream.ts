import { failure, withDetail, type Failure } from './failures';
import type { RefundKind } from './fund/sources';

/**
 * The upstream's own words, carried to the screen with its name on them.
 *
 * Error-handling rule (owner instruction, 2026-09-08): the app never masks an
 * upstream reason. Every failure that came with words from 1Click, Kuru, Kuru Flow,
 * Pimlico or an RPC shows a one-line plain-language lead (the failure catalogue)
 * and, beneath it, the upstream message VERBATIM with its source named — e.g.
 * "NEAR Intents said: “Temporary swap limits: minimum swap amount is $1,000”".
 *
 * This module is the single place that formatting lives, and `upstream.test.ts`
 * fails if any error body that carries an upstream message produces a failure
 * without those words in it.
 */

/** Who answered. 1Click is NEAR Intents' quoting API, so it is named as that. */
export const ONE_CLICK_SOURCE = 'NEAR Intents';

export interface UpstreamAnswer {
  /** Who said it — "NEAR Intents", "Kuru", "Kuru Flow", "Pimlico", "Monad RPC"… */
  readonly source: string;
  /** Their sentence, verbatim. Never rewritten, never truncated here. */
  readonly message: string;
  /** The HTTP or JSON-RPC status it arrived with, when there was one. */
  readonly status?: number;
}

/** `NEAR Intents said: “…”` — the line that renders under the plain lead. */
export function upstreamLine(answer: UpstreamAnswer): string {
  return `${answer.source} said: “${answer.message}”`;
}

/** The shape our own route handlers put an upstream answer on the wire in. */
export interface WireUpstream {
  readonly status?: number;
  readonly message?: string;
  /** Optional source name; absent means the route's default upstream (1Click). */
  readonly source?: string;
}

export interface WireErrorBody {
  readonly error?: string;
  readonly refundKind?: RefundKind;
  readonly originDecimals?: number;
  readonly originSymbol?: string;
  /** Why a source is not priced, in our own words (an API-read fact, not a quote). */
  readonly reason?: string;
  readonly upstream?: WireUpstream;
}

/**
 * The detail line for any wire body that might carry an upstream answer, regardless
 * of whether its `error` code is one `failureForBody` recognises — for a screen that
 * is not rendering one of this module's own failure codes (a balance read, an order
 * read) but still needs to tell a real upstream reason from a transport failure per
 * R5, without hand-rolling the same "who said what" line a second time.
 */
export function detailFrom(body: WireErrorBody, defaultSource: string): string | undefined {
  if (body.upstream?.message) {
    return upstreamLine({
      source: body.upstream.source ?? defaultSource,
      message: body.upstream.message,
      ...(body.upstream.status !== undefined ? { status: body.upstream.status } : {}),
    });
  }
  // Not a quoted sentence, but still the fact the server derived from the API.
  if (body.reason) return body.reason;
  return undefined;
}

/**
 * An HTTP error body from our own quote/route handlers, turned into the failure the
 * screen renders — with the upstream words attached wherever they exist.
 *
 * Every branch goes through `detailFrom`, so a new error code cannot quietly drop
 * the upstream body; `upstream.test.ts` walks all codes and holds that line.
 */
export function failureForBody(
  status: number,
  body: WireErrorBody,
  defaultSource: string = ONE_CLICK_SOURCE,
): Failure {
  const detail = detailFrom(body, defaultSource);

  switch (body.error) {
    case 'AMOUNT_BELOW_MINIMUM':
      return withDetail(failure('AMOUNT_BELOW_MINIMUM'), detail);
    case 'ROUTE_UNAVAILABLE':
      // The catalogue's fix line promises the network's reason below, so the
      // promise is kept even when the wire carried none.
      return withDetail(failure('ROUTE_UNAVAILABLE'), detail ?? `${defaultSource} gave no reason.`);
    case 'ROUTE_LIST_UNAVAILABLE':
      return withDetail(failure('ROUTE_LIST_UNAVAILABLE'), detail);
    case 'ROUTE_NOT_PRICED':
      return withDetail(failure('ROUTE_NOT_PRICED'), detail);
    case 'REFUND_ADDRESS_REQUIRED':
      return withDetail(failure('REFUND_ADDRESS_REQUIRED'), detail);
    case 'DEPOSIT_NEEDS_REFUND_ADDRESS':
      return withDetail(failure('DEPOSIT_NEEDS_REFUND_ADDRESS'), detail);
    case 'REFUND_ADDRESS_REJECTED':
      return withDetail(failure('REFUND_ADDRESS_REJECTED'), detail);
    case 'DEPOSIT_TRACKING_UNAVAILABLE':
      return withDetail(failure('DEPOSIT_TRACKING_UNAVAILABLE'), detail);
    case 'CONVERSION_UNQUOTABLE':
      return withDetail(failure('CONVERSION_UNQUOTABLE'), detail);
    case 'FLOW_ROUTE_NEEDS_NATIVE_VALUE':
      return withDetail(failure('FLOW_ROUTE_NEEDS_NATIVE_VALUE'), detail);
    case 'OFT_QUOTE_UNAVAILABLE':
      return withDetail(failure('OFT_QUOTE_UNAVAILABLE'), detail);
    default:
      if (status === 410) return withDetail(failure('QUOTE_EXPIRED'), detail);
      return withDetail(failure('QUOTE_FAILED'), detail);
  }
}
