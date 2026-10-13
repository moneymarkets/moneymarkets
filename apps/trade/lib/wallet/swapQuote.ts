import { decodeEventLog, getAddress, isAddress, parseAbi, type Address, type Hex } from 'viem';
import { MAINNET } from '@tradepro/core';

/**
 * The pure, shared half of Swap (wallet spec §4.4, §5.1): what token to actually ask
 * Kuru Flow for, whether a returned route is safe to sign against, and which pay
 * tokens the deployed relayer will actually sponsor a permit for. No `'use client'`
 * or server-only import here, deliberately — `/api/wallet/swap/quote` (server) and
 * `lib/wallet/swap.ts` (browser) both need the same answers to the same questions,
 * and a second, drifting copy in either place is how "sponsorable" stops meaning one
 * thing. Testable without a network or a Next.js request, the same discipline
 * `lib/server/walletTokens.ts` already uses for the balances route.
 */

/**
 * The pay tokens whose ERC-2612 `permit` the relayer sponsors. Any other token pays
 * through the C1 approve triple instead — `approve(pinnedRouter, exact)`, the swap,
 * `approve(pinnedRouter, 0)` — which the relayer policy admits for any token
 * (C1, owner's decision 2026-09-25; the per-token Swap gate and its "pending a
 * security review" notice were removed the same day). Permit stays preferred where
 * a token supports it: one signature, no allowance ever standing on chain at all.
 */
export const SWAP_PERMIT_PAY_TOKENS: readonly Address[] = [
  MAINNET.tokens.AUSD.address,
  MAINNET.tokens.USDC.address,
];

export function payWithPermit(tokenIn: Address): boolean {
  return SWAP_PERMIT_PAY_TOKENS.some((t) => t.toLowerCase() === tokenIn.toLowerCase());
}

/** The sentinel this app uses for native MON everywhere else (`walletTokens.ts`'s
 *  `NATIVE_MON`, restated here so this module has no server-only import). */
export const NATIVE_MON: Address = '0x0000000000000000000000000000000000000000';

export const WMON: Address = MAINNET.tokens.WMON.address;

/**
 * What to actually request from Flow for a given "you receive" token, and whether
 * the delivered token is WMON standing in for native MON (spec 5.1: "If the output
 * token is MON, the quote must be requested for WMON and delivered as WMON").
 */
export interface ResolvedTokenOut {
  readonly flowTokenOut: Address;
  readonly deliveredAsWmon?: boolean;
}

export function resolveTokenOut(requested: Address): ResolvedTokenOut {
  const isNativeMon = requested.toLowerCase() === NATIVE_MON.toLowerCase();
  return isNativeMon ? { flowTokenOut: WMON, deliveredAsWmon: true } : { flowTokenOut: requested };
}

/**
 * B3's delivery decision for a swap whose requested output is native MON: the quote
 * is always for WMON (Flow's own deliverable), and the batch may end with
 * `WMON.withdraw(minOut)` so the wallet holds actual native MON — but only when the
 * wallet would END at or above Monad's delegated reserve, judged on the guaranteed
 * minimum, never the optimistic figure. Below that, the swap delivers WMON and the
 * screen says so, in the spec's own words.
 */
export interface NativeDeliveryPlan {
  readonly deliverNative: boolean;
  /** Shown when `deliverNative` is false — B3: "deliver WMON instead and say so". */
  readonly note?: string;
}

export function nativeDeliveryPlan(input: {
  readonly currentNativeWei: bigint;
  readonly minOutWei: bigint;
  readonly reserveWei: bigint;
}): NativeDeliveryPlan {
  if (input.currentNativeWei + input.minOutWei >= input.reserveWei) {
    return { deliverNative: true };
  }
  return {
    deliverNative: false,
    note: 'This amount is too small to end above the 10 MON a delegated wallet must keep, so you will receive WMON instead. Swap a larger amount to receive native MON.',
  };
}

/*
 * v2.1 spec 3.1 removed the WMON-in-the-route heuristic refusals that lived here
 * (`wmonIsExpected` / `routeNeedsNativeMon`): a zero-value route cannot move the
 * account's native balance, the pre-sign simulation is the gate on whether it runs,
 * and a route demanding native value is refused by its own fact at the quote route.
 */

/** B3: the swap-into-MON prefill aims the wallet at 12 MON — comfortably above the
 *  10 MON reserve, so the delivery can be native. */
export const SWAP_INTO_MON_TARGET_WEI = 12n * 10n ** 18n;

/**
 * The pay-side amount that would bring the wallet to the 12 MON target (B3:
 * "prefilled to reach 12 MON"), computed from the two rows' real USD prices —
 * `undefined` when either price is missing, and the field is simply left empty
 * rather than prefilled with a guess. It is only a prefill: the real Flow quote,
 * fetched for whatever amount ends up in the field, is what gets signed.
 */
export function prefillPayAmountForMon(input: {
  readonly currentNativeWei: bigint;
  readonly monUsd: { readonly value: bigint; readonly decimals: number } | null;
  readonly payUsd: { readonly value: bigint; readonly decimals: number } | null;
  readonly payDecimals: number;
}): bigint | undefined {
  const { monUsd, payUsd } = input;
  if (!monUsd || !payUsd || monUsd.value <= 0n || payUsd.value <= 0n) return undefined;
  const deficit = SWAP_INTO_MON_TARGET_WEI - input.currentNativeWei;
  if (deficit <= 0n) return undefined;
  return (
    (deficit * monUsd.value * 10n ** BigInt(input.payDecimals) * 10n ** BigInt(payUsd.decimals)) /
    (10n ** 18n * 10n ** BigInt(monUsd.decimals) * payUsd.value)
  );
}

export function isValidTokenAddress(value: string): value is Address {
  return isAddress(value);
}

export function checksum(value: string): Address {
  return getAddress(value);
}

/** The ERC-20 standard's own `Transfer` event — the same standard `approve` in
 *  `swap.ts` relies on, not a guess about any specific token contract. */
const TRANSFER_EVENT = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

/**
 * What the mined receipt's own logs say actually arrived, in `deliveredToken`, at
 * `recipient` — the fix for a real gap an independent review found: the done
 * notice and the activity row showed the quote's own `output` figure, not what the
 * chain actually delivered, and (separately) said "MON" even when the batch, by
 * construction, always delivers WMON.
 *
 * Sums every matching `Transfer` rather than taking the first: a route can legally
 * emit more than one transfer to the same recipient in the same token (a fee
 * transfer plus the net proceeds, for instance), and taking only the first would
 * under-report. `undefined` when no matching transfer is found at all — the receipt
 * exists but does not say, and a screen should fall back to the quote's own figure
 * rather than claim a number the receipt itself never stated.
 */
export function deliveredAmountFromLogs(
  logs: readonly unknown[] | undefined,
  deliveredToken: Address,
  recipient: Address,
): bigint | undefined {
  if (!logs || logs.length === 0) return undefined;
  let total: bigint | undefined;
  for (const raw of logs) {
    const log = raw as { address?: string; topics?: readonly Hex[]; data?: Hex };
    if (!log.address || log.address.toLowerCase() !== deliveredToken.toLowerCase()) continue;
    if (!log.topics || !log.data) continue;
    try {
      const decoded = decodeEventLog({
        abi: TRANSFER_EVENT,
        topics: log.topics as [Hex, ...Hex[]],
        data: log.data,
      });
      if (decoded.eventName !== 'Transfer') continue;
      if (decoded.args.to.toLowerCase() !== recipient.toLowerCase()) continue;
      total = (total ?? 0n) + decoded.args.value;
    } catch {
      // Not a well-formed Transfer log on this token — skip it rather than guess.
    }
  }
  return total;
}
