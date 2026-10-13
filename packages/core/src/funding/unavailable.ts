import type { Decline, Rail, RailId, RailRef, RailStatus } from './types.js';

/**
 * Rails that were verified and found not to carry Monad, or that need a credential we
 * do not have.
 *
 * These exist as real entries in the router rather than being deleted, for one reason:
 * **a user who wonders "why isn't deBridge here" deserves the answer**, and the answer
 * is the vendor's own response on a stated date. A rail quietly missing from a list
 * teaches nobody anything; a rail that says "deBridge does not list Monad as a
 * supported chain, checked 2026-09-11" is a fact the reader can go and re-check.
 *
 * Every one of these carries the raw response that produced it, so the claim is
 * auditable rather than remembered. When a vendor turns Monad on, the fix is to build
 * the real rail and delete the entry here — not to flip a flag.
 */

export interface UnavailableSpec {
  readonly id: RailId | 'debridge' | 'mayan';
  readonly displayName: string;
  readonly explainer: string;
  /** The vendor's own words, or a plain statement of what its API returned. */
  readonly reason: string;
  /** The observed response. Stored so the decline can be re-checked, not trusted. */
  readonly raw: unknown;
  /** ISO date the observation was made. Shown to the user. */
  readonly checkedOn: string;
}

/**
 * Verified 2026-09-11. Raw responses in `reports/RAILS-VERIFY.md`.
 *
 * `debridge` and `mayan` are not in `RailId` because they are not rails this app has;
 * they are answers to "why not". The router accepts them through the same interface so
 * their declines render exactly like any other vendor's.
 */
export const UNAVAILABLE_RAILS: readonly UnavailableSpec[] = [
  /**
   * Empty, and the reason it is empty is the point.
   *
   * This list held deBridge and Mayan, both written down on 2026-09-11 as permanently
   * unable to carry Monad, each with a raw response attached. Re-checked the same day,
   * **both were wrong**, and both were wrong in the same way: the endpoint that was read
   * was not the endpoint the vendor's own interface reads.
   *
   * ```
   * deBridge  /v1.0/supported-chains-info  17 chains, Monad present as chainId
   *                                        100000030 (originalChainId 143). The first
   *                                        search looked for 143 and found nothing.
   * Mayan     /v3/chains                   7 chains, stale - it omits Base too.
   *           /v3/tokens                   17 chains including Monad, wChainId 48.
   * ```
   *
   * Both now quote live from a plain server, and both are real rails
   * (`debridge.ts`, `mayan.ts`). The entries that said otherwise were on screen for part
   * of a day telling users a vendor did not serve them, which it did.
   *
   * The mechanism was never the problem — a decline carrying the vendor's own response
   * and the date it was taken is still the right way to answer "why isn't X here". What
   * failed was treating one endpoint's silence as the vendor's answer. So the shape
   * stays, ready for a rail that genuinely cannot carry Monad, and nothing sits in it
   * that has not been re-checked today (R11: live observation wins).
   */
];

/**
 * A rail that always declines, with the vendor's reason and the date it was checked.
 *
 * `supports` returns true so the decline actually reaches the screen. A rail that
 * declared itself unsupported would be filtered out by the router and the user would
 * be back to wondering.
 */
export function createUnavailableRail(spec: UnavailableSpec): Rail {
  const id = spec.id as RailId;
  return {
    id,
    displayName: spec.displayName,
    explainer: spec.explainer,
    supports: () => true,
    quote: async (): Promise<Decline> => ({
      rail: id,
      reason: `${spec.reason} (checked ${spec.checkedOn})`,
      raw: spec.raw,
    }),
    status: async (ref: RailRef): Promise<RailStatus> => ({
      state: 'failed',
      message: spec.reason,
      raw: { ref, spec: spec.raw },
    }),
  };
}

/**
 * Relay's deposit-address mode, as a labelled decline until `RELAY_API_KEY` exists.
 *
 * Built as its own entry rather than folded into the Relay rail because the two answer
 * different questions. Relay-the-rail works today, wallet-signed. Relay-deposit-address
 * is the feature a user with no source-chain wallet actually needs, and it is off, and
 * the screen should say which key turns it on rather than silently offering less.
 */
export function createRelayDepositAddressDecline(): Rail {
  return createUnavailableRail({
    id: 'relay',
    displayName: 'Relay deposit address',
    explainer: 'Send from an exchange or any wallet to an address Relay issues for you.',
    reason:
      'Relay deposit addresses need an API key. Without one Relay answers "This request ' +
      'is missing an api key and cannot use a deposit address". Set RELAY_API_KEY on the ' +
      'server to turn this on.',
    raw: { errorCode: 'UNAUTHORIZED', needs: 'RELAY_API_KEY' },
    checkedOn: '2026-09-11',
  });
}
