import { describe, expect, it } from 'vitest';
import { swipeDismisses, TOAST_MS, TOAST_SWIPE_PX, toastVisible } from './toast.js';

describe('toast lifecycle (spec F1)', () => {
  it('auto-dismisses at four seconds, not before', () => {
    expect(TOAST_MS).toBe(4000);
    expect(toastVisible(0, 3999)).toBe(true);
    expect(toastVisible(0, 4000)).toBe(false);
  });

  it('a horizontal swipe dismisses; a tap-length wobble or a vertical scroll does not', () => {
    expect(swipeDismisses(TOAST_SWIPE_PX, 0)).toBe(true);
    expect(swipeDismisses(-TOAST_SWIPE_PX - 10, 5)).toBe(true);
    expect(swipeDismisses(10, 0)).toBe(false);
    expect(swipeDismisses(50, 80)).toBe(false);
  });
});
