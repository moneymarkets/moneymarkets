import { NextResponse, type NextRequest } from 'next/server';

/**
 * A per-request CSP nonce, so `script-src` can stop allowing inline script.
 *
 * ## What this closes
 *
 * The policy was `script-src 'self' 'unsafe-inline'`. The comment beside it read
 * "scripts stay locked to self, so no external origin can inject one" — which is the
 * wrong threat model twice over. With `'unsafe-inline'` an attacker never needs an
 * external origin: any injected `<script>` tag or inline handler executes, and
 * `'self'` does nothing to stop it.
 *
 * That mattered more here than in most apps. The signing account is a live object in
 * React state, and React attaches `__reactFiber$<hash>` to every host DOM node, so a
 * script that runs in the page can walk from `document.body` to the session provider
 * and use the signer. The key itself is no longer reachable — `accountFromMnemonic`
 * strips `getHdKey` — but an armed signer is still an armed signer.
 *
 * With a nonce, an injected tag has no nonce and does not run.
 *
 * ## Why `strict-dynamic`
 *
 * Next's App Router bootstraps and streams RSC payloads through inline scripts it
 * generates itself. Those carry the nonce. `strict-dynamic` lets scripts they load in
 * turn inherit trust, which is what makes chunk loading work without listing every
 * hashed filename. Browsers that do not understand it fall back to `'self'`, so the
 * policy degrades to what it was rather than to nothing.
 *
 * ## Why the header is set here and not only in `next.config.mjs`
 *
 * A nonce must be unique per response. `headers()` in the config is static — it cannot
 * generate one. The static policy remains as the floor for anything middleware does not
 * match; this replaces it on every HTML document request.
 */

/** 128 bits, base64. Web Crypto is available in the middleware runtime. */
function nonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

export function middleware(request: NextRequest) {
  const value = nonce();
  const isDev = process.env.NODE_ENV === 'development';

  const csp = [
    "default-src 'self'",
    // `unsafe-eval` in development only: React rebuilds server error stacks with eval
    // in dev. `next build`/`next start` set NODE_ENV=production, so the deployed
    // policy never carries it.
    `script-src 'self' 'nonce-${value}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    // Styles keep `unsafe-inline`: Next inlines critical CSS and there is no nonce
    // hook for it. A style injection cannot reach the signer.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    // Token icons come from our own `/api/token-icon/<address>` (resolved and resized
    // server-side), so no third-party image host is allowed.
    "img-src 'self' data:",
    /**
     * Named hosts rather than a blanket `https:`.
     *
     * `connect-src https:` meant any script that did run could post to any host on the
     * internet — the exfiltration half of the problem. The browser talks directly to
     * the Monad RPC (`bundlerTransport` builds a viem client with no URL, so it uses
     * the chain default), so that host is named; everything else this app fetches is
     * same-origin through `apiUrl()`.
     */
    "connect-src 'self' https://rpc.monad.xyz https://fonts.gstatic.com",
    "worker-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');

  // Next reads this header and stamps the nonce onto the scripts it generates.
  const headers = new Headers(request.headers);
  headers.set('x-nonce', value);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  /**
   * Document requests only.
   *
   * Static assets and images need no policy of their own and would only pay for the
   * nonce generation. `/api/` is excluded because a JSON response has no scripts and
   * the static header from `next.config.mjs` still covers it.
   */
  matcher: [
    {
      source: '/((?!api|_next/static|_next/image|favicon.ico|sw.js|manifest.webmanifest).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
