import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import {
  allPriced,
  isMoveOutDisabled,
  segmentQuantity,
  segmentUsd,
  sortHoldings,
  totalUsd,
  visibleHoldings,
  waitingToken,
  type WalletTokenEntry,
} from './holdings';

const addr = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}` as Address;

function token(input: {
  symbol: string;
  wallet?: bigint;
  margin?: bigint;
  usdWallet?: bigint | null;
  usdMargin?: bigint | null;
  usdTotal?: bigint | null;
  priceSource?: WalletTokenEntry['priceSource'];
  change24h?: number | null;
}): WalletTokenEntry {
  const wallet = input.wallet ?? 0n;
  const margin = input.margin ?? 0n;
  return {
    symbol: input.symbol,
    name: input.symbol,
    address: addr(1),
    decimals: 6,
    wallet: { value: wallet, decimals: 6 },
    margin: { value: margin, decimals: 6 },
    usd: {
      price: null,
      wallet: input.usdWallet === undefined || input.usdWallet === null ? null : { value: input.usdWallet, decimals: 6 },
      margin: input.usdMargin === undefined || input.usdMargin === null ? null : { value: input.usdMargin, decimals: 6 },
      total: input.usdTotal === undefined || input.usdTotal === null ? null : { value: input.usdTotal, decimals: 6 },
    },
    priceSource: input.priceSource ?? 'par',
    change24h: input.change24h ?? null,
    iconUrl: null,
    listed: true,
  };
}

describe('segmentQuantity / segmentUsd', () => {
  it('reads the right side for each segment', () => {
    const t = token({ symbol: 'USDC', wallet: 5_000_000n, margin: 2_000_000n, usdWallet: 5_000_000n, usdMargin: 2_000_000n, usdTotal: 7_000_000n });
    expect(segmentQuantity(t, 'wallet')).toBe(5_000_000n);
    expect(segmentQuantity(t, 'trading')).toBe(2_000_000n);
    expect(segmentQuantity(t, 'all')).toBe(7_000_000n);
    expect(segmentUsd(t, 'wallet')).toBe(5_000_000n);
    expect(segmentUsd(t, 'trading')).toBe(2_000_000n);
    expect(segmentUsd(t, 'all')).toBe(7_000_000n);
  });

  it('an unpriced token reads undefined, never a fabricated zero', () => {
    const t = token({ symbol: 'USDT0', wallet: 3_000_000n, priceSource: 'none' });
    expect(segmentUsd(t, 'wallet')).toBeUndefined();
    expect(segmentQuantity(t, 'wallet')).toBe(3_000_000n);
  });
});

describe('visibleHoldings', () => {
  it('drops rows with nothing under the segment', () => {
    const rows = [
      token({ symbol: 'USDC', wallet: 1_000_000n, usdWallet: 1_000_000n }),
      token({ symbol: 'AUSD', wallet: 0n, margin: 5_000_000n }),
    ];
    expect(visibleHoldings(rows, 'wallet', false).map((r) => r.symbol)).toEqual(['USDC']);
  });

  it('hide-small drops a priced row under a dollar, keeps an unpriced one', () => {
    const rows = [
      token({ symbol: 'DUST', wallet: 1n, usdWallet: 500_000n }), // $0.50
      token({ symbol: 'BIG', wallet: 1n, usdWallet: 5_000_000n }), // $5.00
      token({ symbol: 'NOPRICE', wallet: 1n, priceSource: 'none' }),
    ];
    const visible = visibleHoldings(rows, 'wallet', true).map((r) => r.symbol);
    expect(visible).toContain('BIG');
    expect(visible).toContain('NOPRICE');
    expect(visible).not.toContain('DUST');
  });

  it('hide-small off shows everything with a positive quantity', () => {
    const rows = [token({ symbol: 'DUST', wallet: 1n, usdWallet: 1n })];
    expect(visibleHoldings(rows, 'wallet', false)).toHaveLength(1);
  });
});

describe('sortHoldings', () => {
  it('sorts by USD value descending, unpriced last', () => {
    const rows = [
      token({ symbol: 'SMALL', wallet: 1n, usdWallet: 1_000_000n }),
      token({ symbol: 'BIG', wallet: 1n, usdWallet: 9_000_000n }),
      token({ symbol: 'NOPRICE', wallet: 1n, priceSource: 'none' }),
    ];
    expect(sortHoldings(rows, 'wallet').map((r) => r.symbol)).toEqual(['BIG', 'SMALL', 'NOPRICE']);
  });
});

describe('totalUsd / allPriced', () => {
  it('sums only what is priced', () => {
    const rows = [
      token({ symbol: 'A', wallet: 1n, usdTotal: 3_000_000n }),
      token({ symbol: 'B', wallet: 1n, usdTotal: 4_000_000n }),
      token({ symbol: 'C', wallet: 1n, priceSource: 'none' }),
    ];
    expect(totalUsd(rows)).toBe(7_000_000n);
    expect(allPriced(rows)).toBe(false);
  });

  it('allPriced is true when every held token has a price, or holds nothing', () => {
    const rows = [
      token({ symbol: 'A', wallet: 1n, usdTotal: 3_000_000n }),
      token({ symbol: 'B', wallet: 0n, margin: 0n, priceSource: 'none' }),
    ];
    expect(allPriced(rows)).toBe(true);
  });
});

describe('waitingToken', () => {
  it('undefined when nothing sits in the wallet', () => {
    const rows = [token({ symbol: 'USDC', wallet: 0n, margin: 5_000_000n })];
    expect(waitingToken(rows)).toBeUndefined();
  });

  it('the largest wallet balance by USD value when more than one qualifies', () => {
    const rows = [
      token({ symbol: 'SMALL', wallet: 1_000_000n, usdWallet: 1_000_000n }),
      token({ symbol: 'BIG', wallet: 5_000_000n, usdWallet: 5_000_000n }),
    ];
    expect(waitingToken(rows)?.symbol).toBe('BIG');
  });

  it('a real, positive wallet balance is required — a margin-only holding never waits', () => {
    const rows = [token({ symbol: 'AUSD', wallet: 0n, margin: 10_000_000n, usdMargin: 10_000_000n })];
    expect(waitingToken(rows)).toBeUndefined();
  });
});

describe('isMoveOutDisabled', () => {
  it('nothing — MON moves out as WMON since D3 (the assertWmonWrap policy line now exists)', () => {
    expect(isMoveOutDisabled('MON')).toBe(false);
    expect(isMoveOutDisabled('USDC')).toBe(false);
    expect(isMoveOutDisabled('AUSD')).toBe(false);
    expect(isMoveOutDisabled('WMON')).toBe(false);
  });
});
