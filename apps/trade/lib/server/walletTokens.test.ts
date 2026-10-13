import { describe, expect, it } from 'vitest';
import { MAINNET, TRADING_MARKET_CANDIDATES, type MarketCandidate } from '@tradepro/core';
import {
  readableTokenPlans,
  classifyMarketPrice,
  enumerateTokenSpecs,
  isUsdDenominated,
  NATIVE_MON,
  toUsd,
  toUsdPar,
  usdcQuotedMarkets,
  usdFromFlow,
} from './walletTokens.js';

/**
 * Wallet tab data layer (WALLET-IMPLEMENTATION.md section 3, section 9's pending
 * item). The owner's real, already-confirmed bug: the account holds cbBTC, WETH
 * and XAUt0 in margin today, and the old `/api/account/balances` shape —
 * `wallet`/`margin` fixed at `AUSD | USDC | USDT0 | MON` — has no field any of the
 * three could occupy. These tests use the app's real, live-verified
 * `TRADING_MARKET_CANDIDATES` and address book (`packages/core/src/chain/addresses.ts`,
 * `packages/core/src/kuru/liveMarkets.ts`) — no invented addresses anywhere.
 */

const ADDRESS_BOOK = {
  AUSD: MAINNET.tokens.AUSD,
  USDC: MAINNET.tokens.USDC,
  USDT0: MAINNET.tokens.USDT0,
  MON: MAINNET.tokens.MON,
  WMON: MAINNET.tokens.WMON,
};

const OLD_FIXED_SYMBOLS = new Set(['AUSD', 'USDC', 'USDT0', 'MON']);

describe('enumerateTokenSpecs — dynamic enumeration', () => {
  it('renders cbBTC, WETH and XAUt0 — tokens the old fixed AUSD/USDC/USDT0/MON shape never had', () => {
    const specs = enumerateTokenSpecs(ADDRESS_BOOK);
    const symbols = specs.map((s) => s.symbol);

    // The owner's actual bug: these three are real trading-candidate base assets
    // (`TRADING_MARKET_CANDIDATES`, verified live on chain 143) that a hand-picked
    // AUSD/USDC/USDT0/MON list has no room for.
    expect(symbols).toContain('cbBTC');
    expect(symbols).toContain('WETH');
    expect(symbols).toContain('XAUt0');

    for (const symbol of ['cbBTC', 'WETH', 'XAUt0']) {
      expect(OLD_FIXED_SYMBOLS.has(symbol), `${symbol} must not already be in the old fixed shape`).toBe(false);
    }

    // Real, verified addresses (liveMarkets.ts), not invented ones.
    const cbBtc = specs.find((s) => s.symbol === 'cbBTC');
    expect(cbBtc?.address.toLowerCase()).toBe('0xd18b7ec58cdf4876f6afebd3ed1730e4ce10414b');
    expect(cbBtc?.decimals).toBe(8);
    const weth = specs.find((s) => s.symbol === 'WETH');
    expect(weth?.address.toLowerCase()).toBe('0xee8c0e9f1bffb4eb878d8f15f368a02a35481242');
    expect(weth?.decimals).toBe(18);
    const xaut0 = specs.find((s) => s.symbol === 'XAUt0');
    expect(xaut0?.address.toLowerCase()).toBe('0x01bff41798a0bcf287b996046ca68b395dbc1071');
    expect(xaut0?.decimals).toBe(6);
  });

  it('is genuinely dynamic: a market added to the candidate list needs no new code here', () => {
    // A synthetic sixth market, standing in for "whatever ships next" — the point
    // is that `enumerateTokenSpecs` takes the candidate list as data, not as a
    // hardcoded symbol table it has to be edited to match.
    const extraCandidate: MarketCandidate = {
      ...TRADING_MARKET_CANDIDATES[0]!,
      address: '0x1111111111111111111111111111111111111111' as MarketCandidate['address'],
      symbol: 'ZZZ/USDC',
      base: 'ZZZ',
      params: {
        ...TRADING_MARKET_CANDIDATES[0]!.params,
        baseAsset: '0x2222222222222222222222222222222222222222' as MarketCandidate['params']['baseAsset'],
        baseDecimals: 9,
      },
    };
    const specs = enumerateTokenSpecs(ADDRESS_BOOK, [], [...TRADING_MARKET_CANDIDATES, extraCandidate]);
    const zzz = specs.find((s) => s.symbol === 'ZZZ');
    expect(zzz?.address.toLowerCase()).toBe('0x2222222222222222222222222222222222222222');
    expect(zzz?.decimals).toBe(9);
  });

  it('dedupes: a token that is both address-book-known and a market asset keeps its legacy tag once', () => {
    const specs = enumerateTokenSpecs(ADDRESS_BOOK);
    const usdcRows = specs.filter((s) => s.address.toLowerCase() === ADDRESS_BOOK.USDC.address.toLowerCase());
    expect(usdcRows).toHaveLength(1);
    expect(usdcRows[0]?.legacy).toBe('USDC');
  });

  it('plans a caller-supplied extra token with unknown decimals as the -1 sentinel, never a guess', () => {
    const extra = '0x9999999999999999999999999999999999999999' as const;
    const specs = enumerateTokenSpecs(ADDRESS_BOOK, [extra]);
    const row = specs.find((s) => s.address.toLowerCase() === extra);
    expect(row?.decimals).toBe(-1);
  });

  it('native MON is keyed by the zero address, same convention as margin.getBalance', () => {
    const specs = enumerateTokenSpecs(ADDRESS_BOOK);
    const mon = specs.find((s) => s.symbol === 'MON');
    expect(mon?.address).toBe(NATIVE_MON);
    expect(mon?.legacy).toBe('MON');
  });
});

describe('usdcQuotedMarkets', () => {
  it('includes MON/USDC, WETH/USDC, cbBTC/USDC and XAUt0/USDC, excludes emo/MON', () => {
    const markets = usdcQuotedMarkets(MAINNET.tokens.USDC.address);
    const bases = markets.map((m) => m.base);
    expect(bases).toEqual(expect.arrayContaining(['MON', 'WETH', 'cbBTC', 'XAUt0']));
    expect(bases).not.toContain('emo');
  });
});

describe('classifyMarketPrice', () => {
  const usdcMarkets = usdcQuotedMarkets(MAINNET.tokens.USDC.address);

  it('AUSD and USDC are par', () => {
    expect(classifyMarketPrice(MAINNET.tokens.AUSD.address, ADDRESS_BOOK, usdcMarkets, new Map()).source).toBe('par');
    expect(classifyMarketPrice(MAINNET.tokens.USDC.address, ADDRESS_BOOK, usdcMarkets, new Map()).source).toBe('par');
  });

  it('cbBTC prices from its own USDC book — a live lastPrice this session (2026-09-24, GET api.kuru.io/api/v1/markets/0x40c49f171202f91ff5d2fae34c22dd2bfdd22af0) was 83449.22, used here as a realistic wire-scale mid, not a raw bestBidAsk capture', () => {
    const cbBtcMarket = TRADING_MARKET_CANDIDATES.find((c) => c.base === 'cbBTC')!;
    const mid = 83_449_220_000_000_000_000_000n; // 83449.22 * 1e18
    const bookMids = new Map([[cbBtcMarket.address.toLowerCase(), mid]]);
    const decision = classifyMarketPrice(cbBtcMarket.params.baseAsset, ADDRESS_BOOK, usdcMarkets, bookMids);
    expect(decision.source).toBe('market-mid');
    expect(decision.priceWire).toBe(mid);
  });

  it('MON and WMON both reuse the MON/USDC book', () => {
    const monMarket = TRADING_MARKET_CANDIDATES.find((c) => c.base === 'MON')!;
    const mid = 26_364_000_000_000_000n; // a real MON/USDC lastPrice this session: 0.026364
    const bookMids = new Map([[monMarket.address.toLowerCase(), mid]]);
    const monDecision = classifyMarketPrice(NATIVE_MON, ADDRESS_BOOK, usdcMarkets, bookMids);
    const wmonDecision = classifyMarketPrice(MAINNET.tokens.WMON.address, ADDRESS_BOOK, usdcMarkets, bookMids);
    expect(monDecision).toEqual({ source: 'market-mid', priceWire: mid });
    expect(wmonDecision).toEqual({ source: 'market-mid', priceWire: mid });
  });

  it('a token with no USDC-quoted book and no par status is honestly "none" — no fallback, no guess', () => {
    // USDT0 is real (address book) but is not the base of any USDC-quoted trading
    // market, so there is no on-chain book source for it — exactly the "No price
    // available" case the spec requires (the caller tries a Flow quote next; this
    // function only reports the two on-chain sources).
    const decision = classifyMarketPrice(MAINNET.tokens.USDT0.address, ADDRESS_BOOK, usdcMarkets, new Map());
    expect(decision).toEqual({ source: 'none' });
  });

  it('emo (quoted in MON, not USDC) is also "none" from this function', () => {
    const emo = TRADING_MARKET_CANDIDATES.find((c) => c.base === 'emo')!;
    const decision = classifyMarketPrice(emo.params.baseAsset, ADDRESS_BOOK, usdcMarkets, new Map());
    expect(decision).toEqual({ source: 'none' });
  });

  it('a book present but with an unreadable (null) mid is still "none", not a stale guess', () => {
    const cbBtcMarket = TRADING_MARKET_CANDIDATES.find((c) => c.base === 'cbBTC')!;
    const bookMids = new Map<string, bigint | null>([[cbBtcMarket.address.toLowerCase(), null]]);
    const decision = classifyMarketPrice(cbBtcMarket.params.baseAsset, ADDRESS_BOOK, usdcMarkets, bookMids);
    expect(decision).toEqual({ source: 'none' });
  });
});

describe('isUsdDenominated', () => {
  it('true for a USDC-quoted market, false for emo/MON', () => {
    const cbBtc = TRADING_MARKET_CANDIDATES.find((c) => c.base === 'cbBTC')!;
    const emo = TRADING_MARKET_CANDIDATES.find((c) => c.base === 'emo')!;
    expect(isUsdDenominated(cbBtc.params, MAINNET.tokens.USDC.address)).toBe(true);
    expect(isUsdDenominated(emo.params, MAINNET.tokens.USDC.address)).toBe(false);
  });
});

describe('dollar math — all bigint, floored, never a float', () => {
  it('toUsdPar is an identity at six decimals: 1,000.50 USDC -> $1,000.50', () => {
    expect(toUsdPar(1_000_500_000n, 6)).toBe(1_000_500_000n);
  });

  it('toUsd prices 0.5 WETH at a $2,645.87 mid as $1,322.935, floored to the cent-plus-micro', () => {
    const halfWeth = 500_000_000_000_000_000n; // 0.5 * 1e18
    const mid = 2_645_870_000_000_000_000_000n; // 2645.87 * 1e18, a real WETH/USDC lastPrice this session
    // 0.5 * 2645.87 = 1322.935 exactly, representable at six decimals.
    expect(toUsd(halfWeth, 18, mid)).toBe(1_322_935_000n);
  });

  it('toUsd floors rather than rounds when the true value is not six-decimal exact', () => {
    // 1 base unit of an 8-decimal token (1e-8 whole units) at a $1 mid is
    // 0.00000001 dollars, which floors to zero at six decimals — never bumped up.
    expect(toUsd(1n, 8, 10n ** 18n)).toBe(0n);
  });

  it('usdFromFlow applies a Flow quote\'s USDC-out-per-whole-token rate directly, no rescale', () => {
    // A Flow quote for 1 whole unit (18 decimals) returned 996458 (0.996458 USDC).
    const usdPerWhole = 996_458n;
    const halfUnit = 500_000_000_000_000_000n;
    expect(usdFromFlow(halfUnit, 18, usdPerWhole)).toBe(498_229n);
  });
});

describe('readableTokenPlans: a discovered token whose read fails is left out, never the whole wallet', () => {
  // Recorded 2026-09-29: 0x2794c3Eba5686e4fABA5647d1dB3DdDCA1DFB933, name and symbol
  // "AỤSD" (an AUSD lookalike), sent a Transfer to proof account 0xBecFa593...2c55 and
  // was found by the scan; its balanceOf(0xBecFa593...) reverted, and viem's multicall
  // gave that leg `status: 'failure'`.
  const POISON = '0x2794c3Eba5686e4fABA5647d1dB3DdDCA1DFB933';
  const USDC = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603';
  const ok = { status: 'success' as const };
  const fail = { status: 'failure' as const };

  it('drops the scanned token whose balanceOf reverted, and keeps every other', () => {
    const plans = [
      { address: USDC, legacy: 'USDC' },
      { address: POISON, walletIdx: 0, marginIdx: 1 },
    ];
    const { kept, dropped } = readableTokenPlans(plans, [fail, ok], new Set([POISON.toLowerCase()]));
    expect(kept.map((p) => p.address)).toEqual([USDC]);
    expect(dropped.map((p) => p.address)).toEqual([POISON]);
  });

  it('keeps a registry or added token whose read failed, so the request still fails closed', () => {
    const plans = [{ address: POISON, walletIdx: 0, marginIdx: 1 }];
    const { kept, dropped } = readableTokenPlans(plans, [fail, ok], new Set());
    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(0);
  });

  it('keeps a scanned token that reads fine', () => {
    const plans = [{ address: POISON, walletIdx: 0, marginIdx: 1, decimalsIdx: 2 }];
    const { kept } = readableTokenPlans(plans, [ok, ok, ok], new Set([POISON.toLowerCase()]));
    expect(kept).toHaveLength(1);
  });
});
