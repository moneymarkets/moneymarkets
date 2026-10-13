import { describe, expect, it } from 'vitest';
import { baseSizeFor, quoteNotionalFor } from './format';

/**
 * Which asset the amount field is asking for, per market, per side (item 2).
 *
 * The ticket asked for the **quote** asset on both sides. Selling MON on MON/USDC
 * therefore read "Amount (USDC)" above a line reading "Available 14.78 MON": two units
 * for one number, and whichever the user typed, one of the two labels was wrong.
 *
 * The rule this locks down is one sentence — **buy spends the quote asset, sell spends
 * the base asset** — and it is asserted for every live market so a new market cannot
 * quietly inherit the old assumption. The conversion is checked in both directions,
 * because the field that is not typed into is derived and has to come back to where it
 * started.
 */

/**
 * The live markets, with the real decimals `getMarketParams()` reports for each: the
 * four this app trades, then the two it shows disabled. WBTC/AUSD is not a market of
 * either kind and is not a market this app trades (`reports/MARKETS-VERIFIED.md`).
 */
const MARKETS = [
  { symbol: 'MON/USDC', base: 'MON', quote: 'USDC', baseDecimals: 18, quoteDecimals: 6 },
  { symbol: 'WETH/USDC', base: 'WETH', quote: 'USDC', baseDecimals: 18, quoteDecimals: 6 },
  { symbol: 'cbBTC/USDC', base: 'cbBTC', quote: 'USDC', baseDecimals: 8, quoteDecimals: 6 },
  { symbol: 'XAUt0/USDC', base: 'XAUt0', quote: 'USDC', baseDecimals: 6, quoteDecimals: 6 },
  { symbol: 'MON/AUSD', base: 'MON', quote: 'AUSD', baseDecimals: 18, quoteDecimals: 6 },
  { symbol: 'AUSD/USDC', base: 'AUSD', quote: 'USDC', baseDecimals: 6, quoteDecimals: 6 },
] as const;

/** The rule under test, extracted exactly as the ticket applies it. */
function amountUnitFor(market: (typeof MARKETS)[number], side: 'buy' | 'sell') {
  const spendsBase = side === 'sell';
  return {
    unit: spendsBase ? market.base : market.quote,
    decimals: spendsBase ? market.baseDecimals : market.quoteDecimals,
    /** The unit shown on the conversion line — always the one not typed. */
    converted: spendsBase ? market.quote : market.base,
  };
}

describe('the amount field follows the side', () => {
  it.each(MARKETS)('$symbol buy asks for the quote asset', (market) => {
    const f = amountUnitFor(market, 'buy');
    expect(f.unit).toBe(market.quote);
    expect(f.decimals).toBe(market.quoteDecimals);
    expect(f.converted).toBe(market.base);
  });

  it.each(MARKETS)('$symbol sell asks for the base asset', (market) => {
    const f = amountUnitFor(market, 'sell');
    expect(f.unit).toBe(market.base);
    expect(f.decimals).toBe(market.baseDecimals);
    expect(f.converted).toBe(market.quote);
  });

  it.each(MARKETS)('$symbol never asks for the same unit on both sides', (market) => {
    // The bug in one line: it did.
    expect(amountUnitFor(market, 'buy').unit).not.toBe(amountUnitFor(market, 'sell').unit);
  });

  it('asks for MON when selling MON, which is the case that was wrong', () => {
    const monUsdc = MARKETS[0];
    expect(amountUnitFor(monUsdc, 'sell').unit).toBe('MON');
    expect(amountUnitFor(monUsdc, 'sell').unit).not.toBe('USDC');
  });
});

describe('the conversion agrees with itself in both directions', () => {
  // The real MON/USDC bid at block 103,667,655: 0.023409 USDC per MON.
  const priceWire = 23_409_000_000_000_000n;

  it('a buy of 1.000000 USDC converts to a MON size and back', () => {
    const typedQuote = 1_000_000n; // 1.000000 USDC
    const size = baseSizeFor(typedQuote, priceWire, 6, 18);
    expect(size).toBeGreaterThan(0n);
    const roundTrip = quoteNotionalFor(size, priceWire, 6, 18);
    // Integer division loses at most one base unit of the quote.
    expect(roundTrip).toBeGreaterThanOrEqual(typedQuote - 1n);
    expect(roundTrip).toBeLessThanOrEqual(typedQuote);
  });

  it('a sell of 1 MON converts to a USDC notional and back', () => {
    const typedBase = 1_000_000_000_000_000_000n; // 1 MON
    const notional = quoteNotionalFor(typedBase, priceWire, 6, 18);
    expect(notional).toBe(23_409n); // 0.023409 USDC, exactly
    const roundTrip = baseSizeFor(notional, priceWire, 6, 18);
    expect(roundTrip).toBeGreaterThan((typedBase * 99n) / 100n);
  });

  it('has no conversion at all without a price, rather than a wrong one', () => {
    expect(baseSizeFor(1_000_000n, 0n, 6, 18)).toBe(0n);
  });
});

describe('the percentage buttons spend from the right balance', () => {
  const pct = (spendable: bigint, p: number) => (p === 100 ? spendable : (spendable * BigInt(p)) / 100n);

  it('a buy takes its percentage of the quote balance', () => {
    const usdcAvailable = 1_056_280n; // the owner's real margin USDC
    expect(pct(usdcAvailable, 25)).toBe(264_070n);
    expect(pct(usdcAvailable, 50)).toBe(528_140n);
    expect(pct(usdcAvailable, 100)).toBe(usdcAvailable);
  });

  it('a sell takes its percentage of the base balance', () => {
    const monAvailable = 14_782_878_000_000_000_000n; // the owner's real margin MON
    expect(pct(monAvailable, 25)).toBe(3_695_719_500_000_000_000n);
    expect(pct(monAvailable, 100)).toBe(monAvailable);
  });

  it('Max is the whole balance and never more', () => {
    const balance = 7n;
    // Deliberately a figure that does not divide by four: Max must not round up.
    expect(pct(balance, 100)).toBe(balance);
    expect(pct(balance, 75)).toBeLessThan(balance);
  });
});
