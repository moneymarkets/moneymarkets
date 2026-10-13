import { createPublicClient, http, type PublicClient, type Transport } from 'viem';
import { chainFor, type ChainMode } from './chains.js';
import { assertMainnetAllowed, readModeGate, type ModeGate } from './mode.js';

/**
 * A second public, keyless Monad mainnet RPC (D201, 2026-10-08) — confirmed live by a
 * direct `eth_chainId` call (answered `0x8f`, chain 143) before relying on it (rule
 * A2.5). Listed at docs.monad.xyz/getting-started/network-information alongside the
 * primary `rpc.monad.xyz`; this one is Goldsky Edge's, a different provider, 300
 * requests per 10s.
 *
 * Deliberately not wired into `createChainClient` itself as a generic fallback
 * transport: viem's `fallback()` retries silently on ANY primary error, and the
 * one caller that resends a signed transaction (the self-bundle send,
 * `SelfBundler`'s `retryClient`) must decide that for itself — only after proving
 * the primary genuinely took nothing (security review, 2026-10-08: an earlier,
 * generic `fallbackRpcUrl` option on this function was unused and, if it had been
 * used for a send, would have silently resent on any primary error, including an
 * ambiguous one, bypassing that proof). Build a plain client pointed at this URL
 * instead, the same way as for any other single RPC.
 */
export const FALLBACK_RPC_URL_MAINNET = 'https://rpc2.monad.xyz';

export interface ClientOptions {
  readonly mode: ChainMode;
  readonly rpcUrl?: string;
  /** Skips the A2.4 gate. Only for read-only calls that cannot move funds. */
  readonly readOnly?: boolean;
  readonly gate?: ModeGate;
}

/**
 * A viem public client for the given mode. Building a *mainnet* client that is not
 * marked `readOnly` goes through the A2.4 gate, so a mainnet write path cannot be
 * assembled by accident.
 */
export function createChainClient(options: ClientOptions): PublicClient<Transport> {
  const { mode, rpcUrl, readOnly = false } = options;
  if (mode === 'mainnet' && !readOnly) {
    assertMainnetAllowed('creating a mainnet client', options.gate ?? readModeGate());
  }
  const chain = chainFor(mode);
  const url = rpcUrl ?? chain.rpcUrls.default.http[0];
  return createPublicClient({ chain, transport: http(url) }) as PublicClient<Transport>;
}
