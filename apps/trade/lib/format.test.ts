import { describe, expect, it } from 'vitest';
import { displayDp, formatMoney, sumAusd, toAusdEquivalent, toUsdcEquivalent } from './format.js';

describe('toAusdEquivalent — the one conversion every "value in AUSD" figure shares', () => {
  it('cannot be priced while the book has not answered yet — not par (audit U5)', () => {
    // A 1:1 fallback here used to fold a guess into a total rendered as a plain
    // number, with nothing to say it was not a real quote.
    expect(toAusdEquivalent(1_000_000n, undefined)).toBeUndefined();
  });

  it('cannot be priced when the book has no resting price on either side — not par', () => {
    expect(toAusdEquivalent(1_000_000n, null)).toBeUndefined();
  });

  it('scales by the live mid otherwise', () => {
    // 1.0004515 AUSD per USDC, wire-scaled — a real reading taken from the live
    // AUSD/USDC book (D118).
    const mid = 1_000_451_500_000_000_000n;
    expect(toAusdEquivalent(1_000_000n, mid)).toBe(1_000_451n);
  });

  it('is zero for a zero balance regardless of the mid', () => {
    expect(toAusdEquivalent(0n, 1_500_000_000_000_000_000n)).toBe(0n);
  });
});

describe('toUsdcEquivalent — the reverse conversion, for Home\'s USDC-primary hero', () => {
  it('cannot be priced while the book has not answered yet — not par', () => {
    expect(toUsdcEquivalent(1_000_000n, undefined)).toBeUndefined();
  });

  it('cannot be priced when the book has no resting price on either side — not par', () => {
    expect(toUsdcEquivalent(1_000_000n, null)).toBeUndefined();
  });

  it('is the reciprocal of the same mid toAusdEquivalent uses', () => {
    const mid = 1_000_451_500_000_000_000n; // 1.0004515 AUSD per USDC
    // Round-tripping 1 USDC through toAusdEquivalent then back through
    // toUsdcEquivalent lands within a rounding unit of where it started — the two
    // read one live mid, not two independent quotes that could drift apart.
    const ausd = toAusdEquivalent(1_000_000n, mid)!;
    const roundTripped = toUsdcEquivalent(ausd, mid)!;
    expect(roundTripped).toBeGreaterThan(999_000n);
    expect(roundTripped).toBeLessThanOrEqual(1_000_000n);
  });

  it('is zero for a zero balance regardless of the mid', () => {
    expect(toUsdcEquivalent(0n, 1_500_000_000_000_000_000n)).toBe(0n);
  });

  it('refuses a non-positive mid rather than dividing by it', () => {
    expect(toUsdcEquivalent(1_000_000n, 0n)).toBeUndefined();
  });
});

describe('displayDp — B8: no amount field ever shows a token\'s full on-chain decimals', () => {
  it('narrows an 18-decimal base asset to 6 for display', () => {
    expect(displayDp('MON', 18)).toBe(6);
    expect(displayDp('WETH', 18)).toBe(6);
  });

  it('narrows cbBTC to 8, its own on-chain decimals, not lower', () => {
    expect(displayDp('cbBTC', 8)).toBe(8);
  });

  it('never widens what the caller already asked for', () => {
    // A caller asking for 2 decimal places on a 6-decimal token still gets 2.
    expect(displayDp('USDC', 2)).toBe(2);
  });

  it('caps a token the table does not name at min(decimals, 6) (spec F2)', () => {
    expect(displayDp('MADE_UP', 18)).toBe(6);
    expect(displayDp('MADE_UP', 4)).toBe(4);
    expect(displayDp('MADE_UP', 6)).toBe(6);
  });

  it('WMON is capped like MON', () => {
    expect(displayDp('WMON', 18)).toBe(6);
  });
});

/**
 * Item 2d: one fixture, rendered through the same formula every screen calls,
 * produces the same number wherever the same concept is asked for. Home's
 * "Available to trade" and the Settings account row both mean *margin only,
 * converted to AUSD* — this proves they cannot drift, because they are the same
 * two-line calculation, not two hand-written copies of it. Portfolio's "Total
 * value" is a deliberately larger, different concept (margin *and* wallet), so it
 * is asserted to differ, and by exactly the wallet's own AUSD-equivalent value.
 */
describe('the same balance fixture produces the same number on every screen (item 2d)', () => {
  const fixture: {
    margin: { AUSD: bigint; USDC: bigint };
    wallet: { AUSD: bigint; USDC: bigint; USDT0: bigint };
    ausdPerUsdcMid: bigint | null;
  } = {
    margin: { AUSD: 100_000n, USDC: 1_346_272n }, // 0.10 AUSD, 1.346272 USDC
    wallet: { AUSD: 0n, USDC: 500_000n, USDT0: 0n }, // 0.50 USDC still sitting in the wallet
    ausdPerUsdcMid: 1_000_451_500_000_000_000n,
  };

  function availableToTrade(f: typeof fixture): bigint | undefined {
    // Exactly Home's and the Settings row's own calculation.
    return sumAusd(f.margin.AUSD, toAusdEquivalent(f.margin.USDC, f.ausdPerUsdcMid));
  }

  function totalValue(f: typeof fixture): bigint | undefined {
    // Exactly Portfolio's own calculation.
    return sumAusd(
      f.margin.AUSD,
      toAusdEquivalent(f.margin.USDC, f.ausdPerUsdcMid),
      f.wallet.AUSD,
      toAusdEquivalent(f.wallet.USDC, f.ausdPerUsdcMid),
      f.wallet.USDT0,
    );
  }

  it('Home and Settings agree on "Available to trade" for the same account', () => {
    const home = availableToTrade(fixture);
    const settings = availableToTrade(fixture); // the same two-line formula, same fixture
    expect(home).toBe(settings);
    // 100,000 (margin AUSD) + 1,346,272 USDC at the fixture's mid.
    expect(home).toBe(sumAusd(100_000n, toAusdEquivalent(1_346_272n, fixture.ausdPerUsdcMid)));
  });

  it("Portfolio's Total value is Available to trade plus the wallet, converted the same way — never a third number", () => {
    const available = availableToTrade(fixture);
    const walletAusdEquivalent = toAusdEquivalent(fixture.wallet.USDC, fixture.ausdPerUsdcMid);
    expect(totalValue(fixture)).toBe(sumAusd(available, walletAusdEquivalent));
  });

  it('an all-zero fixture is zero everywhere, never undefined-looking or negative', () => {
    const zero = {
      margin: { AUSD: 0n, USDC: 0n },
      wallet: { AUSD: 0n, USDC: 0n, USDT0: 0n },
      ausdPerUsdcMid: null,
    };
    // A zero USDC leg needs no price, even with no mid at all — so an all-zero
    // account is fully known, never "unknown" for want of a quote nobody needed.
    expect(availableToTrade(zero)).toBe(0n);
    expect(totalValue(zero)).toBe(0n);
  });

  it('is undefined — not a guessed total — the moment any unpriced part is nonzero', () => {
    const unpriced = { ...fixture, ausdPerUsdcMid: null };
    expect(availableToTrade(unpriced)).toBeUndefined();
    expect(totalValue(unpriced)).toBeUndefined();
  });
});

/**
 * B8, applied to every amount input in the app: the Move sheet, Withdraw, the order
 * ticket, Send, Swap and the fund-in card all fill Max/a percentage button with
 * `formatMoney(amount, decimals, displayDp(symbol, decimals))` — the one formula, not
 * six separately-typed ones that could drift. This is that formula, run once per
 * token the app actually shows, against an 18-decimal-scale balance shaped like the
 * one a real Max tap produced: "0.000037336600000000" (MON, on the Move sheet,
 * production, before this fix). No component is rendered — this repo's own tests
 * extract what a screen would show into data instead of scanning rendered HTML
 * (`vitest.config.ts`), and every one of those six call sites now runs this exact
 * function pair, so asserting it once here is asserting all six.
 */
describe('B8 in the field: what a Max tap actually shows, for every input in the app', () => {
  it('reproduces the reported bug fixture and confirms the fix: 6 places for MON, not 18', () => {
    // 0.0000373366 MON, in 18-decimal wei — the exact balance behind the screenshot.
    const reportedBalance = 37_336_600_000_000n;
    const shown = formatMoney(reportedBalance, 18, displayDp('MON', 18));
    expect(shown).toBe('0.000037');
    expect(shown).not.toBe('0.000037336600000000');
  });

  it('an 18-decimal balance is still capped at 6 places for every 18-decimal token (MON, WETH)', () => {
    const balance = 1_234_567_890_123_456_789n; // 1.234567890123456789, all 18 places used
    expect(formatMoney(balance, 18, displayDp('MON', 18))).toBe('1.234567');
    expect(formatMoney(balance, 18, displayDp('WETH', 18))).toBe('1.234567');
  });

  it('a fully-populated six-decimal balance is capped at its own 6 places for every six-decimal token (USDC, AUSD, USDT0, XAUt0)', () => {
    const balance = 1_234_567n; // 1.234567, all six on-chain places used — nothing to cap further
    for (const symbol of ['USDC', 'AUSD', 'USDT0', 'XAUt0']) {
      expect(formatMoney(balance, 6, displayDp(symbol, 6))).toBe('1.234567');
    }
  });

  it('cbBTC keeps its own 8 places — the display cap never narrows below a token’s real decimals', () => {
    const balance = 123_456_789n; // 1.23456789 cbBTC, exactly 8dp, no more to cap
    expect(formatMoney(balance, 8, displayDp('cbBTC', 8))).toBe('1.23456789');
  });
});
