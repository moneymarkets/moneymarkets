import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Address } from 'viem';

/**
 * Token registry persistence: contract-read metadata, per-account discovered tokens,
 * and the per-account Transfer-log scan cursor.
 *
 * Lives on the same SQLite file as the deposit tracker (`DEPOSIT_DB_PATH`), as its own
 * connection and its own tables. WAL mode, which `DepositDb` already sets on this file,
 * makes a second connection from the same process safe; keeping the classes separate
 * keeps each one's schema and tests small.
 *
 * Every block number is stored as TEXT, the same convention `deposit_attempts` uses for
 * `destination_tx_block`, because SQLite integers are signed 64-bit and a block number
 * is a bigint in this codebase.
 */

export interface TokenMetaRow {
  readonly address: Address;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly readAt: number;
}

export type AccountTokenSource = 'scan' | 'manual';

export interface AccountTokenRow {
  readonly account: Address;
  readonly token: Address;
  readonly firstSeenBlock: bigint | null;
  readonly source: AccountTokenSource;
  readonly addedAt: number;
}

export interface ScanCursor {
  readonly account: Address;
  readonly nextBlock: bigint;
  readonly firstSeenBlock: bigint;
  readonly updatedAt: number;
}

export class TokenDb {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS token_meta (
        address   TEXT PRIMARY KEY,
        symbol    TEXT NOT NULL,
        name      TEXT NOT NULL,
        decimals  INTEGER NOT NULL,
        read_at   INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS account_tokens (
        account          TEXT NOT NULL,
        token            TEXT NOT NULL,
        first_seen_block TEXT,
        source           TEXT NOT NULL,
        added_at         INTEGER NOT NULL,
        PRIMARY KEY (account, token)
      );

      CREATE TABLE IF NOT EXISTS token_scan_cursor (
        account          TEXT PRIMARY KEY,
        next_block       TEXT NOT NULL,
        first_seen_block TEXT NOT NULL,
        updated_at       INTEGER NOT NULL
      );
    `);
  }

  /** Contract-read metadata for `addresses`, keyed by lowercased address. Misses are absent. */
  getMeta(addresses: readonly Address[]): Map<string, TokenMetaRow> {
    const out = new Map<string, TokenMetaRow>();
    if (addresses.length === 0) return out;
    const stmt = this.#db.prepare(
      'SELECT address, symbol, name, decimals, read_at FROM token_meta WHERE address = ?',
    );
    for (const address of addresses) {
      const row = stmt.get(address.toLowerCase()) as Record<string, unknown> | undefined;
      if (!row) continue;
      out.set(address.toLowerCase(), {
        address: String(row.address) as Address,
        symbol: String(row.symbol),
        name: String(row.name),
        decimals: Number(row.decimals),
        readAt: Number(row.read_at),
      });
    }
    return out;
  }

  /** Record what the contract itself answered. Replaces any earlier row for the address. */
  putMeta(rows: readonly Omit<TokenMetaRow, 'readAt'>[], now = Date.now()): void {
    if (rows.length === 0) return;
    const stmt = this.#db.prepare(
      `INSERT INTO token_meta (address, symbol, name, decimals, read_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(address) DO UPDATE SET symbol = excluded.symbol, name = excluded.name,
         decimals = excluded.decimals, read_at = excluded.read_at`,
    );
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      for (const r of rows) stmt.run(r.address.toLowerCase(), r.symbol, r.name, r.decimals, now);
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  accountTokens(account: Address): AccountTokenRow[] {
    const rows = this.#db
      .prepare(
        'SELECT account, token, first_seen_block, source, added_at FROM account_tokens WHERE account = ? ORDER BY added_at',
      )
      .all(account.toLowerCase()) as ReadonlyArray<Record<string, unknown>>;
    return rows.map((row) => ({
      account: String(row.account) as Address,
      token: String(row.token) as Address,
      firstSeenBlock: row.first_seen_block === null ? null : BigInt(String(row.first_seen_block)),
      source: String(row.source) as AccountTokenSource,
      addedAt: Number(row.added_at),
    }));
  }

  /**
   * First evidence wins: a token already recorded for the account keeps its original
   * `first_seen_block` and `source`, so a later manual add cannot erase where the scan
   * first saw it, and a later scan cannot overwrite a manual add's timestamp.
   */
  addAccountToken(
    entry: { account: Address; token: Address; firstSeenBlock: bigint | null; source: AccountTokenSource },
    now = Date.now(),
  ): boolean {
    const result = this.#db
      .prepare(
        `INSERT OR IGNORE INTO account_tokens (account, token, first_seen_block, source, added_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        entry.account.toLowerCase(),
        entry.token.toLowerCase(),
        entry.firstSeenBlock === null ? null : entry.firstSeenBlock.toString(),
        entry.source,
        now,
      );
    return Number(result.changes) > 0;
  }

  cursor(account: Address): ScanCursor | undefined {
    const row = this.#db
      .prepare('SELECT account, next_block, first_seen_block, updated_at FROM token_scan_cursor WHERE account = ?')
      .get(account.toLowerCase()) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      account: String(row.account) as Address,
      nextBlock: BigInt(String(row.next_block)),
      firstSeenBlock: BigInt(String(row.first_seen_block)),
      updatedAt: Number(row.updated_at),
    };
  }

  setCursor(account: Address, nextBlock: bigint, firstSeenBlock: bigint, now = Date.now()): void {
    this.#db
      .prepare(
        `INSERT INTO token_scan_cursor (account, next_block, first_seen_block, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(account) DO UPDATE SET next_block = excluded.next_block, updated_at = excluded.updated_at`,
      )
      .run(account.toLowerCase(), nextBlock.toString(), firstSeenBlock.toString(), now);
  }

  close(): void {
    this.#db.close();
  }
}

let shared: TokenDb | undefined;

/** One instance per process, on the same file as the deposit tracker. */
export function tokenDb(): TokenDb {
  if (!shared) shared = new TokenDb(process.env.DEPOSIT_DB_PATH ?? './data/deposits.sqlite');
  return shared;
}
