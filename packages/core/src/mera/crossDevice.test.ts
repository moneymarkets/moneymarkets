import { afterEach, describe, expect, it } from 'vitest';
import { ceremonyClient, shouldOfferCrossDevice } from './crossDevice.js';

/**
 * What the browser is actually asked for.
 *
 * `hints: ['hybrid']` is the difference between Chrome opening the QR flow straight
 * away and Chrome opening a generic picker the user has to navigate — on a desktop
 * whose local store cannot do PRF, that picker leads to the one option that is
 * guaranteed to fail. The hint is a single line and easy to drop by accident, so it is
 * pinned here.
 *
 * These tests inspect the options handed to `navigator.credentials`, because that is
 * the only thing about a ceremony that can be checked without a real phone. Whether
 * the caBLE handshake then completes is untestable here: a virtual authenticator
 * cannot emulate the hybrid transport. That gap is real and stated rather than papered
 * over — this is EXISTS for the ceremony and EXERCISED only for the request shape.
 */

interface Captured {
  create?: Record<string, unknown>;
  get?: Record<string, unknown>;
}

function stubCredentials(): Captured {
  const captured: Captured = {};
  const credential = {
    type: 'public-key',
    rawId: new Uint8Array([1, 2, 3]).buffer,
    response: { getTransports: () => ['hybrid'] },
    getClientExtensionResults: () => ({
      prf: { enabled: true, results: { first: new Uint8Array(32).fill(7).buffer } },
    }),
  };
  // Node exposes `navigator` as a getter-only global, so a plain assignment throws.
  // defineProperty with configurable:true both installs it and lets afterEach remove it.
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: {
      credentials: {
        create: async (options: { publicKey: Record<string, unknown> }) => {
          captured.create = options.publicKey;
          return credential;
        },
        get: async (options: { publicKey: Record<string, unknown> }) => {
          captured.get = options.publicKey;
          return credential;
        },
      },
    },
  });
  return captured;
}

const createRequest = {
  rp: { id: 'localhost', name: 'tradepro' },
  user: { id: new Uint8Array([9]), name: 'a', displayName: 'a' },
  challenge: new Uint8Array(32),
  algorithms: [-7],
  prfSalt: new Uint8Array(32),
  residentKey: 'required',
  userVerification: 'required',
  attestation: 'none',
} as const;

const getRequest = {
  rpId: 'localhost',
  challenge: new Uint8Array(32),
  prfSalt: new Uint8Array(32),
  userVerification: 'required',
} as const;

afterEach(() => {
  delete (globalThis as Record<string, unknown>).navigator;
});

describe('"create with your phone"', () => {
  it('asks the browser for the hybrid transport', async () => {
    const captured = stubCredentials();
    await ceremonyClient('phone').createCredential(createRequest);
    expect(captured.create?.hints).toEqual(['hybrid']);
  });

  it('also sets cross-platform, for browsers that do not read hints', async () => {
    // `hints` is WebAuthn Level 3. `authenticatorAttachment` is the Level 2 way of
    // saying the same thing, and costs nothing to send alongside.
    const captured = stubCredentials();
    await ceremonyClient('phone').createCredential(createRequest);
    const selection = captured.create?.authenticatorSelection as Record<string, unknown>;
    expect(selection.authenticatorAttachment).toBe('cross-platform');
  });

  it('still asks for a resident key and user verification', async () => {
    // Steering to a phone must not quietly relax the ceremony: the PRF output this
    // whole account model derives from is only produced for a user-verified passkey.
    const captured = stubCredentials();
    await ceremonyClient('phone').createCredential(createRequest);
    const selection = captured.create?.authenticatorSelection as Record<string, unknown>;
    expect(selection.residentKey).toBe('required');
    expect(selection.userVerification).toBe('required');
    expect(captured.create?.extensions).toEqual({ prf: { eval: { first: expect.anything() } } });
  });
});

describe('"sign in with your phone"', () => {
  it('asks the browser for the hybrid transport', async () => {
    const captured = stubCredentials();
    await ceremonyClient('phone').getCredential(getRequest);
    expect(captured.get?.hints).toEqual(['hybrid']);
  });

  it('carries the hint even when a specific credential is allowed', async () => {
    // A returning user has a credential id, and the hint must survive alongside it —
    // otherwise the returning path opens the picker while the new path does not.
    const captured = stubCredentials();
    await ceremonyClient('phone').getCredential({
      ...getRequest,
      allowCredential: { credentialId: new Uint8Array([1, 2, 3]), transports: ['hybrid'] },
    });
    expect(captured.get?.hints).toEqual(['hybrid']);
    expect(captured.get?.allowCredentials).toHaveLength(1);
  });
});

describe('the local path is left alone', () => {
  it('sends no hint and no attachment when the phone was not asked for', async () => {
    // The other buttons must keep opening whatever the platform offers. Steering them
    // to a phone would take the working path away from a Mac with iCloud Keychain.
    const captured = stubCredentials();
    await ceremonyClient('any').createCredential(createRequest);
    expect(captured.create?.hints).toBeUndefined();
    const selection = captured.create?.authenticatorSelection as Record<string, unknown>;
    expect(selection.authenticatorAttachment).toBeUndefined();

    await ceremonyClient('any').getCredential(getRequest);
    expect(captured.get?.hints).toBeUndefined();
  });
});

describe('when the phone is offered at all', () => {
  it('is offered on a desktop, where the local store cannot do PRF', () => {
    expect(shouldOfferCrossDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141')).toBe(
      true,
    );
    expect(
      shouldOfferCrossDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605'),
    ).toBe(true);
  });

  it('is not offered on a phone, which already is one', () => {
    expect(shouldOfferCrossDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Safari/604')).toBe(
      false,
    );
    expect(shouldOfferCrossDevice('Mozilla/5.0 (Linux; Android 15) Chrome/141')).toBe(false);
  });
});
