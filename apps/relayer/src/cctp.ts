import { z } from 'zod';

/**
 * The last leg of a CCTP transfer, which the user cannot do themselves.
 *
 * A CCTP V2 transfer is two transactions on two chains. The user burns USDC on the
 * source chain — their own wallet, their own gas. Then somebody must call
 * `receiveMessage` on Monad with Circle's attestation, and that somebody cannot be the
 * user: their Monad account is a passkey-derived key with no MON, which is the whole
 * premise of this product. Money that is burned and never received is money destroyed.
 *
 * So the relayer submits it, from the float, and this module holds the rules that keep
 * that from being a hole in the policy.
 *
 * ## What makes this safe to do at all
 *
 * `receiveMessage` is **not** a call that can move anyone's money anywhere. It takes a
 * message and Circle's signature over it, verifies the signature against Circle's own
 * attester set on chain, and mints to the `mintRecipient` baked into the message. The
 * relayer chooses nothing: not the amount, not the destination, not the token. A message
 * altered by a byte fails signature verification and mints nothing. The worst a bad
 * caller can do is waste the relayer's own gas.
 *
 * That is the reason this does not widen the relayer's policy in the way `/v1/forward`
 * would (R7): the forwarder executes calldata a user signed, so its allowlist is what
 * bounds it. This executes calldata **Circle** signed, and Circle's attester set is what
 * bounds it. The cap below exists to bound the gas, not the money.
 *
 * ## The three rules
 *
 * 1. **The attestation is re-fetched from Circle**, never taken from the request. A
 *    client sends a transaction hash; this asks Circle what that hash produced. A
 *    forged attestation would fail on chain anyway, but paying gas to find that out is
 *    the cost this avoids.
 * 2. **The mint recipient must be the account that asked.** Circle would happily mint to
 *    whoever the message names; the relayer will not spend its float completing a
 *    stranger's transfer, and a message whose recipient is not the caller is refused
 *    before anything is submitted.
 * 3. **A cap per user per day.** Gas, not money — see above. It bounds how much of the
 *    float one account can consume in a day whatever else goes wrong.
 */

/** How many mints the relayer will submit for one account in a rolling day. */
export const CCTP_MINTS_PER_USER_PER_DAY = 5;

export const CCTP_IRIS_BASE = 'https://iris-api.circle.com';

export const cctpReceiveBodySchema = z.object({
  /** The account that burned, and the only account this mint may be for. */
  recipient: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  /** CCTP domain of the chain the burn happened on. */
  sourceDomain: z.number().int().min(0).max(100),
  /** The burn transaction. Circle is asked what it produced; nothing is read from here. */
  transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
});

export type CctpReceiveBody = z.infer<typeof cctpReceiveBodySchema>;

/** What Circle returns for one message. Only the fields this uses are named. */
export const irisMessageSchema = z.object({
  messages: z
    .array(
      z.object({
        status: z.string().optional(),
        message: z.string().optional(),
        attestation: z.string().optional(),
        eventNonce: z.string().optional(),
        decodedMessage: z
          .object({
            destinationDomain: z.union([z.string(), z.number()]).optional(),
            decodedMessageBody: z
              .object({
                mintRecipient: z.string().optional(),
                amount: z.string().optional(),
              })
              .optional(),
          })
          .optional(),
      }),
    )
    .optional(),
});

export type IrisMessage = NonNullable<z.infer<typeof irisMessageSchema>['messages']>[number];

export type AttestationOutcome =
  | { readonly ready: true; readonly message: `0x${string}`; readonly attestation: `0x${string}`; readonly mintRecipient: string; readonly amount?: string }
  /**
   * Not ready, and whether waiting will ever help.
   *
   * `permanent` is the load-bearing field. Circle still attesting is transient and the
   * caller should poll again; a message that mints to somebody else will never become
   * ours no matter how long anyone waits. Returning one code for both made a permanent
   * refusal look like a transient one, and the watcher polled it every three seconds
   * forever — which consumed the shared rate-limit bucket and took sponsorship down for
   * every user. A refusal that cannot be distinguished from "try again" is a refusal
   * that becomes a denial of service.
   */
  | { readonly ready: false; readonly reason: string; readonly permanent?: boolean };

/**
 * Circle's own 32-byte word for the recipient, compared to an address.
 *
 * The comparison is on the low 20 bytes and case-insensitive: Circle returns the padded
 * word in lower case and viem hands us a checksummed address, and a string comparison
 * between those two is false for every correct message.
 */
export function mintRecipientMatches(mintRecipient: string, address: string): boolean {
  const word = mintRecipient.replace(/^0x/, '').toLowerCase();
  const addr = address.replace(/^0x/, '').toLowerCase();
  if (word.length < 40) return false;
  return word.slice(-40) === addr && /^0*$/.test(word.slice(0, word.length - 40));
}

/**
 * Ask Circle for the attestation, and decide whether it is safe to submit.
 *
 * Returns `ready: false` with a plain reason for every case that is not "submit this
 * now" — including the ordinary one where Circle simply has not finished attesting. That
 * is not an error and the caller reports it as "not yet", because a burn that Circle has
 * not attested is a transfer working exactly as designed.
 */
export async function fetchAttestation(
  body: CctpReceiveBody,
  monadDomain: number,
  fetchImpl: typeof fetch = fetch,
): Promise<AttestationOutcome> {
  const res = await fetchImpl(
    `${CCTP_IRIS_BASE}/v2/messages/${body.sourceDomain}?transactionHash=${body.transactionHash}`,
  );
  const json: unknown = await res.json();

  if (!res.ok) {
    // 404 here is the normal state for the first seconds after a burn.
    return { ready: false, reason: `Circle has not attested this transfer yet (${res.status}).` };
  }

  const parsed = irisMessageSchema.safeParse(json);
  if (!parsed.success) {
    return { ready: false, reason: 'Circle returned a message this service could not read.' };
  }
  const message = parsed.data.messages?.[0];
  if (!message) {
    return { ready: false, reason: 'Circle knows of no transfer for that transaction.' };
  }
  if (message.status !== 'complete') {
    return {
      ready: false,
      reason: `Circle has not finished attesting this transfer (${message.status ?? 'unknown'}).`,
    };
  }
  if (!message.message || !message.attestation) {
    return { ready: false, reason: 'Circle marked this complete but returned no attestation.' };
  }

  const destination = message.decodedMessage?.destinationDomain;
  if (destination !== undefined && Number(destination) !== monadDomain) {
    // Not ours to complete. Submitting it would spend the float on a transfer aimed at
    // another chain entirely.
    // Circle signed this for another chain. No amount of waiting changes that.
    return { ready: false, reason: 'That transfer is not addressed to Monad.', permanent: true };
  }

  const mintRecipient = message.decodedMessage?.decodedMessageBody?.mintRecipient;
  if (!mintRecipient) {
    return { ready: false, reason: 'Circle returned no mint recipient for that transfer.' };
  }
  if (!mintRecipientMatches(mintRecipient, body.recipient)) {
    // The recipient is inside the message Circle signed. It cannot change.
    return {
      ready: false,
      reason: 'That transfer mints to a different account, so this service will not submit it.',
      permanent: true,
    };
  }

  return {
    ready: true,
    message: message.message as `0x${string}`,
    attestation: message.attestation as `0x${string}`,
    mintRecipient,
    ...(message.decodedMessage?.decodedMessageBody?.amount
      ? { amount: message.decodedMessage.decodedMessageBody.amount }
      : {}),
  };
}
