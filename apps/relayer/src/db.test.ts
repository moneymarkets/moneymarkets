import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RelayerDb } from './db.js';

/**
 * `topups.purpose` — added so an operator reading the ledger can see *why* an address
 * was funded, not just how much. The column did not exist on disk before today; the
 * migration in the constructor is what makes an existing `relayer.sqlite` gain it
 * without losing the rows already there.
 */
describe('recordTopUp records a purpose', () => {
  it('persists the purpose and reads it back', () => {
    const db = new RelayerDb(':memory:');
    db.recordTopUp('0xabc', 300_000_000_000_000_000n, 'deposit', 1_000);
    expect(db.topUpFor('0xabc')).toEqual({
      totalWei: 300_000_000_000_000_000n,
      count: 1,
      purpose: 'deposit',
    });
  });

  it('keeps the most recent purpose across repeated top-ups of the same address', () => {
    const db = new RelayerDb(':memory:');
    db.recordTopUp('0xabc', 300_000_000_000_000_000n, 'deposit', 1_000);
    db.recordTopUp('0xabc', 300_000_000_000_000_000n, 'flow-convert', 2_000);
    const row = db.topUpFor('0xabc');
    expect(row?.purpose).toBe('flow-convert');
    expect(row?.count).toBe(2);
    expect(row?.totalWei).toBe(600_000_000_000_000_000n);
  });

  it('is address-case-insensitive, like every other lookup in this table', () => {
    const db = new RelayerDb(':memory:');
    db.recordTopUp('0xABC', 1n, 'deposit', 1_000);
    expect(db.topUpFor('0xabc')?.purpose).toBe('deposit');
  });
});

/**
 * A `:memory:` database never predates the `purpose` column, so it cannot exercise
 * the duplicate-column branch — that needs a real file the constructor opens twice,
 * the second time against a topups table that already has the column. This is exactly
 * what happens to `apps/relayer/data/relayer.sqlite` every time the relayer restarts.
 */
describe('the migration is safe to run against a file that already has the column', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relayer-db-test-'));
  const path = join(dir, 'relayer.sqlite');

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reopening the same file does not throw and keeps the data', () => {
    const first = new RelayerDb(path);
    first.recordTopUp('0xabc', 1n, 'deposit', 1_000);
    first.close();

    // Second open runs the same `ALTER TABLE ... ADD COLUMN purpose` against a file
    // that already has it — this is the duplicate-column error the try/catch exists
    // to swallow.
    const second = new RelayerDb(path);
    expect(second.topUpFor('0xabc')?.purpose).toBe('deposit');
    second.close();
  });
});
