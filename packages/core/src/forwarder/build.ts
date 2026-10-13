import {
  hashTypedData,
  recoverTypedDataAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import {
  assertForwarderSchemaVerified,
  FORWARD_REQUEST_TYPES,
  GET_NONCE_SELECTOR,
  KURU_FORWARDER_DOMAIN,
  type ForwardRequest,
} from './types.js';

/**
 * Building, hashing and verifying ForwardRequests.
 *
 * Every function that would produce or accept a *real* signature calls
 * `assertForwarderSchemaVerified` first, so the unverified struct in `types.ts`
 * cannot leak into a signature by accident. The pure hashing helpers below take an
 * explicit domain and types so they stay testable against a known-good vector the
 * day the real schema arrives.
 */

export const DEFAULT_DEADLINE_SECONDS = 120;
export const MAX_RELAYABLE_GAS = 2_000_000n;

export interface ForwarderDomain {
  readonly name: string;
  readonly version: string;
  readonly chainId: number;
  readonly verifyingContract: Address;
}

/** Read the signer's next nonce. `getNonce(address)` is verified to exist. */
export async function readForwarderNonce(
  client: PublicClient,
  forwarder: Address,
  from: Address,
): Promise<bigint> {
  const result = await client.call({
    to: forwarder,
    data: `${GET_NONCE_SELECTOR}${from.slice(2).toLowerCase().padStart(64, '0')}` as Hex,
  });
  if (!result.data || result.data === '0x') {
    throw new Error(`getNonce(${from}) on ${forwarder} returned no data`);
  }
  return BigInt(result.data);
}

export interface BuildRequestInput {
  readonly from: Address;
  readonly to: Address;
  readonly data: Hex;
  readonly nonce: bigint;
  readonly gas: bigint;
  readonly value?: bigint;
  readonly deadlineSeconds?: number;
  readonly now?: number;
}

/**
 * Assemble a request. `value` is always zero: the relayer forwards calls, it does
 * not move native MON on a user's behalf (spec §5.3).
 */
export function buildForwardRequest(input: BuildRequestInput): ForwardRequest {
  const value = input.value ?? 0n;
  if (value !== 0n) {
    throw new Error('ForwardRequest.value must be 0; the relayer never forwards MON');
  }
  if (input.gas <= 0n || input.gas > MAX_RELAYABLE_GAS) {
    throw new Error(`gas ${input.gas} is outside 1..${MAX_RELAYABLE_GAS}`);
  }
  if (input.nonce < 0n) throw new Error('nonce must not be negative');

  const nowSeconds = Math.floor((input.now ?? Date.now()) / 1000);
  const deadline = BigInt(nowSeconds + (input.deadlineSeconds ?? DEFAULT_DEADLINE_SECONDS));

  return {
    from: input.from,
    to: input.to,
    value,
    gas: input.gas,
    nonce: input.nonce,
    deadline,
    data: input.data,
  };
}

/** Add 20% headroom to an estimate, capped, so a tight estimate does not revert. */
export function gasWithHeadroom(estimate: bigint, cap = MAX_RELAYABLE_GAS): bigint {
  const padded = (estimate * 120n) / 100n;
  return padded > cap ? cap : padded;
}

/**
 * The EIP-712 digest a user signs. Pure — the domain and types are arguments, so a
 * test can pin a known-good vector without touching module state.
 */
export function hashForwardRequestWith(
  request: ForwardRequest,
  domain: ForwarderDomain,
  types: typeof FORWARD_REQUEST_TYPES,
): Hex {
  return hashTypedData({
    domain,
    types,
    primaryType: 'ForwardRequest',
    message: {
      from: request.from,
      to: request.to,
      value: request.value,
      gas: request.gas,
      nonce: request.nonce,
      deadline: request.deadline,
      data: request.data,
    },
  });
}

/** The digest against the live forwarder. Gated on the schema being verified. */
export function hashForwardRequest(request: ForwardRequest): Hex {
  assertForwarderSchemaVerified('hashing a ForwardRequest for the live forwarder');
  return hashForwardRequestWith(request, KURU_FORWARDER_DOMAIN, FORWARD_REQUEST_TYPES);
}

/**
 * `request.from == ecrecover(signature)` (spec §5.3). The relayer runs this before
 * it will spend a wei of gas.
 */
export async function recoverForwardRequestSigner(
  request: ForwardRequest,
  signature: Hex,
  domain: ForwarderDomain = KURU_FORWARDER_DOMAIN,
  types: typeof FORWARD_REQUEST_TYPES = FORWARD_REQUEST_TYPES,
): Promise<Address> {
  return recoverTypedDataAddress({
    domain,
    types,
    primaryType: 'ForwardRequest',
    message: {
      from: request.from,
      to: request.to,
      value: request.value,
      gas: request.gas,
      nonce: request.nonce,
      deadline: request.deadline,
      data: request.data,
    },
    signature,
  });
}

export async function isSignedBySender(
  request: ForwardRequest,
  signature: Hex,
  domain?: ForwarderDomain,
): Promise<boolean> {
  try {
    const recovered = await recoverForwardRequestSigner(request, signature, domain);
    return recovered.toLowerCase() === request.from.toLowerCase();
  } catch {
    return false;
  }
}
