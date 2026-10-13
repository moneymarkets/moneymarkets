import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * `registerDeposit` existed and was correctly written the whole time — nothing called
 * it. `depositDb().register()` (the bare DB write) is what `/api/fund/execute` and
 * `/api/fund/burn` actually called, which skips the two side effects only this
 * wrapper performs: prefetching a Base starting block, and reading the refund
 * wallet's balance *before* anything lands so the terminal card has a real "before"
 * to compare its "after" against. `refund_balance_before` was written for zero real
 * deposits as a result (Section 1 Medium, audit). `/api/fund/execute` now calls this
 * function instead of the bare write — this test is the wrapper's own contract.
 */

const dir = mkdtempSync(join(tmpdir(), 'tradepro-watcher-'));
process.env.DEPOSIT_DB_PATH = join(dir, 'deposits.sqlite');

vi.mock('./chains.js', () => ({
  sourceBalance: vi.fn(async () => 42_000_000n),
  baseBlockNumber: vi.fn(async () => 999_999n),
  baseLanded: vi.fn(),
  solanaLanded: vi.fn(),
  tronLanded: vi.fn(),
}));

const { depositDb } = await import('./db.js');
const { registerDeposit, stopDepositWatcher } = await import('./watcher.js');
const { sourceBalance } = await import('./chains.js');

afterAll(() => {
  stopDepositWatcher();
  // Windows will not remove the directory while the sqlite file handle is open.
  depositDb().close();
  rmSync(dir, { recursive: true, force: true });
});

describe('registerDeposit writes the row and the refund balance "before"', () => {
  const input = {
    depositAddress: '0xdeposit-test-1',
    recipient: '0xRecipient',
    sourceKey: 'base-usdc',
    chain: 'Base',
    route: 'relay',
    refundTo: '0xRefundWallet',
    amountIn: '10000000',
    originDecimals: 6,
    originSymbol: 'USDC',
    expiresAt: Date.now() + 3_600_000,
    rail: 'relay',
    railRef: 'req-1',
  };

  beforeAll(async () => {
    await registerDeposit(input);
    // The refund-balance-before read is deliberately fire-and-forget inside
    // `registerDeposit` ("best-effort and never blocks registration") — give its
    // `.then()` a tick to land before asserting on it.
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it('registers the attempt row', () => {
    const attempt = depositDb().attempt(input.depositAddress);
    expect(attempt).toBeDefined();
    expect(attempt?.rail).toBe('relay');
    expect(attempt?.railRef).toBe('req-1');
  });

  it('reads and records the refund wallet balance before — the actual defect', () => {
    expect(sourceBalance).toHaveBeenCalledWith(input.chain, input.refundTo, undefined);
    const attempt = depositDb().attempt(input.depositAddress);
    expect(attempt?.refundBalanceBefore).toBe('42000000');
  });
});
