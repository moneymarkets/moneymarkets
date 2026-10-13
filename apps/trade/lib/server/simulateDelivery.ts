import {
  delegationCodeFor,
  describeInnerRevert,
  needsAuthorization,
  SIMPLE_7702_DELEGATE,
  toGaslessAccount,
} from '@tradepro/core';
import { decodeEventLog, parseAbi, type Address, type Hex, type PublicClient } from 'viem';
import type { SimCall } from './simulateSponsoredBatch';

/**
 * Simulate a sponsored batch and read what it delivers, for the swap's pre-sign gate
 * (rules 1.6 and 1.7). `simulateSponsoredBatch` answers "would it revert"; this also
 * answers "how much of `tokenOut` reaches the account", which is what tells a
 * fee-on-transfer token apart from an honest route.
 *
 * Method, observed on Monad 2026-09-29 (reports/SWAP-VERIFY.md): `eth_simulateV1` with
 * the account as its own sender. A contract sender (the EntryPoint) is refused there
 * ("sender not eoa"); the account itself is accepted, delegated or not (an undelegated
 * account gets the delegation code by `stateOverrides`), and the delegate's
 * `executeBatch` admits `msg.sender == address(this)`. Each call's `logs` come back, so
 * the delivered amount is the sum of the batch's `Transfer(_, account, v)` logs on
 * `tokenOut`, the same reading `deliveredAmountFromLogs` makes from a real receipt.
 * Native MON delivered by an appended `WMON.withdraw` is not an ERC-20 transfer; the
 * caller reads that case from the withdraw amount instead.
 */

const TRANSFER = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);

export type DeliveryResult =
  | { readonly status: 'ok'; readonly delivered: bigint }
  | { readonly status: 'reverted'; readonly reason: string }
  /** The simulation itself could not be run. Not evidence either way. */
  | { readonly status: 'unchecked'; readonly detail: string };

interface SimulateCallResult {
  readonly status?: string;
  readonly logs?: readonly { address: Address; topics: Hex[]; data: Hex }[];
  readonly error?: { readonly message?: string; readonly data?: Hex };
}

function readOnlyOwner(address: Address): Parameters<typeof toGaslessAccount>[1] {
  const fail = () => {
    throw new Error('simulateDelivery: this stand-in account cannot sign anything');
  };
  return {
    address,
    type: 'local',
    sign: fail,
    signMessage: fail,
    signTransaction: fail,
    signTypedData: fail,
    signAuthorization: fail,
  } as unknown as Parameters<typeof toGaslessAccount>[1];
}

export function deliveredFromLogs(
  logs: readonly { address: Address; topics: Hex[]; data: Hex }[],
  tokenOut: Address,
  recipient: Address,
): bigint {
  let total = 0n;
  for (const log of logs) {
    if (log.address.toLowerCase() !== tokenOut.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: TRANSFER, topics: log.topics as [Hex, ...Hex[]], data: log.data });
      if (decoded.args.to.toLowerCase() === recipient.toLowerCase()) total += decoded.args.value;
    } catch {
      // Not a Transfer on this token; skip rather than guess.
    }
  }
  return total;
}

export async function simulateDelivery(
  client: PublicClient,
  sender: Address,
  calls: readonly SimCall[],
  tokenOut: Address,
  /** Read-only verification scripts only: simulate as if the account held this much MON. */
  nativeBalanceOverride?: bigint,
): Promise<DeliveryResult> {
  let data: Hex;
  let needsAuth: boolean;
  try {
    const { account } = await toGaslessAccount(client, readOnlyOwner(sender));
    data = await account.encodeCalls(calls.map((c) => ({ to: c.to, data: c.data, value: c.value ?? 0n })));
    needsAuth = await needsAuthorization(client, sender);
  } catch (error) {
    return { status: 'unchecked', detail: error instanceof Error ? error.message : String(error) };
  }

  const override = {
    ...(needsAuth ? { code: delegationCodeFor(SIMPLE_7702_DELEGATE) } : {}),
    ...(nativeBalanceOverride !== undefined ? { balance: `0x${nativeBalanceOverride.toString(16)}` } : {}),
  };
  const blockStateCall = {
    ...(Object.keys(override).length > 0 ? { stateOverrides: { [sender]: override } } : {}),
    calls: [{ from: sender, to: sender, data }],
  };

  let result: { calls?: SimulateCallResult[] }[];
  try {
    result = (await client.request({
      method: 'eth_simulateV1' as never,
      params: [{ blockStateCalls: [blockStateCall] }, 'latest'] as never,
    })) as { calls?: SimulateCallResult[] }[];
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // Monad refuses a delegated account ending under its 10 MON reserve with -32000
    // "reserve balance violation", not a revert (security review F1, 2026-09-29). It is
    // the chain's answer, so it blocks like a revert rather than passing unchecked.
    if (/reserve balance violation/i.test(detail)) {
      return { status: 'reverted', reason: 'Your wallet must keep 10 MON, and this swap would leave it with less.' };
    }
    return { status: 'unchecked', detail };
  }

  const call = result[0]?.calls?.[0];
  if (!call) return { status: 'unchecked', detail: 'eth_simulateV1 returned no call result' };
  if (call.status !== '0x1') {
    if (/reserve balance violation/i.test(call.error?.message ?? '')) {
      return { status: 'reverted', reason: 'Your wallet must keep 10 MON, and this swap would leave it with less.' };
    }
    const raw = call.error?.data;
    const reason =
      raw && raw.length > 2 ? describeInnerRevert(raw) : (call.error?.message ?? 'the simulation reverted without a reason');
    return { status: 'reverted', reason };
  }
  return { status: 'ok', delivered: deliveredFromLogs(call.logs ?? [], tokenOut, sender) };
}
