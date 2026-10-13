import { describe, expect, it } from 'vitest';
import { messageFrom } from './bundlerTransport.js';

/**
 * The rejection path's half of the 2026-09-08 error-handling rule: a plain lead in
 * `message`, the upstream's words verbatim in `detail`. The old version substituted
 * its own sentence in three places and each substitution dropped the one thing the
 * user could act on — most concretely the MON figure in Monad's reserve-rule revert.
 */

describe('messageFrom — the relay answer is never masked', () => {
  it('keeps the verbatim line under the plain lead for a generic rejection', () => {
    const { message, detail } = messageFrom(
      new Error('the operation carries no calls this relayer can read'),
    );
    expect(message).toBe('That did not go through. Nothing was spent.');
    expect(detail).toBe(
      'The relay answered: “the operation carries no calls this relayer can read”',
    );
  });

  it('no longer suppresses a line just because it contains a long hex string', () => {
    // The old code replaced any hex-bearing first line with a generic sentence,
    // which erased exactly the material an operator needs to look a failure up.
    const raw = 'UserOperation reverted with reason 0x1234abcdaabbccddeeff00112233445566778899';
    const { detail } = messageFrom(new Error(raw));
    expect(detail).toContain(raw);
  });

  it('leads with the venue state for a Kuru pause, and still names the answer', () => {
    const { message, detail } = messageFrom(
      new Error('execution reverted: 0x44279255 something something'),
    );
    expect(message).toContain('Kuru has paused');
    expect(detail).toBe('Kuru answered: ProtocolPaused');
  });

  it("keeps Monad's own MON-reserve sentence verbatim instead of a substitute", () => {
    const raw = 'SmartAccount with EIP-7702 authorization needs at least 10 MON';
    const { message, detail } = messageFrom(new Error(raw));
    expect(message).toBe('The network requires this account to keep 10 MON in reserve, so nothing was sent.');
    expect(detail).toContain(raw);
  });

  it('prefers the details field viem attaches, first line only', () => {
    const error = new Error('outer wrapper') as Error & { details?: string };
    error.details = 'AA21 didn’t pay prefund\nDocs: https://…';
    const { detail } = messageFrom(error);
    expect(detail).toBe('The relay answered: “AA21 didn’t pay prefund”');
  });
});
