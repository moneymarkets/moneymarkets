import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RecoveryAttempt } from '@tradepro/core';

/**
 * Persistence for the deposit watcher (this file's siblings).
 *
 * Same shape as `apps/relayer/src/db.ts` deliberately — `node:sqlite`, WAL mode, no
 * native postinstall step — but this is the **trade app's own** database, not the
 * relayer's. Rule A2.3 says the relayer submits signed requests and nothing else;
 * watching a Solana/Base/Tron address for an incoming deposit is not that, so it does
 * not live there.
 *
 * `deposit_events` is the append-only log the report in D105 asks for: every state
 * transition, timestamped, with the raw payload that produced it. Nothing here is
 * inferred — a row exists only for what the chain or 1Click actually said.
 * `deposit_attempts` is the one-row-per-address summary the UI and the warning
 * threshold read from, kept in sync by the watcher as events land.
 */

export type DepositEventType =
  | 'REGISTERED'
  | 'SOURCE_LANDED'
  | 'ONECLICK_STATUS'
  /** Any rail's status response, stored raw. Used by every rail but 1Click. */
  | 'RAIL_STATUS'
  /** This app's own chain-confirmed proof of arrival on Monad — step 4's evidence. */
  | 'DESTINATION_DETECTED'
  /** This app's own chain-confirmed proof that the money went back to the depositor. */
  | 'REFUND_DETECTED'
  /** Money came back to the depositor that was only the extra beyond the quote; ends nothing. */
  | 'SURPLUS_RETURNED'
  /** A row that went three times its quoted eta with no change, forced through a full re-check. */
  | 'SLOW_RECHECK'
  /** Found stuck (`@tradepro/core` `isStuck`), and each recovery call made for it. */
  | 'STUCK'
  | 'RECOVERY_ATTEMPT'
  | 'WATCHER_ERROR';

export interface DepositEventRow {
  readonly id: number;
  readonly depositAddress: string;
  readonly type: DepositEventType;
  readonly status: string | null;
  readonly payloadJson: string;
  readonly at: number;
}

export interface DepositAttemptRow {
  readonly depositAddress: string;
  readonly recipient: string;
  readonly sourceKey: string;
  readonly chain: string;
  readonly route: string;
  readonly refundTo: string;
  readonly amountIn: string;
  readonly amountInUsd: string | null;
  readonly refundBalanceBefore: string | null;
  readonly originDecimals: number;
  readonly originSymbol: string;
  readonly expiresAt: number;
  readonly createdAt: number;
  readonly sourceLandedAt: number | null;
  readonly detectedAt: number | null;
  readonly terminalAt: number | null;
  readonly lastStatus: string;
  readonly terminalStatus: string | null;
  readonly refundReason: string | null;
  readonly refundAmount: string | null;
  /** Which rail issued this address, and the key it answers on. */
  readonly rail: string | null;
  readonly railRef: string | null;
  /** Source chain id where the rail is followed up per-chain (CCTP). Null otherwise. */
  readonly sourceChainId: number | null;
  readonly refundTxHash: string | null;
  readonly refundExplorerUrl: string | null;
  readonly amountOut: string | null;
  /**
   * The Monad transaction that credited `recipient`, confirmed by this app's own chain
   * read — set by `applyDestinationEvidence`, independent of the vendor's own status
   * (D-tracker-rebuild: "chain beats vendor"). No longer only set on vendor `SUCCESS`.
   */
  readonly destinationTxHash: string | null;
  readonly destinationTxBlock: string | null;
  /** 'eth_getTransactionReceipt' | 'balance-poll' | 'incoming-api'. */
  readonly destinationEvidenceSource: string | null;
  readonly destinationDetectedAt: number | null;
  /** Whichever of our own watch or the vendor's own report arrived first. */
  readonly sourceTxHash: string | null;
  readonly sourceEvidenceSource: string | null;
  readonly sourceTxAt: number | null;
  /** The vendor's own last status payload, verbatim, for the step-3 tooltip. */
  readonly vendorRawJson: string | null;
  readonly vendorRawAt: number | null;
  /** The vendor's quoted delivery time at issuance, in seconds. Drives the slow-state message. */
  readonly etaSeconds: number | null;
  /** What this deposit delivers on Monad — 'USDC' | 'AUSD' | 'USDT0' | 'MON'. */
  readonly outToken: string | null;
  /** MarginAccount balance for `outToken`, captured once destination evidence lands — the "before" for step 5's margin-read evidence. */
  readonly marginBalanceBefore: string | null;
  readonly marginBalanceBeforeBlock: string | null;
  /**
   * Where the rail delivers — 'wallet' | 'margin'. 'margin' only where the vendor
   * itself makes the MarginAccount call, which is why its destination proof has to be
   * a MarginAccount `Deposit` event rather than a wallet `Transfer` — the money never
   * touches the recipient's own address.
   */
  readonly landsIn: string | null;
  /** What this deposit was quoted to deliver, in `out_token` base units — the amount-tolerance check's own reference. */
  readonly quotedAmountOut: string | null;
  /**
   * A transfer back to `refundTo`, seen by this app's own read of the source chain
   * (`refund.ts`), independent of the vendor. First evidence wins.
   */
  readonly refundEvidenceHash: string | null;
  /** 'our-watcher-solana' | 'our-watcher-evm' | 'our-watcher-tron'. */
  readonly refundEvidenceSource: string | null;
  /** Origin-token base units that actually arrived back at `refundTo`. */
  readonly refundEvidenceAmount: string | null;
  /** The account the refund came from: the deposit address, or the vendor account it was swept to. */
  readonly refundEvidenceFrom: string | null;
  readonly refundEvidenceAt: number | null;
  /** When anything about this row last changed. The slow-state threshold is measured from here. */
  readonly lastChangeAt: number | null;
  /** When the watcher last forced a full re-check because this row had gone slow. */
  readonly slowRecheckAt: number | null;
  /** The next Monad block the arrival scan reads for this row (`arrival.ts`). */
  readonly destScanFrom: string | null;
  /** When the watcher first found this row stuck (`@tradepro/core` `isStuck`). */
  readonly stuckAt: number | null;
  /** Every recovery call made for this row, with the vendor's answer verbatim (JSON array). */
  readonly recoveryJson: string | null;
}

export class DepositDb {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS deposit_attempts (
        deposit_address    TEXT PRIMARY KEY,
        recipient          TEXT NOT NULL,
        source_key         TEXT NOT NULL,
        chain              TEXT NOT NULL,
        route              TEXT NOT NULL,
        refund_to          TEXT NOT NULL,
        amount_in          TEXT NOT NULL,
        amount_in_usd      TEXT,
        refund_balance_before TEXT,
        origin_decimals    INTEGER NOT NULL,
        origin_symbol      TEXT NOT NULL,
        expires_at         INTEGER NOT NULL,
        created_at         INTEGER NOT NULL,
        source_landed_at   INTEGER,
        detected_at        INTEGER,
        terminal_at        INTEGER,
        last_status        TEXT NOT NULL,
        terminal_status    TEXT,
        refund_reason      TEXT,
        refund_amount      TEXT,
        refund_tx_hash     TEXT,
        refund_explorer_url TEXT,
        amount_out         TEXT
      );
      CREATE INDEX IF NOT EXISTS deposit_attempts_recipient
        ON deposit_attempts(recipient, created_at);
      CREATE INDEX IF NOT EXISTS deposit_attempts_active
        ON deposit_attempts(terminal_status);

      CREATE TABLE IF NOT EXISTS deposit_events (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        deposit_address TEXT NOT NULL,
        type            TEXT NOT NULL,
        status          TEXT,
        payload_json    TEXT NOT NULL,
        at              INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS deposit_events_address
        ON deposit_events(deposit_address, at);
    `);
    this.#migrate();
  }

  /**
   * `deposit_attempts` predates `destination_tx_hash` (stabilization pass, item 5b):
   * a delivered row had no Monad-side transaction hash at all, only the refund
   * hash a refunded row carries. sqlite has no `ADD COLUMN IF NOT EXISTS`, so this
   * tries the migration and swallows exactly the "already there" failure — running
   * it twice, on a fresh table or an old one, all land in the same schema.
   */
  #migrate(): void {
    /**
     * Every column this table has gained since it was first written.
     *
     * `deposit_attempts` was shaped for one vendor. `rail` and `rail_ref` are what make
     * it hold several: `rail` says whose status endpoint to poll, `rail_ref` is the key
     * that vendor answers on — Relay's `requestId`, 1Click's deposit address. A row
     * without both cannot be followed up, which is why the watcher skips any row whose
     * rail it does not recognise rather than guessing.
     *
     * Existing rows predate the columns and get `near` by backfill below: every row
     * that existed before 2026-09-11 was a 1Click deposit, so that is a statement of
     * fact rather than a default.
     *
     * sqlite has no `ADD COLUMN IF NOT EXISTS`, so each is tried and the "already
     * there" failure swallowed — running this on a fresh table or an old one lands in
     * the same schema either way.
     */
    const columns = [
      'destination_tx_hash TEXT',
      'rail TEXT',
      'rail_ref TEXT',
      // A wallet-signed burn is followed up at Circle by (sourceDomain, txHash), and the
      // domain comes from the chain id. A deposit-address row does not need it.
      'source_chain_id INTEGER',
      // Tracker rebuild (D-tracker-rebuild): one evidence source per step, so each step
      // gets its own columns rather than borrowing the vendor's.
      'destination_tx_block TEXT',
      'destination_evidence_source TEXT',
      'destination_detected_at INTEGER',
      'source_tx_hash TEXT',
      'source_evidence_source TEXT',
      'source_tx_at INTEGER',
      'vendor_raw_json TEXT',
      'vendor_raw_at INTEGER',
      'eta_seconds INTEGER',
      'out_token TEXT',
      'margin_balance_before TEXT',
      'margin_balance_before_block TEXT',
      'lands_in TEXT',
      // Security review finding H1: destination detection must be checked against
      // what this specific deposit was quoted to deliver, or any incoming transfer of
      // the same token to the same recipient — someone else's payment, a margin
      // withdrawal, a swap fill, even a spoofed zero-value transfer() — can be
      // mistaken for this deposit's own arrival. `quoted_amount_out` is the number
      // that check is against; unset for a row with no quote on record (a pre-rebuild
      // row, or CCTP, which never runs the scan) rather than guessed.
      'quoted_amount_out TEXT',
      // Source-chain refund evidence (2026-09-29): a deposit whose money was already
      // back at the depositor's own address sat on "Bridging to Monad", because
      // nothing watched the source chain after the deposit landed.
      'refund_evidence_hash TEXT',
      'refund_evidence_source TEXT',
      'refund_evidence_amount TEXT',
      'refund_evidence_from TEXT',
      'refund_evidence_at INTEGER',
      'last_change_at INTEGER',
      'slow_recheck_at INTEGER',
      // The Monad arrival scan's cursor (2026-09-30): the next block to read for this
      // row's delivery, from the block the deposit was issued at, forward. The old scan
      // read only the latest few hundred blocks behind the head, so an arrival nobody
      // looked at within about 160 seconds was never found.
      'dest_scan_from TEXT',
      // Stuck deposits (2026-09-30): when the row was first found stuck, and every
      // recovery call made for it with the vendor's answer verbatim (a JSON array).
      'stuck_at INTEGER',
      'recovery_json TEXT',
    ];
    for (const column of columns) {
      try {
        this.#db.exec(`ALTER TABLE deposit_attempts ADD COLUMN ${column}`);
      } catch (error) {
        if (!(error instanceof Error) || !/duplicate column/i.test(error.message)) throw error;
      }
    }
    // Rows written before rails existed were all 1Click. Stated once, not defaulted
    // on every read.
    this.#db.exec(`UPDATE deposit_attempts SET rail = 'near' WHERE rail IS NULL`);
    // And 1Click keys its status on the address it issued, so for those rows the ref
    // *is* the address. Backfilling it means every row can be followed up through the
    // same rail-agnostic path, rather than one rail having a special case forever.
    this.#db.exec(
      `UPDATE deposit_attempts SET rail_ref = deposit_address WHERE rail_ref IS NULL`,
    );

    /**
     * Repair rows abandoned by the terminality bug.
     *
     * `checkRelay` computed `terminal = mapped !== 'PROCESSING'`, so the first poll of a
     * freshly issued Relay address — which Relay answers `unknown`, meaning "nothing has
     * arrived" — wrote `terminal_status = 'PENDING_DEPOSIT'`. `active()` selects
     * `WHERE terminal_status IS NULL`, so those addresses stopped being polled about
     * three seconds after they were handed to a user.
     *
     * Six rows in production carried it. Clearing the column puts them back in the
     * watcher's hands; `terminal_at` goes with it, because a row that has not finished
     * has no time at which it finished.
     *
     * Only ever touches the impossible state. A genuinely terminal row is SUCCESS,
     * REFUNDED or FAILED and is left exactly as it is.
     */
    this.#db.exec(
      `UPDATE deposit_attempts
          SET terminal_status = NULL, terminal_at = NULL
        WHERE terminal_status = 'PENDING_DEPOSIT'`,
    );
  }

  register(attempt: {
    depositAddress: string;
    recipient: string;
    sourceKey: string;
    chain: string;
    route: string;
    refundTo: string;
    amountIn: string;
    amountInUsd?: string;
    originDecimals: number;
    originSymbol: string;
    expiresAt: number;
    /** Which rail issued this address. Decides whose status endpoint the watcher polls. */
    rail?: string;
    /** The key that rail answers on: Relay's requestId, 1Click's deposit address. */
    railRef?: string;
    /** Source chain id, for rails followed up per-chain (CCTP's Iris domain). */
    sourceChainId?: number;
    /** The vendor's quoted delivery time, seconds. Drives the tracker's slow-state message. */
    etaSeconds?: number;
    /** What this deposit delivers on Monad — 'USDC' | 'AUSD' | 'USDT0' | 'MON'. */
    outToken?: string;
    /** Where the rail delivers — 'wallet' | 'margin'. Decides how step 4's destination proof is found. */
    landsIn?: string;
    /** What this deposit was quoted to deliver, in `out_token` base units. */
    quotedAmountOut?: string;
    now?: number;
  }): void {
    const now = attempt.now ?? Date.now();
    this.#db
      .prepare(
        `INSERT INTO deposit_attempts
           (deposit_address, recipient, source_key, chain, route, refund_to, amount_in,
            amount_in_usd, origin_decimals, origin_symbol, expires_at, created_at, last_status,
            rail, rail_ref, source_chain_id, eta_seconds, out_token, lands_in, quoted_amount_out)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_DEPOSIT', ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(deposit_address) DO NOTHING`,
      )
      .run(
        attempt.depositAddress,
        attempt.recipient.toLowerCase(),
        attempt.sourceKey,
        attempt.chain,
        attempt.route,
        attempt.refundTo,
        attempt.amountIn,
        attempt.amountInUsd ?? null,
        attempt.originDecimals,
        attempt.originSymbol,
        attempt.expiresAt,
        now,
        attempt.rail ?? 'near',
        attempt.railRef ?? attempt.depositAddress,
        attempt.sourceChainId ?? null,
        attempt.etaSeconds ?? null,
        attempt.outToken ?? null,
        attempt.landsIn ?? null,
        attempt.quotedAmountOut ?? null,
      );
    this.recordEvent(attempt.depositAddress, 'REGISTERED', null, { ...attempt }, now);
  }

  recordEvent(
    depositAddress: string,
    type: DepositEventType,
    status: string | null,
    payload: unknown,
    at = Date.now(),
  ): void {
    this.#db
      .prepare(
        `INSERT INTO deposit_events (deposit_address, type, status, payload_json, at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(depositAddress, type, status, JSON.stringify(payload), at);
  }

  /** Best-effort, set once shortly after registration if the source-chain read succeeds. */
  setRefundBalanceBefore(depositAddress: string, balance: string): void {
    this.#db
      .prepare(`UPDATE deposit_attempts SET refund_balance_before = ? WHERE deposit_address = ?`)
      .run(balance, depositAddress);
  }

  /** First arrival seen on the source chain directly — independent of 1Click's own detection. */
  markSourceLanded(depositAddress: string, at = Date.now()): void {
    this.#db
      .prepare(
        `UPDATE deposit_attempts SET source_landed_at = COALESCE(source_landed_at, ?)
         WHERE deposit_address = ?`,
      )
      .run(at, depositAddress);
  }

  /**
   * Apply a vendor status update. Named for 1Click because it was the only rail when
   * it was written; `applyRailStatus` is the same method under a name that is true of
   * every rail, and the old name is kept so nothing that calls it has to change.
   */
  applyRailStatus(
    depositAddress: string,
    update: Parameters<DepositDb['applyOneClickStatus']>[1],
    at = Date.now(),
  ): void {
    this.applyOneClickStatus(depositAddress, update, at);
  }

  applyOneClickStatus(
    depositAddress: string,
    update: {
      status: string;
      terminal: boolean;
      refundReason?: string | null;
      refundAmount?: string | null;
      refundTxHash?: string | null;
      refundExplorerUrl?: string | null;
      amountOut?: string | null;
      destinationTxHash?: string | null;
    },
    at = Date.now(),
  ): void {
    const existing = this.attempt(depositAddress);

    /**
     * A terminal state never regresses.
     *
     * Once a row has an outcome (delivered, returned, failed), a later vendor word can
     * add what the outcome was missing (its reason, its refund hash, its amount) but
     * can never change the outcome or put the row back in flight. The one refinement
     * allowed is FAILED to REFUNDED: money seen coming back is more than "failed", and
     * the user needs that fact.
     */
    if (existing?.terminalStatus && !(existing.terminalStatus === 'FAILED' && update.status === 'REFUNDED')) {
      if (existing.terminalStatus === 'REFUNDED' && update.status === 'REFUNDED') {
        this.#db
          .prepare(
            `UPDATE deposit_attempts SET
               refund_reason = COALESCE(refund_reason, ?),
               refund_amount = CASE WHEN refund_amount IS NULL OR refund_amount = '0' THEN ? ELSE refund_amount END,
               refund_tx_hash = COALESCE(NULLIF(refund_tx_hash, ''), ?),
               refund_explorer_url = COALESCE(NULLIF(refund_explorer_url, ''), ?)
             WHERE deposit_address = ?`,
          )
          .run(
            update.refundReason ?? null,
            update.refundAmount ?? null,
            update.refundTxHash ?? null,
            update.refundExplorerUrl ? update.refundExplorerUrl : null,
            depositAddress,
          );
      }
      return;
    }

    const changed = existing?.lastStatus !== update.status || update.terminal;
    const detectedAt = existing?.detectedAt ?? (update.status !== 'PENDING_DEPOSIT' ? at : null);
    const terminalAt = update.terminal
      ? (existing?.terminalAt ?? at)
      : (existing?.terminalAt ?? null);
    this.#db
      .prepare(
        `UPDATE deposit_attempts SET
           last_status = ?,
           detected_at = ?,
           terminal_at = ?,
           terminal_status = ?,
           refund_reason = ?,
           refund_amount = ?,
           refund_tx_hash = ?,
           refund_explorer_url = ?,
           -- First evidence wins (whichever arrives first: the vendor's own report, or
           -- this app's independent chain read via applyDestinationEvidence). A later
           -- write here must not clobber a fact this app already confirmed itself.
           amount_out = COALESCE(amount_out, ?),
           destination_tx_hash = COALESCE(destination_tx_hash, ?),
           last_change_at = CASE WHEN ? THEN ? ELSE last_change_at END
         WHERE deposit_address = ?`,
      )
      .run(
        update.status,
        detectedAt,
        terminalAt,
        update.terminal ? update.status : null,
        update.refundReason ?? null,
        update.refundAmount ?? null,
        update.refundTxHash ?? null,
        update.refundExplorerUrl ?? null,
        update.amountOut ?? null,
        update.destinationTxHash ?? null,
        changed ? 1 : 0,
        at,
        depositAddress,
      );
  }

  /**
   * A refund seen on the source chain: money that arrived back at `refundTo` from the
   * deposit address, or from the vendor account the deposit was swept into.
   *
   * First evidence wins on every evidence column. It ends the row as REFUNDED
   * immediately, whatever the vendor still says (evidence from either chain beats a
   * lagging vendor status), and fills `refund_tx_hash`/`refund_amount` where the vendor
   * has not. Refused (returns `false`) when the row already has destination evidence or
   * a SUCCESS outcome: a delivered deposit does not become a returned one.
   */
  applyRefundEvidence(
    depositAddress: string,
    evidence: { hash: string; source: string; amount: string; from: string },
    at = Date.now(),
  ): boolean {
    const result = this.#db
      .prepare(
        `UPDATE deposit_attempts SET
           refund_evidence_hash = COALESCE(refund_evidence_hash, ?),
           refund_evidence_source = COALESCE(refund_evidence_source, ?),
           refund_evidence_amount = COALESCE(refund_evidence_amount, ?),
           refund_evidence_from = COALESCE(refund_evidence_from, ?),
           refund_evidence_at = COALESCE(refund_evidence_at, ?),
           refund_tx_hash = COALESCE(NULLIF(refund_tx_hash, ''), ?),
           refund_amount = CASE WHEN refund_amount IS NULL OR refund_amount = '0' THEN ? ELSE refund_amount END,
           terminal_status = 'REFUNDED',
           terminal_at = COALESCE(terminal_at, ?),
           last_change_at = CASE WHEN refund_evidence_hash IS NULL THEN ? ELSE last_change_at END
         WHERE deposit_address = ?
           AND destination_tx_hash IS NULL
           AND (terminal_status IS NULL OR terminal_status IN ('REFUNDED', 'FAILED'))`,
      )
      .run(
        evidence.hash,
        evidence.source,
        evidence.amount,
        evidence.from,
        at,
        evidence.hash,
        evidence.amount,
        at,
        at,
        depositAddress,
      );
    return Number(result.changes ?? 0) > 0;
  }

  /**
   * Undo a REFUNDED outcome that came only from this app's own source-chain read, when
   * the vendor has since said SUCCESS and its payload shows the return was the surplus.
   *
   * 2026-10-13, deposit `71ptCLdp…`: 0.0189 SOL was sent against a 0.01 SOL quote. The
   * vendor returned the extra 0.0088 SOL first, the refund scan read that as the whole
   * deposit coming back and ended the row, and the delivery of 1.054412 USDC four
   * minutes later was never accepted. The row showed "Returned" for money that was in
   * the wallet.
   *
   * Only a row whose vendor never said REFUNDED or FAILED is touched, and never one with
   * a delivery already recorded. The return itself stays in the events table.
   */
  revertSurplusRefund(depositAddress: string, at = Date.now()): boolean {
    const result = this.#db
      .prepare(
        `UPDATE deposit_attempts SET
           terminal_status = NULL,
           terminal_at = NULL,
           refund_evidence_hash = NULL,
           refund_evidence_source = NULL,
           refund_evidence_amount = NULL,
           refund_evidence_from = NULL,
           refund_evidence_at = NULL,
           refund_tx_hash = NULL,
           refund_amount = NULL,
           last_change_at = ?
         WHERE deposit_address = ?
           AND terminal_status = 'REFUNDED'
           AND refund_evidence_hash IS NOT NULL
           AND destination_tx_hash IS NULL
           AND last_status NOT IN ('REFUNDED', 'FAILED')`,
      )
      .run(at, depositAddress);
    return Number(result.changes ?? 0) > 0;
  }

  /** Security review H1's exclusivity rule, for refunds: one transaction proves one row's return. */
  refundHashClaimedByOther(hash: string, excludingAddress: string): boolean {
    const row = this.#db
      .prepare(
        `SELECT 1 FROM deposit_attempts
          WHERE (refund_evidence_hash = ? OR refund_tx_hash = ?) AND deposit_address != ? LIMIT 1`,
      )
      .get(hash, hash, excludingAddress);
    return row !== undefined;
  }

  /**
   * Rows with an outcome that is still missing a fact the tracker shows, for at most
   * seven days after the outcome:
   *
   *   - REFUNDED without a refund hash (the vendor said so before the refund
   *     transaction was seen) or without the vendor's reason (the refund was seen on
   *     chain before the vendor said so);
   *   - SUCCESS from the vendor with no delivery this app has confirmed on Monad yet.
   *
   * `active()` stops at the outcome, so without this a row that went terminal on one
   * side's word was never looked at again, and sat on "Bridging to Monad" forever.
   * The watcher only ever enriches these rows; it never changes their outcome.
   */
  followUps(now = Date.now()): readonly DepositAttemptRow[] {
    return (
      this.#db
        .prepare(
          `SELECT * FROM deposit_attempts
            WHERE (terminal_at IS NOT NULL AND terminal_at > ?
              AND (
                (terminal_status = 'REFUNDED'
                   AND (refund_tx_hash IS NULL OR refund_tx_hash = '' OR refund_reason IS NULL))
                OR (terminal_status = 'SUCCESS' AND destination_tx_hash IS NULL)
              ))
              -- A stuck row stays watched until a chain shows its outcome, however long.
              OR (terminal_status IS NOT NULL AND stuck_at IS NOT NULL
                  AND destination_tx_hash IS NULL AND refund_evidence_hash IS NULL
                  AND terminal_status NOT IN ('REFUNDED', 'FAILED'))`,
        )
        .all(now - 7 * 24 * 60 * 60 * 1000) as Record<string, unknown>[]
    ).map(toAttemptRow);
  }

  /** Marks the row stuck, once: answers true only the first time. */
  markStuck(depositAddress: string, at = Date.now()): boolean {
    const result = this.#db
      .prepare(`UPDATE deposit_attempts SET stuck_at = ? WHERE deposit_address = ? AND stuck_at IS NULL`)
      .run(at, depositAddress);
    return Number(result.changes ?? 0) > 0;
  }

  /** Appends one recovery attempt, with the vendor's answer verbatim, to the row's record. */
  appendRecovery(depositAddress: string, attempt: RecoveryAttempt): void {
    const current = this.attempt(depositAddress)?.recoveryJson;
    const list = current ? (JSON.parse(current) as RecoveryAttempt[]) : [];
    list.push(attempt);
    this.#db
      .prepare(`UPDATE deposit_attempts SET recovery_json = ? WHERE deposit_address = ?`)
      .run(JSON.stringify(list), depositAddress);
  }

  /** Moves the Monad arrival scan's cursor forward; never backward. */
  setDestScanFrom(depositAddress: string, block: bigint): void {
    this.#db
      .prepare(
        `UPDATE deposit_attempts SET dest_scan_from = ?
          WHERE deposit_address = ? AND (dest_scan_from IS NULL OR CAST(dest_scan_from AS INTEGER) < ?)`,
      )
      .run(block.toString(), depositAddress, Number(block));
  }

  /** Records that a slow row was forced through a full re-check, so it is not re-forced every tick. */
  markSlowRecheck(depositAddress: string, at = Date.now()): void {
    this.#db
      .prepare(`UPDATE deposit_attempts SET slow_recheck_at = ? WHERE deposit_address = ?`)
      .run(at, depositAddress);
  }

  /**
   * The step-4 evidence, from this app's own chain read — independent of the vendor's
   * own status. First evidence wins: if the vendor's own report already landed this via
   * `applyOneClickStatus`, this is a no-op.
   *
   * Refuses (returns `false`, writes nothing) if the row has gone REFUNDED or FAILED
   * since the caller last read it — security review finding H1's race: `checkDestination`
   * runs against a snapshot taken before the tick's own vendor-status check, so a row
   * that went terminal earlier in the same tick must not have a stale scan's evidence
   * land on top of it and hide the refund. The check is inside this write, against the
   * row as it stands right now, not the caller's possibly-stale copy.
   */
  applyDestinationEvidence(
    depositAddress: string,
    evidence: { hash: string; block: string; source: string; amount?: string },
    at = Date.now(),
  ): boolean {
    const result = this.#db
      .prepare(
        `UPDATE deposit_attempts SET
           destination_tx_hash = COALESCE(destination_tx_hash, ?),
           destination_tx_block = COALESCE(destination_tx_block, ?),
           destination_evidence_source = COALESCE(destination_evidence_source, ?),
           destination_detected_at = COALESCE(destination_detected_at, ?),
           amount_out = COALESCE(amount_out, ?),
           -- Delivery seen on Monad ends the row as delivered (2026-09-29): an outcome,
           -- written once, never regressed by a later vendor word.
           terminal_status = COALESCE(terminal_status, 'SUCCESS'),
           terminal_at = COALESCE(terminal_at, ?),
           last_change_at = CASE WHEN destination_tx_hash IS NULL THEN ? ELSE last_change_at END
         WHERE deposit_address = ?
           AND (terminal_status IS NULL OR terminal_status NOT IN ('REFUNDED', 'FAILED'))`,
      )
      .run(evidence.hash, evidence.block, evidence.source, at, evidence.amount ?? null, at, at, depositAddress);
    return Number(result.changes ?? 0) > 0;
  }

  /**
   * Whether this hash is already this-deposit's own evidence, or another row's —
   * security review finding H1: two rows must never be able to claim the same
   * transaction as proof of their own, separate arrival.
   */
  destinationHashClaimedByOther(hash: string, excludingAddress: string): boolean {
    const row = this.#db
      .prepare(
        `SELECT 1 FROM deposit_attempts WHERE destination_tx_hash = ? AND deposit_address != ? LIMIT 1`,
      )
      .get(hash, excludingAddress);
    return row !== undefined;
  }

  /**
   * The step-2 evidence, whichever of this app's own source-chain watch or the vendor's
   * own reported origin hash arrives first. First evidence wins, same discipline as
   * `applyDestinationEvidence`.
   */
  applySourceEvidence(
    depositAddress: string,
    evidence: { hash?: string; source: string },
    at = Date.now(),
  ): void {
    this.#db
      .prepare(
        `UPDATE deposit_attempts SET
           source_tx_hash = COALESCE(source_tx_hash, ?),
           source_evidence_source = COALESCE(source_evidence_source, ?),
           source_tx_at = COALESCE(source_tx_at, ?),
           last_change_at = CASE WHEN source_evidence_source IS NULL THEN ? ELSE last_change_at END
         WHERE deposit_address = ?`,
      )
      .run(evidence.hash ?? null, evidence.source, at, at, depositAddress);
  }

  /**
   * The vendor's last status payload, verbatim — the step-3 tooltip's evidence.
   * Overwrites on every poll, unlike the other evidence methods: this is "the latest
   * word", not a fact that should freeze at its first value.
   */
  applyVendorRaw(depositAddress: string, raw: unknown, at = Date.now()): void {
    this.#db
      .prepare(
        `UPDATE deposit_attempts SET vendor_raw_json = ?, vendor_raw_at = ? WHERE deposit_address = ?`,
      )
      .run(JSON.stringify(raw), at, depositAddress);
  }

  /**
   * The margin balance "before", captured once step-4 evidence lands — same
   * best-effort, fire-and-forget pattern as `setRefundBalanceBefore`. Never blocks the
   * caller and never overwrites a value already captured.
   */
  setMarginBalanceBefore(depositAddress: string, balance: string, block: string): void {
    this.#db
      .prepare(
        `UPDATE deposit_attempts SET
           margin_balance_before = COALESCE(margin_balance_before, ?),
           margin_balance_before_block = COALESCE(margin_balance_before_block, ?)
         WHERE deposit_address = ?`,
      )
      .run(balance, block, depositAddress);
  }

  attempt(depositAddress: string): DepositAttemptRow | undefined {
    const row = this.#db
      .prepare(`SELECT * FROM deposit_attempts WHERE deposit_address = ?`)
      .get(depositAddress) as Record<string, unknown> | undefined;
    return row ? toAttemptRow(row) : undefined;
  }

  /** Every address that has not yet reached a terminal 1Click status. */
  active(): readonly DepositAttemptRow[] {
    return (
      this.#db
        .prepare(`SELECT * FROM deposit_attempts WHERE terminal_status IS NULL`)
        .all() as Record<string, unknown>[]
    ).map(toAttemptRow);
  }

  /** Every row this database has ever recorded, oldest first — the reconciliation script's own read. */
  allRows(): readonly DepositAttemptRow[] {
    return (
      this.#db.prepare(`SELECT * FROM deposit_attempts ORDER BY created_at ASC`).all() as Record<
        string,
        unknown
      >[]
    ).map(toAttemptRow);
  }

  /** Most recent attempts for one account, newest first — the "Recent deposits" list. */
  recentFor(recipient: string, limit = 20): readonly DepositAttemptRow[] {
    return (
      this.#db
        .prepare(
          `SELECT * FROM deposit_attempts WHERE recipient = ? ORDER BY created_at DESC LIMIT ?`,
        )
        .all(recipient.toLowerCase(), limit) as Record<string, unknown>[]
    ).map(toAttemptRow);
  }

  events(depositAddress: string): readonly DepositEventRow[] {
    return (
      this.#db
        .prepare(`SELECT * FROM deposit_events WHERE deposit_address = ? ORDER BY id ASC`)
        .all(depositAddress) as Record<string, unknown>[]
    ).map((r) => ({
      id: Number(r.id),
      depositAddress: String(r.deposit_address),
      type: String(r.type) as DepositEventType,
      status: r.status === null ? null : String(r.status),
      payloadJson: String(r.payload_json),
      at: Number(r.at),
    }));
  }

  /**
   * USD value of the last `sampleSize` **refunded** attempts for this route — what
   * the warning banner's threshold is computed from. Real outcomes, not a hardcoded
   * guess: see `warningThreshold` in `warn.ts`. Rows with no recorded USD value (the
   * network omitted `amountInUsd`), or a value that is not a clean integer string of
   * base units, are skipped rather than crashing the caller — this column has already
   * been corrupted once, by a backfill script that stored 1Click's decimal-formatted
   * string verbatim instead of converting it, and every Solana quote request failed
   * with a 500 until that row was found. A pricing endpoint must survive one bad row
   * in a history table it does not otherwise depend on.
   */
  recentRefundedUsdAmounts(sourceKey: string, sampleSize = 20): readonly bigint[] {
    const rows = this.#db
      .prepare(
        `SELECT amount_in_usd FROM deposit_attempts
         WHERE source_key = ? AND terminal_status = 'REFUNDED' AND amount_in_usd IS NOT NULL
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(sourceKey, sampleSize) as { amount_in_usd: string }[];
    const amounts: bigint[] = [];
    for (const r of rows) {
      if (!/^\d+$/.test(r.amount_in_usd)) continue;
      amounts.push(BigInt(r.amount_in_usd));
    }
    return amounts;
  }

  close(): void {
    this.#db.close();
  }
}

function toAttemptRow(row: Record<string, unknown>): DepositAttemptRow {
  return {
    depositAddress: String(row.deposit_address),
    recipient: String(row.recipient),
    sourceKey: String(row.source_key),
    chain: String(row.chain),
    route: String(row.route),
    refundTo: String(row.refund_to),
    amountIn: String(row.amount_in),
    amountInUsd: row.amount_in_usd === null ? null : String(row.amount_in_usd),
    refundBalanceBefore:
      row.refund_balance_before === null ? null : String(row.refund_balance_before),
    originDecimals: Number(row.origin_decimals),
    originSymbol: String(row.origin_symbol),
    expiresAt: Number(row.expires_at),
    createdAt: Number(row.created_at),
    sourceLandedAt: row.source_landed_at === null ? null : Number(row.source_landed_at),
    detectedAt: row.detected_at === null ? null : Number(row.detected_at),
    terminalAt: row.terminal_at === null ? null : Number(row.terminal_at),
    lastStatus: String(row.last_status),
    terminalStatus: row.terminal_status === null ? null : String(row.terminal_status),
    refundReason: row.refund_reason === null ? null : String(row.refund_reason),
    refundAmount: row.refund_amount === null ? null : String(row.refund_amount),
    rail: row.rail === null || row.rail === undefined ? null : String(row.rail),
    railRef: row.rail_ref === null || row.rail_ref === undefined ? null : String(row.rail_ref),
    sourceChainId: typeof row.source_chain_id === 'number' ? row.source_chain_id : null,
    refundTxHash: row.refund_tx_hash === null ? null : String(row.refund_tx_hash),
    refundExplorerUrl: row.refund_explorer_url === null ? null : String(row.refund_explorer_url),
    amountOut: row.amount_out === null ? null : String(row.amount_out),
    destinationTxHash:
      row.destination_tx_hash === null || row.destination_tx_hash === undefined
        ? null
        : String(row.destination_tx_hash),
    destinationTxBlock: nullableString(row.destination_tx_block),
    destinationEvidenceSource: nullableString(row.destination_evidence_source),
    destinationDetectedAt: nullableNumber(row.destination_detected_at),
    sourceTxHash: nullableString(row.source_tx_hash),
    sourceEvidenceSource: nullableString(row.source_evidence_source),
    sourceTxAt: nullableNumber(row.source_tx_at),
    vendorRawJson: nullableString(row.vendor_raw_json),
    vendorRawAt: nullableNumber(row.vendor_raw_at),
    etaSeconds: nullableNumber(row.eta_seconds),
    outToken: nullableString(row.out_token),
    marginBalanceBefore: nullableString(row.margin_balance_before),
    marginBalanceBeforeBlock: nullableString(row.margin_balance_before_block),
    landsIn: nullableString(row.lands_in),
    quotedAmountOut: nullableString(row.quoted_amount_out),
    refundEvidenceHash: nullableString(row.refund_evidence_hash),
    refundEvidenceSource: nullableString(row.refund_evidence_source),
    refundEvidenceAmount: nullableString(row.refund_evidence_amount),
    refundEvidenceFrom: nullableString(row.refund_evidence_from),
    refundEvidenceAt: nullableNumber(row.refund_evidence_at),
    lastChangeAt: nullableNumber(row.last_change_at),
    slowRecheckAt: nullableNumber(row.slow_recheck_at),
    destScanFrom: nullableString(row.dest_scan_from),
    stuckAt: nullableNumber(row.stuck_at),
    recoveryJson: nullableString(row.recovery_json),
  };
}

function nullableString(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

function nullableNumber(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

let shared: DepositDb | undefined;

/** One instance per process — the watcher, the API routes and instrumentation.ts all share it. */
export function depositDb(): DepositDb {
  if (!shared) shared = new DepositDb(process.env.DEPOSIT_DB_PATH ?? './data/deposits.sqlite');
  return shared;
}
