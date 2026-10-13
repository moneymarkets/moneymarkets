import type { Address } from 'viem';
import { activeMarketsView, getActiveMarkets } from '../kuru/liveMarkets.js';
import type { MarketParams } from '../kuru/params.js';
import { quoteAmountInCapUnits, quoteValuationFor } from './quoteValuation.js';

/**
 * Hard caps for the mainnet gate run.
 *
 * These are **code, not configuration** (owner decision, 2026-09-02). The numbers
 * below are the ceiling. Environment variables may only move a limit *down*; a value
 * that would raise one is ignored and the code cap stands. That asymmetry is the
 * whole point: a typo in a `.env`, a stale deploy, or a copied config cannot widen
 * the blast radius of a run that is spending real money.
 *
 * Every limit here is enforced by a throw, not a log line. Nothing in this file is
 * advisory.
 */

/** AUSD has 6 decimals: $6 = 6_000_000 base units. */
export const AUSD_DECIMALS = 6;

/**
 * Maximum notional of a single order, in AUSD base units. Owner cap: **$1,000**
 * (1_000_000_000 base units).
 *
 * Raised from $6 to $1,000 on 2026-10-13 by owner decision.
 *
 * The value is kept below any unix timestamp (about 1.79e9 today) on purpose.
 * `MAX_SPONSORED_PERMIT_VALUE` (`gas/policy.ts`) is defined equal to this constant, and
 * that ceiling is what stops an unrelated calldata word from passing as a sponsored
 * permit amount. At 1e9 a word holding a deadline can never do so. See the comment on
 * `MAX_SPONSORED_PERMIT_VALUE` before raising this any further.
 *
 * Earlier history: raised from $5 to $6 on 2026-09-02 because $5 and the venue were
 * incompatible: MON/AUSD's `minSize` is 2_000_000_000_000 sizePrecision units = **200 MON**, which at the
 * bestBid/bestAsk read that day (0.025696 / 0.026211) is $5.14 – $5.24. No legal
 * MON/AUSD *limit* order fits under $5, so the gate could not have placed the resting
 * order M0 describes. $6 clears the minimum with about 15% of headroom against a
 * price move. See DECISIONS.md C5.
 */
export const MAX_ORDER_NOTIONAL_AUSD = 1_000_000_000n;

/**
 * Maximum MON the relayer may hold. Owner cap: **20 MON**.
 *
 * Sized from the measured cost rather than guessed: at 2.0 MON per address per day
 * (`PREFUND_MAX_MON`), 20 MON serves **ten concurrent demo users**, each with a full
 * session's worth of operations. About $0.51 in absolute terms.
 *
 * Raised from 5 on 2026-09-02 after the M0 gate produced a real cost per operation.
 * See DECISIONS.md D34.
 *
 * This is a ceiling, not a target. It bounds what a leaked hot key costs, and the
 * server refuses to start above it — a check that was, until 2026-09-02, silently
 * unreachable when the key came from a keystore rather than the environment.
 */
export const MAX_RELAYER_FLOAT_WEI = 20n * 10n ** 18n;

/**
 * The most MON the relayer will put into one account's EntryPoint prefund in any rolling
 * 24 hours. Owner cap: **2 MON**.
 *
 * Introduced 2026-09-23 for audit follow-up B7 (with findings S4-C1 and S4-C2). It
 * replaces a per-address *lifetime* cap of the same size. The size was right; the shape
 * was wrong for the product. At the measured ~0.07 MON per operation a lifetime cap ran
 * out after about 28 actions and then refused that account forever, so a demo session
 * hit a permanent wall. The same 2 MON now renews continuously.
 *
 * The three sponsorship budgets are all scaled from this one number, so tightening it
 * tightens all of them together:
 *
 *   | budget                     | value   | where the figure comes from                     |
 *   | one address, rolling 24 h  | 2.0 MON | the owner's figure: `PREFUND_MAX_MON`           |
 *   | one address, per hour      | 0.5 MON | the owner's figure: a quarter of the day        |
 *   | all addresses, per hour    | 5.0 MON | **provisional**, see `PREFUND_ACCOUNTS_PER_HOUR` |
 *
 * **The all-addresses budget is the one that matters against abuse.** Signature checks
 * prove an address is controlled by whoever asks. They cannot stop anyone making fresh
 * keys, and every fresh key comes with its own per-address budget. Only a global budget
 * bounds what a stream of fresh addresses can draw, and it bounds it as a rate. The
 * float cap bounds the total.
 *
 * Like every cap in this file it is code, not configuration. `RELAYER_PREFUND_MAX_MON` may
 * lower it through `tighten()` and cannot raise it.
 */
export const PREFUND_MAX_MON = 2n;

/**
 * The all-addresses hourly budget, as a number of accounts at their own hourly budget.
 *
 * **This is a judgment call awaiting the owner's confirmation, not a derived fact.** The
 * owner asked for a global hourly budget but gave no figure. Ten assumes ten concurrent
 * demo accounts each drawing their full 0.5 MON hourly budget, which makes the global
 * budget 5 MON an hour.
 *
 * Nothing links it to the float. At 5 MON an hour a sustained drain empties the 20 MON
 * float in about four hours, which is 120 MON a day against a 20 MON float. So the budget
 * slows a sweep of fresh keys to a rate an operator can see and act on; it does not bound
 * the total. The float cap does that. Retune this number on its own terms. Nothing else
 * asserts against it.
 */
export const PREFUND_ACCOUNTS_PER_HOUR = 10n;

const WEI_PER_MON = 10n ** 18n;

/**
 * The most MON the relayer will put into one account's EntryPoint deposit in one hourly
 * window for operations that pay their own gas. Owner cap: **1 MON** (D172, 2026-09-24).
 *
 * The charged path's own per-address bound. The three sponsorship budgets above bound the
 * free path only (D168), so until this existed one address on the charged path was held by
 * the all-addresses hour alone, and could empty it: scenario H drew 21 top-ups, 4.918 MON in
 * one hour from one address, and every other account was refused for the rest of it.
 *
 * It is a backstop, not the fix. The fix is that a later charged top-up only replaces gas
 * the relayer has seen burned (`TOP_UP_ABOVE_GAS_USED`), which already holds an honest
 * account far below this. This is the ceiling if that rule ever has a bug: at most 1 MON an
 * hour per address, whatever else goes wrong. Same fixed hourly windows and the same ledger
 * as the sponsorship budgets (`prefund_ledger`), counting charged top-ups only.
 *
 * Like every cap in this file it is code, not configuration. No environment variable sets
 * it; `effectiveFeePaidPerAddressHourCap` can only move it down.
 */
export const FEE_PAID_MAX_MON_PER_ADDRESS_HOUR = 1n;

export const FEE_PAID_MAX_WEI_PER_ADDRESS_HOUR = FEE_PAID_MAX_MON_PER_ADDRESS_HOUR * WEI_PER_MON;

export function effectiveFeePaidPerAddressHourCap(envValue?: bigint): bigint {
  return tighten(FEE_PAID_MAX_WEI_PER_ADDRESS_HOUR, envValue);
}

/**
 * The most MON the relayer will put into one account's EntryPoint deposit in one hourly
 * window for a withdraw, a send, or a cancel (`'exempt'` scope, 2026-09-25 rebuild;
 * bounded 2026-09-25 after security review finding 1; carved out of the existing shared
 * ceiling, not added to it, after a second review round the same day found the first
 * bound still doubled the relayer's hourly payout; re-sized again the same day after a
 * third review round found this cap equalled the exempt POOL itself at the default
 * budgets, so one address alone could draw the whole hour's exempt allowance and lock
 * out every other address's withdraw until the next window).
 *
 * These three are never refused for gas by the free-tier or per-address MON budgets — the
 * owner's rule. Before ANY cap existed nothing bounded what a stream of fresh addresses
 * could draw through them: reproduced end to end, 70 fresh addresses each drew a top-up
 * in one probe, 21 MON against a 20 MON float, with the shared hour reading zero
 * throughout because exempt top-ups were, by design, left out of it (D168's isolation,
 * correct on its own, became the hole once the scope itself had no ceiling of its own).
 *
 * A **fraction of the exempt pool itself** (`EXEMPT_PER_ADDRESS_SHARE_OF_POOL_PERCENT`),
 * not a fixed wei amount matched to the charged path's own per-address bound
 * (`FEE_PAID_MAX_MON_PER_ADDRESS_HOUR`, D172, tried first): that fixed figure read as
 * reasonable in isolation but happened to equal the whole exempt pool at the default
 * budgets (both 1 MON), so it protected nothing — one address alone could take
 * everything meant to be spread across every address that hour. Deriving it as a share
 * of the pool it sits inside of means it can never again equal or exceed that pool, at
 * any value of the total (including a tightened one) — the same reasoning
 * `EXEMPT_ALL_ADDRESSES_SHARE_PERCENT` already uses for the pool itself relative to the
 * whole shared ceiling. It is not the only per-address control the fee-paid path has
 * (D172's durable one-outstanding-top-up marker and refill-only-what-was-burned rule do
 * not run for exempt — recorded as a flagged residual, not fixed here, in D177/D178), so
 * this bound carries more weight than its fee-paid counterpart does. The rest of the
 * fix: funding only a real signed send with a verified next nonce, never a bare
 * estimate, and sizing every top-up to the operation's own signed prefund, never a flat
 * 0.30 MON (`prefund.ts`).
 */
export const EXEMPT_PER_ADDRESS_SHARE_OF_POOL_PERCENT = 40n;

export function effectiveExemptPerAddressHourCap(exemptAllAddressesHour: bigint): bigint {
  return (exemptAllAddressesHour * EXEMPT_PER_ADDRESS_SHARE_OF_POOL_PERCENT) / 100n;
}

/**
 * The most MON the relayer will put into one account's EntryPoint deposit over a rolling
 * 24 hours for a withdraw, a send, or a cancel. Added after security review finding 3
 * (second round, 2026-09-25): the exempt scope's rolling day is otherwise unbounded
 * (mirroring D168's fee-paid reasoning — a user must always be able to withdraw whatever
 * they have already drawn today), and without D172's landed-operation backstop applying
 * to exempt too, an hourly cap alone lets one address draw its full hourly cap every
 * single hour, forever: measured at ~0.93 MON/hour in one probe, about 22 MON in 24 hours
 * from a single address, well past the relayer's whole float.
 *
 * Set to the same code cap the ordinary sponsored per-address day already uses
 * (`PREFUND_MAX_MON`) — a value the owner has already reviewed, on the exempt ledger's own
 * separate pool, so it adds nothing to what an address may draw on the sponsored ledger
 * and does not reduce it either. An honest account withdrawing, sending or cancelling
 * enough in one day to reach 2 MON (at a typical ~0.15-0.45 MON top-up, upward of five such
 * actions in one day) is far outside ordinary use; it waits for the next day's window,
 * which is a materially smaller ask than "never refused for gas" and is recorded as a
 * deliberate, narrow exception to it in D177, the same way the hourly cap is.
 */
export const EXEMPT_MAX_MON_PER_ADDRESS_DAY = PREFUND_MAX_MON;

export const EXEMPT_MAX_WEI_PER_ADDRESS_DAY = EXEMPT_MAX_MON_PER_ADDRESS_DAY * WEI_PER_MON;

export function effectiveExemptPerAddressDayCap(envValue?: bigint): bigint {
  return tighten(EXEMPT_MAX_WEI_PER_ADDRESS_DAY, envValue);
}

/**
 * The most MON the relayer will put, across every address together, into exempt top-ups
 * (a withdraw, a send, a cancel) in one hourly window. Added after security review finding
 * 1 (second round, 2026-09-25): the first fix gave exempt its own full `allAddressesHour`
 * (5 MON by default) ON TOP OF the existing shared ceiling sponsored and fee-paid already
 * draw from, doubling the relayer's hourly payout to about 10 MON — an unreviewed change
 * to `PREFUND_ACCOUNTS_PER_HOUR`'s own owner-facing number, reproduced: ordinary sponsored
 * activity plus fresh-address withdraws paid 9.86 MON in one hour against the one number
 * the owner was shown, 5.
 *
 * This is carved OUT of that same shared ceiling, not added: `nonExemptAllAddressesHour`
 * below gives sponsored and fee-paid the remainder, so the two pools still sum to exactly
 * `PrefundBudgets.allAddressesHour`, the number already reviewed, at any value of it.
 * Exempt keeps its own separate ledger and sum (`db.ts`), so sponsored activity still can
 * never block a withdraw — carving the ceiling changes only how much of the SAME total
 * each side may draw, not whether one can starve the other.
 *
 * A **fraction** of the total (`EXEMPT_ALL_ADDRESSES_SHARE_PERCENT`), not a fixed wei
 * amount: a fixed amount does not shrink when `RELAYER_PREFUND_MAX_MON` tightens the total
 * (D177's own finding 5 residual, for the per-address caps below, which still are fixed).
 * A fixed 1 MON carve, tried first, zeroed the non-exempt side outright — and broke a
 * real, pre-existing test — the moment the total was tightened to 0.5 MON, which is
 * exactly the "owner lowers this to reduce exposure" case the tightening exists for.
 */
export const EXEMPT_ALL_ADDRESSES_SHARE_PERCENT = 20n;

export function effectiveExemptAllAddressesHourCap(allAddressesHour: bigint): bigint {
  return (allAddressesHour * EXEMPT_ALL_ADDRESSES_SHARE_PERCENT) / 100n;
}

/**
 * What sponsored and fee-paid top-ups together may still draw from the shared hourly
 * ceiling once exempt's own carved-out slice (`effectiveExemptAllAddressesHourCap`) is set
 * aside. Always exact: the two calls together account for the whole of `allAddressesHour`,
 * integer division's rounding-down landing on the non-exempt side.
 */
export function nonExemptAllAddressesHour(allAddressesHour: bigint): bigint {
  return allAddressesHour - effectiveExemptAllAddressesHourCap(allAddressesHour);
}

/** The three sponsorship budgets, in wei. See `PREFUND_MAX_MON`. */
export interface PrefundBudgets {
  /** One address, summed over the current hourly window and the 23 before it. */
  readonly perAddressDay: bigint;
  /** One address, the current hourly window. */
  readonly perAddressHour: bigint;
  /** Every address together, the current hourly window. */
  readonly allAddressesHour: bigint;
}

/**
 * The effective budgets, from the code cap and an optional environment value in wei.
 *
 * The environment tightens the daily figure and the other two follow from it, so a lower
 * `RELAYER_PREFUND_MAX_MON` lowers all three in proportion. It cannot raise any of them.
 */
export function prefundBudgets(envMaxWei?: bigint): PrefundBudgets {
  const perAddressDay = tighten(PREFUND_MAX_MON * WEI_PER_MON, envMaxWei);
  const perAddressHour = perAddressDay / 4n;
  return {
    perAddressDay,
    perAddressHour,
    allAddressesHour: perAddressHour * PREFUND_ACCOUNTS_PER_HOUR,
  };
}

/** The budgets with nothing tightened. */
export const PREFUND_BUDGETS: PrefundBudgets = prefundBudgets();

/** An order above the notional cap is refused, never trimmed to fit. */
export const REFUSE_IF_ORDER_ABOVE_CAP = true;

/**
 * The markets the live path may touch: whatever `kuru/liveMarkets.ts` last confirmed.
 *
 * Until 2026-09-23 this was a hardcoded array of four books. It is now a live,
 * read-only view of the active set in `liveMarkets.ts`:
 *
 *   - It can only ever hold markets from `TRADING_MARKET_CANDIDATES`, a fixed list in
 *     code: MON/USDC, WETH/USDC, cbBTC/USDC, XAUt0/USDC and emo/MON. Every address and
 *     param there was read on chain 143 (`reports/MARKETS-VERIFIED.md`, rule A2.5).
 *   - A candidate is in it while Kuru still lists it (`GET /api/v1/markets/<address>`)
 *     and its `getMarketParams()` still decodes with the pinned assets and scales. That
 *     is re-checked in the background every ten minutes, never on a request path.
 *   - Before the first check completes, and in any process that never called
 *     `configureLiveMarkets` (the browser, every test), it is MON/USDC alone.
 *   - Writes throw. Reading it starts a refresh when one is due.
 *
 * MON/AUSD and AUSD/USDC are no longer in it. Kuru still lists both, but neither trades:
 * zero 24h volume, AUSD/USDC reverts `MarketStateError`, MON/AUSD has an empty book. They
 * are shown, not traded (`DISABLED_MARKET_CANDIDATES`). WBTC/AUSD is gone entirely.
 * `/v1/bundler` still names AUSD/USDC explicitly for the funding conversion leg, which it
 * did before this list ever held it.
 *
 * The order is candidate order, MON/USDC first while it is confirmed. `/api/status` reads
 * every entry, so nothing depends on position any more.
 *
 * **What the cap still refuses.** The cap is per-order value in dollars, so it meets each
 * book's own resting minimum. Minimums valued by a zero-sender market sell of exactly
 * `minSize` on 2026-09-23 (`reports/MARKETS-VERIFIED.md` section 1; emo/MON's dollar
 * figure uses the MON/USDC mid 0.025861 read at block 107,310,277):
 *
 *   | book        | resting minimum   | worth                      | under the $6 cap?  |
 *   | MON/USDC    | 200 MON           | 5.3382 USDC                | yes, ~11% headroom |
 *   | WETH/USDC   | 0.002 WETH        | 5.5167 USDC                | yes, ~8% headroom  |
 *   | cbBTC/USDC  | 0.000125 cbBTC    | 10.8119 USDC               | **no**             |
 *   | XAUt0/USDC  | 0.002 XAUt0       | 8.6677 USDC                | **no**             |
 *   | emo/MON     | 200 emo           | 4.99899 MON, about $0.13   | yes                |
 *
 * So resting limit orders are impossible on cbBTC/USDC and XAUt0/USDC until the cap moves.
 * That is the cap doing its job, not a defect of this list. Market orders are not gated by
 * `minSize` (D125).
 *
 * emo/MON is quoted in native MON, not a dollar. Its orders are valued at the live
 * MON/USDC mid before they meet the cap (`assertQuoteAmountWithinCap` below, and
 * `chain/quoteValuation.ts`), in both places the cap is enforced.
 */
export const LIVE_MARKET_ALLOWLIST: readonly Address[] = activeMarketsView;

export class CapExceededError extends Error {
  constructor(
    readonly cap: string,
    message: string,
  ) {
    super(message);
    this.name = 'CapExceededError';
  }
}

/**
 * Resolve an effective limit from the code cap and an optional environment value.
 * The environment can only tighten.
 */
export function tighten(codeCap: bigint, envValue: bigint | undefined): bigint {
  if (envValue === undefined) return codeCap;
  if (envValue <= 0n) return codeCap;
  return envValue < codeCap ? envValue : codeCap;
}

export function effectiveOrderNotionalCap(envValue?: bigint): bigint {
  return tighten(MAX_ORDER_NOTIONAL_AUSD, envValue);
}

export function effectiveRelayerFloatCap(envValue?: bigint): bigint {
  return tighten(MAX_RELAYER_FLOAT_WEI, envValue);
}

/**
 * An order's notional in AUSD base units must sit under the cap.
 *
 * `REFUSE_IF_ORDER_ABOVE_CAP` is true, so an oversized order is rejected outright.
 * Silently reducing it to the cap would place an order the user did not ask for.
 *
 * This takes a figure that is already in cap units. An order's value in its own market's
 * quote units goes through `assertQuoteAmountWithinCap` instead.
 */
export function assertOrderWithinCap(notionalAusd: bigint, envCap?: bigint): void {
  const cap = effectiveOrderNotionalCap(envCap);
  if (notionalAusd <= 0n) {
    throw new CapExceededError('MAX_ORDER_NOTIONAL', 'order notional must be positive');
  }
  if (notionalAusd > cap) {
    if (!REFUSE_IF_ORDER_ABOVE_CAP) {
      throw new Error('unreachable: REFUSE_IF_ORDER_ABOVE_CAP is a constant true');
    }
    throw new CapExceededError(
      'MAX_ORDER_NOTIONAL',
      `order notional ${formatAusdCap(notionalAusd)} exceeds the hard cap of ` +
        `${formatAusdCap(cap)} AUSD. The cap is code, not config; it is not raisable ` +
        'from the environment.',
    );
  }
}

/**
 * An order's value, in its market's own quote-asset base units, must sit under the cap.
 *
 * The one check both sides of the signing boundary make: the ticket's `validate()` before
 * the user signs, and the relayer's `notional.ts` after. The quote asset is valued by
 * `quoteValuationFor` (`chain/quoteValuation.ts`): AUSD and USDC one-for-one, native MON
 * at `quoteUsdPrice`, the live MON/USDC mid the caller read. It fails closed twice over:
 *
 *   - a quote asset with no valuation is refused, never compared raw. That raw comparison
 *     is what used to make an 18-decimal MON order read as 170 billion times the cap;
 *   - a priced quote with no usable price is refused, never valued at a default.
 */
export function assertQuoteAmountWithinCap(
  quoteAmount: bigint,
  params: Pick<MarketParams, 'quoteAsset' | 'quoteDecimals'>,
  quoteUsdPrice?: bigint,
  envCap?: bigint,
): void {
  const valuation = quoteValuationFor(params);
  if (!valuation) {
    throw new CapExceededError(
      'MAX_ORDER_NOTIONAL',
      `orders quoted in this market's own asset (${params.quoteDecimals} decimals) cannot be ` +
        'valued in dollars, so they cannot be capped; refusing',
    );
  }
  const capUnits = quoteAmountInCapUnits(quoteAmount, valuation, quoteUsdPrice);
  if (capUnits === undefined) {
    throw new CapExceededError(
      'MAX_ORDER_NOTIONAL',
      `an order quoted in ${valuation.symbol} is valued at the live mid of its pricing ` +
        `book, and there is no usable mid to value it at; refusing rather than sponsoring ` +
        'an order of unknown size',
    );
  }
  assertOrderWithinCap(capUnits, envCap);
}

/**
 * The relayer must not hold more MON than the cap.
 *
 * This is checked on the way *in*, before the relayer is used: an over-funded hot key
 * is a larger loss if it leaks, and the cap is the owner's stated exposure limit.
 */
export function assertFloatWithinCap(balanceWei: bigint, envCap?: bigint): void {
  const cap = effectiveRelayerFloatCap(envCap);
  if (balanceWei > cap) {
    throw new CapExceededError(
      'MAX_RELAYER_FLOAT',
      `relayer holds ${balanceWei} wei, above the hard cap of ${cap} wei ` +
        `(${Number(cap) / 1e18} MON). Move the excess out before running.`,
    );
  }
}

/** Any market outside `LIVE_MARKET_ALLOWLIST` is refused on the live path. */
export function assertMarketAllowed(market: Address): void {
  // One snapshot, so the check and the message describe the same set.
  const allowed = getActiveMarkets();
  const target = market.toLowerCase();
  if (!allowed.some((m) => m.toLowerCase() === target)) {
    throw new CapExceededError(
      'LIVE_MARKET_ALLOWLIST',
      `${market} is not one of the markets the live path may touch (${allowed.join(', ')})`,
    );
  }
}

export function isMarketAllowed(market: Address): boolean {
  const target = market.toLowerCase();
  return getActiveMarkets().some((m) => m.toLowerCase() === target);
}

/** Display only. */
function formatAusdCap(units: bigint): string {
  const scale = 10n ** BigInt(AUSD_DECIMALS);
  return `${units / scale}.${(units % scale).toString().padStart(AUSD_DECIMALS, '0').slice(0, 2)}`;
}
