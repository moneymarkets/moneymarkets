import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Fakes just enough of the Web Audio API surface `sound.ts` calls (never enough to
 * assert the exact synthesis, which is not this module's contract) to prove the
 * three things that matter for an autoplay-policy-safe module: it never throws
 * when there is nothing to play with, it never constructs an `AudioContext` except
 * from inside a trigger call, and the sound preference / reduced-motion gates
 * actually stop it from doing so.
 */
interface FakeAudioNode {
  connect: () => FakeAudioNode;
  start: () => void;
  stop: () => void;
  gain: { setValueAtTime: () => void; exponentialRampToValueAtTime: () => void };
  frequency: {
    value: number;
    setValueAtTime: () => void;
    exponentialRampToValueAtTime: () => void;
  };
  Q: { value: number };
  type: string;
  buffer: unknown;
}

function chainable(): FakeAudioNode {
  const node = {} as FakeAudioNode;
  node.connect = () => node;
  node.start = () => {};
  node.stop = () => {};
  node.gain = { setValueAtTime() {}, exponentialRampToValueAtTime() {} };
  node.frequency = { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} };
  node.Q = { value: 0 };
  node.type = '';
  node.buffer = undefined;
  return node;
}

function fakeAudioContextClass(onConstruct: () => void) {
  return class FakeAudioContext {
    state = 'running';
    currentTime = 0;
    sampleRate = 44100;
    destination = {};
    constructor() {
      onConstruct();
    }
    resume() {
      return Promise.resolve();
    }
    createBuffer() {
      return { getChannelData: () => new Float32Array(8) };
    }
    createBufferSource() {
      return chainable();
    }
    createBiquadFilter() {
      return chainable();
    }
    createGain() {
      return chainable();
    }
    createOscillator() {
      return chainable();
    }
  };
}

function stubWindow(AudioContext: unknown, reduced = false) {
  (globalThis as { window?: unknown }).window = {
    AudioContext,
    matchMedia: () => ({ matches: reduced }),
  };
}

describe('wallet sound module', () => {
  const original = (globalThis as { window?: unknown }).window;

  afterEach(() => {
    if (original === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = original;
    vi.resetModules();
  });

  it('does not throw when AudioContext is unavailable (SSR / this test environment)', async () => {
    delete (globalThis as { window?: unknown }).window;
    const { swoosh, ding, tick } = await import('./sound');
    expect(() => swoosh(true)).not.toThrow();
    expect(() => ding(true)).not.toThrow();
    expect(() => tick(true)).not.toThrow();
  });

  it('never constructs an AudioContext at import time, only when a trigger is called', async () => {
    let constructed = 0;
    stubWindow(fakeAudioContextClass(() => constructed++));
    const mod = await import('./sound');
    expect(constructed).toBe(0);
    mod.tick(true);
    expect(constructed).toBe(1);
  });

  it('does not play when the sound preference is off', async () => {
    let constructed = 0;
    stubWindow(fakeAudioContextClass(() => constructed++));
    const { swoosh, ding, tick } = await import('./sound');
    swoosh(false);
    ding(false);
    tick(false);
    expect(constructed).toBe(0);
  });

  it('is silenced by prefers-reduced-motion even when the preference is on', async () => {
    let constructed = 0;
    stubWindow(fakeAudioContextClass(() => constructed++), true);
    const { ding } = await import('./sound');
    ding(true);
    expect(constructed).toBe(0);
  });

  it('plays when the preference is on and motion is not reduced', async () => {
    let constructed = 0;
    stubWindow(fakeAudioContextClass(() => constructed++), false);
    const { swoosh, ding, tick } = await import('./sound');
    swoosh(true);
    ding(true);
    tick(true);
    // One shared, lazily-constructed context reused across calls, not one per sound.
    expect(constructed).toBe(1);
  });

  it('canPlaySound mirrors the same gate the trigger functions use', async () => {
    stubWindow(fakeAudioContextClass(() => {}), false);
    const { canPlaySound } = await import('./sound');
    expect(canPlaySound(true)).toBe(true);
    expect(canPlaySound(false)).toBe(false);
  });
});
