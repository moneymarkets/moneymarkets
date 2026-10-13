import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/**
 * The monorepo keeps one `.env` at its root; Next only looks inside the app. Rather
 * than duplicate the file (two copies drift, and one of them ends up committed),
 * this copies across an **explicit allowlist** of keys.
 *
 * The allowlist is the point. The root `.env` also holds relayer and deployer key
 * material, and none of it belongs in the web server's process — so nothing outside
 * this list is read, whatever the file grows to contain. Values already present in
 * the environment win, so a deploy that sets them properly is untouched.
 */
const ENV_ALLOWLIST = [
  'CHAIN',
  'MODE',
  'I_UNDERSTAND_THIS_USES_REAL_FUNDS',
  'RPC_URL_MONAD',
  'RPC_URL_MONAD_MAINNET',
  'NEXT_PUBLIC_RP_ID',
  'NEXT_PUBLIC_BASE_PATH',
  'NEXT_PUBLIC_BUILD_ID',
  'NEXT_PUBLIC_MARKETS',
  'NEXT_PUBLIC_DEFAULT_MARKET',
  'NEXT_PUBLIC_FUND_PATH_A',
  // Funding rails. Server-only by construction: none is NEXT_PUBLIC_, so none can
  // reach the browser bundle even if a component asked for it (R6).
  'RELAY_API_KEY',
  'RELAY_APP_FEE_RECIPIENT',
  'RELAY_APP_FEE_BPS',
  'ACROSS_INTEGRATOR_ID',
  'CIRCLE_API_KEY',
];

function loadRootEnv() {
  const here = dirname(fileURLToPath(import.meta.url));
  const rootEnv = resolve(here, '../../.env');
  let contents;
  try {
    contents = readFileSync(rootEnv, 'utf8');
  } catch {
    return; // No local .env. The deployment supplies its own environment.
  }
  for (const line of contents.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (!ENV_ALLOWLIST.includes(key)) continue;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^["']|["']$/g, '');
  }
}

loadRootEnv();

/**
 * A build id the browser can show.
 *
 * Not decoration: an armed deployment kept answering "simulated mode" because the tab
 * was running a bundle built before the fix, and there was no way to tell by looking.
 * The footer prints this, so "did my browser actually load the new code" is a question
 * the screen answers rather than the logs.
 */
process.env.NEXT_PUBLIC_BUILD_ID ??= new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

/** @type {import('next').NextConfig} */
const basePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/$/, '');

const nextConfig = {
  reactStrictMode: true,
  /**
   * Where the build lands.
   *
   * A running dev server holds `.next` open, and on Windows that makes `next build`
   * fail with EBUSY rather than waiting. `NEXT_DIST_DIR=.next-build next build`
   * measures a production bundle without disturbing whoever is developing. Unset,
   * it is Next's own default and nothing changes.
   *
   * One caveat: Next rewrites the generated `next-env.d.ts` to point at whichever
   * dist dir it just used, so restore that file afterwards or the next `typecheck`
   * looks for types in a directory that is git-ignored.
   */
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  // Self-contained server output, so the box needs the build and a node binary
  // rather than a copy of the monorepo's node_modules.
  output: 'standalone',
  outputFileTracingRoot: resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
  ...(basePath ? { basePath, assetPrefix: basePath } : {}),
  transpilePackages: ['@tradepro/ui', '@tradepro/core'],
  async headers() {
    // Rule A4: CSP and HSTS. `unsafe-inline` on styles is Next's inline critical CSS;
    // scripts stay locked to self, so no external origin can inject one.
    //
    // `unsafe-eval` is added in DEVELOPMENT ONLY. React uses eval() in dev to rebuild
    // server-side error stacks in the browser, and without it the console reports
    // "eval() is not supported in this environment" on every page. Neither React nor
    // Next uses eval in production, so the deployed policy stays closed — this is the
    // shape Next's own CSP guide gives for a headers() policy that uses unsafe-inline
    // (node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md).
    //
    // If this ever appears in a production response, that is a bug, not a tradeoff:
    // NODE_ENV is 'production' for `next build` and `next start`.
    const isDev = process.env.NODE_ENV === 'development';
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              "font-src 'self' https://fonts.gstatic.com",
              // Kept in sync with middleware.ts's per-request policy: token icons are
              // served from our own origin, so no third-party image host.
              "img-src 'self' data:",
              "connect-src 'self' https: wss:",
              // The PWA service worker is same-origin; naming it explicitly rather
              // than leaning on default-src, since browsers differ on that fallback.
              "worker-src 'self'",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join('; '),
          },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default nextConfig;
