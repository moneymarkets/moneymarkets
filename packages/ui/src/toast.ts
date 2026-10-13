/**
 * Toast lifecycle, as arithmetic (spec F1): every toast auto-dismisses after four
 * seconds, and dismisses on tap or on a horizontal swipe. Kept free of React so the
 * rule is tested directly; `Toast` in `components.tsx` applies it.
 */

export const TOAST_MS = 4000;

/** Horizontal movement, in CSS px, that counts as a swipe rather than a tap. */
export const TOAST_SWIPE_PX = 40;

export function toastVisible(shownAt: number, now: number): boolean {
  return now - shownAt < TOAST_MS;
}

/** A gesture dismisses when it is mostly horizontal and long enough to be deliberate. */
export function swipeDismisses(dx: number, dy: number): boolean {
  return Math.abs(dx) >= TOAST_SWIPE_PX && Math.abs(dx) > Math.abs(dy);
}
