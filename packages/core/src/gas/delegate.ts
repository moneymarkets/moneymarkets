import type { Address } from 'viem';

/**
 * The EIP-7702 gas layer's on-chain furniture.
 *
 * Every address here was confirmed deployed on Monad mainnet (chain 143) by
 * `eth_getCode` on 2026-09-02, and every claim below was measured rather than read
 * off a document.
 *
 * ## Why 7702 replaced the ERC-2771 forwarder
 *
 * The forwarder path was abandoned on evidence, not preference: KuruForwarder has no
 * recoverable request schema, no transaction has ever been sent to it, and Kuru's own
 * frontend does not use it — their application delegates via EIP-7702 (Calibur)
 * instead. See DECISIONS.md D25 and conflict C8.
 *
 * ## Why Simple7702Account
 *
 * Both candidates were instantiated against a live Monad client and compared:
 *
 * | | account address | EntryPoint | delegate | delegate size | dependency |
 * |---|---|---|---|---|---|
 * | `viem` `toSimple7702SmartAccount` | **== owner EOA** | v0.8 | `0xe6Cae83B…` | 3,639 bytes | viem only |
 * | `permissionless` `to7702KernelSmartAccount` | **== owner EOA** | v0.7 | `0xd6CEDDe8…` | 24,469 bytes | + `permissionless` |
 *
 * Both satisfy the requirement that the user's own EOA stays the on-chain sender.
 * Simple7702Account wins on three counts: it needs no dependency beyond viem, its
 * delegate is a seventh the size (this contract holds delegation over user accounts,
 * so its attack surface is the thing being minimised), and it targets EntryPoint
 * v0.8, which Pimlico's chain-143 bundler lists among its supported entry points.
 *
 * Calibur is what Kuru itself uses. It is deployed and viable, but it is driven
 * through Relay's SDK with its own `SignedBatchedCall` EIP-712 scheme rather than a
 * standard ERC-4337 UserOperation, so adopting it would mean hand-rolling the signing
 * and giving up bundler-agnosticism. Recorded, not used.
 */

/**
 * ERC-4337 EntryPoint v0.8. 21,738 bytes on chain 143, and one of the four entry
 * points Pimlico's bundler for this chain reports from `eth_supportedEntryPoints`.
 */
export const ENTRY_POINT_V08 = '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108' as Address;

/** EntryPoint v0.7, also deployed (16,035 bytes). Used by the Kernel variant. */
export const ENTRY_POINT_V07 = '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as Address;

/**
 * The delegate this project uses: the reference `Simple7702Account`, which is what
 * viem's `toSimple7702SmartAccount` authorizes. 3,639 bytes on chain 143.
 */
export const SIMPLE_7702_DELEGATE = '0xe6Cae83BdE06E4c305530e199D7217f42808555B' as Address;

/** Evaluated and not chosen. Kept so the comparison is reproducible. */
export const EVALUATED_DELEGATES = {
  kernel7702: '0xd6CEDDe84be40893d153Be9d467CD6aD37875b28' as Address,
  /** What Kuru's own frontend delegates to, via Relay's SDK. */
  calibur: '0x000000009B1D0aF20D8C6d0A44e162d11F9b8f00' as Address,
} as const;

/** Pimlico's bundler and paymaster for a chain. The key is server-side only. */
export function pimlicoUrl(chainId: number, apiKey: string): string {
  return `https://api.pimlico.io/v2/${chainId}/rpc?apikey=${apiKey}`;
}

/**
 * An EIP-7702 delegation indicator: `0xef0100 || delegate`. A delegated account's
 * `eth_getCode` returns exactly these 23 bytes.
 */
export const DELEGATION_PREFIX = '0xef0100';

export function delegationCodeFor(delegate: Address): `0x${string}` {
  return `${DELEGATION_PREFIX}${delegate.slice(2)}` as `0x${string}`;
}

/** Reads a delegation indicator back out of account code. */
export function delegateOf(code: string | undefined): Address | undefined {
  if (!code || !code.toLowerCase().startsWith(DELEGATION_PREFIX)) return undefined;
  if (code.length !== 2 + 46) return undefined;
  return `0x${code.slice(8)}` as Address;
}

/**
 * Monad's reserve rule, stated precisely because the framework overstates it.
 *
 * A transaction that would **reduce** a 7702-delegated EOA's balance below 10 MON
 * reverts unconditionally. A transaction that leaves the balance unchanged or higher
 * succeeds even when the balance is already below 10 MON — including at zero.
 *
 * This is why sponsored accounts work here. The bundler pays gas, and every flow in
 * this app moves AUSD rather than MON, so a user's delegated EOA never has its MON
 * balance reduced and can sit at zero forever. The "never holds MON" promise
 * survives delegation.
 *
 * The one case that still needs care is a native-MON transfer out of a delegated
 * account, which this app does not do.
 */
export const MONAD_DELEGATED_RESERVE_WEI = 10n * 10n ** 18n;

/**
 * True when a call would reduce a delegated account's balance below the reserve, and
 * therefore revert on Monad regardless of who pays gas.
 */
export function violatesDelegatedReserve(balanceWei: bigint, spendWei: bigint): boolean {
  if (spendWei === 0n) return false;
  return balanceWei - spendWei < MONAD_DELEGATED_RESERVE_WEI && spendWei > 0n;
}
