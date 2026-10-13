import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import type { WalletTokenEntry } from '../useAccountBalances';
import type { RegistryToken } from '../useTokenRegistry';
import { selectorList } from './tokenSelect';

/** The selector's pure model (v2.1 spec 2.2), tested without rendering. */

const NATIVE = '0x0000000000000000000000000000000000000000' as Address;
const USDC = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603' as Address;
const WMON = '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A' as Address;
const CHOG = '0x0000000000000000000000000000000000000c40' as Address;
const AIRDROP = '0x00000000000000000000000000000000000000a1' as Address;

function entry(over: Partial<WalletTokenEntry> & Pick<WalletTokenEntry, 'symbol' | 'address'>): WalletTokenEntry {
  return {
    name: over.symbol,
    decimals: 6,
    wallet: { value: 0n, decimals: 6 },
    margin: { value: 0n, decimals: 6 },
    usd: { price: null, wallet: null, margin: null, total: null },
    priceSource: 'none',
    change24h: null,
    iconUrl: null,
    listed: true,
    ...over,
  };
}

function reg(address: string, symbol: string, name: string): RegistryToken {
  return { address, symbol, name, decimals: 6, sources: ['kuru-market'], verified: true };
}

const tokens: readonly WalletTokenEntry[] = [
  entry({
    symbol: 'USDC',
    address: USDC,
    name: 'Dollar stablecoin',
    wallet: { value: 2_216_000n, decimals: 6 },
    usd: {
      price: { value: 1_000_000n, decimals: 6 },
      wallet: { value: 2_216_000n, decimals: 6 },
      margin: null,
      total: { value: 2_216_000n, decimals: 6 },
    },
  }),
  entry({ symbol: 'MON', address: NATIVE, name: 'Monad', wallet: { value: 5n * 10n ** 17n, decimals: 18 }, decimals: 18 }),
  // Held, no list names it: the unverified airdrop (G1's own case).
  entry({ symbol: 'PEPEM', address: AIRDROP, name: 'PEPEM', listed: false, wallet: { value: 50_000n, decimals: 6 } }),
];

const registry: readonly RegistryToken[] = [
  reg(USDC, 'USDC', 'Dollar stablecoin'),
  reg(WMON, 'WMON', 'Wrapped MON'),
  reg(CHOG, 'CHOG', 'Chog'),
];

describe('selectorList', () => {
  it('held tokens first (largest USD leading), then the rest of the registry alphabetical', () => {
    const l = selectorList({ tokens, registry, query: '' });
    expect(l.held.map((r) => r.symbol)).toEqual(['USDC', 'MON', 'PEPEM']);
    expect(l.rest.map((r) => r.symbol)).toEqual(['CHOG', 'WMON']);
  });

  it('an unlisted held token keeps its unverified flag; balance rows win over registry rows', () => {
    const l = selectorList({ tokens, registry, query: '' });
    expect(l.held.find((r) => r.symbol === 'PEPEM')?.listed).toBe(false);
    expect(l.held.find((r) => r.symbol === 'USDC')?.walletValue).toBe(2_216_000n);
  });

  it('search filters by symbol and by name, case-insensitive', () => {
    expect(selectorList({ tokens, registry, query: 'chog' }).rest.map((r) => r.symbol)).toEqual(['CHOG']);
    expect(selectorList({ tokens, registry, query: 'wrapped' }).rest.map((r) => r.symbol)).toEqual(['WMON']);
    expect(selectorList({ tokens, registry, query: 'dollar' }).held.map((r) => r.symbol)).toEqual(['USDC']);
  });

  it('a pasted address not in the list surfaces as pastedAddress; a known one does not', () => {
    const unknown = '0x00000000000000000000000000000000000000b2';
    expect(selectorList({ tokens, registry, query: unknown }).pastedAddress).toBe(unknown);
    expect(selectorList({ tokens, registry, query: USDC }).pastedAddress).toBeUndefined();
    // A known address typed as the query still matches its row.
    expect(selectorList({ tokens, registry, query: USDC.toLowerCase() }).held.map((r) => r.symbol)).toEqual(['USDC']);
  });

  it('excludeNative removes MON; accept narrows the list', () => {
    const l = selectorList({ tokens, registry, query: '', excludeNative: true });
    expect(l.held.map((r) => r.symbol)).toEqual(['USDC', 'PEPEM']);
    const only = selectorList({ tokens, registry, query: '', accept: (r) => r.symbol === 'USDC' });
    expect(only.held.map((r) => r.symbol)).toEqual(['USDC']);
    expect(only.rest).toEqual([]);
  });
});
