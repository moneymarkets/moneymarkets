import { describe, expect, it } from 'vitest';
import type { Address, PublicClient } from 'viem';
import { deriveTrackerState, trackerInputFromRow } from '@tradepro/core';
import { DepositDb } from './db';
import { acceptsArrival, settleArrivals, type Arrival } from './arrival';

/**
 * The owner's rule (2026-09-30): a transfer that arrives on Monad and matches an open
 * deposit by token and time window completes it at once, whatever the vendor says.
 *
 * Every chain fact below is recorded from Monad mainnet: the owner's 0.01 SOL deposit
 * `TTmr6f2...` was delivered as 1,190,830 USDC base units by 1Click's Monad sender
 * `0x233c5370...` in `0xf243398b...23af7`, block 109,026,214, 2026-09-29 11:37:54 UTC,
 * and the tracker showed "Bridging to Monad" until 13:03. `2fVhp7da...` is the address
 * issued eight seconds earlier for the same payment, never paid.
 */
const OWNER = '0x714f169fe2d3990961b534d573f9646c037586e6';
const USDC = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603' as Address;
const MARGIN = '0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5' as Address;
const SENDER = '0x233c5370ccfb3cd7409d9a3fb98ab94de94cb4cd' as Address;
const HASH = '0xf243398b2fab7a2a82c95c99b472c11d1b7fc4700e4f2ff44d41d588c3023af7';
const BLOCK = 109_026_214n;
const ARRIVED_MS = Date.parse('2026-09-29T11:37:54Z');
const TTMR = 'TTmr6f2JnpqJDErBsKGHDwTQANptEuxCrHRBAxoGDXk';
const TWIN = '2fVhp7daqC6bHvFjHGFUf8q3xVzjE9FCU5tkvUGCDChb';
const ISSUED_BLOCK = 109_025_880n;

interface FakeLog {
  address: Address;
  from: Address;
  to: string;
  value: bigint;
  block: bigint;
  hash: string;
}

/** Monad, as far as the scan asks: the head, block times, and Transfer logs by range. */
function chain(logs: FakeLog[], head = BLOCK + 20n): PublicClient {
  // ~0.4 s blocks around the recorded arrival.
  const timeOf = (b: bigint) => ARRIVED_MS + Number(b - BLOCK) * 400;
  return {
    getBlockNumber: async () => head,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: BigInt(Math.floor(timeOf(blockNumber) / 1000)) }),
    getLogs: async (q: { address: Address; args?: { to?: string }; fromBlock: bigint; toBlock: bigint }) =>
      logs
        .filter(
          (l) =>
            l.address.toLowerCase() === q.address.toLowerCase() &&
            (!q.args?.to || l.to.toLowerCase() === q.args.to.toLowerCase()) &&
            l.block >= q.fromBlock &&
            l.block <= q.toBlock,
        )
        .map((l) => ({ args: { from: l.from, to: l.to, value: l.value }, blockNumber: l.block, transactionHash: l.hash, address: l.address })),
  } as unknown as PublicClient;
}

const delivery: FakeLog = { address: USDC, from: SENDER, to: OWNER, value: 1_190_830n, block: BLOCK, hash: HASH };

function register(
  db: DepositDb,
  address: string,
  createdAt: number,
  opts: { quoted?: string; outToken?: string; refundTo?: string } = {},
) {
  db.register({
    depositAddress: address,
    recipient: OWNER,
    sourceKey: 'solana-sol',
    chain: 'Solana',
    route: 'near',
    refundTo: opts.refundTo ?? 'CFMGosQQehGZkaAPaQhGkkmqNyabZcnCHLyfrg4E9M31',
    amountIn: '10000000',
    originDecimals: 9,
    originSymbol: 'SOL',
    expiresAt: createdAt + 3 * 24 * 60 * 60 * 1000,
    rail: 'near',
    etaSeconds: 24,
    ...(opts.outToken === undefined ? { outToken: 'USDC' } : opts.outToken ? { outToken: opts.outToken } : {}),
    landsIn: 'wallet',
    ...(opts.quoted ? { quotedAmountOut: opts.quoted } : {}),
    now: createdAt,
  });
  db.setDestScanFrom(address, ISSUED_BLOCK);
}

const deps = (now: number) => ({ resolveToken: (s: string) => (s === 'USDC' ? USDC : undefined), marginAccount: MARGIN, now });

describe('chain evidence on Monad completes a deposit, whatever the vendor says', () => {
  it('vendor still PROCESSING and the Monad transfer present: delivered within one poll, with the Monad hash', async () => {
    const db = new DepositDb(':memory:');
    register(db, TTMR, ARRIVED_MS - 138_000, { quoted: '1193941' });
    db.applyRailStatus(TTMR, { status: 'PROCESSING', terminal: false }, ARRIVED_MS - 60_000);
    db.applySourceEvidence(TTMR, { hash: '2pPsRJgLetEi47AKNpnrKnRGSYDUNeHW3Ju9FzDEzFBfJEMPZyNDTFECErnjJ9zHzev3mnz9Zos7tVmHFpwAG2Vi', source: 'vendor:near' });

    const done = await settleArrivals(db, chain([delivery]), deps(ARRIVED_MS + 3_000));

    expect(done).toEqual([{ depositAddress: TTMR, hash: HASH }]);
    const row = db.attempt(TTMR)!;
    expect(row.destinationTxHash).toBe(HASH);
    expect(row.destinationTxBlock).toBe(BLOCK.toString());
    expect(row.amountOut).toBe('1190830');
    expect(row.terminalStatus).toBe('SUCCESS');
    expect(row.lastStatus).toBe('PROCESSING'); // the vendor's word is kept, and lost
    // What the screen derives: delivered, nothing left spinning, the Monad hash on step 4.
    const state = deriveTrackerState(trackerInputFromRow(row as never, { now: ARRIVED_MS + 3_000, outToken: 'USDC', landsIn: 'wallet', etaSeconds: 24 }));
    expect(state.terminal).toBeUndefined();
    expect(state.steps.some((s) => s.status === 'active')).toBe(false);
    const step4 = state.steps.find((s) => s.id === 4)!;
    expect(step4.status).toBe('done');
    expect(step4.evidence?.hash).toBe(HASH);
  });

  it('completes even with the vendor still waiting and no source-chain read at all', async () => {
    const db = new DepositDb(':memory:');
    register(db, TTMR, ARRIVED_MS - 138_000, { quoted: '1193941' });
    await settleArrivals(db, chain([delivery]), deps(ARRIVED_MS + 3_000));
    expect(db.attempt(TTMR)!.destinationTxHash).toBe(HASH);
  });

  it('the address issued seconds earlier for the same payment does not take it: the paid row does', async () => {
    const db = new DepositDb(':memory:');
    register(db, TWIN, ARRIVED_MS - 146_500, { quoted: '1192945' });
    register(db, TTMR, ARRIVED_MS - 138_000, { quoted: '1193941' });
    db.applySourceEvidence(TTMR, { hash: 'vendor-source', source: 'vendor:near' });
    await settleArrivals(db, chain([delivery]), deps(ARRIVED_MS + 3_000));
    expect(db.attempt(TTMR)!.destinationTxHash).toBe(HASH);
    expect(db.attempt(TWIN)!.destinationTxHash).toBeNull();
    // And a second poll does not hand the same hash to the twin.
    await settleArrivals(db, chain([delivery]), deps(ARRIVED_MS + 6_000));
    expect(db.attempt(TWIN)!.destinationTxHash).toBeNull();
  });

  it('a row with no quote matches by token and time window alone', async () => {
    const db = new DepositDb(':memory:');
    register(db, TTMR, ARRIVED_MS - 138_000);
    await settleArrivals(db, chain([delivery]), deps(ARRIVED_MS + 3_000));
    expect(db.attempt(TTMR)!.destinationTxHash).toBe(HASH);
  });

  it('an arrival found late, far behind the head, is still found: the scan reads from the row cursor, not the head', async () => {
    const db = new DepositDb(':memory:');
    register(db, TTMR, ARRIVED_MS - 138_000, { quoted: '1193941' });
    // Two hours later: 18,000 blocks past the arrival, far outside the old 400-block look-back.
    const head = BLOCK + 18_000n;
    const polls = [];
    for (let i = 0; i < 5 && !db.attempt(TTMR)!.destinationTxHash; i += 1) {
      polls.push(await settleArrivals(db, chain([delivery], head), deps(ARRIVED_MS + 7_200_000)));
    }
    expect(db.attempt(TTMR)!.destinationTxHash).toBe(HASH);
  });

  it('is not fooled: zero value, a MarginAccount withdrawal, the recipient itself, the wrong token, outside the window', () => {
    const db = new DepositDb(':memory:');
    register(db, TTMR, ARRIVED_MS - 138_000);
    const row = db.attempt(TTMR)!;
    const base: Arrival = { hash: HASH, block: BLOCK, amount: 1_190_830n, from: SENDER, atMs: ARRIVED_MS };
    const ctx = { marginAccount: MARGIN, others: db.allRows() };
    expect(acceptsArrival(row, base, ctx)).toBe(true);
    expect(acceptsArrival(row, { ...base, amount: 0n }, ctx)).toBe(false);
    expect(acceptsArrival(row, { ...base, from: MARGIN }, ctx)).toBe(false);
    expect(acceptsArrival(row, { ...base, from: OWNER as Address }, ctx)).toBe(false);
    expect(acceptsArrival(row, { ...base, atMs: row.createdAt - 1 }, ctx)).toBe(false);
    expect(acceptsArrival(row, { ...base, atMs: row.expiresAt + 25 * 60 * 60 * 1000 }, ctx)).toBe(false);
  });

  it('a quoted row refuses a transfer of a very different size', () => {
    const db = new DepositDb(':memory:');
    register(db, TTMR, ARRIVED_MS - 138_000, { quoted: '1193941' });
    const row = db.attempt(TTMR)!;
    const arrival: Arrival = { hash: HASH, block: BLOCK, amount: 5_000n, from: SENDER, atMs: ARRIVED_MS };
    expect(acceptsArrival(row, arrival, { marginAccount: MARGIN, others: db.allRows() })).toBe(false);
  });

  it('a returned deposit is never turned into a delivered one', async () => {
    const db = new DepositDb(':memory:');
    register(db, TTMR, ARRIVED_MS - 138_000);
    db.applyRailStatus(TTMR, { status: 'REFUNDED', terminal: true }, ARRIVED_MS - 1_000);
    await settleArrivals(db, chain([delivery]), deps(ARRIVED_MS + 3_000));
    expect(db.attempt(TTMR)!.destinationTxHash).toBeNull();
    expect(db.attempt(TTMR)!.terminalStatus).toBe('REFUNDED');
  });

  it('matches by deposit address, not by who typed the sender field — a deposit sent from a wallet other than the declared one is still credited (D202)', async () => {
    // The incident this encodes (2026-10-08): NEAR Intents deposit AmRKSc6... was paid
    // from a Solana wallet other than the one typed into the "sender" field. The money
    // arrived; `refundTo` is this app's record of what was typed, and it is never read
    // by `acceptsArrival` or `settleArrivals` — only the deposit address, the token and
    // the time window are. A row registered with a `refundTo` nothing like the real
    // payer still gets matched and marked delivered.
    const db = new DepositDb(':memory:');
    register(db, TTMR, ARRIVED_MS - 138_000, { quoted: '1193941', refundTo: 'NotTheWalletThatActuallyPaidXXXXXXXXXXXXXXX' });
    const done = await settleArrivals(db, chain([delivery]), deps(ARRIVED_MS + 3_000));
    expect(done).toEqual([{ depositAddress: TTMR, hash: HASH }]);
    const row = db.attempt(TTMR)!;
    expect(row.destinationTxHash).toBe(HASH);
    expect(row.terminalStatus).toBe('SUCCESS');
    // And the row's own declared sender is left exactly as typed — nothing here
    // rewrites it to match whoever actually paid.
    expect(row.refundTo).toBe('NotTheWalletThatActuallyPaidXXXXXXXXXXXXXXX');
  });

  it('a row with no token on record is left alone rather than matched on a guess', async () => {
    const db = new DepositDb(':memory:');
    register(db, TTMR, ARRIVED_MS - 138_000, { outToken: '' });
    const done = await settleArrivals(db, chain([delivery]), deps(ARRIVED_MS + 3_000));
    expect(done).toEqual([]);
  });
});
