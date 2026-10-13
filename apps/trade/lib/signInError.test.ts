import { describe, expect, it } from 'vitest';
import {
  classifySignInError,
  developerNoteFor,
  messageForSignInError,
  NOT_ALLOWED_MESSAGE,
  PRF_UNAVAILABLE_MESSAGE,
  SECURITY_ERROR_MESSAGE,
  shouldLogToConsole,
  UNKNOWN_MESSAGE,
} from './signInError';

/**
 * The errors Mera actually throws, reproduced exactly as `@category-labs/mera@0.2.0`
 * constructs them: a `MeraError` with a stable `code`, and the DOMException WebAuthn
 * raised carried as `cause`. Anything that reads only `message` sees "Passkey
 * creation failed" for every one of these, which is how a `SecurityError` about the
 * origin came out as "That did not complete. Try again."
 */
class MeraErrorLike extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MeraError';
    this.code = code;
  }
}

class DomExceptionLike extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

describe('classifySignInError', () => {
  it('names PRF when the authenticator did not enable it', () => {
    const caught = new MeraErrorLike('PRF_UNAVAILABLE', 'Authenticator did not enable PRF');
    expect(classifySignInError(caught)).toBe('PRF_UNAVAILABLE');
    expect(messageForSignInError(caught)).toBe(PRF_UNAVAILABLE_MESSAGE);
  });

  it('names PRF when the assertion returned no output', () => {
    const caught = new MeraErrorLike('PRF_UNAVAILABLE', 'Authenticator did not return PRF output');
    expect(classifySignInError(caught)).toBe('PRF_UNAVAILABLE');
  });

  it('never shows the generic message for a PRF failure', () => {
    for (const message of [
      'Authenticator did not enable PRF',
      'Authenticator did not return PRF output',
      'PRF output must be 32 bytes',
    ]) {
      const caught = new MeraErrorLike('PRF_UNAVAILABLE', message);
      expect(messageForSignInError(caught)).not.toBe(UNKNOWN_MESSAGE);
    }
  });

  it('names the providers that work and offers the phone', () => {
    expect(PRF_UNAVAILABLE_MESSAGE).toContain('iCloud Keychain');
    expect(PRF_UNAVAILABLE_MESSAGE).toContain('Google Password Manager');
    expect(PRF_UNAVAILABLE_MESSAGE).toContain('1Password');
    expect(PRF_UNAVAILABLE_MESSAGE).toContain('your phone');
  });

  it('separates a bad origin from a cancelled ceremony, though both wrap the same code', () => {
    const security = new MeraErrorLike('PASSKEY_OPERATION_FAILED', 'Passkey creation failed', {
      cause: new DomExceptionLike(
        'SecurityError',
        'The relying party ID is not a registrable domain',
      ),
    });
    const cancelled = new MeraErrorLike('PASSKEY_OPERATION_FAILED', 'Passkey creation failed', {
      cause: new DomExceptionLike(
        'NotAllowedError',
        'The operation either timed out or was not allowed',
      ),
    });

    expect(classifySignInError(security)).toBe('SECURITY_ERROR');
    expect(classifySignInError(cancelled)).toBe('NOT_ALLOWED');
    expect(messageForSignInError(security)).toBe(SECURITY_ERROR_MESSAGE);
    expect(messageForSignInError(cancelled)).toBe(NOT_ALLOWED_MESSAGE);
    expect(messageForSignInError(security)).not.toBe(messageForSignInError(cancelled));
  });

  it('is the 127.0.0.1 regression: a SecurityError is not the generic message', () => {
    const caught = new MeraErrorLike('PASSKEY_OPERATION_FAILED', 'Passkey creation failed', {
      cause: new DomExceptionLike('SecurityError', 'rpId "127.0.0.1" is not a registrable domain'),
    });
    expect(messageForSignInError(caught)).not.toBe(UNKNOWN_MESSAGE);
    expect(shouldLogToConsole(classifySignInError(caught))).toBe(true);
    expect(developerNoteFor('SECURITY_ERROR', '127.0.0.1', 'http://127.0.0.1:3117')).toContain(
      '127.0.0.1',
    );
  });

  it('treats an insecure context as its own failure', () => {
    const caught = new MeraErrorLike('CRYPTO_UNAVAILABLE', 'crypto.getRandomValues is unavailable');
    expect(classifySignInError(caught)).toBe('INSECURE_CONTEXT');
  });

  it('reads a bare DOMException too, in case a caller does not go through Mera', () => {
    expect(classifySignInError(new DomExceptionLike('NotAllowedError', 'cancelled'))).toBe(
      'NOT_ALLOWED',
    );
    expect(classifySignInError(new DomExceptionLike('SecurityError', 'bad origin'))).toBe(
      'SECURITY_ERROR',
    );
  });

  it('falls back to the generic message only when nothing identifies the failure', () => {
    expect(messageForSignInError(new Error('something else went wrong'))).toBe(UNKNOWN_MESSAGE);
    expect(shouldLogToConsole('UNKNOWN')).toBe(false);
  });

  it('never puts a hex string or an error object in user-facing copy', () => {
    const caught = new MeraErrorLike('PASSKEY_OPERATION_FAILED', 'Passkey creation failed', {
      cause: new DomExceptionLike('SecurityError', '0xdeadbeef'),
    });
    expect(messageForSignInError(caught)).not.toContain('0x');
  });
});
