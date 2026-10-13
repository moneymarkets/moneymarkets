/**
 * Next.js's own startup hook, run once when the server process boots — not per
 * request. This is what makes the deposit watcher a genuine background service
 * rather than something re-created on every `/fund` page load.
 *
 * Runs in the Node runtime only (the `nodejs` check): the Edge runtime cannot open a
 * SQLite file or run a `setInterval` that outlives a request, and this app's Edge
 * routes have no reason to import this module anyway.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { startDepositWatcher } = await import('./lib/server/deposits/watcher');
  startDepositWatcher();
}
