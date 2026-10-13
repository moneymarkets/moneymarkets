import { getAddress, parseAbiItem, type Address, type PublicClient } from 'viem';
import { PUBLIC_RPC_GET_LOGS_MAX_RANGE } from '@tradepro/core';
import type { DepositAttemptRow, DepositDb } from './db';
import { withinTolerance } from './destination';

/**
 * Chain evidence on Monad completes a deposit (owner rule, 2026-09-30): when a transfer
 * arrives on Monad that matches an open deposit by token and time window, the deposit
 * completes at once as "In your wallet" with that Monad hash, whatever the vendor says.
 *
 * Why this exists. The tracker missed deliveries that were already in the wallet:
 *   - the scan it had (`findIncomingTransfer`) read only the latest 4 x 100 blocks
 *     behind the head, about 160 seconds, so an arrival not looked at in that window was
 *     never found by scanning again;
 *   - it ran only for a row with source-chain evidence and a quoted amount, so a row
 *     whose vendor was behind, or an older row with no quote, never matched;
 *   - a vendor SUCCESS took the row out of the watch before Monad confirmed it
 *     (`TTmr6f2...`, 2026-09-29: in the wallet at 11:37:54, shown as "Bridging to
 *     Monad" until 13:03).
 *
 * Here each open row carries a cursor (`dest_scan_from`) from the Monad block it was
 * issued at, forward, and every poll reads the recipient's arrivals of the row's own
 * token from the cursor to the head, in the public RPC's 100-block pieces.
 *
 * What "matches" means, all of it checked from the chain:
 *   - the row's own `out_token`, sent TO the recipient (a wallet `Transfer`), or, for a
 *     margin-landing row, MarginAccount's own `Deposit` naming the recipient;
 *   - inside the row's window: from the block it was issued at to its expiry plus
 *     `ARRIVAL_GRACE_MS` (a vendor may deliver after the address closed);
 *   - a real amount: not zero, not from MarginAccount (a withdrawal reads as an arrival),
 *     not from the recipient itself; and within 0.5x to 1.5x of the quote when the row
 *     has one (security review H1), token and window alone when it has none;
 *   - a hash no other row has claimed, and, for a row with no source-chain evidence of
 *     its own, not while a sibling row for the same recipient and token HAS such
 *     evidence (two addresses issued seconds apart for one payment: the paid one gets it).
 */

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const MARGIN_DEPOSIT = parseAbiItem('event Deposit(address owner, address token, uint256 amount)');

/** A vendor may deliver after the deposit address expired, if the money reached it in time. */
export const ARRIVAL_GRACE_MS = 24 * 60 * 60 * 1000;
/** Pieces of 100 blocks read per row per poll: a fresh row needs one, a catch-up is spread. */
export const ARRIVAL_CHUNKS_PER_POLL = 50;
/** The watcher leaves rows whose window closed longer ago than this to the reconcile script. */
export const ARRIVAL_WATCH_AFTER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface ArrivalDeps {
  readonly resolveToken: (symbol: string) => Address | undefined;
  readonly marginAccount: Address | undefined;
  readonly now: number;
  readonly chunksPerPoll?: number;
  /** Rows to consider; default every open row the watcher sees. */
  readonly rows?: readonly DepositAttemptRow[];
  /** Include rows whose window closed long ago (the reconcile script). */
  readonly includeOld?: boolean;
  readonly publish?: (row: DepositAttemptRow, arrival: Arrival) => void;
}

export interface Arrival {
  readonly hash: string;
  readonly block: bigint;
  readonly amount: bigint;
  readonly from: Address;
  readonly atMs: number;
}

/** Can this row still be completed by an arrival on Monad? */
export function openForArrival(row: DepositAttemptRow): boolean {
  if (row.rail === 'cctp') return false; // its destination is this app's own mint
  if (row.destinationTxHash) return false;
  if (row.terminalStatus === 'REFUNDED' || row.terminalStatus === 'FAILED') return false;
  if (row.refundEvidenceHash) return false;
  if (!row.outToken) return false; // no token on record: nothing to match by
  return true;
}

export function windowEndMs(row: DepositAttemptRow): number {
  return row.expiresAt + ARRIVAL_GRACE_MS;
}

function hasSourceEvidence(row: DepositAttemptRow): boolean {
  return Boolean(row.sourceTxHash || row.sourceLandedAt);
}

/**
 * Whether `arrival` completes `row`. Pure: every chain fact is already in `arrival`,
 * every other row's state in `others`.
 */
export function acceptsArrival(
  row: DepositAttemptRow,
  arrival: Arrival,
  ctx: { readonly marginAccount: Address | undefined; readonly others: readonly DepositAttemptRow[] },
): boolean {
  if (!openForArrival(row)) return false;
  if (arrival.amount <= 0n) return false;
  if (arrival.atMs < row.createdAt || arrival.atMs > windowEndMs(row)) return false;
  const from = arrival.from.toLowerCase();
  if (from === row.recipient.toLowerCase()) return false;
  if (row.landsIn !== 'margin' && ctx.marginAccount && from === ctx.marginAccount.toLowerCase()) return false;
  if (row.quotedAmountOut && !withinTolerance(arrival.amount, BigInt(row.quotedAmountOut))) return false;
  const hash = arrival.hash.toLowerCase();
  if (ctx.others.some((o) => o.depositAddress !== row.depositAddress && o.destinationTxHash?.toLowerCase() === hash)) {
    return false;
  }
  if (!hasSourceEvidence(row)) {
    const pairedSibling = ctx.others.some(
      (o) =>
        o.depositAddress !== row.depositAddress &&
        o.recipient.toLowerCase() === row.recipient.toLowerCase() &&
        o.outToken === row.outToken &&
        (o.landsIn ?? 'wallet') === (row.landsIn ?? 'wallet') &&
        hasSourceEvidence(o) &&
        (!o.destinationTxHash || o.destinationTxHash.toLowerCase() === hash) &&
        o.terminalStatus !== 'REFUNDED' &&
        o.terminalStatus !== 'FAILED' &&
        arrival.atMs >= o.createdAt &&
        arrival.atMs <= windowEndMs(o),
    );
    if (pairedSibling) return false;
  }
  return true;
}

const blockTimeCache = new Map<bigint, number>();

async function blockTimeMs(client: PublicClient, block: bigint): Promise<number> {
  const cached = blockTimeCache.get(block);
  if (cached !== undefined) return cached;
  const b = await client.getBlock({ blockNumber: block });
  const ms = Number(b.timestamp) * 1000;
  if (blockTimeCache.size > 5000) blockTimeCache.clear();
  blockTimeCache.set(block, ms);
  return ms;
}

/** The last block at or before `atMs`, by binary search over block timestamps. */
export async function blockAtOrBefore(client: PublicClient, atMs: number, head: bigint): Promise<bigint> {
  let lo = 0n;
  let hi = head;
  if ((await blockTimeMs(client, head)) <= atMs) return head;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if ((await blockTimeMs(client, mid)) <= atMs) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

async function arrivalsIn(
  client: PublicClient,
  row: DepositAttemptRow,
  token: Address,
  marginAccount: Address | undefined,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<Arrival[]> {
  const recipient = getAddress(row.recipient);
  if (row.landsIn === 'margin') {
    if (!marginAccount) return [];
    const logs = await client.getLogs({ address: marginAccount, event: MARGIN_DEPOSIT, fromBlock, toBlock });
    const out: Arrival[] = [];
    for (const log of logs) {
      const a = log.args as { owner?: Address; token?: Address; amount?: bigint };
      if (a.owner?.toLowerCase() !== recipient.toLowerCase() || a.token?.toLowerCase() !== token.toLowerCase()) continue;
      if (!log.transactionHash || log.blockNumber === null) continue;
      out.push({
        hash: log.transactionHash,
        block: log.blockNumber,
        amount: a.amount ?? 0n,
        from: log.address,
        atMs: await blockTimeMs(client, log.blockNumber),
      });
    }
    return out;
  }
  const logs = await client.getLogs({ address: token, event: TRANSFER, args: { to: recipient }, fromBlock, toBlock });
  const out: Arrival[] = [];
  for (const log of logs) {
    const a = log.args as { from?: Address; value?: bigint };
    if (!log.transactionHash || log.blockNumber === null || !a.from) continue;
    out.push({
      hash: log.transactionHash,
      block: log.blockNumber,
      amount: a.value ?? 0n,
      from: a.from,
      atMs: await blockTimeMs(client, log.blockNumber),
    });
  }
  return out;
}

/**
 * One poll: for every open row, read its arrivals from its cursor forward and complete
 * it on the first that matches. Returns the rows completed, for logging and tests.
 */
export async function settleArrivals(
  db: DepositDb,
  client: PublicClient,
  deps: ArrivalDeps,
): Promise<{ depositAddress: string; hash: string }[]> {
  const rows = (deps.rows ?? [...db.active(), ...db.followUps(deps.now)]).filter(openForArrival);
  const candidates = rows.filter(
    // A stuck row is read until a chain shows its outcome, however long that takes.
    (r) => deps.includeOld || r.stuckAt !== null || deps.now - windowEndMs(r) < ARRIVAL_WATCH_AFTER_WINDOW_MS,
  );
  if (candidates.length === 0) return [];
  // Rows with source evidence first: when two could take one arrival, the paid one does.
  candidates.sort((a, b) => Number(hasSourceEvidence(b)) - Number(hasSourceEvidence(a)) || a.createdAt - b.createdAt);
  const head = await client.getBlockNumber();
  const span = PUBLIC_RPC_GET_LOGS_MAX_RANGE;
  const perPoll = BigInt(deps.chunksPerPoll ?? ARRIVAL_CHUNKS_PER_POLL);
  const completed: { depositAddress: string; hash: string }[] = [];

  for (const stale of candidates) {
    const row = db.attempt(stale.depositAddress) ?? stale;
    if (!openForArrival(row)) continue;
    const token = deps.resolveToken(row.outToken!);
    if (!token) continue;
    let from = row.destScanFrom !== null ? BigInt(row.destScanFrom) : await blockAtOrBefore(client, row.createdAt, head);
    const end = deps.now > windowEndMs(row) ? await blockAtOrBefore(client, windowEndMs(row), head) : head;
    const stop = from + perPoll * span - 1n < end ? from + perPoll * span - 1n : end;
    let done = false;
    while (from <= stop && !done) {
      const to = from + span - 1n < stop ? from + span - 1n : stop;
      const arrivals = await arrivalsIn(client, row, token, deps.marginAccount, from, to);
      const others = db.allRows();
      for (const arrival of arrivals) {
        if (!acceptsArrival(row, arrival, { marginAccount: deps.marginAccount, others })) continue;
        const at = Date.now();
        const written = db.applyDestinationEvidence(
          row.depositAddress,
          { hash: arrival.hash, block: arrival.block.toString(), source: 'monad-arrival-scan', amount: arrival.amount.toString() },
          at,
        );
        if (!written) continue;
        db.recordEvent(row.depositAddress, 'DESTINATION_DETECTED', 'monad-arrival-scan', {
          hash: arrival.hash,
          block: arrival.block.toString(),
          amount: arrival.amount.toString(),
          from: arrival.from,
          vendorStatus: row.lastStatus,
        }, at);
        deps.publish?.(row, arrival);
        completed.push({ depositAddress: row.depositAddress, hash: arrival.hash });
        done = true;
        break;
      }
      from = to + 1n;
    }
    db.setDestScanFrom(row.depositAddress, from);
  }
  return completed;
}
