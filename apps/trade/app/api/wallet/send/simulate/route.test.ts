import { describe, expect, it, vi } from 'vitest';
import { getAddress, type Address } from 'viem';

/**
 * `POST /api/wallet/send/simulate` (D200, rule 1.6): the chain is stubbed, and this
 * tests only this route's own job — rebuilding the call with `buildNativeSend`
 * (never trusting calldata from the page) and relaying `simulateSponsoredBatch`'s
 * verdict. `simulateSponsoredBatch` itself is tested directly in
 * `lib/server/simulateSponsoredBatch.test.ts`, including the reserve-violation case.
 */

const SENDER = getAddress('0x43a275C3Eb0BE7313f847FFA4fb6Bd366606A961');
const TO = getAddress('0x1111111111111111111111111111111111111111');

let simResult: { executable: true; checked: boolean } | { executable: false; checked: true; reason: string } = {
  executable: true,
  checked: true,
};
let capturedCall: { to: Address; data: string; value?: bigint } | undefined;

vi.mock('../../../../../lib/server/chain', () => ({
  readClient: () => ({}),
}));
vi.mock('../../../../../lib/server/simulateSponsoredBatch', () => ({
  simulateSponsoredBatch: async (_client: unknown, _sender: Address, calls: { to: Address; data: string; value?: bigint }[]) => {
    capturedCall = calls[0];
    return simResult;
  },
}));

const { POST } = await import('./route');

async function simulate(body: Record<string, unknown>) {
  const res = await POST(
    new Request('https://x/api/wallet/send/simulate', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('POST /api/wallet/send/simulate', () => {
  it('rebuilds the exact native-send call and reports an executable plan', async () => {
    simResult = { executable: true, checked: true };
    const { status, body } = await simulate({ sender: SENDER, to: TO, amount: '1000000000000000000' });
    expect(status).toBe(200);
    expect(body).toEqual({ executable: true, checked: true });
    expect(capturedCall).toEqual({ to: TO, data: '0x', value: 1_000_000_000_000_000_000n, purpose: 'nativeSend' });
  });

  it("reports the chain's own reason when the plan would revert, never a bare refusal", async () => {
    simResult = { executable: false, checked: true, reason: 'Your wallet must keep 10 MON, and this would leave it with less.' };
    const { status, body } = await simulate({ sender: SENDER, to: TO, amount: '1000' });
    expect(status).toBe(200);
    expect(body).toEqual({
      executable: false,
      checked: true,
      reason: 'Your wallet must keep 10 MON, and this would leave it with less.',
    });
  });

  it.each([
    ['missing sender', { to: TO, amount: '1' }],
    ['malformed sender', { sender: 'not-an-address', to: TO, amount: '1' }],
    ['missing amount', { sender: SENDER, to: TO }],
    ['zero amount', { sender: SENDER, to: TO, amount: '0' }],
    ['non-numeric amount', { sender: SENDER, to: TO, amount: 'abc' }],
  ])('refuses a request with %s', async (_label, body) => {
    const { status, body: json } = await simulate(body);
    expect(status).toBe(400);
    expect(json).toEqual({ error: 'BAD_REQUEST' });
  });
});
