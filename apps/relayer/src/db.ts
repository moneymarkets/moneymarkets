import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  HOUR_MS,
  oldestWindowInDay,
  prefundHeadroom,
  windowStartOf,
  type FreeActionUsage,
  type PrefundBudgets,
  type PrefundHeadroom,
  type PrefundUsage,
} from '@tradepro/core';

/**
 * Persistence (spec §5.5). SQLite via Node's built-in `node:sqlite`, so there is no
 * native postinstall step — rule A4 forbids postinstall scripts from unknown
 * packages, and `better-sqlite3` would need one on every platform this runs on.
 *
 * Nothing here stores a signature, a request body, or key material. Relays are
 * recorded by their selector and hash so the logs can answer "what did we forward,
 * for whom, and what did it cost" without holding anything sensitive.
 */

export interface RelayRow {
  readonly id: number;
  readonly from: string;
  readonly to: string;
  readonly selector: string;
  readonly purpose: string;
  readonly txHash: string | null;
  readonly status: RelayStatus;
  readonly gasUsed: string | null;
  readonly monSpent: string | null;
  readonly error: string | null;
  readonly createdAt: number;
  readonly minedAt: number | null;
}

/**
 * Every status a relay row can hold.
 *
 * Exported so the metrics endpoint bounds its label cardinality against THIS list
 * rather than a hand-copied one. A hand-copied set had already drifted: it carried
 * 'submitted' and 'mined', which nothing writes, and omitted 'success', which is what
 * the submit path writes the moment the gate opens — so every successful relay would
 * have been counted as "other" on the one counter that matters most.
 */
export const RELAY_STATUSES = ['pending', 'success', 'reverted', 'rejected'] as const;
export type RelayStatus = (typeof RELAY_STATUSES)[number];

/**
 * A row in the sponsorship ledger.
 *
 *   reserved    — counted. Written before any MON moves, in the same transaction as
 *                 the budget check, so two requests can never both see the same room.
 *   paid        — counted. The deposit transaction mined successfully.
 *   unconfirmed — counted. A transaction was sent and no receipt has been seen for it.
 *                 It may yet land, so it stays against the budget: fail closed.
 *   released    — not counted. Nothing reached the account: the transaction was never
 *                 sent, or it reverted, which returns the value.
 */
export const PREFUND_STATUSES = ['reserved', 'paid', 'unconfirmed', 'released'] as const;
export type PrefundStatus = (typeof PREFUND_STATUSES)[number];
const COUNTED = `('reserved', 'paid', 'unconfirmed')`;
const UNSETTLED = `('reserved', 'unconfirmed')`;

/**
 * The purpose of a self-bundle's own ledger row, and of no other row.
 *
 * Self-bundle rows share the table with sponsorship rows (so the rows written before
 * 2026-09-24's separation keep counting where they should, with no migration), but never
 * a budget: `prefundUsage` leaves them out, `reservePrefund` refuses to write one, and
 * `reserveSelfBundle` writes nothing else. A sponsorship purpose is inferred server-side
 * from the batch's shape ('deposit', 'deposit+convert', 'flow-convert', 'other'), never
 * taken from a client, so no top-up can carry this one.
 */
export const SELF_BUNDLE_PURPOSE = 'self-bundle';

/** Why `reserveSelfBundle` refused. Each one sends the operation to Pimlico instead. */
export type SelfBundleRefusal = 'loss-limit' | 'in-flight' | 'float-floor' | 'too-large' | 'amount';

/**
 * The purpose prefix of a top-up paid for an operation that pays its own gas (2026-09-24).
 *
 * The owner's rule: the per-address sponsorship budgets bound the free path only. Once an
 * operation carries a fee leg the relayer verified, its top-up is bounded by the
 * all-addresses hourly budget alone, and it does not use up the account's own budget for
 * its free actions. So `prefundUsage` leaves these rows out of the address's own sums and
 * keeps them in the all-addresses hour. The purpose is set by the relayer after the fee leg
 * verified, never taken from a client.
 */
export const FEE_PAID_PURPOSE_PREFIX = 'fee-paid:';

/**
 * The purpose of a top-up for a withdraw, a send or a cancel (2026-09-25 rebuild).
 *
 * Owner's policy: these three are always sponsored, never counted against the free
 * tier, never charged, and almost never refused for gas — the only ordinary reason any
 * of them can fail is the chain or the venue. "Bound by nothing" was the first version
 * of this (`budgetsFor('exempt', ...)` unbounded on every axis) and a security review
 * the same day found it left a stream of fresh addresses nothing to stop them draining
 * the whole float. It is now bound, on its own ledger, by `EXEMPT_MAX_MON_PER_ADDRESS_DAY`,
 * a percentage share of the shared hour (`EXEMPT_ALL_ADDRESSES_SHARE_PERCENT`, carved OUT
 * of the existing shared ceiling, not added to it, so the relayer's total hourly payout is
 * unchanged from before this purpose existed), and, per address, a percentage share of
 * THAT pool in turn (`EXEMPT_PER_ADDRESS_SHARE_OF_POOL_PERCENT` — a fixed per-address wei
 * figure, tried first, happened to equal the whole pool, so one address alone could take
 * it all). `prefundUsage` still
 * leaves exempt rows out of the sponsored and fee-paid sums, the address's own and
 * everyone's shared hour alike, the same way `SELF_BUNDLE_PURPOSE` already is, so an
 * account's withdraws can never eat into its own or anyone else's ordinary allowance —
 * but exempt's OWN shared-hour sum, unlike those two, does count exempt rows, because
 * that sum is what its own carved-out ceiling bounds. They still land in
 * `prefund_ledger`, tagged, for visibility.
 */
export const EXEMPT_PURPOSE = 'exempt';

/** Which top-ups an address's own budget sums count: the free path's, the charged path's, or an always-sponsored one's (never counted at all). */
export type PrefundLedger = 'sponsored' | 'fee-paid' | 'exempt';

/**
 * A free action's ledger row.
 *
 *   reserved — counted. Written before the operation is submitted, in the same transaction
 *              as the count, so two concurrent sends can never both take the last one.
 *   used     — counted. The operation was handed to a bundler (ours or Pimlico).
 *   released — not counted. It never left the relayer.
 */
export const FREE_ACTION_STATUSES = ['reserved', 'used', 'released'] as const;
export type FreeActionStatus = (typeof FREE_ACTION_STATUSES)[number];
const ACTION_COUNTED = `('reserved', 'used')`;

export class RelayerDb {
  readonly #db: DatabaseSync;

  /** Hour window most recently pruned, so the prune runs once per rollover. */
  #lastPrunedWindow = 0;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS relays (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_address TEXT NOT NULL,
        to_address TEXT NOT NULL,
        selector TEXT NOT NULL,
        purpose TEXT NOT NULL,
        tx_hash TEXT,
        status TEXT NOT NULL,
        gas_used TEXT,
        mon_spent TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        mined_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS relays_from ON relays(from_address, created_at);
      CREATE INDEX IF NOT EXISTS relays_tx ON relays(tx_hash);

      CREATE TABLE IF NOT EXISTS rate_limits (
        subject TEXT NOT NULL,
        kind TEXT NOT NULL,
        window_start INTEGER NOT NULL,
        count INTEGER NOT NULL,
        PRIMARY KEY (subject, kind, window_start)
      );

      -- The metrics endpoint groups by these two. Without indexes each scrape was a
      -- full table scan, which on an ungoverned endpoint is a denial-of-service knob.
      CREATE INDEX IF NOT EXISTS relays_status ON relays(status);
      CREATE INDEX IF NOT EXISTS relays_purpose ON relays(purpose);
      CREATE INDEX IF NOT EXISTS rate_limits_window ON rate_limits(window_start);

      -- Running totals, maintained on write. Summing mon_spent across every relay row
      -- on each scrape was linear in table size and got slower forever.
      CREATE TABLE IF NOT EXISTS counters (
        name TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS float_snapshots (
        ts INTEGER PRIMARY KEY,
        balance_wei TEXT NOT NULL
      );

      -- Running totals of gas funding per address, for metrics and operator reading.
      -- Until 2026-09-23 this was also the ledger a per-address *lifetime* cap was
      -- enforced against. It no longer enforces anything: the rolling budgets read
      -- prefund_ledger below. Kept because relayer_entrypoint_topup_wei_total is a
      -- Prometheus counter read from it, and a counter must not reset.
      CREATE TABLE IF NOT EXISTS topups (
        address TEXT PRIMARY KEY,
        total_wei TEXT NOT NULL,
        count INTEGER NOT NULL,
        last_at INTEGER NOT NULL
      );

      -- The sponsorship ledger the rolling budgets are enforced against (S4-C2, B7).
      -- One row per top-up attempt, bucketed into the same fixed hourly windows as
      -- rate_limits. It must survive a restart, or a restart would hand every address a
      -- fresh budget. Rows older than a day plus one window are pruned on rollover.
      CREATE TABLE IF NOT EXISTS prefund_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        address TEXT NOT NULL,
        window_start INTEGER NOT NULL,
        amount_wei TEXT NOT NULL,
        status TEXT NOT NULL,
        purpose TEXT NOT NULL,
        tx_hash TEXT,
        created_at INTEGER NOT NULL,
        settled_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS prefund_ledger_address ON prefund_ledger(address, window_start);
      CREATE INDEX IF NOT EXISTS prefund_ledger_window ON prefund_ledger(window_start);
      -- R9 second pass (D201): every self-bundle reservation reads exposure, in-flight
      -- count and unsettled outflow inside one write-locked transaction (reserveSelfBundle),
      -- each filtering by exactly purpose + status + window_start -- neither existing index
      -- leads with purpose, so these were table-ish scans held under the write lock
      -- that also blocks every other writer in this process. Purely additive: same rows,
      -- same answers, less work to find them.
      CREATE INDEX IF NOT EXISTS prefund_ledger_purpose_status_window
        ON prefund_ledger(purpose, status, window_start);

      -- Free actions (2026-09-24): one row per counted sponsored operation, in the same
      -- fixed hourly windows as prefund_ledger. A send or a withdraw of the user's own
      -- funds never writes a row. Must survive a restart, or a restart would hand every
      -- account a fresh twenty. Pruned with prefund_ledger.
      CREATE TABLE IF NOT EXISTS free_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        address TEXT NOT NULL,
        window_start INTEGER NOT NULL,
        status TEXT NOT NULL,
        purpose TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        settled_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS free_actions_address ON free_actions(address, window_start);
      CREATE INDEX IF NOT EXISTS free_actions_window ON free_actions(window_start);

      -- The durable backstop (D172): one row per fee-paid top-up, naming the operation it
      -- was paid for. While a row for an address is 'outstanding', no second fee-paid
      -- top-up is paid to that address. It leaves 'outstanding' only when that operation's
      -- UserOperationEvent is seen on chain ('confirmed'), or when the top-up itself never
      -- went out ('released'). Never pruned while outstanding: that is the point.
      CREATE TABLE IF NOT EXISTS fee_paid_topups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        address TEXT NOT NULL,
        user_op_hash TEXT NOT NULL,
        from_block TEXT NOT NULL,
        status TEXT NOT NULL,
        success INTEGER,
        created_at INTEGER NOT NULL,
        settled_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS fee_paid_topups_address ON fee_paid_topups(address, status);
      CREATE INDEX IF NOT EXISTS fee_paid_topups_hash ON fee_paid_topups(user_op_hash);

      -- Gas burned by operations this relayer has seen land (D172, scenario H): the
      -- actualGasCost from each one's UserOperationEvent, read where the backstop already
      -- reads it (our own bundle's receipt, or the event by hash). After an account's first
      -- paid top-up, a later one may only replace what the rows counted here add up to since
      -- the block before the last one. 'counted' says whether a row may be replaced; see
      -- recordGasBurn. Not pruned: a pruned burn would be credit an honest account loses.
      CREATE TABLE IF NOT EXISTS gas_burns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_op_hash TEXT NOT NULL UNIQUE,
        address TEXT NOT NULL,
        block INTEGER,
        actual_gas_cost TEXT NOT NULL,
        success INTEGER NOT NULL,
        counted INTEGER NOT NULL,
        recorded_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS gas_burns_address ON gas_burns(address, block);
    `);
    // `CREATE TABLE IF NOT EXISTS` does not add a column to a table that already
    // exists on disk from before this column existed. SQLite has no
    // `ADD COLUMN IF NOT EXISTS`, so the duplicate-column error is the check.
    try {
      this.#db.exec(`ALTER TABLE topups ADD COLUMN purpose TEXT NOT NULL DEFAULT 'unknown'`);
    } catch (error) {
      if (!(error instanceof Error) || !/duplicate column/i.test(error.message)) throw error;
    }
    // The backstop covers the exempt scope too (owner item 1, 2026-09-29, D191), on its own
    // markers. An exempt marker records its operation's nonce, for inspection only.
    // Existing rows are fee-paid, which is what the default says.
    for (const column of [
      `ALTER TABLE fee_paid_topups ADD COLUMN scope TEXT NOT NULL DEFAULT 'fee-paid'`,
      `ALTER TABLE fee_paid_topups ADD COLUMN nonce TEXT`,
      // A self-bundle's own transaction nonce (R9, 2026-10-07): the sweep releases a row
      // that never landed only once the relayer's mined nonce has moved past it.
      `ALTER TABLE prefund_ledger ADD COLUMN tx_nonce INTEGER`,
    ]) {
      try {
        this.#db.exec(column);
      } catch (error) {
        if (!(error instanceof Error) || !/duplicate column/i.test(error.message)) throw error;
      }
    }
  }

  /** Read a running total. Absent counter reads as zero. */
  counter(name: string): bigint {
    const row = this.#db.prepare(`SELECT value FROM counters WHERE name = ?`).get(name) as
      { value: string } | undefined;
    if (!row) return 0n;
    try {
      return BigInt(row.value);
    } catch {
      return 0n;
    }
  }

  /** Add to a running total. Called on the write path so reads stay O(1). */
  addToCounter(name: string, delta: bigint): bigint {
    const next = this.counter(name) + delta;
    this.#db
      .prepare(
        `INSERT INTO counters (name, value) VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET value = excluded.value`,
      )
      .run(name, next.toString());
    return next;
  }

  recordRelay(entry: {
    from: string;
    to: string;
    selector: string;
    purpose: string;
    status: RelayRow['status'];
    txHash?: string | null;
    error?: string | null;
    now?: number;
  }): number {
    const stmt = this.#db.prepare(
      `INSERT INTO relays (from_address, to_address, selector, purpose, tx_hash, status, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const result = stmt.run(
      entry.from.toLowerCase(),
      entry.to.toLowerCase(),
      entry.selector.toLowerCase(),
      entry.purpose,
      entry.txHash ?? null,
      entry.status,
      entry.error ?? null,
      entry.now ?? Date.now(),
    );
    return Number(result.lastInsertRowid);
  }

  markMined(
    txHash: string,
    status: RelayRow['status'],
    detail: { gasUsed?: bigint; monSpent?: bigint; error?: string; now?: number } = {},
  ): void {
    this.#db
      .prepare(
        `UPDATE relays SET status = ?, gas_used = ?, mon_spent = ?, error = ?, mined_at = ?
         WHERE tx_hash = ?`,
      )
      .run(
        status,
        detail.gasUsed?.toString() ?? null,
        detail.monSpent?.toString() ?? null,
        detail.error ?? null,
        detail.now ?? Date.now(),
        txHash.toLowerCase(),
      );
    if (detail.monSpent !== undefined && detail.monSpent > 0n) {
      this.addToCounter('mon_spent_wei', detail.monSpent);
    }
  }

  findByTxHash(txHash: string): RelayRow | undefined {
    const row = this.#db
      .prepare(`SELECT * FROM relays WHERE tx_hash = ? ORDER BY id DESC LIMIT 1`)
      .get(txHash.toLowerCase()) as Record<string, unknown> | undefined;
    return row ? toRelayRow(row) : undefined;
  }

  pendingCount(): number {
    const row = this.#db
      .prepare(`SELECT COUNT(*) AS n FROM relays WHERE status = 'pending'`)
      .get() as { n: number };
    return Number(row.n);
  }

  /**
   * Fixed-window counter. A sliding window would be nicer, but the thing being
   * protected is a gas float, not a market — a bounded overshoot at a window edge is
   * a rounding error, and the simpler code is easier to audit.
   */
  hitRateLimit(
    subject: string,
    kind: 'address' | 'ip' | 'metrics' | 'quote' | 'allowance',
    limit: number,
    now = Date.now(),
  ): boolean {
    const windowStart = Math.floor(now / 3_600_000) * 3_600_000;
    const key = subject.toLowerCase();
    const existing = this.#db
      .prepare(`SELECT count FROM rate_limits WHERE subject = ? AND kind = ? AND window_start = ?`)
      .get(key, kind, windowStart) as { count: number } | undefined;
    const next = (existing?.count ?? 0) + 1;
    this.#db
      .prepare(
        `INSERT INTO rate_limits (subject, kind, window_start, count) VALUES (?, ?, ?, ?)
         ON CONFLICT(subject, kind, window_start) DO UPDATE SET count = excluded.count`,
      )
      .run(key, kind, windowStart, next);
    // Prune once per hour boundary, globally. The previous trigger keyed off this
    // subject's own count, so a sweep of many addresses hitting once each — the exact
    // abuse case — never reached it, and ordinary traffic never did either because the
    // per-address limit is 60/hour. Measured: 5000 subjects x 1 hit produced 4800
    // stale rows and zero prunes. This is O(1), always runs, and still needs no timer.
    this.#maybePrune(now);
    return next > limit;
  }

  /**
   * What the sponsorship ledger holds for `address` at `now`.
   *
   * Summed in bigint rather than by SQL `SUM`: amounts are wei in TEXT, and SQLite would
   * sum them as floats past 2^63 (rule A2.6: monetary math is bigint).
   */
  prefundUsage(address: string, now = Date.now(), ledger: PrefundLedger = 'sponsored'): PrefundUsage {
    const key = address.toLowerCase();
    const current = windowStartOf(now);
    const dayStart = oldestWindowInDay(now);

    // Self-bundle rows are the relayer's own exposure, not sponsorship drawn by anyone,
    // and are bounded by `reserveSelfBundle` instead. Counting them here is what let an
    // account's two ordinary top-ups in one hour switch self-bundling off for it. Exempt
    // rows (a withdraw's, a send's, a cancel's — 2026-09-25) are the same idea: never
    // counted toward the sponsored or fee-paid ledgers, so a withdraw can never eat into
    // the same account's own free tier or MON budget.
    // The address's own sums are per ledger: the sponsorship budgets count every ordinary
    // top-up, the charged path's own hourly cap (D172) counts only the fee-paid ones
    // (`FEE_PAID_PURPOSE_PREFIX`), and the exempt ledger counts only `EXEMPT_PURPOSE` rows.
    // Bounded 2026-09-25 (security review finding 1): the exempt ledger's own shared-hour
    // sum, below, now counts exempt rows too, on its own pool — before this it was always
    // left out of every "everyone" sum, sponsored's and fee-paid's correctly, but also its
    // own, which is what let a stream of fresh addresses draw from it with nothing to stop
    // them. Sponsored and fee-paid still exclude exempt from their own shared hour.
    const ownQuery =
      ledger === 'exempt'
        ? `SELECT window_start, amount_wei FROM prefund_ledger
           WHERE address = ? AND window_start >= ? AND window_start <= ? AND status IN ${COUNTED}
             AND purpose = ?`
        : `SELECT window_start, amount_wei FROM prefund_ledger
           WHERE address = ? AND window_start >= ? AND window_start <= ? AND status IN ${COUNTED}
             AND purpose != ? AND purpose != ? AND (substr(purpose, 1, ?) = ?) = ?`;
    const ownParams =
      ledger === 'exempt'
        ? [key, dayStart, current, EXEMPT_PURPOSE]
        : [
            key,
            dayStart,
            current,
            SELF_BUNDLE_PURPOSE,
            EXEMPT_PURPOSE,
            FEE_PAID_PURPOSE_PREFIX.length,
            FEE_PAID_PURPOSE_PREFIX,
            ledger === 'fee-paid' ? 1 : 0,
          ];
    const own = this.#db.prepare(ownQuery).all(...ownParams) as ReadonlyArray<Record<string, unknown>>;
    const byWindow = new Map<number, bigint>();
    let addressDay = 0n;
    for (const row of own) {
      const amount = BigInt(String(row.amount_wei));
      const ws = Number(row.window_start);
      byWindow.set(ws, (byWindow.get(ws) ?? 0n) + amount);
      addressDay += amount;
    }

    const everyoneQuery =
      ledger === 'exempt'
        ? `SELECT amount_wei FROM prefund_ledger
           WHERE window_start = ? AND status IN ${COUNTED} AND purpose = ?`
        : `SELECT amount_wei FROM prefund_ledger
           WHERE window_start = ? AND status IN ${COUNTED} AND purpose != ? AND purpose != ?`;
    const everyoneParams =
      ledger === 'exempt' ? [current, EXEMPT_PURPOSE] : [current, SELF_BUNDLE_PURPOSE, EXEMPT_PURPOSE];
    const everyone = this.#db
      .prepare(everyoneQuery)
      .all(...everyoneParams) as ReadonlyArray<Record<string, unknown>>;
    let allAddressesHour = 0n;
    for (const row of everyone) allAddressesHour += BigInt(String(row.amount_wei));

    return {
      addressHour: byWindow.get(current) ?? 0n,
      addressDay,
      allAddressesHour,
      addressWindows: [...byWindow.entries()]
        .sort(([a], [b]) => a - b)
        .map(([windowStart, amount]) => ({ windowStart, amount })),
    };
  }

  /**
   * Reserve `amountWei` against the budgets, or refuse. Nothing moves before this.
   *
   * The budget check and the insert run in one `BEGIN IMMEDIATE` transaction. In this
   * process the relayer's top-up lock already serialises callers. The transaction is
   * what keeps the check atomic if a second process ever opens the same file, because
   * SQLite then takes the write lock before the read rather than after.
   */
  reservePrefund(entry: {
    address: string;
    amountWei: bigint;
    purpose: string;
    budgets: PrefundBudgets;
    now?: number;
  }): { ok: true; id: number; headroom: PrefundHeadroom } | { ok: false; headroom: PrefundHeadroom } {
    if (entry.purpose === SELF_BUNDLE_PURPOSE) {
      // A self-bundle row written here would be checked against the sponsorship budgets
      // and then left out of them by `prefundUsage`: budgeted by neither pool.
      throw new Error(
        'a self-bundle reserves through reserveSelfBundle, never a sponsorship budget',
      );
    }
    const now = entry.now ?? Date.now();
    const ledger: PrefundLedger =
      entry.purpose === EXEMPT_PURPOSE
        ? 'exempt'
        : entry.purpose.startsWith(FEE_PAID_PURPOSE_PREFIX)
          ? 'fee-paid'
          : 'sponsored';
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const headroom = prefundHeadroom(
        this.prefundUsage(entry.address, now, ledger),
        entry.budgets,
        now,
      );
      if (entry.amountWei <= 0n || entry.amountWei > headroom.remaining) {
        this.#db.exec('ROLLBACK');
        return { ok: false, headroom };
      }
      const result = this.#db
        .prepare(
          `INSERT INTO prefund_ledger (address, window_start, amount_wei, status, purpose, created_at)
           VALUES (?, ?, ?, 'reserved', ?, ?)`,
        )
        .run(
          entry.address.toLowerCase(),
          windowStartOf(now),
          entry.amountWei.toString(),
          entry.purpose,
          now,
        );
      this.#db.exec('COMMIT');
      return { ok: true, id: Number(result.lastInsertRowid), headroom };
    } catch (error) {
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        /* the transaction may already be gone; the original error is the one to raise */
      }
      throw error;
    }
  }

  /**
   * Move a reservation to its outcome. See `PREFUND_STATUSES` for which ones still count.
   *
   * `amountWei` records what was actually spent when that is less than was reserved: a
   * self-bundle reserves its worst case and is charged only its real loss. It can only
   * lower a row, never raise it, because the budget check approved the reserved amount
   * and nothing larger.
   *
   * `onlyFrom` makes the move conditional: a row whose status is not in it is left exactly
   * as it is, and the call answers false. A self-bundle's receipt can be read by the
   * browser's receipt lookup while the bundle's own wait is still running, so whichever
   * settles second must not overwrite the first (2026-09-24, answer on hash).
   */
  settlePrefund(
    id: number,
    status: Exclude<PrefundStatus, 'reserved'>,
    detail: {
      txHash?: string;
      txNonce?: number;
      now?: number;
      amountWei?: bigint;
      onlyFrom?: readonly PrefundStatus[];
    } = {},
  ): boolean {
    const row = this.#db
      .prepare(`SELECT amount_wei, status FROM prefund_ledger WHERE id = ?`)
      .get(id) as { amount_wei: string; status: string } | undefined;
    if (detail.onlyFrom && !(row && detail.onlyFrom.includes(row.status as PrefundStatus))) {
      return false;
    }
    if (detail.amountWei !== undefined) {
      if (!row) throw new Error(`no prefund reservation ${id}`);
      if (detail.amountWei < 0n || detail.amountWei > BigInt(row.amount_wei)) {
        throw new Error('a settled amount must be between zero and what was reserved');
      }
      this.#db
        .prepare(`UPDATE prefund_ledger SET amount_wei = ? WHERE id = ?`)
        .run(detail.amountWei.toString(), id);
    }
    const result = this.#db
      .prepare(
        `UPDATE prefund_ledger SET status = ?, tx_hash = ?, tx_nonce = COALESCE(?, tx_nonce), settled_at = ? WHERE id = ?`,
      )
      .run(status, detail.txHash?.toLowerCase() ?? null, detail.txNonce ?? null, detail.now ?? Date.now(), id);
    return Number(result.changes ?? 0) > 0;
  }

  /**
   * Reserve a self-bundle's worst case against self-bundling's own allowance, or refuse.
   *
   * Nothing here reads or touches the sponsorship budgets, and nothing in them reads this
   * row (`prefundUsage` leaves `SELF_BUNDLE_PURPOSE` out). The relayer is repaid a
   * successful bundle's gas from the sender's own EntryPoint deposit in the same
   * transaction, so what this bounds is the relayer's own exposure when that repayment
   * does not come, not anyone's sponsorship. Three bounds, all read and the row written in
   * one `BEGIN IMMEDIATE` transaction, the same shape as `reservePrefund`, after the
   * bundle's own size:
   *
   *   too-large    this bundle's worst case is above `maxWorstCaseWei`;
   *   loss-limit   the rolling window's self-bundle losses plus the worst case of every
   *                self-bundle not yet settled have reached `lossLimitWei`;
   *   in-flight    `maxInFlight` self-bundles are already reserved or sent and unsettled;
   *   float-floor  the relayer's balance, less every relayer transaction still unsettled
   *                (any purpose: an unconfirmed top-up may yet leave too) and less this
   *                bundle's worst case, would be at or below `floatFloorWei`.
   */
  reserveSelfBundle(entry: {
    address: string;
    amountWei: bigint;
    maxWorstCaseWei: bigint;
    lossLimitWei: bigint;
    maxInFlight: number;
    relayerBalanceWei: bigint;
    floatFloorWei: bigint;
    now: number;
    windowMs?: number;
  }):
    | { ok: true; id: number }
    | {
        ok: false;
        reason: SelfBundleRefusal;
        exposureWei: bigint;
        inFlight: number;
        unsettledWei: bigint;
      } {
    const windowMs = entry.windowMs ?? HOUR_MS;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const exposureWei = this.selfBundleExposure(entry.now, windowMs);
      const inFlight = this.selfBundlesInFlight(entry.now, windowMs);
      const unsettledWei = this.unsettledOutflowWei(entry.now, windowMs);
      const projected = entry.relayerBalanceWei - unsettledWei - entry.amountWei;
      const reason: SelfBundleRefusal | undefined =
        entry.amountWei <= 0n
          ? 'amount'
          : entry.amountWei > entry.maxWorstCaseWei
            ? 'too-large'
            : exposureWei >= entry.lossLimitWei
              ? 'loss-limit'
              : inFlight >= entry.maxInFlight
                ? 'in-flight'
                : projected <= entry.floatFloorWei
                  ? 'float-floor'
                  : undefined;
      if (reason) {
        this.#db.exec('ROLLBACK');
        return { ok: false, reason, exposureWei, inFlight, unsettledWei };
      }
      const result = this.#db
        .prepare(
          `INSERT INTO prefund_ledger (address, window_start, amount_wei, status, purpose, created_at)
           VALUES (?, ?, ?, 'reserved', ?, ?)`,
        )
        .run(
          entry.address.toLowerCase(),
          windowStartOf(entry.now),
          entry.amountWei.toString(),
          SELF_BUNDLE_PURPOSE,
          entry.now,
        );
      this.#db.exec('COMMIT');
      return { ok: true, id: Number(result.lastInsertRowid) };
    } catch (error) {
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        /* the transaction may already be gone; the original error is the one to raise */
      }
      throw error;
    }
  }

  /**
   * What self-bundling has cost or put at risk in the rolling window ending at `now`: every
   * self-bundle row still counted. A realised loss is a `paid` row at the amount lost. A
   * bundle sent and not yet seen, or interrupted part-way, is an `unconfirmed` or `reserved`
   * row at its worst case. A bundle that netted zero or better was `released` and is not
   * here. Persisted, so a restart does not hand the loss limit a fresh hour.
   */
  selfBundleExposure(now: number, windowMs: number = HOUR_MS): bigint {
    const since = now - windowMs;
    const rows = this.#db
      .prepare(
        `SELECT amount_wei FROM prefund_ledger
         WHERE purpose = ? AND status IN ${COUNTED}
           AND window_start >= ? AND created_at > ?`,
      )
      .all(SELF_BUNDLE_PURPOSE, windowStartOf(since), since) as unknown as ReadonlyArray<{
      amount_wei: string;
    }>;
    let total = 0n;
    for (const row of rows) total += BigInt(row.amount_wei);
    return total;
  }

  /**
   * Self-bundles reserved or sent and not yet settled, in the same rolling window the loss
   * limit reads. A row left `reserved` by a process that stopped part-way is counted: it
   * may have been sent.
   */
  selfBundlesInFlight(now: number, windowMs: number = HOUR_MS): number {
    const since = now - windowMs;
    const row = this.#db
      .prepare(
        `SELECT COUNT(*) AS n FROM prefund_ledger
         WHERE purpose = ? AND status IN ${UNSETTLED}
           AND window_start >= ? AND created_at > ?`,
      )
      .get(SELF_BUNDLE_PURPOSE, windowStartOf(since), since) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  /**
   * What may still leave the relayer's balance for transactions it has reserved or sent
   * and not settled, of any purpose, in the rolling window: a self-bundle at its worst case,
   * an unconfirmed top-up at its value. Not yet in any balance read, because not yet mined.
   */
  unsettledOutflowWei(now: number, windowMs: number = HOUR_MS): bigint {
    const since = now - windowMs;
    const rows = this.#db
      .prepare(
        `SELECT amount_wei FROM prefund_ledger
         WHERE status IN ${UNSETTLED} AND window_start >= ? AND created_at > ?`,
      )
      .all(windowStartOf(since), since) as unknown as ReadonlyArray<{ amount_wei: string }>;
    let total = 0n;
    for (const row of rows) total += BigInt(row.amount_wei);
    return total;
  }

  /** Self-bundles sent without a receipt, oldest first, for reconciliation. */
  unconfirmedSelfBundles(
    sinceMs: number,
    limit: number,
  ): ReadonlyArray<{
    id: number;
    address: string;
    txHash: string;
    amountWei: bigint;
    createdAt: number;
    txNonce: number | null;
  }> {
    const rows = this.#db
      .prepare(
        `SELECT id, address, tx_hash, amount_wei, created_at, tx_nonce FROM prefund_ledger
         WHERE purpose = ? AND status = 'unconfirmed' AND tx_hash IS NOT NULL
           AND created_at > ?
         ORDER BY id ASC LIMIT ?`,
      )
      .all(SELF_BUNDLE_PURPOSE, sinceMs, limit) as ReadonlyArray<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      address: String(r.address),
      txHash: String(r.tx_hash),
      amountWei: BigInt(String(r.amount_wei)),
      createdAt: Number(r.created_at),
      txNonce: r.tx_nonce === null || r.tx_nonce === undefined ? null : Number(r.tx_nonce),
    }));
  }

  /** One ledger row's current status and amount, or undefined. */
  prefundRow(id: number): { status: PrefundStatus; amountWei: bigint } | undefined {
    const row = this.#db.prepare(`SELECT status, amount_wei FROM prefund_ledger WHERE id = ?`).get(id) as
      | { status: string; amount_wei: string }
      | undefined;
    return row ? { status: row.status as PrefundStatus, amountWei: BigInt(row.amount_wei) } : undefined;
  }

  /** Every ledger row, newest first, for tests and operator inspection. */
  prefundLedger(address?: string): ReadonlyArray<{
    id: number;
    address: string;
    windowStart: number;
    amountWei: bigint;
    status: PrefundStatus;
    purpose: string;
    txHash: string | null;
    txNonce: number | null;
  }> {
    const rows = (
      address
        ? this.#db
            .prepare(`SELECT * FROM prefund_ledger WHERE address = ? ORDER BY id DESC`)
            .all(address.toLowerCase())
        : this.#db.prepare(`SELECT * FROM prefund_ledger ORDER BY id DESC`).all()
    ) as ReadonlyArray<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      address: String(r.address),
      windowStart: Number(r.window_start),
      amountWei: BigInt(String(r.amount_wei)),
      status: String(r.status) as PrefundStatus,
      purpose: String(r.purpose),
      txHash: r.tx_hash === null ? null : String(r.tx_hash),
      txNonce: r.tx_nonce === null || r.tx_nonce === undefined ? null : Number(r.tx_nonce),
    }));
  }

  /**
   * Drop ledger rows that can no longer count toward any budget.
   *
   * The rolling day reads the current window and the 23 before it, so anything older
   * than 24 windows back is inert. One extra window is kept so a window boundary during
   * a read is harmless, the same margin `pruneRateLimits` keeps.
   */
  prunePrefundLedger(now = Date.now()): number {
    const cutoff = windowStartOf(now) - 24 * HOUR_MS;
    const result = this.#db.prepare(`DELETE FROM prefund_ledger WHERE window_start < ?`).run(cutoff);
    return Number(result.changes ?? 0);
  }

  /**
   * One address's counted free actions per hourly window across the rolling day at `now`,
   * oldest first. `freeActionHeadroom` (core) says what they mean.
   */
  freeActionUsage(address: string, now = Date.now()): FreeActionUsage {
    const rows = this.#db
      .prepare(
        `SELECT window_start, COUNT(*) AS n FROM free_actions
         WHERE address = ? AND window_start >= ? AND window_start <= ? AND status IN ${ACTION_COUNTED}
         GROUP BY window_start ORDER BY window_start ASC`,
      )
      .all(address.toLowerCase(), oldestWindowInDay(now), windowStartOf(now)) as unknown as ReadonlyArray<{
      window_start: number;
      n: number;
    }>;
    return {
      windows: rows.map((r) => ({ windowStart: Number(r.window_start), count: Number(r.n) })),
    };
  }

  /**
   * Take one of `address`'s free actions, or refuse when it has none left.
   *
   * The count and the insert run in one `BEGIN IMMEDIATE` transaction, the same shape as
   * `reservePrefund`, so concurrent sends from one account can never both take the last one.
   */
  reserveFreeAction(entry: {
    address: string;
    purpose: string;
    limit: number;
    now: number;
  }): { ok: true; id: number } | { ok: false; usage: FreeActionUsage } {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const usage = this.freeActionUsage(entry.address, entry.now);
      const used = usage.windows.reduce((sum, w) => sum + w.count, 0);
      if (used >= entry.limit) {
        this.#db.exec('ROLLBACK');
        return { ok: false, usage };
      }
      const result = this.#db
        .prepare(
          `INSERT INTO free_actions (address, window_start, status, purpose, created_at)
           VALUES (?, ?, 'reserved', ?, ?)`,
        )
        .run(entry.address.toLowerCase(), windowStartOf(entry.now), entry.purpose, entry.now);
      this.#db.exec('COMMIT');
      return { ok: true, id: Number(result.lastInsertRowid) };
    } catch (error) {
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        /* the transaction may already be gone; the original error is the one to raise */
      }
      throw error;
    }
  }

  /** Move a reserved free action to its outcome. Only a row still `reserved` moves. */
  settleFreeAction(id: number, status: Exclude<FreeActionStatus, 'reserved'>, now = Date.now()): boolean {
    const result = this.#db
      .prepare(`UPDATE free_actions SET status = ?, settled_at = ? WHERE id = ? AND status = 'reserved'`)
      .run(status, now, id);
    return Number(result.changes ?? 0) > 0;
  }

  /** Every free-action row for `address`, newest first, for tests and operator inspection. */
  freeActionLedger(address: string): ReadonlyArray<{
    id: number;
    windowStart: number;
    status: FreeActionStatus;
    purpose: string;
    createdAt: number;
  }> {
    const rows = this.#db
      .prepare(`SELECT * FROM free_actions WHERE address = ? ORDER BY id DESC`)
      .all(address.toLowerCase()) as ReadonlyArray<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      windowStart: Number(r.window_start),
      status: String(r.status) as FreeActionStatus,
      purpose: String(r.purpose),
      createdAt: Number(r.created_at),
    }));
  }

  /** This address's outstanding fee-paid top-up, if it has one. */
  outstandingFeePaidTopUp(address: string, scope: 'fee-paid' | 'exempt' = 'fee-paid'):
    | {
        id: number;
        userOpHash: string;
        fromBlock: bigint;
        createdAt: number;
        scope: 'fee-paid' | 'exempt';
        nonce: bigint | undefined;
      }
    | undefined {
    const row = this.#db
      .prepare(
        `SELECT id, user_op_hash, from_block, created_at, scope, nonce FROM fee_paid_topups
         WHERE address = ? AND status = 'outstanding' AND scope = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(address.toLowerCase(), scope) as
      | { id: number; user_op_hash: string; from_block: string; created_at: number; scope: string; nonce: string | null }
      | undefined;
    return row
      ? {
          id: Number(row.id),
          userOpHash: row.user_op_hash,
          fromBlock: BigInt(row.from_block),
          createdAt: Number(row.created_at),
          scope: row.scope === 'exempt' ? 'exempt' : 'fee-paid',
          nonce: row.nonce === null ? undefined : BigInt(row.nonce),
        }
      : undefined;
  }

  /**
   * Open the marker for a fee-paid top-up about to be paid. Refuses (answers undefined) when
   * the address already has one outstanding: checked and written in one `BEGIN IMMEDIATE`
   * transaction, so no two top-ups can both find the address clear.
   */
  openFeePaidTopUp(entry: {
    address: string;
    userOpHash: string;
    fromBlock: bigint;
    now: number;
    /** 'fee-paid' unless said otherwise; an exempt marker carries its operation's nonce. */
    scope?: 'fee-paid' | 'exempt';
    nonce?: bigint;
  }): number | undefined {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      if (this.outstandingFeePaidTopUp(entry.address, entry.scope ?? 'fee-paid')) {
        this.#db.exec('ROLLBACK');
        return undefined;
      }
      const result = this.#db
        .prepare(
          `INSERT INTO fee_paid_topups (address, user_op_hash, from_block, status, created_at, scope, nonce)
           VALUES (?, ?, ?, 'outstanding', ?, ?, ?)`,
        )
        .run(
          entry.address.toLowerCase(),
          entry.userOpHash.toLowerCase(),
          entry.fromBlock.toString(),
          entry.now,
          entry.scope ?? 'fee-paid',
          entry.nonce === undefined ? null : entry.nonce.toString(),
        );
      this.#db.exec('COMMIT');
      return Number(result.lastInsertRowid);
    } catch (error) {
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        /* the transaction may already be gone; the original error is the one to raise */
      }
      throw error;
    }
  }

  /** Close a marker: its operation was seen to land, or the top-up never went out. */
  settleFeePaidTopUp(
    id: number,
    status: 'confirmed' | 'released',
    detail: { success?: boolean; now: number },
  ): void {
    this.#db
      .prepare(
        `UPDATE fee_paid_topups SET status = ?, success = ?, settled_at = ?
         WHERE id = ? AND status = 'outstanding'`,
      )
      .run(status, detail.success === undefined ? null : detail.success ? 1 : 0, detail.now, id);
  }

  /** Confirm whichever outstanding marker names this operation, when its event is seen. */
  confirmFeePaidTopUpByHash(userOpHash: string, success: boolean, now: number): boolean {
    const result = this.#db
      .prepare(
        `UPDATE fee_paid_topups SET status = 'confirmed', success = ?, settled_at = ?
         WHERE user_op_hash = ? AND status = 'outstanding'`,
      )
      .run(success ? 1 : 0, now, userOpHash.toLowerCase());
    return Number(result.changes ?? 0) > 0;
  }

  /** Every marker for `address`, newest first, for tests and operator inspection. */
  feePaidTopUps(address: string): ReadonlyArray<{
    id: number;
    userOpHash: string;
    status: string;
    success: boolean | null;
  }> {
    const rows = this.#db
      .prepare(`SELECT * FROM fee_paid_topups WHERE address = ? ORDER BY id DESC`)
      .all(address.toLowerCase()) as ReadonlyArray<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      userOpHash: String(r.user_op_hash),
      status: String(r.status),
      success: r.success === null ? null : Number(r.success) === 1,
    }));
  }

  /**
   * This address's most recent fee-paid top-up whose operation was seen to land, if any.
   * None means its next fee-paid top-up is its first, sized to the operation's own need.
   */
  lastLandedFeePaidTopUp(
    address: string,
    scope: 'fee-paid' | 'exempt' = 'fee-paid',
  ): { id: number; fromBlock: bigint } | undefined {
    const row = this.#db
      .prepare(
        `SELECT id, from_block FROM fee_paid_topups
         WHERE address = ? AND status = 'confirmed' AND scope = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(address.toLowerCase(), scope) as { id: number; from_block: string } | undefined;
    return row ? { id: Number(row.id), fromBlock: BigInt(row.from_block) } : undefined;
  }

  /** Did this relayer send the bundle transaction `txHash` itself? */
  isOwnBundleTx(txHash: string): boolean {
    const row = this.#db
      .prepare(`SELECT 1 AS own FROM prefund_ledger WHERE purpose = ? AND lower(tx_hash) = ? LIMIT 1`)
      .get(SELF_BUNDLE_PURPOSE, txHash.toLowerCase());
    return row !== undefined;
  }

  /**
   * Record the gas an operation burned, from its `UserOperationEvent` (D172, scenario H).
   * Idempotent by operation hash: the same operation seen by two readers is one burn.
   *
   * Whether it may later be replaced by a paid top-up ('counted') depends on who was paid
   * for it. `actualGasCost` goes to the bundle's beneficiary:
   *
   *   - our own bundle: the relayer itself was paid, so replacing it costs the relayer
   *     nothing. Counted, whether the batch succeeded or reverted: a reverted batch still
   *     burned real gas, and it was paid to us.
   *   - anyone else's bundle: the beneficiary is not known from the event, and it may be the
   *     account's owner, who can bundle their own operation. Counted only for a fee-paid
   *     operation that succeeded, because then its fee leg ran and paid at least 1.2x its
   *     most expensive run. A reverted one paid no fee: replacing its gas would refund the
   *     owner's own bundling, every cycle.
   *
   * A later reader that proves the bundle was ours upgrades a row to counted; nothing ever
   * downgrades one.
   */
  recordGasBurn(entry: {
    userOpHash: string;
    address: string;
    block: bigint | undefined;
    actualGasCost: bigint;
    success: boolean;
    ownBundle: boolean;
    now: number;
  }): void {
    const hash = entry.userOpHash.toLowerCase();
    const feePaid =
      this.#db
        .prepare(
          `SELECT 1 AS fp FROM fee_paid_topups
           WHERE user_op_hash = ? AND status != 'released' AND scope = 'fee-paid' LIMIT 1`,
        )
        .get(hash) !== undefined;
    const counted = entry.ownBundle || (entry.success && feePaid);
    this.#db
      .prepare(
        `INSERT INTO gas_burns (user_op_hash, address, block, actual_gas_cost, success, counted, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_op_hash) DO UPDATE SET
           counted = MAX(gas_burns.counted, excluded.counted),
           block = COALESCE(gas_burns.block, excluded.block)`,
      )
      .run(
        hash,
        entry.address.toLowerCase(),
        entry.block === undefined ? null : Number(entry.block),
        entry.actualGasCost.toString(),
        entry.success ? 1 : 0,
        counted ? 1 : 0,
        entry.now,
      );
  }

  /**
   * The counted gas burned by this address's operations in blocks after `afterBlock`: what a
   * paid top-up may replace. Summed in bigint (rule A2.6). A burn with no block is left out.
   */
  gasBurnedSince(address: string, afterBlock: bigint, scope: 'fee-paid' | 'exempt' = 'fee-paid'): bigint {
    // Each burn feeds one lane only (security review of D191, finding 3): a burn whose
    // operation an exempt marker named is the exempt lane's, and every other counted burn
    // is the fee-paid lane's, as before. `counted` is set only for this relayer's own
    // bundles or a fee-paid operation, so an exempt operation someone else bundled (whose
    // gas may have gone back to its own owner) refills nothing.
    const exemptNamed = `EXISTS (SELECT 1 FROM fee_paid_topups t
                 WHERE t.user_op_hash = g.user_op_hash AND t.scope = 'exempt' AND t.status != 'released')`;
    const rows = this.#db
      .prepare(
        `SELECT g.actual_gas_cost FROM gas_burns g
         WHERE g.address = ? AND g.counted = 1 AND g.block IS NOT NULL AND g.block > ?
           AND ${scope === 'exempt' ? '' : 'NOT '}${exemptNamed}`,
      )
      .all(address.toLowerCase(), Number(afterBlock)) as ReadonlyArray<Record<string, unknown>>;
    let total = 0n;
    for (const row of rows) total += BigInt(String(row.actual_gas_cost));
    return total;
  }

  /** Every burn recorded for `address`, newest first, for tests and operator inspection. */
  gasBurns(address: string): ReadonlyArray<{
    userOpHash: string;
    block: bigint | null;
    actualGasCost: bigint;
    success: boolean;
    counted: boolean;
  }> {
    const rows = this.#db
      .prepare(`SELECT * FROM gas_burns WHERE address = ? ORDER BY id DESC`)
      .all(address.toLowerCase()) as ReadonlyArray<Record<string, unknown>>;
    return rows.map((r) => ({
      userOpHash: String(r.user_op_hash),
      block: r.block === null ? null : BigInt(Number(r.block)),
      actualGasCost: BigInt(String(r.actual_gas_cost)),
      success: Number(r.success) === 1,
      counted: Number(r.counted) === 1,
    }));
  }

  /** Free-action rows that can no longer count, with the same one-window margin as the ledger. */
  pruneFreeActions(now = Date.now()): number {
    const cutoff = windowStartOf(now) - 24 * HOUR_MS;
    const result = this.#db.prepare(`DELETE FROM free_actions WHERE window_start < ?`).run(cutoff);
    return Number(result.changes ?? 0);
  }

  /**
   * Record a completed top-up in the running totals. Called after the deposit
   * transaction is mined, alongside `settlePrefund(id, 'paid')`.
   *
   * Statistics only: the budgets are enforced against `prefund_ledger`, not here.
   * `purpose` is the reason this address needed funding — 'deposit', 'deposit+convert'
   * or 'flow-convert', inferred server-side from the batch's own shape (never trusted
   * from the client). The column holds the most recent purpose, not a history.
   */
  recordTopUp(address: string, amountWei: bigint, purpose: string, now = Date.now()): bigint {
    const key = address.toLowerCase();
    const existing = this.#db
      .prepare(`SELECT total_wei FROM topups WHERE address = ?`)
      .get(key) as { total_wei: string } | undefined;
    const total = (existing ? BigInt(existing.total_wei) : 0n) + amountWei;
    this.#db
      .prepare(
        `INSERT INTO topups (address, total_wei, count, last_at, purpose) VALUES (?, ?, 1, ?, ?)
         ON CONFLICT(address) DO UPDATE SET
           total_wei = excluded.total_wei,
           count = topups.count + 1,
           last_at = excluded.last_at,
           purpose = excluded.purpose`,
      )
      .run(key, total.toString(), now, purpose);
    return total;
  }

  /** Read one address's top-up row, for tests and operator inspection. */
  topUpFor(address: string): { totalWei: bigint; count: number; purpose: string } | undefined {
    const row = this.#db
      .prepare(`SELECT total_wei, count, purpose FROM topups WHERE address = ?`)
      .get(address.toLowerCase()) as
      { total_wei: string; count: number; purpose: string } | undefined;
    return row
      ? { totalWei: BigInt(row.total_wei), count: row.count, purpose: row.purpose }
      : undefined;
  }

  /** Prune once per hour rollover, from any write path that runs regularly. */
  #maybePrune(now: number): void {
    const windowStart = Math.floor(now / 3_600_000) * 3_600_000;
    if (windowStart === this.#lastPrunedWindow) return;
    this.#lastPrunedWindow = windowStart;
    this.pruneRateLimits(now);
    this.pruneFloatSnapshots(now);
    this.prunePrefundLedger(now);
    this.pruneFreeActions(now);
  }

  recordFloat(balanceWei: bigint, now = Date.now()): void {
    this.#maybePrune(now);
    this.#db
      .prepare(`INSERT OR REPLACE INTO float_snapshots (ts, balance_wei) VALUES (?, ?)`)
      .run(now, balanceWei.toString());
  }

  /**
   * Counters for the metrics endpoint.
   *
   * Read straight out of the tables rather than kept in memory, so a restart does
   * not silently reset the numbers an operator is watching. Everything here is a
   * count or a total the relayer already stores; nothing is estimated.
   */
  metrics(now = Date.now()): {
    relaysByStatus: ReadonlyArray<{ status: string; count: number }>;
    relaysByPurpose: ReadonlyArray<{ purpose: string; count: number }>;
    monSpentTotalWei: bigint;
    topupTotalWei: bigint;
    topupAddresses: number;
    rateLimitedSubjects: number;
    lastFloatWei: bigint | null;
    lastFloatAgeMs: number | null;
  } {
    const rows = (sql: string) =>
      this.#db.prepare(sql).all() as ReadonlyArray<Record<string, unknown>>;

    const relaysByStatus = rows(`SELECT status, COUNT(*) AS count FROM relays GROUP BY status`).map(
      (r) => ({ status: String(r.status), count: Number(r.count) }),
    );

    const relaysByPurpose = rows(
      `SELECT purpose, COUNT(*) AS count FROM relays GROUP BY purpose`,
    ).map((r) => ({ purpose: String(r.purpose), count: Number(r.count) }));

    // Read the running total rather than summing every relay row. The scan version
    // was linear in table size on an endpoint anyone can call.
    const monSpentTotalWei = this.counter('mon_spent_wei');

    let topupTotalWei = 0n;
    const topupRows = rows(`SELECT total_wei FROM topups`);
    for (const r of topupRows) {
      try {
        topupTotalWei += BigInt(String(r.total_wei));
      } catch {
        /* as above */
      }
    }

    // Same unit hitRateLimit writes: epoch MILLISECONDS truncated to the hour. The
    // `* 3_600_000` was missing here, so this gauge could never match a row and read
    // 0 no matter how much the limiter was tripping.
    const windowStart = Math.floor(now / 3_600_000) * 3_600_000;
    const limited = this.#db
      .prepare(`SELECT COUNT(*) AS n FROM rate_limits WHERE window_start = ? AND kind IN ('address', 'ip')`)
      .get(windowStart) as { n: number } | undefined;

    const float = this.#db
      .prepare(`SELECT ts, balance_wei FROM float_snapshots ORDER BY ts DESC LIMIT 1`)
      .get() as { ts: number; balance_wei: string } | undefined;

    return {
      relaysByStatus,
      relaysByPurpose,
      monSpentTotalWei,
      topupTotalWei,
      topupAddresses: topupRows.length,
      rateLimitedSubjects: limited?.n ?? 0,
      lastFloatWei: float ? BigInt(float.balance_wei) : null,
      lastFloatAgeMs: float ? now - float.ts : null,
    };
  }

  /**
   * Drop rate-limit rows older than `keepWindows` hourly windows.
   *
   * Nothing else ever deleted from this table, so it grew a row per subject per hour
   * forever and every window query got slower. Two windows is enough: the limiter
   * only ever reads the current one, and keeping the previous one makes a window
   * boundary harmless.
   */
  pruneRateLimits(now = Date.now(), keepWindows = 2): number {
    const cutoff = (Math.floor(now / 3_600_000) - keepWindows) * 3_600_000;
    const result = this.#db.prepare(`DELETE FROM rate_limits WHERE window_start < ?`).run(cutoff);
    return Number(result.changes ?? 0);
  }

  /**
   * Keep a bounded history of float readings.
   *
   * `recordFloat` now runs on every metrics scrape, so this table gained a row per
   * scrape forever. A day is plenty to see a trend; the alert reads the latest row.
   */
  pruneFloatSnapshots(now = Date.now(), keepMs = 86_400_000): number {
    const result = this.#db.prepare(`DELETE FROM float_snapshots WHERE ts < ?`).run(now - keepMs);
    return Number(result.changes ?? 0);
  }

  close(): void {
    this.#db.close();
  }
}

function toRelayRow(row: Record<string, unknown>): RelayRow {
  return {
    id: Number(row.id),
    from: String(row.from_address),
    to: String(row.to_address),
    selector: String(row.selector),
    purpose: String(row.purpose),
    txHash: row.tx_hash === null ? null : String(row.tx_hash),
    status: String(row.status) as RelayRow['status'],
    gasUsed: row.gas_used === null ? null : String(row.gas_used),
    monSpent: row.mon_spent === null ? null : String(row.mon_spent),
    error: row.error === null ? null : String(row.error),
    createdAt: Number(row.created_at),
    minedAt: row.mined_at === null ? null : Number(row.mined_at),
  };
}
