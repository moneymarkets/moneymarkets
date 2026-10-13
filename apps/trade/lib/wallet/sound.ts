'use client';

import { prefersReducedMotion } from './motionGate';

/**
 * Wallet sounds (spec §7), synthesised in the browser with the Web Audio API. No
 * audio files: this app's CSP has no asset host to add, and none is needed.
 *
 * Ported faithfully from the interaction reference's `<script>` block —
 * `swoosh()` (a band-passed noise sweep), `ding()` (a two-note chime) and `tick()`
 * (a short click) do the same synthesis those did, as a real TypeScript module
 * instead of inline script.
 *
 * ## Why the `AudioContext` cannot leak into a page load
 *
 * Browsers refuse to run an `AudioContext` until a user gesture has happened, and
 * silently ignoring that refusal a second time (after one real gesture already
 * resumed the context) is not the same guarantee. So the context is constructed
 * here, lazily, inside `ctx()`, and `ctx()` is only ever called from inside
 * `swoosh`/`ding`/`tick` — never at module load, never in a `useEffect`. A caller
 * that wires one of these into a `useEffect` instead of a click handler has broken
 * the one rule this module exists to keep; nothing here can stop that, but nothing
 * here does it either.
 *
 * Every exported function takes the resolved `enabled` preference as its first
 * argument rather than reading a global — the caller (the Wallet settings screen,
 * the header toggle, or a Swap/Send/Move ticket) already knows the account's
 * current preference, and a module-level flag here would be one more place that
 * preference could drift out of step with the one in `localStorage`.
 */

type AudioCtor = new () => AudioContext;

let cached: AudioContext | undefined;

function ctx(): AudioContext | undefined {
  try {
    if (typeof window === 'undefined') return undefined;
    const Ctor = (window.AudioContext ??
      (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext) as
      | AudioCtor
      | undefined;
    if (!Ctor) return undefined;
    if (!cached) cached = new Ctor();
    if (cached.state === 'suspended') void cached.resume();
    return cached;
  } catch {
    return undefined;
  }
}

/** Whether a sound should play at all: the preference is on, reduced motion is not
 *  requested, and there is a browser to play it in. Exported so a screen can decide
 *  whether to bother building a label ("Swoosh") without duplicating this logic. */
export function canPlaySound(enabled: boolean): boolean {
  return enabled && !prefersReducedMotion() && typeof window !== 'undefined';
}

/** Band-passed noise sweeping upward, for Sending (spec §7). */
export function swoosh(enabled: boolean, durationSec = 0.55): void {
  if (!canPlaySound(enabled)) return;
  const a = ctx();
  if (!a) return;
  try {
    const n = Math.max(1, Math.floor(a.sampleRate * durationSec));
    const buffer = a.createBuffer(1, n, a.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / n);

    const source = a.createBufferSource();
    source.buffer = buffer;

    const filter = a.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 1.2;
    filter.frequency.setValueAtTime(400, a.currentTime);
    filter.frequency.exponentialRampToValueAtTime(3200, a.currentTime + durationSec * 0.7);

    const gain = a.createGain();
    gain.gain.setValueAtTime(0.0001, a.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.3, a.currentTime + 0.08);
    gain.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + durationSec);

    source.connect(filter).connect(gain).connect(a.destination);
    source.start();
  } catch {
    // A sound that fails to play is never worth breaking the action it announced.
  }
}

/** Two-note chime, for Confirmed (spec §7). */
export function ding(enabled: boolean): void {
  if (!canPlaySound(enabled)) return;
  const a = ctx();
  if (!a) return;
  try {
    [880, 1320].forEach((freq, i) => {
      const osc = a.createOscillator();
      const gain = a.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const at = a.currentTime + i * 0.06;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.25, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.5);
      osc.connect(gain).connect(a.destination);
      osc.start(at);
      osc.stop(at + 0.55);
    });
  } catch {
    // Same: never break the action over a sound.
  }
}

/** Short click, for taps (spec §7). */
export function tick(enabled: boolean): void {
  if (!canPlaySound(enabled)) return;
  const a = ctx();
  if (!a) return;
  try {
    const osc = a.createOscillator();
    const gain = a.createGain();
    osc.type = 'triangle';
    osc.frequency.value = 1500;
    gain.gain.setValueAtTime(0.1, a.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + 0.08);
    osc.connect(gain).connect(a.destination);
    osc.start();
    osc.stop(a.currentTime + 0.09);
  } catch {
    // Same.
  }
}
