/**
 * A guard against exactly the mistake that leaked `PIMLICO_API_KEY` and
 * `RELAYER_KEYSTORE_PASSPHRASE` into a chat transcript (2026-09-04, DECISIONS.md
 * D114): a diagnostic command's own "redact secrets" filter — a hand-written `sed`
 * transform meant to show key names but not values — silently failed, and the real
 * values were printed.
 *
 * The fix is not a smarter filter. A filter can always fail the same way again,
 * silently, because its failure mode is "print the thing it was supposed to hide."
 * This guard's failure mode is the opposite: it refuses to print anything at all
 * once it sees the shape of a secret's real value, so a broken caller gets a thrown
 * error instead of a leak. Rule A4 requires diagnostics that touch `.env`/`.secrets/`
 * to route their output through this, or an equivalent, rather than a bespoke filter.
 */

/**
 * Every env var name this repo treats as a secret. Add to this list whenever a new
 * one is introduced; never remove a name without recording why in `DECISIONS.md` —
 * a name silently dropped here is a name this guard stops protecting.
 */
export const SECRET_ENV_NAMES = [
  'PIMLICO_API_KEY',
  'RELAYER_KEYSTORE_PASSPHRASE',
  'RELAYER_PRIVATE_KEY',
] as const;

export type SecretEnvName = (typeof SECRET_ENV_NAMES)[number];

/**
 * Matches `NAME=value` at the start of a line, for any allowlisted secret name,
 * only when a value actually follows the `=`. `NAME=` with nothing after it — the
 * shape a "list the key names only" diagnostic produces — is deliberately allowed
 * through: that is what this guard exists to let past.
 */
function leakPattern(names: readonly string[]): RegExp {
  return new RegExp(`^(${names.join('|')})=(.+)$`, 'm');
}

/**
 * Throws if `text` contains an allowlisted secret name immediately followed by `=`
 * and a non-empty value, anywhere on its own line — the exact shape of an env-file
 * line reaching an output stream. Pass a narrower `names` list to check for a
 * specific secret rather than every known one.
 */
export function assertNoSecretValues(
  text: string,
  names: readonly string[] = SECRET_ENV_NAMES,
): void {
  const match = leakPattern(names).exec(text);
  if (match) {
    throw new Error(
      `refusing to print: a line starts with the secret name "${match[1]}" followed ` +
        'by a value. Print key names only — see CLAUDE.md rule A4.',
    );
  }
}

/** `console.log`, but refuses to print a line that looks like a leaked secret. */
export function safeLog(text: string, names: readonly string[] = SECRET_ENV_NAMES): void {
  assertNoSecretValues(text, names);
  console.log(text);
}
