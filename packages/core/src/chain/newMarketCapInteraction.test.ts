import { describe, expect, it } from 'vitest';
import { assertOrderWithinCap, CapExceededError, MAX_ORDER_NOTIONAL_AUSD } from './caps.js';
import { MIN_SIZE_WORTH } from '../kuru/__fixtures__/newMarkets.js';
import { AUSD_USDC_PARAMS } from '../kuru/__fixtures__/ausdUsdc.js';

/**
 * Item 3: the minSize-vs-notional-cap interaction `reports/MARKETS-VERIFIED.md` §1
 * surfaced for two of the five newly-verified markets.
 *
 * cbBTC/USDC's resting minimum is worth 10.8119 USDC and XAUt0/USDC's is worth
 * 8.6677 USDC (report §1 "Minimum resting size" table, and repeated in the report's
 * own "Observations for the caps change" section). Both were above the **$6** cap in
 * force until 2026-10-13, so no resting limit order was possible on either book. The
 * owner raised `MAX_ORDER_NOTIONAL_AUSD` to **$1,000** that day, and both minimums
 * now fit with room to spare. The cap is read live from `caps.ts` below rather than
 * hard-coded here, so this test fails loudly if the cap ever moves instead of quietly
 * describing a world that no longer exists (it did exactly that on 2026-10-13).
 *
 * `assertOrderWithinCap` takes a bare notional and does not care what currency it
 * came from; it is denominated in AUSD base units. Neither cbBTC/USDC nor XAUt0/USDC
 * quotes in AUSD — both quote in USDC — but `caps.ts`'s own doc comment already
 * compares a USDC-denominated book minimum against this AUSD cap for AUSD/USDC and
 * WBTC/AUSD ("~$10.00", "~$11"), on the basis that AUSD and USDC are both 6-decimal
 * stablecoins trading close to 1:1 (confirmed by `AUSD_USDC_MEASURED` in
 * `convert.test.ts`: 1.000147-1.000149). This test follows that same established
 * convention rather than inventing a new one.
 */
/** The cap in force until 2026-10-13, kept only to show which minimums it refused. */
const PREVIOUS_CAP_AUSD = 6_000_000n;

describe('cbBTC/USDC and XAUt0/USDC resting minimums fit under the $1,000 order cap', () => {
  it('the cap is $1,000 (1_000_000_000 AUSD base units) today', () => {
    expect(MAX_ORDER_NOTIONAL_AUSD).toBe(1_000_000_000n);
  });

  it('accepts a limit order at cbBTC/USDC’s minSize (worth 10.8119 USDC), which $6 refused', () => {
    expect(MIN_SIZE_WORTH.cbbtcUsdc.worthQuote).toBeGreaterThan(PREVIOUS_CAP_AUSD);
    expect(MIN_SIZE_WORTH.cbbtcUsdc.worthQuote).toBeLessThan(MAX_ORDER_NOTIONAL_AUSD);
    expect(() => assertOrderWithinCap(MIN_SIZE_WORTH.cbbtcUsdc.worthQuote)).not.toThrow();
  });

  it('accepts a limit order at XAUt0/USDC’s minSize (worth 8.6677 USDC), which $6 refused', () => {
    expect(MIN_SIZE_WORTH.xaut0Usdc.worthQuote).toBeGreaterThan(PREVIOUS_CAP_AUSD);
    expect(MIN_SIZE_WORTH.xaut0Usdc.worthQuote).toBeLessThan(MAX_ORDER_NOTIONAL_AUSD);
    expect(() => assertOrderWithinCap(MIN_SIZE_WORTH.xaut0Usdc.worthQuote)).not.toThrow();
  });

  it('MON/USDC and WETH/USDC’s minimums fit too, as they did under $6', () => {
    // Under $6 only these two of the dollar-quoted books fit, which is what made the
    // cbBTC/XAUt0 case interesting. Under $1,000 all four fit. (emo/MON is not compared
    // here: its minimum is worth ~5 native MON, which has to be valued at the MON/USDC
    // mid before it means anything against a dollar cap. That is
    // `newMarketEmoMonCap.test.ts`, where it fits at about $0.13.)
    expect(() => assertOrderWithinCap(MIN_SIZE_WORTH.monUsdc.worthQuote)).not.toThrow();
    expect(() => assertOrderWithinCap(MIN_SIZE_WORTH.wethUsdc.worthQuote)).not.toThrow();
  });

  it('still refuses an order genuinely above $1,000 on those books', () => {
    // 100 times cbBTC/USDC's minimum, 0.0125 cbBTC, is worth 1,081.19 USDC at the
    // measured fill; 120 times XAUt0/USDC's, 0.24 XAUt0, is worth 1,040.124 USDC.
    const cbbtc = MIN_SIZE_WORTH.cbbtcUsdc.worthQuote * 100n;
    const xaut0 = MIN_SIZE_WORTH.xaut0Usdc.worthQuote * 120n;
    expect(cbbtc).toBe(1_081_190_000n);
    expect(xaut0).toBe(1_040_124_000n);
    for (const notional of [cbbtc, xaut0]) {
      expect(notional).toBeGreaterThan(MAX_ORDER_NOTIONAL_AUSD);
      expect(() => assertOrderWithinCap(notional)).toThrow(CapExceededError);
      expect(() => assertOrderWithinCap(notional)).toThrow(/not raisable/);
    }
  });
});

/**
 * The same interaction, for the OLD four-market allowlist: `caps.ts`'s own doc
 * comment documented it against the $6 cap ("AUSD/USDC 10 AUSD (~$10.00) | no",
 * "WBTC/AUSD 0.0001 WBTC (~$11) | no") but nothing in `caps.test.ts` asserted it
 * before this file. Under the $1,000 cap (2026-10-13) the answer for AUSD/USDC is now
 * "yes". AUSD/USDC closes cleanly: its minSize is already denominated in AUSD (`AUSD_USDC_PARAMS`,
 * verified live 2026-09-02, `__fixtures__/ausdUsdc.ts`), so no cross-currency
 * assumption is needed at all.
 *
 * WBTC/AUSD is NOT closed here. Read live today (`getMarketParams()` on
 * `0xbdc776284bf593981b1f0237f053a7ad11eb596f`, chain 143, block 107,261,023): its
 * minSize is confirmed as 0.0001 WBTC (pricePrecision 1e4, sizePrecision 1e8, minSize
 * 10000, matching `caps.ts`'s "pricePrecision 1e4, not 1e8" comment) — but
 * `bestBidAsk()` on the same read returned the "no bid" sentinel and a real 0 for
 * "no ask": this book has no live price right now (consistent with
 * `reports/MARKETS-VERIFIED.md` §3, which found WBTC/AUSD listed but inactive today).
 * With no live price there is no honest way to turn 0.0001 WBTC into a notional
 * without inventing one, so `caps.ts`'s "~$11" stays an unverified estimate and this
 * gap is reported rather than guessed shut.
 */
describe('AUSD/USDC’s minSize-vs-cap interaction (the OLD-market half of this gap)', () => {
  it('AUSD/USDC’s minSize is 10 AUSD, under the $1,000 cap where $6 refused it — closes cleanly, no currency conversion needed', () => {
    expect(AUSD_USDC_PARAMS.minSize).toBe(10_000_000n); // 10 AUSD, 6 decimals
    expect(AUSD_USDC_PARAMS.minSize).toBeGreaterThan(PREVIOUS_CAP_AUSD);
    expect(AUSD_USDC_PARAMS.minSize).toBeLessThan(MAX_ORDER_NOTIONAL_AUSD);
    expect(() => assertOrderWithinCap(AUSD_USDC_PARAMS.minSize)).not.toThrow();
  });

  it('refuses 1,010 AUSD on AUSD/USDC, an order genuinely above the cap', () => {
    const oversized = AUSD_USDC_PARAMS.minSize * 101n; // 1,010 AUSD
    expect(oversized).toBeGreaterThan(MAX_ORDER_NOTIONAL_AUSD);
    expect(() => assertOrderWithinCap(oversized)).toThrow(CapExceededError);
  });
});
