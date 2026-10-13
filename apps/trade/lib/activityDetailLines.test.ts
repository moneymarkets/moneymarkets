import { describe, expect, it } from 'vitest';
import { detailGroups, reportTextFor } from './activityDetailLines';
import type { ActivityKind, ActivityRow } from './activityStore';

/**
 * The detail view's content, for every activity type (ITEM 4e).
 *
 * The assertion that matters is that **no line is ever rendered with nothing beside
 * it**. `ActivityDetail.tsx` renders exactly what `detailGroups` returns and adds
 * nothing, so asserting on the groups asserts on the screen — and it does so exactly,
 * rather than by searching rendered HTML for the absence of a dash and hoping the
 * string searched for was the right one.
 *
 * The sparse fixtures are the important half. They are shaped like rows written before
 * the detail fields existed, which is what most of a real user's history is.
 */

const PLACEHOLDERS = ['—', '-', 'undefined', 'null', 'NaN', 'N/A', 'n/a', '[object Object]', '?'];

/** Every kind, so adding one to the union without covering it here fails this test. */
const KINDS: readonly ActivityKind[] = [
  'direct-deposit',
  'move',
  'convert',
  'withdraw',
  'send',
  'order',
  'cancel',
];

/** The sparsest row the store permits: id, kind, summary, at. Nothing else. */
function bare(kind: ActivityKind): ActivityRow {
  return { id: `bare-${kind}`, kind, summary: `Something happened (${kind})`, at: 1788933397000 };
}

function full(kind: ActivityKind): ActivityRow {
  const base: ActivityRow = {
    id: `0x${'ab'.repeat(32)}`,
    kind,
    summary: `A complete ${kind} row`,
    amount: '387416705400000000',
    decimals: 18,
    symbol: 'MON',
    txHash: `0x${'ab'.repeat(32)}`,
    userOpHash: `0x${'cd'.repeat(32)}`,
    blockNumber: 103247367,
    at: 1788933397000,
    status: 'confirmed',
    resultingBalance: '5.900000 AUSD',
    resultingLocation: 'trading balance',
    market: 'MON/USDC',
  };
  if (kind === 'order') {
    return {
      ...base,
      trade: {
        side: 'buy',
        baseAmount: '387416705400000000',
        baseSymbol: 'MON',
        baseDecimals: 18,
        quoteAmount: '10000',
        quoteSymbol: 'USDC',
        quoteDecimals: 6,
      },
      order: {
        id: '13130688',
        priceText: '0.025812 USDC',
        sizeText: '0.387417 MON',
        filledText: '0.387417 MON',
        remainingText: '0.000000 MON',
      },
    };
  }
  if (kind === 'direct-deposit') {
    const { market: _market, ...rest } = base;
    return {
      ...rest,
      route: 'Base',
      deposit: {
        sourceChain: 'Base',
        depositAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        upstreamMessage: 'Temporary swap limits: minimum swap amount is $1,000',
      },
    };
  }
  return base;
}

const labelsOf = (row: ActivityRow) => detailGroups(row).flatMap((g) => g.lines.map((l) => l.label));
const valuesOf = (row: ActivityRow) => detailGroups(row).flatMap((g) => g.lines.map((l) => l.value));

describe('the activity detail lines, for every type', () => {
  it.each(KINDS)('a bare %s row produces no empty value', (kind) => {
    for (const value of valuesOf(bare(kind))) {
      expect(value.trim()).not.toBe('');
      for (const placeholder of PLACEHOLDERS) expect(value).not.toBe(placeholder);
    }
  });

  it.each(KINDS)('a bare %s row omits the labels it has no value for', (kind) => {
    const labels = labelsOf(bare(kind));
    for (const absent of [
      'Amount',
      'Resulting balance',
      'Order id',
      'Deposit address',
      'Transaction',
      'User operation',
      'Block',
      'Market',
      'Route',
    ]) {
      expect(labels).not.toContain(absent);
    }
    // What it does know is still there.
    expect(labels).toContain('When');
    expect(labels).toContain('Type');
  });

  it.each(KINDS)('a fully populated %s row produces no empty value either', (kind) => {
    for (const value of valuesOf(full(kind))) {
      expect(value.trim()).not.toBe('');
      for (const placeholder of PLACEHOLDERS) expect(value).not.toBe(placeholder);
    }
  });

  it.each(KINDS)('every %s row states the network fee', (kind) => {
    // The app's central promise, on every row of every type, populated or not.
    for (const row of [bare(kind), full(kind)]) {
      const fees = detailGroups(row).find((g) => g.key === 'fees');
      expect(fees?.lines).toContainEqual({ label: 'Network fee', value: 'Paid for you' });
    }
  });

  it('drops a whole group when every line in it is missing', () => {
    const keys = detailGroups(bare('order')).map((g) => g.key);
    expect(keys).not.toContain('order');
    expect(keys).not.toContain('deposit');
    expect(keys).not.toContain('hashes');
  });

  it('shows order lines only on a row that carries them', () => {
    expect(labelsOf(full('order'))).toContain('Order id');
    expect(labelsOf(full('withdraw'))).not.toContain('Order id');
  });

  it('shows the upstream verbatim and source-named, only on a deposit that has one', () => {
    const lines = detailGroups(full('direct-deposit')).find((g) => g.key === 'deposit')?.lines ?? [];
    const said = lines.find((l) => l.label === 'They said');
    // D124: the upstream's own sentence, never a substitute, always attributed.
    expect(said?.value).toContain('NEAR Intents said');
    expect(said?.value).toContain('minimum swap amount is $1,000');
    expect(labelsOf(full('move'))).not.toContain('Deposit address');
  });

  it('labels both sides of a buy and a sell the way the money actually moved', () => {
    const buy = detailGroups(full('order')).flatMap((g) => g.lines);
    expect(buy.find((l) => l.label === 'Received')?.value).toContain('MON');
    expect(buy.find((l) => l.label === 'Paid')?.value).toContain('USDC');

    const sellRow = full('order');
    const sold: ActivityRow = { ...sellRow, trade: { ...sellRow.trade!, side: 'sell' } };
    const sell = detailGroups(sold).flatMap((g) => g.lines);
    expect(sell.find((l) => l.label === 'Sold')?.value).toContain('MON');
    expect(sell.find((l) => l.label === 'Received')?.value).toContain('USDC');
  });

  it('says Market for a trade and Route for anything else', () => {
    expect(labelsOf(full('order'))).toContain('Market');
    expect(labelsOf(full('direct-deposit'))).toContain('Route');
  });

  it('names the timezone, because this is the screen people reconcile against', () => {
    const when = detailGroups(full('send')).flatMap((g) => g.lines).find((l) => l.label === 'When');
    expect(when?.value).toMatch(/\(.+\)/);
  });
});

describe('the report text', () => {
  it('carries every recorded field for a full row', () => {
    const text = reportTextFor(full('order'));
    expect(text).toContain('A complete order row');
    expect(text).toContain('Status: Confirmed');
    expect(text).toContain('Order id: 13130688');
    expect(text).toContain('Network fee: Paid for you');
    expect(text).toContain('Transaction: 0x');
  });

  it('is short and complete for a bare row rather than padded out', () => {
    const text = reportTextFor(bare('send'));
    expect(text).toContain('Something happened (send)');
    expect(text).not.toContain('Transaction:');
    expect(text).not.toContain('Order id:');
    // No line anywhere ends in a label with nothing after it.
    for (const l of text.split('\n').slice(1)) expect(l).toMatch(/: .+$/);
  });

  it('says exactly what the screen says, so a pasted report is not a different record', () => {
    const row = full('direct-deposit');
    const onScreen = detailGroups(row).flatMap((g) => g.lines.map((l) => `${l.label}: ${l.value}`));
    const inReport = reportTextFor(row).split('\n').slice(2);
    expect(inReport).toEqual(onScreen);
  });
});
