/**
 * Every external call this app makes, and what the screen says when it does not
 * answer (task 3.6).
 *
 * There are four things outside this process the app depends on — Monad's RPC, the
 * 1Click solver network, the Kuru book itself, and the bundler behind `submit()` — and
 * each of them can fail in more than one way. Five of those ways had no words at all
 * until 2026-09-09 (ITEM 9): a rate limit, an exhausted sponsorship float, an
 * operation that was accepted and never confirmed, a market that paused between the
 * check and the send, and a balance read that failed. The last two mattered most —
 * a paused market blamed this app, and a failed read rendered as a balance of zero. (There were five: the Envio indexer was
 * dropped on 2026-09-09, and its two failure codes with it, because activity is now
 * built from this app's own records.) A single
 * "something went wrong" collapses those into one shrug, which is exactly the state
 * a user cannot act on.
 *
 * So each failure is a value with three parts: the **fact** (what did not happen),
 * the **fix** (what the user or the app does next), and a **recovery** that says
 * whether waiting, retrying, or re-quoting is the way out. Copy follows design §6 —
 * states the fact and the fix, never apologises, never contains a hex string.
 *
 * ## `EXPIRED` is not a dead end
 *
 * 1Click quotes carry a deadline, and the status API reports `EXPIRED` for a quote
 * whose deposit window closed with nothing sent. That is **non-terminal**: no money
 * moved, and the user can ask for a new quote at the current price. It is modelled
 * here as `recovery: 'requote'` and `terminal: false`, so a screen that renders it
 * has to offer the way forward rather than a full stop.
 */

export type FailureCode =
  /** The quote request itself did not answer, or answered with a refusal. */
  | 'QUOTE_FAILED'
  /** The quote's deadline passed. Non-terminal: nothing moved, re-quote. */
  | 'QUOTE_EXPIRED'
  /** No deposit address exists to show, so none is shown. */
  | 'DEPOSIT_ADDRESS_UNAVAILABLE'
  /** The route needs an address on the origin chain before it can be priced. */
  | 'REFUND_ADDRESS_REQUIRED'
  /** The origin network refused the address that was given. */
  | 'REFUND_ADDRESS_REJECTED'
  /** The list of routes the solver network can deliver did not load. */
  | 'ROUTE_LIST_UNAVAILABLE'
  /** This source has no price feed configured in this build. */
  | 'ROUTE_NOT_PRICED'
  /** A Monad read failed: no balance, no book, no params. */
  | 'RPC_UNAVAILABLE'
  /** I6: the book has not been refreshed inside the heartbeat. */
  | 'BOOK_STALE'
  /** I1: best bid is at or above best ask. */
  | 'BOOK_CROSSED'
  /** The book exists and is consistent, but nothing is resting on it. */
  | 'BOOK_EMPTY'
  /** The token cannot be moved by signature, so a gasless top-up is impossible. */
  | 'PERMIT_UNSUPPORTED'
  /** `submit()` validated everything and sent nothing, because this build is not live. */
  | 'NOT_LIVE'
  /**
   * The solver network turned the amount down. This app keeps no floor of its own and
   * never pre-checks against one — the network's sentence is shown and that is all.
   */
  | 'AMOUNT_BELOW_MINIMUM'
  /** The network answered, and the answer was that it will not carry this route. */
  | 'ROUTE_UNAVAILABLE'
  /** An address exists to send to, but not one to refund to. */
  | 'DEPOSIT_NEEDS_REFUND_ADDRESS'
  /**
   * 1Click reserved a real address, but the server could not confirm the watcher
   * would track it, after retrying. The address is refused rather than handed out —
   * a fundable address nothing is watching is worse than a moment's refusal.
   */
  | 'DEPOSIT_TRACKING_UNAVAILABLE'
  /** The deposit window closed with nothing sent. Non-terminal: re-quote. */
  | 'DEPOSIT_WINDOW_CLOSED'
  /** Less arrived than the quote was for. */
  | 'SWAP_INCOMPLETE'
  /** The deposit came back to the refund address. */
  | 'SWAP_REFUNDED'
  /** The swap did not execute. */
  | 'SWAP_FAILED'
  /** Base did not answer the LayerZero fee read. */
  | 'OFT_QUOTE_UNAVAILABLE'
  /** The AUSD/USDC book could not price the conversion leg. */
  | 'CONVERSION_UNQUOTABLE'
  /** The route Kuru returned demands native value sent with the call (v2.1 spec 3.1:
   *  the one thing the relayer's VALUE_NOT_ZERO non-negotiable cannot carry — every
   *  heuristic refusal that used to sit beside it is deleted). */
  | 'FLOW_ROUTE_NEEDS_NATIVE_VALUE'
  /** Kuru Flow did not return a price for a Wallet-tab Swap (wallet spec §4.4). Its
   *  own code, distinct from `CONVERSION_UNQUOTABLE`: that one's fix text ("move it
   *  across once the book has depth") is about the AUSD/USDC funding conversion and
   *  does not apply to an arbitrary Swap pair. */
  | 'SWAP_QUOTE_UNAVAILABLE'
  /**
   * The relayer refused because this account or this network has asked too often.
   * Its own sentence names which of the two, and rides in `detail`.
   */
  | 'RATE_LIMITED'
  /**
   * The relayer has run out of MON to pay fees with. Ours, not the user's.
   */
  | 'SPONSORSHIP_UNAVAILABLE'
  /**
   * The operation was accepted and no receipt came back inside the wait.
   * Deliberately says nothing about whether it landed, because nothing knows yet.
   */
  | 'SUBMIT_TIMED_OUT'
  /**
   * The venue stopped mid-flow. Nothing was sent, and the venue's own error says why.
   */
  | 'MARKET_PAUSED_MIDFLOW'
  /** A balance read failed. Never rendered as zero — see `BALANCE_UNREADABLE`. */
  | 'BALANCE_UNREADABLE'
  /** Send's QR scan button (spec §4.3): the user declined the camera prompt. */
  | 'CAMERA_PERMISSION_DENIED'
  /** Send's QR scan button: the camera could not be opened for any other
   *  reason — no device, already in use, a platform refusal. */
  | 'CAMERA_UNAVAILABLE';

/** How a failure is escaped. Drives which affordance the screen must render. */
export type Recovery =
  /** Ask for a fresh quote. The old one is dead; nothing was spent. */
  | 'requote'
  /** The app retries on its own; the user waits. */
  | 'automatic'
  /** The user does something — enters an address, picks another market. */
  | 'user'
  /** Nothing here recovers it. An operator has to change something. */
  | 'operator';

export interface Failure {
  readonly code: FailureCode;
  /** `err` for a stop, `warn` for a pause, `ok` for a designed outcome. */
  readonly tone: 'warn' | 'err' | 'ok';
  /** What did not happen. One sentence, no hex, no jargon. */
  readonly fact: string;
  /** What happens next. One sentence, imperative or descriptive. */
  readonly fix: string;
  readonly recovery: Recovery;
  /** False when the user can carry on from here without starting again. */
  readonly terminal: boolean;
  /** Label for the affordance, when the screen offers one. */
  readonly action?: string;
  /**
   * One more sentence, supplied at the call site rather than by the catalogue.
   *
   * This is where the upstream's own words about why it refused go. It is rendered on
   * its own line under the copy, never concatenated into it, so the catalogue's
   * sentences stay the sentences the copy rules are tested against.
   */
  readonly detail?: string;
}

const CATALOGUE: Record<FailureCode, Omit<Failure, 'code'>> = {
  RATE_LIMITED: {
    tone: 'warn',
    // The relayer counts per address and per IP and says which one bound. Its own
    // sentence carries the number, so this copy states the shape and leaves the
    // figure to `detail` rather than inventing a duration it cannot know.
    fact: 'Too many requests. Nothing was sent.',
    fix: 'Wait a few minutes and try again.',
    recovery: 'automatic',
    terminal: false,
    action: 'Try again',
  },
  SPONSORSHIP_UNAVAILABLE: {
    tone: 'err',
    // Ours, and said so. A user reading "insufficient funds" about an account they
    // just funded will go looking for a mistake they did not make.
    fact: 'Fees are paid for you, and the account that pays them has run out.',
    fix: 'This is our problem, not yours. Nothing was sent and nothing was spent. Try again shortly.',
    recovery: 'operator',
    terminal: false,
    action: 'Try again',
  },
  SUBMIT_TIMED_OUT: {
    tone: 'warn',
    /**
     * The one state where the honest answer is "we do not know yet".
     *
     * An operation that was accepted and has not produced a receipt may still land.
     * Saying it failed would be a guess, and a user told it failed may send it twice.
     * So this states exactly what is known and points at the record.
     */
    fact: 'This was sent and has not confirmed yet.',
    fix: 'Nothing has moved unless a receipt says so. Check Activity in a minute — the transaction appears there if it lands.',
    recovery: 'automatic',
    terminal: false,
    action: 'Open Activity',
  },
  MARKET_PAUSED_MIDFLOW: {
    tone: 'warn',
    fact: 'This market stopped trading before your order was sent. Nothing was sent.',
    fix: 'The venue paused it, not this app. Try another market, or come back when it reopens.',
    recovery: 'user',
    terminal: false,
  },
  BALANCE_UNREADABLE: {
    tone: 'warn',
    // A balance that could not be read is not a balance of zero, and rendering it as
    // one has told people their money is gone.
    fact: 'Your balance could not be read just now.',
    fix: 'This is a reading problem, not a balance of zero. Retry.',
    recovery: 'automatic',
    terminal: false,
    action: 'Retry',
  },
  CAMERA_PERMISSION_DENIED: {
    tone: 'warn',
    fact: 'Camera access was not given, so nothing was scanned.',
    fix: 'Allow camera access for this site and try again, or type the address instead.',
    recovery: 'user',
    terminal: false,
    action: 'Try again',
  },
  CAMERA_UNAVAILABLE: {
    tone: 'warn',
    fact: 'The camera could not be opened.',
    fix: 'Try again, or type the address instead.',
    recovery: 'user',
    terminal: false,
    action: 'Try again',
  },
  QUOTE_FAILED: {
    tone: 'err',
    fact: 'The solver network did not return a price for this route.',
    fix: 'Try again in a moment, or choose a different source.',
    recovery: 'requote',
    terminal: false,
    action: 'Get a new quote',
  },
  QUOTE_EXPIRED: {
    tone: 'warn',
    // Non-terminal by construction: an expired quote is a price that lapsed, not a
    // transfer that failed. Saying so is the difference between a user who asks for
    // a new price and a user who thinks their money is stuck.
    fact: 'This price has expired. Nothing was sent and nothing was spent.',
    fix: 'Get a new quote to see the current price.',
    recovery: 'requote',
    terminal: false,
    action: 'Get a new quote',
  },
  DEPOSIT_ADDRESS_UNAVAILABLE: {
    tone: 'warn',
    fact: 'No deposit address has been issued for this route.',
    fix: 'A priced quote does not reserve an address. Nothing here is an address you can send to.',
    recovery: 'user',
    terminal: false,
  },
  REFUND_ADDRESS_REQUIRED: {
    tone: 'warn',
    fact: 'This route needs an address on the chain you are sending from before it can be priced.',
    fix: 'Enter the address you will send from. A deposit that fails is returned there.',
    recovery: 'user',
    terminal: false,
  },
  REFUND_ADDRESS_REJECTED: {
    tone: 'warn',
    fact: 'That address was not accepted for the chain you are sending from.',
    fix: 'Check it and try again. It has to be an address on that chain, not on Monad.',
    recovery: 'user',
    terminal: false,
  },
  ROUTE_LIST_UNAVAILABLE: {
    tone: 'err',
    fact: 'The list of routes into Monad did not load.',
    fix: 'Reload to try again. No source is offered until the live list confirms it.',
    recovery: 'automatic',
    terminal: false,
    action: 'Try again',
  },
  ROUTE_NOT_PRICED: {
    tone: 'warn',
    fact: 'This route is not priced in this build.',
    fix: 'Choose a source that shows a price, or wait for this one to be enabled.',
    recovery: 'user',
    terminal: false,
  },
  RPC_UNAVAILABLE: {
    tone: 'err',
    fact: 'Monad is not answering right now.',
    fix: 'Nothing is shown until it does. The app retries on its own.',
    recovery: 'automatic',
    terminal: false,
  },
  BOOK_STALE: {
    tone: 'warn',
    fact: 'Prices have not updated for more than three seconds.',
    fix: 'Trading is paused until the feed returns.',
    recovery: 'automatic',
    terminal: false,
  },
  BOOK_CROSSED: {
    tone: 'err',
    fact: 'The book shows a bid at or above the best ask, which cannot be right.',
    fix: 'Trading is paused until the data is consistent again.',
    recovery: 'automatic',
    terminal: false,
  },
  BOOK_EMPTY: {
    tone: 'warn',
    fact: 'This book has no resting orders.',
    fix: 'There is nothing to trade against until it is seeded. Pick another market.',
    recovery: 'user',
    terminal: false,
  },
  PERMIT_UNSUPPORTED: {
    tone: 'err',
    fact: 'This token cannot be moved by signature.',
    fix: 'A gasless top-up needs one. Fund with a token that supports it instead.',
    recovery: 'operator',
    terminal: true,
  },
  NOT_LIVE: {
    tone: 'ok',
    fact: 'Checked and costed. Nothing was sent — this app is running in simulated mode.',
    fix: 'Every figure above is real; the transfer is the only part that did not happen.',
    recovery: 'operator',
    terminal: true,
  },
  AMOUNT_BELOW_MINIMUM: {
    tone: 'warn',
    // No number is quoted here and none is enforced anywhere. The network's own
    // sentence arrives as `detail` and is rendered verbatim beneath this (D124); this
    // app keeps no floor of its own and never tells the user what to type — the copy
    // said "raise the amount to the minimum shown" and was removed at the owner's
    // instruction on 2026-09-09, along with the cached floor behind it.
    fact: 'The solver network turned this amount down.',
    fix: 'Nothing was sent. Its own reason is shown below; any amount can be tried.',
    recovery: 'user',
    terminal: false,
    action: 'Try again',
  },
  ROUTE_UNAVAILABLE: {
    // Warn, not err: the network answered; it just said no. The lead makes no claim
    // about WHY — the old copy asserted "temporarily unavailable", and on 2026-09-08
    // that sentence stood in front of a real, actionable reason ("Temporary swap
    // limits: minimum swap amount is $1,000"). The network's own sentence is carried
    // as `detail` and rendered verbatim beneath this; the catalogue never speaks for
    // it (error-handling rule, 2026-09-08).
    tone: 'warn',
    fact: 'The solver network declined to price this route just now.',
    fix: 'Nothing was sent. Its own reason is shown below.',
    recovery: 'user',
    terminal: false,
    action: 'Try again',
  },
  DEPOSIT_TRACKING_UNAVAILABLE: {
    tone: 'err',
    fact: 'This deposit address could not be issued safely just now.',
    fix: 'Nothing was sent. Try again in a moment.',
    recovery: 'user',
    terminal: false,
  },
  DEPOSIT_NEEDS_REFUND_ADDRESS: {
    tone: 'warn',
    fact: 'An address to send to cannot be issued without an address to refund to.',
    fix: 'Enter the address you will send from. If the swap fails, that is where the money goes.',
    recovery: 'user',
    terminal: false,
  },
  DEPOSIT_WINDOW_CLOSED: {
    tone: 'warn',
    fact: 'This deposit address has stopped accepting funds. Nothing was sent and nothing was spent.',
    fix: 'Get a new quote and a new address at the current price.',
    recovery: 'requote',
    terminal: false,
    action: 'Get a new quote',
  },
  SWAP_INCOMPLETE: {
    tone: 'warn',
    fact: 'Less arrived than the quote was for, so the swap is waiting.',
    fix: 'Send the rest to the same address, or let it lapse and be refunded.',
    recovery: 'user',
    terminal: false,
  },
  SWAP_REFUNDED: {
    tone: 'warn',
    fact: 'The deposit was returned to your refund address.',
    fix: 'Nothing is missing. Get a new quote to try again.',
    recovery: 'requote',
    terminal: true,
    action: 'Get a new quote',
  },
  SWAP_FAILED: {
    tone: 'err',
    fact: 'The swap did not execute.',
    fix: 'Your deposit is refunded to the address on the quote. Get a new quote to try again.',
    recovery: 'requote',
    terminal: true,
    action: 'Get a new quote',
  },
  OFT_QUOTE_UNAVAILABLE: {
    tone: 'err',
    fact: 'Base is not answering, so the bridge fee cannot be read.',
    fix: 'Nothing is shown until it does. Try again in a moment.',
    recovery: 'automatic',
    terminal: false,
    action: 'Try again',
  },
  CONVERSION_UNQUOTABLE: {
    tone: 'warn',
    fact: 'The AUSD book did not quote a price for this size.',
    fix: 'Try a larger amount, or move it across once the book has depth again.',
    recovery: 'user',
    terminal: false,
  },
  FLOW_ROUTE_NEEDS_NATIVE_VALUE: {
    tone: 'warn',
    fact: 'The route Kuru returned needs native MON sent with the call, which this account cannot carry.',
    fix: 'Try a different amount, or move it in as USDC instead.',
    recovery: 'user',
    terminal: false,
  },
  SWAP_QUOTE_UNAVAILABLE: {
    tone: 'warn',
    fact: 'Kuru did not return a price for this swap.',
    fix: 'Try again in a moment, or choose a different token or amount.',
    recovery: 'requote',
    terminal: false,
    action: 'Get a new price',
  },
};

export function failure(code: FailureCode): Failure {
  return { code, ...CATALOGUE[code] };
}

/**
 * The same failure, carrying one more fact that only this moment knows.
 *
 * `detail` is not part of `failureText`: a screen renders it separately, so the
 * copy rules in design section 6 keep applying to the catalogue unchanged.
 */
export function withDetail(f: Failure, detail: string | undefined): Failure {
  return detail && detail.trim() !== '' ? { ...f, detail: detail.trim() } : f;
}

/** The whole message, for a `Notice` that renders one string. */
export function failureText(f: Failure): string {
  return `${f.fact} ${f.fix}`;
}

export const FAILURE_CODES = Object.keys(CATALOGUE) as readonly FailureCode[];

/**
 * A failure from an HTTP status our own route handlers return.
 *
 * Kept in one place so a screen never invents copy from a status code inline, and so
 * a new status has exactly one home.
 */
export function failureForStatus(status: number): Failure {
  if (status === 504 || status === 502) return failure('QUOTE_FAILED');
  if (status === 410) return failure('QUOTE_EXPIRED');
  if (status === 503) return failure('ROUTE_NOT_PRICED');
  return failure('QUOTE_FAILED');
}
