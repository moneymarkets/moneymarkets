import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
  recoverTypedDataAddress,
  stringToHex,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { KURU_FLOW_ROUTER } from '../kuru/flow.js';

/**
 * ERC-2612 permits.
 *
 * A permit is the only signature in this app that lets anyone else move a user's
 * tokens, so the rules around it are tight (rule A4): exact amount; deadline at most
 * ten minutes; spender is the MarginAccount **or** the pinned Kuru Flow router
 * (D101) — never a caller-supplied address, and nothing else. The router is only
 * safe as a second spender because it is a code constant, the same one
 * `gas/policy.ts`'s `PINNED_PERMIT_SPENDERS` pins server-side, and the relayer
 * refuses to sponsor a router permit that is not immediately followed by the swap
 * it pays for.
 *
 * ## Domains, read from Monad mainnet on 2026-09-02
 *
 * | token  | address     | permit | domain name    | version | how known        |
 * |--------|-------------|--------|----------------|---------|------------------|
 * | AUSD   | 0x00000000… | yes    | "Agora Dollar" | "1"     | `eip712Domain()` |
 * | USDC   | 0x754704Bc… | yes    | "USDC"         | "2"     | solved against `DOMAIN_SEPARATOR()` |
 * | USDT0  | 0xe7cd86e1… | yes    | "USDT0"        | "1"     | solved against `DOMAIN_SEPARATOR()` |
 *
 * USDC and USDT0 do **not** implement ERC-5267 `eip712Domain()` — it reverts — so
 * their name and version were recovered by reconstructing the 4-field
 * `EIP712Domain` hash and matching it byte-for-byte against the `DOMAIN_SEPARATOR()`
 * the contract returns. `verifyPermitDomain` below is that same check, and every
 * hardcoded domain is expected to pass it against the live chain.
 *
 * This closes DECISIONS.md open item 4: Monad USDC supports `permit`, so the Aurora
 * Path-B top-up can be gasless and funding does not have to be steered to AUSD OFT.
 *
 * Testnet AUSD (`0xa9012a05…`) reports the same domain with chainId 10143. Kuru's
 * testnet USDC (`0xee0722ea…`) has no `DOMAIN_SEPARATOR()`, no `nonces()` and no
 * `decimals()` — it is a mock, not an ERC-2612 token.
 */

export const MAX_PERMIT_DEADLINE_SECONDS = 600;

export const PERMIT_TYPES = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

export const EIP712_DOMAIN_TYPEHASH = keccak256(
  stringToHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
);

export interface PermitDomain {
  readonly name: string;
  readonly version: string;
  readonly chainId: number;
  readonly verifyingContract: Address;
}

/** Domains confirmed against the live `DOMAIN_SEPARATOR()` on chain 143. */
export const KNOWN_PERMIT_DOMAINS: Record<string, { name: string; version: string }> = {
  '0x00000000efe302beaa2b3e6e1b18d08d69a9012a': { name: 'Agora Dollar', version: '1' },
  '0x754704bc059f8c67012fed69bc8a327a5aafb603': { name: 'USDC', version: '2' },
  '0xe7cd86e13ac4309349f30b3435a9d337750fc82d': { name: 'USDT0', version: '1' },
  // Testnet AUSD, from its own eip712Domain().
  '0xa9012a055bd4e0edff8ce09f960291c09d5322dc': { name: 'Agora Dollar', version: '1' },
};

const permitAbi = parseAbi([
  'function nonces(address owner) view returns (uint256)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
]);

export function domainSeparatorOf(domain: PermitDomain): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' },
      ],
      [
        EIP712_DOMAIN_TYPEHASH,
        keccak256(stringToHex(domain.name)),
        keccak256(stringToHex(domain.version)),
        BigInt(domain.chainId),
        domain.verifyingContract,
      ],
    ),
  );
}

/**
 * Resolve a token's permit domain and prove it: the reconstructed separator must
 * equal the one the contract returns. A mismatch throws rather than producing a
 * signature the token will silently reject.
 */
export async function resolvePermitDomain(
  client: PublicClient,
  token: Address,
  chainId: number,
): Promise<PermitDomain> {
  const onChain = await client.readContract({
    address: token,
    abi: permitAbi,
    functionName: 'DOMAIN_SEPARATOR',
  });

  const known = KNOWN_PERMIT_DOMAINS[token.toLowerCase()];
  if (known) {
    const candidate: PermitDomain = { ...known, chainId, verifyingContract: token };
    if (domainSeparatorOf(candidate) === onChain) return candidate;
    throw new Error(
      `permit domain for ${token} no longer matches DOMAIN_SEPARATOR(). ` +
        `Expected ${domainSeparatorOf(candidate)}, chain says ${onChain}. ` +
        'The token was upgraded or the chain id is wrong; do not sign.',
    );
  }

  throw new Error(
    `no known EIP-712 domain for token ${token}. Read it from eip712Domain() or ` +
      'recover it against DOMAIN_SEPARATOR() before signing a permit.',
  );
}

export async function verifyPermitDomain(
  client: PublicClient,
  domain: PermitDomain,
): Promise<boolean> {
  const onChain = await client.readContract({
    address: domain.verifyingContract,
    abi: permitAbi,
    functionName: 'DOMAIN_SEPARATOR',
  });
  return domainSeparatorOf(domain) === onChain;
}

export async function readPermitNonce(
  client: PublicClient,
  token: Address,
  owner: Address,
): Promise<bigint> {
  return client.readContract({
    address: token,
    abi: permitAbi,
    functionName: 'nonces',
    args: [owner],
  });
}

export interface PermitMessage {
  readonly owner: Address;
  readonly spender: Address;
  readonly value: bigint;
  readonly nonce: bigint;
  readonly deadline: bigint;
}

export interface BuildPermitInput {
  readonly owner: Address;
  /** Must be the MarginAccount or the pinned Kuru Flow router. Anything else is rejected. */
  readonly spender: Address;
  readonly marginAccount: Address;
  /** Exact amount. Infinite approvals are not built here. */
  readonly value: bigint;
  readonly nonce: bigint;
  readonly deadlineSeconds?: number;
  readonly now?: number;
}

export function buildPermitMessage(input: BuildPermitInput): PermitMessage {
  const allowedSpenders = [input.marginAccount.toLowerCase(), KURU_FLOW_ROUTER.toLowerCase()];
  if (!allowedSpenders.includes(input.spender.toLowerCase())) {
    throw new Error(
      `permit spender must be the MarginAccount (${input.marginAccount}) or the Kuru Flow ` +
        `router (${KURU_FLOW_ROUTER}), got ${input.spender}`,
    );
  }
  if (input.value <= 0n) throw new Error('permit value must be positive');
  if (input.value === 2n ** 256n - 1n) {
    throw new Error('permit value must be the exact amount, never an infinite approval');
  }
  const seconds = input.deadlineSeconds ?? MAX_PERMIT_DEADLINE_SECONDS;
  if (seconds <= 0 || seconds > MAX_PERMIT_DEADLINE_SECONDS) {
    throw new Error(`permit deadline must be 1..${MAX_PERMIT_DEADLINE_SECONDS} seconds`);
  }
  const nowSeconds = Math.floor((input.now ?? Date.now()) / 1000);
  return {
    owner: input.owner,
    spender: input.spender,
    value: input.value,
    nonce: input.nonce,
    deadline: BigInt(nowSeconds + seconds),
  };
}

export function permitTypedData(message: PermitMessage, domain: PermitDomain) {
  return {
    domain,
    types: PERMIT_TYPES,
    primaryType: 'Permit' as const,
    message: {
      owner: message.owner,
      spender: message.spender,
      value: message.value,
      nonce: message.nonce,
      deadline: message.deadline,
    },
  };
}

export async function recoverPermitSigner(
  message: PermitMessage,
  domain: PermitDomain,
  signature: Hex,
): Promise<Address> {
  return recoverTypedDataAddress({ ...permitTypedData(message, domain), signature });
}

export interface PermitSignature {
  readonly v: number;
  readonly r: Hex;
  readonly s: Hex;
}

/** Split a 65-byte signature the way `permit(...)` wants it. */
export function splitSignature(signature: Hex): PermitSignature {
  const body = signature.slice(2);
  if (body.length !== 130) throw new Error(`expected a 65-byte signature, got ${body.length / 2}`);
  const r = `0x${body.slice(0, 64)}` as Hex;
  const s = `0x${body.slice(64, 128)}` as Hex;
  let v = parseInt(body.slice(128, 130), 16);
  if (v < 27) v += 27;
  return { v, r, s };
}

export function buildPermitCall(
  token: Address,
  message: PermitMessage,
  signature: Hex,
): { to: Address; data: Hex } {
  const { v, r, s } = splitSignature(signature);
  return {
    to: token,
    data: encodeFunctionData({
      abi: permitAbi,
      functionName: 'permit',
      args: [message.owner, message.spender, message.value, message.deadline, v, r, s],
    }),
  };
}
