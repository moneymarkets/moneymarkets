import {
  chainFor as chainForMode,
  createChainClient,
  chainModeSchema,
  mainnetAllowed,
  readModeGate,
  MAINNET,
  TESTNET,
} from '@tradepro/core';
import type { PublicClient, Transport } from 'viem';

/**
 * The one read-only chain client the route handlers share.
 *
 * `readOnly: true` is correct and deliberate: nothing here can move funds, so it must
 * not be behind the A2.4 write gate. Everything that can spend goes through
 * `submit()`.
 */

let cached: PublicClient<Transport> | undefined;

export function chainMode() {
  return chainModeSchema.parse(process.env.CHAIN ?? 'testnet');
}

export function addresses() {
  return chainMode() === 'mainnet' ? MAINNET : TESTNET;
}

/** The viem chain for the configured mode, for anything that needs to write. */
export function chainFor() {
  return chainForMode(chainMode());
}

export function readClient(): PublicClient<Transport> {
  if (cached) return cached;
  const mode = chainMode();
  const rpcUrl =
    (mode === 'mainnet' ? process.env.RPC_URL_MONAD_MAINNET : undefined) ??
    process.env.RPC_URL_MONAD;
  cached = createChainClient({ mode, readOnly: true, ...(rpcUrl ? { rpcUrl } : {}) });
  return cached;
}

/** JSON cannot carry a bigint, and the app refuses to round one into a number. */
export function jsonSafe<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

/**
 * Whether this deployment would actually send a transaction.
 *
 * Exposed to the client for one reason: a disabled button that cannot say why is a
 * dead end. In dryrun the move card still renders — the interface has to be visible
 * before it is armed — and its button explains that live actions are off rather than
 * looking broken.
 *
 * This is the same three-switch gate `submit()` enforces; it is not a second opinion.
 */
export function liveEnabled(): boolean {
  return mainnetAllowed(readModeGate());
}
