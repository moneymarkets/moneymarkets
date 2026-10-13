import { describe, expect, it } from 'vitest';
import { isIpOrigin } from './dev.mjs';

/**
 * The dev server's origin guard. WebAuthn requires the relying-party id to be a
 * registrable domain, which an address literal never is — so a dev server on an IP
 * produces passkey failures that no copy on the screen can explain. It refuses
 * instead, and this says what it refuses.
 */
describe('isIpOrigin', () => {
  it('refuses IPv4 literals, including the loopback that started this', () => {
    expect(isIpOrigin('127.0.0.1')).toBe(true);
    expect(isIpOrigin('192.168.1.20')).toBe(true);
    expect(isIpOrigin('0.0.0.0')).toBe(true);
  });

  it('refuses IPv6 literals in both spellings', () => {
    expect(isIpOrigin('::1')).toBe(true);
    expect(isIpOrigin('[::1]')).toBe(true);
    expect(isIpOrigin('fe80::1')).toBe(true);
  });

  it('accepts localhost, which is the one loopback WebAuthn treats as a domain', () => {
    expect(isIpOrigin('localhost')).toBe(false);
  });

  it('accepts real hostnames, including a tunnel', () => {
    expect(isIpOrigin('moneymarkets.trade')).toBe(false);
    expect(isIpOrigin('something-random.trycloudflare.com')).toBe(false);
  });
});
