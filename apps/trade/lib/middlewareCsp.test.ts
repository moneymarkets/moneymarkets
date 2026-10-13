import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '../middleware';

/**
 * The per-request CSP `middleware.ts` stamps onto every document response.
 *
 * `img-src` is `'self' data:` only: token icons are resolved and resized server-side
 * and served from `/api/token-icon/<address>`, so no third-party image host is named. `csp.test.ts` in this same directory covers the
 * static floor `next.config.mjs` sets for anything this middleware does not match.
 */
describe('middleware CSP img-src', () => {
  it('keeps img-src to our own origin: token icons come from /api/token-icon', () => {
    const response = middleware(new NextRequest('https://tradepro.example/wallet'));
    const csp = response.headers.get('Content-Security-Policy') ?? '';
    const imgSrc = csp.split('; ').find((d) => d.startsWith('img-src')) ?? '';
    expect(imgSrc.split(' ').filter(Boolean)).toEqual(['img-src', "'self'", 'data:']);
  });

  it('keeps every other directive intact alongside the img-src change', () => {
    const response = middleware(new NextRequest('https://tradepro.example/wallet'));
    const csp = response.headers.get('Content-Security-Policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
  });
});
