import { describe, expect, it } from 'vitest';
import { orderBookAbi } from '@tradepro/core';
import {
  decimalsOfPrecision,
  formatBase,
  formatPrice,
  formatQuote,
  formatSize,
  formatWire,
  gapBps,
  renderLadder,
  renderLadderSummary,
  renderPlannedCall,
  renderTable,
} from './format.js';
import { argNamesOf, decodedArgsOf, planCall, selectorOfCall } from './plan.js';
import { buildLadder, resolveAnchor } from './ladder.js';
import {
  MON_AUSD,
  MON_AUSD_BEST_ASK_WIRE,
  MON_AUSD_BEST_BID_WIRE,
  MON_AUSD_MARKET,
} from './__fixtures__/markets.js';

describe('decimalsOfPrecision', () => {
  it('maps a power of ten to its exponent', () => {
    expect(decimalsOfPrecision(1n)).toBe(0);
    expect(decimalsOfPrecision(100n)).toBe(2);
    expect(decimalsOfPrecision(100_000_000n)).toBe(8);
    expect(decimalsOfPrecision(10_000_000_000n)).toBe(10);
  });

  it('refuses anything that is not a power of ten', () => {
    expect(() => decimalsOfPrecision(0n)).toThrow();
    expect(() => decimalsOfPrecision(-10n)).toThrow();
    expect(() => decimalsOfPrecision(150n)).toThrow(/power of ten/);
  });
});

describe('formatters are display-only and never lose the raw value', () => {
  it('formats a MON/AUSD price at 8 decimal places', () => {
    expect(formatPrice(2_544_200n, MON_AUSD)).toBe('0.025442');
    expect(formatPrice(100n, MON_AUSD)).toBe('0.000001');
  });

  it('formats a size at sizePrecision', () => {
    expect(formatSize(2_000_000_000_000n, MON_AUSD)).toBe('200');
  });

  it('formats quote and base at their token decimals', () => {
    expect(formatQuote(20_000_000n, MON_AUSD)).toBe('20');
    expect(formatBase(10n ** 18n, MON_AUSD)).toBe('1');
  });

  it('formats a 1e18 wire price', () => {
    expect(formatWire(MON_AUSD_BEST_BID_WIRE)).toBe('0.025442');
    expect(formatWire(MON_AUSD_BEST_ASK_WIRE)).toBe('0.025952');
  });
});

describe('gapBps', () => {
  it('reports a gap as basis points with one decimal', () => {
    expect(gapBps(7700n, 2_544_200n)).toBe('30.2');
    expect(gapBps(100n, 1_000_000n)).toBe('1.0');
    expect(gapBps(0n, 1_000_000n)).toBe('0.0');
  });

  it('does not divide by zero', () => {
    expect(gapBps(100n, 0n)).toBe('—');
  });
});

describe('renderTable', () => {
  it('pads columns to their widest cell and rules the header', () => {
    const out = renderTable(
      [
        { a: 'x', b: '1' },
        { a: 'longer', b: '22' },
      ],
      [
        { header: 'A', align: 'left', value: (r) => r.a },
        { header: 'B', align: 'right', value: (r) => r.b },
      ],
    );
    const lines = out.split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe('A        B');
    expect(lines[2]).toBe('x        1');
    expect(lines[3]).toBe('longer  22');
  });

  it('handles an empty row set', () => {
    expect(renderTable([], [{ header: 'A', align: 'left', value: () => '' }])).toBe('A\n─');
  });
});

describe('the rendered ladder', () => {
  const ladder = buildLadder(
    { address: MON_AUSD_MARKET, symbol: 'MON/AUSD' },
    {
      params: MON_AUSD,
      anchor: resolveAnchor({
        bidWire: MON_AUSD_BEST_BID_WIRE,
        askWire: MON_AUSD_BEST_ASK_WIRE,
      }),
      feeBps: 30n,
      levels: 4,
      bandLow: 980_000n,
      bandHigh: 1_020_000n,
      sizePerLevelQuote: 20_000_000n,
      side: 'both',
    },
  );

  it('shows every level, sells above buys', () => {
    const rows = renderLadder(ladder).split('\n').slice(2);
    expect(rows).toHaveLength(8);
    expect(rows.slice(0, 4).every((r) => r.startsWith('sell'))).toBe(true);
    expect(rows.slice(4).every((r) => r.startsWith('buy'))).toBe(true);
  });

  it('prints both the human and the raw value of every price', () => {
    const text = renderLadder(ladder);
    expect(text).toContain('price (raw)');
    expect(text).toContain('size (raw)');
    for (const level of ladder.levels) {
      expect(text).toContain(level.price.toString());
      expect(text).toContain(level.size.toString());
    }
  });

  it('the summary states the pps conversion and the total capital', () => {
    const summary = renderLadderSummary(ladder);
    expect(summary).toContain('--fee-bps 30  ->  3000 pps');
    expect(summary).toContain('parts-per-million');
    expect(summary).toContain('TOTAL CAPITAL');
    expect(summary).toContain(ladder.totalQuote.toString());
    expect(summary).toContain(ladder.totalBase.toString());
    expect(summary).toContain('bestBidAsk');
  });
});

describe('planCall', () => {
  const call = planCall({
    label: 'test',
    to: MON_AUSD_MARKET,
    abi: orderBookAbi as never,
    functionName: 'batchProvisionLiquidity',
    args: [[2_544_200], [2_551_900], [7_861_016_429_525n], [true], true],
  });

  it('encodes calldata that decodes back to the same function and arguments', () => {
    expect(selectorOfCall(call)).toBe('0xcca97a3c');
    const args = decodedArgsOf(call);
    expect(args[0]).toEqual([2_544_200]);
    expect(args[1]).toEqual([2_551_900]);
    expect(args[2]).toEqual([7_861_016_429_525n]);
    expect(args[3]).toEqual([true]);
    expect(args[4]).toBe(true);
  });

  it('knows the ABI names of its own arguments', () => {
    expect(argNamesOf(call)).toEqual([
      'prices',
      'flipPrices',
      'sizes',
      'isBuy',
      '_provisionOrRevert',
    ]);
  });

  it('defaults value to zero', () => {
    expect(call.value).toBe(0n);
  });

  it('refuses an argument that does not fit its ABI type', () => {
    expect(() =>
      planCall({
        label: 'bad',
        to: MON_AUSD_MARKET,
        abi: orderBookAbi as never,
        functionName: 'batchProvisionLiquidity',
        // 2**32 does not fit a uint32 price.
        args: [[4_294_967_296], [1], [1n], [true], true],
      }),
    ).toThrow();
  });

  it('renders a call with its selector, target and decoded arguments', () => {
    const text = renderPlannedCall(call, 1);
    expect(text).toContain('0xcca97a3c');
    expect(text).toContain(MON_AUSD_MARKET);
    expect(text).toContain('_provisionOrRevert = true');
    expect(text).toContain('batchProvisionLiquidity');
  });
});
