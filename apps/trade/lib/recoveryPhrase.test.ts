import { describe, expect, it } from 'vitest';
import { close, failed, holdsWords, open, reveal, shown, CLOSED } from './recoveryPhrase.js';

/**
 * A BIP-39 phrase-shaped fixture. It is **not** a valid mnemonic and controls
 * nothing: twenty-four repetitions of a single word list entry, which fails the
 * checksum by construction. Rule A2.2 — no key material in a test fixture.
 */
const TWENTY_FOUR = Array.from({ length: 24 }, (_, i) => `word${i + 1}`).join(' ');

describe('the phrase exists in exactly one phase', () => {
  it('carries no words before the passkey is presented', () => {
    expect('words' in open()).toBe(false);
    expect('words' in CLOSED).toBe(false);
  });

  it('carries no words in the error phase', () => {
    // A failed ceremony must not leave a half-shown phrase behind it.
    expect('words' in failed('Not shown')).toBe(false);
  });

  it('drops the words on close, rather than emptying them', () => {
    const state = shown(TWENTY_FOUR);
    expect(holdsWords(state)).toBe(true);
    // Not `words: []` — the field is gone, so a stale render cannot index into it.
    expect('words' in close()).toBe(false);
    expect(holdsWords(close())).toBe(false);
  });
});

describe('blurred until an explicit tap', () => {
  it('arrives blurred', () => {
    const state = shown(TWENTY_FOUR);
    expect(state.phase).toBe('shown');
    expect(state.phase === 'shown' && state.revealed).toBe(false);
  });

  it('only reveal() un-blurs it', () => {
    const revealed = reveal(shown(TWENTY_FOUR));
    expect(revealed.phase === 'shown' && revealed.revealed).toBe(true);
  });

  it('cannot conjure words out of a phase that has none', () => {
    expect(reveal(open())).toEqual(open());
    expect(reveal(CLOSED)).toEqual(CLOSED);
    expect('words' in reveal(failed('x'))).toBe(false);
  });
});

describe('twenty-four words, not twelve', () => {
  it('splits a full phrase', () => {
    const state = shown(TWENTY_FOUR);
    expect(state.phase === 'shown' && state.words.length).toBe(24);
  });

  it('tolerates the whitespace a wallet might hand back', () => {
    const state = shown(`  ${TWENTY_FOUR.replace(/ /g, '  ')}\n`);
    expect(state.phase === 'shown' && state.words.length).toBe(24);
  });
});

describe('nothing is persisted or transmitted', () => {
  it('touches no storage and no network', () => {
    // The module imports nothing. If a future edit reaches for storage or fetch,
    // these stand-ins record it and the test fails rather than the property
    // silently disappearing.
    const touched: string[] = [];
    const storage = new Proxy(
      {},
      {
        get(_t, key) {
          touched.push(String(key));
          return () => undefined;
        },
      },
    );
    const globals = globalThis as unknown as Record<string, unknown>;
    const realLocal = globals.localStorage;
    const realSession = globals.sessionStorage;
    const realFetch = globals.fetch;
    globals.localStorage = storage;
    globals.sessionStorage = storage;
    globals.fetch = (...args: unknown[]) => {
      touched.push(`fetch:${String(args[0])}`);
      return Promise.reject(new Error('no'));
    };

    try {
      let state = open();
      state = shown(TWENTY_FOUR);
      state = reveal(state);
      state = close();
      expect(state).toEqual(CLOSED);
    } finally {
      globals.localStorage = realLocal;
      globals.sessionStorage = realSession;
      globals.fetch = realFetch;
    }

    expect(touched).toEqual([]);
  });
});
