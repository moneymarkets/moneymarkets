import { z } from 'zod';
import { isAddress, type Address, type Hex } from 'viem';
import {
  isForwardableSelector,
  isSignedBySender,
  MAX_PERMIT_DEADLINE_SECONDS,
  selectorOf,
  type ForwardRequest,
} from '@tradepro/core';
import type { TargetAllowlist } from './allowlist.js';

/**
 * Request validation — spec §5.3 and rule A4, in order, fail-closed.
 *
 * Every check runs before a single wei of gas is spent, and each one returns a code
 * the API turns into a 4xx. The order matters: the cheap structural checks come
 * first so a malformed flood costs no RPC calls.
 */

export const REJECTION_CODES = [
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'TARGET_NOT_ALLOWED',
  'SELECTOR_NOT_ALLOWED',
  'VALUE_NOT_ZERO',
  'GAS_TOO_HIGH',
  'DEADLINE_INVALID',
  'DEADLINE_TOO_FAR',
  'SIGNATURE_INVALID',
  'NONCE_MISMATCH',
  'RATE_LIMITED',
  'FLOAT_TOO_LOW',
  'SIMULATION_REVERTED',
  'SPENDER_NOT_MARGIN_ACCOUNT',
  'PERMIT_AMOUNT_INVALID',
  'FORWARDER_SCHEMA_UNVERIFIED',
  'CAP_EXCEEDED',
  // A payment to the relayer that is not the exact fee leg it computed (2026-09-24).
  'FEE_LEG_MISMATCH',
] as const;

export type RejectionCode = (typeof REJECTION_CODES)[number];

export class Rejection extends Error {
  constructor(
    readonly code: RejectionCode,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'Rejection';
  }
}

const hexString = z.string().regex(/^0x[0-9a-fA-F]*$/, 'expected 0x-prefixed hex');
const addressString = z.string().refine(isAddress, 'expected a 20-byte address');
const bigintString = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]);

export const forwardRequestSchema = z.object({
  from: addressString,
  to: addressString,
  value: bigintString,
  gas: bigintString,
  nonce: bigintString,
  deadline: bigintString,
  data: hexString,
});

export const forwardBodySchema = z.object({
  request: forwardRequestSchema,
  signature: hexString.regex(/^0x[0-9a-fA-F]{130}$/, 'expected a 65-byte signature'),
  purpose: z.enum(['order', 'cancel', 'deposit', 'withdraw']),
});

export const permitBodySchema = z.object({
  token: addressString,
  owner: addressString,
  spender: addressString,
  value: bigintString,
  deadline: bigintString,
  v: z.number().int().min(0).max(255),
  r: hexString.regex(/^0x[0-9a-fA-F]{64}$/),
  s: hexString.regex(/^0x[0-9a-fA-F]{64}$/),
});

/** A batch of calls to be sponsored as one user operation. */
export const sponsorBodySchema = z.object({
  sender: addressString,
  calls: z
    .array(z.object({ to: addressString, data: hexString }))
    .min(1)
    .max(8),
  purpose: z.enum(['order', 'cancel', 'deposit', 'withdraw']).optional(),
});

export const bundleBodySchema = z.object({
  permit: permitBodySchema.optional(),
  forward: forwardBodySchema,
});

export function toForwardRequest(raw: z.infer<typeof forwardRequestSchema>): ForwardRequest {
  return {
    from: raw.from as Address,
    to: raw.to as Address,
    value: BigInt(raw.value),
    gas: BigInt(raw.gas),
    nonce: BigInt(raw.nonce),
    deadline: BigInt(raw.deadline),
    data: raw.data as Hex,
  };
}

export interface ValidationContext {
  readonly allowlist: TargetAllowlist;
  readonly maxGas: bigint;
  readonly maxDeadlineSeconds: number;
  /** Injected so tests are deterministic. */
  readonly now?: () => number;
  /** `forwarder.getNonce(from)`. Omitted skips the nonce check (structural tests). */
  readonly readNonce?: (from: Address) => Promise<bigint>;
  readonly verifySignature?: (request: ForwardRequest, signature: Hex) => Promise<boolean>;
}

/**
 * The structural half: everything checkable without touching the network. Runs first
 * so a spam flood is rejected before it costs an RPC call.
 */
export function validateForwardStructure(
  request: ForwardRequest,
  context: ValidationContext,
): void {
  const entry = context.allowlist.get(request.to);
  if (!entry) {
    throw new Rejection(
      'TARGET_NOT_ALLOWED',
      `${request.to} is not a Kuru contract this relayer forwards to`,
    );
  }
  if (!entry.trustsForwarder) {
    throw new Rejection(
      'TARGET_NOT_ALLOWED',
      `${request.to} does not trust the forwarder on chain; a forwarded call there ` +
        'would execute with the wrong sender',
    );
  }

  if (request.data.length < 10) {
    throw new Rejection('BAD_REQUEST', 'calldata is too short to carry a selector');
  }
  if (!isForwardableSelector(request.data)) {
    throw new Rejection(
      'SELECTOR_NOT_ALLOWED',
      `selector ${selectorOf(request.data)} is not one this relayer forwards`,
    );
  }

  if (request.value !== 0n) {
    throw new Rejection('VALUE_NOT_ZERO', 'the relayer never forwards native MON');
  }

  if (request.gas <= 0n || request.gas > context.maxGas) {
    throw new Rejection('GAS_TOO_HIGH', `gas must be 1..${context.maxGas}`);
  }

  const nowSeconds = Math.floor((context.now?.() ?? Date.now()) / 1000);
  if (request.deadline <= BigInt(nowSeconds)) {
    throw new Rejection('DEADLINE_INVALID', 'this request has already expired');
  }
  if (request.deadline - BigInt(nowSeconds) > BigInt(context.maxDeadlineSeconds)) {
    throw new Rejection(
      'DEADLINE_TOO_FAR',
      `deadline may not be more than ${context.maxDeadlineSeconds}s in the future`,
    );
  }
}

/** The half that needs the chain: signature recovery and the forwarder's nonce. */
export async function validateForwardSignature(
  request: ForwardRequest,
  signature: Hex,
  context: ValidationContext,
): Promise<void> {
  const verify = context.verifySignature ?? isSignedBySender;
  if (!(await verify(request, signature))) {
    throw new Rejection(
      'SIGNATURE_INVALID',
      'the signature does not recover to the request sender',
      401,
    );
  }

  if (context.readNonce) {
    const expected = await context.readNonce(request.from);
    if (expected !== request.nonce) {
      throw new Rejection(
        'NONCE_MISMATCH',
        `forwarder expects nonce ${expected} for ${request.from}, request carries ${request.nonce}`,
        409,
      );
    }
  }
}

export interface PermitValidationContext {
  readonly marginAccount: Address;
  readonly now?: () => number;
}

/**
 * Permits are the sharpest edge in the system: a signature that lets someone else
 * move a user's tokens. Exact amount, MarginAccount only, ten-minute ceiling.
 */
export function validatePermit(
  permit: z.infer<typeof permitBodySchema>,
  context: PermitValidationContext,
): void {
  if (permit.spender.toLowerCase() !== context.marginAccount.toLowerCase()) {
    throw new Rejection(
      'SPENDER_NOT_MARGIN_ACCOUNT',
      `permit spender must be the MarginAccount (${context.marginAccount})`,
    );
  }
  const value = BigInt(permit.value);
  if (value <= 0n) {
    throw new Rejection('PERMIT_AMOUNT_INVALID', 'permit amount must be positive');
  }
  if (value === 2n ** 256n - 1n) {
    throw new Rejection(
      'PERMIT_AMOUNT_INVALID',
      'infinite approvals are not relayed; sign the exact amount',
    );
  }
  const nowSeconds = Math.floor((context.now?.() ?? Date.now()) / 1000);
  const deadline = BigInt(permit.deadline);
  if (deadline <= BigInt(nowSeconds)) {
    throw new Rejection('DEADLINE_INVALID', 'this permit has already expired');
  }
  if (deadline - BigInt(nowSeconds) > BigInt(MAX_PERMIT_DEADLINE_SECONDS)) {
    throw new Rejection(
      'DEADLINE_TOO_FAR',
      `permit deadline may not be more than ${MAX_PERMIT_DEADLINE_SECONDS}s in the future`,
    );
  }
}
