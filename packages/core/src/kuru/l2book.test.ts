import { describe, expect, it } from 'vitest';
import { decodeL2Book, L2BookLayoutError } from './l2book.js';
import { isTradable, normalizeBook } from './book.js';
import { MON_USDC_PARAMS } from './__fixtures__/logs.js';
import {
  MON_USDC_L2_BEST_ASK_WIRE,
  MON_USDC_L2_BEST_BID_WIRE,
  MON_USDC_L2_BLOCK,
  MON_USDC_L2_BOOK,
} from './__fixtures__/l2book.js';
import type { Address } from 'viem';

const MARKET = '0x065C9d28E428A0db40191a54d33d5b7c71a9C394' as Address;

describe('decodeL2Book', () => {
  it('reads the block number from the first word', () => {
    expect(decodeL2Book(MON_USDC_L2_BOOK).blockNumber).toBe(MON_USDC_L2_BLOCK);
  });

  it('splits bids from asks on the zero word', () => {
    const book = decodeL2Book(MON_USDC_L2_BOOK);
    expect(book.bids).toHaveLength(6);
    expect(book.asks).toHaveLength(6);
    expect(book.bids[0]).toEqual({ price: 2_543_200n, size: 983_440_000_000_000n });
    expect(book.asks[0]).toEqual({ price: 2_543_900n, size: 983_440_000_000_000n });
  });

  it('rejects a blob that is not whole words', () => {
    expect(() => decodeL2Book('0x1234')).toThrow(L2BookLayoutError);
  });

  it('rejects a blob with no bid/ask separator', () => {
    expect(() => decodeL2Book(`0x${'11'.repeat(32)}`)).toThrow(L2BookLayoutError);
  });
});

describe('contract-getL2Book normalization', () => {
  it('scales prices from pricePrecision to the 1e18 wire scale', () => {
    const decoded = decodeL2Book(MON_USDC_L2_BOOK);
    const book = normalizeBook({
      market: MARKET,
      source: 'contract-getL2Book',
      state: 'finalized',
      params: MON_USDC_PARAMS,
      bids: decoded.bids,
      asks: decoded.asks,
      bestBid: MON_USDC_L2_BEST_BID_WIRE,
      bestAsk: MON_USDC_L2_BEST_ASK_WIRE,
      receivedAt: 1_000,
    });

    // 2543200 pricePrecision units == 0.025432 == the bestBidAsk() reading.
    expect(book.bids[0]?.price).toBe(MON_USDC_L2_BEST_BID_WIRE);
    expect(book.asks[0]?.price).toBe(MON_USDC_L2_BEST_ASK_WIRE);
    expect(book.validity).toBe('ok');
    expect(isTradable(book, 1_000)).toBe(true);
  });

  it('converts sizes out of sizePrecision into base units', () => {
    const decoded = decodeL2Book(MON_USDC_L2_BOOK);
    const book = normalizeBook({
      market: MARKET,
      source: 'contract-getL2Book',
      state: 'finalized',
      params: MON_USDC_PARAMS,
      bids: decoded.bids,
      asks: [],
    });
    // 983440000000000 sizePrecision (1e10) units == 98,344 MON == 98344e18 base units.
    expect(book.bids[0]?.size).toBe(98_344n * 10n ** 18n);
  });

  it('marks the book INVALID when bestBidAsk crosses (I1)', () => {
    const decoded = decodeL2Book(MON_USDC_L2_BOOK);
    const book = normalizeBook({
      market: MARKET,
      source: 'contract-getL2Book',
      state: 'finalized',
      params: MON_USDC_PARAMS,
      bids: decoded.bids,
      asks: decoded.asks,
      bestBid: MON_USDC_L2_BEST_ASK_WIRE,
      bestAsk: MON_USDC_L2_BEST_BID_WIRE,
      receivedAt: 1_000,
    });
    expect(book.validity).toBe('INVALID');
    expect(isTradable(book, 1_000)).toBe(false);
  });
});
