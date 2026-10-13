import { defineConfig } from 'vitest/config';

/**
 * The trade app had no vitest config: everything it tested until 2026-09-09 lived under
 * `lib/` and the defaults found it. This states the include pattern rather than
 * inheriting it, now that there is more than one directory worth testing.
 *
 * Deliberately no jsdom, no testing-library and no JSX transform. The activity detail
 * view's honesty rule — a missing value removes its whole line — was moved into
 * `lib/activityDetailLines.ts` precisely so it could be asserted as data instead of by
 * scanning rendered HTML for the absence of a dash. That is both a stronger test and
 * one that needs nothing added to the dependency tree (rule A4).
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['{app,lib,components,scripts}/**/*.test.ts'],
  },
});
