'use client';

import { buildDeposit, type MeraAccount } from '@tradepro/core';
import type { Address } from 'viem';
import { runWithGasCharge, type FeeLegPlan } from './gasCharge';
import type { OnProgress, Progress } from '../ticket';

/**
 * Move-in for native MON (D200, 2026-10-08): one call, `MarginAccount.deposit(user,
 * 0x0, amount)` with `value` equal to `amount` — confirmed on mainnet that Kuru's
 * MarginAccount takes native MON directly this way, no WMON wrap and no allowance
 * needed (native MON has no `permit()` and no `approve()`, so neither of the other
 * two Move-in paths — `topUp`'s permit, `moveInWithApprove`'s triple — apply to it).
 *
 * Same as both of those: nothing here asks for a fresh passkey. Move-in keeps funds
 * inside the user's own account (spec §6, "may sign without a fresh prompt").
 */
const NATIVE_MON: Address = '0x0000000000000000000000000000000000000000';

export async function moveInNative(input: {
  readonly account: MeraAccount;
  readonly marginAccount: Address;
  readonly amount: bigint;
  readonly onProgress: OnProgress;
  readonly onFeePlan?: (plan: FeeLegPlan) => void;
}): Promise<Progress> {
  const deposit = buildDeposit(input.marginAccount, input.account.address, NATIVE_MON, input.amount);
  return runWithGasCharge({
    sender: input.account.address,
    actionCalls: [{ to: deposit.to, data: deposit.data, value: input.amount }],
    purpose: 'deposit',
    marginAccount: input.marginAccount,
    owner: input.account.account,
    onProgress: input.onProgress,
    ...(input.onFeePlan ? { onFeePlan: input.onFeePlan } : {}),
  });
}
