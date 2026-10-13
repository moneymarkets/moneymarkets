import { MAINNET, MARKET_CANDIDATES, type MarketCandidate } from '@tradepro/core';
import type { Address } from 'viem';

/**
 * The token registry (any-token wallet, spec A1): every token this app knows about,
 * merged from its sources in a fixed order, with symbol and decimals taken from the
 * contract itself once read, never from a list.
 *
 * Pure logic lives here and is unit tested with fakes; the live wiring (chain reads,
 * SQLite, the TTL cache) is in `tokenRegistryLive.ts`.
 *
 * Merge order is the spec's: Kuru's market token list first (the one source whose
 * every address was read on chain 143 and pinned in `liveMarkets.ts`), then Kuru
 * Flow's list (see `flowTokenSource.ts`), then the base set from the address book.
 * An address listed by several sources is one entry whose `sources` names all of them
 * in that order. A source may supply a symbol as a placeholder; the entry's symbol is
 * the contract's the moment the contract has been read, and a source never overrides
 * it afterwards.
 */

export const NATIVE_MON: Address = '0x0000000000000000000000000000000000000000';

export type RegistrySource = 'kuru-market' | 'kuru-flow' | 'base';

export interface SourceToken {
  readonly address: Address;
  readonly symbol?: string;
  readonly name?: string;
  readonly decimals?: number;
  readonly logoUrl?: string;
}

export interface TokenListSource {
  readonly name: RegistrySource;
  list(): Promise<readonly SourceToken[]>;
}

export interface TokenRegistryEntry {
  readonly address: Address;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly logoUrl?: string;
  readonly sources: readonly RegistrySource[];
  /** True once symbol/name/decimals are the contract's own answer, not a source's word. */
  readonly verified: boolean;
}

/** What one contract answered, or `null` when it is not an ERC-20 (`decimals()` reverted). */
export interface ContractMeta {
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
}

export type ContractMetaReader = (
  addresses: readonly Address[],
) => Promise<ReadonlyMap<string, ContractMeta | null>>;

export interface MetaStore {
  getMeta(addresses: readonly Address[]): ReadonlyMap<string, { symbol: string; name: string; decimals: number }>;
  putMeta(rows: readonly { address: Address; symbol: string; name: string; decimals: number }[]): void;
}

/** Kuru's market token list: every base and quote asset of every market candidate. */
export function kuruMarketTokens(candidates: readonly MarketCandidate[] = MARKET_CANDIDATES): SourceToken[] {
  const out: SourceToken[] = [];
  for (const c of candidates) {
    out.push({ address: c.params.baseAsset, symbol: c.base, decimals: c.params.baseDecimals });
    out.push({ address: c.params.quoteAsset, symbol: c.quote, decimals: c.params.quoteDecimals });
  }
  return out;
}

/** The base set: the address book, always present whatever the lists say. */
export function baseTokens(book: typeof MAINNET.tokens = MAINNET.tokens): SourceToken[] {
  return Object.values(book).map((t) => ({ address: t.address, symbol: t.symbol, decimals: t.decimals }));
}

export interface MergedToken {
  readonly address: Address;
  readonly placeholderSymbol: string;
  readonly placeholderName: string;
  readonly placeholderDecimals: number | undefined;
  readonly logoUrl?: string;
  readonly sources: RegistrySource[];
}

/**
 * Merge source lists in order. Dedup by lowercased address; the first source to name
 * an address supplies the placeholders, every source that names it is recorded.
 */
export function mergeSources(
  lists: ReadonlyArray<{ readonly name: RegistrySource; readonly tokens: readonly SourceToken[] }>,
): MergedToken[] {
  const byAddress = new Map<string, MergedToken>();
  for (const { name, tokens } of lists) {
    for (const t of tokens) {
      const key = t.address.toLowerCase();
      const existing = byAddress.get(key);
      if (existing) {
        if (!existing.sources.includes(name)) existing.sources.push(name);
        continue;
      }
      byAddress.set(key, {
        address: t.address,
        placeholderSymbol: t.symbol ?? '',
        placeholderName: t.name ?? t.symbol ?? '',
        placeholderDecimals: t.decimals,
        ...(t.logoUrl ? { logoUrl: t.logoUrl } : {}),
        sources: [name],
      });
    }
  }
  return [...byAddress.values()];
}

/**
 * Turn merged placeholders into entries whose symbol/name/decimals are the contract's.
 *
 * `store` remembers past contract reads; only addresses it has never answered for are
 * read now, through `readContractMeta` (one multicall in production, a fake in tests).
 * Native MON has no contract and keeps its address-book facts. An address whose
 * `decimals()` reverts is not an ERC-20 and is dropped, whatever list named it.
 */
export async function verifyWithContract(
  merged: readonly MergedToken[],
  store: MetaStore,
  readContractMeta: ContractMetaReader,
): Promise<TokenRegistryEntry[]> {
  const contracts = merged.filter((m) => m.address.toLowerCase() !== NATIVE_MON);
  const known = store.getMeta(contracts.map((m) => m.address));
  const unread = contracts.filter((m) => !known.has(m.address.toLowerCase())).map((m) => m.address);
  const fresh = unread.length > 0 ? await readContractMeta(unread) : new Map<string, ContractMeta | null>();

  const toPersist: { address: Address; symbol: string; name: string; decimals: number }[] = [];
  const out: TokenRegistryEntry[] = [];
  for (const m of merged) {
    const key = m.address.toLowerCase();
    if (key === NATIVE_MON) {
      out.push({
        address: NATIVE_MON,
        symbol: m.placeholderSymbol || 'MON',
        name: m.placeholderName || 'MON',
        decimals: m.placeholderDecimals ?? 18,
        ...(m.logoUrl ? { logoUrl: m.logoUrl } : {}),
        sources: m.sources,
        verified: true,
      });
      continue;
    }
    const meta = known.get(key) ?? fresh.get(key);
    if (meta === null) continue; // not an ERC-20
    if (meta === undefined) {
      // The read did not answer for this address (transport failure, not a revert):
      // keep the placeholder, unverified, rather than drop a token a source named.
      if (m.placeholderDecimals === undefined) continue;
      out.push({
        address: m.address,
        symbol: m.placeholderSymbol,
        name: m.placeholderName,
        decimals: m.placeholderDecimals,
        ...(m.logoUrl ? { logoUrl: m.logoUrl } : {}),
        sources: m.sources,
        verified: false,
      });
      continue;
    }
    if (!known.has(key)) toPersist.push({ address: m.address, ...meta });
    out.push({
      address: m.address,
      symbol: meta.symbol,
      name: meta.name,
      decimals: meta.decimals,
      ...(m.logoUrl ? { logoUrl: m.logoUrl } : {}),
      sources: m.sources,
      verified: true,
    });
  }
  if (toPersist.length > 0) store.putMeta(toPersist);
  return out;
}

/** Every distinct host the registry's logo URLs point at, for the CSP `img-src` test. */
export function logoHosts(entries: readonly TokenRegistryEntry[]): string[] {
  const hosts = new Set<string>();
  for (const e of entries) {
    if (!e.logoUrl) continue;
    try {
      hosts.add(new URL(e.logoUrl).host);
    } catch {
      // A malformed URL is not a host; the icon simply falls back to the mark.
    }
  }
  return [...hosts].sort();
}

export async function buildRegistry(options: {
  readonly sources: readonly TokenListSource[];
  readonly store: MetaStore;
  readonly readContractMeta: ContractMetaReader;
  /** Logo URLs by lowercased address, from Kuru's market metadata. */
  readonly logoByAddress?: ReadonlyMap<string, string>;
}): Promise<TokenRegistryEntry[]> {
  const lists: { name: RegistrySource; tokens: readonly SourceToken[] }[] = [];
  for (const source of options.sources) {
    let tokens: readonly SourceToken[] = [];
    try {
      tokens = await source.list();
    } catch {
      // A source that fails to answer contributes nothing this build; the registry is
      // still correct with the sources that did answer.
    }
    lists.push({ name: source.name, tokens });
  }
  const merged = mergeSources(lists).map((m) => {
    const logo = options.logoByAddress?.get(m.address.toLowerCase());
    return logo && !m.logoUrl ? { ...m, logoUrl: logo } : m;
  });
  return verifyWithContract(merged, options.store, options.readContractMeta);
}
