'use client';

import { prefersReducedMotion } from './motionGate';

/**
 * Wallet haptics (spec §7), via `navigator.vibrate` where the device has it.
 *
 * Two patterns, ported from the reference's `buzz()` calls: a short pulse on a
 * Face ID / passkey prompt, a triple pulse on Confirmed. Like `sound.ts`, every
 * export takes the resolved `enabled` preference as an argument rather than
 * reading a global, and is silenced by `prefers-reduced-motion` regardless of that
 * preference.
 */

/** Whether a vibration should fire at all. */
export function canVibrate(enabled: boolean): boolean {
  return (
    enabled &&
    !prefersReducedMotion() &&
    typeof navigator !== 'undefined' &&
    typeof navigator.vibrate === 'function'
  );
}

/** Fire a vibration pattern (ms, or on/off/on/... ms), swallowing any failure —
 *  a device that refuses to vibrate is never a reason to fail the action. */
export function buzz(enabled: boolean, pattern: number | readonly number[]): void {
  if (!canVibrate(enabled)) return;
  try {
    navigator.vibrate(pattern as number | number[]);
  } catch {
    // Vibration can be refused by the platform at any time; nothing to recover.
  }
}

/** Short pulse, for a Face ID / passkey prompt. */
export function hapticFaceId(enabled: boolean): void {
  buzz(enabled, 20);
}

/** Triple pulse, for Confirmed. */
export function hapticConfirmed(enabled: boolean): void {
  buzz(enabled, [30, 40, 30]);
}
