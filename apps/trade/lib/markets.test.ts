import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MARKET,
  DISABLED_MARKETS,
  LIVE_MARKETS,
  MARKETS,
  TRADING_MARKETS,
  isKnownMarket,
  marketFor,
} from './markets';

/**
 * The catalogue has to carry a market that does not exist without ever letting it
 * reach the chain. These tests are the guard: a route handler that accepted
 * USDT0/AUSD would call `getMarketParams()` on nothing, and an empty answer drawn as
 * an empty book is indistinguishable from a real market nobody trades.
 *
 * It also has to carry exactly the eight markets verified this session — five
 * tradable, two shown-and-disabled, one not deployed — and nothing else. WBTC/AUSD is
 * not a candidate of any kind and must never appear. emo/MON is a trading market since
 * 2026-09-23, when the order cap started valuing MON at the MON/USDC mid.
 */

describe('the market catalogue', () => {
  it('covers exactly the eight verified markets, in role order', () => {
    expect(MARKETS.map((m) => m.symbol)).toEqual([
      'MON / USDC',
      'WETH / USDC',
      'cbBTC / USDC',
      'XAUt0 / USDC',
      'emo / MON',
      'MON / AUSD',
      'AUSD / USDC',
      'USDT0 / AUSD',
    ]);
  });

  it('never lists WBTC/AUSD', () => {
    const symbols = MARKETS.map((m) => m.symbol);
    expect(symbols).not.toContain('WBTC / AUSD');
  });

  it('lists emo/MON once, as a trading market quoted in MON, at its pinned address', () => {
    const emo = MARKETS.filter((m) => /emo/i.test(m.symbol));
    expect(emo).toHaveLength(1);
    expect(emo[0]?.role).toBe('trading');
    expect(emo[0]?.quote).toBe('MON');
    expect(emo[0]?.address?.toLowerCase()).toBe('0xe7a4f90369b48d8f5b61f2fd519ec563c11e4b2d');
  });

  it('marks the five trading markets with role "trading"', () => {
    expect(TRADING_MARKETS.map((m) => m.symbol)).toEqual([
      'MON / USDC',
      'WETH / USDC',
      'cbBTC / USDC',
      'XAUt0 / USDC',
      'emo / MON',
    ]);
    for (const market of TRADING_MARKETS) {
      expect(market.status).toBe('live');
      expect(market.address).toBeDefined();
    }
  });

  it('marks MON/AUSD and AUSD/USDC disabled, not hidden', () => {
    expect(DISABLED_MARKETS.map((m) => m.symbol)).toEqual(['MON / AUSD', 'AUSD / USDC']);
    for (const market of DISABLED_MARKETS) {
      // Still a real, readable book — Kuru still lists both.
      expect(market.status).toBe('live');
      expect(market.address).toBeDefined();
    }
  });

  it('marks USDT0/AUSD as not deployed and gives it no address', () => {
    const market = marketFor('usdt0-ausd');
    expect(market?.status).toBe('not-deployed');
    expect(market?.address).toBeUndefined();
    expect(market?.note).toMatch(/not been created/i);
  });

  it('refuses a market with no book at the route handlers', () => {
    expect(isKnownMarket('usdt0-ausd')).toBe(false);
    for (const market of LIVE_MARKETS) {
      expect(isKnownMarket(market.key)).toBe(true);
    }
  });

  it('never opens on a market that has no book, and never defaults to a disabled one', () => {
    expect(DEFAULT_MARKET.status).toBe('live');
    expect(DEFAULT_MARKET.role).toBe('trading');
    expect(DEFAULT_MARKET.address).toBeDefined();
    expect(DEFAULT_MARKET.symbol).toBe('MON / USDC');
  });

  it('resolves a market by address or by symbol', () => {
    const mon = MARKETS.find((m) => m.symbol === 'MON / AUSD');
    expect(marketFor(mon!.key)).toBe(mon);
    expect(marketFor('MON / AUSD')).toBe(mon);
    expect(marketFor('mon/ausd')).toBe(mon);
    expect(marketFor('not a market')).toBeUndefined();
  });

  it('gives every live market a checksummed address as its route key', () => {
    for (const market of LIVE_MARKETS) {
      expect(market.key).toBe(market.address);
      expect(market.key).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });
});
