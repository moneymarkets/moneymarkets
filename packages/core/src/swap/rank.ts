import type { SwapTx } from './types.js';

/**
 * Rule 1.3: the highest minimum out wins; a tie goes to the lower vendor gas estimate;
 * a vendor with no estimate sorts after one that has one. Which gas lane pays is
 * decided later and never by which vendor won. Stable: equal routes keep input order.
 */
export function rankRoutes<T extends Pick<SwapTx, 'minOut' | 'gasEstimate'>>(routes: readonly T[]): T[] {
  return routes
    .map((route, index) => ({ route, index }))
    .sort((a, b) => {
      if (a.route.minOut !== b.route.minOut) return a.route.minOut > b.route.minOut ? -1 : 1;
      const ga = a.route.gasEstimate;
      const gb = b.route.gasEstimate;
      if (ga !== undefined && gb !== undefined && ga !== gb) return ga < gb ? -1 : 1;
      if (ga !== undefined && gb === undefined) return -1;
      if (ga === undefined && gb !== undefined) return 1;
      return a.index - b.index;
    })
    .map(({ route }) => route);
}
