import { describe, expect, it } from 'vitest';
import {
  fetchAttestation,
  mintRecipientMatches,
  cctpReceiveBodySchema,
  CCTP_MINTS_PER_USER_PER_DAY,
} from './cctp.js';

/**
 * The rules that keep the CCTP mint from being a hole in the relayer's policy.
 *
 * The relayer spends its own float to complete a transfer the user cannot complete. What
 * makes that safe is that `receiveMessage` chooses nothing — Circle's signature decides
 * the amount and the recipient. What these tests pin is the part that is ours: that the
 * attestation is fetched rather than accepted, and that the float is never spent
 * finishing a transfer addressed to somebody else.
 */

const ACCOUNT = '0x714f169Fe2D3990961B534D573f9646c037586E6';
const ACCOUNT_WORD = '0x000000000000000000000000714f169fe2d3990961b534d573f9646c037586e6';
const OTHER_WORD = '0x0000000000000000000000000000000000000000000000000000000000000009';

const BODY = {
  recipient: ACCOUNT,
  sourceDomain: 6,
  transactionHash: `0x${'a'.repeat(64)}`,
};

function respond(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

const COMPLETE = {
  messages: [
    {
      status: 'complete',
      message: '0xdeadbeef',
      attestation: '0xsignature',
      decodedMessage: {
        destinationDomain: 15,
        decodedMessageBody: { mintRecipient: ACCOUNT_WORD, amount: '4999350' },
      },
    },
  ],
};

describe('the recipient comparison survives Circle’s padding and our checksumming', () => {
  it('matches a padded word against a checksummed address', () => {
    // Circle returns lower-case padded; viem hands us EIP-55. A string compare is false
    // for every correct message, which is why this is its own function.
    expect(mintRecipientMatches(ACCOUNT_WORD, ACCOUNT)).toBe(true);
  });

  it('rejects a different account', () => {
    expect(mintRecipientMatches(OTHER_WORD, ACCOUNT)).toBe(false);
  });

  it('rejects a word whose upper bytes are not zero', () => {
    // A word with rubbish above the address is not an address-shaped recipient, and
    // treating the low 20 bytes as one would be reading past what CCTP guarantees.
    const dirty = `0x00000000000000000000000f${ACCOUNT.slice(2).toLowerCase()}`;
    expect(mintRecipientMatches(dirty, ACCOUNT)).toBe(false);
  });

  it('rejects a truncated word', () => {
    expect(mintRecipientMatches('0x714f', ACCOUNT)).toBe(false);
  });
});

describe('the request carries a hash and nothing that is trusted', () => {
  it('accepts a well-formed body', () => {
    expect(cctpReceiveBodySchema.safeParse(BODY).success).toBe(true);
  });

  it('has no field for a message or an attestation at all', () => {
    // The shape is the policy: there is nowhere for a client to put a forged
    // attestation, so there is no path where one could be submitted.
    const parsed = cctpReceiveBodySchema.parse({
      ...BODY,
      message: '0xforged',
      attestation: '0xforged',
    });
    expect('message' in parsed).toBe(false);
    expect('attestation' in parsed).toBe(false);
  });

  it('rejects a recipient that is not an address', () => {
    expect(cctpReceiveBodySchema.safeParse({ ...BODY, recipient: 'me' }).success).toBe(false);
  });

  it('rejects a hash that is not 32 bytes', () => {
    expect(cctpReceiveBodySchema.safeParse({ ...BODY, transactionHash: '0xab' }).success).toBe(
      false,
    );
  });
});

describe('only a complete attestation addressed to the caller is submitted', () => {
  it('is ready when Circle says complete and the recipient is the caller', async () => {
    const out = await fetchAttestation(BODY, 15, respond(200, COMPLETE));
    expect(out.ready).toBe(true);
    if (out.ready) {
      expect(out.message).toBe('0xdeadbeef');
      expect(out.attestation).toBe('0xsignature');
      expect(out.amount).toBe('4999350');
    }
  });

  it('is not ready, and not an error, while Circle is still attesting', async () => {
    const pending = { messages: [{ status: 'pending_confirmations' }] };
    const out = await fetchAttestation(BODY, 15, respond(200, pending));
    expect(out.ready).toBe(false);
    if (!out.ready) expect(out.reason).toMatch(/has not finished attesting/);
  });

  it('treats Circle’s 404 as "not yet", which is what it means after a fresh burn', async () => {
    const out = await fetchAttestation(
      BODY,
      15,
      respond(404, { error: 'Message not found for provided parameters' }),
    );
    expect(out.ready).toBe(false);
    if (!out.ready) expect(out.reason).toMatch(/has not attested this transfer yet/);
  });

  it('refuses to spend the float on a mint addressed to someone else', async () => {
    const stranger = {
      messages: [
        {
          ...COMPLETE.messages[0],
          decodedMessage: {
            destinationDomain: 15,
            decodedMessageBody: { mintRecipient: OTHER_WORD },
          },
        },
      ],
    };
    const out = await fetchAttestation(BODY, 15, respond(200, stranger));
    expect(out.ready).toBe(false);
    if (!out.ready) expect(out.reason).toMatch(/different account/);
  });

  it('refuses a transfer aimed at another chain', async () => {
    const elsewhere = {
      messages: [
        {
          ...COMPLETE.messages[0],
          decodedMessage: {
            destinationDomain: 3,
            decodedMessageBody: { mintRecipient: ACCOUNT_WORD },
          },
        },
      ],
    };
    const out = await fetchAttestation(BODY, 15, respond(200, elsewhere));
    expect(out.ready).toBe(false);
    if (!out.ready) expect(out.reason).toMatch(/not addressed to Monad/);
  });

  it('refuses a complete message that carries no attestation', async () => {
    const empty = { messages: [{ status: 'complete', decodedMessage: COMPLETE.messages[0]?.decodedMessage }] };
    const out = await fetchAttestation(BODY, 15, respond(200, empty));
    expect(out.ready).toBe(false);
    if (!out.ready) expect(out.reason).toMatch(/no attestation/);
  });

  it('refuses a body it cannot read, rather than assuming a shape', async () => {
    const out = await fetchAttestation(BODY, 15, respond(200, { messages: 'nope' }));
    expect(out.ready).toBe(false);
    if (!out.ready) expect(out.reason).toMatch(/could not read/);
  });
});

describe('the cap bounds the float, and is a number somebody chose', () => {
  it('is a small positive daily count', () => {
    expect(CCTP_MINTS_PER_USER_PER_DAY).toBeGreaterThan(0);
    expect(CCTP_MINTS_PER_USER_PER_DAY).toBeLessThanOrEqual(50);
  });
});
