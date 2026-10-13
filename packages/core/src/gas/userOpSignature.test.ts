import { describe, expect, it } from 'vitest';
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  createBundlerClient,
  entryPoint08Abi,
  entryPoint08Address,
} from 'viem/account-abstraction';
import { chainFor } from '../chain/chains.js';
import { toGaslessAccount } from './account.js';
import { delegationCodeFor, ENTRY_POINT_V08, SIMPLE_7702_DELEGATE } from './delegate.js';
import {
  nonceKeyOf,
  rpcUserOperationSchema,
  verifyUserOperationSignature,
  withSignedEstimates,
  type RpcUserOperationV08,
} from './userOpSignature.js';

/**
 * The relayer's signature check against the browser's actual signing path.
 *
 * Every operation here is produced by viem's own `prepareUserOperation` and
 * `sendUserOperation`, the same calls `apps/trade/lib/fund/bundlerTransport.ts` makes,
 * talking to fake transports that record exactly what would have gone over the wire. No
 * operation is assembled by hand. A hand-built fixture proves only that the verifier
 * agrees with the fixture (the lesson of the 2026-09-03 permit reviews). This proves it
 * agrees with viem.
 */

const CHAIN = chainFor('mainnet');
const CONTEXT = { chainId: CHAIN.id, entryPoint: ENTRY_POINT_V08 };
// A throwaway test key. Not a secret, holds nothing, and never touches a network.
const owner = privateKeyToAccount(`0x${'5a'.repeat(32)}` as Hex);
const OTHER = privateKeyToAccount(`0x${'6b'.repeat(32)}` as Hex);
const MARGIN = '0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5' as Address;

/** A public client that answers the reads `prepareUserOperation` makes, and nothing else. */
function fakePublicClient(options: { delegated: boolean }): PublicClient {
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
          case 'eth_getTransactionCount':
            return '0x0';
          case 'eth_maxPriorityFeePerGas':
            return '0x3b9aca00';
          case 'eth_getBlockByNumber':
            return {
              number: '0x1',
              hash: `0x${'11'.repeat(32)}`,
              parentHash: `0x${'22'.repeat(32)}`,
              timestamp: '0x1',
              baseFeePerGas: '0x17bfac7c00',
              gasLimit: '0x1c9c380',
              gasUsed: '0x0',
              transactions: [],
            };
          case 'eth_call': {
            // EntryPoint.getNonce(sender, key): a fresh key has sequence 0, so the
            // answer is key << 64 — exactly what the real EntryPoint returns.
            const call = args[0] as { to: Address; data: Hex };
            expect(call.to.toLowerCase()).toBe(entryPoint08Address.toLowerCase());
            const decoded = decodeFunctionData({ abi: entryPoint08Abi, data: call.data });
            expect(decoded.functionName).toBe('getNonce');
            const key = (decoded.args as readonly [Address, bigint])[1];
            return encodeFunctionResult({
              abi: entryPoint08Abi,
              functionName: 'getNonce',
              result: key << 64n,
            });
          }
          default:
            throw new Error(`the fake public client was not expecting ${method}`);
        }
      },
    }),
  }) as PublicClient;
}

/** Records every bundler call and answers the two a submission makes. */
function recordingBundler() {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      calls.push({ method, params: (params ?? []) as unknown[] });
      if (method === 'eth_estimateUserOperationGas') {
        return {
          callGasLimit: '0x61a80',
          verificationGasLimit: '0x186a0',
          preVerificationGas: '0xea60',
        };
      }
      if (method === 'eth_sendUserOperation') return `0x${'ab'.repeat(32)}`;
      if (method === 'eth_chainId') return `0x${CHAIN.id.toString(16)}`;
      throw new Error(`the recording bundler was not expecting ${method}`);
    },
  });
  return { calls, transport };
}

async function submitThroughViem(options: { delegated: boolean; signedEstimates: boolean }) {
  const client = fakePublicClient(options);
  const { account } = await toGaslessAccount(client, owner);
  const recorder = recordingBundler();
  const bundler = createBundlerClient({
    account: options.signedEstimates ? withSignedEstimates(account) : account,
    client: client as never,
    transport: recorder.transport,
  });
  // The same explicit authorization bundlerTransport signs for an undelegated account.
  const authorization = options.delegated
    ? undefined
    : await owner.signAuthorization({ address: SIMPLE_7702_DELEGATE, chainId: CHAIN.id, nonce: 0 });

  const prepared = (await bundler.prepareUserOperation({
    calls: [{ to: MARGIN, data: '0xdeadbeef', value: 0n }],
    ...(authorization ? { authorization } : {}),
  })) as Record<string, unknown>;
  const signature = await account.signUserOperation(prepared as never);
  await bundler.sendUserOperation({ ...prepared, signature } as never);

  const wire = (method: string) => {
    const call = recorder.calls.find((c) => c.method === method);
    if (!call) throw new Error(`no ${method} was sent`);
    return { op: rpcUserOperationSchema.parse(call.params[0]), entryPoint: call.params[1] };
  };
  return { estimate: wire('eth_estimateUserOperationGas'), send: wire('eth_sendUserOperation') };
}

describe('a real signed estimate verifies', () => {
  it('for a first-time account carrying its EIP-7702 authorization', async () => {
    const { estimate } = await submitThroughViem({ delegated: false, signedEstimates: true });
    expect(estimate.op.factory).toBe('0x7702');
    expect(estimate.op.eip7702Auth).toBeDefined();
    // Every gas limit is zero on the estimate — the fields the signature is over. All
    // three, because any one of them non-zero would be a limit someone could execute with.
    expect(BigInt(estimate.op.callGasLimit ?? '0x0')).toBe(0n);
    expect(BigInt(estimate.op.verificationGasLimit ?? '0x0')).toBe(0n);
    expect(BigInt(estimate.op.preVerificationGas ?? '0x0')).toBe(0n);
    const proof = await verifyUserOperationSignature(estimate.op, CONTEXT);
    expect(proof).toMatchObject({ ok: true });
  });

  it('for an account that is already delegated', async () => {
    const { estimate } = await submitThroughViem({ delegated: true, signedEstimates: true });
    expect(estimate.op.factory).toBeUndefined();
    expect(estimate.op.eip7702Auth).toBeUndefined();
    const proof = await verifyUserOperationSignature(estimate.op, CONTEXT);
    expect(proof).toMatchObject({ ok: true });
  });

  it('names EntryPoint v0.8 as its entry point', async () => {
    const { estimate, send } = await submitThroughViem({ delegated: true, signedEstimates: true });
    expect(entryPoint08Address).toBe(ENTRY_POINT_V08);
    expect(String(estimate.entryPoint).toLowerCase()).toBe(ENTRY_POINT_V08.toLowerCase());
    expect(String(send.entryPoint).toLowerCase()).toBe(ENTRY_POINT_V08.toLowerCase());
  });

  it('carries a nonce whose key is fresh, not zero', async () => {
    const { estimate, send } = await submitThroughViem({ delegated: true, signedEstimates: true });
    // viem's nonceKeyManager draws a key per operation, so the relayer must read the
    // EntryPoint nonce for THIS key. Checking key zero would refuse every real op.
    expect(nonceKeyOf(BigInt(estimate.op.nonce))).toBeGreaterThan(0n);
    expect(estimate.op.nonce).toBe(send.op.nonce);
  });
});

describe('withSignedEstimates will not sign an operation that carries gas limits (F2)', () => {
  async function wrapped() {
    const { account } = await toGaslessAccount(fakePublicClient({ delegated: true }), owner);
    return { account, signing: withSignedEstimates(account) };
  }

  const base = {
    sender: owner.address,
    nonce: 1n << 64n,
    callData: '0xdeadbeef' as Hex,
    maxFeePerGas: 204_000_000_000n,
    maxPriorityFeePerGas: 2_000_000_000n,
  };

  it.each([['callGasLimit'], ['verificationGasLimit'], ['preVerificationGas']] as const)(
    'returns the placeholder, not a signature, when %s is non-zero',
    async (field) => {
      const { account, signing } = await wrapped();
      const signature = await signing.getStubSignature({ ...base, [field]: 1n } as never);
      expect(signature).toBe(await account.getStubSignature());
      // And the placeholder proves nothing to the relayer.
      const op = rpcUserOperationSchema.parse({
        sender: base.sender,
        nonce: `0x${base.nonce.toString(16)}`,
        callData: base.callData,
        [field]: '0x1',
        maxFeePerGas: `0x${base.maxFeePerGas.toString(16)}`,
        maxPriorityFeePerGas: `0x${base.maxPriorityFeePerGas.toString(16)}`,
        signature,
      });
      expect((await verifyUserOperationSignature(op, CONTEXT)).ok).toBe(false);
    },
  );

  it('refuses a limit of an unexpected type rather than guessing it is zero', async () => {
    const { account, signing } = await wrapped();
    const signature = await signing.getStubSignature({ ...base, callGasLimit: '0x0' } as never);
    expect(signature).toBe(await account.getStubSignature());
  });

  it('signs for real when every limit is zero or absent', async () => {
    const { account, signing } = await wrapped();
    const placeholder = await account.getStubSignature();
    expect(await signing.getStubSignature(base as never)).not.toBe(placeholder);
    expect(
      await signing.getStubSignature({
        ...base,
        callGasLimit: 0n,
        verificationGasLimit: 0n,
        preVerificationGas: 0n,
      } as never),
    ).not.toBe(placeholder);
  });
});

describe('the send verifies exactly as before', () => {
  it.each([
    ['first-time', false],
    ['delegated', true],
  ])('%s account: the signed operation recovers to its sender', async (_label, delegated) => {
    const { send } = await submitThroughViem({ delegated, signedEstimates: true });
    expect(BigInt(send.op.callGasLimit ?? '0x0')).toBeGreaterThan(0n);
    const proof = await verifyUserOperationSignature(send.op, CONTEXT);
    expect(proof).toMatchObject({ ok: true });
  });
});

describe('what does not verify', () => {
  it('refuses viem’s placeholder estimate signature — the dummy proves nothing', async () => {
    const { estimate, send } = await submitThroughViem({ delegated: false, signedEstimates: false });
    const proof = await verifyUserOperationSignature(estimate.op, CONTEXT);
    expect(proof.ok).toBe(false);
    // The unwrapped account's real send still verifies; only the estimate is unproven.
    expect((await verifyUserOperationSignature(send.op, CONTEXT)).ok).toBe(true);
  });

  const tamper = async (edit: (op: RpcUserOperationV08) => RpcUserOperationV08) => {
    const { send } = await submitThroughViem({ delegated: true, signedEstimates: true });
    return verifyUserOperationSignature(edit(send.op), CONTEXT);
  };

  it('refuses the same signature on different calls', async () => {
    const proof = await tamper((op) => ({ ...op, callData: `${op.callData}00` }));
    expect(proof.ok).toBe(false);
  });

  it('refuses a signature moved onto someone else’s address', async () => {
    const proof = await tamper((op) => ({ ...op, sender: OTHER.address }));
    expect(proof.ok).toBe(false);
  });

  it('refuses a different nonce under the same signature', async () => {
    const proof = await tamper((op) => ({ ...op, nonce: `0x${(BigInt(op.nonce) + 1n).toString(16)}` }));
    expect(proof.ok).toBe(false);
  });

  it('refuses a signature made for another chain', async () => {
    const { send } = await submitThroughViem({ delegated: true, signedEstimates: true });
    const proof = await verifyUserOperationSignature(send.op, { ...CONTEXT, chainId: 10143 });
    expect(proof.ok).toBe(false);
  });

  it('refuses the malleated twin of a valid signature, as OpenZeppelin ECDSA would', async () => {
    const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const proof = await tamper((op) => {
      const r = op.signature.slice(2, 66);
      const s = BigInt(`0x${op.signature.slice(66, 130)}`);
      const v = Number.parseInt(op.signature.slice(130, 132), 16);
      const flipped = (N - s).toString(16).padStart(64, '0');
      const flippedV = (v === 27 ? 28 : 27).toString(16);
      return { ...op, signature: `0x${r}${flipped}${flippedV}` };
    });
    expect(proof).toEqual({ ok: false, reason: 'the signature is malleable or malformed' });
  });

  it('refuses the EIP-7702 marker without its authorization', async () => {
    const { estimate } = await submitThroughViem({ delegated: false, signedEstimates: true });
    const { eip7702Auth: _dropped, ...withoutAuth } = estimate.op;
    const proof = await verifyUserOperationSignature(withoutAuth, CONTEXT);
    expect(proof.ok).toBe(false);
  });

  it('refuses an operation that names a paymaster', async () => {
    const proof = await tamper((op) => ({ ...op, paymaster: MARGIN, paymasterData: '0x' }));
    expect(proof.ok).toBe(false);
  });

  it('refuses a signature that is not 65 bytes at the schema', () => {
    const parsed = rpcUserOperationSchema.safeParse({
      sender: owner.address,
      nonce: '0x0',
      callData: '0x',
      maxFeePerGas: '0x1',
      maxPriorityFeePerGas: '0x1',
      signature: '0x1234',
    });
    expect(parsed.success).toBe(false);
  });
});
