import { describe, expect, it } from 'vitest';
import type { ActivityRow } from '../activityStore';
import { activityToCsv } from './exportCsv';

/**
 * Fixtures shaped exactly like `ActivityRow` (`lib/activityStore.ts`), the real
 * interface every activity row in this app is written against — not a stub shape
 * invented for this test.
 */
const MOVE_ROW: ActivityRow = {
  id: '0xabc123',
  kind: 'move',
  summary: 'Moved 0.20 USDC to trading balance',
  amount: '200000',
  decimals: 6,
  symbol: 'USDC',
  txHash: '0xabc123',
  at: 1758600000000,
  resultingBalance: '25.10 AUSD',
  resultingLocation: 'trading balance',
};

const TRADE_ROW: ActivityRow = {
  id: '0xdef456',
  kind: 'order',
  summary: 'Bought 3.73 MON for 0.10 USDC',
  txHash: '0xdef456',
  at: 1758603600000,
  market: 'MON/USDC',
  status: 'confirmed',
  trade: {
    side: 'buy',
    baseAmount: '3730000000000000000',
    baseSymbol: 'MON',
    baseDecimals: 18,
    quoteAmount: '100000',
    quoteSymbol: 'USDC',
    quoteDecimals: 6,
  },
};

const NO_HASH_ROW: ActivityRow = {
  id: 'arrival-1758600000000',
  kind: 'direct-deposit',
  summary: 'Received 0.50 USDC, "quoted, commas" and a newline\nin the note',
  at: 1758610000000,
};

describe('activityToCsv', () => {
  it('writes a header row and one line per activity row', () => {
    const csv = activityToCsv([MOVE_ROW, TRADE_ROW]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('Date,Kind,Summary,Amount,Symbol,Status,Transaction hash');
    expect(lines).toHaveLength(3);
  });

  it('writes real fields, not placeholders, for a row that has them', () => {
    const csv = activityToCsv([MOVE_ROW]);
    const line = csv.split('\r\n')[1] ?? '';
    expect(line).toContain('move');
    expect(line).toContain('Moved 0.20 USDC to trading balance');
    expect(line).toContain('200000');
    expect(line).toContain('USDC');
    expect(line).toContain('0xabc123');
    expect(line).toContain(new Date(MOVE_ROW.at).toISOString());
  });

  it('defaults status to confirmed when the row does not carry one', () => {
    const csv = activityToCsv([MOVE_ROW]);
    const fields = (csv.split('\r\n')[1] ?? '').split(',');
    expect(fields[5]).toBe('confirmed');
  });

  it('leaves amount, symbol and hash blank rather than fabricating a value', () => {
    const csv = activityToCsv([NO_HASH_ROW]);
    const fields = parseCsvLine(csv.split('\r\n')[1] ?? '');
    expect(fields[3]).toBe(''); // Amount
    expect(fields[4]).toBe(''); // Symbol
    expect(fields[6]).toBe(''); // Transaction hash
  });

  it('quotes a summary that contains a comma or a newline', () => {
    const csv = activityToCsv([NO_HASH_ROW]);
    const line = csv.split('\r\n')[1] ?? '';
    expect(line).toContain('"Received 0.50 USDC, ""quoted, commas"" and a newline\nin the note"');
  });

  it('is an empty-but-headed file for an account with no activity, never a fake row', () => {
    const csv = activityToCsv([]);
    expect(csv).toBe('Date,Kind,Summary,Amount,Symbol,Status,Transaction hash');
  });
});

/** Minimal CSV-line parser for the assertions above; good enough for the shapes
 *  this module ever writes (one quoted field, no embedded CRLF outside quotes). */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        cur += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += char;
    }
  }
  out.push(cur);
  return out;
}
