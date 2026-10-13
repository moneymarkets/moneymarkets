import type { Address, Hex } from 'viem';

/**
 * KuruForwarder — what is known, and what is not.
 *
 * ## Verified on chain (2026-09-02, Monad mainnet, chain 143)
 *
 * The proxy at `0x974E61BBa9C4704E8Bcc1923fdC3527B41323FAA` is an ERC-1967 proxy
 * (implementation slot `0x360894…382bbc`) pointing at
 * `0xbf6Cc109c6eBcA4B28e3e51FD8798294599CFe2A`.
 *
 * `eip712Domain()` (ERC-5267) returns, decoded from the raw call:
 *   fields            0x0f  (name, version, chainId, verifyingContract; no salt)
 *   name              "KuruForwarder"
 *   version           "1.0.0"
 *   chainId           143
 *   verifyingContract 0x974e61bba9c4704e8bcc1923fdc3527b41323faa
 *   salt              0x00…00
 *   extensions        []
 *
 * `getNonce(address)` (selector 0x2d0335ab) exists and returns 0 for a fresh
 * address. `nonces(address)` (0x7ecebe00) and `DOMAIN_SEPARATOR()` (0x3644e515)
 * both revert — so this is **not** OpenZeppelin's `ERC2771Forwarder` v5 shape, and
 * the `nonce` accessor is the older `getNonce` one.
 *
 * Both Kuru contracts trust it, read live:
 *   OrderBook(MON/USDC).isTrustedForwarder(0x974E…) -> true
 *   MarginAccount.isTrustedForwarder(0x974E…)       -> true
 *   Router.TRUSTED_FORWARDER()                      -> 0x974e61bb…23faa
 *
 * The deployed implementation is Solady-based (`Ownable` with ownership handover,
 * UUPS, `Initialized(uint64)`), and its dispatcher carries these selectors that no
 * public source, 4byte entry, Sourcify record or Kuru package accounts for:
 *
 *   0x10012a15 0x16912671 0x1a4e971f 0x1fbe2e4f 0x3bcb61ef 0x487ed96e 0x5b31c2e6
 *   0x6b446f49 0x6cce95f0 0x6e084905 0x950b2e51 0xdf477d50 0xe6bc6b56
 *
 * One of those is `execute`. Its argument types were searched exhaustively over
 * every plausible forwarder struct (2 addresses, 2–4 unsigned fields of seven widths,
 * a `bytes` payload, with and without a trailing signature, under twelve function
 * names) — 1.2 million candidate signatures — with no match. The EIP-712 struct hash
 * was searched the same way against the four unidentified `PUSH32` constants in the
 * runtime — 2.5 million candidate type strings — also with no match. The struct is
 * therefore something this repo has not seen, and guessing it is forbidden by rule
 * A2.5.
 *
 * ## What is NOT known
 *
 * The `ForwardRequest` field list, its EIP-712 type string, and the `execute`
 * signature. Everything in this file below `KURU_FORWARDER_DOMAIN` is an interface
 * definition, not a fact.
 *
 * ## How to close it
 *
 * Any one of these ends the ambiguity in minutes:
 *   1. A MonadScan (Etherscan V2, chainid 143) API key -> `getsourcecode` for
 *      `0xbf6Cc109c6eBcA4B28e3e51FD8798294599CFe2A`, or `txlist` for the proxy to
 *      recover a real `execute` calldata. The free key is the cheapest path.
 *   2. Kuru sharing the forwarder ABI or verified source.
 *   3. Any historical `execute` transaction hash. A 400,000-block scan of recent
 *      mainnet blocks found no transaction sent to the proxy, so the forwarder is
 *      not currently carrying Kuru's own traffic.
 *
 * See DECISIONS.md open item 1 and `reports/2026-09-02.md`.
 */

export const KURU_FORWARDER_ADDRESS = '0x974E61BBa9C4704E8Bcc1923fdC3527B41323FAA' as Address;

export const KURU_FORWARDER_IMPLEMENTATION =
  '0xbf6Cc109c6eBcA4B28e3e51FD8798294599CFe2A' as Address;

/** Read from `eip712Domain()`. These four values are facts. */
export const KURU_FORWARDER_DOMAIN = {
  name: 'KuruForwarder',
  version: '1.0.0',
  chainId: 143,
  verifyingContract: KURU_FORWARDER_ADDRESS,
} as const;

/** Verified: this selector is in the deployed dispatcher and returns a uint256. */
export const GET_NONCE_SELECTOR = '0x2d0335ab' as Hex;

/**
 * The request this repo will sign, expressed as the interface the rest of the code
 * programs against.
 *
 * UNVERIFIED: the on-chain struct may order, name, or size these fields differently,
 * and may not have a `deadline` at all. Nothing may sign one of these against the
 * real forwarder until open item 1 is closed.
 */
export interface ForwardRequest {
  readonly from: Address;
  readonly to: Address;
  readonly value: bigint;
  readonly gas: bigint;
  readonly nonce: bigint;
  readonly deadline: bigint;
  readonly data: Hex;
}

export interface SignedForwardRequest {
  readonly request: ForwardRequest;
  readonly signature: Hex;
}

/**
 * The EIP-712 types this repo would use if the forwarder matched the common
 * OpenZeppelin-derived shape.
 *
 * UNVERIFIED: brute-force search did not match this type string's hash against any
 * constant in the deployed bytecode, which is evidence *against* it. It exists so
 * the signing path, the relayer's validation and the tests are all written and
 * reviewable now; the moment the real type string is known, only this constant
 * changes.
 */
// UNVERIFIED: KuruForwarder ForwardRequest EIP-712 type string (open item 1)
export const FORWARD_REQUEST_TYPES = {
  ForwardRequest: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'gas', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'data', type: 'bytes' },
  ],
} as const;

/**
 * Guard for every path that would put a real signature in front of the real
 * forwarder. Flip to `true` only in the commit that lands the verified struct.
 */
export const FORWARD_REQUEST_SCHEMA_VERIFIED = false;

export class ForwarderSchemaUnverifiedError extends Error {
  constructor(what: string) {
    super(
      `${what} needs the KuruForwarder ForwardRequest schema, which is still ` +
        'unverified (DECISIONS.md open item 1). Signing a guessed struct produces a ' +
        'signature the forwarder will reject, and could produce one it accepts for ' +
        'the wrong call. Close item 1 first.',
    );
    this.name = 'ForwarderSchemaUnverifiedError';
  }
}

export function assertForwarderSchemaVerified(what: string): void {
  if (!FORWARD_REQUEST_SCHEMA_VERIFIED) throw new ForwarderSchemaUnverifiedError(what);
}
