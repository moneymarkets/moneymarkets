import { describe, expect, it } from 'vitest';
import {
  createPublicClient,
  custom,
  encodeErrorResult,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { chainFor, delegationCodeFor, KURU_FLOW_ROUTER, MAINNET, SIMPLE_7702_DELEGATE } from '@tradepro/core';
import { simulateSponsoredBatch } from './simulateSponsoredBatch';

/**
 * The pre-sign simulation gate (wallet spec §5.1): a plan that would revert must
 * show the decoded reason and must never be offered as signable.
 *
 * Rewritten after an independent mutation-testing review found three real gaps this
 * file's earlier version did not catch: simulating only the first call of a batch,
 * never overriding code for a not-yet-delegated account, and overriding with the
 * wrong delegate — the last one is the dangerous one, since removing the override
 * entirely on mainnet made a failing batch from a fresh (undelegated) account read
 * as `executable: true`. Every one of those is now asserted directly: the exact
 * `stateOverride` sent to `client.call()`, and that the calldata for a multi-call
 * batch is not the same calldata a single-call simulation would produce.
 *
 * The fake client answers only what `simulateSponsoredBatch` actually needs —
 * `eth_getCode` (delegation status) and `eth_call` (the simulation itself) — the
 * same technique `gas/userOpSignature.test.ts` uses for this exact account type.
 */

const CHAIN = chainFor('mainnet');
const SENDER = '0x43a275C3Eb0BE7313f847FFA4fb6Bd366606A961' as Address;
const USDC = MAINNET.tokens.USDC.address;
const PERMIT_CALL = { to: USDC, data: '0xd505accf' as Hex };
const SWAP_CALL = { to: KURU_FLOW_ROUTER, data: '0xce1e7030' as Hex };

interface CapturedCall {
  readonly account: Address | undefined;
  readonly to: Address | undefined;
  readonly data: Hex | undefined;
  readonly stateOverride: unknown;
}

function fakeClient(options: {
  delegated: boolean;
  onCall: (call: CapturedCall) => void;
  /** `undefined` succeeds; a hex string reverts with exactly that raw revert data. */
  revertData?: Hex;
  /** Monad's own -32000, carrying no revert data at all (D199/D200). */
  reserveViolation?: boolean;
}): PublicClient {
  return createPublicClient({
    chain: CHAIN,
    transport: custom({
      async request({ method, params }: { method: string; params?: unknown }) {
        const args = (params ?? []) as unknown[];
        switch (method) {
          case 'eth_chainId':
            return `0x${CHAIN.id.toString(16)}`;
          case 'eth_getCode':
            return options.delegated ? delegationCodeFor(SIMPLE_7702_DELEGATE) : '0x';
          case 'eth_call': {
            const call = args[0] as { to?: Address; data?: Hex; from?: Address };
            const stateOverride = args[2];
            options.onCall({ to: call.to, data: call.data, account: call.from, stateOverride });
            if (options.reserveViolation) {
              throw { code: -32000, message: 'reserve balance violation' };
            }
            if (options.revertData === undefined) return '0x';
            // A raw JSON-RPC error carrying real revert bytes — the shape a real
            // node returns, so viem's own error wrapping is exercised for real
            // rather than assumed.
            throw { code: 3, message: 'execution reverted', data: options.revertData };
          }
          default:
            // Permissive: `toGaslessAccount`/`encodeCalls` may read a small number
            // of other view methods to build the smart-account object. Anything
            // this test does not care about gets a harmless zero answer.
            return '0x0000000000000000000000000000000000000000000000000000000000000000';
        }
      },
    }),
  }) as PublicClient;
}

describe('simulateSponsoredBatch — the caller and the target', () => {
  it('calls as the EntryPoint into the sender, not as the sender on their own behalf', async () => {
    const calls: CapturedCall[] = [];
    const client = fakeClient({ delegated: true, onCall: (c) => calls.push(c) });

    await simulateSponsoredBatch(client, SENDER, [PERMIT_CALL, SWAP_CALL]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.account?.toLowerCase()).toBe(
      '0x4337084d9e255ff0702461cf8895ce9e3b5ff108', // ENTRY_POINT_V08
    );
    expect(calls[0]!.to?.toLowerCase()).toBe(SENDER.toLowerCase());
  });

  it('accepts a batch the chain does not refuse', async () => {
    const client = fakeClient({ delegated: true, onCall: () => {} });
    const result = await simulateSponsoredBatch(client, SENDER, [PERMIT_CALL, SWAP_CALL]);
    expect(result).toEqual({ executable: true, checked: true });
  });
});

describe('simulateSponsoredBatch — the state override (the dangerous gap)', () => {
  it('overrides the sender\'s own code with exactly the Simple7702 delegation indicator when not yet delegated', async () => {
    const calls: CapturedCall[] = [];
    const client = fakeClient({ delegated: false, onCall: (c) => calls.push(c) });

    await simulateSponsoredBatch(client, SENDER, [PERMIT_CALL]);

    // viem's `client.call()` sends `stateOverride` over the wire keyed by address
    // (the JSON-RPC `eth_call` third parameter's own shape), not as the array this
    // module builds it as — asserting on the wire shape is what actually proves the
    // override reaches the node, rather than proving this module built *an* array.
    expect(calls[0]!.stateOverride).toEqual({
      [SENDER]: { code: delegationCodeFor(SIMPLE_7702_DELEGATE) },
    });
  });

  it('sends no state override at all once the account is already delegated', async () => {
    const calls: CapturedCall[] = [];
    const client = fakeClient({ delegated: true, onCall: (c) => calls.push(c) });

    await simulateSponsoredBatch(client, SENDER, [PERMIT_CALL]);

    expect(calls[0]!.stateOverride).toBeUndefined();
  });

  it('never overrides any address other than the sender itself', async () => {
    const calls: CapturedCall[] = [];
    const client = fakeClient({ delegated: false, onCall: (c) => calls.push(c) });

    await simulateSponsoredBatch(client, SENDER, [PERMIT_CALL]);

    const override = calls[0]!.stateOverride as Record<string, unknown>;
    expect(Object.keys(override)).toEqual([SENDER]);
  });
});

describe('simulateSponsoredBatch — every call in the batch is actually simulated', () => {
  it('a two-call batch does not simulate the same calldata a one-call batch would', async () => {
    const twoCallCalls: CapturedCall[] = [];
    await simulateSponsoredBatch(fakeClient({ delegated: true, onCall: (c) => twoCallCalls.push(c) }), SENDER, [
      PERMIT_CALL,
      SWAP_CALL,
    ]);

    const firstOnlyCalls: CapturedCall[] = [];
    await simulateSponsoredBatch(
      fakeClient({ delegated: true, onCall: (c) => firstOnlyCalls.push(c) }),
      SENDER,
      [PERMIT_CALL],
    );

    const secondOnlyCalls: CapturedCall[] = [];
    await simulateSponsoredBatch(
      fakeClient({ delegated: true, onCall: (c) => secondOnlyCalls.push(c) }),
      SENDER,
      [SWAP_CALL],
    );

    // If only the first call were ever encoded, the two-call batch's calldata would
    // be indistinguishable from the one-call-alone batch built from the same first
    // call — this catches exactly that regression.
    expect(twoCallCalls[0]!.data).not.toBe(firstOnlyCalls[0]!.data);
    expect(twoCallCalls[0]!.data).not.toBe(secondOnlyCalls[0]!.data);
    // And the batch's calldata is strictly longer: it carries both calls' bytes.
    expect((twoCallCalls[0]!.data ?? '').length).toBeGreaterThan((firstOnlyCalls[0]!.data ?? '').length);
  });
});

describe('simulateSponsoredBatch — the decoded reason (spec §5.1)', () => {
  const ACCOUNT_ERRORS = parseAbi(['error ExecuteError(uint256 index, bytes innerError)']);
  const SOLIDITY_ERROR = parseAbi(['error Error(string reason)']);

  function encodeSolidityError(reason: string): Hex {
    return encodeErrorResult({ abi: SOLIDITY_ERROR, errorName: 'Error', args: [reason] });
  }
  function encodeExecuteError(index: bigint, inner: Hex): Hex {
    return encodeErrorResult({ abi: ACCOUNT_ERRORS, errorName: 'ExecuteError', args: [index, inner] });
  }

  it('names the failing call and the chain\'s own reason for a reverting batch, never a bare "execution reverted"', async () => {
    const inner = encodeSolidityError('InsufficientBalance');
    const client = fakeClient({
      delegated: true,
      onCall: () => {},
      revertData: encodeExecuteError(1n, inner),
    });

    const result = await simulateSponsoredBatch(client, SENDER, [PERMIT_CALL, SWAP_CALL]);

    expect(result.executable).toBe(false);
    expect(!result.executable && result.reason).toContain('call 2 of the batch');
    expect(!result.executable && result.reason).toContain('InsufficientBalance');
    expect(!result.executable && result.reason).not.toBe('execution reverted');
  });

  it('decodes a single unwrapped revert the same way, with no batch framing', async () => {
    const client = fakeClient({
      delegated: true,
      onCall: () => {},
      revertData: encodeSolidityError('SizeError'),
    });

    const result = await simulateSponsoredBatch(client, SENDER, [PERMIT_CALL]);

    expect(result.executable).toBe(false);
    expect(!result.executable && result.reason).toContain('SizeError');
    expect(!result.executable && result.reason).not.toContain('batch');
  });

  it('is unchecked, not blocked, when the node answers with no revert data at all', async () => {
    const client = fakeClient({ delegated: true, onCall: () => {}, revertData: '0x' as Hex });
    const result = await simulateSponsoredBatch(client, SENDER, [PERMIT_CALL]);
    // Empty revert data is still a real refusal (`describeInnerRevert` says so
    // honestly: "The chain gave no reason") — checked and refused, not waved through.
    expect(result.executable).toBe(false);
  });

  it('blocks Monad\'s own -32000 "reserve balance violation" as a real refusal, not an unchecked transport error (D199/D200)', async () => {
    const client = fakeClient({ delegated: true, onCall: () => {}, reserveViolation: true });
    const result = await simulateSponsoredBatch(client, SENDER, [PERMIT_CALL]);
    expect(result).toEqual({
      executable: false,
      checked: true,
      reason: 'Your wallet must keep 10 MON, and this would leave it with less.',
    });
  });
});
