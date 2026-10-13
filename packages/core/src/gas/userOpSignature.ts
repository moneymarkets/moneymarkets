import { z } from 'zod';
import { getAddress, recoverAddress, type Address, type Hex } from 'viem';
import {
  getUserOperationHash,
  type SmartAccount,
  type UserOperation,
} from 'viem/account-abstraction';

/**
 * Who signed a user operation, checked the way the EntryPoint will check it.
 *
 * ## Why the relayer needs this at all
 *
 * The relayer pays MON into an account's EntryPoint deposit before that account's
 * operation is forwarded (`ensureDeposit`). Until 2026-09-23 nothing in the relayer
 * looked at a signature, so any request naming any address could make the float pay
 * into that address's deposit (audit finding S4-C1). A top-up now requires proof that
 * whoever asks holds the sender's key: a signature over this operation that recovers to
 * `sender`.
 *
 * ## What is hashed, and why it matches the chain
 *
 * EntryPoint v0.8 hashes a user operation as EIP-712 `PackedUserOperation` under the
 * domain `{ name: "ERC4337", version: "1", chainId, verifyingContract: EntryPoint }`, and
 * `Simple7702Account._validateSignature` accepts exactly `ECDSA.recover(userOpHash, sig) ==
 * address(this)`. viem's `getUserOperationHash` is the implementation the browser signs
 * with (`toSimple7702SmartAccount.signUserOperation`), so hashing with it guarantees the
 * relayer checks the same digest the user signed.
 *
 * One field differs between the wire and the hash. A first operation carries the EIP-7702
 * marker `factory = 0x7702` and its authorization as `eip7702Auth`. The EntryPoint then
 * hashes the delegate's address in place of the marker, and viem does the same, but only
 * when it is handed `authorization`, which the wire format calls something else. So the
 * delegate is lifted out of `eip7702Auth` here. A marker with no authorization is refused.
 * viem never sends one, and the chain would hash the on-chain delegate there, which the
 * wire does not carry.
 */

const hex = z.string().regex(/^0x[0-9a-fA-F]*$/, 'expected 0x-prefixed hex');
const quantity = z.string().regex(/^0x[0-9a-fA-F]{1,64}$/, 'expected a hex quantity');
const addressHex = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected a 20-byte address');
const word = z.string().regex(/^0x[0-9a-fA-F]{1,64}$/, 'expected at most 32 bytes');

/** The EIP-7702 marker, as viem writes it (both spellings reach the same EntryPoint branch). */
const EIP7702_MARKERS = new Set(['0x7702', `0x7702${'0'.repeat(36)}`]);

/** Is `factory` the EIP-7702 marker (either spelling)? */
export function isEip7702Marker(factory: string | undefined): boolean {
  return factory !== undefined && EIP7702_MARKERS.has(factory.toLowerCase());
}

/**
 * An EntryPoint v0.8 user operation in its JSON-RPC form, as viem's
 * `formatUserOperationRequest` writes it.
 *
 * The three gas limits are optional because viem sends them as `0x0` during estimation
 * and a missing value hashes exactly as zero does. The signature must be 65 bytes. Anything
 * else cannot be an ECDSA signature `Simple7702Account` would accept.
 */
export const rpcUserOperationSchema = z.object({
  sender: addressHex,
  nonce: quantity,
  factory: hex.optional(),
  factoryData: hex.optional(),
  callData: hex,
  callGasLimit: quantity.optional(),
  verificationGasLimit: quantity.optional(),
  preVerificationGas: quantity.optional(),
  maxFeePerGas: quantity,
  maxPriorityFeePerGas: quantity,
  paymaster: hex.optional(),
  paymasterData: hex.optional(),
  paymasterVerificationGasLimit: quantity.optional(),
  paymasterPostOpGasLimit: quantity.optional(),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/, 'expected a 65-byte signature'),
  eip7702Auth: z
    .object({
      address: addressHex,
      chainId: quantity,
      nonce: quantity,
      r: word,
      s: word,
      yParity: quantity,
    })
    .optional(),
});

export type RpcUserOperationV08 = z.infer<typeof rpcUserOperationSchema>;

export type UserOperationProof =
  | { readonly ok: true; readonly hash: Hex; readonly nonce: bigint }
  | { readonly ok: false; readonly reason: string };

/** secp256k1 group order, halved. OpenZeppelin's ECDSA refuses any `s` above this. */
const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/**
 * True when a paymaster field is present and non-empty.
 *
 * This project uses no paymaster. Gas comes from the account's own deposit, which is the
 * only thing the relayer tops up. An operation that names a paymaster does not draw on
 * that deposit at all, so funding it would be paying for nothing. And forwarding it would
 * carry someone else's sponsor on this relayer's bundler quota.
 */
export function namesPaymaster(op: RpcUserOperationV08): boolean {
  return op.paymaster !== undefined && op.paymaster !== '0x';
}

/**
 * The user operation hash the EntryPoint will compute, or a reason it cannot be computed.
 */
export function userOperationHashOf(
  op: RpcUserOperationV08,
  context: { readonly chainId: number; readonly entryPoint: Address },
): { ok: true; hash: Hex } | { ok: false; reason: string } {
  if (namesPaymaster(op)) {
    return { ok: false, reason: 'the operation names a paymaster, and this relayer uses none' };
  }
  const isMarker = op.factory !== undefined && EIP7702_MARKERS.has(op.factory.toLowerCase());
  if (isMarker && !op.eip7702Auth) {
    return {
      ok: false,
      reason: 'the operation carries the EIP-7702 marker without its authorization',
    };
  }

  return {
    ok: true,
    hash: getUserOperationHash({
      chainId: context.chainId,
      entryPointAddress: context.entryPoint,
      entryPointVersion: '0.8',
      userOperation: toUserOperationV08(op),
    }),
  };
}

/**
 * The wire operation as viem's `UserOperation` type: the one object that is both hashed
 * for the signature check and packed for `handleOps`. Using the same conversion for
 * both is what guarantees the relayer submits exactly the operation it verified.
 */
export function toUserOperationV08(op: RpcUserOperationV08): UserOperation<'0.8'> {
  return {
    sender: getAddress(op.sender),
    nonce: BigInt(op.nonce),
    callData: op.callData as Hex,
    callGasLimit: BigInt(op.callGasLimit ?? '0x0'),
    verificationGasLimit: BigInt(op.verificationGasLimit ?? '0x0'),
    preVerificationGas: BigInt(op.preVerificationGas ?? '0x0'),
    maxFeePerGas: BigInt(op.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(op.maxPriorityFeePerGas),
    signature: op.signature as Hex,
    ...(op.factory !== undefined ? { factory: op.factory as Address } : {}),
    ...(op.factoryData !== undefined ? { factoryData: op.factoryData as Hex } : {}),
    ...(op.eip7702Auth
      ? {
          authorization: {
            address: getAddress(op.eip7702Auth.address),
            chainId: Number(BigInt(op.eip7702Auth.chainId)),
            nonce: Number(BigInt(op.eip7702Auth.nonce)),
            r: op.eip7702Auth.r as Hex,
            s: op.eip7702Auth.s as Hex,
            yParity: Number(BigInt(op.eip7702Auth.yParity)),
          },
        }
      : {}),
  };
}

/**
 * Does this operation's signature recover to its sender?
 *
 * Only the signature is checked here. The nonce is the caller's to check against the
 * EntryPoint, because that needs a chain read, and a signature over a nonce that has
 * already been used is a replay, not a proof.
 */
export async function verifyUserOperationSignature(
  op: RpcUserOperationV08,
  context: { readonly chainId: number; readonly entryPoint: Address },
): Promise<UserOperationProof> {
  const hashed = userOperationHashOf(op, context);
  if (!hashed.ok) return hashed;

  // r (32) || s (32) || v (1). Anything OpenZeppelin's ECDSA would refuse on chain is
  // refused here too, so a signature the account will reject never counts as proof.
  const s = BigInt(`0x${op.signature.slice(66, 130)}`);
  const v = Number.parseInt(op.signature.slice(130, 132), 16);
  if (v !== 27 && v !== 28) return { ok: false, reason: 'the signature has an invalid v' };
  if (s === 0n || s > SECP256K1_HALF_N) {
    return { ok: false, reason: 'the signature is malleable or malformed' };
  }

  let recovered: Address;
  try {
    recovered = await recoverAddress({ hash: hashed.hash, signature: op.signature as Hex });
  } catch {
    return { ok: false, reason: 'the signature does not recover to any address' };
  }
  if (recovered.toLowerCase() !== op.sender.toLowerCase()) {
    return { ok: false, reason: 'the signature does not recover to the sender' };
  }
  return { ok: true, hash: hashed.hash, nonce: BigInt(op.nonce) };
}

/**
 * The nonce key of an EntryPoint 2D nonce: the top 192 bits.
 *
 * viem gives every operation a fresh key (its `nonceKeyManager` draws one per operation),
 * so the check that matters is `EntryPoint.getNonce(sender, key) == nonce` for this
 * operation's own key, never key zero.
 */
export function nonceKeyOf(nonce: bigint): bigint {
  return nonce >> 64n;
}

/**
 * A smart account whose gas estimates carry a real signature instead of a placeholder.
 *
 * viem estimates gas with `getStubSignature()`, a fixed signature-shaped value that
 * recovers to nobody. The relayer tops up an account's deposit during the estimate,
 * because the bundler checks the prefund there first (see `/v1/bundler`), and it now
 * refuses to spend on anything it cannot tie to the sender's key. So the estimate has to
 * carry a real signature.
 *
 * `prepareUserOperation` calls `getStubSignature(request)` after it has filled in the call
 * data, factory, fees, nonce and authorization, and before any gas limit exists. It then
 * sends the estimate with every gas limit at zero. Signing `request` here therefore signs
 * exactly the fields the estimate carries. The relayer recomputes that hash and it
 * matches. `userOpSignature.test.ts` proves this by running viem's own
 * `prepareUserOperation`, not a re-implementation of it.
 *
 * A signature over zero gas limits cannot execute on chain. Validation with no
 * verification gas runs out of gas, and changing any limit changes the hash. It is
 * proof of the key and nothing more. The operation the user actually sends is signed
 * again, over its real limits, exactly as before.
 *
 * Signing costs no prompt: the owner signs from the in-memory session key (5 ms measured
 * for this account type on 2026-09-10).
 *
 * **The zero-limits guarantee is enforced here, not trusted from the caller.** If any of
 * the three gas limits arrives non-zero, this does not sign at all and returns viem's
 * placeholder, which funds nothing and executes nothing. An operation with real limits
 * must only ever be signed on purpose, by `signUserOperation`, never by the estimate path.
 */
export function withSignedEstimates<T extends SmartAccount>(account: T): T {
  return {
    ...account,
    async getStubSignature(userOperation?: Parameters<T['getStubSignature']>[0]) {
      if (!userOperation || !hasOnlyZeroGasLimits(userOperation)) {
        return account.getStubSignature();
      }
      return account.signUserOperation(userOperation as never);
    },
  } as T;
}

/**
 * True when none of the three gas limits is set to anything but zero.
 *
 * Absent counts as zero, because viem packs an absent limit as zero into the hash. Any
 * other value, including a non-bigint, counts as non-zero, so an unexpected shape fails
 * toward the placeholder rather than toward a signature.
 */
function hasOnlyZeroGasLimits(userOperation: unknown): boolean {
  const op = userOperation as Record<string, unknown>;
  return (['callGasLimit', 'verificationGasLimit', 'preVerificationGas'] as const).every(
    (field) => op[field] === undefined || op[field] === 0n,
  );
}
