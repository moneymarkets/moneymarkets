import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import type { MarketParams } from '@tradepro/core';
import { validate, type TicketDraft } from './ticket.js';

/** MON/AUSD, read live off chain 143 — the same row `apps/indexer/src/markets.ts` seeds. */
const MON_AUSD_MARKET = '0x131A2e70A5b31a517A74b8c567149bc294470Da9' as Address;
const MON_AUSD_PARAMS: MarketParams = {
  pricePrecision: 100_000_000n,
  sizePrecision: 10_000_000_000n,
  baseAsset: '0x0000000000000000000000000000000000000000' as Address,
  baseDecimals: 18,
  quoteAsset: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a' as Address,
  quoteDecimals: 6,
  tickSize: 100n,
  minSize: 2_000_000_000_000n,
  maxSize: 20_000_000_000_000_000_000n,
  takerFeeBps: 0n,
  makerFeeBps: 0n,
};

/**
 * The two submit-time guards added 2026-09-09, both from the logic audit.
 *
 * They are here rather than in a component test because they are the guards that
 * decide whether a passkey prompt happens at all, and a component test would prove
 * only that a particular button was grey.
 */

const BASE: Omit<TicketDraft, 'side' | 'type' | 'priceWire'> = {
  market: MON_AUSD_MARKET,
  params: MON_AUSD_PARAMS,
  // 1 AUSD of notional, comfortably inside the $1,000 cap.
  quoteAmount: 1_000_000n,
  // 40 MON, well under the 200 MON resting minimum — irrelevant to a market order.
  sizeBase: 40n * 10n ** 18n,
};

const PLENTY = 1_000_000_000n;

describe('a market order is refused when the side it would eat is empty (open item #16)', () => {
  /**
   * Measured on MON/AUSD, chain 143 block 103,110,791: `placeAndExecuteMarketBuy`
   * against an empty book does **not** revert. It succeeds and returns
   * `amountOut = 0`, including from the zero sender. So without this guard the user
   * signs with a passkey, pays gas, and receives nothing, with no error anywhere.
   *
   * `priceWire` for a market order is the opposing touch, and is zero exactly when
   * that side is empty — which is only true once `normalizeBestBidAsk` has folded the
   * `2^256-1` no-bid sentinel, added in the same pass.
   */
  it('refuses a market BUY when there are no asks', () => {
    const v = validate({ ...BASE, side: 'buy', type: 'market', priceWire: 0n }, PLENTY, PLENTY);
    expect(v.ok).toBe(false);
    expect(v.message).toMatch(/no orders to buy from/i);
    expect(v.call).toBeUndefined();
  });

  it('refuses a market SELL when there are no bids', () => {
    const v = validate({ ...BASE, side: 'sell', type: 'market', priceWire: 0n }, PLENTY, PLENTY);
    expect(v.ok).toBe(false);
    expect(v.message).toMatch(/no orders to sell into/i);
  });

  it('still builds a market order when the opposing side is real', () => {
    const v = validate(
      { ...BASE, side: 'buy', type: 'market', priceWire: 25_834_000_000_000_000n },
      PLENTY,
      PLENTY,
    );
    expect(v.ok).toBe(true);
    expect(v.call).toBeDefined();
  });

  it('does not change what a limit order says when it has no price', () => {
    const v = validate({ ...BASE, side: 'buy', type: 'limit', priceWire: 0n }, PLENTY, PLENTY);
    expect(v.message).toBe('Enter a price for this order.');
  });
});

describe('the sell side fails CLOSED on an unknown balance', () => {
  /**
   * The guard used to be `availableBase !== undefined && sizeBase > availableBase`, so
   * a balance that had not loaded — or whose read had failed — skipped the check and
   * the order went to chain to be refused there, after a passkey prompt. An unknown
   * balance is not evidence of a sufficient one.
   */
  // 200 MON — this book's own resting minimum, so the builder has no other reason
  // to refuse and the balance guard is the only thing under test.
  const RESTING_MIN = 200n * 10n ** 18n;
  const draft: TicketDraft = {
    ...BASE,
    side: 'sell',
    type: 'limit',
    priceWire: 25_834_000_000_000_000n,
    sizeBase: RESTING_MIN,
  };

  it('refuses when the base balance is not known', () => {
    const v = validate(draft, PLENTY, undefined);
    expect(v.ok).toBe(false);
    expect(v.message).toMatch(/has not loaded yet/i);
  });

  it('refuses when the base balance is known and too small', () => {
    const v = validate(draft, PLENTY, 1n);
    expect(v.ok).toBe(false);
    expect(v.message).toMatch(/do not hold enough/i);
  });

  it('allows the sell when the balance is known and sufficient', () => {
    const v = validate(draft, PLENTY, RESTING_MIN);
    expect(v.ok).toBe(true);
  });

  it('leaves the buy side alone — it already failed closed via `available ?? 0n`', () => {
    const buy: TicketDraft = { ...draft, side: 'buy' };
    expect(validate(buy, 0n, undefined).message).toMatch(/not enough in your trading balance/i);
  });
});
