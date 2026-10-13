import { afterEach, describe, expect, it } from 'vitest';
import { prefersReducedMotion } from './motionGate';

describe('prefersReducedMotion', () => {
  const original = (globalThis as { window?: unknown }).window;

  afterEach(() => {
    if (original === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = original;
  });

  it('is false with no window at all (SSR / this test environment)', () => {
    delete (globalThis as { window?: unknown }).window;
    expect(prefersReducedMotion()).toBe(false);
  });

  it('reflects the media query when one exists', () => {
    (globalThis as { window?: unknown }).window = {
      matchMedia: (query: string) => ({ matches: query.includes('reduce') }),
    };
    expect(prefersReducedMotion()).toBe(true);
  });

  it('is false when the media query reports no preference', () => {
    (globalThis as { window?: unknown }).window = {
      matchMedia: () => ({ matches: false }),
    };
    expect(prefersReducedMotion()).toBe(false);
  });

  it('fails safe to true when matchMedia itself throws', () => {
    (globalThis as { window?: unknown }).window = {
      matchMedia: () => {
        throw new Error('blocked');
      },
    };
    expect(prefersReducedMotion()).toBe(true);
  });
});
