import {
  describeInnerRevert,
  ENTRY_POINT_V08,
  delegationCodeFor,
  needsAuthorization,
  SIMPLE_7702_DELEGATE,
  toGaslessAccount,
} from '@tradepro/core';
import type { Address, Hex, PublicClient } from 'viem';

/**
 * The pre-sign simulation gate for this app's own sponsored EIP-7702 batches (wallet
 * spec §5.1: "the plan is simulated with `eth_call` from the account before the
 * passkey prompt; a plan that would revert shows the decoded reason and never asks
 * for Face ID").
 *
 * `/api/fund/execute`'s `lib/server/rails.ts` already does the equivalent thing for a
 * *foreign*-chain, wallet-signed plan — plain `eth_call` per step, from the user's
 * own address on that chain. That recipe does not carry over to THIS app's own
 * sponsored batches unchanged: those calls execute atomically inside one EIP-7702
 * user operation (the permit's allowance has to exist before the swap that spends
 * it, in the same call frame), and a foreign-chain wallet transaction is signed and
 * sent by the address itself, not by the EntryPoint calling into a delegated EOA. A
 * batch of separate, unlinked `eth_call`s would not see the first call's state
 * change by the second, and would either falsely reject a batch that is actually
 * fine or falsely accept one that only works if you ignore ordering.
 *
 * So this reuses the *other* verified recipe already in this codebase —
 * `gas/account.ts`'s own doc comment, proved against a real sponsored path on Monad
 * mainnet on 2026-09-02:
 *
 *   eth_call({ from: EntryPointV08, to: EOA, data: account.encodeCalls([...]) })
 *   stateOverride: EOA.code = 0xef0100 || Simple7702Account   (only if not delegated yet)
 *
 * `account.encodeCalls` is viem's own, already-depended-on encoder for exactly this
 * account type (`toSimple7702SmartAccount`), not a guessed ABI for an unverified
 * contract — the delegate's bytecode itself is never decoded here, only the standard
 * library's calldata for calling it.
 */

export interface SimCall {
  readonly to: Address;
  readonly data: Hex;
  readonly value?: bigint;
}

export type SimulationResult =
  /** The chain accepted it, or nothing could be checked before it would run. */
  | { readonly executable: true; readonly checked: boolean }
  /** The chain refused it. `reason` is the chain's own words, never invented. */
  | { readonly executable: false; readonly checked: true; readonly reason: string };

/** A minimal, sign-incapable stand-in for the passkey account.
 *  `toGaslessAccount`/`encodeCalls` never call a signing method to build calldata —
 *  only `.address` is read — so nothing here needs to be able to sign anything, and
 *  nothing here ever will: this module only ever calls `client.call()`. */
function readOnlyOwner(address: Address): Parameters<typeof toGaslessAccount>[1] {
  const fail = () => {
    throw new Error('simulateSponsoredBatch: this stand-in account cannot sign anything');
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

/**
 * Simulate a batch exactly as it would execute inside the account's own sponsored
 * user operation, and report whether the chain accepts it.
 *
 * Never throws: a read that fails for a reason that is not a revert (a transport
 * error, an RPC hiccup) is not evidence the plan would fail, so it comes back as
 * `{ executable: true, checked: false }` — unchecked, not blocked, the same
 * distinction `/api/fund/execute`'s own simulation makes for a step it cannot check.
 */
export async function simulateSponsoredBatch(
  client: PublicClient,
  sender: Address,
  calls: readonly SimCall[],
): Promise<SimulationResult> {
  let data: Hex;
  try {
    const { account } = await toGaslessAccount(client, readOnlyOwner(sender));
    data = await account.encodeCalls(
      calls.map((c) => ({ to: c.to, data: c.data, value: c.value ?? 0n })),
    );
  } catch {
    // Could not even build the calldata to check — unchecked, not blocked.
    return { executable: true, checked: false };
  }

  let needsAuth: boolean;
  try {
    needsAuth = await needsAuthorization(client, sender);
  } catch {
    return { executable: true, checked: false };
  }

  try {
    await client.call({
      account: ENTRY_POINT_V08,
      to: sender,
      data,
      ...(needsAuth
        ? { stateOverride: [{ address: sender, code: delegationCodeFor(SIMPLE_7702_DELEGATE) }] }
        : {}),
    });
    return { executable: true, checked: true };
  } catch (error) {
    // Monad refuses a delegated account ending under its 10 MON reserve with -32000
    // "reserve balance violation", not a revert (security review F1, 2026-09-29;
    // D199/D200: the same gotcha `simulateDelivery.ts` already guards against for
    // swaps) — the chain's answer, so it blocks like a revert rather than passing
    // unchecked, checked first since it carries no revert data for `revertReasonOf`
    // to decode.
    const detail = error instanceof Error ? error.message : String(error);
    if (/reserve balance violation/i.test(detail)) {
      return {
        executable: false,
        checked: true,
        reason: 'Your wallet must keep 10 MON, and this would leave it with less.',
      };
    }
    const reason = revertReasonOf(error);
    if (!reason) {
      // Threw, but not with a revert reason — a transport problem, not the chain
      // refusing. Not evidence either way.
      return { executable: true, checked: false };
    }
    return { executable: false, checked: true, reason };
  }
}

/**
 * The chain's own decoded reason, mirroring `lib/server/rails.ts`'s own `ethCall`
 * for how a revert is told apart from a transport failure, and reusing `core`'s
 * `describeInnerRevert` (the relayer's own, already-verified `ExecuteError(index,
 * inner)` decoding — wallet spec §5.1 wants the decoded reason, not a bare
 * "execution reverted") for how the batch's revert data is actually read.
 * `describeInnerRevert` already tells a batch's wrapped revert from a single call's
 * unwrapped one on its own (`unwrapAccountRevert` falls back to the raw bytes when
 * they are not `ExecuteError`-shaped), so nothing here has to know which this was.
 *
 * The raw revert bytes are wherever viem's own error wrapping put them — `data` on
 * a decoded contract error, or `cause.data`/`cause.cause.data` a layer or two down a
 * plain JSON-RPC error, since a single `eth_call` with no ABI attached is not
 * auto-decoded by viem and the raw hex survives under different property names
 * depending on which layer threw. Every one of those is checked, in order.
 * `undefined` means none of them held anything — a transport problem, not the chain
 * refusing.
 */
function revertReasonOf(error: unknown): string | undefined {
  const raw = rawRevertDataOf(error);
  if (raw !== undefined) return describeInnerRevert(raw);

  // No raw bytes anywhere in the error — fall back to whatever plain-language reason
  // viem or the node did give, same as before this decode existed.
  const e = error as { shortMessage?: string; details?: string; cause?: { reason?: string } };
  const generic = /transaction creation failed|unknown reason/i;
  const specific = e.cause?.reason ?? e.details;
  return specific ?? (e.shortMessage && !generic.test(e.shortMessage) ? e.shortMessage : undefined);
}

function isHexData(value: unknown): value is Hex {
  return typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value) && value.length > 2;
}

/** Walks a few layers of viem's own error wrapping for the raw revert hex, however
 *  deep this particular failure buried it. */
function rawRevertDataOf(error: unknown): Hex | undefined {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const c = current as { data?: unknown; cause?: unknown };
    if (isHexData(c.data)) return c.data;
    current = c.cause;
  }
  return undefined;
}
