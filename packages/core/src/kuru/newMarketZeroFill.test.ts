import { describe, expect, it } from 'vitest';
import { buildMarketOrder, selectorOf, FORWARDABLE_SELECTORS } from './orders.js';
import { minAmountOutFor, assertMinAmountOut, SlippageFloorError } from './convert.js';
import { ACTION_MATRIX, EMO_MON_MARKET, EMO_MON_PARAMS } from './__fixtures__/newMarkets.js';

/**
 * Item 4: emo/MON's real quirk (`reports/MARKETS-VERIFIED.md` §2 "emo/MON" section,
 * and §5 finding #2). The book has **no asks** — `bestBidAsk()` returns a real bid
 * and the zero "no ask" sentinel — so a real, measured `eth_call` of
 * `placeAndExecuteMarketBuy(quoteSize=100000, 0, true, false)` (1 MON) **succeeds and
 * returns 0**. It does not revert. The report calls this "the same 'succeeds and
 * fills nothing' behaviour `venueState.ts` documents for MON/AUSD" (§5, observation
 * 2).
 *
 * The venue-side half of this — the call itself does not revert — is not this
 * package's problem to solve; it is a fact about the contract. What this package
 * *does* own is what happens to that `0` once it is used to size a slippage floor for
 * a live order: `minAmountOutFor` / `assertMinAmountOut` (`convert.ts`) are the
 * generic "a market order needs a non-zero floor" guard already in this codebase
 * (spec: "a `minAmountOut` of 0 on a market order is a standing offer to accept any
 * fill at any price"). This file is the first time they are exercised with a real
 * measured zero quote rather than a synthetic one.
 */
describe('a zero-fill quote is refused as a floor, not silently accepted (emo/MON, real numbers)', () => {
  it('the real measured amountOut for emo/MON’s 1-MON market buy is exactly 0', () => {
    expect(ACTION_MATRIX.emoMon.marketBuy1Mon.amountOut).toBe(0n);
  });

  it('minAmountOutFor refuses to build a floor under a zero quote', () => {
    expect(() => minAmountOutFor(ACTION_MATRIX.emoMon.marketBuy1Mon.amountOut, 25n)).toThrow(
      SlippageFloorError,
    );
    expect(() => minAmountOutFor(ACTION_MATRIX.emoMon.marketBuy1Mon.amountOut, 25n)).toThrow(
      /nothing out at this size/,
    );
  });

  it('assertMinAmountOut refuses a zero floor even if one were passed through anyway', () => {
    // The failure mode this guards against: treating "the call did not revert" as
    // "there is a fill", and sending a live order with minAmountOut 0 — which accepts
    // any price, on any book, forever.
    expect(() =>
      assertMinAmountOut(0n, ACTION_MATRIX.emoMon.marketBuy1Mon.amountOut),
    ).toThrow(SlippageFloorError);
  });

  it('assertMinAmountOut also refuses checking a floor against the zero quote itself', () => {
    expect(() =>
      assertMinAmountOut(1n, ACTION_MATRIX.emoMon.marketBuy1Mon.amountOut),
    ).toThrow(/quote of zero/);
  });

  it('building the calldata itself does not throw — the venue accepts the call and returns 0, it does not revert', () => {
    // Matches the measured on-chain behaviour exactly: this is not a case the builder
    // should refuse to construct, because the real contract does not refuse it either.
    // The danger is downstream (a floor built from the resulting 0), not here.
    const call = buildMarketOrder({
      market: EMO_MON_MARKET,
      params: EMO_MON_PARAMS,
      side: 'buy',
      amount: 1_000_000_000_000_000_000n, // 1 MON
      minAmountOut: 0n,
    });
    expect(selectorOf(call.data)).toBe(FORWARDABLE_SELECTORS.placeAndExecuteMarketBuy);
  });
});
