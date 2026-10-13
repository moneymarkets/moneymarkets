import { beforeEach, describe, expect, it } from 'vitest';
import { getAddress, type Address } from 'viem';
import {
  assertFloatWithinCap,
  assertMarketAllowed,
  assertOrderWithinCap,
  assertQuoteAmountWithinCap,
  CapExceededError,
  effectiveOrderNotionalCap,
  effectiveRelayerFloatCap,
  isMarketAllowed,
  LIVE_MARKET_ALLOWLIST,
  MAX_ORDER_NOTIONAL_AUSD,
  MAX_RELAYER_FLOAT_WEI,
  PREFUND_ACCOUNTS_PER_HOUR,
  PREFUND_BUDGETS,
  PREFUND_MAX_MON,
  prefundBudgets,
  REFUSE_IF_ORDER_ABOVE_CAP,
  tighten,
} from './caps.js';
import {
  assertMainnetAllowed,
  isDryRun,
  mainnetAllowed,
  MainnetNotUnlockedError,
  readModeGate,
} from './mode.js';
import {
  configureLiveMarkets,
  liveMarketsRefreshInFlight,
  resetLiveMarketsForTests,
  TRADING_MARKET_CANDIDATES,
} from '../kuru/liveMarkets.js';
import { fakeChain, fakeKuru, notFoundFor } from '../kuru/__fixtures__/liveMarketsHarness.js';
import {
  EMO_MON_PARAMS,
  MON_USDC_PARAMS,
  MON_USDC_PM_MID_WIRE,
  WETH_USDC_PARAMS,
} from '../kuru/__fixtures__/newMarkets.js';
import { MON_AUSD_PARAMS } from '../kuru/__fixtures__/books.js';
import { MAINNET } from './addresses.js';

const MON_AUSD = '0x131a2e70a5b31a517a74b8c567149bc294470da9' as Address;
const MON_USDC = '0x065C9d28E428A0db40191a54d33d5b7c71a9C394' as Address;
const AUSD_USDC = '0x699abc15308156e9a3ab89ec7387e9cfe1c86a3b' as Address;
const WBTC_AUSD = '0xbdc776284bf593981b1f0237f053a7ad11eb596f' as Address;
const EMO_MON = '0xe7a4f90369b48d8f5b61f2fd519ec563c11e4b2d' as Address;

describe('the caps are the owner’s numbers', () => {
  it('holds $1,000 per order and 20 MON of float', () => {
    // $1,000, raised from $6 on 2026-10-13 by owner decision. ($6 was itself raised from
    // $5 on 2026-09-02: MON/AUSD's 200-MON minimum is $5.14-$5.24, so no legal limit
    // order fit under $5. See DECISIONS.md C5.)
    expect(MAX_ORDER_NOTIONAL_AUSD).toBe(1_000_000_000n); // 6 decimals
    // 20 MON = ten concurrent demo users at 2.0 MON per address per day.
    expect(MAX_RELAYER_FLOAT_WEI).toBe(20_000_000_000_000_000_000n);
    expect(REFUSE_IF_ORDER_ABOVE_CAP).toBe(true);
  });
});

/**
 * Since 2026-09-23 the allowlist is a live view of `kuru/liveMarkets.ts`, not an array
 * typed here. These tests pin what it may ever contain and how it moves; the lookup and
 * refresh rules themselves are tested in `liveMarkets.test.ts`.
 */
describe('the live market allowlist', () => {
  // Read at import, before any test configures or resets anything.
  const AT_IMPORT = [...LIVE_MARKET_ALLOWLIST];

  beforeEach(() => resetLiveMarketsForTests());

  it('starts as MON/USDC alone, never empty', () => {
    expect(AT_IMPORT).toEqual([getAddress(MON_USDC)]);
    expect([...LIVE_MARKET_ALLOWLIST]).toEqual([getAddress(MON_USDC)]);
  });

  it('is exactly the five verified books once a refresh confirms them', async () => {
    // Five, not "at least five": a sixth address appearing here is a decision, and it
    // should fail this test until it is made deliberately in TRADING_MARKET_CANDIDATES.
    const { fetchImpl } = fakeKuru();
    configureLiveMarkets({ client: fakeChain().client, fetchImpl });
    await liveMarketsRefreshInFlight();
    expect(LIVE_MARKET_ALLOWLIST.map((m) => m.toLowerCase())).toEqual([
      MON_USDC.toLowerCase(),
      '0xa6afd386135b7d41a6c40c525abc4a1019b0d132', // WETH/USDC
      '0x40c49f171202f91ff5d2fae34c22dd2bfdd22af0', // cbBTC/USDC
      '0x851145eaefdc37956b08da829fa31722199f3f07', // XAUt0/USDC
      EMO_MON, // emo/MON, quoted in MON and valued at the MON/USDC mid (D159)
    ]);
    for (const market of LIVE_MARKET_ALLOWLIST) {
      expect(isMarketAllowed(market)).toBe(true);
      expect(() => assertMarketAllowed(market)).not.toThrow();
    }
  });

  it('never holds anything outside the trading candidates', async () => {
    const candidates = TRADING_MARKET_CANDIDATES.map((c) => c.address.toLowerCase());
    for (const m of LIVE_MARKET_ALLOWLIST) expect(candidates).toContain(m.toLowerCase());
    configureLiveMarkets({ client: fakeChain().client, fetchImpl: fakeKuru().fetchImpl });
    await liveMarketsRefreshInFlight();
    for (const m of LIVE_MARKET_ALLOWLIST) expect(candidates).toContain(m.toLowerCase());
  });

  it('allows emo/MON only once a refresh confirms it, never from cold', async () => {
    expect(isMarketAllowed(EMO_MON)).toBe(false);
    expect(() => assertMarketAllowed(EMO_MON)).toThrow(CapExceededError);
    configureLiveMarkets({ client: fakeChain().client, fetchImpl: fakeKuru().fetchImpl });
    await liveMarketsRefreshInFlight();
    expect(isMarketAllowed(EMO_MON)).toBe(true);
    expect(() => assertMarketAllowed(EMO_MON)).not.toThrow();
  });

  it('refuses MON/AUSD, AUSD/USDC and WBTC/AUSD, cold and warm', async () => {
    const dropped = [MON_AUSD, AUSD_USDC, WBTC_AUSD];
    for (const m of dropped) {
      expect(isMarketAllowed(m)).toBe(false);
      expect(() => assertMarketAllowed(m)).toThrow(CapExceededError);
    }
    configureLiveMarkets({ client: fakeChain().client, fetchImpl: fakeKuru().fetchImpl });
    await liveMarketsRefreshInFlight();
    for (const m of dropped) {
      expect(isMarketAllowed(m)).toBe(false);
      expect(() => assertMarketAllowed(m)).toThrow(CapExceededError);
    }
  });

  it('follows a market Kuru stops listing, through the same function signatures', async () => {
    const weth = '0xa6AFd386135b7d41A6C40C525abC4a1019B0d132' as Address;
    const { fetchImpl } = fakeKuru({
      '0xa6afd386135b7d41a6c40c525abc4a1019b0d132': notFoundFor(
        '0xa6afd386135b7d41a6c40c525abc4a1019b0d132',
      ),
    });
    configureLiveMarkets({ client: fakeChain().client, fetchImpl });
    await liveMarketsRefreshInFlight();
    expect(isMarketAllowed(weth)).toBe(false);
    expect(() => assertMarketAllowed(weth)).toThrow(/not one of the markets/);
    expect(isMarketAllowed(MON_USDC)).toBe(true);
  });

  it('cannot be written to by a caller', () => {
    expect(() => (LIVE_MARKET_ALLOWLIST as Address[]).push(MON_AUSD)).toThrow(TypeError);
    expect(isMarketAllowed(MON_AUSD)).toBe(false);
  });
});

describe('sponsorship budgets scale from PREFUND_MAX_MON (B7, 2026-09-23)', () => {
  const MON = 10n ** 18n;

  it('is 2 MON a day and 0.5 MON an hour per address — the owner’s figures', () => {
    expect(PREFUND_MAX_MON).toBe(2n);
    expect(PREFUND_BUDGETS.perAddressDay).toBe(2n * MON);
    expect(PREFUND_BUDGETS.perAddressHour).toBe(MON / 2n);
  });

  it('is 5 MON an hour across all addresses — provisional, awaiting the owner', () => {
    // Pinned so a change is deliberate, and deliberately NOT asserted against the
    // float: the two are unrelated, and retuning this must not need the float to move.
    expect(PREFUND_ACCOUNTS_PER_HOUR).toBe(10n);
    expect(PREFUND_BUDGETS.allAddressesHour).toBe(
      PREFUND_BUDGETS.perAddressHour * PREFUND_ACCOUNTS_PER_HOUR,
    );
    expect(PREFUND_BUDGETS.allAddressesHour).toBe(5n * MON);
  });

  it('lets the environment tighten all three together', () => {
    const tightened = prefundBudgets(MON); // 1 MON a day
    expect(tightened.perAddressDay).toBe(MON);
    expect(tightened.perAddressHour).toBe(MON / 4n);
    expect(tightened.allAddressesHour).toBe((MON / 4n) * PREFUND_ACCOUNTS_PER_HOUR);
  });

  it('never lets the environment widen any of them', () => {
    expect(prefundBudgets(100n * MON)).toEqual(PREFUND_BUDGETS);
    expect(prefundBudgets(0n)).toEqual(PREFUND_BUDGETS);
    expect(prefundBudgets(-1n)).toEqual(PREFUND_BUDGETS);
    expect(prefundBudgets(undefined)).toEqual(PREFUND_BUDGETS);
  });
});

describe('the environment can only tighten a cap, never loosen it', () => {
  it('takes a lower env value', () => {
    expect(tighten(100n, 10n)).toBe(10n);
    expect(effectiveOrderNotionalCap(1_000_000n)).toBe(1_000_000n);
    expect(effectiveRelayerFloatCap(10n ** 18n)).toBe(10n ** 18n);
  });

  it('ignores a higher env value and keeps the code cap', () => {
    expect(tighten(100n, 1_000_000n)).toBe(100n);
    // Someone asking the environment for $6,000 gets the $1,000 code cap anyway.
    expect(effectiveOrderNotionalCap(6_000_000_000n)).toBe(MAX_ORDER_NOTIONAL_AUSD);
    expect(effectiveRelayerFloatCap(100n * 10n ** 18n)).toBe(MAX_RELAYER_FLOAT_WEI);
  });

  it('ignores a missing, zero or negative env value', () => {
    expect(effectiveOrderNotionalCap(undefined)).toBe(MAX_ORDER_NOTIONAL_AUSD);
    expect(effectiveOrderNotionalCap(0n)).toBe(MAX_ORDER_NOTIONAL_AUSD);
    expect(effectiveOrderNotionalCap(-1n)).toBe(MAX_ORDER_NOTIONAL_AUSD);
  });
});

describe('order notional cap', () => {
  it('accepts an order at the cap', () => {
    expect(() => assertOrderWithinCap(MAX_ORDER_NOTIONAL_AUSD)).not.toThrow();
  });

  it('accepts the smallest legal MON/AUSD limit order, which $5 would have refused', () => {
    // 200 MON at the bestAsk of 0.026211 read 2026-09-02 = $5.2422.
    expect(() => assertOrderWithinCap(5_242_200n)).not.toThrow();
  });

  it('refuses one cent above it', () => {
    const oneCentOver = MAX_ORDER_NOTIONAL_AUSD + 10_000n; // $1,000.01
    expect(() => assertOrderWithinCap(oneCentOver)).toThrow(CapExceededError);
    expect(() => assertOrderWithinCap(oneCentOver)).toThrow(/not raisable/);
  });

  it('refuses rather than trimming to fit', () => {
    // A trimmed order is an order the user did not place. $5,000 against the $1,000 cap.
    try {
      assertOrderWithinCap(5_000_000_000n);
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CapExceededError);
      expect((error as CapExceededError).cap).toBe('MAX_ORDER_NOTIONAL');
    }
  });

  it('refuses a non-positive notional', () => {
    expect(() => assertOrderWithinCap(0n)).toThrow(/must be positive/);
  });
});

/**
 * The same cap, applied to an order's value in its own market's quote units: the entry
 * point both the ticket and the relayer use since 2026-09-23. One test per quote asset.
 * Params are real `getMarketParams()` reads; the MON price is the real MON/USDC mid at
 * block 107,310,277 (0.025861).
 */
describe('order value in quote units, valued in dollars before the cap', () => {
  const MON_WEI = 10n ** 18n;

  describe('AUSD-quoted (MON/AUSD): one-for-one, exactly as before', () => {
    it('passes $1,000.00 and refuses $1,000.000001, with no price at all', () => {
      expect(() =>
        assertQuoteAmountWithinCap(MAX_ORDER_NOTIONAL_AUSD, MON_AUSD_PARAMS),
      ).not.toThrow();
      expect(() =>
        assertQuoteAmountWithinCap(MAX_ORDER_NOTIONAL_AUSD + 1n, MON_AUSD_PARAMS),
      ).toThrow(CapExceededError);
    });

    it('ignores a price if one is passed', () => {
      expect(() =>
        assertQuoteAmountWithinCap(MAX_ORDER_NOTIONAL_AUSD, MON_AUSD_PARAMS, 1n),
      ).not.toThrow();
      expect(() =>
        assertQuoteAmountWithinCap(MAX_ORDER_NOTIONAL_AUSD + 1n, MON_AUSD_PARAMS, 10n ** 30n),
      ).toThrow(CapExceededError);
    });
  });

  describe('USDC-quoted (MON/USDC): one-for-one, exactly as before', () => {
    it('passes the 5.3382 USDC resting minimum and $1,000.00, and refuses $1,000.000001', () => {
      expect(() => assertQuoteAmountWithinCap(5_338_200n, MON_USDC_PARAMS)).not.toThrow();
      expect(() =>
        assertQuoteAmountWithinCap(MAX_ORDER_NOTIONAL_AUSD, MON_USDC_PARAMS),
      ).not.toThrow();
      expect(() =>
        assertQuoteAmountWithinCap(MAX_ORDER_NOTIONAL_AUSD + 1n, MON_USDC_PARAMS),
      ).toThrow(/not raisable/);
    });

    it('still refuses a non-positive amount', () => {
      expect(() => assertQuoteAmountWithinCap(0n, MON_USDC_PARAMS)).toThrow(/must be positive/);
    });
  });

  describe('MON-quoted (emo/MON): valued at the MON/USDC mid', () => {
    it('passes 200 emo at 0.031 MON, 6.2 MON, which the raw comparison refused billions of times over', () => {
      // $0.160339. Compared raw, 6.2e18 against 1e9.
      expect(() =>
        assertQuoteAmountWithinCap(
          6_200_000_000_000_000_000n,
          EMO_MON_PARAMS,
          MON_USDC_PM_MID_WIRE,
        ),
      ).not.toThrow();
      expect(() => assertOrderWithinCap(6_200_000_000_000_000_000n)).toThrow(CapExceededError);
    });

    it('passes 38,668.264954951471327481 MON ($1,000.000000) and refuses one wei more', () => {
      // floor($1,000 / 0.025861) in wei of MON: the largest amount that still rounds up
      // to exactly the cap.
      const atCap = 38_668_264_954_951_471_327_481n;
      expect(() =>
        assertQuoteAmountWithinCap(atCap, EMO_MON_PARAMS, MON_USDC_PM_MID_WIRE),
      ).not.toThrow();
      expect(() =>
        assertQuoteAmountWithinCap(atCap + 1n, EMO_MON_PARAMS, MON_USDC_PM_MID_WIRE),
      ).toThrow(CapExceededError);
    });

    it('passes 250 MON ($6.47), which the $6 cap refused', () => {
      expect(() =>
        assertQuoteAmountWithinCap(250n * MON_WEI, EMO_MON_PARAMS, MON_USDC_PM_MID_WIRE),
      ).not.toThrow();
    });

    it('refuses 40,000 MON ($1,034.44), a genuinely oversized order', () => {
      expect(() =>
        assertQuoteAmountWithinCap(40_000n * MON_WEI, EMO_MON_PARAMS, MON_USDC_PM_MID_WIRE),
      ).toThrow(/exceeds the hard cap/);
    });

    it('refuses rather than guessing when there is no MON price', () => {
      for (const price of [undefined, 0n]) {
        expect(() => assertQuoteAmountWithinCap(MON_WEI, EMO_MON_PARAMS, price)).toThrow(
          /no usable mid/,
        );
      }
    });

    it('lets the environment tighten it, and not loosen it', () => {
      // $0.160339 is over a $0.10 environment cap, and the $1,000 code cap still stands
      // against a $1,000,000 one: 40,000 MON is $1,034.44.
      expect(() =>
        assertQuoteAmountWithinCap(
          6_200_000_000_000_000_000n,
          EMO_MON_PARAMS,
          MON_USDC_PM_MID_WIRE,
          100_000n,
        ),
      ).toThrow(CapExceededError);
      expect(() =>
        assertQuoteAmountWithinCap(
          40_000n * MON_WEI,
          EMO_MON_PARAMS,
          MON_USDC_PM_MID_WIRE,
          10n ** 12n,
        ),
      ).toThrow(CapExceededError);
    });
  });

  describe('a quote asset with no valuation', () => {
    it('is refused outright, never compared raw', () => {
      // WETH as a quote: a real 18-decimal token with no rule. Even a tiny amount that a
      // raw comparison would have waved through is refused.
      const wethQuoted = { quoteAsset: WETH_USDC_PARAMS.baseAsset, quoteDecimals: 18 };
      expect(() => assertQuoteAmountWithinCap(1n, wethQuoted, MON_USDC_PM_MID_WIRE)).toThrow(
        /cannot be valued in dollars/,
      );
      // USDT0: six decimals, a dollar, but not one the owner's rule names.
      const usdt0Quoted = { quoteAsset: MAINNET.tokens.USDT0.address, quoteDecimals: 6 };
      expect(() => assertQuoteAmountWithinCap(1_000_000n, usdt0Quoted)).toThrow(CapExceededError);
    });
  });
});

describe('relayer float cap', () => {
  it('accepts a float at or below 20 MON', () => {
    expect(() => assertFloatWithinCap(20n * 10n ** 18n)).not.toThrow();
    expect(() => assertFloatWithinCap(0n)).not.toThrow();
  });

  it('refuses an over-funded relayer', () => {
    expect(() => assertFloatWithinCap(21n * 10n ** 18n)).toThrow(CapExceededError);
    expect(() => assertFloatWithinCap(21n * 10n ** 18n)).toThrow(/Move the excess out/);
  });
});

describe('market allowlist', () => {
  beforeEach(() => resetLiveMarketsForTests());

  it('allows MON/USDC in either case', () => {
    expect(() => assertMarketAllowed(MON_USDC)).not.toThrow();
    expect(() => assertMarketAllowed(MON_USDC.toLowerCase() as Address)).not.toThrow();
    expect(() => assertMarketAllowed(MON_USDC.toUpperCase() as Address)).not.toThrow();
    expect(isMarketAllowed(MON_USDC)).toBe(true);
  });

  it('allows every listed book, and still refuses one that is not listed', () => {
    for (const market of LIVE_MARKET_ALLOWLIST) {
      expect(() => assertMarketAllowed(market)).not.toThrow();
      expect(isMarketAllowed(market)).toBe(true);
    }
    // A real Kuru book that is deliberately not on the list.
    const unlisted = '0xE9E448ab704E0b5F83261342D0DB8aC00651E70F' as Address;
    expect(() => assertMarketAllowed(unlisted)).toThrow(CapExceededError);
    expect(isMarketAllowed(unlisted)).toBe(false);
  });
});

describe('MODE gate', () => {
  const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

  it('defaults to a dry run on testnet with no funds acknowledged', () => {
    const gate = readModeGate(env({}));
    expect(gate).toEqual({ mode: 'testnet', runMode: 'dryrun', realFundsAcknowledged: false });
    expect(isDryRun(gate)).toBe(true);
    expect(mainnetAllowed(gate)).toBe(false);
  });

  it('stays a dry run when only CHAIN is set', () => {
    const gate = readModeGate(env({ CHAIN: 'mainnet' }));
    expect(mainnetAllowed(gate)).toBe(false);
    expect(isDryRun(gate)).toBe(true);
  });

  it('stays locked when MODE=live but the funds flag is missing', () => {
    const gate = readModeGate(env({ CHAIN: 'mainnet', MODE: 'live' }));
    expect(mainnetAllowed(gate)).toBe(false);
    expect(() => assertMainnetAllowed('placing an order', gate)).toThrow(
      /I_UNDERSTAND_THIS_USES_REAL_FUNDS=true/,
    );
  });

  it('stays locked when the funds flag is set but MODE is still dryrun', () => {
    const gate = readModeGate(env({ CHAIN: 'mainnet', I_UNDERSTAND_THIS_USES_REAL_FUNDS: 'true' }));
    expect(mainnetAllowed(gate)).toBe(false);
    expect(() => assertMainnetAllowed('placing an order', gate)).toThrow(/MODE=live/);
  });

  it('unlocks only with all three', () => {
    const gate = readModeGate(
      env({ CHAIN: 'mainnet', MODE: 'live', I_UNDERSTAND_THIS_USES_REAL_FUNDS: 'true' }),
    );
    expect(mainnetAllowed(gate)).toBe(true);
    expect(isDryRun(gate)).toBe(false);
    expect(() => assertMainnetAllowed('placing an order', gate)).not.toThrow();
  });

  it('names every switch still missing', () => {
    try {
      assertMainnetAllowed('placing an order', readModeGate(env({})));
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(MainnetNotUnlockedError);
      const message = (error as Error).message;
      expect(message).toContain('CHAIN=mainnet');
      expect(message).toContain('MODE=live');
      expect(message).toContain('I_UNDERSTAND_THIS_USES_REAL_FUNDS=true');
    }
  });

  it('treats an unrecognised MODE as a dry run rather than failing open', () => {
    expect(readModeGate(env({ MODE: 'yolo' })).runMode).toBe('dryrun');
  });
});
