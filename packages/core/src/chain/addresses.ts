import type { Address } from 'viem';
import type { ChainMode } from './chains.js';

/**
 * Addresses.
 *
 * Rule A2.5: nothing here is a guess. Every mainnet entry below was confirmed by a
 * live read on 2026-09-02 (see the annotations). Kuru *market* addresses are
 * deliberately NOT part of the trusted set at runtime — they are discovered from the
 * live registry and verified on chain (`kuru/registry.ts`), because the SDK shipped
 * stale hardcoded market addresses once already.
 */

export interface TokenInfo {
  readonly address: Address;
  readonly decimals: number;
  readonly symbol: string;
}

/** Verified 2026-09-02 by direct `eth_call` against https://rpc.monad.xyz. */
export const MAINNET = {
  chainId: 143,
  kuru: {
    /** `Router.TRUSTED_FORWARDER()` returns the forwarder below. */
    router: '0xd651346d7c789536ebf06dc72aE3C8502cd695CC' as Address,
    /** `isTrustedForwarder(forwarder)` -> true. */
    marginAccount: '0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5' as Address,
    /**
     * ERC-1967 proxy. Implementation `0xbf6Cc109c6eBcA4B28e3e51FD8798294599CFe2A`
     * (slot 0x360894…382bbc). `eip712Domain()` -> name "KuruForwarder",
     * version "1.0.0", chainId 143, verifyingContract = itself, no salt.
     */
    forwarder: '0x974E61BBa9C4704E8Bcc1923fdC3527B41323FAA' as Address,
    forwarderImplementation: '0xbf6Cc109c6eBcA4B28e3e51FD8798294599CFe2A' as Address,
    restApi: 'https://api.kuru.io',
    wsApi: 'wss://exchange.kuru.io/ws',
    flowApi: 'https://ws.kuru.io/api',
  },
  tokens: {
    AUSD: {
      address: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a' as Address,
      decimals: 6,
      symbol: 'AUSD',
    },
    USDC: {
      address: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603' as Address,
      decimals: 6,
      symbol: 'USDC',
    },
    USDT0: {
      address: '0xe7cd86e13AC4309349F30B3435a9d337750fC82D' as Address,
      decimals: 6,
      symbol: 'USDT0',
    },
    MON: {
      address: '0x0000000000000000000000000000000000000000' as Address,
      decimals: 18,
      symbol: 'MON',
    },
    /**
     * Wrapped MON. Verified 2026-09-08 by a live `eth_call`: `name()` -> "Wrapped MON",
     * `symbol()` -> "WMON", `decimals()` -> 18. Kuru Flow routes a swap through this
     * token — wrapping and unwrapping native MON internally — once the direct AUSD/USDC
     * book cannot fill the requested size; see `kuru/flow.ts`'s `flowTouchesWmon`.
     */
    WMON: {
      address: '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A' as Address,
      decimals: 18,
      symbol: 'WMON',
    },
  } satisfies Record<string, TokenInfo>,
  /**
   * LayerZero OFT for AUSD on Base. Verified on Base mainnet at block 50783474,
   * 2026-09-02: 1200 bytes of code, `token()` is the same AUSD address Monad uses,
   * `endpoint()` is LayerZero V2 0x1a44076050125825900e736c501f859c50fE728c,
   * `sharedDecimals()` 6, and `approvalRequired()` is **false** — no ERC-20 approve
   * is needed before `send()`. A live quoteSend of 5 AUSD to Monad cost
   * 0.000100701869744601 ETH. See `ausd/oft.test.ts` for the full reading.
   */
  ausdOftAdapter: '0x9CaB7Ede13dc56652E44D2404E969C212f22689b' as Address,
  /** DECISIONS.md open item 3 — must come from `@layerzerolabs/lz-definitions`. */
  layerZeroEid: undefined as number | undefined,
} as const;

/**
 * Testnet.
 *
 * The AUSD token and its faucet are live and were confirmed to have code on
 * 2026-09-02. **Kuru's public testnet deployment is a different, older build than
 * mainnet** — see `KURU_TESTNET_STATUS` below. There are therefore no trusted Kuru
 * testnet addresses here; nothing may be hardcoded until a current deployment
 * exists.
 */
export const TESTNET = {
  chainId: 10143,
  kuru: {
    router: undefined as Address | undefined,
    marginAccount: undefined as Address | undefined,
    forwarder: undefined as Address | undefined,
    restApi: 'https://api.testnet.kuru.io',
    wsApi: undefined as string | undefined,
    flowApi: undefined as string | undefined,
  },
  tokens: {
    AUSD: {
      address: '0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC' as Address,
      decimals: 6,
      symbol: 'AUSD',
    },
    /** Kuru testnet's own USDC, from `api.testnet.kuru.io` market metadata. */
    USDC: {
      address: '0xee0722ead54f1B4fE97BE399bE43BC0226a6F97E' as Address,
      decimals: 6,
      symbol: 'USDC',
    },
    MON: {
      address: '0x0000000000000000000000000000000000000000' as Address,
      decimals: 18,
      symbol: 'MON',
    },
  } satisfies Record<string, TokenInfo>,
  ausdFaucet: '0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C' as Address,
  ausdOftAdapter: undefined as Address | undefined,
  layerZeroEid: undefined as number | undefined,
} as const;

/**
 * What is actually deployed on Kuru's public testnet, measured 2026-09-02 against
 * `0xfdbe356828c8f5a5d5ed4f69dde0816f4058ef61` (MONUSDC, listed active by
 * `api.testnet.kuru.io/api/v1/markets` with 53 trades in 24h):
 *
 *   getMarketParams()        returns 7 words, not the mainnet 11-tuple
 *   isTrustedForwarder(addr) reverts (function absent)
 *   addBuyOrder(...)         reverts (function absent)
 *   getL2Book()              reverts (function absent)
 *   code at the mainnet forwarder address: none
 *
 * So the M0 gate as written ("a forwarded testnet order") cannot run against Kuru's
 * public testnet. See DECISIONS.md open item 7 and the session report.
 */
export const KURU_TESTNET_STATUS = {
  erc2771Aware: false,
  matchesMainnetAbi: false,
  observedAt: '2026-09-02',
  probeMarket: '0xfdbe356828c8f5a5d5ed4f69dde0816f4058ef61' as Address,
} as const;

export function addressesFor(mode: ChainMode) {
  return mode === 'mainnet' ? MAINNET : TESTNET;
}
