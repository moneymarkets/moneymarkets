import { toSimple7702SmartAccount, type SmartAccount } from 'viem/account-abstraction';
import type { Address, Hex, PublicClient } from 'viem';
import { delegateOf, SIMPLE_7702_DELEGATE } from './delegate.js';

/**
 * A user's account under the EIP-7702 gas layer.
 *
 * The whole point of choosing 7702 over a smart-contract wallet is that there is no
 * second address: the smart account **is** the user's EOA. Kuru's OrderBook records
 * `OrderCreated.owner` as that EOA, `Trade.makerAddress` as that EOA, and
 * `MarginAccount` credits that EOA — with no ERC-2771 calldata suffix anywhere.
 *
 * Verified on Monad mainnet, 2026-09-02, by simulating the full sponsored path with
 * the account's code overridden to a real delegation indicator:
 *
 *   eth_call({ from: EntryPointV08, to: EOA, data: account.encodeCalls([deposit]) })
 *   stateOverride: EOA.code = 0xef0100||Simple7702Account,
 *                  AUSD.code = a token accepting transferFrom only from <X>
 *
 *   X = EOA         -> SUCCEEDS
 *   X = EntryPoint  -> reverts
 *   X = delegate    -> reverts
 *
 * So through a sponsored userOp the callee still sees the user's own address.
 */

export interface GaslessAccount {
  /** The user's EOA. Also the smart account address, and the on-chain sender. */
  readonly address: Address;
  /** viem smart account, for building and signing user operations. */
  readonly account: SmartAccount;
  /** The delegate this account authorizes. */
  readonly delegate: Address;
}

/**
 * The owner a 7702 smart account needs.
 *
 * Narrower than viem's `LocalAccount`, which makes `sign` and `signAuthorization`
 * optional. A 7702 account requires both — the authorization is the whole mechanism —
 * so the requirement belongs in the type rather than in a runtime surprise. Mera's
 * `toViemAccount` satisfies it.
 */
export type SevenSevenZeroTwoOwner = Parameters<typeof toSimple7702SmartAccount>[0]['owner'];

/**
 * Wrap a signer — in production a Mera passkey account — as a 7702 smart account.
 *
 * The owner must be able to sign an EIP-7702 authorization. Mera's `toViemAccount`
 * implements `signAuthorization` alongside `signTypedData`, both through
 * `session.signDigest`, so neither shows a passkey prompt after the session exists.
 */
export async function toGaslessAccount(
  client: PublicClient,
  owner: SevenSevenZeroTwoOwner,
): Promise<GaslessAccount> {
  const account = await toSimple7702SmartAccount({ client: client as never, owner });
  if (account.address.toLowerCase() !== owner.address.toLowerCase()) {
    // Would mean viem changed the account model underneath us; the whole design
    // depends on these being the same address.
    throw new Error(
      `7702 smart account address ${account.address} is not the owner EOA ` +
        `${owner.address}. The gas layer assumes they are identical.`,
    );
  }
  return { address: account.address, account, delegate: SIMPLE_7702_DELEGATE };
}

export interface DelegationStatus {
  readonly delegated: boolean;
  /** The delegate currently authorized, if any. */
  readonly delegate?: Address;
  /** True when delegated to something other than the delegate this app uses. */
  readonly foreign: boolean;
}

/** Read whether an account is already delegated, and to what. */
export async function readDelegation(
  client: PublicClient,
  address: Address,
  expected: Address = SIMPLE_7702_DELEGATE,
): Promise<DelegationStatus> {
  const code = await client.getCode({ address });
  const delegate = delegateOf(code);
  if (!delegate) return { delegated: false, foreign: false };
  return {
    delegated: true,
    delegate,
    foreign: delegate.toLowerCase() !== expected.toLowerCase(),
  };
}

/**
 * Whether the next user operation has to carry an authorization.
 *
 * The authorization is signed once per account. After it lands, the account's code is
 * the delegation indicator and later operations need nothing extra.
 */
export async function needsAuthorization(client: PublicClient, address: Address): Promise<boolean> {
  const status = await readDelegation(client, address);
  return !status.delegated || status.foreign;
}

/**
 * A user operation's calls, as this app builds them.
 * Every entry must survive the sponsorship policy before it reaches a bundler.
 */
export interface SponsoredCall {
  readonly to: Address;
  readonly data: Hex;
  /** Non-zero for a WMON wrap, a native-MON send, or a native-MON margin deposit
   *  (D200) — zero for everything else, which is still almost every call. */
  readonly value?: bigint;
}
