import { describe, expect, it } from 'vitest';
import { detailFrom, failureForBody, upstreamLine } from './upstream.js';

/**
 * Error-handling rule (owner instruction, 2026-09-08): the app never masks an
 * upstream reason. These tests are the enforcement — if any error code's handling
 * drops the upstream body, or renders it without naming who said it, this file
 * fails before the change reaches a screen.
 */

/** Every error string our funding routes can put on the wire alongside `upstream`. */
const WIRE_ERROR_CODES = [
  'AMOUNT_BELOW_MINIMUM',
  'ROUTE_UNAVAILABLE',
  'ROUTE_LIST_UNAVAILABLE',
  'ROUTE_NOT_PRICED',
  'REFUND_ADDRESS_REQUIRED',
  'DEPOSIT_NEEDS_REFUND_ADDRESS',
  'REFUND_ADDRESS_REJECTED',
  'DEPOSIT_TRACKING_UNAVAILABLE',
  'CONVERSION_UNQUOTABLE',
  'FLOW_ROUTE_NOT_GASLESS_SAFE',
  'OFT_QUOTE_UNAVAILABLE',
  'ANYTHING_UNRECOGNISED',
] as const;

describe('an upstream error body is never dropped', () => {
  // A sentinel nothing in the catalogue could contain by accident.
  const SENTINEL = 'XY-upstream-sentinel-7Q: minimum swap amount is $1,000';

  it('carries the verbatim message into the failure detail, for every error code', () => {
    for (const error of WIRE_ERROR_CODES) {
      const f = failureForBody(422, {
        error,
        upstream: { status: 400, message: SENTINEL },
      });
      expect(f.detail, error).toBeDefined();
      expect(f.detail, error).toContain(SENTINEL);
    }
  });

  it('names the source in front of the verbatim message', () => {
    const f = failureForBody(502, {
      error: 'ROUTE_UNAVAILABLE',
      upstream: { status: 400, message: 'Temporary swap limits: minimum swap amount is $1,000' },
    });
    expect(f.detail).toBe(
      'NEAR Intents said: “Temporary swap limits: minimum swap amount is $1,000”',
    );
  });

  it('lets the wire override the source name for non-1Click routes', () => {
    const f = failureForBody(502, {
      error: 'CONVERSION_UNQUOTABLE',
      upstream: { source: 'Kuru', message: 'SizeError' },
    });
    expect(f.detail).toBe('Kuru said: “SizeError”');
  });

  it('keeps the ROUTE_UNAVAILABLE promise even when no reason arrived', () => {
    // The catalogue's fix line says the network's reason is shown below, so an
    // empty wire still produces a truthful line rather than a broken promise.
    const f = failureForBody(502, { error: 'ROUTE_UNAVAILABLE' });
    expect(f.detail).toBe('NEAR Intents gave no reason.');
  });

  it('surfaces a ROUTE_NOT_PRICED reason as the detail', () => {
    const f = failureForBody(503, {
      error: 'ROUTE_NOT_PRICED',
      reason: 'The solver network is not currently listing USDT on Tron.',
    });
    expect(f.detail).toBe('The solver network is not currently listing USDT on Tron.');
  });
});

describe('the lead sentence never asserts a diagnosis the upstream did not give', () => {
  it('ROUTE_UNAVAILABLE no longer claims deposits are temporarily unavailable', () => {
    // The exact regression from 2026-09-08: NEAR's "Temporary swap limits" refusal
    // was fronted by our own invented "temporarily unavailable … try again in a few
    // minutes" sentence, which was false — the route worked fine above $1,000.
    const f = failureForBody(502, {
      error: 'ROUTE_UNAVAILABLE',
      upstream: { status: 400, message: 'Temporary swap limits: minimum swap amount is $1,000' },
    });
    expect(f.fact).not.toMatch(/temporarily unavailable/i);
    expect(f.fix).not.toMatch(/try again in a few minutes/i);
  });
});

describe('detailFrom — the shared reader for a screen with no failure code of its own', () => {
  /**
   * B3: `balances/route.ts`, `orders/route.ts` and `pathB.ts`'s `preflight()` are not
   * quote flows, so they never had a reason to import `failureForBody` — but they had
   * the exact same job of not masking an upstream reason, and were each hand-rolling a
   * slightly different version of this. `detailFrom` is the one function all of them
   * now share, exported so it is not reimplemented a third time.
   */
  it('formats a carried upstream message with its source', () => {
    expect(detailFrom({ upstream: { source: 'Monad RPC', message: 'timeout' } }, 'default')).toBe(
      'Monad RPC said: “timeout”',
    );
  });

  it('falls back to the default source when the wire named none', () => {
    expect(detailFrom({ upstream: { message: 'connection refused' } }, 'Monad RPC')).toBe(
      'Monad RPC said: “connection refused”',
    );
  });

  it('falls back to a plain reason when there is no upstream quote', () => {
    expect(detailFrom({ reason: 'the book is empty' }, 'default')).toBe('the book is empty');
  });

  it('is undefined when the wire carried neither', () => {
    expect(detailFrom({}, 'default')).toBeUndefined();
  });
});

describe('upstreamLine', () => {
  it('quotes the message and names the speaker', () => {
    expect(upstreamLine({ source: 'Pimlico', message: 'AA21 didn’t pay prefund' })).toBe(
      'Pimlico said: “AA21 didn’t pay prefund”',
    );
  });
});

describe('no floor is enforced, and no minimum is quoted back at the user', () => {
  /**
   * Owner's instruction, 2026-09-09: remove the client-side minimum check on /fund
   * entirely. Any amount, no pre-check, no blocking message; send the request and
   * show only what 1Click returns. A cached floor had been blocking amounts the
   * network would in fact have priced.
   *
   * This test is the guard on that: the catalogue copy must not tell anyone to raise
   * an amount, and the failure carries the network's sentence and nothing else.
   */
  it('AMOUNT_BELOW_MINIMUM no longer tells the user to raise the amount', () => {
    const f = failureForBody(422, {
      error: 'AMOUNT_BELOW_MINIMUM',
      upstream: { status: 400, message: 'Temporary swap limits: minimum swap amount is $1,000' },
    });
    expect(`${f.fact} ${f.fix}`).not.toMatch(/raise the amount|minimum shown/i);
    // The network's own words still survive verbatim, per D124.
    expect(f.detail).toBe(
      'NEAR Intents said: “Temporary swap limits: minimum swap amount is $1,000”',
    );
  });

  it('quotes no figure of its own in the lead copy', () => {
    const f = failureForBody(422, { error: 'AMOUNT_BELOW_MINIMUM' });
    expect(`${f.fact} ${f.fix}`).not.toMatch(/\$[\d,]/);
  });
});
