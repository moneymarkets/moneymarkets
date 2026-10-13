import { describe, expect, it } from 'vitest';
import { MAINNET, MARKET_CANDIDATES } from '@tradepro/core';
import type { Address } from 'viem';
import {
  baseTokens,
  buildRegistry,
  kuruMarketTokens,
  logoHosts,
  mergeSources,
  NATIVE_MON,
  verifyWithContract,
  type ContractMeta,
  type ContractMetaReader,
  type MetaStore,
  type TokenListSource,
} from './tokenRegistry.js';
import { flowTokenSource } from './flowTokenSource.js';

/**
 * Registry rules (spec A1): sources merge in a fixed order, an address named by several
 * sources is one entry naming all of them, and symbol/decimals are the contract's, never
 * a list's. Real addresses only: the market candidates and the address book, both
 * verified on chain 143.
 */

class FakeStore implements MetaStore {
  readonly rows = new Map<string, { symbol: string; name: string; decimals: number }>();
  getMeta(addresses: readonly Address[]) {
    const out = new Map<string, { symbol: string; name: string; decimals: number }>();
    for (const a of addresses) {
      const r = this.rows.get(a.toLowerCase());
      if (r) out.set(a.toLowerCase(), r);
    }
    return out;
  }
  putMeta(rows: readonly { address: Address; symbol: string; name: string; decimals: number }[]) {
    for (const r of rows) this.rows.set(r.address.toLowerCase(), { symbol: r.symbol, name: r.name, decimals: r.decimals });
  }
}

const usdc = MAINNET.tokens.USDC.address;
const ausd = MAINNET.tokens.AUSD.address;
const wmon = MAINNET.tokens.WMON.address;

function readerFrom(answers: Record<string, ContractMeta | null>): ContractMetaReader & { calls: Address[][] } {
  const calls: Address[][] = [];
  const reader: ContractMetaReader = async (addresses) => {
    calls.push([...addresses]);
    const out = new Map<string, ContractMeta | null>();
    for (const a of addresses) {
      const key = a.toLowerCase();
      if (key in answers) out.set(key, answers[key] ?? null);
    }
    return out;
  };
  return Object.assign(reader, { calls });
}

describe('mergeSources: fixed order, one entry per address, every source recorded', () => {
  it('USDC, named by the Kuru market list and the base set, is one entry with both sources in order', () => {
    const merged = mergeSources([
      { name: 'kuru-market', tokens: kuruMarketTokens(MARKET_CANDIDATES) },
      { name: 'kuru-flow', tokens: [] },
      { name: 'base', tokens: baseTokens() },
    ]);
    const entry = merged.find((m) => m.address.toLowerCase() === usdc.toLowerCase());
    expect(entry?.sources).toEqual(['kuru-market', 'base']);
    expect(merged.filter((m) => m.address.toLowerCase() === usdc.toLowerCase())).toHaveLength(1);
  });

  it('a token only the base set names carries only that source', () => {
    const merged = mergeSources([
      { name: 'kuru-market', tokens: kuruMarketTokens(MARKET_CANDIDATES) },
      { name: 'base', tokens: baseTokens() },
    ]);
    // USDT0 is on no Kuru book (balances route doc comment, confirmed live).
    const usdt0 = merged.find((m) => m.address.toLowerCase() === MAINNET.tokens.USDT0.address.toLowerCase());
    expect(usdt0?.sources).toEqual(['base']);
  });
});

describe('verifyWithContract: the contract wins over any list', () => {
  it("a source's wrong symbol and decimals are replaced by the contract's answer", async () => {
    const store = new FakeStore();
    const reader = readerFrom({ [usdc.toLowerCase()]: { symbol: 'USDC', name: 'USD Coin', decimals: 6 } });
    const entries = await verifyWithContract(
      mergeSources([{ name: 'kuru-flow', tokens: [{ address: usdc, symbol: 'NOT-USDC', decimals: 18 }] }]),
      store,
      reader,
    );
    expect(entries).toEqual([
      { address: usdc, symbol: 'USDC', name: 'USD Coin', decimals: 6, sources: ['kuru-flow'], verified: true },
    ]);
    // And the answer is remembered, so the next build reads nothing.
    expect(store.rows.get(usdc.toLowerCase())).toEqual({ symbol: 'USDC', name: 'USD Coin', decimals: 6 });
  });

  it('an address already in the store is not read again', async () => {
    const store = new FakeStore();
    store.putMeta([{ address: ausd, symbol: 'AUSD', name: 'Agora USD', decimals: 6 }]);
    const reader = readerFrom({});
    const entries = await verifyWithContract(
      mergeSources([{ name: 'base', tokens: [{ address: ausd, symbol: 'AUSD', decimals: 6 }] }]),
      store,
      reader,
    );
    expect(reader.calls).toEqual([]);
    expect(entries[0]).toMatchObject({ symbol: 'AUSD', verified: true });
  });

  it('an address whose decimals() reverts is not an ERC-20 and is dropped, whoever listed it', async () => {
    const notAToken = '0x1111111111111111111111111111111111111111' as Address;
    const store = new FakeStore();
    const reader = readerFrom({ [notAToken]: null });
    const entries = await verifyWithContract(
      mergeSources([{ name: 'kuru-flow', tokens: [{ address: notAToken, symbol: 'SCAM' }] }]),
      store,
      reader,
    );
    expect(entries).toEqual([]);
  });

  it('a read that did not answer keeps the placeholder, marked unverified, rather than dropping the token', async () => {
    const store = new FakeStore();
    const reader = readerFrom({}); // transport gave nothing back
    const entries = await verifyWithContract(
      mergeSources([{ name: 'base', tokens: [{ address: wmon, symbol: 'WMON', decimals: 18 }] }]),
      store,
      reader,
    );
    expect(entries[0]).toMatchObject({ symbol: 'WMON', decimals: 18, verified: false });
  });

  it('native MON has no contract and keeps the address-book facts, verified', async () => {
    const entries = await verifyWithContract(
      mergeSources([{ name: 'base', tokens: [{ address: NATIVE_MON, symbol: 'MON', decimals: 18 }] }]),
      new FakeStore(),
      readerFrom({}),
    );
    expect(entries[0]).toMatchObject({ address: NATIVE_MON, symbol: 'MON', decimals: 18, verified: true });
  });
});

describe('buildRegistry: the whole pipeline with the real source lists', () => {
  it('a source that answers nothing (the UNVERIFIED Flow list today) leaves the registry correct', async () => {
    const answers: Record<string, ContractMeta> = {};
    for (const t of [...kuruMarketTokens(), ...baseTokens()]) {
      if (t.address.toLowerCase() !== NATIVE_MON) {
        answers[t.address.toLowerCase()] = { symbol: t.symbol ?? '', name: t.symbol ?? '', decimals: t.decimals ?? 18 };
      }
    }
    const kuru: TokenListSource = { name: 'kuru-market', async list() { return kuruMarketTokens(); } };
    const base: TokenListSource = { name: 'base', async list() { return baseTokens(); } };
    const entries = await buildRegistry({
      sources: [kuru, flowTokenSource, base],
      store: new FakeStore(),
      readContractMeta: readerFrom(answers),
    });
    const symbols = entries.map((e) => e.symbol);
    for (const s of ['USDC', 'AUSD', 'USDT0', 'MON', 'WMON', 'WETH', 'cbBTC', 'XAUt0']) expect(symbols).toContain(s);
    expect(entries.every((e) => e.verified)).toBe(true);
    expect(entries.some((e) => e.sources.includes('kuru-flow'))).toBe(false);
  });

  it('a source that throws contributes nothing and does not fail the build', async () => {
    const broken: TokenListSource = { name: 'kuru-flow', async list() { throw new Error('down'); } };
    const base: TokenListSource = { name: 'base', async list() { return [{ address: usdc, symbol: 'USDC', decimals: 6 }]; } };
    const entries = await buildRegistry({
      sources: [broken, base],
      store: new FakeStore(),
      readContractMeta: readerFrom({ [usdc.toLowerCase()]: { symbol: 'USDC', name: 'USD Coin', decimals: 6 } }),
    });
    expect(entries.map((e) => e.symbol)).toEqual(['USDC']);
  });

  it('logo URLs come from the market metadata by address, and logoHosts lists each host once', async () => {
    const logos = new Map([[usdc.toLowerCase(), 'https://dsvxs4ecepqgj.cloudfront.net/usdc.png'], [ausd.toLowerCase(), 'https://dsvxs4ecepqgj.cloudfront.net/ausd.png']]);
    const base: TokenListSource = {
      name: 'base',
      async list() {
        return [
          { address: usdc, symbol: 'USDC', decimals: 6 },
          { address: ausd, symbol: 'AUSD', decimals: 6 },
        ];
      },
    };
    const entries = await buildRegistry({
      sources: [base],
      store: new FakeStore(),
      readContractMeta: readerFrom({
        [usdc.toLowerCase()]: { symbol: 'USDC', name: 'USD Coin', decimals: 6 },
        [ausd.toLowerCase()]: { symbol: 'AUSD', name: 'Agora USD', decimals: 6 },
      }),
      logoByAddress: logos,
    });
    expect(entries.map((e) => e.logoUrl)).toEqual([
      'https://dsvxs4ecepqgj.cloudfront.net/usdc.png',
      'https://dsvxs4ecepqgj.cloudfront.net/ausd.png',
    ]);
    expect(logoHosts(entries)).toEqual(['dsvxs4ecepqgj.cloudfront.net']);
  });
});
