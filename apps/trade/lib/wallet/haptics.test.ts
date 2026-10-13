import { afterEach, describe, expect, it, vi } from 'vitest';

function stubNavigator(vibrate: ((pattern: number | number[]) => boolean) | undefined, reduced = false) {
  (globalThis as { navigator?: unknown }).navigator = vibrate ? { vibrate } : {};
  (globalThis as { window?: unknown }).window = { matchMedia: () => ({ matches: reduced }) };
}

describe('wallet haptics module', () => {
  const originalNavigator = (globalThis as { navigator?: unknown }).navigator;
  const originalWindow = (globalThis as { window?: unknown }).window;

  afterEach(() => {
    if (originalNavigator === undefined) delete (globalThis as { navigator?: unknown }).navigator;
    else (globalThis as { navigator?: unknown }).navigator = originalNavigator;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = originalWindow;
    vi.resetModules();
  });

  it('does not throw with no navigator.vibrate at all (SSR / this test environment)', async () => {
    delete (globalThis as { navigator?: unknown }).navigator;
    delete (globalThis as { window?: unknown }).window;
    const { buzz, hapticFaceId, hapticConfirmed } = await import('./haptics');
    expect(() => buzz(true, 20)).not.toThrow();
    expect(() => hapticFaceId(true)).not.toThrow();
    expect(() => hapticConfirmed(true)).not.toThrow();
  });

  it('fires a short pulse on hapticFaceId and a triple pulse on hapticConfirmed', async () => {
    const calls: (number | number[])[] = [];
    stubNavigator((pattern) => {
      calls.push(pattern);
      return true;
    });
    const { hapticFaceId, hapticConfirmed } = await import('./haptics');
    hapticFaceId(true);
    hapticConfirmed(true);
    expect(calls).toEqual([20, [30, 40, 30]]);
  });

  it('does not vibrate when the preference is off', async () => {
    const calls: unknown[] = [];
    stubNavigator((pattern) => {
      calls.push(pattern);
      return true;
    });
    const { buzz } = await import('./haptics');
    buzz(false, 20);
    expect(calls).toHaveLength(0);
  });

  it('is silenced by prefers-reduced-motion even when the preference is on', async () => {
    const calls: unknown[] = [];
    stubNavigator((pattern) => {
      calls.push(pattern);
      return true;
    }, true);
    const { buzz } = await import('./haptics');
    buzz(true, 20);
    expect(calls).toHaveLength(0);
  });
});
