'use client';

import { useEffect } from 'react';
import { BASE_PATH } from '../lib/basePath';

/**
 * Registers the app-shell worker, once, for every visitor.
 *
 * It is mounted in the root layout rather than next to the install banner, because
 * the two are not the same job: the banner is an offer that only some browsers can
 * take up, while the worker is what makes the app open at all when the network is
 * gone. Hanging registration off a signed-in screen meant a signed-out visitor never
 * got one.
 *
 * The worker caches the shell and refuses to touch `/api/` — see `public/sw.js`.
 */
export function ServiceWorker() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    void navigator.serviceWorker
      .register(`${BASE_PATH}/sw.js`, { scope: `${BASE_PATH}/` })
      .catch(() => {
        // No worker means no offline shell and nothing else. Online, the app is
        // identical, so this is not worth telling anyone about.
      });
  }, []);
  return null;
}
