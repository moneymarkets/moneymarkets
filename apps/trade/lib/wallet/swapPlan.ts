import { buildWithdraw, MAINNET, type SwapVendorId } from '@tradepro/core';
import { encodeFunctionData, getAddress, type Address, type Hex } from 'viem';

/**
 * The exact batch a swap signs, for every shape Swap can take, as one pure function
 * used by both the server (to simulate it before any Face ID prompt, rules 1.6 and 1.7)
 * and the browser (to sign it). One builder, so what was simulated is what is signed.
 *
 * Shapes (rule 1.8):
 *   wrap       MON to WMON: `WMON.deposit{value}`. No aggregator.
 *   unwrap     WMON to MON: `WMON.withdraw(amount)`. No aggregator.
 *   aggregated any other pair, through the winning vendor's pinned router:
 *                [trading balance: MarginAccount.withdraw(amount, payToken)]
 *                [MON input: WMON.deposit{value: amount}]
 *                permit + swap            (Kuru Flow paying with AUSD/USDC)
 *                or approve, swap, approve 0   (every other case)
 *                [MON output delivered native: WMON.withdraw(minOut)]
 *
 * No `'use client'` and no server-only import: both sides need it.
 */

export const NATIVE_MON: Address = '0x0000000000000000000000000000000000000000';
export const WMON: Address = MAINNET.tokens.WMON.address;

export type SwapSource = 'trading' | 'wallet';
export type SwapKind = 'wrap' | 'unwrap' | 'aggregated';

export interface SwapCall {
  readonly to: Address;
  readonly data: Hex;
  readonly value?: bigint;
}

/** A vendor's route as the quote route hands it to the browser (bigints as strings on
 *  the wire; see `parseRouteWire`). */
export interface SwapRoute {
  readonly vendor: SwapVendorId;
  readonly displayName: string;
  readonly to: Address;
  readonly data: Hex;
  /** What the vendor swaps: WMON stands in for native MON on either side. */
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountIn: bigint;
  readonly expectedOut: bigint;
  readonly minOut: bigint;
  readonly gasEstimate?: bigint;
}

export function isNative(token: Address): boolean {
  return token.toLowerCase() === NATIVE_MON.toLowerCase();
}

export function isWmon(token: Address): boolean {
  return token.toLowerCase() === WMON.toLowerCase();
}

export function swapKindOf(payToken: Address, receiveToken: Address): SwapKind {
  if (isNative(payToken) && isWmon(receiveToken)) return 'wrap';
  if (isWmon(payToken) && isNative(receiveToken)) return 'unwrap';
  return 'aggregated';
}

/** The token an aggregator is asked for on each side: never native MON (rule 1.8). */
export function vendorToken(token: Address): Address {
  return isNative(token) ? WMON : getAddress(token);
}

const WMON_ABI = [
  { type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] },
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'wad', type: 'uint256' }],
    outputs: [],
  },
] as const;

const APPROVE_ABI = [
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

export function wmonDeposit(value: bigint): SwapCall {
  return { to: WMON, data: encodeFunctionData({ abi: WMON_ABI, functionName: 'deposit' }), value };
}

export function wmonWithdraw(amount: bigint): SwapCall {
  return { to: WMON, data: encodeFunctionData({ abi: WMON_ABI, functionName: 'withdraw', args: [amount] }) };
}

export function approveCall(token: Address, spender: Address, amount: bigint): SwapCall {
  return { to: token, data: encodeFunctionData({ abi: APPROVE_ABI, functionName: 'approve', args: [spender, amount] }) };
}

/**
 * How the swap's allowance is paid. `'approve'` is the exact triple (and what the
 * simulation always uses, since a permit cannot be simulated before it is signed); a
 * permit is the signed call itself, allowed only toward Kuru Flow.
 */
export type SwapAllowance = { readonly kind: 'approve' } | { readonly kind: 'permit'; readonly call: SwapCall };

export interface SwapBatchInput {
  readonly kind: SwapKind;
  readonly marginAccount: Address;
  /** What the user pays with, as the screen shows it (native MON is the zero address). */
  readonly payToken: Address;
  readonly amountIn: bigint;
  readonly source: SwapSource;
  /** Required for `aggregated`. */
  readonly route?: SwapRoute;
  readonly allowance?: SwapAllowance;
  /** Aggregated to native MON: unwrap `route.minOut` at the end (B3). */
  readonly deliverNative?: boolean;
}

export function buildSwapBatch(input: SwapBatchInput): SwapCall[] {
  const { amountIn, source, marginAccount, payToken } = input;
  if (amountIn <= 0n) throw new Error('swap amount must be positive');
  const calls: SwapCall[] = [];

  if (source === 'trading') {
    const withdraw = buildWithdraw(marginAccount, isNative(payToken) ? NATIVE_MON : getAddress(payToken), amountIn);
    calls.push({ to: withdraw.to, data: withdraw.data });
  }

  if (input.kind === 'wrap') {
    calls.push(wmonDeposit(amountIn));
    return calls;
  }
  if (input.kind === 'unwrap') {
    calls.push(wmonWithdraw(amountIn));
    return calls;
  }

  const route = input.route;
  if (!route) throw new Error('an aggregated swap needs the route it is signing');
  if (route.amountIn !== amountIn) throw new Error('this route is for a different amount than the one on screen');
  if (route.tokenIn.toLowerCase() !== vendorToken(payToken).toLowerCase()) {
    throw new Error('this route spends a different token than the one on screen');
  }

  if (isNative(payToken)) calls.push(wmonDeposit(amountIn));

  const allowance = input.allowance ?? { kind: 'approve' };
  const swap: SwapCall = { to: route.to, data: route.data };
  if (allowance.kind === 'permit') {
    if (route.vendor !== 'kuru-flow') throw new Error('a permit pays Kuru Flow only');
    calls.push(allowance.call, swap);
  } else {
    calls.push(approveCall(route.tokenIn, route.to, amountIn), swap, approveCall(route.tokenIn, route.to, 0n));
  }

  if (input.deliverNative) {
    if (!isWmon(route.tokenOut)) throw new Error('native delivery unwraps WMON, and this route delivers something else');
    calls.push(wmonWithdraw(route.minOut));
  }
  return calls;
}

/** Rule 1.8's check for spending native MON from the wallet: the wallet must end at
 *  the 10 MON reserve or above. Returns the most that can be spent. */
export function maxNativeSpend(nativeBalance: bigint, reserveWei: bigint): bigint {
  return nativeBalance > reserveWei ? nativeBalance - reserveWei : 0n;
}

/** On the wire, every bigint is a decimal string. */
export interface SwapRouteWire {
  readonly vendor: SwapVendorId;
  readonly displayName: string;
  readonly to: Address;
  readonly data: Hex;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountIn: string;
  readonly expectedOut: string;
  readonly minOut: string;
  readonly gasEstimate?: string;
}

export function routeToWire(route: SwapRoute): SwapRouteWire {
  return {
    vendor: route.vendor,
    displayName: route.displayName,
    to: route.to,
    data: route.data,
    tokenIn: route.tokenIn,
    tokenOut: route.tokenOut,
    amountIn: route.amountIn.toString(),
    expectedOut: route.expectedOut.toString(),
    minOut: route.minOut.toString(),
    ...(route.gasEstimate !== undefined ? { gasEstimate: route.gasEstimate.toString() } : {}),
  };
}

export function routeFromWire(wire: SwapRouteWire): SwapRoute {
  return {
    vendor: wire.vendor,
    displayName: wire.displayName,
    to: getAddress(wire.to),
    data: wire.data,
    tokenIn: getAddress(wire.tokenIn),
    tokenOut: getAddress(wire.tokenOut),
    amountIn: BigInt(wire.amountIn),
    expectedOut: BigInt(wire.expectedOut),
    minOut: BigInt(wire.minOut),
    ...(wire.gasEstimate !== undefined ? { gasEstimate: BigInt(wire.gasEstimate) } : {}),
  };
}
