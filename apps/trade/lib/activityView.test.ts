import { describe, expect, it } from 'vitest';
import { MAINNET } from '@tradepro/core';
import type { Address } from 'viem';
import type { ActivityRow } from './activityStore';
import { activityRowView } from './activityView.js';
import type { WalletTokenEntry } from './useAccountBalances';

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

const tokens = [
  entry({ address: MAINNET.tokens.USDC.address, symbol: 'USDC', decimals: 6, iconUrl: 'https://dsvxs4ecepqgj.cloudfront.net/usdc.png' }),
  entry({ address: AIRDROP, symbol: 'AIR', listed: false }),
];

describe('activityRowView (spec E4)', () => {
  it('a send of an unlisted token carries its address, resolves to it, and is marked unverified', () => {
    const row: ActivityRow = {
      id: '0xabc',
      kind: 'send',
      summary: 'Sent 1.5 AIR',
      amount: (15n * 10n ** 17n).toString(),
      decimals: 18,
      symbol: 'AIR',
      token: AIRDROP,
      at: 0,
    };
    expect(activityRowView(row, tokens)).toEqual({
      title: 'Sent 1.5 AIR',
      amountText: '1.500000 AIR',
      symbol: 'AIR',
      iconUrl: null,
      address: AIRDROP,
      unverified: true,
    });
  });

  it('a listed token gets its registry icon and no chip; the amount is at display precision', () => {
    const row: ActivityRow = {
      id: '0xdef',
      kind: 'move',
      summary: 'Moved 2.00 USDC',
      amount: '2000000',
      decimals: 6,
      symbol: 'USDC',
      at: 0,
    };
    expect(activityRowView(row, tokens)).toMatchObject({
      amountText: '2.000000 USDC',
      iconUrl: 'https://dsvxs4ecepqgj.cloudfront.net/usdc.png',
      unverified: false,
    });
  });

  it('a row about a token the account no longer holds is neither iconed nor flagged', () => {
    const row: ActivityRow = { id: 'x', kind: 'cancel', summary: 'Cancelled an order', at: 0 };
    expect(activityRowView(row, tokens)).toEqual({ title: 'Cancelled an order', iconUrl: null, unverified: false });
  });
});
