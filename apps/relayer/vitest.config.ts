import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    /**
     * One process per test file.
     *
     * Several files here mutate `process.env`, which is process-global: under a shared
     * worker, one file's teardown removes a variable another file's test is depending
     * on. That produced a roughly one-in-four failure in the mode-gate test that passed
     * every time in isolation. `forks` gives each file its own process, so there is no
     * shared environment left to race over.
     */
    pool: 'forks',
    /**
     * Each file's first test pays its forked process's cold import of the whole server
     * (viem, fastify, node:sqlite). Under `pnpm -r test`, with every workspace testing at
     * once, that alone passed the 5 s default: the same five first-in-file tests timed
     * out in two of three gated deploys on 2026-09-30, and all 420 passed on their own.
     * A time limit only; no assertion changed.
     */
    testTimeout: 20_000,
  },
});
