import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stuckThresholdMs, VENDOR_SUPPORT } from '@tradepro/core';
import { DepositDb } from './db';
import { evaluateStuck, helpReportFor } from './stuck';
import { recoverStuck } from './recovery';

/**
 * Stuck deposits (owner, 2026-09-30), per rail, on recorded payloads:
 *   - vendor status: 1Click `/v0/status` PROCESSING for BhJJtyzn... (recorded
 *     2026-09-24), Relay `/intents/status` "unknown" for 68mSo... (recorded 2026-09-29);
 *   - recovery answers: 1Click `/v0/deposit/submit` for TTmr6f2... (201), Relay
 *     `/transactions/deposit-address/reindex` for 0x83ae... on Base (200, "No balances
 *     found"), Circle `/v2/messages` for a hash with no message (404). All recorded
 *     2026-09-30. No CCTP burn has ever been made from this app, so no re-attest answer
 *     exists to record; the CCTP case records the real "no message" answer and makes
 *     no re-attest call.
 */
const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8');
const recorded = (name: string) => JSON.parse(fixture(name)) as { httpStatus: number; body: string };

const T0 = Date.parse('2026-09-30T08:00:00Z');
const OWNER = '0x714f169fe2d3990961b534d573f9646c037586e6';

interface RailCase {
  rail: 'near' | 'relay' | 'cctp';
  address: string;
  chain: string;
  symbol: string;
  decimals: number;
  amountIn: string;
  refundTo: string;
  etaSeconds: number | null;
  sourceTxHash: string;
  vendorStatus: string;
  vendorRaw: string;
  recovery: { name: string; url: string };
  railRef?: string;
  sourceChainId?: number;
}

const CASES: RailCase[] = [
  {
    rail: 'near',
    address: 'BhJJtyzn8JpuJ6NyHVfUS9dubn9knc7fC5Pkem5qWWyF',
    chain: 'Solana',
    symbol: 'SOL',
    decimals: 9,
    amountIn: '10000000',
    refundTo: 'CFMGosQQehGZkaAPaQhGkkmqNyabZcnCHLyfrg4E9M31',
    etaSeconds: 24,
    sourceTxHash: '2pPsRJgLetEi47AKNpnrKnRGSYDUNeHW3Ju9FzDEzFBfJEMPZyNDTFECErnjJ9zHzev3mnz9Zos7tVmHFpwAG2Vi',
    vendorStatus: 'PROCESSING',
    vendorRaw: fixture('oneclick.status.BhJJ-PROCESSING.event282907.fixture.json'),
    recovery: { name: 'oneclick.deposit-submit.TTmr.fixture.json', url: 'https://1click.chaindefuser.com/v0/deposit/submit' },
  },
  {
    rail: 'relay',
    address: '0x83ae43810f754542d940aaa0fb8ad096fd00115c',
    chain: 'Base',
    symbol: 'USDC',
    decimals: 6,
    amountIn: '1000000',
    refundTo: '0x19c26c36838425bb6a0bf16d71ec2a298d910221',
    etaSeconds: null,
    // Synthetic: no Relay deposit address from this app has ever been funded.
    sourceTxHash: `0x${'5e'.repeat(32)}`,
    vendorStatus: 'PENDING_DEPOSIT',
    vendorRaw: fixture('relay.intents-status.68mSo-unknown.fixture.json'),
    recovery: { name: 'relay.deposit-address-reindex.0x83ae.fixture.json', url: 'https://api.relay.link/transactions/deposit-address/reindex' },
  },
  {
    rail: 'cctp',
    address: 'cctp-burn-0x0000000000000000000000000000000000000000000000000000000000000001',
    chain: 'Arbitrum',
    symbol: 'USDC',
    decimals: 6,
    amountIn: '1000000',
    refundTo: OWNER,
    etaSeconds: 60,
    sourceTxHash: '0x0000000000000000000000000000000000000000000000000000000000000001',
    vendorStatus: 'PROCESSING',
    vendorRaw: '{"messages":[]}',
    recovery: { name: 'iris.v2-messages.not-found.fixture.json', url: 'https://iris-api.circle.com/v2/messages/3?transactionHash=' },
    railRef: '0x0000000000000000000000000000000000000000000000000000000000000001',
    sourceChainId: 42161,
  },
];

function seed(c: RailCase) {
  const db = new DepositDb(':memory:');
  db.register({
    depositAddress: c.address,
    recipient: OWNER,
    sourceKey: `${c.chain.toLowerCase()}-${c.symbol.toLowerCase()}`,
    chain: c.chain,
    route: c.rail,
    refundTo: c.refundTo,
    amountIn: c.amountIn,
    originDecimals: c.decimals,
    originSymbol: c.symbol,
    expiresAt: T0 + 24 * 60 * 60 * 1000,
    rail: c.rail,
    ...(c.railRef ? { railRef: c.railRef } : {}),
    ...(c.sourceChainId ? { sourceChainId: c.sourceChainId } : {}),
    ...(c.etaSeconds !== null ? { etaSeconds: c.etaSeconds } : {}),
    outToken: 'USDC',
    landsIn: 'wallet',
    quotedAmountOut: '1161990',
    now: T0,
  });
  db.applyRailStatus(c.address, { status: c.vendorStatus, terminal: false }, T0);
  db.applyVendorRaw(c.address, JSON.parse(c.vendorRaw), T0);
  db.markSourceLanded(c.address, T0);
  db.applySourceEvidence(c.address, { hash: c.sourceTxHash, source: `our-watcher-${c.chain.toLowerCase()}` }, T0);
  return db;
}

function recordingFetch(c: RailCase) {
  const calls: string[] = [];
  const answer = recorded(c.recovery.name);
  const f = (async (url: string | URL) => {
    calls.push(String(url));
    return new Response(answer.body, { status: answer.httpStatus });
  }) as typeof fetch;
  return { f, calls };
}

for (const c of CASES) {
  describe(`stuck deposits, ${c.rail}`, () => {
    const threshold = stuckThresholdMs(c.etaSeconds);
    const lastChange = () => T0; // every evidence above was written at T0

    it('stuck detection fires at the threshold, not a moment before, and once', async () => {
      const db = seed(c);
      const warnings: string[] = [];
      const deps = (now: number) => ({ now, warn: (l: string) => warnings.push(l), reportPath: join(mkdtempSync(join(tmpdir(), 'stuck-')), 'STUCK-DEPOSITS.md') });
      expect(await evaluateStuck(db, db.active(), deps(lastChange() + threshold - 1))).toEqual([]);
      const found = await evaluateStuck(db, db.active(), deps(lastChange() + threshold));
      expect(found.map((r) => r.depositAddress)).toEqual([c.address]);
      expect(db.attempt(c.address)!.stuckAt).toBe(lastChange() + threshold);
      expect(await evaluateStuck(db, db.active(), deps(lastChange() + threshold + 60_000))).toEqual([]);
      // The operator alert: one warn line, with the same fields as the user's report.
      const alert = JSON.parse(warnings.find((w) => w.includes('"deposit stuck"'))!) as Record<string, unknown>;
      expect(alert).toMatchObject({ level: 'warn', depositAddress: c.address, sourceTxHash: c.sourceTxHash, refundTo: c.refundTo, lastStatus: c.vendorStatus });
    });

    it('the documented recovery call is attempted once and recorded with the vendor answer verbatim', async () => {
      const db = seed(c);
      const { f, calls } = recordingFetch(c);
      const now = lastChange() + threshold;
      const reportPath = join(mkdtempSync(join(tmpdir(), 'stuck-')), 'STUCK-DEPOSITS.md');
      const deps = { now, reportPath, warn: () => undefined, recover: (row: Parameters<typeof recoverStuck>[0]) => recoverStuck(row, f, () => now) };
      await evaluateStuck(db, db.active(), deps);
      await evaluateStuck(db, db.active(), { ...deps, now: now + 60_000 });
      const attempts = JSON.parse(db.attempt(c.address)!.recoveryJson!) as { call: string; httpStatus: number | null; answer: string }[];
      expect(attempts).toHaveLength(1);
      expect(calls.length).toBe(1);
      expect(calls[0]!.startsWith(c.recovery.url)).toBe(true);
      const answer = recorded(c.recovery.name);
      if (c.rail === 'cctp') {
        // Circle gave no message for this hash, so no re-attest was sent.
        expect(attempts[0]!.answer).toContain('gave no nonce');
        expect(attempts[0]!.httpStatus).toBe(404);
      } else {
        expect(attempts[0]!.answer).toBe(answer.body.slice(0, 2000));
        expect(attempts[0]!.httpStatus).toBe(answer.httpStatus);
      }
      // And the operator file has its section, with every field.
      const md = readFileSync(reportPath, 'utf8');
      for (const field of [c.address, c.sourceTxHash, c.refundTo, c.vendorStatus, 'Route quoted', 'Landed', 'Account', VENDOR_SUPPORT[c.rail].name]) {
        expect(md).toContain(field);
      }
    });

    it('the help report contains every field, first person, no em-dashes', () => {
      const db = seed(c);
      const row = db.attempt(c.address)!;
      const report = helpReportFor(row, lastChange() + threshold + 5 * 60_000);
      const vendor = VENDOR_SUPPORT[c.rail];
      for (const field of [
        vendor.name,
        vendor.supportUrl!,
        `Deposit address: ${c.address}`,
        `Source transaction: ${c.sourceTxHash}`,
        `Amount: `,
        `Landed on ${c.chain}: ${new Date(T0).toISOString()}`,
        'Route quoted: ',
        `Refund address: ${c.refundTo}`,
        `Last status from ${vendor.name}: ${c.vendorStatus}`,
        `as ${vendor.name} sent it: ${JSON.stringify(JSON.parse(c.vendorRaw))}`,
      ]) {
        expect(report).toContain(field);
      }
      expect(report).toMatch(/\bI sent\b/);
      expect(report).not.toMatch(/—/);
    });

    it('delivery on Monad after being stuck closes the row; so does a refund', async () => {
      for (const outcome of ['delivered', 'refunded'] as const) {
        const db = seed(c);
        const now = lastChange() + threshold;
        await evaluateStuck(db, db.active(), { now, warn: () => undefined, reportPath: join(mkdtempSync(join(tmpdir(), 'stuck-')), 'S.md') });
        expect(db.attempt(c.address)!.stuckAt).not.toBeNull();
        if (outcome === 'delivered') {
          db.applyDestinationEvidence(c.address, { hash: '0xf243398b2fab7a2a82c95c99b472c11d1b7fc4700e4f2ff44d41d588c3023af7', block: '109026214', source: 'monad-arrival-scan' }, now + 1);
          expect(db.attempt(c.address)!.terminalStatus).toBe('SUCCESS');
        } else {
          db.applyRefundEvidence(c.address, { hash: '4jVcz2r6GkKA7oujk6VNTjCrBYT8EHSS8UMKQTCqxVmss9cxBoj7YR2CB1yU5ufngUcYFA3AKAcpUNZgDrgn2Hd1', source: 'our-watcher-solana', amount: c.amountIn, from: c.address }, now + 1);
          expect(db.attempt(c.address)!.terminalStatus).toBe('REFUNDED');
        }
        // Off the watcher: not active, and not a stuck follow-up any more.
        expect(db.active().some((r) => r.depositAddress === c.address)).toBe(false);
        expect(db.followUps(now + 2).some((r) => r.depositAddress === c.address && r.stuckAt !== null && !r.destinationTxHash && !r.refundEvidenceHash)).toBe(false);
      }
    });
  });
}

describe('a stuck row stays on the watcher', () => {
  it('a vendor SUCCESS with nothing seen on Monad, stuck, is followed up however long it takes', async () => {
    const c = CASES[0]!;
    const db = seed(c);
    const now = T0 + stuckThresholdMs(c.etaSeconds);
    await evaluateStuck(db, db.active(), { now, warn: () => undefined, reportPath: join(mkdtempSync(join(tmpdir(), 'stuck-')), 'S.md') });
    db.applyRailStatus(c.address, { status: 'SUCCESS', terminal: true }, now + 1);
    const thirtyDaysLater = now + 30 * 24 * 60 * 60 * 1000;
    expect(db.followUps(thirtyDaysLater).some((r) => r.depositAddress === c.address)).toBe(true);
  });
});
