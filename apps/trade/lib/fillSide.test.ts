import { describe, expect, it } from 'vitest';
import { departedRow, type WatchedOrder } from './activity';

/**
 * The row written when a resting order leaves the book (2026-09-09 audit).
 *
 * This is the path that runs when nobody is watching — the user is away, their order
 * fills, and the only account of it is whatever this function wrote. It is therefore
 * the side most likely to be wrong without anyone noticing, which is why it gets its
 * own test rather than riding on the detail-view suite.
 *
 * The load-bearing assertion is that the side comes from the **order record**. A resting
 * order that fills makes its owner the maker, and `Trade.isBuy` is the taker's side, so
 * this is exactly the case where reading the event would produce the opposite word.
 */

const buy: WatchedOrder = {
  id: '13130688',
  isBuy: true,
  sizeText: '200.00 MON',
  priceText: '0.025812 USDC',
};
const sell: WatchedOrder = { ...buy, id: '13130689', isBuy: false };

describe('a resting order that leaves the book', () => {
  it('says "buy" for a buy order, from the order record and not from an event', () => {
    const row = departedRow(buy, 'MON/USDC', false, 1788933397000);
    expect(row.summary).toBe('Your buy order for 200.00 MON at 0.025812 USDC filled on MON/USDC');
    expect(row.kind).toBe('order');
  });

  it('says "sell" for a sell order', () => {
    expect(departedRow(sell, 'MON/USDC', false, 1).summary).toContain('Your sell order');
  });

  it('never describes a fill with the opposite side', () => {
    // The regression this whole audit exists to prevent: an owner whose resting BUY
    // filled is the maker, and Trade.isBuy on that fill is the TAKER's side — false.
    // Reading the event would have written "sell". The record says buy, and so do we.
    const eventIsBuyForTheTaker = false;
    const naive = eventIsBuyForTheTaker ? 'buy' : 'sell';
    const row = departedRow(buy, 'MON/USDC', false, 1);
    expect(row.summary).toContain('buy');
    expect(row.summary).not.toContain(naive);
  });

  it('is a cancellation when this app recorded cancelling it', () => {
    const row = departedRow(buy, 'MON/USDC', true, 1);
    expect(row.kind).toBe('cancel');
    expect(row.summary).toBe('Cancelled your buy order for 200.00 MON at 0.025812 USDC on MON/USDC');
    expect(row.summary).not.toContain('filled');
  });

  it('uses an id the cancel path also writes, so the two collapse into one row', () => {
    // `OpenOrdersCard` writes `cancel:<market>:<id>` when a cancellation confirms, and
    // `recordActivity` is idempotent on id — so the watcher noticing the same departure
    // a moment later adds nothing rather than duplicating it.
    expect(departedRow(buy, 'MON/USDC', true, 1).id).toBe('cancel:MON/USDC:13130688');
    expect(departedRow(buy, 'MON/USDC', false, 1).id).toBe('fill:MON/USDC:13130688');
  });

  it('carries the amount with its token and the price with its own', () => {
    const row = departedRow(buy, 'MON/USDC', false, 1);
    // Rule: no bare amount anywhere.
    expect(row.order?.sizeText).toBe('200.00 MON');
    expect(row.order?.priceText).toBe('0.025812 USDC');
    expect(row.market).toBe('MON/USDC');
  });

  it('still writes a usable row when the market params were not loaded', () => {
    // No size or price text: the app knows the order left and which way it faced, and
    // says only that rather than inventing a scale it could not read.
    const sparse: WatchedOrder = { id: '7', isBuy: true };
    const row = departedRow(sparse, 'MON/AUSD', false, 1);
    expect(row.summary).toBe('Your buy order filled on MON/AUSD');
    expect(row.order?.sizeText).toBeUndefined();
    expect(row.order?.priceText).toBeUndefined();
  });

  it('records the order id so the detail view can show it', () => {
    expect(departedRow(buy, 'MON/USDC', false, 1).order?.id).toBe('13130688');
  });
});
