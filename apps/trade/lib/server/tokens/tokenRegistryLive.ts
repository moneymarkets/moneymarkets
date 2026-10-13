import { MAINNET } from '@tradepro/core';
import type { Address } from 'viem';
import { addresses, readClient } from '../chain';
import { flowTokenSource } from './flowTokenSource';
import { logoByAddressFromMarkets } from './kuruMarketMeta';
import { tokenDb } from './tokenDb';
import {
  baseTokens,
  buildRegistry,
  kuruMarketTokens,
  logoHosts,
  type ContractMeta,
  type ContractMetaReader,
  type TokenListSource,
  type TokenRegistryEntry,
} from './tokenRegistry';

/**
 * The registry, live: chain reads through the shared read client, contract metadata
 * remembered in SQLite, rebuilt every ten minutes in the background (spec A1). The
 * same stale-while-revalidate + inflight guard shape `liveMarkets.ts` uses for
 * `ACTIVE_MARKETS_TTL_MS`.
 */
export const REGISTRY_TTL_MS = 10 * 60_000;

const decimalsAbi = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const;
const symbolAbi = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
] as const;
const nameAbi = [
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
] as const;

interface LegResult {
  readonly status: 'success' | 'failure';
  readonly result?: unknown;
}

function shortAddress(address: Address): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * One multicall of `decimals()`, `symbol()`, `name()` per address. `decimals()`
 * failing means "not an ERC-20" (`null`); a missing symbol or name is not, since some
 * real tokens return bytes32 or nothing there, and the address stands in.
 */
export const readContractMetaLive: ContractMetaReader = async (addressesIn) => {
  const out = new Map<string, ContractMeta | null>();
  if (addressesIn.length === 0) return out;
  const client = readClient();
  const legs = addressesIn.flatMap((address) => [
    { address, abi: decimalsAbi, functionName: 'decimals', args: [] },
    { address, abi: symbolAbi, functionName: 'symbol', args: [] },
    { address, abi: nameAbi, functionName: 'name', args: [] },
  ]);
  let results: readonly LegResult[];
  try {
    results = (await client.multicall({ contracts: legs as never })) as unknown as readonly LegResult[];
  } catch {
    // Transport failure: answer nothing, so callers keep placeholders unverified
    // rather than dropping tokens or inventing metadata.
    return out;
  }
  addressesIn.forEach((address, i) => {
    const dec = results[i * 3];
    const sym = results[i * 3 + 1];
    const nam = results[i * 3 + 2];
    if (!dec || dec.status !== 'success') {
      out.set(address.toLowerCase(), null);
      return;
    }
    const decimals = Number(dec.result);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
      out.set(address.toLowerCase(), null);
      return;
    }
    const symbol =
      sym && sym.status === 'success' && typeof sym.result === 'string' && sym.result.length > 0
        ? sym.result
        : shortAddress(address);
    const name = nam && nam.status === 'success' && typeof nam.result === 'string' ? nam.result : symbol;
    out.set(address.toLowerCase(), { symbol, name, decimals });
  });
  return out;
};

export interface RegistrySnapshot {
  readonly tokens: readonly TokenRegistryEntry[];
  readonly logoHosts: readonly string[];
  readonly asOf: number;
}

let current: RegistrySnapshot | undefined;
let inflight: Promise<RegistrySnapshot> | undefined;

function sources(): TokenListSource[] {
  const kuru: TokenListSource = { name: 'kuru-market', async list() { return kuruMarketTokens(); } };
  const base: TokenListSource = { name: 'base', async list() { return baseTokens(MAINNET.tokens); } };
  return [kuru, flowTokenSource, base];
}

async function rebuild(): Promise<RegistrySnapshot> {
  const chain = addresses();
  const restApi = (chain as typeof MAINNET).kuru.restApi;
  const tokens = await buildRegistry({
    sources: sources(),
    store: tokenDb(),
    readContractMeta: readContractMetaLive,
    ...(restApi ? { logoByAddress: logoByAddressFromMarkets(restApi) } : {}),
  });
  return { tokens, logoHosts: logoHosts(tokens), asOf: Date.now() };
}

function refreshInBackground(): Promise<RegistrySnapshot> {
  if (inflight) return inflight;
  inflight = rebuild()
    .then((snap) => {
      current = snap;
      return snap;
    })
    .finally(() => {
      inflight = undefined;
    });
  return inflight;
}

/** The registry: awaited only on a cold start, served from cache and refreshed behind it afterwards. */
export async function tokenRegistry(): Promise<RegistrySnapshot> {
  if (current && Date.now() - current.asOf < REGISTRY_TTL_MS) return current;
  if (current) {
    void refreshInBackground();
    return current;
  }
  return refreshInBackground();
}

/** Registry lookup by address, or undefined when no source lists it. */
export function registryEntry(snapshot: RegistrySnapshot, address: Address): TokenRegistryEntry | undefined {
  const key = address.toLowerCase();
  return snapshot.tokens.find((t) => t.address.toLowerCase() === key);
}
