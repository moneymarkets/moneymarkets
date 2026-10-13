import { describe, expect, it } from 'vitest';
import {
  FAILURE_CODES,
  failure,
  failureForStatus,
  failureText,
  type FailureCode,
} from './failures.js';

/**
 * The copy rules in design §6 are testable, so they are tested rather than reviewed.
 * A sentence that apologises or leaks a hex string fails here before it reaches a
 * screen.
 */

describe('failure catalogue', () => {
  it('covers every external call the app makes', () => {
    // Task 3.6's list, spelled out so removing one is a failing test rather than a
    // quiet regression.
    const required: FailureCode[] = [
      'QUOTE_FAILED',
      'QUOTE_EXPIRED',
      'DEPOSIT_ADDRESS_UNAVAILABLE',
      'RPC_UNAVAILABLE',
      'BOOK_STALE',
      'BOOK_CROSSED',
    ];
    for (const code of required) expect(FAILURE_CODES).toContain(code);
  });

  it('gives every failure a fact and a fix', () => {
    for (const code of FAILURE_CODES) {
      const f = failure(code);
      expect(f.fact.length, code).toBeGreaterThan(10);
      expect(f.fix.length, code).toBeGreaterThan(10);
      // A fact is a sentence, so it ends like one.
      expect(f.fact.trim().endsWith('.'), code).toBe(true);
      expect(f.fix.trim().endsWith('.'), code).toBe(true);
    }
  });

  it('never apologises and never shows hex', () => {
    for (const code of FAILURE_CODES) {
      const text = failureText(failure(code));
      expect(text, code).not.toMatch(/\boops\b|\bsorry\b|\bunfortunately\b/i);
      expect(text, code).not.toMatch(/0x[0-9a-fA-F]{4,}/);
      // "Error" and "failed" describe our own plumbing, not the user's situation.
      expect(text, code).not.toMatch(/\berror\b/i);
    }
  });

  it('offers an action wherever the user is the one who recovers it', () => {
    for (const code of FAILURE_CODES) {
      const f = failure(code);
      if (f.recovery === 'requote') expect(f.action, code).toBeDefined();
    }
  });
});

describe('EXPIRED is not a dead end', () => {
  it('is non-terminal and recovers by re-quoting', () => {
    const f = failure('QUOTE_EXPIRED');
    expect(f.terminal).toBe(false);
    expect(f.recovery).toBe('requote');
    expect(f.action).toBe('Get a new quote');
  });

  it('says nothing was spent, because nothing was', () => {
    // An expired quote is a lapsed price, not a lost transfer. If the copy does not
    // say so, a user reads it as money in limbo.
    expect(failure('QUOTE_EXPIRED').fact).toMatch(/nothing was sent/i);
  });

  it('is a warning, not a stop', () => {
    expect(failure('QUOTE_EXPIRED').tone).toBe('warn');
    expect(failure('QUOTE_FAILED').tone).toBe('err');
  });
});

describe('a deposit address is never implied', () => {
  it('says plainly that a priced quote reserves nothing', () => {
    const f = failure('DEPOSIT_ADDRESS_UNAVAILABLE');
    expect(f.fix).toMatch(/does not reserve an address/i);
    expect(f.terminal).toBe(false);
  });
});

describe('status mapping', () => {
  it('maps an upstream timeout to a re-quotable failure', () => {
    expect(failureForStatus(504).code).toBe('QUOTE_FAILED');
    expect(failureForStatus(504).recovery).toBe('requote');
  });

  it('maps 410 Gone to the expired quote, not to a generic failure', () => {
    expect(failureForStatus(410).code).toBe('QUOTE_EXPIRED');
  });

  it('falls back to a re-quotable failure rather than throwing', () => {
    expect(failureForStatus(418).code).toBe('QUOTE_FAILED');
  });
});
