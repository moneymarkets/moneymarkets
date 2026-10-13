import { concat, type Address, type Hex, type PublicClient } from 'viem';
import { decodeKuruError, userMessageFor, type ForwardRequest } from '@tradepro/core';

/**
 * Pre-flight simulation.
 *
 * Spec §5.3 asks for an `eth_call` of `forwarder.execute(...)` before submitting.
 * That is not possible yet — the `execute` signature is open item 1 — but the thing
 * the simulation is *for* is entirely reachable without it.
 *
 * ERC-2771 works by appending the real sender's 20 bytes to the calldata; the target
 * reads them back as `_msgSender()` when `msg.sender` is the trusted forwarder.
 * `eth_call` lets the caller choose `from`, so the exact state transition the
 * forwarder would produce can be replayed directly:
 *
 *     eth_call({ from: forwarder, to: request.to, data: request.data ++ request.from })
 *
 * This was validated against the live MarginAccount on 2026-09-02: with a token mock
 * that only accepts `transferFrom` from the suffixed address, the call succeeds; with
 * mocks expecting the forwarder's own address it reverts. So the simulation exercises
 * the same sender resolution, the same balance and allowance reads, and the same
 * revert paths that the real forwarded call will.
 *
 * What it does not cover is the forwarder's own signature and nonce checks. Those are
 * validated separately in `validate.ts`, and the submitter still refuses to send
 * until open item 1 is closed.
 */

export interface SimulationResult {
  readonly ok: boolean;
  readonly revertData?: Hex;
  readonly errorName?: string;
  readonly userMessage?: string;
}

export function appendSenderSuffix(data: Hex, sender: Address): Hex {
  return concat([data, sender]);
}

export async function simulateForwardedCall(
  client: PublicClient,
  forwarder: Address,
  request: ForwardRequest,
): Promise<SimulationResult> {
  try {
    await client.call({
      account: forwarder,
      to: request.to,
      data: appendSenderSuffix(request.data, request.from),
      value: 0n,
    });
    return { ok: true };
  } catch (error) {
    const revertData = extractRevertData(error);
    const known = decodeKuruError(revertData);
    return {
      ok: false,
      ...(revertData ? { revertData } : {}),
      ...(known ? { errorName: known.name } : {}),
      userMessage: userMessageFor(revertData),
    };
  }
}

function extractRevertData(error: unknown): Hex | undefined {
  const walked = (error as { walk?: (fn: (e: unknown) => boolean) => unknown }).walk?.(
    (e) => typeof e === 'object' && e !== null && 'data' in e,
  );
  const candidate =
    (walked as { data?: unknown } | undefined)?.data ??
    (error as { data?: unknown }).data ??
    (error as { cause?: { data?: unknown } }).cause?.data;
  return typeof candidate === 'string' && candidate.startsWith('0x')
    ? (candidate as Hex)
    : undefined;
}
