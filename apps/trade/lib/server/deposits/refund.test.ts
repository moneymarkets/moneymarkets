import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveTrackerState, sourceTxExplorerUrl, trackerInputFromRow, type TrackerState } from '@tradepro/core';
import { DepositDb, type DepositAttemptRow } from './db.js';
import {
  detectSourceRefund,
  findTronRefund,
  refundAmountPlausible,
  type SourceChainReaders,
  type TronTransfer,
} from './refund.js';
import { solanaLanded } from './chains.js';
import { slowNeedsRecheck } from './watcher.js';

/**
 * The deposit tracker, every state, on recorded payloads (owner item, 2026-09-29).
 *
 * Every fixture under `__fixtures__/` is a real response, named after its source:
 *
 *   - `solana.*`: Solana mainnet JSON-RPC (`api.mainnet-beta.solana.com`), read
 *     2026-09-29, for the owner's own SOL deposit `7uNPTMxP...uw5u` (0.01 SOL sent from
 *     `CFMGos...M31`, returned 0.009408387 SOL by `4jVcz...Hd1`), for the never-funded
 *     1Click address `DnfBm...SHUd`, and for Relay address `E1J8...ttCY`, whose only
 *     transactions all failed.
 *   - `oneclick.status.*`: 1Click `/v0/status`. `event4`/`event6`/`event282907` are the
 *     payloads the production watcher stored in `deposit_events` (ids 4, 6 and 282907 of
 *     the 2026-09-29 backup); `-live` ones were read 2026-09-29.
 *   - `relay.intents-status.*`: Relay `/intents/status`, read 2026-09-29.
 *   - `tron.trc20-transactions.*`: TronGrid `/v1/accounts/{address}/transactions/trc20`,
 *     read 2026-09-29.
 *
 * The real order of events for `7uNP`, from those payloads and the chain: deposit seen
 * 17:48:45, 1Click PROCESSING at 17:49:20, refund on Solana at 17:49:42, 1Click REFUNDED
 * at 17:49:43.
 */

const FIX = join(import.meta.dirname, '__fixtures__');
const fixture = <T = unknown>(name: string): T => JSON.parse(readFileSync(join(FIX, name), 'utf8')) as T;

const DEPOSIT = '7uNPTMxPfwitS7fCMF9Q5v58VvdpkMsCrxixabwEuw5u';
const REFUND_TO = 'CFMGosQQehGZkaAPaQhGkkmqNyabZcnCHLyfrg4E9M31';
const DEPOSIT_TX = '23gwvHD6XqTHz3vqAzaT4GMQTy816zj6WHvMfU8dcx5ZCfLFWki1ZsAa9cph3NtDhAMg3t7mAJw8rmNbLB3DLb28';
const REFUND_TX = '4jVcz2r6GkKA7oujk6VNTjCrBYT8EHSS8UMKQTCqxVmss9cxBoj7YR2CB1yU5ufngUcYFA3AKAcpUNZgDrgn2Hd1';
/** The block time of `4jVcz...`, from its own `getTransaction`. */
const REFUND_AT = 1788457782_000;

interface OneClickPayload {
  status: string;
  swapDetails?: {
    refundReason?: string | null;
    refundedAmount?: string | null;
    originChainTxHashes?: { hash: string }[];
  };
}

/** Solana readers answering only from the recorded payloads; anything unrecorded fails loudly. */
function solanaReaders(options: { refundVisible: boolean }): SourceChainReaders {
  const signatures: Record<string, string> = {
    [DEPOSIT]: 'solana.getSignaturesForAddress.7uNP-deposit.fixture.json',
    [REFUND_TO]: 'solana.getSignaturesForAddress.CFMGos-refundTo.fixture.json',
  };
  const transactions: Record<string, string> = {
    [REFUND_TX]: 'solana.getTransaction.4jVcz-refund.fixture.json',
    [DEPOSIT_TX]: 'solana.getTransaction.23gwv-deposit.fixture.json',
    '3JUKeemLzTb2YU9Pkn2B96L7PZx5wgqcuRfe7hBa6Sm7WrZnmYgFYtj596ZnuazVUYBVXh8MBreaLYpNNEU5fAJN':
      'solana.getTransaction.3JUKe-sweep.fixture.json',
  };
  return {
    async solana(method, params) {
      if (method === 'getSignaturesForAddress') {
        const [address, opts] = params as [string, { before?: string }];
        if (opts?.before) return [];
        const file = signatures[address];
        if (!file) throw new Error(`no recorded signatures for ${address}`);
        const list = fixture<{ result: { signature: string; blockTime: number }[] }>(file).result;
        // "Not seen yet" is the same real list as it stood before the refund block.
        return options.refundVisible ? list : list.filter((s) => s.blockTime * 1000 < REFUND_AT);
      }
      if (method === 'getTransaction') {
        const file = transactions[(params as [string])[0]];
        if (!file) throw new Error(`no recorded transaction ${(params as [string])[0]}`);
        return fixture<{ result: unknown }>(file).result;
      }
      throw new Error(`unrecorded Solana method ${method}`);
    },
    async evm() {
      throw new Error('no EVM read in this test');
    },
    async tron() {
      throw new Error('no Tron read in this test');
    },
  };
}

/** The production row for `7uNP`, as registered on 2026-09-03, with its quoted eta. */
function registerOwnerDeposit(db: DepositDb): string {
  db.register({
    depositAddress: DEPOSIT,
    recipient: '0x714f169fe2d3990961b534d573f9646c037586e6',
    sourceKey: 'sol-solana',
    chain: 'Solana',
    route: 'intents',
    refundTo: REFUND_TO,
    amountIn: '10000000',
    originDecimals: 9,
    originSymbol: 'SOL',
    expiresAt: 1788716944875,
    rail: 'near',
    etaSeconds: 24,
    now: 1788457655585,
  });
  db.markSourceLanded(DEPOSIT, 1788457736713);
  db.applySourceEvidence(DEPOSIT, { hash: DEPOSIT_TX, source: 'our-watcher-solana' }, 1788457736713);
  return DEPOSIT;
}

/** What the watcher writes for a 1Click payload, the same mapping `checkOne` uses. */
function applyOneClick(db: DepositDb, address: string, payload: OneClickPayload, at: number): void {
  const terminal = ['SUCCESS', 'REFUNDED', 'FAILED'].includes(payload.status);
  const hashes = payload.swapDetails?.originChainTxHashes ?? [];
  const refundTx = payload.status === 'REFUNDED' && hashes.length > 1 ? hashes.at(-1) : undefined;
  db.applyOneClickStatus(
    address,
    {
      status: payload.status,
      terminal,
      refundReason: payload.swapDetails?.refundReason ?? null,
      refundAmount: payload.swapDetails?.refundedAmount ?? null,
      refundTxHash: refundTx?.hash ?? null,
    },
    at,
  );
}

function stateOf(row: DepositAttemptRow, now: number): TrackerState {
  return deriveTrackerState(trackerInputFromRow(row, { now, explorerUrl: sourceTxExplorerUrl }));
}

function expectNoSpinner(state: TrackerState): void {
  expect(state.steps.filter((s) => s.status === 'active')).toEqual([]);
  expect(state.steps.filter((s) => s.slow)).toEqual([]);
}

async function applyChainRefund(db: DepositDb, address: string, readers: SourceChainReaders) {
  const row = db.attempt(address)!;
  const check = await detectSourceRefund(row, readers);
  if (check.status === 'found') {
    const f = check.finding;
    db.applyRefundEvidence(address, { hash: f.hash, source: f.source, amount: f.amount.toString(), from: f.from }, f.at);
  }
  return check;
}

describe('refund seen on the source chain before the vendor says REFUNDED', () => {
  it('ends the tracker as returned, with amount, hash, link, and then the vendor reason verbatim', async () => {
    const db = new DepositDb(':memory:');
    const address = registerOwnerDeposit(db);
    applyOneClick(db, address, fixture('oneclick.status.7uNP-PROCESSING.event4.fixture.json'), 1788457760743);

    const inFlight = stateOf(db.attempt(address)!, REFUND_AT - 1_000);
    expect(inFlight.terminal).toBeUndefined();
    expect(inFlight.steps.find((s) => s.id === 3)?.status).toBe('active');

    const check = await applyChainRefund(db, address, solanaReaders({ refundVisible: true }));
    expect(check.status).toBe('found');
    if (check.status !== 'found') return;
    expect(check.finding.hash).toBe(REFUND_TX);
    expect(check.finding.amount).toBe(9408387n);
    // Paid from the account the deposit was swept into, learned from the sweep itself.
    expect(check.finding.from).toBe('6tckHFBpiJ8YgYN8FUskvtvTpXQZ55g5LHeo1kvELoDQ');

    const row = db.attempt(address)!;
    expect(row.lastStatus).toBe('PROCESSING'); // the vendor still says so
    expect(row.terminalStatus).toBe('REFUNDED'); // and the chain says otherwise

    const returned = stateOf(row, REFUND_AT + 1_000);
    expect(returned.terminal?.kind).toBe('REFUNDED');
    expect(returned.terminal?.headline).toBe('Returned to your Solana address');
    expect(returned.terminal?.returned).toEqual({
      amount: '9408387',
      symbol: 'SOL',
      decimals: 9,
      chainName: 'Solana',
      seenBy: 'chain',
    });
    expect(returned.terminal?.refundTxHash).toBe(REFUND_TX);
    expect(returned.terminal?.refundExplorerUrl).toBe(`https://explorer.solana.com/tx/${REFUND_TX}`);
    expect(returned.terminal?.reasonFromVendor).toBe(false);
    expectNoSpinner(returned);
    // Still followed up: the vendor's reason is what is missing.
    expect(db.followUps(REFUND_AT + 1_000).map((r) => r.depositAddress)).toContain(address);

    applyOneClick(db, address, fixture('oneclick.status.7uNP-REFUNDED.event6.fixture.json'), 1788457784783);
    const withReason = stateOf(db.attempt(address)!, REFUND_AT + 2_000);
    expect(withReason.terminal?.reason).toBe('UNKNOWN');
    expect(withReason.terminal?.reasonFromVendor).toBe(true);
    expect(withReason.terminal?.refundTxHash).toBe(REFUND_TX);
    expect(db.followUps(REFUND_AT + 2_000)).toEqual([]);
  });
});

describe('vendor REFUNDED with no refund transaction yet', () => {
  it('ends the tracker as returned, says the transaction is not seen yet, and fills it in when it is', async () => {
    const db = new DepositDb(':memory:');
    const address = registerOwnerDeposit(db);
    // No real 1Click payload says REFUNDED without its refund hash: `event6` carries
    // both. This is `event6` with its second `originChainTxHashes` entry (the refund)
    // removed, and every other field as recorded.
    const recorded = fixture<OneClickPayload>('oneclick.status.7uNP-REFUNDED.event6.fixture.json');
    const withoutRefundTx: OneClickPayload = {
      ...recorded,
      swapDetails: { ...recorded.swapDetails, originChainTxHashes: recorded.swapDetails!.originChainTxHashes!.slice(0, 1) },
    };
    applyOneClick(db, address, withoutRefundTx, 1788457784783);

    const notSeen = await applyChainRefund(db, address, solanaReaders({ refundVisible: false }));
    expect(notSeen.status).toBe('none');
    const pending = stateOf(db.attempt(address)!, REFUND_AT);
    expect(pending.terminal?.kind).toBe('REFUNDED');
    expect(pending.terminal?.headline).toBe('Returned to your Solana address');
    expect(pending.terminal?.refundTxHash).toBeUndefined();
    expect(pending.terminal?.whereItWent).toContain('has not been seen on Solana yet');
    expect(pending.terminal?.returned).toMatchObject({ amount: '9408387', symbol: 'SOL', seenBy: 'vendor' });
    expect(pending.terminal?.reason).toBe('UNKNOWN');
    expectNoSpinner(pending);
    expect(db.followUps(REFUND_AT).map((r) => r.depositAddress)).toContain(address);

    const seen = await applyChainRefund(db, address, solanaReaders({ refundVisible: true }));
    expect(seen.status).toBe('found');
    const done = stateOf(db.attempt(address)!, REFUND_AT + 5_000);
    expect(done.terminal?.refundTxHash).toBe(REFUND_TX);
    expect(done.terminal?.returned?.seenBy).toBe('chain');
    expect(db.followUps(REFUND_AT + 5_000)).toEqual([]);
  });
});

describe('delivery seen on Monad while the vendor still says PROCESSING', () => {
  const BHJJ = 'BhJJtyzn8JpuJ6NyHVfUS9dubn9knc7fC5Pkem5qWWyF';

  it('ends the tracker as delivered, and no later vendor word or refund moves it', () => {
    const db = new DepositDb(':memory:');
    db.register({
      depositAddress: BHJJ,
      recipient: '0x714f169fe2d3990961b534d573f9646c037586e6',
      sourceKey: 'solana-sol',
      chain: 'Solana',
      route: 'near',
      refundTo: 'B5vbGugmip8NaqWxz6g2T4PyrX7eQ5eEjKNH3KEwJ9Hm',
      amountIn: '10000000',
      originDecimals: 9,
      originSymbol: 'SOL',
      expiresAt: 1790535036513,
      rail: 'near',
      outToken: 'USDC',
      quotedAmountOut: '1161990',
      now: 1790272237290,
    });
    const processing = fixture<OneClickPayload>('oneclick.status.BhJJ-PROCESSING.event282907.fixture.json');
    applyOneClick(db, BHJJ, processing, 1790272285700);
    db.applySourceEvidence(BHJJ, { hash: processing.swapDetails!.originChainTxHashes![0]!.hash, source: 'vendor:near' }, 1790272285700);
    // The production row's own destination evidence for this deposit.
    const written = db.applyDestinationEvidence(
      BHJJ,
      {
        hash: '0x319f81935824caa644d95f4e272e3f4185795070224b8a9c68c1ffc48a966980',
        block: '107671295',
        source: 'eth_getTransactionReceipt',
        amount: '1161990',
      },
      1790272290000,
    );
    expect(written).toBe(true);
    expect(db.attempt(BHJJ)?.terminalStatus).toBe('SUCCESS');
    expect(db.attempt(BHJJ)?.lastStatus).toBe('PROCESSING');

    const delivered = stateOf(db.attempt(BHJJ)!, 1790272291000);
    expect(delivered.terminal).toBeUndefined();
    expect(delivered.steps.find((s) => s.id === 4)?.status).toBe('done');
    expectNoSpinner(delivered);

    applyOneClick(db, BHJJ, processing, 1790272292000);
    expect(db.attempt(BHJJ)?.terminalStatus).toBe('SUCCESS');
    expect(
      db.applyRefundEvidence(BHJJ, { hash: 'unrelated', source: 'our-watcher-solana', amount: '1', from: 'x' }),
    ).toBe(false);
    expect(db.attempt(BHJJ)?.refundEvidenceHash).toBeNull();
  });
});

describe('expiry with nothing sent', () => {
  const DNFB = 'DnfBmMgvZdPiuCdU28fjRUdEtHjMHrYBr2dN9tB7SHUd';

  it('ends the tracker as expired at step 1, with nothing on the chain and the vendor still waiting', () => {
    const sigs = fixture<{ result: unknown[] }>('solana.getSignaturesForAddress.DnfBm-deposit.fixture.json');
    expect(sigs.result).toEqual([]);
    const vendor = fixture<{ status: string; quoteResponse: { quote: { deadline: string } } }>(
      'oneclick.status.DnfBm-PENDING_DEPOSIT.fixture.json',
    );
    expect(vendor.status).toBe('PENDING_DEPOSIT');

    const db = new DepositDb(':memory:');
    db.register({
      depositAddress: DNFB,
      recipient: '0x714f169fe2d3990961b534d573f9646c037586e6',
      sourceKey: 'sol-solana',
      chain: 'Solana',
      route: 'intents',
      refundTo: '2nMNRRRHSngPjiB1W8u8Ba9SUmuDbDBy8EyNyd99KNwp',
      amountIn: '12000000000',
      originDecimals: 9,
      originSymbol: 'SOL',
      expiresAt: Date.parse(vendor.quoteResponse.quote.deadline),
      rail: 'near',
      now: 1788938531723,
    });
    applyOneClick(db, DNFB, vendor, Date.parse('2026-09-29T12:00:00Z'));
    const state = stateOf(db.attempt(DNFB)!, Date.parse('2026-09-29T12:00:00Z'));
    expect(state.terminal?.kind).toBe('EXPIRED');
    expect(state.terminal?.atStep).toBe(1);
    expect(state.terminal?.headline).toBe('Expired, nothing was sent');
    expectNoSpinner(state);
  });

  it('a failed transaction to the address is not a deposit', async () => {
    const recorded = fixture('solana.getSignaturesForAddress.E1J8-deposit-failed-only.fixture.json');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(recorded), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await solanaLanded('E1J8wdP1Cz6Z3o2Jf94spSWnaLeUmehM19CEdBAottCY')).toEqual({ landed: false });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });
});

describe('a state never regresses', () => {
  it('a returned deposit stays returned whatever the vendor says next', async () => {
    const db = new DepositDb(':memory:');
    const address = registerOwnerDeposit(db);
    await applyChainRefund(db, address, solanaReaders({ refundVisible: true }));
    for (const status of ['PENDING_DEPOSIT', 'PROCESSING', 'SUCCESS', 'FAILED']) {
      db.applyOneClickStatus(address, { status, terminal: ['SUCCESS', 'FAILED'].includes(status) }, REFUND_AT + 10_000);
      expect(db.attempt(address)?.terminalStatus, status).toBe('REFUNDED');
    }
    expect(
      db.applyDestinationEvidence(address, { hash: '0xlate', block: '1', source: 'balance-poll' }),
    ).toBe(false);
    const state = stateOf(db.attempt(address)!, REFUND_AT + 20_000);
    expect(state.terminal?.kind).toBe('REFUNDED');
    expect(state.terminal?.refundTxHash).toBe(REFUND_TX);
  });

  it('first refund evidence wins, and a hash already on another row is recognised as claimed', async () => {
    const db = new DepositDb(':memory:');
    const address = registerOwnerDeposit(db);
    await applyChainRefund(db, address, solanaReaders({ refundVisible: true }));
    db.applyRefundEvidence(address, { hash: 'second', source: 'our-watcher-solana', amount: '1', from: 'y' });
    expect(db.attempt(address)?.refundEvidenceHash).toBe(REFUND_TX);
    expect(db.attempt(address)?.refundEvidenceAmount).toBe('9408387');
    expect(db.refundHashClaimedByOther(REFUND_TX, 'some-other-row')).toBe(true);
    expect(db.refundHashClaimedByOther(REFUND_TX, address)).toBe(false);
  });

  it('FAILED may become REFUNDED once money is seen coming back, never the other way', async () => {
    const db = new DepositDb(':memory:');
    const address = registerOwnerDeposit(db);
    db.applyOneClickStatus(address, { status: 'FAILED', terminal: true }, REFUND_AT - 5_000);
    await applyChainRefund(db, address, solanaReaders({ refundVisible: true }));
    expect(db.attempt(address)?.terminalStatus).toBe('REFUNDED');
    db.applyOneClickStatus(address, { status: 'FAILED', terminal: true }, REFUND_AT + 5_000);
    expect(db.attempt(address)?.terminalStatus).toBe('REFUNDED');
  });
});

describe('the tracker never spins after a terminal state', () => {
  it('no active step and no slow message on any outcome, long after the eta', async () => {
    const db = new DepositDb(':memory:');
    const address = registerOwnerDeposit(db);
    const farLater = REFUND_AT + 24 * 60 * 60 * 1000;

    // In flight and three times past its 24-second eta: slow, stated, and re-checked once.
    applyOneClick(db, address, fixture('oneclick.status.7uNP-PROCESSING.event4.fixture.json'), 1788457760743);
    const slowAt = 1788457760743 + 5 * 60_000;
    const slow = stateOf(db.attempt(address)!, slowAt);
    const step3 = slow.steps.find((s) => s.id === 3)!;
    expect(step3.status).toBe('active');
    expect(step3.slow?.message).toBe('Taking longer than usual, 5 minutes so far');
    expect(slowNeedsRecheck(db.attempt(address)!, slowAt)).toBe(true);
    db.markSlowRecheck(address, slowAt);
    expect(slowNeedsRecheck(db.attempt(address)!, slowAt + 1_000)).toBe(false);

    await applyChainRefund(db, address, solanaReaders({ refundVisible: true }));
    const returned = stateOf(db.attempt(address)!, farLater);
    expect(returned.terminal?.kind).toBe('REFUNDED');
    expectNoSpinner(returned);
    expect(slowNeedsRecheck(db.attempt(address)!, farLater)).toBe(false);

    const { refundEvidence: _dropped, ...withoutRefund } = trackerInputFromRow(db.attempt(address)!, { now: farLater });
    const failed = deriveTrackerState({ ...withoutRefund, vendorTerminalStatus: 'FAILED' });
    expect(failed.terminal?.kind).toBe('FAILED');
    expectNoSpinner(failed);
  });
});

describe('source-chain shapes', () => {
  it('reads a real TronGrid TRC-20 transfer list', () => {
    const body = fixture<{ data: TronTransfer[] }>('tron.trc20-transactions.TR7N-only_to.fixture.json');
    const first = body.data[0]!;
    const found = findTronRefund({
      depositAddress: first.from,
      refundTo: first.to,
      token: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      outOfDeposit: [],
      intoRefundTo: body.data,
      notBeforeMs: first.block_timestamp,
      reference: BigInt(first.value),
    });
    expect(found?.hash).toBe(first.transaction_id);
    expect(found?.amount).toBe(BigInt(first.value));
  });

  it('a refund is between half and one and a half times what was sent', () => {
    expect(refundAmountPlausible(9408387n, 10000000n)).toBe(true);
    expect(refundAmountPlausible(4_000_000n, 10000000n)).toBe(false);
    expect(refundAmountPlausible(16_000_000n, 10000000n)).toBe(false);
    expect(refundAmountPlausible(0n, 10000000n)).toBe(false);
  });

  it('builds refund links only on verified explorers', () => {
    expect(sourceTxExplorerUrl('Solana', REFUND_TX)).toBe(`https://explorer.solana.com/tx/${REFUND_TX}`);
    expect(sourceTxExplorerUrl('Base', `0x${'ab'.repeat(32)}`)).toBe(`https://basescan.org/tx/0x${'ab'.repeat(32)}`);
    expect(sourceTxExplorerUrl('Bitcoin', 'abc')).toBeUndefined();
    expect(sourceTxExplorerUrl('Solana', 'javascript:alert(1)')).toBeUndefined();
  });
});
