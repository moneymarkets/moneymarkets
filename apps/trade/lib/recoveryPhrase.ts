/**
 * The recovery-phrase sheet's state machine (rule A4, design §5.6).
 *
 * It is a separate module from the screen because its rules are the security
 * properties, and properties that live only inside a component are properties nobody
 * can test. Four of the five things rule A4 demands are decided here:
 *
 *   - the phrase exists only in the `shown` phase, so every other phase is provably
 *     wordless — `close()` returns a value with no `words` field at all rather than
 *     an empty array, which means a stale render cannot show a leftover;
 *   - `shown` always starts `revealed: false`, so a phrase cannot arrive unblurred;
 *   - `reveal()` only flips a flag and cannot produce words that were not already
 *     there;
 *   - nothing in this file touches storage, the network, or the console.
 *
 * The fifth — that the assertion is **fresh** — is not decidable here. It is a
 * property of `exportMnemonic()` in core, which calls `getPasskeyPrfOutput()` on
 * every invocation and derives the phrase from that output. There is no cache to
 * read, so a phrase cannot be produced without a new ceremony.
 */

export type PhraseState =
  /** No sheet. No words anywhere. */
  | { readonly phase: 'closed' }
  /** Waiting on the passkey. Still no words. */
  | { readonly phase: 'confirm' }
  /** The only phase that carries the phrase. */
  | { readonly phase: 'shown'; readonly words: readonly string[]; readonly revealed: boolean }
  | { readonly phase: 'error'; readonly message: string };

export const CLOSED: PhraseState = { phase: 'closed' };

export function open(): PhraseState {
  return { phase: 'confirm' };
}

/**
 * A mnemonic becomes words, blurred.
 *
 * Twenty-four, not the twelve the design draws: Mera's PRF output is 32 bytes, and
 * 32 bytes of BIP-39 entropy is a 24-word phrase. Truncating to fit the drawing
 * would halve the recovery path's entropy while the passkey path kept all of it.
 * See DECISIONS.md D16.
 */
export function shown(mnemonic: string): PhraseState {
  const words = mnemonic.trim().split(/\s+/).filter(Boolean);
  return { phase: 'shown', words, revealed: false };
}

/** An explicit tap, and nothing else, un-blurs. */
export function reveal(state: PhraseState): PhraseState {
  if (state.phase !== 'shown') return state;
  return { ...state, revealed: true };
}

export function failed(message: string): PhraseState {
  return { phase: 'error', message };
}

/**
 * Drop the phrase.
 *
 * This releases the app's only reference to the words. It is not a guarantee that
 * the strings are gone from the JavaScript heap — nothing in a browser can promise
 * that, since the engine owns when it collects — and this file does not claim
 * otherwise. What it does guarantee is that no code path can read them back.
 */
export function close(): PhraseState {
  return CLOSED;
}

/** For a screen that needs to know whether anything is being held. */
export function holdsWords(state: PhraseState): boolean {
  return state.phase === 'shown' && state.words.length > 0;
}
