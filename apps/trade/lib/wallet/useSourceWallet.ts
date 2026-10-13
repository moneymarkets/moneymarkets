'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  connectWallet,
  currentChainId,
  discoverWallets,
  switchToChain,
  wasRejectedByUser,
  type ConnectedEvmWallet,
  type WalletChoice,
} from './evm';
import {
  connectSolanaWallet,
  discoverSolanaWallets,
  disconnectSolanaWallet,
  solanaRejectedByUser,
  type ConnectedSolanaWallet,
  type SolanaWalletChoice,
} from './solana';
import { connectWalletConnect, walletConnectAvailable } from './walletconnect';

/**
 * One hook holding the **source-chain** wallet, kept strictly apart from the session.
 *
 * `useSession` is the passkey account: it is the recipient, it signs on Monad, and it is
 * never the thing that signs a deposit on Base. This is the other one. Two separate
 * hooks, two separate addresses on screen, no code path where one can stand in for the
 * other.
 *
 * ## It follows the wallet rather than remembering it
 *
 * `accountsChanged` and `chainChanged` are subscribed for the life of the connection. A
 * user who switches account in MetaMask has switched account here too — the alternative
 * is a screen showing one address while the wallet signs from another, which is the
 * worst failure this surface has.
 *
 * Nothing is persisted. On reload the connection is gone and has to be made again. That
 * is the honest state: an EIP-1193 permission can be revoked in the wallet at any time,
 * so a remembered address is a claim this app cannot check without prompting anyway.
 */

export type SourceWalletState =
  | { readonly status: 'idle' }
  | { readonly status: 'connecting' }
  | { readonly status: 'evm'; readonly wallet: ConnectedEvmWallet }
  | { readonly status: 'solana'; readonly wallet: ConnectedSolanaWallet };

export interface SourceWallet {
  readonly state: SourceWalletState;
  /** Injected EVM wallets that announced themselves, plus WalletConnect when enabled. */
  readonly evmChoices: readonly WalletChoice[];
  readonly solanaChoices: readonly SolanaWalletChoice[];
  readonly walletConnectOffered: boolean;
  readonly error?: string;
  /** The address that will send, whichever family is connected. */
  readonly address?: string;
  connectEvm(choice: WalletChoice): Promise<void>;
  connectViaWalletConnect(chainIds: readonly number[]): Promise<void>;
  connectSolana(choice: SolanaWalletChoice): Promise<void>;
  /** Move the connected EVM wallet to a chain, adding it first if it is unknown. */
  ensureChain(chainId: number): Promise<boolean>;
  disconnect(): void;
  refreshChoices(): void;
}

export function useSourceWallet(): SourceWallet {
  const [state, setState] = useState<SourceWalletState>({ status: 'idle' });
  const [evmChoices, setEvmChoices] = useState<readonly WalletChoice[]>([]);
  const [solanaChoices, setSolanaChoices] = useState<readonly SolanaWalletChoice[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [nonce, setNonce] = useState(0);
  const connectedSolana = useRef<SolanaWalletChoice | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void discoverWallets().then((found) => {
      if (!cancelled) setEvmChoices(found);
    });
    setSolanaChoices(discoverSolanaWallets());
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  // Follow the wallet. A silent divergence between what is shown and what will sign is
  // the one failure this screen must not have.
  useEffect(() => {
    if (state.status !== 'evm') return;
    const provider = state.wallet.provider;
    if (!provider.on || !provider.removeListener) return;

    const onAccounts = (...args: unknown[]) => {
      const accounts = args[0] as string[] | undefined;
      const next = accounts?.[0];
      if (!next) {
        setState({ status: 'idle' });
        setError('Your wallet disconnected this site.');
        return;
      }
      setState((s) =>
        s.status === 'evm'
          ? { status: 'evm', wallet: { ...s.wallet, address: next as `0x${string}` } }
          : s,
      );
    };
    const onChain = (...args: unknown[]) => {
      const hex = args[0] as string | undefined;
      if (!hex) return;
      const id = Number.parseInt(hex, 16);
      setState((s) => (s.status === 'evm' ? { status: 'evm', wallet: { ...s.wallet, chainId: id } } : s));
    };

    provider.on('accountsChanged', onAccounts);
    provider.on('chainChanged', onChain);
    return () => {
      provider.removeListener?.('accountsChanged', onAccounts);
      provider.removeListener?.('chainChanged', onChain);
    };
  }, [state]);

  const connectEvm = useCallback(async (choice: WalletChoice) => {
    setError(undefined);
    setState({ status: 'connecting' });
    try {
      setState({ status: 'evm', wallet: await connectWallet(choice) });
    } catch (e) {
      setState({ status: 'idle' });
      setError(
        wasRejectedByUser(e)
          ? 'You cancelled the connection. Nothing was shared.'
          : e instanceof Error
            ? e.message
            : 'That wallet could not be connected.',
      );
    }
  }, []);

  const connectViaWalletConnect = useCallback(
    async (chainIds: readonly number[]) => {
      setError(undefined);
      setState({ status: 'connecting' });
      try {
        const choice = await connectWalletConnect(chainIds);
        setState({ status: 'evm', wallet: await connectWallet(choice) });
      } catch (e) {
        setState({ status: 'idle' });
        setError(e instanceof Error ? e.message : 'WalletConnect could not be started.');
      }
    },
    [],
  );

  const connectSolana = useCallback(async (choice: SolanaWalletChoice) => {
    setError(undefined);
    setState({ status: 'connecting' });
    try {
      const wallet = await connectSolanaWallet(choice);
      connectedSolana.current = choice;
      setState({ status: 'solana', wallet });
    } catch (e) {
      setState({ status: 'idle' });
      setError(
        solanaRejectedByUser(e)
          ? 'You cancelled the connection. Nothing was shared.'
          : e instanceof Error
            ? e.message
            : 'That wallet could not be connected.',
      );
    }
  }, []);

  const ensureChain = useCallback(
    async (chainId: number): Promise<boolean> => {
      if (state.status !== 'evm') return false;
      setError(undefined);
      try {
        await switchToChain(state.wallet.provider, chainId);
        const now = await currentChainId(state.wallet.provider);
        setState({ status: 'evm', wallet: { ...state.wallet, chainId: now } });
        return now === chainId;
      } catch (e) {
        setError(
          wasRejectedByUser(e)
            ? 'You cancelled the network switch, so nothing was sent.'
            : e instanceof Error
              ? e.message
              : 'Your wallet would not switch networks.',
        );
        return false;
      }
    },
    [state],
  );

  const disconnect = useCallback(() => {
    if (connectedSolana.current) {
      void disconnectSolanaWallet(connectedSolana.current);
      connectedSolana.current = undefined;
    }
    // An EVM provider has no disconnect: the permission lives in the wallet and is the
    // user's to revoke there. Forgetting it here is the honest half of the job.
    setState({ status: 'idle' });
    setError(undefined);
  }, []);

  const address =
    state.status === 'evm' ? state.wallet.address : state.status === 'solana' ? state.wallet.address : undefined;

  return {
    state,
    evmChoices,
    solanaChoices,
    walletConnectOffered: walletConnectAvailable(),
    ...(error ? { error } : {}),
    ...(address ? { address } : {}),
    connectEvm,
    connectViaWalletConnect,
    connectSolana,
    ensureChain,
    disconnect,
    refreshChoices: () => setNonce((n) => n + 1),
  };
}
