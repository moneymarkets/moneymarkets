import { describe, expect, it } from 'vitest';
import { MAINNET } from '@tradepro/core';
import type { Address } from 'viem';
import type { WalletTokenEntry } from '../useAccountBalances';
import {
  marginHoldings,
  pricedTotal,
  splitListed,
  tokenByAddress,
  unlistedGroupState,
  walletHasFunds,
  walletHoldings,
} from './holdingsModel.js';
import { withAddedToken } from './addedTokens.js';

/**
 * G1: a token received by airdrop and absent from every list appears under Unlisted
 * with its contract address; adding a token by address renders it; the total excludes
 * unpriced tokens and says how many. Real addresses for listed tokens (the address
 * book); the airdrop is a fixture address no list names, which is the point.
 */

const AIRDROP = '0x00000000000000000000000000000000000000b1' as Address;

function entry(partial: Partial<WalletTokenEntry> & { address: Address; symbol: string }): WalletTokenEntry {
  // v2.1: entries carry the token's full name; the symbol stands in for fixtures.
  const decimals = partial.decimals ?? 18;
  return {
    name: partial.symbol,
    decimals,
    wallet: { value: 0n, decimals },
    margin: { value: 0n, decimals },
    usd: { price: null, wallet: null, margin: null, total: null },
    priceSource: 'none',
    change24h: null,
    iconUrl: null,
    listed: true,
    ...partial,
  };
}

const usdc = entry({
  address: MAINNET.tokens.USDC.address,
  symbol: 'USDC',
  decimals: 6,
  wallet: { value: 1_500_000n, decimals: 6 },
  usd: { price: { value: 1_000_000n, decimals: 6 }, wallet: { value: 1_500_000n, decimals: 6 }, margin: null, total: { value: 1_500_000n, decimals: 6 } },
  priceSource: 'par',
});
const airdrop = entry({
  address: AIRDROP,
  symbol: 'AIR',
  wallet: { value: 42n * 10n ** 18n, decimals: 18 },
  listed: false,
});
const dust = entry({ address: MAINNET.tokens.WMON.address, symbol: 'WMON' }); // held nowhere

describe('an airdropped token no list names', () => {
  it('is held, so it is a wallet holding like any other', () => {
    expect(walletHoldings([usdc, airdrop, dust]).map((t) => t.symbol)).toEqual(['USDC', 'AIR']);
    expect(walletHasFunds([dust, airdrop])).toBe(true);
    expect(walletHasFunds([dust])).toBe(false);
  });

  it('lands in the Unlisted group with its contract address, collapsed while Hide unlisted is on', () => {
    const state = unlistedGroupState([usdc, airdrop, dust], { hideUnlisted: true });
    expect(state).toEqual({
      count: 1,
      collapsed: true,
      rows: [{ symbol: 'AIR', address: AIRDROP, wallet: airdrop.wallet, margin: airdrop.margin }],
    });
    expect(unlistedGroupState([usdc, airdrop], { hideUnlisted: false }).collapsed).toBe(false);
  });

  it('is not in the listed group, and nothing is deleted: split keeps every entry', () => {
    const { listed, unlisted } = splitListed([usdc, airdrop, dust]);
    expect(listed.map((t) => t.symbol)).toEqual(['USDC', 'WMON']);
    expect(unlisted.map((t) => t.symbol)).toEqual(['AIR']);
  });

  it('has no price, so the total excludes it and counts it', () => {
    expect(pricedTotal([usdc, airdrop, dust])).toEqual({ totalUsd: 1_500_000n, unpricedCount: 1 });
  });
});

describe('adding a token by address', () => {
  it('appends a checksummed address once and refuses a non-address', () => {
    const once = withAddedToken([], AIRDROP);
    expect(once.map((a) => a.toLowerCase())).toEqual([AIRDROP.toLowerCase()]);
    // Checksummed on the way in, so the same address in any case is one entry.
    expect(once[0]).not.toBe(AIRDROP);
    expect(withAddedToken(once, AIRDROP.toUpperCase().replace('0X', '0x'))).toEqual(once);
    expect(() => withAddedToken([], 'not-an-address')).toThrow();
  });

  it('once the balance read includes it, the row is found by address', () => {
    expect(tokenByAddress([usdc, airdrop], AIRDROP)?.symbol).toBe('AIR');
    expect(tokenByAddress([usdc], AIRDROP)).toBeUndefined();
  });
});

describe('margin holdings', () => {
  it('is any token with a margin balance, listed or not', () => {
    const inMargin = entry({ address: AIRDROP, symbol: 'AIR', margin: { value: 1n, decimals: 18 }, listed: false });
    expect(marginHoldings([usdc, inMargin]).map((t) => t.symbol)).toEqual(['AIR']);
  });
});
