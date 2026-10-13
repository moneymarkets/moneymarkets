import { describe, expect, it } from 'vitest';
import { buildWithdraw, isSendOrWithdraw, MAINNET } from '@tradepro/core';
import { isMoveOutDisabled } from './holdings';

/**
 * Move-out's fee-exemption claim, checked against the real policy function rather
 * than assumed (wallet spec §5.5: "send and move-out never count and never show a
 * fee").
 *
 * `moveOut.ts` sends exactly one call — `MarginAccount.withdraw(amount, token)` —
 * which is the same call `apps/withdraw/WithdrawScreen.tsx` already sends today.
 * `packages/core/src/gas/policy.ts`'s `isSendOrWithdraw` (read-only in this pass,
 * not edited — see the WMON-move-out note in `holdings.ts`) is what the relayer
 * checks to decide whether a batch is exempt from the free-tier count and from any
 * fee; this test proves a Move-out batch, built the way `moveOut.ts` builds it,
 * already matches that shape for every token this pass offers Move-out on.
 *
 * MON is offered too since D3 (2026-09-25), and arrives as native MON since D200
 * (2026-10-08) rather than D3's WMON wrap — the reserve never binds this direction,
 * so wrapping it was never required, only cautious. `exemptionOf` classifies the
 * plain withdrawal as the same own-funds exemption — checked below against the
 * exact batch `moveOut.ts` builds.
 */
describe('Move-out is exempt from the free-tier count and from any fee', () => {
  const marginAccount = MAINNET.kuru.marginAccount as `0x${string}`;

  const movableTokens = [
    { symbol: 'AUSD', address: MAINNET.tokens.AUSD.address },
    { symbol: 'USDC', address: MAINNET.tokens.USDC.address },
    { symbol: 'USDT0', address: MAINNET.tokens.USDT0.address },
    { symbol: 'WMON', address: MAINNET.tokens.WMON.address },
  ];

  it.each(movableTokens)('a $symbol Move-out batch matches the own-funds exemption', ({ address }) => {
    const call = buildWithdraw(marginAccount, address, 1_000_000n);
    expect(isSendOrWithdraw([{ to: call.to, data: call.data }], marginAccount)).toBe(true);
  });

  it('a MON Move-out batch — a plain native withdrawal, no wrap — matches the own-funds exemption (D200)', () => {
    expect(isMoveOutDisabled('MON')).toBe(false);
    const native = '0x0000000000000000000000000000000000000000' as `0x${string}`;
    const amount = 7n * 10n ** 17n;
    const call = buildWithdraw(marginAccount, native, amount);
    expect(isSendOrWithdraw([{ to: call.to, data: call.data }], marginAccount)).toBe(true);
  });
});
