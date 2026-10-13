import { describe, expect, it } from 'vitest';
import { exemptionOf, isSponsorable, MAINNET, selectorOf } from '@tradepro/core';
import type { Address } from 'viem';
import { moveInTripleCalls } from './moveInApprove';

/**
 * D2's approve-deposit-revoke triple, checked against the real relayer policy
 * (`assertSponsorable` via `isSponsorable`), the same way `moveOut.test.ts` proves
 * its own exemption claim — never assumed.
 */

const MARGIN = MAINNET.kuru.marginAccount as Address;
const WMON = MAINNET.tokens.WMON.address as Address;
const USER = '0x43a275C3Eb0BE7313f847FFA4fb6Bd366606A961' as Address;
const APPROVE = '0x095ea7b3';

describe('moveInTripleCalls (D2)', () => {
  const calls = moveInTripleCalls({ marginAccount: MARGIN, user: USER, token: WMON, amount: 5n * 10n ** 18n });

  it('is approve(MarginAccount, exact), the deposit, approve(MarginAccount, 0) — in that order', () => {
    expect(calls).toHaveLength(3);
    expect(calls[0]!.to.toLowerCase()).toBe(WMON.toLowerCase());
    expect(selectorOf(calls[0]!.data)).toBe(APPROVE);
    expect(calls[1]!.to.toLowerCase()).toBe(MARGIN.toLowerCase());
    expect(calls[2]!.to.toLowerCase()).toBe(WMON.toLowerCase());
    expect(BigInt(`0x${calls[2]!.data.slice(10 + 64, 10 + 128)}`)).toBe(0n);
  });

  it('the real policy sponsors exactly this batch', () => {
    expect(
      isSponsorable(
        calls.map((c) => ({ to: c.to, data: c.data, value: 0n })),
        { marginAccount: MARGIN, permitTokens: [] },
      ),
    ).toBe(true);
  });

  it('a Move-in stays a counted, ordinary action — never exempt', () => {
    expect(exemptionOf(calls.map((c) => ({ to: c.to, data: c.data, value: 0n })), MARGIN)).toBeUndefined();
  });
});
