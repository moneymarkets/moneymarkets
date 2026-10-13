/**
 * What went wrong with a passkey, and what to say about it.
 *
 * Mera does not throw DOM exceptions. It catches whatever WebAuthn threw and rethrows
 * a `MeraError` carrying a stable `code`, with the original as `cause`
 * (`@category-labs/mera@0.2.0`, `src/passkey.ts`):
 *
 *   PRF_UNAVAILABLE          the authenticator did not enable or return a 32-byte
 *                            PRF output — a Windows Chrome profile passkey, most
 *                            often. There is no account without it.
 *   PASSKEY_OPERATION_FAILED WebAuthn itself failed. `cause` is the DOMException,
 *                            and its `name` is the only thing that separates a user
 *                            who pressed Escape from a site served on a bad origin.
 *   CRYPTO_UNAVAILABLE       no `crypto.getRandomValues` — an insecure context.
 *   INPUT_INVALID            a stored credential id that is not canonical base64url.
 *
 * Reading only `error.message` collapses all of those into one sentence. That is why
 * `http://127.0.0.1:3117` produced "That did not complete. Try again." for what was
 * actually a `SecurityError` about the origin: the message on the thrown error was
 * "Passkey creation failed", which matched none of the patterns, so the generic copy
 * won. The classification below reads the code and the cause instead.
 */

export type SignInFailure =
  /** The provider cannot derive an account. Name the ones that can. */
  | 'PRF_UNAVAILABLE'
  /** Bad origin or rpId. The user cannot fix this; the developer can. */
  | 'SECURITY_ERROR'
  /** Cancelled, dismissed, or timed out. Nothing happened. */
  | 'NOT_ALLOWED'
  /** Insecure context: no Web Crypto. */
  | 'INSECURE_CONTEXT'
  /** Anything else. */
  | 'UNKNOWN';

/**
 * PRF copy names the providers that work and the cross-device route, because on a
 * Windows desktop none of the local options do (design §5.1, `docs/devices.md`).
 */
export const PRF_UNAVAILABLE_MESSAGE =
  'This passkey provider cannot create your account — it does not support the ' +
  'feature the account is derived from. Save the passkey to iCloud Keychain, ' +
  'Google Password Manager or 1Password, or use your phone instead.';

export const NOT_ALLOWED_MESSAGE = 'Nothing was created. Try again when ready.';

export const SECURITY_ERROR_MESSAGE =
  'This address cannot hold passkeys. Open the app on localhost or on its real ' +
  'domain — an IP address will never work.';

export const INSECURE_CONTEXT_MESSAGE =
  'Passkeys need a secure connection. Open the app over https, or on localhost.';

export const UNKNOWN_MESSAGE = 'That did not complete. Try again.';

const MESSAGES: Record<SignInFailure, string> = {
  PRF_UNAVAILABLE: PRF_UNAVAILABLE_MESSAGE,
  SECURITY_ERROR: SECURITY_ERROR_MESSAGE,
  NOT_ALLOWED: NOT_ALLOWED_MESSAGE,
  INSECURE_CONTEXT: INSECURE_CONTEXT_MESSAGE,
  UNKNOWN: UNKNOWN_MESSAGE,
};

interface CodedError {
  readonly code?: unknown;
  readonly name?: unknown;
  readonly message?: unknown;
  readonly cause?: unknown;
}

function nameOf(value: unknown): string {
  const candidate = (value as CodedError | null)?.name;
  return typeof candidate === 'string' ? candidate : '';
}

/**
 * The one classifier. Everything about a failed ceremony flows through here, so
 * there is exactly one place where "which failure was that?" is decided.
 */
export function classifySignInError(caught: unknown): SignInFailure {
  const error = caught as CodedError | null;
  const code = typeof error?.code === 'string' ? error.code : '';

  if (code === 'PRF_UNAVAILABLE') return 'PRF_UNAVAILABLE';
  if (code === 'CRYPTO_UNAVAILABLE') return 'INSECURE_CONTEXT';

  // `cause` is the DOMException WebAuthn threw. Its name is the whole signal.
  const causeName = nameOf(error?.cause) || nameOf(error);
  if (causeName === 'SecurityError') return 'SECURITY_ERROR';
  if (causeName === 'NotAllowedError' || causeName === 'AbortError') return 'NOT_ALLOWED';
  if (causeName === 'NotSupportedError') return 'PRF_UNAVAILABLE';

  // A stand-in or a future version that reports the same conditions in prose.
  const raw = typeof error?.message === 'string' ? error.message : String(caught);
  if (/\bPRF\b/i.test(raw)) return 'PRF_UNAVAILABLE';
  if (/SecurityError|relying party|rpId|not a registrable/i.test(raw)) return 'SECURITY_ERROR';
  if (/NotAllowedError|AbortError|cancel|timed out/i.test(raw)) return 'NOT_ALLOWED';

  return 'UNKNOWN';
}

export function messageForSignInError(caught: unknown): string {
  return MESSAGES[classifySignInError(caught)];
}

/**
 * A `SecurityError` is a deployment mistake, not something the user did. It is the
 * one failure worth putting in the console, and the only one carrying a detail the
 * user must never be shown as-is.
 */
export function shouldLogToConsole(failure: SignInFailure): boolean {
  return failure === 'SECURITY_ERROR';
}

export function developerNoteFor(failure: SignInFailure, rpId: string, origin: string): string {
  if (failure !== 'SECURITY_ERROR') return '';
  return (
    `WebAuthn refused rpId "${rpId}" for origin "${origin}". The rpId must be the ` +
    'origin host or a registrable suffix of it, and must not be an IP literal. Set ' +
    'NEXT_PUBLIC_RP_ID to the host this build is served from.'
  );
}
