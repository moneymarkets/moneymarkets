import { PUBLIC_RPC_GET_LOGS_MAX_RANGE } from '@tradepro/core';
import type { Address } from 'viem';
import type { TokenDb } from './tokenDb.js';

/**
 * Holdings discovery (spec A2b): find every ERC-20 the account has ever received by
 * walking `Transfer(*, account, *)` logs forward from a persisted cursor, in pages the
 * public RPC accepts, a bounded number of pages per call, so a route never blocks and
 * the scan never repeats a block.
 *
 * Pure planning here; the log read is injected so the walk is tested without a chain.
 */

/**
 * Where a first scan starts: this many blocks below the head. About one day at
 * Monad's 400 ms blocks. A full-chain walk at 100 blocks a page is on the order of
 * a million requests per account and is not done. An airdrop older than this floor
 * to an account this app has never scanned is reached through add-by-address (A2c).
 * Recorded as a decision.
 */
export const FIRST_SEEN_FLOOR_BLOCKS = 200_000n;

/** Pages per tick: 2,000 blocks, about 13 minutes of chain, per call. */
export const MAX_PAGES_PER_TICK = 20;

export interface ScanPage {
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
}

export function initialFirstSeen(head: bigint, floor = FIRST_SEEN_FLOOR_BLOCKS): bigint {
  return head > floor ? head - floor : 0n;
}

/** The pages one tick walks: from `nextBlock` up to `head`, never past either bound. */
export function planPages(
  nextBlock: bigint,
  head: bigint,
  pageSize = PUBLIC_RPC_GET_LOGS_MAX_RANGE,
  maxPages = MAX_PAGES_PER_TICK,
): ScanPage[] {
  const pages: ScanPage[] = [];
  let from = nextBlock;
  while (from <= head && pages.length < maxPages) {
    const to = from + pageSize - 1n > head ? head : from + pageSize - 1n;
    pages.push({ fromBlock: from, toBlock: to });
    from = to + 1n;
  }
  return pages;
}

/** Reads one page and answers the distinct token contracts that emitted a Transfer to `account`. */
export type TransferLogReader = (account: Address, page: ScanPage) => Promise<readonly Address[]>;

export interface ScanTickResult {
  readonly pagesScanned: number;
  readonly discovered: readonly Address[];
  readonly nextBlock: bigint;
  readonly caughtUp: boolean;
}

/**
 * One tick: resume from the account's cursor (or start at the floor), walk up to
 * `MAX_PAGES_PER_TICK` pages, record every new token, advance the cursor after each
 * page so a failure mid-tick loses at most one page's work, never more.
 */
export async function scanTick(input: {
  readonly account: Address;
  readonly head: bigint;
  readonly db: TokenDb;
  readonly readLogs: TransferLogReader;
  readonly now?: number;
}): Promise<ScanTickResult> {
  const { account, head, db, readLogs } = input;
  const existing = db.cursor(account);
  const firstSeen = existing?.firstSeenBlock ?? initialFirstSeen(head);
  let next = existing?.nextBlock ?? firstSeen;
  if (!existing) db.setCursor(account, next, firstSeen, input.now);

  const pages = planPages(next, head);
  const discovered: Address[] = [];
  for (const page of pages) {
    const tokens = await readLogs(account, page);
    for (const token of tokens) {
      const added = db.addAccountToken(
        { account, token, firstSeenBlock: page.fromBlock, source: 'scan' },
        input.now,
      );
      if (added) discovered.push(token);
    }
    next = page.toBlock + 1n;
    db.setCursor(account, next, firstSeen, input.now);
  }
  return { pagesScanned: pages.length, discovered, nextBlock: next, caughtUp: next > head };
}
