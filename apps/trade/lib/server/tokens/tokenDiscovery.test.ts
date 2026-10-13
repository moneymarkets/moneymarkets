import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PUBLIC_RPC_GET_LOGS_MAX_RANGE } from '@tradepro/core';
import type { Address } from 'viem';
import { TokenDb } from './tokenDb.js';
import {
  FIRST_SEEN_FLOOR_BLOCKS,
  initialFirstSeen,
  MAX_PAGES_PER_TICK,
  planPages,
  scanTick,
  type ScanPage,
} from './tokenDiscovery.js';

/**
 * Discovery (spec A2b): a forward walk in RPC-sized pages, bounded per tick, with the
 * cursor persisted after every page so the scan never repeats a block. The log read is
 * a fake; what is under test is the walk and its bookkeeping.
 */

const dir = mkdtempSync(join(tmpdir(), 'tradepro-token-discovery-'));
const db = new TokenDb(join(dir, 'tokens.sqlite'));

afterAll(() => {
  // Windows will not remove the directory while the sqlite file handle is open.
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const ACCOUNT = '0x000000000000000000000000000000000000aAaA' as Address;
const AIRDROP = '0x00000000000000000000000000000000000000b1' as Address;
const OTHER = '0x00000000000000000000000000000000000000b2' as Address;

describe('planPages', () => {
  it('pages are exactly the RPC maximum range and never overshoot the head', () => {
    const pages = planPages(1_000n, 1_250n);
    expect(pages[0]).toEqual({ fromBlock: 1_000n, toBlock: 1_000n + PUBLIC_RPC_GET_LOGS_MAX_RANGE - 1n });
    expect(pages[pages.length - 1]?.toBlock).toBe(1_250n);
    for (const p of pages) expect(p.toBlock - p.fromBlock + 1n).toBeLessThanOrEqual(PUBLIC_RPC_GET_LOGS_MAX_RANGE);
  });

  it('one tick is bounded at MAX_PAGES_PER_TICK pages', () => {
    const pages = planPages(0n, 10_000_000n);
    expect(pages).toHaveLength(MAX_PAGES_PER_TICK);
  });

  it('nothing to do when the cursor is past the head', () => {
    expect(planPages(501n, 500n)).toEqual([]);
  });

  it('the first scan starts at the floor, never below block 0', () => {
    expect(initialFirstSeen(1_000_000n)).toBe(1_000_000n - FIRST_SEEN_FLOOR_BLOCKS);
    expect(initialFirstSeen(10n)).toBe(0n);
  });
});

describe('scanTick', () => {
  it('an airdropped token, on no list, is recorded for the account with the page it was seen in, and the cursor advances', async () => {
    const head = 5_001_999n;
    const floor = head - FIRST_SEEN_FLOOR_BLOCKS; // 4_801_999, where the first scan starts
    const airdropBlock = floor + 251n; // inside the third page of the first tick
    const pagesRead: ScanPage[] = [];
    const readLogs = async (_account: Address, page: ScanPage) => {
      pagesRead.push(page);
      return page.fromBlock <= airdropBlock && airdropBlock <= page.toBlock ? [AIRDROP] : [];
    };
    const first = await scanTick({ account: ACCOUNT, head, db, readLogs, now: 1 });
    // Started at the floor, walked exactly MAX_PAGES_PER_TICK pages, not the whole gap.
    expect(pagesRead[0]?.fromBlock).toBe(floor);
    expect(first.pagesScanned).toBe(MAX_PAGES_PER_TICK);
    expect(first.caughtUp).toBe(false);
    expect(db.cursor(ACCOUNT)?.nextBlock).toBe(first.nextBlock);
    expect(first.nextBlock).toBe(floor + BigInt(MAX_PAGES_PER_TICK) * PUBLIC_RPC_GET_LOGS_MAX_RANGE);

    expect(first.discovered).toEqual([AIRDROP]);
    const rows = db.accountTokens(ACCOUNT);
    expect(rows).toHaveLength(1);
    const airdropPage = pagesRead.find((p) => p.fromBlock <= airdropBlock && airdropBlock <= p.toBlock)!;
    expect(rows[0]).toMatchObject({ token: AIRDROP.toLowerCase(), source: 'scan', firstSeenBlock: airdropPage.fromBlock });
  });

  it('a later tick resumes from the cursor and never re-reads a page', async () => {
    const before = db.cursor(ACCOUNT)!.nextBlock;
    const pagesRead: ScanPage[] = [];
    const readLogs = async (_a: Address, page: ScanPage) => {
      pagesRead.push(page);
      return [] as Address[];
    };
    await scanTick({ account: ACCOUNT, head: before + 300n, db, readLogs, now: 3 });
    expect(pagesRead[0]?.fromBlock).toBe(before);
    expect(db.cursor(ACCOUNT)?.nextBlock).toBe(before + 301n);
  });

  it('a token seen twice is recorded once, and its first sighting is kept', async () => {
    const account = '0x000000000000000000000000000000000000cccc' as Address;
    const readLogs = async () => [OTHER];
    const r1 = await scanTick({ account, head: 100_000n + FIRST_SEEN_FLOOR_BLOCKS, db, readLogs, now: 4 });
    expect(r1.discovered).toEqual([OTHER]);
    const r2 = await scanTick({ account, head: 100_000n + FIRST_SEEN_FLOOR_BLOCKS, db, readLogs, now: 5 });
    expect(r2.discovered).toEqual([]);
    expect(db.accountTokens(account)).toHaveLength(1);
    expect(db.accountTokens(account)[0]?.firstSeenBlock).toBe(100_000n);
  });
});

describe('TokenDb', () => {
  it('a manual add is first-evidence-wins against a later scan and vice versa', () => {
    const account = '0x000000000000000000000000000000000000dddd' as Address;
    expect(db.addAccountToken({ account, token: OTHER, firstSeenBlock: null, source: 'manual' }, 10)).toBe(true);
    expect(db.addAccountToken({ account, token: OTHER, firstSeenBlock: 5n, source: 'scan' }, 11)).toBe(false);
    expect(db.accountTokens(account)[0]).toMatchObject({ source: 'manual', firstSeenBlock: null, addedAt: 10 });
  });

  it('contract metadata round-trips by lowercased address and replaces on conflict', () => {
    db.putMeta([{ address: OTHER, symbol: 'OT', name: 'Other', decimals: 9 }], 20);
    expect(db.getMeta([OTHER.toUpperCase() as Address]).get(OTHER.toLowerCase())).toMatchObject({ symbol: 'OT', decimals: 9, readAt: 20 });
    db.putMeta([{ address: OTHER, symbol: 'OT2', name: 'Other 2', decimals: 12 }], 21);
    expect(db.getMeta([OTHER]).get(OTHER.toLowerCase())).toMatchObject({ symbol: 'OT2', decimals: 12, readAt: 21 });
  });
});
