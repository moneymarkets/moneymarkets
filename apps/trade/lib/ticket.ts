'use client';

import {
  assertQuoteAmountWithinCap,
  buildCancelOrders,
  buildLimitOrder,
  buildMarketOrder,
  CapExceededError,
  didNotSend,
  kuruDetailFor,
  quoteValuationFor,
  SPONSORSHIP_ALLOWANCE_USED,
  submit,
  userMessageFor,
  type BuiltCall,
  type MarketParams,
  type Side,
  type SubmitResult,
} from '@tradepro/core';
import type { Address, Hex } from 'viem';
import { recordDryRun } from './dryrunLog';
import { bundlerTransport } from './fund/bundlerTransport';

/**
 * The order ticket state machine, spec §6.2, verbatim:
 *
 *   IDLE → VALIDATING → READY
 *   READY → SIGNING → RELAYING
 *   RELAYING → MINED → CONFIRMED
 *   RELAYING → REJECTED → READY (with message)
 *   MINED    → REVERTED → READY (with message)
 *
 * Every path out of READY goes through `submit()` in `@tradepro/core` and nowhere
 * else. In this build `submit()` answers `DRYRUN` and sends nothing, because `MODE`
 * is not `live` — that is the designed outcome, not a failure, and `didNotSend()` is
 * what the screen branches on.
 */

export type TicketState =
  | 'IDLE'
  | 'VALIDATING'
  | 'READY'
  | 'SIGNING'
  | 'RELAYING'
  | 'MINED'
  | 'CONFIRMED'
  | 'REJECTED'
  | 'REVERTED';

/**
 * Index into the five segments the design draws.
 *
 * The second segment was labelled **"Face ID"** and never once happened. The account
 * key is derived from the passkey at sign-in and held as a `LocalAccount`, so signing
 * a user operation is an in-memory ECDSA signature — measured at **5 ms** on
 * 2026-09-10, with no prompt of any kind. A stage that names a biometric the user is
 * never asked for teaches them to distrust the whole pill. It now reads "Preparing",
 * which is what those milliseconds are actually spent on.
 */
export function segmentFor(state: TicketState): number {
  switch (state) {
    case 'VALIDATING':
      return 0;
    case 'READY':
    case 'SIGNING':
      return 1;
    case 'RELAYING':
    case 'REJECTED':
      return 2;
    case 'MINED':
    case 'REVERTED':
      return 3;
    case 'CONFIRMED':
      return 4;
    default:
      return 0;
  }
}

export function isTerminal(state: TicketState): boolean {
  return state === 'CONFIRMED' || state === 'REJECTED' || state === 'REVERTED';
}

/**
 * The segment to light for a progress update. Every screen that draws the pill reads it
 * from here rather than from the state name alone.
 *
 * `REJECTED` usually lights "Sending", where most refusals happen. A refusal that came
 * before anything could be sent lights "Checking" instead, the same way TicketCard's own
 * validation failures always have. The sponsorship allowance is the case that needed
 * it: the relayer refuses it on the gas estimate, before the user signs, and showing
 * that as a failure at "Sending" said something was sent when nothing was.
 */
export function segmentOf(progress: Pick<Progress, 'state' | 'refusedAtChecking'>): number {
  return progress.refusedAtChecking ? segmentFor('VALIDATING') : segmentFor(progress.state);
}

export interface TicketDraft {
  readonly market: Address;
  readonly params: MarketParams;
  readonly side: Side;
  readonly type: 'limit' | 'market';
  /** human * 1e18. Required for a limit order. */
  readonly priceWire: bigint;
  /** Quote spend in quote base units — what the user typed in the Amount field. */
  readonly quoteAmount: bigint;
  /** Base size in base-asset base units, derived from the two above. */
  readonly sizeBase: bigint;
}

export interface Validation {
  readonly ok: boolean;
  /** User-facing. Never a hex string (design §6). */
  readonly message?: string;
  readonly call?: BuiltCall;
  /** Set when tick or size alignment moved what the user typed. */
  readonly adjustedPriceWire?: bigint;
  readonly adjustedSizeBase?: bigint;
}

/**
 * VALIDATING — everything that can be known without a signature: the caps, the
 * market's tick and size rules, and the user's balance.
 *
 * Errors from `core`'s builders are already sentences about this market's rules, but
 * they are engineer sentences; each one is mapped to copy that states the fact and
 * the fix.
 */
export function validate(
  draft: TicketDraft,
  available: bigint,
  /** Base-asset balance in the margin account. Undefined means "not known yet". */
  availableBase?: bigint,
  /**
   * The dollar price of one whole unit of the market's quote asset, wire scale: the
   * MON/USDC mid for a market quoted in native MON, from the market route's own poll.
   * Unused for a dollar-quoted market. Undefined means "not known", and a MON-quoted
   * order is then held back, exactly as the relayer would refuse it.
   */
  quoteUsdPrice?: bigint,
): Validation {
  if (draft.quoteAmount <= 0n) {
    return { ok: false, message: 'Enter an amount to trade.' };
  }
  if (draft.type === 'limit' && draft.priceWire <= 0n) {
    return { ok: false, message: 'Enter a price for this order.' };
  }
  // Open item #16: a market order against an empty side does NOT revert — it
  // succeeds and fills zero (measured on MON/AUSD, chain 143 block 103,110,791:
  // `placeAndExecuteMarketBuy` returned `amountOut = 0` for every size tried,
  // including from the zero sender). So the user would pay gas, sign with a passkey,
  // and receive nothing, with no error anywhere. `priceWire` for a market order is
  // the opposing touch, and is zero exactly when that side is empty — once the
  // `bestBidAsk` no-side sentinel is folded, which `normalizeBestBidAsk` now does.
  if (draft.type === 'market' && draft.priceWire <= 0n) {
    return {
      ok: false,
      message:
        draft.side === 'buy'
          ? 'There are no orders to buy from on this book, so a market order would fill nothing.'
          : 'There are no orders to sell into on this book, so a market order would fill nothing.',
    };
  }
  if (draft.side === 'buy' && draft.quoteAmount > available) {
    return { ok: false, message: 'Not enough in your trading balance. Add money and try again.' };
  }
  // A sell spends the base asset. Catching it here saves a round trip that would come
  // back as `InsufficientBalance` and tell the user the same thing more slowly.
  //
  // **Fails closed on an unknown balance.** This used to read
  // `availableBase !== undefined && draft.sizeBase > availableBase`, so a balance that
  // had not been read yet — or whose read had failed — skipped the check entirely and
  // the order went to chain to be refused there, after a passkey prompt. An unknown
  // balance is not evidence of a sufficient one.
  if (draft.side === 'sell') {
    if (availableBase === undefined) {
      return {
        ok: false,
        message: 'Your balance for this asset has not loaded yet, so this order is held back.',
      };
    }
    if (draft.sizeBase > availableBase) {
      return { ok: false, message: 'You do not hold enough of this asset to sell.' };
    }
  }

  // The same check, with the same valuation, the relayer makes after the user signs
  // (`assertQuoteAmountWithinCap`): the order's value in its quote asset, measured in
  // dollars — AUSD and USDC one-for-one, MON at the live MON/USDC mid. It used to compare
  // the raw quote amount, which only worked while every market was quoted in a dollar.
  const valuation = quoteValuationFor(draft.params);
  if (!valuation) {
    return {
      ok: false,
      message: 'This build cannot size-check orders on this market, so it does not place them.',
    };
  }
  if (valuation.kind === 'priced' && (quoteUsdPrice === undefined || quoteUsdPrice <= 0n)) {
    return {
      ok: false,
      message: `The ${valuation.symbol} price used to check this order’s size has not loaded, so the order is held back. Try again in a moment.`,
    };
  }
  try {
    assertQuoteAmountWithinCap(draft.quoteAmount, draft.params, quoteUsdPrice);
  } catch (caught) {
    if (caught instanceof CapExceededError) {
      return {
        ok: false,
        message: 'That order is above the size limit this build allows. Trade a smaller amount.',
      };
    }
    throw caught;
  }

  try {
    if (draft.type === 'limit') {
      const built = buildLimitOrder({
        market: draft.market,
        params: draft.params,
        side: draft.side,
        priceWire: draft.priceWire,
        sizeBase: draft.sizeBase,
      });
      return {
        ok: true,
        call: built,
        adjustedPriceWire: built.price.priceWire,
        adjustedSizeBase: built.size.sizeBase,
      };
    }
    const built = buildMarketOrder({
      market: draft.market,
      params: draft.params,
      side: draft.side,
      amount: draft.side === 'buy' ? draft.quoteAmount : draft.sizeBase,
      // A market order with no floor is a market order; slippage is bounded by the
      // book the user is looking at, and I1/I6 already refuse a book that is not.
      //
      // This is the opposite floor `/api/fund/convert`'s CONVERSION_SLIPPAGE_BPS uses
      // for what is, underneath, the same `placeAndExecuteMarketBuy` primitive (audit
      // High #16) — reconciled, not overlooked. The standard: an order placed from a
      // screen the user is looking at the live book on needs no floor of its own,
      // because the book they see IS the floor, and I1/I6 already refuse to trade
      // against one that is stale or crossed. An order built from a quote fetched in
      // the background — nothing on `/fund` shows a live book between the quote and
      // the signature — has no such substitute and gets an explicit one instead. Same
      // rule, two different substitutes for the same protection.
      minAmountOut: 0n,
    });
    return { ok: true, call: built };
  } catch (caught) {
    return { ok: false, message: builderMessage(caught, draft.params) };
  }
}

function builderMessage(caught: unknown, params: MarketParams): string {
  const raw = caught instanceof Error ? caught.message : String(caught);
  if (/below the market minimum/.test(raw)) {
    return `That is below this market’s minimum order size. Increase the amount.`;
  }
  if (/above the market maximum/.test(raw)) {
    return 'That is above this market’s maximum order size. Reduce the amount.';
  }
  if (/rounds to zero at tick|below one tick/.test(raw)) {
    return 'That price is below one tick on this market. Raise it.';
  }
  if (/overflows uint/.test(raw)) {
    return 'That amount is too large for this market.';
  }
  if (/must be positive/.test(raw)) {
    return 'Enter an amount to trade.';
  }
  void params;
  return 'That order does not fit this market’s rules. Adjust the price or amount.';
}

export interface Progress {
  readonly state: TicketState;
  readonly message?: string;
  /**
   * The upstream's own words, verbatim and source-named — "Kuru answered:
   * SizeError", or the relay's quoted sentence. Rendered under `message`, never in
   * place of it (error-handling rule, 2026-09-08).
   */
  readonly detail?: string;
  readonly result?: SubmitResult;
  /** The calls that were handed to `submit()`. Real calldata in every mode. */
  readonly calls?: readonly { readonly to: Address; readonly data: Hex }[];
  /**
   * One word for what is happening inside the current stage.
   *
   * Rendered under the pill only once a stage has run for more than two seconds, so a
   * fast action stays quiet and a slow one explains itself rather than looking stuck.
   */
  readonly stageNote?: string;
  /** Checks finished inside "Checking", and how many there are (Swap's five, item 4). */
  readonly checking?: { readonly done: number; readonly of: number };
  /**
   * Set on a `REJECTED` that was decided before anything was sent: the pill stops, and
   * stays, at "Checking". See `segmentOf`.
   */
  readonly refusedAtChecking?: boolean;
}

/**
 * An order that was checked but not sent.
 *
 * It carries the real calldata and the real, tick-aligned price and size that
 * `@tradepro/core` produced. `simulated` is stored as a field rather than implied by
 * which list it lives in, so anything reading it back — a screen, a test, a person
 * looking at localStorage — sees the flag before the numbers.
 *
 * `reference` is the market's own order counter — `s_orderIdCounter()` read from the
 * contract at `block`, a high-water mark rather than a prediction. It is what the
 * cancel calldata encodes, and it is never shown: the exact id this order would
 * receive is not knowable before it is placed, and a number on the screen would read
 * as if it were.
 */
export interface SimulatedOrder {
  readonly simulated: true;
  readonly market: Address;
  readonly isBuy: boolean;
  /** human * 1e18, after tick alignment. */
  readonly priceWire: string;
  /** base-asset base units, after size alignment. */
  readonly sizeBase: string;
  readonly to: Address;
  readonly data: Hex;
  readonly reference: string | null;
  readonly block: string | null;
  readonly at: number;
}

export interface PlacedOrder {
  readonly progress: Progress;
  /** Present only when nothing was sent: what the order would have been. */
  readonly simulated?: SimulatedOrder;
  /**
   * Which way the order went.
   *
   * The receipt does not say it directly. `Trade.isBuy` is the **taker's** side —
   * measured across the owner's four real MON/USDC fills, where it matched the margin
   * ledger on all four — so a maker reading it gets the opposite of what they did. It
   * is derivable (`userSideOf` in core does it correctly), but the ticket already knows
   * what the user pressed, and a value that is known beats one that is inferred.
   */
  readonly side?: 'buy' | 'sell';
  /**
   * What the ticket knew about the order as it submitted it.
   *
   * Enough for the open-orders list to show a labelled pending row immediately rather
   * than waiting on a read. Not a claim that the order rests — the next read decides
   * that, and retires this.
   */
  readonly optimistic?: { readonly size: string; readonly price: string; readonly isBuy: boolean };
  /** `/dev/perf`'s action id for this submission, so the screen can mark `ui-updated`. */
  readonly perfActionId?: string;
}

export type OnProgress = (progress: Progress) => void;

export interface RunOptions {
  readonly sender: Address;
  /**
   * `BuiltCall` satisfies this, and so does a permit call, which carries no
   * forwardable purpose because a permit is sponsored rather than forwarded.
   */
  readonly calls: readonly {
    readonly to: Address;
    readonly data: Hex;
    /** Native value, for a call that carries it: the WMON wrap beside a margin
     *  withdrawal (D3), a plain native send, or a native margin deposit (D200).
     *  Omitted everywhere else. */
    readonly value?: bigint;
  }[];
  readonly purpose: 'order' | 'cancel' | 'deposit' | 'withdraw' | 'swap';
  readonly onProgress: OnProgress;
  /**
   * What to keep in the dry-run log, when it must differ from what was submitted.
   *
   * The one caller that sets it is the funding top-up: its batch contains an
   * ERC-2612 permit, whose calldata embeds the user's signature. That signature is a
   * bearer authorisation for its amount and nonce, and rule A4 says signatures are
   * not written down — so the log keeps the deposit and drops the permit rather than
   * persisting a signed approval in browser storage.
   */
  readonly logCalls?: readonly { readonly to: Address; readonly data: Hex }[];
  /**
   * The signing account. Present in production: `submit()` needs a transport once
   * the gate is open, and building one needs the key that will sign the operation.
   * Without it `submit()` throws rather than sending, which is how an armed build
   * came to answer "simulated mode" and send nothing.
   */
  readonly owner?: Parameters<typeof bundlerTransport>[0];
  /** Injected in tests. Production passes nothing and `submit()` decides. */
  readonly submitFn?: typeof submit;
  /**
   * `/dev/perf`'s action id for this submission (`lib/perf/orderPerf.ts`), started by
   * the caller at the tap. Threaded through to `bundlerTransport()` so its own stage
   * marks (`estimated`, `signed`, `submitted`, …) land on the same ring-buffer entry
   * as `validated`. Undefined outside a tap that started one; every downstream mark
   * call is then a no-op, so this changes nothing about what the order does.
   */
  readonly perfActionId?: string;
}

/**
 * Drive READY → SIGNING → RELAYING → (MINED → CONFIRMED | REJECTED | REVERTED).
 *
 * There is no second submission path. When `submit()` says it did not send, the run
 * stops at RELAYING and says so in the user's words — it does not pretend to mine.
 */
export async function run(options: RunOptions): Promise<Progress> {
  const send = options.submitFn ?? submit;
  const calls = options.calls.map((c) => ({
    to: c.to,
    data: c.data,
    ...(c.value !== undefined && c.value !== 0n ? { value: c.value } : {}),
  }));

  /**
   * Advance when a stage genuinely finishes, not before.
   *
   * This used to emit SIGNING and then RELAYING back to back, before the transport had
   * done anything at all — so the pill jumped to "Sending" in under a millisecond and
   * then sat there for the whole submission: the delegation read, over a second of gas
   * estimation, the submit, and the wait for a receipt. Measured 2026-09-10, that was
   * roughly 2.8 of the 3.1 seconds spent on one label.
   *
   * The transport now reports each stage as it reaches it, and `stageNote` carries one
   * word for whatever is happening, so a stage that runs long says what it is doing.
   */
  options.onProgress({ state: 'SIGNING', stageNote: 'Preparing' });

  let result: SubmitResult;
  try {
    result = await send(
      { sender: options.sender, calls, purpose: options.purpose },
      options.owner ? bundlerTransport(options.owner, {}, options.perfActionId) : undefined,
      {},
      (stage) => {
        // Segment 1 ("Preparing") covers everything up to a signed operation;
        // segment 2 ("Sending") covers the wire; segment 3 ("Mined") lights the
        // instant a receipt exists (ITEM 5). The note says which part of each.
        switch (stage) {
          case 'preparing':
            options.onProgress({ state: 'SIGNING', stageNote: 'Preparing' });
            break;
          case 'estimating':
            options.onProgress({ state: 'SIGNING', stageNote: 'Estimating gas' });
            break;
          case 'signing':
            options.onProgress({ state: 'SIGNING', stageNote: 'Signing' });
            break;
          case 'submitting':
            // Fires once the bundler has accepted the operation hash — "Sent",
            // before any receipt exists (ITEM 5).
            options.onProgress({ state: 'RELAYING', stageNote: 'Sent' });
            break;
          case 'mining':
            // Fires the instant a receipt exists, whatever it says. This is the
            // transport's *only* MINED signal now — see the removed explicit one
            // below, which used to fire after the transport's whole promise (and,
            // on a success, an extra finality wait) had already resolved.
            options.onProgress({ state: 'MINED' });
            break;
        }
      },
    );
  } catch (caught) {
    const thrown = caught instanceof Error ? caught.message.split('\n')[0]?.trim() : String(caught);
    const progress: Progress = {
      state: 'REJECTED',
      message:
        caught instanceof Error && caught.name === 'GasLayerUnprovenError'
          ? 'Trading is not live yet in this build.'
          : 'That did not go through. Nothing was spent.',
      // What actually threw, verbatim — never swallowed into the lead (2026-09-08).
      ...(thrown ? { detail: `The submission step answered: “${thrown}”` } : {}),
    };
    options.onProgress(progress);
    return progress;
  }

  if (didNotSend(result)) {
    // Keep the bytes. They are what a live run would carry, and a dry run nobody can
    // inspect afterwards proves nothing.
    recordDryRun({
      simulated: true,
      purpose: options.purpose,
      sender: options.sender,
      calls: options.logCalls ? options.logCalls.map((c) => ({ to: c.to, data: c.data })) : calls,
      reason: result.reason ?? result.status,
      at: Date.now(),
    });
    const progress: Progress = {
      state: 'RELAYING',
      message:
        result.message ?? 'Checked and costed. Nothing was sent — this app is not in live mode.',
      result,
      calls,
    };
    options.onProgress(progress);
    return progress;
  }

  if (result.status === 'REJECTED') {
    const progress: Progress = {
      state: 'REJECTED',
      message: result.message ?? userMessageFor(undefined),
      // The transport's verbatim upstream line, carried through untouched.
      ...(result.detail ? { detail: result.detail } : {}),
      // Sponsorship refused: terminal at "Checking", never "Sending" (B7).
      ...(result.reason === SPONSORSHIP_ALLOWANCE_USED ? { refusedAtChecking: true } : {}),
      result,
    };
    options.onProgress(progress);
    return progress;
  }

  /**
   * Accepted, not confirmed (ITEM 9).
   *
   * `SUBMITTED` reaching here means the wait for a receipt ran out. It is not MINED
   * and it is not REJECTED — nothing knows which yet — so it stops at RELAYING with
   * the transport's own sentence, which says the operation was sent, that nothing has
   * moved unless a receipt says so, and where to look. Falling through to MINED would
   * be a claim, and REJECTED would be a wrong one.
   */
  if (result.status === 'SUBMITTED') {
    const progress: Progress = {
      state: 'RELAYING',
      message: result.message ?? 'This was sent and has not confirmed yet.',
      ...(result.detail ? { detail: result.detail } : {}),
      result,
      calls,
    };
    options.onProgress(progress);
    return progress;
  }

  // MINED was already reported by the `onStage('mining')` callback above, fired by
  // the transport mid-flight — the instant its receipt existed, well before its
  // promise resolved (ITEM 5: a successful order still waits one more block, inside
  // the transport, for finality before reaching here). Re-emitting it here would
  // fire it again after that wait, collapsing MINED and CONFIRMED back into one
  // moment, which is exactly what item 5 asked to stop happening.

  if (result.status === 'REVERTED') {
    const reason = result.reason;
    // Plain lead from the decoded error; the venue's own answer follows as the
    // detail line, never masked (2026-09-08 rule): the decoded name when this build
    // knows the revert, the transport's own quoted line otherwise, and the raw
    // reason verbatim as the last resort.
    const decoded = kuruDetailFor(reason as Hex | undefined);
    const detail =
      decoded ??
      result.detail ??
      (reason && reason.trim() !== '' ? `The relay answered: “${reason}”` : undefined);
    const progress: Progress = {
      state: 'REVERTED',
      message: userMessageFor(reason as Hex | undefined),
      ...(detail ? { detail } : {}),
      result,
    };
    options.onProgress(progress);
    return progress;
  }

  const progress: Progress = { state: 'CONFIRMED', result };
  options.onProgress(progress);
  return progress;
}

/** Cancel takes the identical path (spec 6.2). */
export function cancelCall(market: Address, orderId: bigint): BuiltCall {
  return buildCancelOrders(market, [orderId]);
}
