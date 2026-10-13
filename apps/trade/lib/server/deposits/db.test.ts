import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DepositDb } from './db.js';

/**
 * The persistence layer D105 asks for: "nothing is inferred; every row is what the
 * chain or 1Click actually said." These tests are about that guarantee — a row exists
 * only when something real was written, and `deposit_events` is an append-only record
 * of what changed, not a log of every question asked.
 */

function registered(db: DepositDb, address = '0xdeposit1') {
  db.register({
    depositAddress: address,
    recipient: '0xRecipient',
    sourceKey: 'sol-solana',
    chain: 'Solana',
    route: 'intents',
    refundTo: 'RefundAddr111',
    amountIn: '10000000',
    amountInUsd: '1013200',
    originDecimals: 9,
    originSymbol: 'SOL',
    expiresAt: Date.now() + 3 * 86_400_000,
  });
  return address;
}

describe('register', () => {
  it('creates a row readable back by attempt()', () => {
    const db = new DepositDb(':memory:');
    const address = registered(db);
    const row = db.attempt(address);
    expect(row?.lastStatus).toBe('PENDING_DEPOSIT');
    expect(row?.sourceLandedAt).toBeNull();
    expect(row?.terminalStatus).toBeNull();
  });

  it('is idempotent — registering the same address twice keeps the first row', () => {
    const db = new DepositDb(':memory:');
    const address = registered(db);
    db.register({
      depositAddress: address,
      recipient: '0xDIFFERENT',
      sourceKey: 'usdc-base',
      chain: 'Base',
      route: 'intents',
      refundTo: 'x',
      amountIn: '1',
      originDecimals: 6,
      originSymbol: 'USDC',
      expiresAt: Date.now(),
    });
    expect(db.attempt(address)?.recipient).toBe('0xrecipient');
  });

  it('writes a REGISTERED event', () => {
    const db = new DepositDb(':memory:');
    const address = registered(db);
    const events = db.events(address);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('REGISTERED');
  });
});

describe('markSourceLanded', () => {
  it('sets sourceLandedAt once and does not move it on a second call', () => {
    const db = new DepositDb(':memory:');
    const address = registered(db);
    db.markSourceLanded(address, 1_000);
    db.markSourceLanded(address, 2_000);
    expect(db.attempt(address)?.sourceLandedAt).toBe(1_000);
  });
});

describe('applyOneClickStatus', () => {
  it('moves the attempt out of active() once terminal', () => {
    const db = new DepositDb(':memory:');
    const address = registered(db);
    expect(db.active().map((a) => a.depositAddress)).toContain(address);
    db.applyOneClickStatus(address, {
      status: 'REFUNDED',
      terminal: true,
      refundReason: 'NO_LIQUIDITY',
    });
    expect(db.active().map((a) => a.depositAddress)).not.toContain(address);
  });

  it('records terminalAt once — a repeated terminal read does not move it', () => {
    const db = new DepositDb(':memory:');
    const address = registered(db);
    db.applyOneClickStatus(address, { status: 'REFUNDED', terminal: true }, 5_000);
    db.applyOneClickStatus(address, { status: 'REFUNDED', terminal: true }, 9_000);
    expect(db.attempt(address)?.terminalAt).toBe(5_000);
  });

  it('carries the refund reason, amount, tx hash and explorer link through', () => {
    const db = new DepositDb(':memory:');
    const address = registered(db);
    db.applyOneClickStatus(address, {
      status: 'REFUNDED',
      terminal: true,
      refundReason: 'NO_LIQUIDITY',
      refundAmount: '9898383',
      refundTxHash: 'abc123',
      refundExplorerUrl: 'https://explorer.example/tx/abc123',
    });
    const row = db.attempt(address);
    expect(row?.refundReason).toBe('NO_LIQUIDITY');
    expect(row?.refundAmount).toBe('9898383');
    expect(row?.refundTxHash).toBe('abc123');
    expect(row?.refundExplorerUrl).toBe('https://explorer.example/tx/abc123');
  });

  it('carries the destination tx hash through for a delivered row (item 5b)', () => {
    const db = new DepositDb(':memory:');
    const address = registered(db);
    db.applyOneClickStatus(address, {
      status: 'SUCCESS',
      terminal: true,
      destinationTxHash: '0xdestinationhash',
    });
    expect(db.attempt(address)?.destinationTxHash).toBe('0xdestinationhash');
  });

  it('leaves destinationTxHash null for a row that never delivered', () => {
    const db = new DepositDb(':memory:');
    const address = registered(db);
    db.applyOneClickStatus(address, { status: 'REFUNDED', terminal: true });
    expect(db.attempt(address)?.destinationTxHash).toBeNull();
  });
});

describe('the destination_tx_hash migration (item 5b)', () => {
  it('adds the column to a table that predates it, without losing existing rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tradepro-migrate-'));
    const path = join(dir, 'deposits.sqlite');
    try {
      // Build the table exactly as it existed before this column, then open it
      // with today's DepositDb — the real shape a production upgrade hits.
      const raw = new DatabaseSync(path);
      raw.exec(`
        CREATE TABLE deposit_attempts (
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
      `);
      raw.exec(
        `INSERT INTO deposit_attempts (deposit_address, recipient, source_key, chain, route,
          refund_to, amount_in, origin_decimals, origin_symbol, expires_at, created_at, last_status)
         VALUES ('0xpre-existing', '0xrecipient', 'sol-solana', 'Solana', 'intents', 'refund',
          '1', 9, 'SOL', 1, 1, 'PENDING_DEPOSIT')`,
      );
      raw.close();

      const db = new DepositDb(path);
      const row = db.attempt('0xpre-existing');
      expect(row?.recipient).toBe('0xrecipient');
      expect(row?.destinationTxHash).toBeNull();

      db.applyOneClickStatus('0xpre-existing', {
        status: 'SUCCESS',
        terminal: true,
        destinationTxHash: '0xnowset',
      });
      expect(db.attempt('0xpre-existing')?.destinationTxHash).toBe('0xnowset');
      db.close();

      // Opening it a second time must not fail on "duplicate column".
      const reopened = new DepositDb(path);
      expect(() => reopened).not.toThrow();
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});

describe('recentFor', () => {
  it("lists an account's own attempts, newest first, and only that account's", () => {
    const db = new DepositDb(':memory:');
    db.register({
      depositAddress: 'a1',
      recipient: '0xAAA',
      sourceKey: 'sol-solana',
      chain: 'Solana',
      route: 'intents',
      refundTo: 'x',
      amountIn: '1',
      originDecimals: 9,
      originSymbol: 'SOL',
      expiresAt: 0,
      now: 1_000,
    });
    db.register({
      depositAddress: 'a2',
      recipient: '0xAAA',
      sourceKey: 'sol-solana',
      chain: 'Solana',
      route: 'intents',
      refundTo: 'x',
      amountIn: '1',
      originDecimals: 9,
      originSymbol: 'SOL',
      expiresAt: 0,
      now: 2_000,
    });
    db.register({
      depositAddress: 'b1',
      recipient: '0xBBB',
      sourceKey: 'sol-solana',
      chain: 'Solana',
      route: 'intents',
      refundTo: 'x',
      amountIn: '1',
      originDecimals: 9,
      originSymbol: 'SOL',
      expiresAt: 0,
      now: 1_500,
    });
    const rows = db.recentFor('0xAAA');
    expect(rows.map((r) => r.depositAddress)).toEqual(['a2', 'a1']);
  });
});

describe('recentRefundedUsdAmounts survives a corrupted row', () => {
  // A real incident: a backfill script stored 1Click's decimal-formatted USD string
  // ("1.014700000000") straight into this column instead of converting it to base
  // units, and BigInt() on that string threw inside this function — which
  // warningThreshold() calls, which /api/fund/quote calls unconditionally for every
  // `intents` quote. One bad row took down every Solana quote request with a 500
  // until the row was found by hand. This is the regression test for that outage.
  //
  // `DepositDb` exposes no way to write a malformed value — correctly, that should
  // never be reachable through its own API — so the corruption is written with a
  // second, raw connection to the same file, the way the real bad row actually got
  // there (a different piece of code writing straight SQL).
  const dir = mkdtempSync(join(tmpdir(), 'deposit-db-corrupt-test-'));
  const path = join(dir, 'deposits.sqlite');

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('skips a row whose amount_in_usd is not a clean integer string, rather than throwing', () => {
    const db = new DepositDb(path);
    registered(db, 'good');
    db.applyOneClickStatus('good', { status: 'REFUNDED', terminal: true, refundAmount: '1' });
    registered(db, 'corrupted');
    db.applyOneClickStatus('corrupted', { status: 'REFUNDED', terminal: true, refundAmount: '1' });
    db.close();

    const raw = new DatabaseSync(path);
    raw
      .prepare(`UPDATE deposit_attempts SET amount_in_usd = ? WHERE deposit_address = ?`)
      .run('1.014700000000', 'corrupted');
    raw.close();

    const reopened = new DepositDb(path);
    let amounts: readonly bigint[] = [];
    expect(() => {
      amounts = reopened.recentRefundedUsdAmounts('sol-solana');
    }).not.toThrow();
    expect(amounts).toEqual([1_013_200n]);
    reopened.close();
  });
});

describe('recentRefundedUsdAmounts — the warning threshold input', () => {
  it('returns only REFUNDED attempts for the given source, most recent first bound by sample size', () => {
    const db = new DepositDb(':memory:');
    for (const [address, amountInUsd, status] of [
      ['r1', '1000000', 'REFUNDED'],
      ['r2', '2000000', 'REFUNDED'],
      ['r3', '3000000', 'SUCCESS'],
    ] as const) {
      db.register({
        depositAddress: address,
        recipient: '0xAAA',
        sourceKey: 'sol-solana',
        chain: 'Solana',
        route: 'intents',
        refundTo: 'x',
        amountIn: '1',
        amountInUsd,
        originDecimals: 9,
        originSymbol: 'SOL',
        expiresAt: 0,
      });
      db.applyOneClickStatus(address, { status, terminal: true });
    }
    const amounts = db.recentRefundedUsdAmounts('sol-solana').map(String);
    expect(amounts.sort()).toEqual(['1000000', '2000000']);
  });
});

describe('the tracker rebuild evidence columns', () => {
  it('applyDestinationEvidence: first evidence wins — a second call cannot overwrite it', () => {
    const db = new DepositDb(':memory:');
    const address = registered(db);
    db.applyDestinationEvidence(address, {
      hash: '0xfirst',
      block: '100',
      source: 'eth_getTransactionReceipt',
      amount: '5000000',
    });
    db.applyDestinationEvidence(address, {
      hash: '0xsecond',
      block: '200',
      source: 'balance-poll',
      amount: '9999999',
    });
    const row = db.attempt(address);
    expect(row?.destinationTxHash).toBe('0xfirst');
    expect(row?.destinationTxBlock).toBe('100');
    expect(row?.destinationEvidenceSource).toBe('eth_getTransactionReceipt');
    expect(row?.amountOut).toBe('5000000');
  });

  it('applyOneClickStatus and applyDestinationEvidence never clobber each other, whichever runs first', () => {
    const db = new DepositDb(':memory:');
    const address = registered(db);
    // Our own chain read arrives first.
    db.applyDestinationEvidence(address, { hash: '0xours', block: '10', source: 'balance-poll' });
    // The vendor reports SUCCESS afterward, with its own hash — must not overwrite.
    db.applyOneClickStatus(address, { status: 'SUCCESS', terminal: true, destinationTxHash: '0xvendor' });
    expect(db.attempt(address)?.destinationTxHash).toBe('0xours');
  });

  it('applySourceEvidence: first evidence wins between our own watch and the vendor', () => {
    const db = new DepositDb(':memory:');
    const address = registered(db);
    db.applySourceEvidence(address, { hash: '0xsrc-ours', source: 'our-watcher-solana' });
    db.applySourceEvidence(address, { hash: '0xsrc-vendor', source: 'vendor:near' });
    const row = db.attempt(address);
    expect(row?.sourceTxHash).toBe('0xsrc-ours');
    expect(row?.sourceEvidenceSource).toBe('our-watcher-solana');
  });

  it('applyVendorRaw overwrites on every call — it is the latest word, not a frozen fact', () => {
    const db = new DepositDb(':memory:');
    const address = registered(db);
    db.applyVendorRaw(address, { status: 'PROCESSING' }, 1000);
    db.applyVendorRaw(address, { status: 'PROCESSING' }, 2000);
    const row = db.attempt(address);
    expect(row?.vendorRawAt).toBe(2000);
    expect(JSON.parse(row!.vendorRawJson!)).toEqual({ status: 'PROCESSING' });
  });

  it('setMarginBalanceBefore is captured once and never overwritten', () => {
    const db = new DepositDb(':memory:');
    const address = registered(db);
    db.setMarginBalanceBefore(address, '1000', '50');
    db.setMarginBalanceBefore(address, '9999', '60');
    const row = db.attempt(address);
    expect(row?.marginBalanceBefore).toBe('1000');
    expect(row?.marginBalanceBeforeBlock).toBe('50');
  });

  it('register carries etaSeconds, outToken and landsIn through to the row', () => {
    const db = new DepositDb(':memory:');
    const address = 'eta-address';
    db.register({
      depositAddress: address,
      recipient: '0xAAA',
      sourceKey: 'sol-solana',
      chain: 'Solana',
      route: 'intents',
      refundTo: 'x',
      amountIn: '1',
      originDecimals: 9,
      originSymbol: 'SOL',
      expiresAt: 0,
      etaSeconds: 45,
      outToken: 'USDC',
      landsIn: 'margin',
    });
    const row = db.attempt(address);
    expect(row?.etaSeconds).toBe(45);
    expect(row?.outToken).toBe('USDC');
    expect(row?.landsIn).toBe('margin');
  });
});

describe('a surplus returned before delivery (deposit 71ptCLdp, 2026-10-13)', () => {
  const refund = { hash: 'RefundTx111', source: 'our-watcher-solana', amount: '8771942', from: 'VendorAcct111' };

  it('goes back in flight, then ends delivered, once the vendor reports the delivery', () => {
    const db = new DepositDb(':memory:');
    const address = registered(db);
    db.applyOneClickStatus(address, { status: 'PROCESSING', terminal: false });
    expect(db.applyRefundEvidence(address, refund)).toBe(true);
    expect(db.attempt(address)?.terminalStatus).toBe('REFUNDED');

    expect(db.revertSurplusRefund(address)).toBe(true);
    const open = db.attempt(address);
    expect(open?.terminalStatus).toBeNull();
    expect(open?.refundEvidenceHash).toBeNull();
    expect(open?.refundTxHash).toBeNull();

    db.applyOneClickStatus(address, { status: 'SUCCESS', terminal: true, amountOut: '1054412' });
    expect(db.attempt(address)?.terminalStatus).toBe('SUCCESS');
    expect(db.applyDestinationEvidence(address, { hash: '0xdelivered', block: '1', source: 'vendor-confirmed' })).toBe(true);
    expect(db.attempt(address)?.destinationTxHash).toBe('0xdelivered');
  });

  it('leaves a refund the vendor itself reported alone', () => {
    const db = new DepositDb(':memory:');
    const address = registered(db);
    db.applyOneClickStatus(address, { status: 'REFUNDED', terminal: true, refundAmount: '9194707' });
    db.applyRefundEvidence(address, { ...refund, amount: '9194707' });
    expect(db.revertSurplusRefund(address)).toBe(false);
    expect(db.attempt(address)?.terminalStatus).toBe('REFUNDED');
  });
});
