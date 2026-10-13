import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import './globals.css';
import { ServiceWorker } from '../components/ServiceWorker';
import { SessionProvider } from '../lib/session';
import { BASE_PATH } from '../lib/basePath';
import { THEME_BOOTSTRAP, ThemeProvider } from '../lib/theme';

/**
 * Phase 2 shell. The chrome (rail on desktop, tab bar on phone) lives in
 * `components/Chrome.tsx` and is mounted per screen rather than here, because `/` is
 * the one screen with no navigation (design §5.1).
 */

export const metadata: Metadata = {
  title: 'MoneyMarkets',
  description: 'Your dollars. Trading on Monad. No gas, no seed phrase.',
  // `basePath` rewrites Next's own routes, but a metadata URL is emitted as written,
  // so these carry the prefix themselves. Under `/tradepro` a bare `/favicon.ico`
  // leaves the app entirely.
  manifest: `${BASE_PATH}/manifest.webmanifest`,
  icons: {
    icon: [
      { url: `${BASE_PATH}/favicon.svg`, type: 'image/svg+xml' },
      { url: `${BASE_PATH}/favicon.ico`, sizes: '48x48 32x32 16x16' },
      { url: `${BASE_PATH}/icon-192.png`, type: 'image/png', sizes: '192x192' },
    ],
    apple: [{ url: `${BASE_PATH}/apple-touch-icon.png`, sizes: '180x180' }],
  },
  metadataBase: new URL('https://moneymarkets.trade'),
  openGraph: {
    title: 'MoneyMarkets',
    description: 'Trade on Kuru with Face ID. No wallet, no gas.',
    images: [{ url: `${BASE_PATH}/og-image.png`, width: 1200, height: 630 }],
  },
  twitter: { card: 'summary_large_image', images: [`${BASE_PATH}/og-image.png`] },
  appleWebApp: { capable: true, title: 'MoneyMarkets', statusBarStyle: 'black-translucent' },
  other: { 'mobile-web-app-capable': 'yes' },
};

// Redesign (2026-09-30): the PWA shell's two theme colours, from
// design/tradepro-redesign.html's `:root` — dark green / white, not the previous
// mint-paper palette. `lib/theme.tsx`'s `ThemeProvider` keeps these two `<meta>`
// tags in sync with the resolved theme after hydration (an explicit Light/Dark
// choice, not just the OS setting), since Next's static `themeColor` can only
// answer `prefers-color-scheme` at first paint.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#FFFFFF' },
    { media: '(prefers-color-scheme: dark)', color: '#0B1A14' },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  /**
   * The per-request CSP nonce, set by `middleware.ts`.
   *
   * The theme bootstrap below is the app's one inline script. Under a nonce policy it
   * needs the nonce or it does not run, and if it does not run a dark-mode user sees a
   * white flash before hydration. Reading it here rather than threading it through
   * props keeps that coupling in one place.
   */
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    /*
      `suppressHydrationWarning` belongs here and nowhere else.

      The script below stamps `data-theme` on this element before the first paint —
      that is the whole point of it, and it means the DOM React hydrates into carries
      an attribute the server never rendered. React reports that as a mismatch it
      "won't patch up", which is true and, here, harmless: the attribute is the
      correct one and the server could not have known it.

      The flag suppresses exactly one level — this element's own attributes and text.
      It does not hide mismatches anywhere inside the tree, so a real hydration bug in
      a screen still surfaces. The alternative, rendering without a theme and letting
      the client correct it, is a mint-white flash on every load for a dark-mode user.
    */
    <html lang="en" suppressHydrationWarning>
      <head>
        {/*
          Stamps the saved theme on <html> before the first paint, so a dark-mode
          user never sees a mint-white frame. A constant string, never interpolated
          content (rule A4).
        */}
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* Redesign: Bricolage Grotesque only, system-ui fallback (tokens.css'
            `--font-display`/`--font-ui`), matching design/tradepro-redesign.html —
            Instrument Sans is dropped, the only dependency/config change this
            reskin makes besides CSS. */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,300..700&display=swap"
        />
      </head>
      <body>
        <ThemeProvider>
          <SessionProvider>{children}</SessionProvider>
        </ThemeProvider>
        <ServiceWorker />
      </body>
    </html>
  );
}
