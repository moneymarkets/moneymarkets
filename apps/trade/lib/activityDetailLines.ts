'use client';

import type { ActivityRow } from './activityStore';
import { formatMoney } from './format';
import { absoluteTime, amountText, kindLabel, statusLabel, whereText } from './activityView';

/**
 * What the detail view says about a row, as data (ITEM 4c and 4e).
 *
 * ## Why this is not inside the component
 *
 * The rule that matters here — *omit any line we genuinely lack rather than showing a
 * blank* — is a decision about content, not about markup. Keeping it in a pure module
 * means it can be tested directly and exactly: a test asserts which lines exist for
 * which row, rather than scanning rendered HTML for the absence of a dash and hoping
 * the string it searched for was the right one.
 *
 * `ActivityDetail.tsx` renders whatever this returns and adds nothing of its own, so
 * there is no second place where a line could be invented.
 *
 * ## Absent is absent
 *
 * `line()` returns nothing when the value is missing or empty, and the group functions
 * drop a whole section when every line in it is missing. Nothing here ever substitutes
 * a dash, a zero or an "unknown": a row written before a field existed does not know
 * it, and printing a placeholder beside a label would be this app claiming to have
 * recorded something it did not.
 */

export interface DetailLine {
  readonly label: string;
  readonly value: string;
  /** Render in the tabular/monospace style and allow it to wrap mid-string. */
  readonly mono?: boolean;
}

export interface DetailGroup {
  readonly key: string;
  readonly lines: readonly DetailLine[];
}

function line(label: string, value: string | undefined, mono?: boolean): DetailLine[] {
  if (value === undefined || value.trim() === '') return [];
  return [mono === undefined ? { label, value } : { label, value, mono }];
}

function group(key: string, lines: DetailLine[]): DetailGroup[] {
  return lines.length === 0 ? [] : [{ key, lines }];
}

/** Both sides of a fill, labelled by which way the money went. */
function tradeLines(row: ActivityRow): DetailLine[] {
  const t = row.trade;
  if (!t) return [];
  const base = `${formatMoney(BigInt(t.baseAmount), t.baseDecimals, 6)} ${t.baseSymbol}`;
  const quote = `${formatMoney(BigInt(t.quoteAmount), t.quoteDecimals, 6)} ${t.quoteSymbol}`;
  return t.side === 'buy'
    ? [...line('Received', base), ...line('Paid', quote)]
    : [...line('Sold', base), ...line('Received', quote)];
}

export function detailGroups(row: ActivityRow): readonly DetailGroup[] {
  const resulting =
    row.resultingBalance && row.resultingLocation
      ? `${row.resultingBalance} in your ${row.resultingLocation}`
      : row.resultingBalance;

  return [
    ...group('what', [
      ...line('When', absoluteTime(row.at)),
      ...line('Type', kindLabel(row)),
      ...line('Amount', amountText(row, formatMoney)),
      ...tradeLines(row),
      ...line(row.market ? 'Market' : 'Route', whereText(row)),
      ...line('Resulting balance', resulting),
    ]),
    // Always present, on every row and every type: it is the app's central promise and
    // the one number a user goes looking for and cannot otherwise find.
    ...group('fees', [...line('Network fee', 'Paid for you'), ...line('Other fees', row.feeText)]),
    ...group('order', [
      ...line('Order id', row.order?.id, true),
      ...line('Price', row.order?.priceText),
      ...line('Size', row.order?.sizeText),
      ...line('Filled', row.order?.filledText),
      ...line('Remaining', row.order?.remainingText),
    ]),
    ...group('deposit', [
      ...line('From', row.deposit?.sourceChain),
      ...line('Deposit address', row.deposit?.depositAddress, true),
      // Verbatim and source-named, never a substitute sentence (D124).
      ...line(
        'They said',
        row.deposit?.upstreamMessage
          ? `NEAR Intents said: “${row.deposit.upstreamMessage}”`
          : undefined,
      ),
    ]),
    ...group('hashes', [
      ...line('Transaction', row.txHash, true),
      ...line('User operation', row.userOpHash, true),
      ...line('Block', row.blockNumber === undefined ? undefined : String(row.blockNumber)),
    ]),
  ];
}

/**
 * The whole record as plain text, for a support message or a bug report.
 *
 * Built from the same groups the screen shows, so what a user pastes is exactly what
 * they were looking at — a report that quietly contains more or less than the screen
 * is a report that starts an argument about what they actually saw.
 */
export function reportTextFor(row: ActivityRow): string {
  const lines = [row.summary, `Status: ${statusLabel(row)}`];
  for (const g of detailGroups(row)) {
    for (const l of g.lines) lines.push(`${l.label}: ${l.value}`);
  }
  return lines.join('\n');
}
