'use client';

import type { Eip1193Provider, WalletChoice } from './evm';

/**
 * WalletConnect, and why there is no button for it in this build.
 *
 * WalletConnect needs a project id from its own dashboard. Without one the relay refuses
 * the session and the QR never resolves — so a button that is always shown is a button
 * that always fails, and a user who tapped it would reasonably conclude their wallet was
 * the problem.
 *
 * `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` decides it. Unset, as it is today, and this
 * app offers injected wallets only and says so in one line rather than dead-ending
 * someone at a QR code. Set, and the connector below loads.
 *
 * ## The package is not a dependency of this app
 *
 * `@walletconnect/ethereum-provider` is a large tree pulled in for a path that cannot
 * run without an id this project does not have. Installing it now would ship it to every
 * user to support nobody. The import below is dynamic and only reached when an id is
 * present; if the id is set and the package is absent, the error says exactly that and
 * names the install command, which is a better failure than a silent one.
 *
 * **Status: MISSING.** This has never opened a session, because there has never been a
 * project id to open one with. It is written against WalletConnect's published
 * `EthereumProvider.init` surface and has not met it.
 */

export const WALLETCONNECT_PROJECT_ID =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim() ?? '';

export function walletConnectAvailable(): boolean {
  return WALLETCONNECT_PROJECT_ID.length > 0;
}

/** The one line the UI shows where the button would be, when there is no id. */
export const WALLETCONNECT_ABSENT_NOTE =
  'Only wallets installed in this browser are offered. WalletConnect needs a project id ' +
  'this build does not have.';

interface EthereumProviderModule {
  EthereumProvider: {
    init(options: {
      projectId: string;
      chains: number[];
      optionalChains: number[];
      showQrModal: boolean;
      metadata: { name: string; description: string; url: string; icons: string[] };
    }): Promise<Eip1193Provider & { connect(): Promise<void>; disconnect(): Promise<void> }>;
  };
}

/**
 * Open a WalletConnect session and return it as one more `WalletChoice`.
 *
 * `chains` is the required set and `optionalChains` the rest: a wallet that cannot do
 * every chain we might ask for should still be allowed to connect for the one the user
 * is actually funding from, and be asked to switch later.
 */
export async function connectWalletConnect(chainIds: readonly number[]): Promise<WalletChoice> {
  if (!walletConnectAvailable()) {
    throw new Error(WALLETCONNECT_ABSENT_NOTE);
  }

  let module: EthereumProviderModule;
  try {
    /**
     * The specifier is held in a variable on purpose.
     *
     * A literal would make the package a build-time dependency of this app — the
     * bundler would try to resolve it and the typechecker would fail on a module that
     * is deliberately not installed. Computing it keeps the import a runtime one, which
     * is the truth of it: this line runs only when a project id is set, and then the
     * package must be there.
     */
    const specifier = ['@walletconnect', 'ethereum-provider'].join('/');
    module = (await import(/* @vite-ignore */ specifier)) as unknown as EthereumProviderModule;
  } catch {
    throw new Error(
      'WalletConnect is switched on by NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID but the ' +
        '@walletconnect/ethereum-provider package is not installed. Run ' +
        '`pnpm --filter @tradepro/trade add @walletconnect/ethereum-provider` and rebuild.',
    );
  }

  const first = chainIds[0];
  if (first === undefined) throw new Error('No chain was named for the WalletConnect session.');

  const provider = await module.EthereumProvider.init({
    projectId: WALLETCONNECT_PROJECT_ID,
    chains: [first],
    optionalChains: [...chainIds],
    showQrModal: true,
    metadata: {
      name: 'MoneyMarkets',
      description: 'Add money to your Monad trading account',
      url: typeof window === 'undefined' ? '' : window.location.origin,
      icons: [],
    },
  });
  await provider.connect();

  return { id: 'walletconnect', name: 'WalletConnect', provider };
}
