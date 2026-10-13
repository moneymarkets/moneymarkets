/**
 * The one check `sound.ts`, `haptics.ts` and the JS-driven motion primitives in
 * `@tradepro/ui` all defer to: `prefers-reduced-motion` overrides the stored sound
 * and haptics preference, never the other way round (wallet spec §7, rule A6).
 *
 * Read directly from `window.matchMedia` rather than through React's
 * `usePrefersReducedMotion` hook, because `sound.ts` and `haptics.ts` are plain
 * functions called from event handlers, not components — the hook exists for
 * screens that render differently under reduced motion; this exists for code that
 * cannot call a hook at all.
 */
export function prefersReducedMotion(): boolean {
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    // A browser that throws on matchMedia is not one to risk motion on.
    return true;
  }
}
