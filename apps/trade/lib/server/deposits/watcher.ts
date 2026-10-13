import { getAddress, type Address } from 'viem';
import {
  CCTP_DOMAINS,
  asSwapStatus,
  isSlow,
  isTerminalSwapStatus,
  marginAccountAbi,
  oneClickStatusSchema,
  statusUrl,
} from '@tradepro/core';
import { depositDb, type DepositAttemptRow } from './db';
import { publishDepositTransition } from './bus';
import { baseBlockNumber, solanaLanded, sourceBalance, tronLanded } from './chains';
import { detectDestination } from './destination';
import { settleArrivals } from './arrival';
import { evaluateStuck } from './stuck';
import { recoverStuck } from './recovery';
import { detectSourceRefund, evmLanded, resolveSourceAsset } from './refund';
import { refundTxFrom, relayMapped } from './vendorStatus';
import { resolveSources } from '../aurora';
import { addresses, readClient } from '../chain';

/**
 * The watcher itself (spec: D105, "deposit tracking must be real-time... without
 * anyone polling by hand").
 *
 * Two things run on the same three-second tick, for every address that has not yet
 * reached a terminal 1Click status:
 *
 *   1. a direct read of the origin chain — Solana, Base or Tron — for whether
 *      anything has landed yet, independent of 1Click's own detection;
 *   2. a read of 1Click's own `/v0/status`.
 *
 * Both write straight to `deposit_events` and `deposit_attempts`, and a genuine
 * change publishes to `bus.ts` for `/api/fund/stream` to forward. A poll that finds
 * nothing new writes nothing and publishes nothing — the events table is a record of
 * transitions, not a log of every question asked.
 *
 * `ausd-base` (the OFT/LayerZero route) is **not watched here**. It is not a 1Click
 * swap at all — a different bridge, a different status model — and pretending to
 * cover it with this loop would be exactly the kind of guess A2.5 forbids. It stays
 * MISSING until it gets its own watcher.
 */

const TICK_MS = 3_000;

let timer: NodeJS.Timeout | undefined;
/** One in-flight tick at a time — a slow chain RPC must not stack ticks. */
let ticking = false;

export function startDepositWatcher(): void {
  if (timer) return;
  timer = setInterval(() => {
    void tick();
  }, TICK_MS);
  timer.unref?.();
  console.log('[deposit-watcher] started, 3s tick');
}

export function stopDepositWatcher(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}

export interface RegisterDepositInput {
  readonly depositAddress: string;
  readonly recipient: string;
  readonly sourceKey: string;
  readonly chain: string;
  readonly route: string;
  readonly refundTo: string;
  readonly amountIn: string;
  readonly amountInUsd?: string;
  readonly originDecimals: number;
  readonly originSymbol: string;
  readonly expiresAt: number;
  readonly tokenContract?: string;
  /** Which rail issued this address — decides whose status endpoint the tick polls. */
  readonly rail?: string;
  /** The key that rail answers on: Relay's requestId, 1Click's deposit address. */
  readonly railRef?: string;
  /** Source chain id, for rails followed up per-chain (CCTP's Iris domain). */
  readonly sourceChainId?: number;
  /** The vendor's quoted delivery time, seconds — drives the tracker's slow-state message. */
  readonly etaSeconds?: number;
  /** What this deposit delivers on Monad — resolves the token the destination watch scans for. */
  readonly outToken?: string;
  /** Where the rail delivers — 'wallet' | 'margin'. Decides how step 4's destination proof is found. */
  readonly landsIn?: 'wallet' | 'margin';
  /**
   * What this deposit was quoted to deliver, in `out_token` base units — the
   * amount-tolerance check's own reference (security review finding H1). Without it,
   * `checkDestination` cannot tell this deposit's own arrival apart from any other
   * transfer of the same token to the same recipient, and skips automatic detection.
   */
  readonly quotedAmountOut?: string;
}

/** Contract addresses for the Base/Tron watchers, keyed by deposit address. Not persisted — re-derivable from `resolveSources()` at any time, and only the active set needs it. */
const contractByAddress = new Map<string, string>();
const startBlockByAddress = new Map<string, bigint>();

export async function registerDeposit(input: RegisterDepositInput): Promise<void> {
  depositDb().register({
    depositAddress: input.depositAddress,
    recipient: input.recipient,
    sourceKey: input.sourceKey,
    chain: input.chain,
    route: input.route,
    refundTo: input.refundTo,
    amountIn: input.amountIn,
    ...(input.amountInUsd ? { amountInUsd: input.amountInUsd } : {}),
    originDecimals: input.originDecimals,
    originSymbol: input.originSymbol,
    expiresAt: input.expiresAt,
    ...(input.rail ? { rail: input.rail } : {}),
    ...(input.railRef ? { railRef: input.railRef } : {}),
    ...(input.sourceChainId !== undefined ? { sourceChainId: input.sourceChainId } : {}),
    ...(input.etaSeconds !== undefined ? { etaSeconds: input.etaSeconds } : {}),
    ...(input.outToken ? { outToken: input.outToken } : {}),
    ...(input.landsIn ? { landsIn: input.landsIn } : {}),
    ...(input.quotedAmountOut ? { quotedAmountOut: input.quotedAmountOut } : {}),
  });
  if (input.tokenContract) contractByAddress.set(input.depositAddress, input.tokenContract);
  if (input.chain === 'Base') {
    try {
      startBlockByAddress.set(input.depositAddress, await baseBlockNumber());
    } catch (error) {
      console.error('[deposit-watcher] could not read the starting Base block', error);
    }
  }
  // Best-effort and never blocks registration: a failed read here just means the
  // terminal card shows "after" without a "before" to compare it to.
  void sourceBalance(input.chain, input.refundTo, input.tokenContract)
    .then((balance) => depositDb().setRefundBalanceBefore(input.depositAddress, balance.toString()))
    .catch((error: unknown) => {
      console.error('[deposit-watcher] could not read the refund wallet balance before', error);
    });
  // Step 5's "before", same best-effort discipline — captured now, before anything has
  // arrived, so a page opened after the money already landed still has a real baseline
  // to compare against rather than only the client's own first read.
  if (input.outToken) {
    void readMarginBalance(input.recipient, input.outToken)
      .then((before) => {
        if (before) depositDb().setMarginBalanceBefore(input.depositAddress, before.balance, before.block);
      })
      .catch((error: unknown) => {
        console.error('[deposit-watcher] could not read the margin balance before', error);
      });
  }
  // The Monad arrival scan starts at the block this address was issued at.
  void readClient()
    .getBlockNumber()
    .then((head) => depositDb().setDestScanFrom(input.depositAddress, head))
    .catch((error: unknown) => {
      console.error('[deposit-watcher] could not read the starting Monad block', error);
    });
  startDepositWatcher();
}

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const db = depositDb();
    const now = Date.now();
    const active = db.active();
    // Rows with an outcome that is still missing a fact: a vendor REFUNDED whose refund
    // transaction has not been seen, a refund seen on chain whose vendor reason has not
    // arrived, a vendor SUCCESS this app has not confirmed on Monad. They are enriched,
    // never moved to a different outcome (`db.ts`'s non-regression rule).
    const followUps = db.followUps(now);
    await hydrateChainState(active);

    // A row that has gone three times its quoted eta with nothing changing is re-checked
    // against both chains and the vendor, now, whatever the usual cadence says.
    const forced = new Set<string>();
    for (const attempt of active) {
      if (slowNeedsRecheck(attempt, now)) {
        forced.add(attempt.depositAddress);
        db.markSlowRecheck(attempt.depositAddress, now);
        db.recordEvent(attempt.depositAddress, 'SLOW_RECHECK', attempt.lastStatus, {
          etaSeconds: attempt.etaSeconds,
          lastChangeAt: lastChangeOf(attempt),
        }, now);
      }
    }

    await Promise.allSettled(
      [...active, ...followUps].map((attempt) =>
        // Which vendor to ask is a property of the row, not of this file. A rail this
        // watcher does not know is skipped rather than polled at 1Click's endpoint,
        // which would report someone else's deposit as missing.
        attempt.rail === 'relay'
          ? checkRelay(attempt)
          : attempt.rail === 'cctp'
            ? attempt.terminalStatus
              ? Promise.resolve()
              : checkCctp(attempt)
            : checkOne(attempt),
      ),
    );
    // The source chain, both directions: did the money land at the deposit address,
    // and has it come back to the depositor. Every rail but CCTP, whose "deposit" is a
    // burn with no address to come back from.
    await Promise.allSettled(
      active.filter((a) => a.rail !== 'cctp' && a.sourceLandedAt === null).map((a) => checkSourceLanding(a, now)),
    );
    await Promise.allSettled(
      [...active, ...followUps.filter((a) => a.terminalStatus === 'REFUNDED')]
        .filter((a) => a.rail !== 'cctp')
        .map((a) => checkSourceRefund(a, now, forced.has(a.depositAddress))),
    );
    // Destination detection runs for every active row, independent of which vendor it
    // is, independent of what that vendor's own status says. This is the tracker
    // rebuild's "chain beats vendor" rule: it is what proves step 4, not a vendor's own
    // terminal word — see `destination.ts`.
    await Promise.allSettled(
      [...active, ...followUps.filter((a) => a.terminalStatus === 'SUCCESS')].map((attempt) =>
        checkDestination(attempt),
      ),
    );
    // Stuck deposits (owner, 2026-09-30): evaluated for every watched row on every poll.
    try {
      await evaluateStuck(db, [...db.active(), ...db.followUps(now)], {
        now,
        recover: recoverStuck,
        onChange: (row) =>
          publishDepositTransition({
            depositAddress: row.depositAddress,
            type: 'STUCK',
            status: row.lastStatus,
            terminal: false,
            at: Date.now(),
          }),
      });
    } catch (error) {
      console.error('[deposit-watcher] stuck pass failed', error instanceof Error ? error.message : error);
    }
    // Chain evidence always wins (owner rule, 2026-09-30): a matching arrival on Monad
    // completes the row at once, whatever the vendor says, read from each row's own
    // cursor forward rather than a window behind the head (`arrival.ts`).
    try {
      const marginAccount = marginAccountAddress();
      await settleArrivals(db, readClient(), {
        resolveToken: resolveOutTokenAddress,
        marginAccount,
        now,
        publish: (row) =>
          publishDepositTransition({
            depositAddress: row.depositAddress,
            type: 'DESTINATION_DETECTED',
            status: 'SUCCESS',
            terminal: true,
            at: Date.now(),
          }),
      });
    } catch (error) {
      console.error('[deposit-watcher] arrival scan failed', error instanceof Error ? error.message : error);
    }
  } finally {
    ticking = false;
  }
}

/** When anything about this row last changed, from every timestamp it carries. */
function lastChangeOf(attempt: DepositAttemptRow): number {
  return Math.max(
    attempt.createdAt,
    attempt.lastChangeAt ?? 0,
    attempt.sourceTxAt ?? 0,
    attempt.sourceLandedAt ?? 0,
    attempt.detectedAt ?? 0,
  );
}

/**
 * In flight (something landed, nothing delivered or returned), three times its
 * quoted eta without a change, and not already forced within the last such window.
 */
export function slowNeedsRecheck(attempt: DepositAttemptRow, now: number): boolean {
  if (attempt.terminalStatus || attempt.destinationTxHash) return false;
  if (!attempt.sourceTxHash && attempt.sourceLandedAt === null) return false;
  if (!isSlow({ etaSeconds: attempt.etaSeconds, lastChangeAt: lastChangeOf(attempt), now })) return false;
  const windowMs = (attempt.etaSeconds ?? 0) * 3 * 1000;
  return attempt.slowRecheckAt === null || now - attempt.slowRecheckAt > windowMs;
}

/** Per-row time of the last source-chain refund scan: the RPCs are public and shared. */
const lastRefundScan = new Map<string, number>();
const REFUND_SCAN_EVERY_MS = 30_000;

/**
 * Whether this row could have been refunded yet: something reached the deposit
 * address (our watch, or the vendor's own word that it saw a deposit), or the vendor
 * already says REFUNDED/FAILED and the refund transaction is what is missing.
 */
function refundScanDue(attempt: DepositAttemptRow): boolean {
  if (attempt.refundEvidenceHash || attempt.destinationTxHash) return false;
  if (attempt.terminalStatus === 'SUCCESS') return false;
  const somethingArrived =
    Boolean(attempt.sourceTxHash) || attempt.sourceLandedAt !== null || attempt.lastStatus !== 'PENDING_DEPOSIT';
  // A stuck row is read until a chain shows its outcome, however long that takes.
  return somethingArrived && (attempt.stuckAt !== null || Date.now() - attempt.createdAt < 7 * 24 * 60 * 60 * 1000);
}

/** Refund hashes already recorded as a surplus return, so each is logged once. */
const surplusSeen = new Set<string>();

/** What the vendor says reached the deposit address, in the origin token's base units. */
function depositedAmountOf(attempt: DepositAttemptRow): bigint | undefined {
  if (!attempt.vendorRawJson) return undefined;
  try {
    const raw = JSON.parse(attempt.vendorRawJson) as { swapDetails?: { depositedAmount?: unknown } };
    const v = raw.swapDetails?.depositedAmount;
    return typeof v === 'string' && /^\d+$/.test(v) ? BigInt(v) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A return of less than 90% of what was deposited is the surplus, not the deposit: a
 * full refund comes back whole, less a fee that is small beside it.
 */
export function isSurplusReturn(returned: bigint, deposited: bigint | undefined): boolean {
  if (deposited === undefined || deposited <= 0n || returned <= 0n) return false;
  return returned * 10n < deposited * 9n;
}

async function checkSourceRefund(attempt: DepositAttemptRow, now: number, force: boolean): Promise<void> {
  if (!refundScanDue(attempt)) return;
  const last = lastRefundScan.get(attempt.depositAddress) ?? 0;
  if (!force && now - last < REFUND_SCAN_EVERY_MS) return;
  lastRefundScan.set(attempt.depositAddress, now);
  const db = depositDb();
  try {
    const check = await detectSourceRefund(attempt);
    if (check.status !== 'found') return;
    const { finding } = check;
    // More was sent than the quote was for, and the vendor is returning the extra while
    // it still works on the swap: that is not the deposit coming back. Unless the vendor
    // itself has said REFUNDED, a return well short of what was deposited ends nothing.
    if (attempt.terminalStatus !== 'REFUNDED' && isSurplusReturn(finding.amount, depositedAmountOf(attempt))) {
      if (!surplusSeen.has(finding.hash)) {
        surplusSeen.add(finding.hash);
        db.recordEvent(attempt.depositAddress, 'SURPLUS_RETURNED', attempt.lastStatus, {
          ...finding,
          amount: finding.amount.toString(),
        });
      }
      return;
    }
    if (db.refundHashClaimedByOther(finding.hash, attempt.depositAddress)) {
      db.recordEvent(attempt.depositAddress, 'WATCHER_ERROR', null, {
        source: 'refund-detect',
        message: `refund ${finding.hash} is already recorded on a different row, refused`,
      });
      return;
    }
    const at = Date.now();
    const written = db.applyRefundEvidence(
      attempt.depositAddress,
      { hash: finding.hash, source: finding.source, amount: finding.amount.toString(), from: finding.from },
      at,
    );
    if (!written) return; // delivered on Monad first: a delivered deposit does not become a returned one.
    db.recordEvent(attempt.depositAddress, 'REFUND_DETECTED', 'REFUNDED', {
      ...finding,
      amount: finding.amount.toString(),
    }, at);
    lastRefundScan.delete(attempt.depositAddress);
    publishDepositTransition({
      depositAddress: attempt.depositAddress,
      type: 'REFUND_DETECTED',
      status: 'REFUNDED',
      terminal: true,
      at,
    });
  } catch (error) {
    db.recordEvent(attempt.depositAddress, 'WATCHER_ERROR', null, {
      source: 'refund-detect',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Arrival at the deposit address, read from the source chain, for every rail that issues one. */
async function checkSourceLanding(attempt: DepositAttemptRow, now: number): Promise<void> {
  // An address whose window closed a day ago is not scanned any more; the vendor's own
  // poll still runs, and it reports a late deposit as a deposit.
  if (now > attempt.expiresAt + 24 * 60 * 60 * 1000) return;
  const db = depositDb();
  try {
    const landed = await checkSourceChain(attempt);
    if (!landed.landed) return;
    const at = Date.now();
    db.markSourceLanded(attempt.depositAddress, at);
    db.applySourceEvidence(
      attempt.depositAddress,
      { ...(landed.txHash ? { hash: landed.txHash } : {}), source: `our-watcher-${attempt.chain.toLowerCase()}` },
      at,
    );
    db.recordEvent(attempt.depositAddress, 'SOURCE_LANDED', null, landed, at);
    publishDepositTransition({
      depositAddress: attempt.depositAddress,
      type: 'SOURCE_LANDED',
      status: attempt.lastStatus,
      terminal: false,
      at,
    });
  } catch (error) {
    db.recordEvent(
      attempt.depositAddress,
      'WATCHER_ERROR',
      null,
      { chain: attempt.chain, message: error instanceof Error ? error.message : String(error) },
      Date.now(),
    );
  }
}

/**
 * Step 4's independent proof, for one row. Skipped once the row already has its own
 * destination evidence (first-evidence-wins means a repeat detection can never change
 * the answer) and for CCTP rows, whose `destination_tx_hash` is already this app's own
 * relayer submission — see `checkCctp` — not a vendor claim to confirm.
 *
 * ## Guards added after independent security review (this session)
 *
 * Three more conditions gate this before it runs at all:
 *
 *   - **Source evidence must exist.** An address nothing was ever sent to is scanned
 *     forever otherwise, and any later, unrelated transfer to that same recipient in
 *     the same token — a different deposit, a send from someone else, a margin
 *     withdrawal — would be mistaken for this row's own arrival the moment it landed.
 *   - **An expired row with no source evidence is skipped outright.** Its window has
 *     closed; scanning it is pure exposure with no legitimate outcome to find.
 *   - **A row must not already be terminal REFUNDED or FAILED.** `active()` was read
 *     before this tick's own vendor-status check ran, so a row that just went terminal
 *     earlier in the same tick could otherwise still have a stale scan's evidence land
 *     on top of it — `applyDestinationEvidence` itself refuses that write and this
 *     checks its return value rather than assuming success.
 *
 * `detectDestination` (`destination.ts`) is where the *attribution* guards live: a
 * quoted-amount tolerance so an unrelated transfer of a different size cannot match,
 * and (for the receipt-confirm path) a check that the receipt's own log actually pays
 * this recipient this token. What is left here is exclusivity — a hash already
 * claimed by a different row is refused, never double-counted.
 */
async function checkDestination(attempt: DepositAttemptRow): Promise<void> {
  if (attempt.destinationTxHash || attempt.rail === 'cctp') return;
  const hasSourceEvidence = Boolean(attempt.sourceTxHash || attempt.sourceLandedAt);
  if (!hasSourceEvidence) return;
  // Money seen on the source chain but never confirmed to have landed here, for a
  // week, is not something a 3s poll is going to resolve. Vendor status polling
  // continues regardless (`checkOne`/`checkRelay`/`checkCctp` do not consult this),
  // this only stops the RPC-costly scan.
  if (attempt.stuckAt === null && Date.now() - attempt.createdAt > 7 * 24 * 60 * 60 * 1000) return;
  const db = depositDb();
  try {
    const vendorRaw = attempt.vendorRawJson ? (JSON.parse(attempt.vendorRawJson) as unknown) : undefined;
    const outTokenAddress = attempt.outToken ? resolveOutTokenAddress(attempt.outToken) : undefined;
    const landsIn = attempt.landsIn === 'margin' ? 'margin' : 'wallet';
    const marginAccount = landsIn === 'margin' ? marginAccountAddress() : undefined;
    const quotedAmountOut = attempt.quotedAmountOut ? BigInt(attempt.quotedAmountOut) : undefined;
    const evidence = await detectDestination(readClient(), {
      recipient: getAddress(attempt.recipient),
      outTokenAddress,
      vendorRaw,
      landsIn,
      ...(marginAccount ? { marginAccount } : {}),
      ...(quotedAmountOut !== undefined ? { quotedAmountOut } : {}),
    });
    if (!evidence) return;

    if (db.destinationHashClaimedByOther(evidence.hash, attempt.depositAddress)) {
      db.recordEvent(attempt.depositAddress, 'WATCHER_ERROR', null, {
        source: 'destination-detect',
        message: `hash ${evidence.hash} is already recorded on a different row — refused, not double-counted`,
      });
      return;
    }

    const at = Date.now();
    const written = db.applyDestinationEvidence(
      attempt.depositAddress,
      { hash: evidence.hash, block: evidence.block, source: evidence.source, ...(evidence.amount ? { amount: evidence.amount } : {}) },
      at,
    );
    if (!written) return; // row went REFUNDED/FAILED earlier in this same tick — refused, not overridden.
    db.recordEvent(attempt.depositAddress, 'DESTINATION_DETECTED', evidence.source, evidence, at);
    // Delivery seen on Monad is an outcome: `applyDestinationEvidence` wrote SUCCESS.
    publishDepositTransition({
      depositAddress: attempt.depositAddress,
      type: 'DESTINATION_DETECTED',
      status: 'SUCCESS',
      terminal: true,
      at,
    });
  } catch (error) {
    db.recordEvent(attempt.depositAddress, 'WATCHER_ERROR', null, {
      source: 'destination-detect',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function resolveOutTokenAddress(outToken: string): Address | undefined {
  const chain = addresses();
  const token = (chain.tokens as Record<string, { address?: string }>)[outToken];
  return token?.address && token.address !== '0x0000000000000000000000000000000000000000'
    ? getAddress(token.address)
    : undefined;
}

function marginAccountAddress(): Address | undefined {
  const chain = addresses();
  return chain.kuru.marginAccount as Address | undefined;
}

async function readMarginBalance(
  recipient: string,
  outToken: string,
): Promise<{ balance: string; block: string } | undefined> {
  const marginAccount = marginAccountAddress();
  const tokenAddress = resolveOutTokenAddress(outToken);
  if (!marginAccount || !tokenAddress) return undefined;
  const client = readClient();
  const [balance, block] = await Promise.all([
    client.readContract({
      address: marginAccount,
      abi: marginAccountAbi,
      functionName: 'getBalance',
      args: [getAddress(recipient), tokenAddress],
    }) as Promise<bigint>,
    client.getBlockNumber(),
  ]);
  return { balance: balance.toString(), block: block.toString() };
}

/**
 * Re-derive the token contract (and, for Base, a starting block) for any active
 * attempt this process has not seen `registerDeposit` called for — the case after a
 * server restart, where `deposit_attempts` survives in SQLite but the in-memory maps
 * do not. Solana needs neither, so it is unaffected either way.
 */
async function hydrateChainState(active: readonly DepositAttemptRow[]): Promise<void> {
  const needsHydration = active.filter(
    (a) => (a.chain === 'Base' || a.chain === 'Tron') && !contractByAddress.has(a.depositAddress),
  );
  if (needsHydration.length === 0) return;
  try {
    const sources = await resolveSources();
    let currentBaseBlock: bigint | undefined;
    for (const attempt of needsHydration) {
      const source = sources.find((s) => s.key === attempt.sourceKey);
      if (!source?.contractAddress) continue;
      contractByAddress.set(attempt.depositAddress, source.contractAddress);
      if (attempt.chain === 'Base' && !startBlockByAddress.has(attempt.depositAddress)) {
        currentBaseBlock ??= await baseBlockNumber();
        // Best-effort after a restart: this scans forward from now, so a Base deposit
        // that arrived while the process was down is picked up by the 1Click poll
        // instead, which does not depend on this map at all.
        startBlockByAddress.set(attempt.depositAddress, currentBaseBlock);
      }
    }
  } catch (error) {
    console.error('[deposit-watcher] could not hydrate chain state after restart', error);
  }
}

// Moved to `vendorStatus.ts` so the reconcile script maps a payload exactly as this
// watcher does; re-exported so existing callers and tests are unchanged.
export { destinationTxFrom, refundTxFrom } from './vendorStatus';

/**
 * Poll Relay for one issued deposit address.
 *
 * The endpoint is `/intents/status?requestId=`, which is not a guess: every Relay quote
 * carries it at `steps[].items[].check.endpoint`, observed 2026-09-11.
 *
 * Every response is stored raw before anything is derived from it, so a row can always
 * be read back as what Relay actually said rather than as our reading of it. Relay's
 * own status words are what the screen shows; the mapping below exists only to drive
 * this app's own terminal/non-terminal decision.
 */
async function checkRelay(attempt: DepositAttemptRow): Promise<void> {
  const db = depositDb();
  const ref = attempt.railRef;
  if (!ref) return; // cannot be followed up; never guessed at

  try {
    const key = process.env.RELAY_API_KEY;
    const res = await fetch(
      `https://api.relay.link/intents/status?requestId=${encodeURIComponent(ref)}`,
      { headers: key ? { 'x-api-key': key } : {}, cache: 'no-store', signal: AbortSignal.timeout(8_000) },
    );
    const raw = (await res.json()) as {
      status?: string;
      details?: string;
      inTxHashes?: string[];
      txHashes?: string[];
    };

    if (!res.ok) {
      db.recordEvent(attempt.depositAddress, 'WATCHER_ERROR', null, {
        source: 'relay',
        httpStatus: res.status,
        body: raw,
      });
      return;
    }

    // The tracker's step-3 tooltip and slow-state message: the latest word, whether or
    // not it is a transition worth an events-table row.
    db.applyVendorRaw(attempt.depositAddress, raw);
    // Step 2's evidence, when Relay has one — a candidate only in the sense that this
    // app trusts Relay's own read of the source chain here, same as 1Click's
    // `originChainTxHashes` below; unlike step 4, step 2 has no independent confirm.
    if (raw.inTxHashes?.[0]) {
      db.applySourceEvidence(attempt.depositAddress, { hash: raw.inTxHashes[0], source: 'vendor:relay' });
    }

    // Relay's own word, uppercased for this table's existing vocabulary. The raw
    // payload is stored beside it either way, so a row reads back as what Relay said.
    const status = (raw.status ?? '').toLowerCase();
    /**
     * Relay's vocabulary, as observed rather than as documented.
     *
     * `unknown` is the one that is easy to get wrong. It is what Relay answers for a
     * deposit address nothing has been sent to yet — observed 2026-09-11, every three
     * seconds, on a freshly issued address. It is not an error and it is not a missing
     * request: it is "I have not seen your money", which is exactly `PENDING_DEPOSIT`.
     * Treating it as unrecognised wrote an event row on every tick, which turned the
     * transitions table into a log of every question asked (R8 stores transitions).
     */
    const mapped = relayMapped(status);
    // A word Relay has not used before is not one to act on. It is still recorded, so
    // the vocabulary can be widened from evidence rather than from a guess.
    if (!mapped) {
      if (raw.status && raw.status !== attempt.lastStatus) {
        db.recordEvent(attempt.depositAddress, 'RAIL_STATUS', raw.status, raw);
      }
      return;
    }

    /**
     * Only an outcome is terminal.
     *
     * This read `mapped !== 'PROCESSING'`, which made `PENDING_DEPOSIT` terminal — and
     * `active()` selects `WHERE terminal_status IS NULL`, so the watcher dropped every
     * Relay address about three seconds after issuing it, which is when Relay first
     * answers `unknown`. Five rows in production carry the damage: addresses that were
     * handed to a user and then never polled again.
     *
     * `PENDING_DEPOSIT` and `PROCESSING` are both states a deposit passes *through*. A
     * transfer is finished when it is delivered, returned, or failed, and not before.
     */
    const terminal = mapped === 'SUCCESS' || mapped === 'REFUNDED' || mapped === 'FAILED';
    // The same answer asked again is not a transition (R8 stores every transition, not
    // every question). A 3s tick would otherwise write 1,200 identical rows an hour.
    if (mapped === attempt.lastStatus && !terminal) return;
    // The same outcome asked again, unless it now carries the reason the row lacks.
    if (mapped === attempt.terminalStatus && !(needsEnrichment(attempt) && raw.details && attempt.refundReason === null)) {
      return;
    }

    const at = Date.now();
    db.applyRailStatus(
      attempt.depositAddress,
      {
        status: mapped,
        terminal,
        ...(raw.details ? { refundReason: raw.details } : {}),
        // Security review finding H3: `raw.txHashes[0]` used to be written straight
        // into `destination_tx_hash` here, unconfirmed, on any status Relay reported —
        // `pending`, `refund` and `failure` included. It is a *candidate* only, exactly
        // like 1Click's own `destinationChainTxHashes`, and reaches this row's evidence
        // solely through `applyVendorRaw` above and `checkDestination`'s
        // receipt-confirm path, which now also verifies the receipt actually paid this
        // recipient this token before trusting it.
      },
      at,
    );
    db.recordEvent(attempt.depositAddress, 'RAIL_STATUS', mapped, raw, at);
    // What makes the row appear and the notification fire without a manual refresh:
    // `/api/fund/stream` forwards this, and `RecentDeposits` re-reads on it.
    publishDepositTransition({
      depositAddress: attempt.depositAddress,
      type: 'RAIL_STATUS',
      status: mapped,
      terminal,
      at,
    });
  } catch (error) {
    db.recordEvent(attempt.depositAddress, 'WATCHER_ERROR', null, {
      source: 'relay',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Finish a CCTP transfer: watch Circle, then ask the relayer to mint.
 *
 * The user burned USDC on the source chain with their own wallet and their own gas. The
 * mint on Monad needs a transaction, and their Monad account has no MON to pay for one —
 * that is the premise of this product. Without this loop a burn is money destroyed.
 *
 * ## The encoding is proven, not assumed
 *
 * `receiveMessage` was simulated on Monad against a **real** Circle-signed message, from
 * a live Base to Monad burn (`0xd92f2558…d315`, destinationCaller = 0):
 *
 * ```
 * eth_call MessageTransmitterV2.receiveMessage(message, attestation)
 *   -> execution reverted: Nonce already used
 * ```
 *
 * That revert is the evidence. To reach the nonce check the call had to pass message
 * format validation, the destination-domain check against Monad's own `localDomain`, the
 * `destinationCaller` check, **and Circle's attestation signature verification**. It
 * stopped only because that particular message had already been delivered. A wrong ABI
 * or a mangled message fails far earlier and differently.
 *
 * A second burn whose `destinationCaller` was Mayan's contract reverted with
 * `Invalid caller for message` — which is why our own burns set `destinationCaller` to
 * the zero word, so that anyone, including our relayer, may complete them.
 *
 * ## What this loop will not do
 *
 * It does not decide the amount or the recipient: Circle's signature does, and the
 * relayer re-fetches the attestation itself rather than trusting anything sent to it. It
 * does not retry a mint the chain has refused. And it stops asking once Circle reports
 * the message delivered.
 */
async function checkCctp(attempt: DepositAttemptRow): Promise<void> {
  const db = depositDb();
  const burnTx = attempt.railRef;
  const chainId = attempt.sourceChainId;
  if (!burnTx || chainId === null) return; // cannot be followed up; never guessed at

  const domain = CCTP_DOMAINS[chainId];
  if (domain === undefined) return;

  let raw: {
    messages?: {
      status?: string;
      message?: string;
      attestation?: string;
      decodedMessage?: { decodedMessageBody?: { amount?: string; mintRecipient?: string } };
    }[];
    error?: string;
  };
  try {
    const res = await fetch(
      `https://iris-api.circle.com/v2/messages/${domain}?transactionHash=${burnTx}`,
      { cache: 'no-store', signal: AbortSignal.timeout(8_000) },
    );
    raw = (await res.json()) as typeof raw;
    if (!res.ok) {
      // 404 is the ordinary state in the first seconds after a burn: Circle has not
      // indexed it yet. It is not a failure and must not be written as one.
      if (attempt.lastStatus !== 'PENDING_DEPOSIT') {
        db.recordEvent(attempt.depositAddress, 'WATCHER_ERROR', null, {
          source: 'circle',
          httpStatus: res.status,
          body: raw,
        });
      }
      return;
    }
  } catch (error) {
    db.recordEvent(attempt.depositAddress, 'WATCHER_ERROR', null, {
      source: 'circle',
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  // The tracker's step-3 tooltip and slow-state message: Circle's latest word.
  db.applyVendorRaw(attempt.depositAddress, raw);

  const message = raw.messages?.[0];
  const status = message?.status ?? 'unknown';

  // Circle attesting is not Circle delivering. Until `complete` there is nothing to
  // submit, and submitting early wastes the relayer's float on a revert.
  if (status !== 'complete') {
    if (attempt.lastStatus !== 'PROCESSING') {
      const at = Date.now();
      db.applyRailStatus(attempt.depositAddress, { status: 'PROCESSING', terminal: false }, at);
      db.recordEvent(attempt.depositAddress, 'RAIL_STATUS', status, raw, at);
      publishDepositTransition({
        depositAddress: attempt.depositAddress,
        type: 'RAIL_STATUS',
        status: 'PROCESSING',
        terminal: false,
        at,
      });
    }
    return;
  }

  // Attested. Ask the relayer to submit it; the relayer re-fetches the attestation from
  // Circle itself, so nothing here is trusted as input to a signature.
  const relayerUrl = process.env.RELAYER_URL;
  if (!relayerUrl) {
    db.recordEvent(attempt.depositAddress, 'WATCHER_ERROR', null, {
      source: 'cctp-mint',
      message: 'RELAYER_URL is not set, so the mint cannot be submitted',
    });
    return;
  }

  try {
    const res = await fetch(`${relayerUrl.replace(/\/$/, '')}/v1/cctp/receive`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        recipient: attempt.recipient,
        sourceDomain: domain,
        transactionHash: burnTx,
      }),
      signal: AbortSignal.timeout(90_000),
    });
    const body = (await res.json()) as { code?: string; hash?: string; amount?: string; message?: string };

    // 202 is "Circle is still attesting" — the ordinary case. Poll again.
    if (res.status === 202) return;

    /**
     * 409 is permanent. Stop.
     *
     * The relayer says this when Circle's signed message mints to a different account
     * or targets another chain — neither of which can change, because both are inside
     * the message Circle signed. Retrying was not merely useless: each attempt spent
     * the relayer's shared rate-limit budget, and a handful of rows kept sponsorship
     * off for every user. Writing a terminal status takes the row out of `active()`.
     */
    if (res.status === 409) {
      const at = Date.now();
      db.applyRailStatus(attempt.depositAddress, { status: 'FAILED', terminal: true }, at);
      db.recordEvent(attempt.depositAddress, 'RAIL_STATUS', 'FAILED', { mint: body }, at);
      publishDepositTransition({
        depositAddress: attempt.depositAddress,
        type: 'RAIL_STATUS',
        status: 'FAILED',
        terminal: true,
        at,
      });
      return;
    }

    if (!res.ok || body.code !== 'MINTED' || !body.hash) {
      db.recordEvent(attempt.depositAddress, 'WATCHER_ERROR', null, {
        source: 'cctp-mint',
        httpStatus: res.status,
        body,
      });
      return;
    }

    const at = Date.now();
    db.applyRailStatus(
      attempt.depositAddress,
      {
        status: 'SUCCESS',
        terminal: true,
        destinationTxHash: body.hash,
        amountOut: body.amount ?? message?.decodedMessage?.decodedMessageBody?.amount ?? null,
      },
      at,
    );
    db.recordEvent(attempt.depositAddress, 'RAIL_STATUS', 'SUCCESS', { iris: raw, mint: body }, at);
    // What puts the Activity row and the notification on the screen.
    publishDepositTransition({
      depositAddress: attempt.depositAddress,
      type: 'RAIL_STATUS',
      status: 'SUCCESS',
      terminal: true,
      at,
    });
  } catch (error) {
    db.recordEvent(attempt.depositAddress, 'WATCHER_ERROR', null, {
      source: 'cctp-mint',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * A terminal row the vendor still has something to add to: a REFUNDED outcome with
 * no refund hash or no reason yet. Its repeated terminal word is not skipped as "the
 * same answer asked again", because the answer may now carry what was missing.
 */
function needsEnrichment(attempt: DepositAttemptRow): boolean {
  return attempt.terminalStatus === 'REFUNDED' && (!attempt.refundTxHash || attempt.refundReason === null);
}

async function checkOne(input: DepositAttemptRow): Promise<void> {
  let attempt = input;
  const db = depositDb();

  // Arrival on the source chain is read in `checkSourceLanding`, for every rail.
  try {
    const res = await fetch(statusUrl(attempt.depositAddress), {
      signal: AbortSignal.timeout(8_000),
      cache: 'no-store',
    });
    if (!res.ok) return;
    const parsed = oneClickStatusSchema.parse(await res.json());
    const status = asSwapStatus(parsed.status);
    const terminal = isTerminalSwapStatus(status);

    // The tracker's step-3 tooltip and slow-state message: the latest word, whether or
    // not it is a transition worth an events-table row.
    db.applyVendorRaw(attempt.depositAddress, parsed);
    const originHash = parsed.swapDetails?.originChainTxHashes?.[0]?.hash;
    if (originHash) {
      db.applySourceEvidence(attempt.depositAddress, { hash: originHash, source: 'vendor:near' });
    }

    // The vendor says delivered on a row this app ended as returned from its own chain
    // read, and the vendor's numbers show the return was only the surplus: the row goes
    // back in flight so the delivery below is accepted and then confirmed on Monad.
    if (
      status === 'SUCCESS' &&
      attempt.terminalStatus === 'REFUNDED' &&
      attempt.refundEvidenceHash &&
      /^\d+$/.test(parsed.swapDetails?.refundedAmount ?? '') &&
      /^\d+$/.test(parsed.swapDetails?.depositedAmount ?? '') &&
      /^[1-9]\d*$/.test(parsed.swapDetails?.amountOut ?? '') &&
      isSurplusReturn(BigInt(parsed.swapDetails!.refundedAmount!), BigInt(parsed.swapDetails!.depositedAmount!))
    ) {
      const revertedAt = Date.now();
      if (db.revertSurplusRefund(attempt.depositAddress, revertedAt)) {
        db.recordEvent(attempt.depositAddress, 'SURPLUS_RETURNED', status, {
          hash: attempt.refundEvidenceHash,
          amount: attempt.refundEvidenceAmount,
          note: 'refund outcome withdrawn: the vendor reports delivery and a partial return',
        }, revertedAt);
        attempt = db.attempt(attempt.depositAddress) ?? attempt;
      }
    }

    if (status === attempt.lastStatus && !terminal) return;
    const details = parsed.swapDetails;
    const refundTx = refundTxFrom(status, details);
    // Terminal is written once — a repeated identical REFUNDED read is not a new
    // transition, it is the same answer asked again. Unless it now carries what the
    // outcome was missing: the reason, or the refund transaction.
    if (status === attempt.terminalStatus) {
      const adds =
        needsEnrichment(attempt) &&
        ((Boolean(details?.refundReason) && attempt.refundReason === null) ||
          (Boolean(refundTx?.hash) && !attempt.refundTxHash));
      if (!adds) return;
    }

    const at = Date.now();
    // Security review finding H3: `destinationTxFrom`'s hash used to be written
    // straight into `destination_tx_hash` here, unconfirmed, whenever the vendor's own
    // status reached SUCCESS. It is a candidate only — `applyVendorRaw` above already
    // stores the full payload `destinationChainTxHashes` came from, and
    // `checkDestination`'s receipt-confirm path picks it up from there and verifies it
    // actually paid this recipient this token before trusting it.
    db.applyOneClickStatus(
      attempt.depositAddress,
      {
        status,
        terminal,
        refundReason: details?.refundReason ?? null,
        refundAmount: details?.refundedAmount ?? null,
        refundTxHash: refundTx?.hash ?? null,
        refundExplorerUrl: refundTx?.explorerUrl ?? null,
        amountOut: details?.amountOut ?? null,
      },
      at,
    );
    db.recordEvent(attempt.depositAddress, 'ONECLICK_STATUS', status, parsed, at);
    publishDepositTransition({
      depositAddress: attempt.depositAddress,
      type: 'ONECLICK_STATUS',
      status,
      terminal,
      at,
    });

    if (terminal) {
      contractByAddress.delete(attempt.depositAddress);
      startBlockByAddress.delete(attempt.depositAddress);
    }
  } catch (error) {
    db.recordEvent(
      attempt.depositAddress,
      'WATCHER_ERROR',
      null,
      { source: '1click', message: error instanceof Error ? error.message : String(error) },
      Date.now(),
    );
  }
}

async function checkSourceChain(
  attempt: DepositAttemptRow,
): Promise<{ landed: boolean; txHash?: string }> {
  if (attempt.chain === 'Solana') return solanaLanded(attempt.depositAddress);
  if (attempt.chain === 'Tron') {
    const contract = contractByAddress.get(attempt.depositAddress) ?? resolveSourceAsset('Tron', attempt.originSymbol)?.token;
    if (!contract) return { landed: false };
    return tronLanded(attempt.depositAddress, contract);
  }
  /**
   * Every EVM source, Base included, through the same chunked log scan from the
   * moment the address was issued. The old Base read asked for `fromBlock..latest`
   * in one call from a start block held in memory, which `mainnet.base.org` refuses
   * once the range passes 2,000 blocks (about an hour) and which a restart forgot.
   */
  return evmLanded(attempt);
}
