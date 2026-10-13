import { afterEach, beforeEach } from 'vitest';

/**
 * Give a test file its own view of `process.env`.
 *
 * ## The flake this fixes
 *
 * `process.env` is process-global. Three files in this suite mutate it —
 * `bundler.test.ts` sets and deletes `PIMLICO_API_KEY`, `config.test.ts` and
 * `keystore.test.ts` do the same for the relayer key variables — and each used a bare
 * `delete` in `afterEach`. Under a parallel run that is a race: one file's teardown
 * removes a variable another file's test is relying on, and
 * `bundler.test.ts > refuses everything when the relayer is not armed` fails about one
 * run in four. It passes alone every time, which is what made it look like noise.
 *
 * A test that fails once in four runs is worse than one that fails every time. It
 * teaches everyone to re-run instead of read, and the next real failure gets the same
 * shrug.
 *
 * ## Snapshot the whole thing, restore the whole thing
 *
 * Deleting the keys a test set is not the same as putting the environment back: it
 * cannot restore a value that was already there, and it silently leaves behind anything
 * the test set that the teardown forgot. Copying the object and reassigning it covers
 * both, and needs no list of names to keep in sync with the tests.
 *
 * The relayer's vitest config also isolates each file in its own process, so this is
 * belt and braces — but only this part survives someone changing the pool.
 */
export function isolateEnv(): void {
  let snapshot: NodeJS.ProcessEnv;

  beforeEach(() => {
    snapshot = { ...process.env };
  });

  afterEach(() => {
    // Reassigning `process.env` wholesale does not work on all runtimes, so the keys are
    // reconciled in place: remove what the test added, restore what it changed or deleted.
    for (const key of Object.keys(process.env)) {
      if (!(key in snapshot)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(snapshot)) {
      if (value !== undefined) process.env[key] = value;
    }
  });
}
