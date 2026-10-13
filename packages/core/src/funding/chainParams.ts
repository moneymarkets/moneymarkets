import { KNOWN_CHAINS } from './coverage.js';

/**
 * What a wallet needs to be told about a chain it does not already know.
 *
 * `wallet_switchEthereumChain` fails with code **4902** when the wallet has never heard
 * of the chain. The recovery is `wallet_addEthereumChain` with a full description, then
 * the switch again. Every wallet ships Ethereum, Base and Arbitrum; a user on a less
 * common source chain is exactly the person that fallback exists for, so it is not an
 * optional nicety.
 *
 * ## Every value here was read, not copied
 *
 * Each `rpcUrls[0]` below answered `eth_chainId` with the id it is filed under, checked
 * 2026-09-11:
 *
 * ```
 * Ethereum        1      -> 1        OP Mainnet     10     -> 10
 * BNB Smart Chain 56     -> 56       Polygon        137    -> 137
 * Monad           143    -> 143      Base           8453   -> 8453
 * Arbitrum One    42161  -> 42161    Avalanche      43114  -> 43114
 * Linea           59144  -> 59144
 * ```
 *
 * A wrong RPC here would add a chain under the wrong name in someone's wallet and leave
 * it there, which is why the check is a transcript rather than an assurance.
 *
 * ## Native currency is the chain's own, never the token being sent
 *
 * `nativeCurrency` is what pays gas on that chain. Polygon's is POL, not MATIC — the
 * rename shipped and a wallet told MATIC shows the wrong ticker forever.
 */

export interface AddEthereumChainParams {
  /** Hex, no leading zeros. The shape `wallet_addEthereumChain` requires. */
  readonly chainId: string;
  readonly chainName: string;
  readonly nativeCurrency: { readonly name: string; readonly symbol: string; readonly decimals: number };
  readonly rpcUrls: readonly string[];
  readonly blockExplorerUrls: readonly string[];
}

const PARAMS: Readonly<Record<number, AddEthereumChainParams>> = {
  1: {
    chainId: '0x1',
    chainName: 'Ethereum',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://ethereum-rpc.publicnode.com'],
    blockExplorerUrls: ['https://etherscan.io'],
  },
  10: {
    chainId: '0xa',
    chainName: 'OP Mainnet',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://mainnet.optimism.io'],
    blockExplorerUrls: ['https://optimistic.etherscan.io'],
  },
  56: {
    chainId: '0x38',
    chainName: 'BNB Smart Chain',
    nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
    rpcUrls: ['https://bsc-dataseed.bnbchain.org'],
    blockExplorerUrls: ['https://bscscan.com'],
  },
  137: {
    chainId: '0x89',
    chainName: 'Polygon',
    // POL, not MATIC. The rename shipped; a wallet told MATIC keeps it forever.
    nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 },
    rpcUrls: ['https://polygon-bor-rpc.publicnode.com'],
    blockExplorerUrls: ['https://polygonscan.com'],
  },
  143: {
    chainId: '0x8f',
    chainName: 'Monad',
    nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
    rpcUrls: ['https://rpc.monad.xyz'],
    blockExplorerUrls: ['https://explorer.monad.xyz'],
  },
  8453: {
    chainId: '0x2105',
    chainName: 'Base',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://mainnet.base.org'],
    blockExplorerUrls: ['https://basescan.org'],
  },
  42161: {
    chainId: '0xa4b1',
    chainName: 'Arbitrum One',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://arb1.arbitrum.io/rpc'],
    blockExplorerUrls: ['https://arbiscan.io'],
  },
  43114: {
    chainId: '0xa86a',
    chainName: 'Avalanche',
    nativeCurrency: { name: 'Avalanche', symbol: 'AVAX', decimals: 18 },
    rpcUrls: ['https://api.avax.network/ext/bc/C/rpc'],
    blockExplorerUrls: ['https://snowtrace.io'],
  },
  59144: {
    chainId: '0xe708',
    chainName: 'Linea',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://rpc.linea.build'],
    blockExplorerUrls: ['https://lineascan.build'],
  },
};

/**
 * The add-chain description for a chain, or `undefined` where none was verified.
 *
 * `undefined` is a real answer: the caller must then report that it cannot add the
 * chain rather than sending a wallet an RPC URL nobody checked.
 */
export function addChainParams(chainId: number): AddEthereumChainParams | undefined {
  return PARAMS[chainId];
}

/** `0x2105` for 8453 — what every EIP-1193 chain method expects. */
export function toHexChainId(chainId: number): string {
  return `0x${chainId.toString(16)}`;
}

/** The chains this app can ask a wallet to switch to, for tests and for the UI. */
export function switchableChainIds(): number[] {
  return Object.keys(PARAMS)
    .map(Number)
    .filter((id) => id === 143 || KNOWN_CHAINS[id] !== undefined);
}

/**
 * Every block explorer host this app has verified, flattened from `PARAMS` above.
 *
 * Used to gate a **vendor-chosen** URL — a rail's own `explorerUrl` on a refund row,
 * never something this app built itself — before it is rendered as a clickable link
 * (audit M4). Not XSS (React's `sanitizeURL` already neutralises `javascript:`), but
 * an unchecked vendor URL rendered as a trusted-looking link inside this app's own UI
 * is a clean phishing primitive, and a vendor answer is not proof of where it points.
 */
/**
 * Explorers for the non-EVM source chains a deposit can come from, each with where its
 * host and its transaction route were read (2026-09-29):
 *
 *   - Solana: `explorer.solana.com`, listed on Solana's own cluster reference
 *     (solana.com/docs/references/clusters). The `/tx/<signature>` route is the
 *     explorer's own `app/tx/[signature]/page.tsx` (github.com/solana-foundation/explorer).
 *   - Tron: `tronscan.org`, listed on TRON's developer docs
 *     (developers.tron.network/docs/tronscan). The `/transaction/:hash` route is in
 *     tronscan-frontend's own `src/routes.js`. That the app serves it under `#/` (hash
 *     routing) was not confirmed from source; UNVERIFIED: tronscan hash-route prefix.
 */
const NON_EVM_EXPLORERS: Readonly<Record<string, { readonly base: string; readonly txPath: (hash: string) => string }>> = {
  Solana: { base: 'https://explorer.solana.com', txPath: (hash) => `/tx/${hash}` },
  Tron: { base: 'https://tronscan.org', txPath: (hash) => `/#/transaction/${hash}` },
};

const TRUSTED_EXPLORER_HOSTS = new Set([
  ...Object.values(PARAMS).flatMap((p) => p.blockExplorerUrls.map((u) => new URL(u).hostname)),
  ...Object.values(NON_EVM_EXPLORERS).map((e) => new URL(e.base).hostname),
]);

/**
 * A transaction link on a deposit's source chain, built by this app from a verified
 * explorer host, never taken from a vendor. `chain` is the display name a deposit row
 * stores ('Solana', 'Tron', 'Base', ...), resolved through `KNOWN_CHAINS` for EVM
 * chains. `undefined` for a chain with no verified explorer, or a hash that is not the
 * shape that chain uses; the caller then shows the hash as plain text.
 */
export function sourceTxExplorerUrl(chain: string, hash: string): string | undefined {
  const nonEvm = NON_EVM_EXPLORERS[chain];
  if (nonEvm) {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,90}$/.test(hash) && !/^(0x)?[0-9a-fA-F]{64}$/.test(hash)) return undefined;
    return `${nonEvm.base}${nonEvm.txPath(hash.replace(/^0x/, ''))}`;
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return undefined;
  const known = Object.values(KNOWN_CHAINS).find((c) => c.displayName === chain && c.vm === 'evm');
  const explorer = known ? PARAMS[known.id]?.blockExplorerUrls[0] : undefined;
  return explorer ? `${explorer}/tx/${hash}` : undefined;
}

/**
 * True only for an `https:` URL whose host is one of the block explorers this app has
 * actually verified. A URL from a chain this app has not verified an explorer for —
 * including a real one, such as a non-EVM rail's own explorer — is refused rather than
 * trusted on the vendor's word; the caller falls back to plain, non-clickable text.
 */
export function isTrustedExplorerUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && TRUSTED_EXPLORER_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}
