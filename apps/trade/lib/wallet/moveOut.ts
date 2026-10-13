'use client';

import { assertFreshPasskey, buildWithdraw, type MeraAccount } from '@tradepro/core';
import type { Address } from 'viem';
import { RP_ID } from '../session';
import { run, type OnProgress, type Progress } from '../ticket';

/**
 * Move sheet, Trading balance -> Wallet (wallet spec §5.3): every margin token,
 * MON included since D3 (2026-09-25).
 *
 * This is exactly `apps/trade/app/withdraw/WithdrawScreen.tsx`'s own call and its own
 * passkey pattern, reused rather than duplicated: `MarginAccount.withdraw(amount,
 * token)`, a fresh passkey assertion every time (spec §6: "Move out, Withdraw" always
 * prompts, because money leaves Kuru to the wallet, from where it can be sent), and
 * `purpose: 'withdraw'`.
 *
 * Native MON arrives as native MON (D200 replaced D3's WMON wrap): this direction
 * only ever increases the wallet's native balance, so the 10 MON reserve never binds
 * it — confirmed against Monad's docs (D199) — and wrapping it was a conservative
 * choice from before that was confirmed, not something the reserve itself required.
 *
 * That purpose is what makes Move-out free: `exemptionOf` classifies a plain
 * withdrawal as `'own-funds'` regardless of which token it names, which the relayer
 * never counts against the free tier. See `moveOut.test.ts` for the check against the
 * real policy function.
 */

export interface MoveOutInput {
  readonly account: MeraAccount;
  readonly marginAccount: Address;
  readonly token: Address;
  /** Base units of `token`. Never more than the margin balance that was read. */
  readonly amount: bigint;
  readonly onProgress: OnProgress;
}

export async function moveOut(input: MoveOutInput): Promise<Progress> {
  input.onProgress({ state: 'VALIDATING' });

  try {
    /**
     * The passkey, every time, before anything is signed — same ceremony and the
     * same "nothing was signed" framing as `WithdrawScreen.tsx`. This try/catch
     * covers only the signing and submission, never bookkeeping after a real
     * confirmation.
     */
    await assertFreshPasskey({
      rpId: RP_ID,
      ...(input.account.credentialId ? { credentialId: input.account.credentialId } : {}),
    });
  } catch {
    const progress: Progress = {
      state: 'REJECTED',
      message: "Face ID was not confirmed, so nothing was sent.",
      refusedAtChecking: true,
    };
    input.onProgress(progress);
    return progress;
  }

  const call = buildWithdraw(input.marginAccount, input.token, input.amount);
  return run({
    sender: input.account.address,
    calls: [call],
    purpose: 'withdraw',
    owner: input.account.account,
    onProgress: input.onProgress,
  });
}
