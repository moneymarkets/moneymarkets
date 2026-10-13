'use client';

import { buildDeposit, type MeraAccount } from '@tradepro/core';
import { encodeFunctionData, type Address, type Hex } from 'viem';
import { runWithGasCharge, type FeeLegPlan } from './gasCharge';
import type { OnProgress, Progress } from '../ticket';

/**
 * Move-in for a token without ERC-2612 permit (D2, 2026-09-25): the C1/D2 triple —
 * `token.approve(MarginAccount, amount)`, `MarginAccount.deposit(user, token,
 * amount)`, `token.approve(MarginAccount, 0)` — in one batch. Exact amount, pinned
 * spender, allowance opened and closed atomically; the relayer's
 * `assertSponsoredApprove` validates precisely this shape and nothing looser.
 *
 * Permit tokens keep using `lib/fund/pathB.ts`'s `topUp` (permit is one signature
 * and leaves no allowance on chain at all); this module exists only for the tokens
 * that cannot permit. Same as `topUp`, nothing here asks for a fresh passkey:
 * Move-in keeps funds inside the user's own account (spec §6, "may sign without a
 * fresh prompt").
 *
 * Nothing in the triple embeds a signature, so the whole batch is loggable as-is.
 */

const approveAbi = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

export function moveInTripleCalls(input: {
  readonly marginAccount: Address;
  readonly user: Address;
  readonly token: Address;
  readonly amount: bigint;
}): readonly { readonly to: Address; readonly data: Hex }[] {
  const approve = (amount: bigint) => ({
    to: input.token,
    data: encodeFunctionData({
      abi: approveAbi,
      functionName: 'approve',
      args: [input.marginAccount, amount],
    }),
  });
  const deposit = buildDeposit(input.marginAccount, input.user, input.token, input.amount);
  return [approve(input.amount), { to: deposit.to, data: deposit.data }, approve(0n)];
}

export async function moveInWithApprove(input: {
  readonly account: MeraAccount;
  readonly marginAccount: Address;
  readonly token: Address;
  readonly amount: bigint;
  readonly onProgress: OnProgress;
  readonly onFeePlan?: (plan: FeeLegPlan) => void;
}): Promise<Progress> {
  const calls = moveInTripleCalls({
    marginAccount: input.marginAccount,
    user: input.account.address,
    token: input.token,
    amount: input.amount,
  });
  return runWithGasCharge({
    sender: input.account.address,
    actionCalls: calls,
    purpose: 'deposit',
    marginAccount: input.marginAccount,
    owner: input.account.account,
    onProgress: input.onProgress,
    ...(input.onFeePlan ? { onFeePlan: input.onFeePlan } : {}),
  });
}
