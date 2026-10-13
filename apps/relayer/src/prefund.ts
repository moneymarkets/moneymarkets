import {
  createWalletClient,
  encodeFunctionData,
  fallback,
  http,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { entryPoint08Abi } from 'viem/account-abstraction';
import {
  PRIOR_FEE_NEVER_LANDED_MESSAGE,
  PRIOR_FEE_PENDING_MESSAGE,
  TOP_UP_ABOVE_GAS_USED_MESSAGE,
  type GasChargeRefusalData,
  allowanceScopeOf,
  chainFor,
  decideTopUp,
  effectiveExemptAllAddressesHourCap,
  effectiveExemptPerAddressDayCap,
  effectiveExemptPerAddressHourCap,
  effectiveFeePaidPerAddressHourCap,
  ENTRY_POINT_V08,
  ENTRYPOINT_TOPUP_WEI,
  HOUR_MS,
  MIN_ENTRYPOINT_DEPOSIT_WEI,
  nonExemptAllAddressesHour,
  prefundHeadroom,
  readEntryPointDeposit,
  rollingDayResetsAt,
  sponsorshipAllowanceMessage,
  SPONSORSHIP_ALLOWANCE_USED,
  utcClock,
  windowStartOf,
  type ChainMode,
  type PrefundBudgets,
  type PrefundHeadroom,
  type PrefundUsage,
  type SponsorshipAllowanceData,
} from '@tradepro/core';
import { EXEMPT_PURPOSE, FEE_PAID_PURPOSE_PREFIX, type PrefundLedger, type RelayerDb } from './db.js';
import { loadRelayerAccount } from './keystore.js';
import type { FundedRunCheck } from './selfBundle.js';

/**
 * Funding an account's EntryPoint deposit from the relayer float, and nothing else.
 *
 * This is the only code in the relayer that moves MON on a user's behalf. It exists
 * because the EntryPoint refuses an operation whose deposit cannot cover its prefund
 * (`AA21 didn't pay prefund`), and a gasless account has no MON of its own to deposit.
 *
 * ## The three rules it enforces
 *
 *  1. **Proof before money.** `ensure` pays only when the caller's `prove` resolves true:
 *     the user-operation signature recovered to the sender (checked by the route) and its
 *     nonce is the EntryPoint's next one (read by `prove`). No `prove`, no spend (S4-C1).
 *  2. **Reserve before spend.** The budget is checked and the amount reserved in one
 *     synchronous step, then the transaction is sent (S4-C2).
 *  3. **One top-up at a time.** Every spend runs inside a single in-process lock, so two
 *     requests can never both read the same thin deposit and both pay. The audit measured
 *     60 concurrent requests for one address paying 18 MON against a 2 MON cap. Under the
 *     lock the first pays and the other 59 re-read a funded deposit and pay nothing.
 *
 * ## Why one global lock rather than one per address
 *
 * The float, the relayer's own transaction nonce and the all-addresses hourly budget are
 * shared by every address. A per-address lock would still let different addresses race
 * on all three, and two top-ups from one key in the same block collide on its nonce.
 * Top-ups are rare (a few per account per day), and the read-only checks that decide
 * most requests run outside the lock. So serialising the spend costs little and removes
 * every one of those races, rather than reasoning about each separately.
 */

/**
 * How the relayer actually pays. Injected so tests can count payments without a key.
 *
 * On this machine `.secrets/relayer-keystore.json` unlocks the real mainnet relayer. A
 * test that reached the live executor with a positive fake balance would sign and
 * broadcast a real `depositTo`. Every relayer test injects its own executor for that
 * reason.
 */
export interface TopUpExecutor {
  /** The relayer's own address, or undefined when its key cannot be unlocked. */
  relayerAddress(): Address | undefined;
  /** Send `EntryPoint.depositTo(account)` carrying `amount`. Resolves with its hash. */
  depositTo(account: Address, amount: bigint): Promise<Hex>;
  /** Wait for the receipt of a transaction this executor sent. */
  waitForReceipt(hash: Hex): Promise<'success' | 'reverted'>;
}

export const TOPUP_RECEIPT_TIMEOUT_MS = 60_000;

/** A top-up that could not bring the deposit to what the operation needs is not paid. */
/** The exempt backstop (D191): the last advanced action has not been seen to land yet. */
export const PRIOR_TOPUP_PENDING_MESSAGE =
  "Your last action hasn't confirmed on chain yet, so network fees can't be advanced for this one. Try again in a moment.";

/** The exempt backstop (D191): the last advanced action never landed. */
export const PRIOR_TOPUP_NEVER_LANDED_MESSAGE =
  "Your last action never confirmed on chain, so network fees can't be advanced for this account now. Add MON to your wallet, or money to your trading balance, to keep going.";

export const UNFUNDABLE_MESSAGE =
  'The network fee for this action cannot be covered right now, so nothing was sent. Try again later.';

/**
 * How often a receipt wait under the relayer key's lock looks, in ms. The relayer's client
 * has no block time on its chain definition, so viem falls back to polling every 4 s, and
 * a deposit mined in 400 ms held the lock, and every bundle queued behind it, for up to
 * 4 s more. 500 ms is what the browser's clients already use (`bundlerTransport.ts`).
 */
export const RECEIPT_POLL_MS = 500;

export function liveTopUpExecutor(options: {
  readonly client: PublicClient;
  readonly mode: ChainMode;
  readonly rpcUrl: string | undefined;
  /** A second public RPC to retry the broadcast on, once, if the primary fails
   *  (D201) — mainnet only; no fallback is verified for testnet. */
  readonly fallbackRpcUrl?: string;
}): TopUpExecutor {
  return {
    relayerAddress: () => loadRelayerAccount()?.address,
    async depositTo(account, amount) {
      const relayer = loadRelayerAccount();
      if (!relayer) throw new Error('the relayer key cannot be unlocked');
      const primary = options.rpcUrl ? http(options.rpcUrl) : http();
      const wallet = createWalletClient({
        account: relayer,
        chain: chainFor(options.mode),
        transport:
          options.mode === 'mainnet' && options.fallbackRpcUrl
            ? fallback([primary, http(options.fallbackRpcUrl)])
            : primary,
      });
      // The nonce is read from the primary alone (security review, 2026-10-08): with
      // the fallback transport on `wallet` itself, letting `sendTransaction` fetch its
      // own nonce risks a lagging second node handing out one this relayer key's own
      // in-flight transaction already used. The one lock this runs under (F5) still
      // serializes every relayer-key send; this only keeps the nonce itself off the
      // second node too. Gas estimation is left to `sendTransaction` — a different
      // estimate between nodes changes the gas limit, never the nonce, and is not
      // the failure mode this guards against.
      const nonce = await options.client.getTransactionCount({
        address: relayer.address,
        blockTag: 'pending',
      });
      return wallet.sendTransaction({
        to: ENTRY_POINT_V08,
        data: encodeFunctionData({ abi: entryPoint08Abi, functionName: 'depositTo', args: [account] }),
        value: amount,
        nonce,
      });
    },
    async waitForReceipt(hash) {
      // Bounded explicitly. This runs inside the one top-up lock, and viem's default is
      // three minutes, which would stall every account's funding behind one slow receipt.
      // A 400 ms chain mines a deposit in seconds. On timeout the caller keeps the
      // reservation counted, so a slow receipt never frees budget early.
      const receipt = await options.client.waitForTransactionReceipt({
        hash,
        timeout: TOPUP_RECEIPT_TIMEOUT_MS,
        pollingInterval: RECEIPT_POLL_MS,
      });
      return receipt.status;
    },
  };
}

/**
 * Is this bundler answer the EntryPoint's "the deposit could not pay" failure?
 *
 * `AA21 didn't pay prefund` is the EntryPoint's own error for an account whose deposit
 * cannot cover the prefund. This codebase has had it back from Pimlico verbatim, on the
 * estimate as well as the send (see the `/v1/bundler` notes in server.ts). It is matched
 * on the code alone, wherever the bundler puts it (message or data), and anything that
 * does not parse as a JSON-RPC error is not it.
 */
export function isPrefundFailure(answer: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer);
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
  const error = (parsed as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return false;
  const { message, data } = error as { message?: unknown; data?: unknown };
  const text = `${typeof message === 'string' ? message : ''} ${JSON.stringify(data ?? '')}`;
  return /\bAA21\b/.test(text);
}

/** Runs tasks one at a time, in arrival order. A failed task does not block the next. */
export class SerialLock {
  #tail: Promise<void> = Promise.resolve();
  #generation = 0;
  #active = 0;
  #queued = 0;

  /**
   * How many tasks have started, and whether none is running or waiting now (R9,
   * 2026-10-07). A self-bundle's reads made outside the lock are reused inside it only
   * when the lock was idle as they started and exactly one task, its own, has started
   * since: then no relayer-key transaction can have gone out between the reads and the
   * send.
   */
  snapshot(): { readonly generation: number; readonly idle: boolean } {
    return { generation: this.#generation, idle: this.#active === 0 && this.#queued === 0 };
  }

  get generation(): number {
    return this.#generation;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    this.#queued += 1;
    const result = this.#tail.then(async () => {
      this.#queued -= 1;
      this.#generation += 1;
      this.#active += 1;
      try {
        return await task();
      } finally {
        this.#active -= 1;
      }
    });
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/**
 * Why no top-up happened, in the words the user will see. `data` is present only for a
 * used-up allowance, which the browser renders in its own time zone.
 */
export interface Refusal {
  readonly message: string;
  readonly data?: SponsorshipAllowanceData | GasChargeRefusalData;
}

/**
 * How the durable backstop (D172) sees the chain: the latest block, and whether a given
 * operation's `UserOperationEvent` has appeared since `fromBlock`.
 *
 *   landed       the event is there, with its `success`, the `actualGasCost` it burned,
 *                and where it is (block, bundle transaction);
 *   pending      not yet, and the window it should land in is still open;
 *   missed       the window closed without it: the operation never landed where expected;
 *   unavailable  the read failed. Treated as not landed: nothing is advanced on a guess.
 */
export interface FeePaidWatch {
  latestBlock(): Promise<bigint | undefined>;
  findEvent(
    userOpHash: Hex,
    fromBlock: bigint,
  ): Promise<
    | {
        readonly status: 'landed';
        readonly success: boolean;
        readonly actualGasCost: bigint;
        readonly block: bigint;
        readonly txHash: Hex;
      }
    | { readonly status: 'pending' | 'missed' | 'unavailable' }
  >;
}

export type PrefundOutcome =
  /** The deposit already covers an operation. Nothing was spent. */
  | { readonly kind: 'not-needed' }
  /** A top-up was paid and mined. */
  | { readonly kind: 'funded'; readonly amount: bigint; readonly hash: Hex }
  /** A top-up would be needed, but the request carried no proof. Nothing was spent. */
  | { readonly kind: 'unproven' }
  /**
   * No top-up is possible, and the operation cannot run without one: the deposit is
   * empty, or it is below this send's own prefund. Nothing was spent. Refuse with `refusal`.
   */
  | { readonly kind: 'refused'; readonly refusal: Refusal }
  /**
   * No top-up is possible, but the existing deposit may still pay for this operation. It
   * covers this send's prefund, or this is an estimate whose prefund only the bundler
   * knows. Forward it unfunded. If the bundler answers `AA21 didn't pay prefund`, that
   * answer is replaced by `refusal`, because that is the true reason (F1, 2026-09-23).
   */
  | { readonly kind: 'forward-without-top-up'; readonly refusal: Refusal }
  /**
   * `verifyRun` said the funded operation would not run: the chain's reason, in words.
   * Nothing was reserved or spent.
   */
  | { readonly kind: 'would-fail'; readonly reason: string };

export interface PrefundLogger {
  info(detail: Record<string, unknown>, message: string): void;
  warn(detail: Record<string, unknown>, message: string): void;
}

export interface PrefundRequest {
  /**
   * Resolves true only if the request's signed nonce is the EntryPoint's next one.
   * Absent when there is no valid signature from the sender.
   */
  readonly prove?: () => Promise<boolean>;
  readonly purpose: string;
  /**
   * This operation's own prefund, from its signed gas limits and fee, for a send, or from
   * the limits this relayer is about to answer an estimate with. Absent for an estimate
   * Pimlico will answer, whose real prefund is unknown here.
   */
  readonly requiredPrefund?: bigint;
  /**
   * The deposit, when the caller already read it alongside its other reads. Used only for
   * the first, read-only decision. The spend always re-reads it under the lock.
   */
  readonly deposit?: bigint;
  /**
   * Which budgets bound this top-up (2026-09-24). 'sponsored', the default, is every
   * budget, as before. 'fee-paid' is for a send whose fee leg the route has already
   * verified exactly: the all-addresses hourly budget alone, per the owner's rule that the
   * per-address budgets bound the free path only. The route never passes 'fee-paid' for
   * anything else, and never with a `prove` for an estimate.
   */
  readonly budgetScope?: BudgetScope;
  /**
   * Proof that the top-up about to be paid buys a real run of this operation (independent
   * review, 2026-09-24): asked inside the lock, with the exact amount, just before anything
   * is reserved or sent, and nothing is paid unless it answers `runs`. The route passes
   * `simulateFundedRun` for every charged send.
   */
  readonly verifyRun?: (topUp: bigint, payer: Address) => Promise<FundedRunCheck>;
  /**
   * The operation a fee-paid top-up is for. Required for 'fee-paid' funding: the durable
   * backstop records it, and refuses the next fee-paid top-up to this address until this
   * operation's `UserOperationEvent` is seen. Without it nothing fee-paid is funded.
   */
  readonly feePaidOp?: { readonly userOpHash: Hex };
  /**
   * The operation an exempt top-up is for (owner item 1, 2026-09-29, D191). Required for
   * 'exempt' funding: the same durable backstop as fee-paid applies (one outstanding
   * top-up per address, refill only what was burned). Only a signed send carries one; an
   * exempt estimate is never funded (D177). The nonce is recorded for inspection only.
   */
  readonly exemptOp?: { readonly userOpHash: Hex; readonly nonce: bigint };
  /**
   * A signed send whose deposit already covers its own signed prefund goes out without
   * waiting on a top-up (R9, 2026-10-07; widened from sponsored-only to the charged lane
   * too by D201, 2026-10-08 — only 'exempt' is excluded); the deposit is put back after
   * it lands, in the background (`PrefundGate.refill`). Only the route sets it, only for
   * a signed send, and only `requiredPrefund` decides: a deposit short of it still tops
   * up first.
   */
  readonly sendFirst?: boolean;
  /**
   * A background refill after an operation landed (R9): bring the deposit back toward
   * `REFILL_THRESHOLD_WEI`, by no more than `burned`, the gas the EntryPoint charged.
   */
  readonly refill?: { readonly burned: bigint };
}

/**
 * The deposit a background refill keeps an account at (R9, 2026-10-07): one top-up from the
 * minimum, 0.15 + 0.30 MON. Measured on mainnet the same day, a sponsored swap burned
 * 0.089 MON and needed a prefund of 0.15 to 0.30 MON at the browser's 1.2x fee, so this
 * line covers the next action's prefund and the burn of three typical actions. A refill
 * never adds more than the gas the landed operation burned, so it replaces use and never
 * grows a deposit past where sponsorship already put it.
 */
export const REFILL_THRESHOLD_WEI = MIN_ENTRYPOINT_DEPOSIT_WEI + ENTRYPOINT_TOPUP_WEI;

/**
 * What a background refill leaves of the hour every address shares (security review, R9):
 * two full top-ups. A refill is optional, a top-up someone is waiting on is not, so a
 * refill never takes the shared hour below this.
 */
export const REFILL_SHARED_RESERVE_WEI = 2n * ENTRYPOINT_TOPUP_WEI;

export type BudgetScope = 'sponsored' | 'fee-paid' | 'exempt';

/** Larger than any sum of wei the ledger can hold: "no per-address bound". */
const UNBOUNDED = 1n << 255n;

/**
 * The budgets a top-up in `scope` is held to.
 *
 * 'fee-paid': the free path's per-address budgets do not apply (D168); the charged path
 * has its own per-address hourly cap instead, `FEE_PAID_MAX_MON_PER_ADDRESS_HOUR` (1 MON,
 * a code cap, D172), counted over fee-paid top-ups only (`ledgerFor`). The all-addresses
 * hour is exactly as before. A refusal names whichever bound: 'account-hour' for the cap,
 * 'shared' for the hour every address shares.
 *
 * 'exempt' (2026-09-25 rebuild; bounded 2026-09-25 after security review finding 1,
 * re-bounded the same day after a second review round found the first bound doubled the
 * relayer's hourly payout instead of sharing the existing ceiling):
 *
 * Bounded on the day, per address, at `EXEMPT_MAX_MON_PER_ADDRESS_DAY` (finding 3, second
 * round) — a separate 2 MON pool on exempt's own ledger, so it never reduces what an
 * address may still draw on the sponsored ledger. Reasoning kept from the first pass: a
 * withdraw, a send or a cancel should almost never be refused for gas by the day budget,
 * because a user must usually be able to get their own funds out whatever they have
 * already drawn today — bounded, not unbounded, because unbounded let one address draw
 * its full hourly cap every hour forever (about 22 MON in 24 hours in one probe), and
 * D172's landed-operation backstop does not run for exempt (flagged, not ported, D177).
 *
 * Bounded on the hour, shared across every address at `EXEMPT_ALL_ADDRESSES_SHARE_PERCENT`
 * of the total, and per address at `EXEMPT_PER_ADDRESS_SHARE_OF_POOL_PERCENT` of THAT pool
 * (not of the total, and not a fixed wei figure — a third review round found a fixed
 * figure equalled the whole pool at the default budgets, so one address alone could take
 * the entire hour's exempt allowance), on its own ledger (`ledgerFor`, `db.ts`) so exempt
 * spend never eats into the free tier or the charged path's own budgets, and
 * sponsored/fee-paid activity can never block a withdraw. The shared hour is a PERCENTAGE
 * slice CARVED OUT of `budgets.allAddressesHour`, not a fixed wei amount added to it
 * (`nonExemptAllAddressesHour` below gives sponsored/fee-paid the rest) — the two together
 * still sum to exactly the one number the owner has seen, at any value of it, including a
 * tightened one. The per-address and per-IP rate limit (`enforceRateLimits`) and the
 * amount itself (a withdraw can only move what the account holds) still apply on top.
 */
export function budgetsFor(budgets: PrefundBudgets, scope: BudgetScope | undefined): PrefundBudgets {
  if (scope === 'exempt') {
    const exemptAllAddressesHour = effectiveExemptAllAddressesHourCap(budgets.allAddressesHour);
    return {
      perAddressDay: effectiveExemptPerAddressDayCap(),
      perAddressHour: effectiveExemptPerAddressHourCap(exemptAllAddressesHour),
      allAddressesHour: exemptAllAddressesHour,
    };
  }
  const sharedHour = nonExemptAllAddressesHour(budgets.allAddressesHour);
  if (scope !== 'fee-paid') return { ...budgets, allAddressesHour: sharedHour };
  return {
    perAddressDay: UNBOUNDED,
    perAddressHour: effectiveFeePaidPerAddressHourCap(),
    allAddressesHour: sharedHour,
  };
}

/** Which of the address's own top-ups its budgets in `scope` count. */
export function ledgerFor(scope: BudgetScope | undefined): PrefundLedger {
  if (scope === 'exempt') return 'exempt';
  return scope === 'fee-paid' ? 'fee-paid' : 'sponsored';
}

/**
 * The deposit an operation needs before it can run: the usual minimum, or its own prefund
 * when that is larger (2026-09-24).
 *
 * `MIN_ENTRYPOINT_DEPOSIT_WEI` was sized for a 560,000-gas batch. The relayer now answers
 * estimates itself with limits that reserve more, 0.187 MON for a plain market order at
 * the browser's 244 gwei, so a deposit between 0.15 and that was left un-topped and the
 * EntryPoint refused the operation with AA21. The top-up is still the same fixed amount
 * inside the same budgets; this only decides when one is due.
 *
 * Bounded at what one top-up from the minimum can reach. A user signs their own fee, and
 * a prefund above that bound would otherwise have the relayer chase a deposit no normal
 * operation needs.
 */
export function depositNeeded(requiredPrefund: bigint | undefined): bigint {
  const ceiling = MIN_ENTRYPOINT_DEPOSIT_WEI + ENTRYPOINT_TOPUP_WEI;
  if (requiredPrefund === undefined || requiredPrefund <= MIN_ENTRYPOINT_DEPOSIT_WEI) {
    return MIN_ENTRYPOINT_DEPOSIT_WEI;
  }
  return requiredPrefund < ceiling ? requiredPrefund : ceiling;
}

/**
 * The largest prefund a fee-paid operation may have: the same 0.45 MON ceiling a sponsored
 * top-up can reach (`depositNeeded`). Above it a fee-paid operation is refused, never
 * funded short (independent review, 2026-09-24).
 */
export const FEE_PAID_MAX_PREFUND_WEI = MIN_ENTRYPOINT_DEPOSIT_WEI + ENTRYPOINT_TOPUP_WEI;

/**
 * The deposit a fee-paid operation needs: exactly its own signed prefund (F1, revised after
 * independent review, 2026-09-24), or undefined when it may not be funded at all.
 *
 * A sponsored top-up adds a fixed 0.30 MON so one top-up covers several operations. For an
 * operation paying its own gas that left a float the user could withdraw with
 * `EntryPoint.withdrawTo`. So a fee-paid top-up brings the deposit to exactly what the
 * EntryPoint will demand before it runs this operation: the prefund of its limits at its
 * max fee, AS SIGNED. Never less: a deposit short of the signed prefund fails AA21 unmined
 * and unpaid, and the same signed operation can be replayed for another top-up, which is
 * how the first version of this function was drained (0.45 MON a replay, 12 replays to
 * empty the shared hour). Never more than `FEE_PAID_MAX_PREFUND_WEI`, and with no signed
 * prefund (an estimate) nothing is funded.
 */
export function feePaidDepositNeeded(requiredPrefund: bigint | undefined): bigint | undefined {
  if (requiredPrefund === undefined || requiredPrefund > FEE_PAID_MAX_PREFUND_WEI) return undefined;
  return requiredPrefund;
}

/**
 * The deposit an exempt (withdraw, send, cancel) operation needs: exactly its own signed
 * prefund, the same rule as `feePaidDepositNeeded` and for the same reason (security
 * review, 2026-09-25, finding 1) — an estimate's prefund is not this account's own signed
 * commitment, so nothing is funded against one. The route itself already never asks for
 * an estimate to be funded (`prove` is withheld for `exempt && !isSend`, `server.ts`);
 * this is the fail-safe if a caller ever changes that. Never more than
 * `FEE_PAID_MAX_PREFUND_WEI`, the same ceiling a sponsored top-up can reach.
 */
export function exemptDepositNeeded(requiredPrefund: bigint | undefined): bigint | undefined {
  if (requiredPrefund === undefined || requiredPrefund > FEE_PAID_MAX_PREFUND_WEI) return undefined;
  return requiredPrefund;
}

/** What the deposit must reach before this request may run. Undefined: never fundable. */
function neededFor(request: PrefundRequest): bigint | undefined {
  if (request.refill) return REFILL_THRESHOLD_WEI;
  if (request.budgetScope === 'fee-paid') return feePaidDepositNeeded(request.requiredPrefund);
  if (request.budgetScope === 'exempt') return exemptDepositNeeded(request.requiredPrefund);
  return depositNeeded(request.requiredPrefund);
}

export class PrefundGate {
  readonly #lock: SerialLock;
  /** Addresses with a background refill queued or running: at most one each (R9). */
  readonly #refilling = new Set<string>();

  constructor(
    private readonly deps: {
      readonly db: RelayerDb;
      readonly client: PublicClient;
      readonly executor: TopUpExecutor;
      readonly budgets: PrefundBudgets;
      readonly now: () => number;
      readonly log: PrefundLogger;
      /**
       * The lock every transaction from the relayer key runs under. Shared with the
       * CCTP mint route, so a top-up and a mint can never race for the key's nonce.
       */
      readonly lock?: SerialLock;
      /** The durable backstop's view of the chain. Without it, nothing fee-paid is funded. */
      readonly feePaidWatch?: FeePaidWatch;
    },
  ) {
    this.#lock = deps.lock ?? new SerialLock();
  }

  /**
   * Make sure `sender` can pay for an operation. Fund it only if `prove` says so.
   *
   * `prove` is absent when the request carried no signature from the sender, and
   * otherwise resolves true only if the signed nonce is the EntryPoint's next one. It is
   * called only when a top-up would really happen, because it costs a chain read, and
   * always before the lock and the reservation. Without a true answer nothing is spent.
   *
   * The two checks before it are read-only: a funded deposit needs nothing, and an
   * exhausted budget is refused. Both are answered without queueing behind someone
   * else's top-up, and without the request having proven anything, because neither
   * spends. The budget refusal in particular has to happen on the estimate, before the
   * user signs, so the screen can stop at "Checking" and never reach "Sending".
   */
  async ensure(sender: Address, request: PrefundRequest): Promise<PrefundOutcome> {
    const { db, client, now } = this.deps;
    const budgets = budgetsFor(this.deps.budgets, request.budgetScope);

    const deposit = request.deposit ?? (await readEntryPointDeposit(client, sender)).deposit;
    const needed = neededFor(request);
    if (needed === undefined) {
      // A fee-paid operation with no signed prefund, or one above the ceiling: never
      // funded. The route refuses these before here; this is the fail-safe.
      if (request.requiredPrefund !== undefined && deposit >= request.requiredPrefund) {
        return { kind: 'not-needed' };
      }
      return request.prove
        ? { kind: 'refused', refusal: { message: UNFUNDABLE_MESSAGE } }
        : { kind: 'unproven' };
    }
    if (deposit >= needed) return { kind: 'not-needed' };
    // Send first (R9, widened from sponsored-only to the charged lane too by D201,
    // 2026-10-08): the deposit already pays for this operation as signed, so nothing
    // waits on a top-up either way — a top-up that IS needed is the only place the
    // scope (who pays it) matters, and that path is not this one. Excluded: 'exempt',
    // never asked to take this shortcut.
    if (
      request.sendFirst &&
      (request.budgetScope ?? 'sponsored') !== 'exempt' &&
      request.requiredPrefund !== undefined &&
      deposit >= request.requiredPrefund
    ) {
      return { kind: 'not-needed' };
    }

    const t = now();
    const early = prefundHeadroom(
      db.prefundUsage(sender, t, ledgerFor(request.budgetScope)),
      budgets,
      t,
    );
    if (early.remaining === 0n) {
      return this.#cannotTopUp(deposit, request, this.#allowanceUsed(sender, early, 'precheck'));
    }

    if (!request.prove || !(await request.prove())) return { kind: 'unproven' };

    return this.#lock.run(() => this.#fund(sender, request));
  }

  /**
   * The background refill (R9, 2026-10-07): after a sponsored operation this relayer sent
   * has landed, put back what it burned, so the user's next action does not wait on a
   * top-up. Called only from a landed bundle, whose sender's signature was verified before
   * it was sent. The same lock, budgets, reservation and receipt handling as any sponsored
   * top-up; at most one per address queued or running; never more than `burned`, never
   * past `REFILL_THRESHOLD_WEI`. A spent budget or a full deposit simply means no refill:
   * nothing is refused to anyone, and the next action's own send funds itself as before.
   */
  async refill(sender: Address, burned: bigint): Promise<PrefundOutcome | { kind: 'skipped'; reason: string }> {
    const key = sender.toLowerCase();
    if (burned <= 0n) return { kind: 'skipped', reason: 'nothing was burned' };
    if (this.#refilling.has(key)) return { kind: 'skipped', reason: 'a refill is already outstanding' };
    this.#refilling.add(key);
    try {
      const outcome = await this.#lock.run(() =>
        this.#fund(sender, { purpose: 'refill', budgetScope: 'sponsored', refill: { burned } }),
      );
      this.deps.log.info(
        {
          sender,
          burnedWei: burned.toString(),
          outcome: outcome.kind,
          ...(outcome.kind === 'funded' ? { amountWei: outcome.amount.toString(), hash: outcome.hash } : {}),
        },
        'entrypoint refill',
      );
      return outcome;
    } finally {
      this.#refilling.delete(key);
    }
  }

  /** The spend. Only ever runs inside the lock. */
  async #fund(sender: Address, request: PrefundRequest): Promise<PrefundOutcome> {
    const { db, client, executor, now, log } = this.deps;
    const budgets = budgetsFor(this.deps.budgets, request.budgetScope);
    // Derived from the scope, not trusted from the caller (security review finding 7):
    // `reservePrefund` (`db.ts`) picks the ledger from the purpose string alone, so a
    // future 'exempt'-scope request whose purpose was not exactly `EXEMPT_PURPOSE` would
    // be checked against the exempt budgets here but written, and counted, to the
    // sponsored ledger instead — the same class of mismatch the fee-paid prefix already
    // guards against.
    const purpose =
      request.budgetScope === 'fee-paid'
        ? `${FEE_PAID_PURPOSE_PREFIX}${request.purpose}`
        : request.budgetScope === 'exempt'
          ? EXEMPT_PURPOSE
          : request.purpose;

    // Re-read: the top-up this request queued behind may have been for this account.
    const deposit = (await readEntryPointDeposit(client, sender)).deposit;
    const needed = neededFor(request);
    if (needed === undefined) return { kind: 'refused', refusal: { message: UNFUNDABLE_MESSAGE } };
    if (deposit >= needed) return { kind: 'not-needed' };
    const cannot = (refusal: Refusal) => this.#cannotTopUp(deposit, request, refusal);

    /**
     * The durable backstop (D172, independent review, 2026-09-24). At most one fee-paid
     * top-up per address is outstanding: while the operation the last one paid for has not
     * been seen to land (its `UserOperationEvent`), no second one is paid to that address,
     * however the first came to nothing (a race won to withdraw it, a deadline that ran out
     * after the simulation, a bundler that never included it). Every such variant is held to
     * one top-up per address instead of one per replay. An honest account is rarely touched:
     * a top-up that never landed is still in its deposit, so its next operation needs none.
     * An operation that lands, whose unused prefund is then withdrawn (scenario H), is the
     * refill rule's case, just below.
     */
    const feePaid = request.budgetScope === 'fee-paid';
    // Owner item 1 (2026-09-29, D191): the exempt scope carries the same two rules.
    const exempt = request.budgetScope === 'exempt';
    const backstop = feePaid || exempt;
    const watch = this.deps.feePaidWatch;
    const markerHash = feePaid ? request.feePaidOp?.userOpHash : request.exemptOp?.userOpHash;
    if (backstop) {
      if (!watch || !markerHash) {
        return { kind: 'refused', refusal: { message: UNFUNDABLE_MESSAGE } };
      }
      const prior = db.outstandingFeePaidTopUp(sender, exempt ? 'exempt' : 'fee-paid');
      // Any outstanding marker, same nonce or not, is judged only by whether its operation
      // landed (security review of D191, finding 1: a same-nonce resend is not "the same
      // operation" and is never funded again while the first is unseen).
      if (prior) {
        const seen = await watch.findEvent(prior.userOpHash as Hex, prior.fromBlock);
        if (seen.status === 'landed') {
          // Its burn first, then the marker: the refill rule below reads both.
          db.recordGasBurn({
            userOpHash: prior.userOpHash,
            address: sender,
            block: seen.block,
            actualGasCost: seen.actualGasCost,
            success: seen.success,
            ownBundle: db.isOwnBundleTx(seen.txHash),
            now: now(),
          });
          db.settleFeePaidTopUp(prior.id, 'confirmed', { success: seen.success, now: now() });
        } else {
          log.warn(
            { sender, priorUserOpHash: prior.userOpHash, seen: seen.status, scope: request.budgetScope },
            `${request.budgetScope} top-up refused: the last one has not been seen to land`,
          );
          return {
            kind: 'refused',
            refusal: exempt
              ? {
                  message: seen.status === 'missed' ? PRIOR_TOPUP_NEVER_LANDED_MESSAGE : PRIOR_TOPUP_PENDING_MESSAGE,
                  data: { reason: 'PRIOR_FEE_UNCONFIRMED' },
                }
              : {
                  message: seen.status === 'missed' ? PRIOR_FEE_NEVER_LANDED_MESSAGE : PRIOR_FEE_PENDING_MESSAGE,
                  data: { reason: 'PRIOR_FEE_UNCONFIRMED' },
                },
          };
        }
      }

      /**
       * Refill only what was burned (D172, scenario H, the owner's structural fix). A top-up
       * is the operation's whole signed prefund; the EntryPoint charges only its
       * `actualGasCost` and credits the rest back to the sender's own deposit, which the
       * sender can withdraw once the operation has landed. So after an address's first paid
       * top-up, a later one may only replace gas its operations have been seen to burn since
       * the block before the last one: the `actualGasCost` of that operation (mined, success
       * or not) and of any others read since, from the same events the backstop reads
       * (`recordGasBurn` says which count). Whatever was left over and withdrawn is never
       * put back, so it is one operation's headroom per address, once, not once per cycle.
       * The first top-up, with no landed one before it, is sized to the operation's need.
       */
      const landed = db.lastLandedFeePaidTopUp(sender, exempt ? 'exempt' : 'fee-paid');
      if (landed) {
        const burned = db.gasBurnedSince(sender, landed.fromBlock, exempt ? 'exempt' : 'fee-paid');
        if (needed - deposit > burned) {
          log.warn(
            {
              sender,
              shortfallWei: (needed - deposit).toString(),
              burnedSinceWei: burned.toString(),
              sinceBlock: landed.fromBlock.toString(),
            },
            `${request.budgetScope} top-up refused: more than the gas burned since the last one`,
          );
          return {
            kind: 'refused',
            refusal: {
              message: TOP_UP_ABOVE_GAS_USED_MESSAGE,
              data: { reason: 'TOP_UP_ABOVE_GAS_USED' },
            },
          };
        }
      }
    }

    const relayer = executor.relayerAddress();
    if (!relayer) {
      return cannot({
        message: 'this relayer cannot unlock its key, so it cannot fund the operation',
      });
    }
    const relayerBalance = await client.getBalance({ address: relayer });

    // ---- No await from here to the reservation. ----
    const t = now();
    const usage = db.prefundUsage(sender, t, ledgerFor(request.budgetScope));
    const headroom = prefundHeadroom(usage, budgets, t);
    // A refill may use only what the shared hour holds above its reserve (security review,
    // R9): checked here, and the refill sized to it below, so it can never cross the line.
    const refillRoom = headroom.detail.allAddressesHourLeft - REFILL_SHARED_RESERVE_WEI;
    if (request.refill && refillRoom <= 0n) {
      return { kind: 'refused', refusal: { message: 'the shared hour is kept for top-ups someone is waiting on' } };
    }
    const decision = decideTopUp({
      deposit,
      budgetRemaining: headroom.remaining,
      relayerBalance,
      minDeposit: needed,
      // F1: a fee-paid top-up is the shortfall to this operation's own prefund, not 0.30.
      // An exempt top-up is sized the same way (security review, 2026-09-25, finding 1):
      // never more than the operation actually needs, so a legitimate withdraw, send or
      // cancel draws as little as possible from the bounded exempt pool, and a top-up
      // funded on a signed prefund can never be inflated past what that signature buys.
      ...(request.budgetScope === 'fee-paid' || request.budgetScope === 'exempt'
        ? { topUpAmount: needed - deposit }
        : request.refill
          ? {
              // Refill only what was burned, never past the deposit line, and never into the
              // shared hour's reserve (R9).
              topUpAmount: [request.refill.burned, needed - deposit, refillRoom].reduce((a, b) => (b < a ? b : a)),
            }
          : {}),
    });
    if (!decision.topUp) {
      if (decision.refusal === 'NOT_NEEDED') return { kind: 'not-needed' };
      if (decision.refusal === 'BUDGET_EXHAUSTED') {
        return cannot(this.#allowanceUsed(sender, headroom, 'locked'));
      }
      log.warn({ sender, reason: decision.reason }, 'entrypoint top-up refused');
      return cannot({ message: decision.reason ?? 'this account cannot be funded now' });
    }
    /**
     * Fail-safe (independent review, 2026-09-24): never pay a top-up that leaves the
     * deposit short of the operation's own signed prefund. Such a top-up buys nothing: the
     * EntryPoint refuses the operation (AA21), nothing mines, no fee is paid, the nonce is
     * unused, and the same signed operation can ask again. It covers a budget trimming the
     * top-up to what is left, and any wrong figure reaching here from elsewhere.
     */
    if (
      request.requiredPrefund !== undefined &&
      deposit + decision.amount < request.requiredPrefund
    ) {
      log.warn(
        {
          sender,
          depositWei: deposit.toString(),
          topUpWei: decision.amount.toString(),
          requiredPrefundWei: request.requiredPrefund.toString(),
        },
        'entrypoint top-up would leave the deposit short of the operation’s prefund; not paid',
      );
      return cannot(this.#shortRefusal(sender, headroom, decision.amount, t, usage, budgets.perAddressDay));
    }
    /**
     * The last word before money moves: does this top-up buy a real run? Awaited here,
     * under the lock, before the reservation. `reservePrefund` re-checks the budgets in its
     * own transaction, so a read here cannot let a reservation past them.
     */
    if (request.verifyRun) {
      const check = await request.verifyRun(decision.amount, relayer);
      if (check.kind !== 'runs') {
        log.warn(
          { sender, topUpWei: decision.amount.toString(), check: check.kind, reason: check.reason },
          'entrypoint top-up not paid: the funded operation would not run',
        );
        return check.kind === 'fails'
          ? { kind: 'would-fail', reason: check.reason }
          : { kind: 'refused', refusal: { message: UNFUNDABLE_MESSAGE } };
      }
    }
    // Where the backstop starts looking for this operation's event: the block before the
    // top-up is sent, so the operation, which runs after it, cannot land earlier.
    let fromBlock: bigint | undefined;
    if (backstop) {
      fromBlock = await watch!.latestBlock();
      if (fromBlock === undefined) {
        return { kind: 'refused', refusal: { message: UNFUNDABLE_MESSAGE } };
      }
    }
    const reservation = db.reservePrefund({
      address: sender,
      amountWei: decision.amount,
      purpose,
      budgets,
      now: t,
    });
    if (!reservation.ok) return cannot(this.#allowanceUsed(sender, reservation.headroom, 'reserve'));
    // ---- Reserved. Awaiting is safe from here: the budget already counts this. ----

    // The backstop's marker, opened before any money moves, so a crash after sending still
    // leaves the address held. Refused if another marker appeared meanwhile (fail-safe).
    let markerId: number | undefined;
    if (backstop) {
      markerId = db.openFeePaidTopUp({
        address: sender,
        userOpHash: markerHash!,
        fromBlock: fromBlock!,
        now: now(),
        scope: exempt ? 'exempt' : 'fee-paid',
        ...(exempt && request.exemptOp ? { nonce: request.exemptOp.nonce } : {}),
      });
      if (markerId === undefined) {
        db.settlePrefund(reservation.id, 'released', { now: now() });
        return {
          kind: 'refused',
          refusal: { message: PRIOR_FEE_PENDING_MESSAGE, data: { reason: 'PRIOR_FEE_UNCONFIRMED' } },
        };
      }
    }
    // The top-up did not go out (or reverted, returning its value): the address is clear.
    const releaseMarker = () => {
      if (markerId !== undefined) db.settleFeePaidTopUp(markerId, 'released', { now: now() });
    };

    let hash: Hex;
    try {
      hash = await executor.depositTo(sender, decision.amount);
    } catch (error) {
      // No hash, so the transaction was not accepted by the node. That is where viem
      // fails: gas estimation, nonce, signing, or the node refusing the raw transaction.
      // The reservation is released so our failure does not spend the user's budget.
      db.settlePrefund(reservation.id, 'released', { now: now() });
      releaseMarker();
      log.warn(
        { sender, err: error instanceof Error ? error.message.split('\n')[0] : String(error) },
        'entrypoint top-up could not be sent',
      );
      return cannot({ message: 'the EntryPoint top-up could not be sent' });
    }

    let status: 'success' | 'reverted';
    try {
      status = await executor.waitForReceipt(hash);
    } catch {
      // Sent, and no receipt. It may still land, so it stays against the budget.
      db.settlePrefund(reservation.id, 'unconfirmed', { txHash: hash, now: now() });
      log.warn({ sender, hash }, 'entrypoint top-up sent without a receipt');
      return cannot({ message: 'the EntryPoint top-up has not confirmed yet' });
    }
    if (status !== 'success') {
      // A reverted transaction returns its value, so the account received nothing.
      db.settlePrefund(reservation.id, 'released', { txHash: hash, now: now() });
      releaseMarker();
      return cannot({ message: 'the EntryPoint top-up did not go through' });
    }

    db.settlePrefund(reservation.id, 'paid', { txHash: hash, now: now() });
    db.recordTopUp(sender, decision.amount, purpose, now());
    log.info({ sender, amount: decision.amount.toString(), hash, purpose }, 'entrypoint top-up');
    return { kind: 'funded', amount: decision.amount, hash };
  }

  /**
   * No top-up is possible. Does the operation need one? (F1, 2026-09-23.)
   *
   * `MIN_ENTRYPOINT_DEPOSIT_WEI` is the level this relayer tops up *below*, sized for the
   * largest batch at twice the gas price. It is not what a given operation needs.
   * Refusing everyone under it whenever a budget was spent meant a user holding 0.10 MON
   * of deposit was refused a 0.084 MON order they could pay for themselves, whenever
   * someone else had drained the all-addresses hour. So:
   *
   *   - an empty deposit can pay for nothing:             refuse;
   *   - a send whose own prefund the deposit covers:      forward, unfunded;
   *   - a send whose own prefund the deposit does not:    refuse;
   *   - an estimate, whose real limits are not known yet:  forward, and let the bundler's
   *     `AA21 didn't pay prefund` decide. The route turns that answer into `refusal`.
   */
  /**
   * Would the free path refuse this operation because of the account's OWN sponsorship
   * budgets, and nothing else? (F4, 2026-09-24.) Read-only.
   *
   * True exactly when `ensure` in the 'sponsored' scope would answer 'refused' with an
   * account budget as the reason: a top-up is due, the address's day or hour has nothing
   * left, the budget every address shares still has room, and the existing deposit cannot
   * run the operation on its own. Then the operation is charged instead of refused: it
   * pays its own gas, and its top-up is held to the shared budget alone. When the shared
   * budget is spent too, charging would not fund it either, so this answers undefined and
   * the ordinary refusal stands.
   *
   * Answers the refusal the free path would have given, for an account that cannot pay.
   */
  async addressBudgetBlocks(
    sender: Address,
    request: { readonly requiredPrefund?: bigint; readonly deposit?: bigint },
  ): Promise<Refusal | undefined> {
    const { db, client, now, budgets } = this.deps;
    const deposit = request.deposit ?? (await readEntryPointDeposit(client, sender)).deposit;
    if (deposit >= depositNeeded(request.requiredPrefund)) return undefined;
    const t = now();
    // The same, carved-down sponsored ceiling `ensure` itself checks (`budgetsFor`), not
    // the raw, un-carved total — otherwise this could see room in the full shared hour
    // that the sponsored ledger's own actual budget no longer has, and redirect to
    // charging when `ensure` would have refused for the exact same request.
    const headroom = prefundHeadroom(db.prefundUsage(sender, t), budgetsFor(budgets, 'sponsored'), t);
    const { addressDayLeft, addressHourLeft, allAddressesHourLeft } = headroom.detail;
    if (allAddressesHourLeft === 0n) return undefined;
    if (addressDayLeft > 0n && addressHourLeft > 0n) return undefined;
    const runsOnItsOwn =
      deposit > 0n &&
      (request.requiredPrefund === undefined || deposit >= request.requiredPrefund);
    if (runsOnItsOwn) return undefined;
    return this.#allowanceUsed(sender, headroom, 'charge-instead');
  }

  /**
   * Why a top-up that would not reach the operation's prefund was not paid. When a budget
   * trimmed it (what was left is all it could be), that budget's own refusal, with its
   * reset time for the hourly ones; otherwise the plain sentence.
   *
   * `usage`/`dayBudget` added (third review round, 2026-09-25, finding 3): before exempt's
   * rolling day was bounded (D178), a day could never be the binding budget here, so no
   * day branch existed. Now it can — reproduced: a withdraw refused with no `data` and no
   * time at all, "cannot be covered right now, try again later", when the real block was
   * the exempt day resetting about 22 hours out. `rollingDayResetsAt` needs the address's
   * own per-window spend, which `headroom.detail` does not carry, so `usage` is threaded
   * through from the same read the caller already made.
   */
  #shortRefusal(
    sender: Address,
    headroom: PrefundHeadroom,
    amount: bigint,
    t: number,
    usage: PrefundUsage,
    dayBudget: bigint,
  ): Refusal {
    if (amount !== headroom.remaining) return { message: UNFUNDABLE_MESSAGE };
    const nextWindow = windowStartOf(t) + HOUR_MS;
    if (headroom.remaining === headroom.detail.allAddressesHourLeft) {
      return this.#allowanceUsed(
        sender,
        { ...headroom, exhausted: ['ALL_ADDRESSES_HOUR'], resetsAt: nextWindow },
        'short',
      );
    }
    if (headroom.remaining === headroom.detail.addressHourLeft) {
      return this.#allowanceUsed(
        sender,
        { ...headroom, exhausted: ['ADDRESS_HOUR'], resetsAt: nextWindow },
        'short',
      );
    }
    if (headroom.remaining === headroom.detail.addressDayLeft) {
      return this.#allowanceUsed(
        sender,
        {
          ...headroom,
          exhausted: ['ADDRESS_DAY'],
          resetsAt: rollingDayResetsAt(usage.addressWindows, usage.addressDay, dayBudget),
        },
        'short',
      );
    }
    return { message: UNFUNDABLE_MESSAGE };
  }

  #cannotTopUp(deposit: bigint, request: PrefundRequest, refusal: Refusal): PrefundOutcome {
    if (deposit === 0n) return { kind: 'refused', refusal };
    if (request.requiredPrefund === undefined) return { kind: 'forward-without-top-up', refusal };
    return deposit >= request.requiredPrefund
      ? { kind: 'forward-without-top-up', refusal }
      : { kind: 'refused', refusal };
  }

  /**
   * The allowance refusal, with the figures kept on the server.
   *
   * The log line carries which budget bound and what is left in each, in wei, so an
   * operator can see exactly why. The message keeps the internal scope-naming sentence:
   * this ledger's word is diagnostic truth, and the ONE user-facing gas sentence (B2c)
   * is the route's job — `convertBudgetRefusal` in server.ts rewrites any refusal whose
   * data says SPONSORSHIP_ALLOWANCE_USED before a user can see it, after the fall-through
   * chain (own MON, then a charged fee) has really been found unavailable.
   */
  #allowanceUsed(sender: Address, headroom: PrefundHeadroom, stage: string): Refusal {
    const scope = allowanceScopeOf(headroom.exhausted);
    const now = this.deps.now();
    // Absent only if nothing is exhausted, which the callers never pass. Fall back to the
    // next window rather than a time already in the past.
    const resetsAt = headroom.resetsAt ?? windowStartOf(now) + HOUR_MS;
    this.deps.log.info(
      {
        sender,
        stage,
        exhausted: headroom.exhausted,
        addressDayLeftWei: headroom.detail.addressDayLeft.toString(),
        addressHourLeftWei: headroom.detail.addressHourLeft.toString(),
        allAddressesHourLeftWei: headroom.detail.allAddressesHourLeft.toString(),
        resetsAt: new Date(resetsAt).toISOString(),
      },
      'sponsorship allowance used',
    );
    return {
      message: sponsorshipAllowanceMessage(scope, resetsAt, { now, clock: utcClock }),
      data: { reason: SPONSORSHIP_ALLOWANCE_USED, scope, resetsAt },
    };
  }

  /**
   * Read-only: what `scope`'s budgets would still let this sender draw, in wei. The
   * quote route uses it to steer an exempt action before anything is signed: room means
   * 'sponsored'; none means the same fall-through chain every other action gets (own
   * MON, then the trading balance, then the one refusal), decided while it is still a
   * quote and not a signed operation (B2d).
   */
  /**
   * Read-only: would the exempt backstop refuse a top-up for an operation needing
   * `requiredPrefund`? (Security review of D191, finding 4.) The same two rules `#fund`
   * applies: an outstanding exempt marker whose operation has not landed refuses; after a
   * landed one, only the gas burned since may be refilled. Writes nothing; the landed
   * marker's own burn is added here as `#fund` would record it. True when it would refuse
   * or when it cannot tell, so the quote steers to the next lane rather than promise one.
   */
  async exemptBackstopBlocks(sender: Address, requiredPrefund: bigint | undefined): Promise<boolean> {
    const { db, client } = this.deps;
    const watch = this.deps.feePaidWatch;
    if (!watch) return true;
    // No plan (an account not delegated yet): only an exempt marker, outstanding or landed,
    // can block; a fresh account has neither (re-review of D191, finding A).
    if (requiredPrefund === undefined) {
      return (
        db.lastLandedFeePaidTopUp(sender, 'exempt') !== undefined ||
        db.outstandingFeePaidTopUp(sender, 'exempt') !== undefined
      );
    }
    const needed = exemptDepositNeeded(requiredPrefund);
    if (needed === undefined) return true;
    let deposit: bigint;
    try {
      deposit = (await readEntryPointDeposit(client, sender)).deposit;
    } catch {
      return true;
    }
    if (deposit >= needed) return false;
    const prior = db.outstandingFeePaidTopUp(sender, 'exempt');
    let sinceBlock: bigint | undefined;
    let pendingBurn = 0n;
    if (prior) {
      const seen = await watch.findEvent(prior.userOpHash as Hex, prior.fromBlock);
      if (seen.status !== 'landed') return true;
      sinceBlock = prior.fromBlock;
      // Counted only if this relayer bundled it, exactly as `recordGasBurn` decides.
      // Self-bundling may already have recorded it from its own receipt.
      const recorded = db
        .gasBurns(sender)
        .some((b) => b.userOpHash.toLowerCase() === prior.userOpHash.toLowerCase());
      if (!recorded && db.isOwnBundleTx(seen.txHash)) pendingBurn = seen.actualGasCost;
    } else {
      sinceBlock = db.lastLandedFeePaidTopUp(sender, 'exempt')?.fromBlock;
    }
    if (sinceBlock === undefined) return false;
    const burned = db.gasBurnedSince(sender, sinceBlock, 'exempt') + pendingBurn;
    return needed - deposit > burned;
  }

  scopeRemaining(sender: Address, scope: BudgetScope): bigint {
    const t = this.deps.now();
    const headroom = prefundHeadroom(
      this.deps.db.prefundUsage(sender, t, ledgerFor(scope)),
      budgetsFor(this.deps.budgets, scope),
      t,
    );
    return headroom.remaining;
  }
}
