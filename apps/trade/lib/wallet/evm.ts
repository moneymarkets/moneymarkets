'use client';

import { addChainParams, toHexChainId } from '@tradepro/core';

/**
 * The source-chain EVM signer: whichever wallet the user already has.
 *
 * ## The passkey account is never the source signer
 *
 * This app's account is a passkey-derived key that lives in memory on Monad. It has no
 * balance on Base, no balance on Arbitrum, and asking it to sign a SpokePool deposit on
 * a chain where it holds nothing would produce a transaction that reverts on gas before
 * it did anything else. Money comes *from* somewhere the user already keeps it, and that
 * somewhere has its own wallet. So this file connects a **second, separate** signer, and
 * every screen that uses it shows both addresses side by side — the one that signs on
 * the source chain, and the one the money is being delivered to.
 *
 * Nothing here can change the destination. The recipient is fixed server-side and every
 * rail asserts it (R4).
 *
 * ## Discovery is EIP-6963, with `window.ethereum` as the fallback
 *
 * EIP-6963 exists because `window.ethereum` is a single slot that several extensions
 * fight over: with two wallets installed, the one that wins is whichever loaded last,
 * and the user has no say. Announcing providers over an event lets the user pick. A
 * wallet too old to announce still lands in the fallback, so nobody is locked out.
 *
 * ## No dependency
 *
 * viem is already here and speaks EIP-1193 through `custom()`. WalletConnect is the one
 * connector that needs a package, and it is behind `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`
 * — see `walletconnect.ts` for why an unset id means injected-only rather than a button
 * that fails when pressed.
 */

/** The EIP-1193 surface this app actually uses. Nothing wider is assumed. */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
}

export interface WalletChoice {
  /** EIP-6963 `rdns`, or `injected` for the fallback slot. Stable per wallet. */
  readonly id: string;
  readonly name: string;
  readonly icon?: string;
  readonly provider: Eip1193Provider;
}

interface Eip6963Detail {
  info?: { uuid?: string; name?: string; icon?: string; rdns?: string };
  provider?: Eip1193Provider;
}

/**
 * Every wallet that answers, plus the legacy slot if it is not already one of them.
 *
 * EIP-6963 is request/announce: providers listen for `eip6963:requestProvider` and each
 * replies with its own `eip6963:announceProvider`. They answer synchronously in
 * practice, but a short window is given rather than assuming that, and the legacy
 * `window.ethereum` is added only when no announcer claimed it — otherwise a single
 * MetaMask appears twice.
 */
export async function discoverWallets(waitMs = 120): Promise<WalletChoice[]> {
  if (typeof window === 'undefined') return [];
  const found = new Map<string, WalletChoice>();

  const onAnnounce = (event: Event) => {
    const detail = (event as CustomEvent<Eip6963Detail>).detail;
    const info = detail?.info;
    const provider = detail?.provider;
    if (!info?.rdns || !provider) return;
    found.set(info.rdns, {
      id: info.rdns,
      name: info.name ?? info.rdns,
      ...(info.icon ? { icon: info.icon } : {}),
      provider,
    });
  };

  window.addEventListener('eip6963:announceProvider', onAnnounce);
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  await new Promise((resolve) => window.setTimeout(resolve, waitMs));
  window.removeEventListener('eip6963:announceProvider', onAnnounce);

  const legacy = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
  if (legacy && ![...found.values()].some((w) => w.provider === legacy)) {
    found.set('injected', { id: 'injected', name: 'Browser wallet', provider: legacy });
  }
  return [...found.values()];
}

export interface ConnectedEvmWallet {
  readonly id: string;
  readonly name: string;
  readonly address: `0x${string}`;
  readonly chainId: number;
  readonly provider: Eip1193Provider;
}

/**
 * Ask a wallet for an account.
 *
 * `eth_requestAccounts` is the prompt; `eth_accounts` alone returns nothing until the
 * user has approved this origin once. A rejected prompt throws with EIP-1193 code 4001,
 * which callers surface as "you cancelled it" rather than as a failure.
 */
export async function connectWallet(choice: WalletChoice): Promise<ConnectedEvmWallet> {
  const accounts = (await choice.provider.request({ method: 'eth_requestAccounts' })) as string[];
  const address = accounts?.[0];
  if (!address) throw new Error('That wallet returned no account.');
  const chainId = await currentChainId(choice.provider);
  return {
    id: choice.id,
    name: choice.name,
    address: address as `0x${string}`,
    chainId,
    provider: choice.provider,
  };
}

export async function currentChainId(provider: Eip1193Provider): Promise<number> {
  const hex = (await provider.request({ method: 'eth_chainId' })) as string;
  return Number.parseInt(hex, 16);
}

/** EIP-1193 codes this app reacts to by name rather than by number at the call site. */
export const USER_REJECTED = 4001;
const CHAIN_NOT_ADDED = 4902;

function errorCode(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'number') return code;
  // Some wallets nest the provider error one level down.
  const inner = (error as { data?: { originalError?: { code?: unknown } } } | null)?.data
    ?.originalError?.code;
  return typeof inner === 'number' ? inner : undefined;
}

export function wasRejectedByUser(error: unknown): boolean {
  return errorCode(error) === USER_REJECTED;
}

/**
 * Move the wallet to `chainId`, adding the chain first if it has never seen it.
 *
 * The 4902 path is the whole reason this is not a one-liner. A wallet that does not know
 * a chain refuses the switch, and the only recovery is to describe the chain to it and
 * try again — with values that were checked, which is what `addChainParams` holds. Where
 * no verified description exists this throws saying so, rather than handing a wallet an
 * RPC URL nobody confirmed.
 */
export async function switchToChain(provider: Eip1193Provider, chainId: number): Promise<void> {
  if ((await currentChainId(provider)) === chainId) return;
  const hex = toHexChainId(chainId);
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
  } catch (error) {
    if (errorCode(error) !== CHAIN_NOT_ADDED) throw error;
    const params = addChainParams(chainId);
    if (!params) {
      throw new Error(
        `Your wallet does not have that network and this app has no verified details ` +
          `for it, so it will not describe one. Add chain ${chainId} in your wallet and ` +
          `try again.`,
      );
    }
    await provider.request({ method: 'wallet_addEthereumChain', params: [params] });
    // Adding does not always select. Ask again; a wallet that added and switched in one
    // step answers this immediately from its own state.
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
  }

  // Trust the wallet's own answer, not the fact that the call returned.
  const now = await currentChainId(provider);
  if (now !== chainId) {
    throw new Error(`Your wallet is still on network ${now}. Switch it to ${chainId} to continue.`);
  }
}

export interface SourceTxRequest {
  readonly to: `0x${string}`;
  readonly data: `0x${string}`;
  /** Wei, as a decimal string. Almost always '0' — these are token transfers. */
  readonly value: string;
}

/**
 * Send one transaction from the connected wallet and return its hash.
 *
 * The chain is asserted immediately before sending, not when the plan was built: a user
 * can switch networks in the wallet between pressing the button and approving, and a
 * SpokePool deposit sent to the wrong chain is money handed to an address that means
 * something else there.
 */
export async function sendSourceTx(
  wallet: ConnectedEvmWallet,
  chainId: number,
  tx: SourceTxRequest,
): Promise<`0x${string}`> {
  const now = await currentChainId(wallet.provider);
  if (now !== chainId) {
    throw new Error(`Your wallet is on network ${now}, not ${chainId}. Nothing was sent.`);
  }
  const value = BigInt(tx.value ?? '0');
  const hash = (await wallet.provider.request({
    method: 'eth_sendTransaction',
    params: [
      {
        from: wallet.address,
        to: tx.to,
        data: tx.data,
        ...(value > 0n ? { value: `0x${value.toString(16)}` } : {}),
      },
    ],
  })) as string;
  return hash as `0x${string}`;
}
