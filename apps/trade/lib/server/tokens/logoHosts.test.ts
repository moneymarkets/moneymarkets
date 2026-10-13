import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '../../../middleware';

/**
 * Token icons are served from our own `/api/token-icon/<address>`, so the CSP allows
 * no third-party image host: `img-src` is exactly `'self' data:`, in the per-request
 * policy and in the static floor in `next.config.mjs`.
 */
describe('CSP img-src allows only our own origin', () => {
  it('middleware policy: self and data:, nothing else', () => {
    const response = middleware(new NextRequest('https://tradepro.example/wallet'));
    const csp = response.headers.get('Content-Security-Policy') ?? '';
    const imgSrc = csp.split('; ').find((d) => d.startsWith('img-src')) ?? '';
    expect(imgSrc.split(' ').filter(Boolean).slice(1)).toEqual(["'self'", 'data:']);
  });

  it('static next.config.mjs policy matches', () => {
    const config = readFileSync(join(import.meta.dirname, '../../../next.config.mjs'), 'utf8');
    const lines = config.split('\n').filter((l) => l.includes('img-src'));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.trim()).toBe(`"img-src 'self' data:",`);
  });
});
