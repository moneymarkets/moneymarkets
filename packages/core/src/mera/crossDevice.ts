/**
 * Cross-device passkeys — "create with your phone".
 *
 * Windows Chrome's local passkey store does not evaluate the WebAuthn PRF extension,
 * so a passkey saved to the Windows profile cannot derive a Mera account at all: the
 * ceremony succeeds and then `PRF_UNAVAILABLE` is thrown. The provider that does work
 * on a desktop is a phone — iCloud Keychain or Google Password Manager reached over
 * the hybrid (caBLE) transport, which the browser presents as a QR code.
 *
 * `@category-labs/mera@0.2.0` lets a caller supply the `WebAuthnClient` that runs the
 * ceremony, and its own browser client asks for no particular authenticator. This one
 * asks for the phone: `hints: ['hybrid']` (WebAuthn Level 3 §5.4.7, honoured by
 * Chrome) with `authenticatorAttachment: 'cross-platform'` as the Level 2 fallback
 * for browsers that do not read hints.
 *
 * `packages/core` compiles without the DOM library, because most of it runs on a
 * server and nothing there should be able to reach a document by accident. The
 * browser surface this module needs is therefore declared below, narrowly: two
 * methods and the one extension output it reads. `apps/trade` reaches this through a
 * dynamic import, so no server bundle pulls it in either.
 */

/** `PublicKeyCredentialHints`, WebAuthn Level 3. */
export type PasskeyHint = 'hybrid' | 'security-key' | 'client-device';

/** Which authenticator a ceremony should look for. */
export type PasskeyAttachment = 'any' | 'phone';

const HYBRID_HINTS: readonly PasskeyHint[] = ['hybrid'];

/**
 * The subset of Mera's `WebAuthnClient` this module implements. Restated here rather
 * than imported so `@tradepro/core` does not take a type dependency on a deep path in
 * a package it loads dynamically.
 */
export interface CredentialCeremonyClient {
  createCredential(request: CreateCredentialRequest): Promise<CreateCredentialResult>;
  getCredential(request: GetCredentialRequest): Promise<GetCredentialResult>;
}

export interface CreateCredentialRequest {
  rp: { id: string; name: string };
  user: { id: Uint8Array; name: string; displayName: string };
  challenge: Uint8Array;
  algorithms: readonly number[];
  prfSalt: Uint8Array;
  residentKey: 'required';
  userVerification: 'required';
  attestation: 'none';
  timeout?: number;
}

export interface CreateCredentialResult {
  credentialId: Uint8Array;
  transports?: readonly string[];
  prfEnabled: boolean;
  prfOutput?: Uint8Array;
}

export interface GetCredentialRequest {
  rpId: string;
  challenge: Uint8Array;
  allowCredential?: { credentialId: Uint8Array; transports?: readonly string[] };
  prfSalt: Uint8Array;
  userVerification: 'required';
  timeout?: number;
}

export interface GetCredentialResult {
  credentialId: Uint8Array;
  prfOutput?: Uint8Array;
}

/** The PRF extension's client output, the only extension result this reads. */
interface PrfExtensionOutputs {
  prf?: { enabled?: boolean; results?: { first?: ArrayBuffer | ArrayBufferView } };
}

interface CredentialWithPrf {
  type: string;
  rawId: ArrayBuffer;
  response: { getTransports?: () => string[] };
  getClientExtensionResults(): PrfExtensionOutputs;
}

/** What this module needs from the browser, and nothing more. */
interface CredentialsContainerLike {
  create(options: { publicKey: Record<string, unknown> }): Promise<unknown>;
  get(options: { publicKey: Record<string, unknown> }): Promise<unknown>;
}

export class CeremonyUnavailableError extends Error {
  constructor() {
    super('This browser has no WebAuthn credential store.');
    this.name = 'CeremonyUnavailableError';
  }
}

export class CeremonyFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CeremonyFailedError';
  }
}

function credentials(): CredentialsContainerLike {
  const container = (globalThis as { navigator?: { credentials?: CredentialsContainerLike } })
    .navigator?.credentials;
  if (!container) throw new CeremonyUnavailableError();
  return container;
}

function toBytes(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  return ArrayBuffer.isView(value)
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : new Uint8Array(value);
}

function assertCredential(credential: unknown): CredentialWithPrf {
  const candidate = credential as CredentialWithPrf | null;
  if (
    !candidate ||
    candidate.type !== 'public-key' ||
    typeof candidate.getClientExtensionResults !== 'function'
  ) {
    throw new CeremonyFailedError('WebAuthn returned no usable public key credential');
  }
  return candidate;
}

/**
 * A ceremony client that steers the browser to a phone.
 *
 * `attachment: 'any'` gives back a client with no steering, which is what the local
 * path uses; the two share this one implementation so there is a single place where
 * the PRF extension is requested.
 */
export function ceremonyClient(attachment: PasskeyAttachment): CredentialCeremonyClient {
  const wantsPhone = attachment === 'phone';

  return {
    async createCredential(request) {
      const credential = assertCredential(
        await credentials().create({
          publicKey: {
            rp: request.rp,
            user: request.user,
            challenge: request.challenge,
            pubKeyCredParams: request.algorithms.map((alg) => ({ type: 'public-key', alg })),
            attestation: request.attestation,
            authenticatorSelection: {
              residentKey: request.residentKey,
              requireResidentKey: true,
              userVerification: request.userVerification,
              ...(wantsPhone ? { authenticatorAttachment: 'cross-platform' } : {}),
            },
            ...(wantsPhone ? { hints: HYBRID_HINTS } : {}),
            ...(request.timeout === undefined ? {} : { timeout: request.timeout }),
            extensions: { prf: { eval: { first: request.prfSalt } } },
          },
        }),
      );

      const prf = credential.getClientExtensionResults().prf;
      const first = prf?.results?.first;
      const transports =
        typeof credential.response.getTransports === 'function'
          ? credential.response.getTransports()
          : undefined;

      return {
        credentialId: new Uint8Array(credential.rawId),
        ...(transports === undefined ? {} : { transports }),
        prfEnabled: prf?.enabled === true,
        ...(first === undefined ? {} : { prfOutput: toBytes(first) }),
      };
    },

    async getCredential(request) {
      const { allowCredential } = request;
      const credential = assertCredential(
        await credentials().get({
          publicKey: {
            rpId: request.rpId,
            challenge: request.challenge,
            userVerification: request.userVerification,
            ...(wantsPhone ? { hints: HYBRID_HINTS } : {}),
            ...(request.timeout === undefined ? {} : { timeout: request.timeout }),
            ...(allowCredential === undefined
              ? {}
              : {
                  allowCredentials: [
                    {
                      id: allowCredential.credentialId,
                      type: 'public-key',
                      ...(allowCredential.transports === undefined
                        ? {}
                        : { transports: allowCredential.transports }),
                    },
                  ],
                }),
            extensions: { prf: { eval: { first: request.prfSalt } } },
          },
        }),
      );

      const first = credential.getClientExtensionResults().prf?.results?.first;
      return {
        credentialId: new Uint8Array(credential.rawId),
        ...(first === undefined ? {} : { prfOutput: toBytes(first) }),
      };
    },
  };
}

/**
 * Whether "create with your phone" should be offered as a first-class action.
 *
 * Offered on anything that is not itself a phone, because that is where the local
 * store is the one that cannot do PRF. It is an offer, never a redirect: a desktop
 * with a working provider (a Mac with iCloud Keychain) still has the local button.
 */
export function shouldOfferCrossDevice(userAgent: string): boolean {
  return !/Android|iPhone|iPad|iPod/i.test(userAgent);
}
