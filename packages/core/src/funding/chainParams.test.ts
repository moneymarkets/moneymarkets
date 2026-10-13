import { describe, expect, it } from 'vitest';
import { isTrustedExplorerUrl } from './chainParams.js';

/**
 * Audit M4: a rail's own `explorerUrl` on a refund row is a vendor-chosen string,
 * rendered as a clickable link inside this app's own UI. Not XSS (React neutralises
 * `javascript:`), but an unchecked link presented as ours is a clean phishing
 * primitive, so it is gated on being `https:` to one of the explorer hosts this repo
 * has actually verified (`chainParams.ts`'s own `PARAMS`), never on the vendor's word.
 */
describe('isTrustedExplorerUrl', () => {
  it('accepts a real transaction link on a verified explorer', () => {
    expect(isTrustedExplorerUrl('https://basescan.org/tx/0xabc123')).toBe(true);
    expect(isTrustedExplorerUrl('https://explorer.monad.xyz/tx/0xabc123')).toBe(true);
    expect(isTrustedExplorerUrl('https://etherscan.io/tx/0xabc123')).toBe(true);
  });

  it('refuses a host this repo has not verified an explorer for', () => {
    expect(isTrustedExplorerUrl('https://totally-legit-basescan.org/tx/0xabc')).toBe(false);
    expect(isTrustedExplorerUrl('https://solscan.io/tx/abc')).toBe(false);
    expect(isTrustedExplorerUrl('https://evil.example/tx/0xabc')).toBe(false);
  });

  it('refuses a non-https scheme even on a real explorer host', () => {
    expect(isTrustedExplorerUrl('http://basescan.org/tx/0xabc')).toBe(false);
    expect(isTrustedExplorerUrl('javascript:alert(1)')).toBe(false);
  });

  it('refuses a malformed URL rather than throwing', () => {
    expect(isTrustedExplorerUrl('not a url')).toBe(false);
    expect(isTrustedExplorerUrl('')).toBe(false);
  });

  it('refuses a lookalike host that merely contains a real one as a substring', () => {
    expect(isTrustedExplorerUrl('https://basescan.org.evil.example/tx/0xabc')).toBe(false);
  });

  it('is not fooled by userinfo before a real host — `new URL` parses that correctly', () => {
    // `evil.example@basescan.org` is userinfo="evil.example", host="basescan.org": a
    // real basescan.org link, not a spoof, and a naive `.includes('basescan.org')`
    // check would have gotten this right for the wrong reason. `new URL` parses it
    // correctly for the right one.
    expect(isTrustedExplorerUrl('https://evil.example@basescan.org/tx/0xabc')).toBe(true);
  });
});
