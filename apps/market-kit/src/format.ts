import { formatUnits, type MarketParams } from '@tradepro/core';
import { argNamesOf, decodedArgsOf, selectorOfCall, type PlannedCall } from './plan.js';
import { fmtBand, type Ladder, type LadderLevel } from './ladder.js';

/**
 * Display only. Nothing in this file feeds a value back into arithmetic (rule A2.6):
 * every number that reaches a column has already been decided in `bigint`.
 */

/** `1e8` -> 8. Kuru precisions are always exact powers of ten (Router enforces it). */
export function decimalsOfPrecision(precision: bigint): number {
  if (precision <= 0n) throw new Error(`precision ${precision} is not positive`);
  let v = precision;
  let d = 0;
  while (v % 10n === 0n) {
    v /= 10n;
    d += 1;
  }
  if (v !== 1n) throw new Error(`precision ${precision} is not a power of ten`);
  return d;
}

export function formatPrice(pricePp: bigint, params: MarketParams): string {
  return formatUnits(pricePp, decimalsOfPrecision(params.pricePrecision));
}

export function formatSize(size: bigint, params: MarketParams): string {
  return formatUnits(size, decimalsOfPrecision(params.sizePrecision));
}

export function formatQuote(units: bigint, params: MarketParams): string {
  return formatUnits(units, params.quoteDecimals);
}

export function formatBase(units: bigint, params: MarketParams): string {
  return formatUnits(units, params.baseDecimals);
}

/** A gap as a share of its price, in basis points, for a human sanity check. */
export function gapBps(gap: bigint, price: bigint): string {
  if (price <= 0n) return '—';
  // One decimal place of a basis point, integer-only.
  const tenths = (gap * 100_000n) / price;
  return `${tenths / 10n}.${tenths % 10n}`;
}

export interface TableColumn<T> {
  readonly header: string;
  readonly align: 'left' | 'right';
  readonly value: (row: T) => string;
}

export function renderTable<T>(rows: readonly T[], columns: readonly TableColumn<T>[]): string {
  const cells = rows.map((row) => columns.map((c) => c.value(row)));
  const widths = columns.map((c, i) =>
    Math.max(c.header.length, ...cells.map((r) => (r[i] ?? '').length)),
  );
  const pad = (text: string, width: number, align: 'left' | 'right'): string =>
    align === 'right' ? text.padStart(width) : text.padEnd(width);
  const line = (values: readonly string[]): string =>
    values.map((v, i) => pad(v, widths[i] ?? 0, columns[i]?.align ?? 'left')).join('  ');
  const rule = widths.map((w) => '─'.repeat(w)).join('  ');
  return [line(columns.map((c) => c.header)), rule, ...cells.map(line)].join('\n');
}

export function renderLadder(ladder: Ladder): string {
  const p = ladder.params;
  const ordered = [
    ...ladder.levels.filter((l) => l.side === 'sell').sort((a, b) => cmp(b.price, a.price)),
    ...ladder.levels.filter((l) => l.side === 'buy').sort((a, b) => cmp(b.price, a.price)),
  ];
  const columns: TableColumn<LadderLevel>[] = [
    { header: 'side', align: 'left', value: (l) => l.side },
    { header: '#', align: 'right', value: (l) => String(l.index) },
    { header: 'price', align: 'right', value: (l) => formatPrice(l.price, p) },
    { header: 'flip', align: 'right', value: (l) => formatPrice(l.flipPrice, p) },
    { header: 'gap bps', align: 'right', value: (l) => gapBps(l.flipGap, l.price) },
    { header: 'size (base)', align: 'right', value: (l) => formatSize(l.size, p) },
    { header: 'price (raw)', align: 'right', value: (l) => l.price.toString() },
    { header: 'flip (raw)', align: 'right', value: (l) => l.flipPrice.toString() },
    { header: 'size (raw)', align: 'right', value: (l) => l.size.toString() },
    {
      header: 'locks',
      align: 'right',
      value: (l) =>
        l.side === 'buy'
          ? `${formatQuote(l.quoteRequired, p)} quote`
          : `${formatBase(l.baseRequired, p)} base`,
    },
  ];
  return renderTable(ordered, columns);
}

function cmp(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * `refSource` is the provenance of a `--ref` anchor. It sits directly under the anchor
 * block because that is the number it explains, and it is absent when the ladder was
 * anchored on the book — where the chain is its own provenance.
 */
export function renderLadderSummary(ladder: Ladder, refSource?: string): string {
  const p = ladder.params;
  const buys = ladder.levels.filter((l) => l.side === 'buy').length;
  const sells = ladder.levels.filter((l) => l.side === 'sell').length;
  return [
    `anchor            ${ladder.anchor.source}  (${ladder.anchor.note})`,
    `  best bid        ${formatWire(ladder.anchor.bidWire)}`,
    `  best ask        ${formatWire(ladder.anchor.askWire)}`,
    `  mid             ${formatWire(ladder.anchor.midWire)}`,
    ...(refSource ? wrapLabelled('  source', refSource) : []),
    `band              ${fmtBand(ladder.bandLow)} .. ${fmtBand(ladder.bandHigh)} of mid`,
    `fee               --fee-bps ${ladder.feeBps}  ->  ${ladder.feePps} pps` +
      `   (x100: minFeesPps is parts-per-million, not bps)`,
    `levels            ${ladder.levelsPerSide} per side  (${buys} buy, ${sells} sell)`,
    `size per level    ${formatQuote(ladder.sizePerLevelQuote, p)} quote`,
    `tick              ${p.tickSize} (${formatPrice(p.tickSize, p)})`,
    `minSize/maxSize   ${p.minSize} / ${p.maxSize}`,
    '',
    `TOTAL CAPITAL`,
    `  quote (buys)    ${formatQuote(ladder.totalQuote, p)}  [${ladder.totalQuote} base units]`,
    `  base  (sells)   ${formatBase(ladder.totalBase, p)}  [${ladder.totalBase} base units]`,
  ].join('\n');
}

/**
 * A long value under a short label, wrapped to the width the rest of the report uses
 * and hanging-indented so the label column stays readable.
 */
export function wrapLabelled(label: string, value: string, width = 96): string[] {
  const indent = ' '.repeat(18);
  const first = `${label.padEnd(18)}`;
  const out: string[] = [];
  let line = '';
  for (const word of value.split(/\s+/).filter(Boolean)) {
    const candidate = line.length === 0 ? word : `${line} ${word}`;
    if (candidate.length + 18 > width && line.length > 0) {
      out.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line.length > 0) out.push(line);
  return out.map((text, i) => (i === 0 ? first + text : indent + text));
}

/** 1e18 wire price -> human string. */
export function formatWire(wire: bigint): string {
  return formatUnits(wire, 18);
}

/**
 * A call with an empty ABI is one whose bytes this kit did not build — today only the
 * Kuru Flow swap, whose route encoding is the aggregator's and is not documented. It
 * is printed whole rather than decoded, because inventing a decode for it would be
 * exactly the hallucinated-ABI failure rule A2.5 exists to prevent.
 */
export function renderPlannedCall(call: PlannedCall, index: number): string {
  const opaque = call.abi.length === 0;
  const args = opaque ? [] : decodedArgsOf(call);
  const names = opaque ? [] : argNamesOf(call);
  const lines = [
    `  [${index}] ${call.label}`,
    `       target     ${call.to}`,
    `       function   ${call.functionName}`,
    `       selector   ${selectorOfCall(call)}`,
    `       value      ${call.value} wei`,
    `       calldata   ${
      call.data.length > 138
        ? `${call.data.slice(0, 138)}… (${(call.data.length - 2) / 2} bytes)`
        : call.data
    }`,
  ];
  if (opaque) {
    lines.push('       args       not decoded — no ABI for this selector. The bytes above are');
    lines.push('                  the whole call; nothing here re-encodes or reinterprets them.');
    lines.push(`       full       ${call.data}`);
    return lines.join('\n');
  }
  lines.push('       decoded args:');
  args.forEach((arg, i) => {
    lines.push(`         ${names[i] ?? `arg${i}`} = ${renderArg(arg)}`);
  });
  return lines.join('\n');
}

function renderArg(arg: unknown): string {
  if (typeof arg === 'bigint') return arg.toString();
  if (Array.isArray(arg)) {
    const inner = arg.map(renderArg);
    const joined = inner.join(', ');
    return joined.length > 160
      ? `[${inner.length} items] ${inner.slice(0, 6).join(', ')}, … , ${inner.slice(-1)[0]}`
      : `[${joined}]`;
  }
  return String(arg);
}

export function heading(text: string): string {
  return `\n${text}\n${'─'.repeat(text.length)}`;
}
