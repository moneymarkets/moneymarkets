import { defineChain } from 'viem';

/**
 * Monad chain definitions.
 *
 * Both chain IDs were read from the chain, not from a document:
 *   eth_chainId @ https://rpc.monad.xyz          -> 0x8f   = 143    (2026-09-02)
 *   eth_chainId @ https://testnet-rpc.monad.xyz  -> 0x279f = 10143  (2026-09-02)
 *
 * The spec listed 10143 as `[?] confirm`; it is now confirmed. See DECISIONS.md
 * open item 7.
 */

export const MONAD_MAINNET_ID = 143 as const;
export const MONAD_TESTNET_ID = 10143 as const;

/** Standard deterministic-deploy address, confirmed live on Monad mainnet 2026-09-08 (`eth_getCode`). */
export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;

export const monad = defineChain({
  id: MONAD_MAINNET_ID,
  name: 'Monad',
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.monad.xyz'] } },
  blockExplorers: { default: { name: 'MonadScan', url: 'https://monadscan.com' } },
  contracts: { multicall3: { address: MULTICALL3_ADDRESS } },
});

export const monadTestnet = defineChain({
  id: MONAD_TESTNET_ID,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: ['https://testnet-rpc.monad.xyz'] } },
  blockExplorers: {
    default: { name: 'Monad Explorer', url: 'https://testnet.monadexplorer.com' },
  },
  testnet: true,
});

export type ChainMode = 'mainnet' | 'testnet';

export function chainFor(mode: ChainMode) {
  return mode === 'mainnet' ? monad : monadTestnet;
}

/**
 * Block time and finality, measured by Monad and used for the relayer's resubmit
 * policy and the book's staleness threshold (spec §3.1, §5.4).
 */
export const BLOCK_TIME_MS = 400;
export const FINALITY_MS = 800;

/**
 * The public Monad RPC caps `eth_getLogs` at a 100-block range (observed
 * 2026-09-02: `{"code":-32614,"message":"eth_getLogs is limited to a 100 range"}`).
 * Anything that needs history must go through the indexer, not the node. This is
 * why spec §9 exists.
 */
export const PUBLIC_RPC_GET_LOGS_MAX_RANGE = 100n;
