/*
 * The service worker. It caches the app shell and nothing else.
 *
 * Spec §6.5 says "offline shell only; never cache API", and the reason is the whole
 * point of this build: a cached `/api/account` would draw yesterday's balance in a
 * hero that looks exactly like a live one. A user cannot tell those apart, so the
 * worker is written so it cannot happen — every request whose path contains `/api/`
 * is handed straight back to the network, before any cache is even opened, and the
 * cache is never written from a response the worker did not fetch as a shell asset.
 *
 * Three rules, in order:
 *
 *   1. Not a GET, or an API path, or another origin  -> the worker does nothing.
 *   2. A hashed build asset under `_next/static`     -> cache first. The hash is in
 *      the URL, so a stale answer is impossible by construction.
 *   3. A page navigation                             -> network first, and the cached
 *      shell only when the network is genuinely gone. Offline, that shell renders
 *      its own loading and error states against an API it cannot reach, which is
 *      the honest picture.
 *
 * `SCOPE_PREFIX` is filled in from the worker's own location rather than from a build
 * variable, so the same file works at `/` and under `/tradepro`.
 */

const VERSION = 'tradepro-shell-v1';
const SCOPE_PREFIX = new URL(self.registration.scope).pathname.replace(/\/$/, '');

/** What is worth having before the network disappears. */
const SHELL = [
  `${SCOPE_PREFIX}/home`,
  `${SCOPE_PREFIX}/manifest.webmanifest`,
  `${SCOPE_PREFIX}/icon-192.png`,
  `${SCOPE_PREFIX}/icon-512.png`,
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(VERSION);
      // One failure must not sink the install; a missing icon is not a reason to
      // leave the user with no worker at all.
      await Promise.allSettled(SHELL.map((url) => cache.add(url)));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== VERSION).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

function isApi(url) {
  // Deliberately broad. `/api/` anywhere in the path, on any origin, is never cached
  // and never served from a cache.
  return url.pathname.includes('/api/');
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isApi(url)) return;

  // Hashed build output. The hash is the version, so the cache cannot go stale.
  if (url.pathname.startsWith(`${SCOPE_PREFIX}/_next/static/`)) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(VERSION);
          cache.put(request, response.clone());
        }
        return response;
      })(),
    );
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          if (response.ok) {
            const cache = await caches.open(VERSION);
            cache.put(request, response.clone());
          }
          return response;
        } catch (offline) {
          const cached =
            (await caches.match(request)) ?? (await caches.match(`${SCOPE_PREFIX}/home`));
          if (cached) return cached;
          throw offline;
        }
      })(),
    );
  }
});
