import { describe, expect, it } from 'vitest';
import type { Address, Hex, Log } from 'viem';
import { filledFromReceipt, type MarketParams } from '@tradepro/core';
import { applyFillDelta } from './useAccountBalances.js';

/**
 * ITEM 6 — the balance the ticket shows the instant an order confirms has to match
 * what a fresh `/api/account/balances` read would have shown, because that read is
 * still coming right behind it as the consistency check and the two must agree.
 *
 * The log below is copied byte-for-byte from the same real capture
 * `packages/core/src/kuru/__fixtures__/logs.ts` uses for `REAL_TRADE_LOG` (tx
 * 0x888e1e5db88c5dc09ed9090f4d8bfd18fc8e6281a6f5f6b0d48692911387383d, block
 * 101267808, MON/USDC on Monad mainnet, captured 2026-09-02). Copied rather than
 * imported: that fixture lives under core's `__fixtures__`, which the package does
 * not publish past `dist/index.js` for another package to import.
 */
const MON_USDC_MARKET = '0x065C9d28E428A0db40191a54d33d5b7c71a9C394' as Address;

const MON_USDC_PARAMS: MarketParams = {
  pricePrecision: 100_000_000n,
  sizePrecision: 10_000_000_000n,
  baseAsset: '0x0000000000000000000000000000000000000000' as Address,
  baseDecimals: 18,
  quoteAsset: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603' as Address,
  quoteDecimals: 6,
  tickSize: 100n,
  minSize: 2_000_000_000_000n,
  maxSize: 2_000_000_000_000_000_000n,
  takerFeeBps: 0n,
  makerFeeBps: 0n,
};

const REAL_TRADE_LOG = {
  address: MON_USDC_MARKET,
  topics: ['0xf16924fba1c18c108912fcacaac7450c98eb3f2d8c0a3cdf3df7066c08f21581'] as [Hex],
  data:
    '0x00000000000000000000000000000000000000000000000000000000056792fb' +
    '00000000000000000000000034ae4d081c0d46b23ebf5292c1be4e45f8a73fc5' +
    '0000000000000000000000000000000000000000000000000000000000000001' +
    '000000000000000000000000000000000000000000000000005d2c6875e12000' +
    '000000000000000000000000000000000000000000000000000307b6a9fbec75' +
    '00000000000000000000000080c74517bcc2d67ffe02d3ed886796272f647210' +
    '000000000000000000000000f380bf747b61ced8afb949337acb23e0aa4043ec' +
    '00000000000000000000000000000000000000000000000000005b63be4c5f8b',
  blockNumber: 101_267_808n,
  transactionHash: '0x888e1e5db88c5dc09ed9090f4d8bfd18fc8e6281a6f5f6b0d48692911387383d' as Hex,
  logIndex: 4,
  transactionIndex: 0,
  blockHash: '0x'.padEnd(66, '0') as Hex,
  removed: false,
} as unknown as Log<bigint, number, false>;

/** The taker of the real fill above (verified against the margin ledger, per fills.ts). */
const TAKER = '0x80c74517BCC2D67fFE02D3ED886796272F647210' as Address;
/** filledSize 100_483_952_566_155n / 1e10 = 10,048.395... MON at 0.026226 ≈ 263.53 USDC. */

describe('ITEM 6 — applying a real confirmed fill matches what a fresh read would show', () => {
  it('debits the quote asset and credits the base asset by exactly what the receipt decoded', () => {
    const filled = filledFromReceipt(
      [REAL_TRADE_LOG] as Parameters<typeof filledFromReceipt>[0],
      MON_USDC_MARKET,
      TAKER,
      MON_USDC_PARAMS,
    );
    expect(filled).toBeDefined();
    expect(filled?.baseFilled).toBeGreaterThan(0n);
    expect(filled?.quoteFilled).toBeGreaterThan(263_000_000n);
    expect(filled?.quoteFilled).toBeLessThan(264_000_000n);

    // The margin snapshot the ticket already has in memory before the fill confirms.
    const before = {
      AUSD: { value: 0n, decimals: 6 },
      USDC: { value: 1_000_000_000n, decimals: 6 }, // 1,000 USDC
      USDT0: { value: 0n, decimals: 6 },
      MON: { value: 0n, decimals: 18 },
    };
    const beforeBase = { value: 0n, decimals: 18 };

    // The taker bought MON with USDC, so quote decreases and base increases — exactly
    // the same arithmetic `TradeScreen.tsx`'s `onPlaced` applies from this same
    // `filledFromReceipt` call.
    const { margin: after, marginBase: afterBase } = applyFillDelta(before, beforeBase, {
      quoteSymbol: 'USDC',
      quoteDelta: -(filled?.quoteFilled ?? 0n),
      baseDelta: filled?.baseFilled ?? 0n,
    });

    // What a fresh `/api/account/balances` read would show after the same fill: the
    // starting balance moved by exactly the receipt's own decoded amounts, nothing
    // rounded or approximated on the way.
    expect(after.USDC.value).toBe(before.USDC.value - (filled?.quoteFilled ?? 0n));
    expect(afterBase?.value).toBe(filled?.baseFilled);
    // The other tokens are untouched — a MON/USDC fill has no reason to move AUSD.
    expect(after.AUSD.value).toBe(0n);
    expect(after.USDT0.value).toBe(0n);
    expect(after.MON.value).toBe(0n);
  });

  it('clamps at zero rather than going negative if a delta ever overshoots', () => {
    const before = {
      AUSD: { value: 0n, decimals: 6 },
      USDC: { value: 10n, decimals: 6 },
      USDT0: { value: 0n, decimals: 6 },
      MON: { value: 0n, decimals: 18 },
    };
    const { margin: after } = applyFillDelta(before, undefined, {
      quoteSymbol: 'USDC',
      quoteDelta: -1_000n,
      baseDelta: 0n,
    });
    expect(after.USDC.value).toBe(0n);
  });

  it('leaves marginBase untouched when the hook was not tracking a base token', () => {
    const before = {
      AUSD: { value: 0n, decimals: 6 },
      USDC: { value: 1_000n, decimals: 6 },
      USDT0: { value: 0n, decimals: 6 },
      MON: { value: 0n, decimals: 18 },
    };
    const { marginBase } = applyFillDelta(before, undefined, {
      quoteSymbol: 'USDC',
      quoteDelta: -1n,
      baseDelta: 5n,
    });
    expect(marginBase).toBeUndefined();
  });
});
