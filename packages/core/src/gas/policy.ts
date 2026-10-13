import { getAddress, type Address, type Hex } from 'viem';
import {
  assertMarketAllowed,
  assertOrderWithinCap,
  CapExceededError,
  isMarketAllowed,
  MAX_ORDER_NOTIONAL_AUSD,
} from '../chain/caps.js';
import { MARKET_CANDIDATES } from '../kuru/liveMarkets.js';
import { ENTRY_POINT_V08, SIMPLE_7702_DELEGATE } from './delegate.js';
import { FORWARDABLE_SELECTORS, isForwardableSelector, selectorOf } from '../kuru/orders.js';
import { KURU_FLOW_ROUTER } from '../kuru/flow.js';
import { KYBER_ROUTER } from '../swap/kyberRouter.js';
import { pinnedSwapRouter, readPinnedSwap, type PinnedSwapRead } from '../swap/routers.js';
import { MAINNET } from '../chain/addresses.js';
import type { SponsoredCall } from './account.js';
import { isGasFeeToken, MAX_GAS_FEE } from './gasFee.js';

/**
 * The sponsorship policy.
 *
 * Under the forwarder this list was "what the relayer will submit". Under 7702 it is
 * "what the paymaster will pay for", which is the same question with more at stake:
 * a sponsored user operation spends the project's money on a call the project did not
 * write. The allowlist is therefore unchanged in substance — same targets, same
 * 4-byte selectors, same caps — and is enforced server-side before the paymaster is
 * ever asked for a signature.
 *
 * What changed is what the relayer *is*. It no longer holds a MON float and no longer
 * signs transactions. It holds `PIMLICO_API_KEY`, applies this policy, and asks the
 * paymaster to sponsor what passes. It still never holds user funds and still never
 * signs on a user's behalf (rule A2.3) — under 7702 it cannot, because the only
 * signature that authorizes anything is the user's own over the user operation.
 */

/** `permit(address,address,uint256,uint256,uint8,bytes32,bytes32)` */
export const PERMIT_SELECTOR = '0xd505accf';

/** `deposit(address user, address token, uint256 amount)` on the MarginAccount. */
const MARGIN_DEPOSIT_SELECTOR = '0x8340f549';

/**
 * `approve(address spender, uint256 value)` (C1, 2026-09-25, owner's decision).
 *
 * Sponsorable in exactly one shape, the triple: `approve(pinnedSpender, exactAmount)`,
 * immediately followed by the one call that spends it (the Flow swap, or the
 * MarginAccount deposit), immediately followed by `approve(pinnedSpender, 0)` on the
 * same token. The doc comment that used to sit on `SPONSORED_TRANSFER_TOKENS` said an
 * approval "is unbounded in time and amount, which is the opposite of what a per-call
 * cap bounds" — that was true of a lone approval, and it is exactly what the triple
 * removes: the amount is exact against the spend beside it, and the batch that opens
 * the allowance closes it, atomically, so no allowance can outlive the operation
 * whatever the spend did. That structural bound is what stands in for
 * `MAX_SPONSORED_PERMIT_VALUE` on tokens whose base units are not dollars (see
 * `assertSponsoredApprove`).
 */
export const APPROVE_SELECTOR = '0x095ea7b3';

/**
 * `deposit()` on WMON, the canonical WETH9 wrap: payable, no arguments, credits the
 * caller with wrapped tokens for the native value sent. The selector is the keccak of
 * the literal signature `deposit()`; that WMON is a WETH9-style wrapper with this entry
 * point is the mechanism `lib/wallet/holdings.ts` recorded when MON move-out was first
 * scoped, and it is probed live against the pinned WMON address before any deploy that
 * enables the wrap (D3).
 */
export const WMON_DEPOSIT_SELECTOR = '0xd0e30db0';

/**
 * `withdraw(uint256 wad)` on WMON, the canonical WETH9 unwrap: burns the caller's
 * wrapped balance and sends the same amount of native MON back to the caller —
 * nobody else can be the recipient, by the wrapper's own construction. Sponsorable
 * in exactly one place: directly after a Flow swap that delivered WMON, turning a
 * swap-into-MON (B3) into actual native MON the account can pay its own gas with
 * (`assertWmonUnwrap`). The batch's ending balance must clear Monad's delegated
 * reserve, which is why the client falls back to delivering WMON, and says so, when
 * the swap is too small to end at 10 MON (B3's own rule).
 */
export const WMON_WITHDRAW_SELECTOR = '0x2e1a7d4d';

/**
 * How long a sponsored permit may live. Rule A4 says ten minutes, and a sponsored
 * permit is the one signature that lets somebody else move the user's tokens, so the
 * window is checked here rather than trusted from wherever it was built.
 */
export const MAX_SPONSORED_PERMIT_SECONDS = 600;

/**
 * How long a sponsored permit must still have to run: two minutes (independent review,
 * 2026-09-24, fourth round). A permit signed to expire a second from now passed every check
 * and the relayer's funded-run simulation, which runs at "now", then expired before the
 * bundle executed a second or two later: nothing mined, no fee, a top-up left in a deposit
 * the user can withdraw. The browser signs 300 seconds (`TOP_UP_DEADLINE_SECONDS`,
 * `SWAP_DEADLINE_SECONDS`), so this refuses nothing honest. The relayer also simulates the
 * funded run 120 seconds ahead, which covers a deadline this policy cannot read.
 */
export const MIN_SPONSORED_PERMIT_SECONDS = 120;

/**
 * The most a sponsored permit may ever be worth, in quote base units.
 *
 * A4 says "exact amount", and the amount is checked against the swap it pays for. That
 * check alone is not enough: the swap's calldata is a Flow route we have no verified ABI
 * for, so "the amount appears in the calldata" is evidence, not proof. Two of that
 * calldata's words are token addresses, and an address read as a uint256 is about 1e48 —
 * so without a ceiling, a permit for 6.7e41 USDC matches a genuine, unedited swap and
 * leaves a standing allowance behind. The ceiling is what makes the evidence safe: every
 * word that could collide is now either rejected or worth less than a hundredth of a
 * cent. Same cap as an order, because a swap is the same size of thing.
 */
export const MAX_SPONSORED_PERMIT_VALUE = MAX_ORDER_NOTIONAL_AUSD;

/** `permit(owner, spender, value, deadline, v, r, s)` — selector plus seven static words. */
const PERMIT_CALLDATA_LENGTH = 2 + 8 + 7 * 64;

/**
 * Where a Flow swap carries the token it spends and how much of it.
 *
 * The router is unverified on the explorer and publishes no ABI, so this is not read
 * from a signature — it is the correspondence observed between quote requests we
 * controlled and the calldata that came back, on 2026-09-03:
 *
 *   USDC -> AUSD   1000000   19 words
 *   AUSD -> USDC   2500000   19 words
 *   USDC -> USDT0   777000   20 words
 *
 * plus the quote recorded on 2026-09-02. In all four, word 0 is tokenOut, word 2 is
 * tokenIn and word 3 is amountIn, across two different route lengths. Treat it as a
 * measurement rather than a specification: if a route ever lays its calldata out
 * differently these checks stop matching and the batch is refused, which is the
 * direction a wrong guess should fail in. `MAX_SPONSORED_PERMIT_VALUE` still bounds
 * the damage if the measurement is ever wrong in the other direction. The positions live
 * in `swap/routers.ts` (`readPinnedSwap`), beside KyberSwap's verified-ABI decode.
 */

/**
 * The only two spenders a sponsored permit may name, per A4 as widened on 2026-09-03.
 *
 * Built from the address book and the router constant, never from the caller's
 * `PolicyContext`. A caller-supplied margin account would mean "two pinned constants"
 * was only true for one of them, and a batch could name any spender it liked simply by
 * passing a matching context.
 */
/**
 * `transfer(address,uint256)`. The only selector a sponsored send may carry.
 */
export const TRANSFER_SELECTOR = '0xa9059cbb';

/**
 * The three dollar-par tokens, pinned in code.
 *
 * Until 2026-09-25 this was the whole set a sponsored `transfer` could move (D128,
 * widened from "no transfers at all" on 2026-09-09). The any-token wallet (owner's
 * decision, C1/D1) widens a sponsored `transfer` to any ERC-20 the user holds — the
 * transfer spends the user's own balance, the recipient checks and the shape checks
 * are token-independent, and a wallet that can only send three tokens is not an
 * any-token wallet. What this list still pins is **valuation**: these three are
 * six-decimal dollar stablecoins whose base units the AUSD-denominated cap applies to
 * directly, so a transfer or an approval of one of them is capped at par. A token not
 * on this list has no price this policy can read without I/O, and per the owner's C2
 * decision the cap does not apply to it — the cap protects the user from mispriced
 * orders, not the relayer from gas, and gas is bounded by the sponsorship budgets.
 */
export const SPONSORED_TRANSFER_TOKENS: readonly string[] = [
  MAINNET.tokens.AUSD.address,
  MAINNET.tokens.USDC.address,
  MAINNET.tokens.USDT0.address,
].map((a) => a.toLowerCase());

/**
 * Addresses a sponsored transfer may not be sent TO.
 *
 * Every contract this sponsorship policy names, plus the zero address. Sending a token to a
 * token contract, to the MarginAccount, to an order book or to the EntryPoint is
 * almost always a mistake and is never something this app should pay to help with —
 * the money does not arrive anywhere the user can reach it. It is a refusal rather
 * than a warning because the relayer is deciding what to *fund*, not what the user is
 * permitted to do with their own keys.
 *
 * Not a completeness claim: an unknown contract is still allowed, and the screen warns
 * about code at the address. This bounds the cases we can actually name.
 */
export const SPONSORED_TRANSFER_FORBIDDEN_RECIPIENTS: readonly string[] = [
  '0x0000000000000000000000000000000000000000',
  MAINNET.tokens.AUSD.address,
  MAINNET.tokens.USDC.address,
  MAINNET.tokens.USDT0.address,
  MAINNET.tokens.WMON.address,
  MAINNET.kuru.marginAccount,
  MAINNET.kuru.router,
  MAINNET.kuru.forwarder,
  MAINNET.kuru.forwarderImplementation,
  // The OFT adapter is a plausible paste target for a user who has just bridged AUSD
  // in through it, and a raw transfer to it is unrecoverable.
  MAINNET.ausdOftAdapter,
  KURU_FLOW_ROUTER,
  KYBER_ROUTER,
  ENTRY_POINT_V08,
  SIMPLE_7702_DELEGATE,
  // Every order book this app knows, traded or not, rather than the live allowlist: the
  // allowlist now changes at runtime, and a transfer to a book is a lost transfer
  // whether or not the book is trading today.
  ...MARKET_CANDIDATES.map((c) => c.address),
  // WBTC/AUSD, dropped from the market lists on 2026-09-23 but still a Kuru order book.
  // A deny list only grows: removing it would newly sponsor a transfer into it.
  '0xbdc776284bf593981b1f0237f053a7ad11eb596f',
].map((a) => a.toLowerCase());

const PINNED_PERMIT_SPENDERS: readonly string[] = [
  MAINNET.kuru.marginAccount,
  KURU_FLOW_ROUTER,
].map((a) => a.toLowerCase());

// Deliberately mainnet-only. Merging TESTNET's margin account in as well made the set
// mode-blind: it is `undefined` today, so the list happened to come out right, but the
// day testnet gets a MarginAccount a *mainnet* relayer would start accepting it as a
// permit spender. When testnet needs one it gets pinned per mode, explicitly.
if (
  PINNED_PERMIT_SPENDERS.length !== 2 ||
  PINNED_PERMIT_SPENDERS.some((a) => !/^0x[0-9a-f]{40}$/.test(a))
) {
  throw new Error('the pinned permit spenders must be exactly two real addresses');
}

export interface PolicyContext {
  /** Kuru's MarginAccount. Deposits and withdrawals target it. */
  readonly marginAccount: Address;
  /** Order books this policy will sponsor. Empty means "the live market allowlist". */
  readonly markets?: readonly Address[];
  /**
   * Tokens whose `permit` may be sponsored, so an approval and a deposit can travel
   * in one atomic user operation. `permit` is the only selector allowed on these
   * addresses — no `transfer`, no `approve`, nothing else.
   */
  readonly permitTokens?: readonly Address[];
  /** Notional per order, in quote base units. Omitted uses the code cap. */
  readonly notionalOf?: (call: SponsoredCall) => bigint | undefined;
  /** Injected in tests; defaults to the wall clock. */
  readonly now?: () => number;
  /**
   * The relayer's fee, when this relayer can be paid one. Built by the relayer from its
   * own configuration and its own computation, never from anything a client sent.
   *
   * With it present, a transfer to `recipient` (or a margin deposit crediting it) is
   * refused anywhere except as the fee leg `splitFeeLeg` describes, and the fee leg must
   * be what `expected` says:
   *
   *   'none'       this batch is not charged: no fee leg, and nothing may pay `recipient`;
   *   'unpriced'   an estimate of a charged batch: one well-formed fee leg, amount not yet
   *                known (the operation's own gas limits are what price it);
   *   {token, amount}  a send of a charged batch: exactly this fee leg and no other.
   *
   * Absent, nothing about a fee is recognised, which is how this policy behaved before.
   */
  readonly gasFee?: {
    readonly recipient: Address;
    readonly expected: 'none' | 'unpriced' | { readonly token: Address; readonly amount: bigint };
  };
  /**
   * Every address the relayer controls: its own signing address (the hot key) and its fee
   * address, whatever they are today. None may appear anywhere in a sponsored batch, as a
   * call target or anywhere in any call's bytes, with one exception: `gasFee.recipient` as
   * the recipient of the verified fee leg (D168). Kept apart from `gasFee` so the hot key
   * stays forbidden after the fee address moves off it (D169), and on a relayer that
   * charges nothing. Built by the relayer from its own key and configuration.
   */
  readonly relayerAddresses?: readonly Address[];
  /**
   * The account the batch executes as, when the caller knows it (the relayer always
   * does: the operation's own `sender`). With it, a pinned router swap that names its
   * receiver (KyberSwap's decoded `dstReceiver`) must name this account or the zero
   * address (which the router reads as "the caller", i.e. this account). Absent, the
   * receiver check falls back to refusing any non-zero receiver that could not be
   * compared, never to trusting it.
   */
  readonly sender?: Address;
}

export class PolicyViolation extends Error {
  constructor(
    readonly reason:
      | 'TARGET_NOT_ALLOWED'
      | 'SELECTOR_NOT_ALLOWED'
      | 'VALUE_NOT_ZERO'
      | 'CAP_EXCEEDED'
      | 'EMPTY_BATCH'
      // A sponsored permit named someone other than the two pinned spenders, or a
      // permit to the Flow router was not paired with the swap it is for.
      | 'SPENDER_NOT_ALLOWED'
      | 'PERMIT_AMOUNT_INVALID'
      | 'DEADLINE_TOO_FAR'
      // Expires within MIN_SPONSORED_PERMIT_SECONDS: it could expire before the bundle runs.
      | 'DEADLINE_TOO_SOON'
      // The permit named a token the paired swap never touches, or its calldata was
      // not a well-formed `permit` at all.
      | 'PERMIT_TOKEN_MISMATCH'
      | 'PERMIT_MALFORMED'
      // A payment to the relayer that is not the exact fee leg the relayer computed for
      // this operation: the wrong amount, token or position, a fee on a batch that is not
      // charged, a charged batch with no fee, or a payment to the relayer standing alone.
      | 'FEE_LEG_MISMATCH',
    message: string,
  ) {
    super(message);
    this.name = 'PolicyViolation';
  }
}

/**
 * Decide whether a batch of calls may be sponsored. Throws on the first violation;
 * a partially-sponsored batch is not a thing.
 */
export function assertSponsorable(calls: readonly SponsoredCall[], context: PolicyContext): void {
  if (calls.length === 0) {
    throw new PolicyViolation('EMPTY_BATCH', 'nothing to sponsor');
  }

  // Before anything else, so no branch below can let a payment to the relayer through on
  // other terms. -1 when the batch carries no fee leg.
  const feeTransferIndex = context.gasFee
    ? assertFeeLeg(calls, context.marginAccount, context.gasFee)
    : -1;
  assertNoRelayerAddress(calls, context);
  // The action calls end where the fee leg (always the last two calls) begins.
  const actionsEnd = feeTransferIndex === -1 ? calls.length : feeTransferIndex - 1;

  for (const [index, call] of calls.entries()) {
    if ((call.value ?? 0n) !== 0n) {
      // A sponsored call that moves MON would both spend the user's reserve and
      // break the "never holds MON" promise, with three exceptions (D200 added the
      // last two to D3/rule 1.8's wrap): the WMON wrap (the user's own MON into the
      // user's own WMON, beside a margin withdrawal, or as the whole action or the
      // head of a MON-input swap); a plain native send, data-less like any other
      // simple transfer; or native MON straight into the margin deposit it funds —
      // Kuru's own MarginAccount takes native MON directly this way, confirmed on
      // mainnet, no WMON wrap needed.
      if (call.data === '0x') {
        assertSponsoredNativeSend(call);
        continue;
      }
      if (
        call.to.toLowerCase() === context.marginAccount.toLowerCase() &&
        call.data.length >= 10 &&
        selectorOf(call.data) === MARGIN_DEPOSIT_SELECTOR
      ) {
        assertNativeMarginDeposit(call, context);
        continue;
      }
      assertWmonWrap(calls, index, call, actionsEnd);
      continue;
    }

    if (call.data.length < 10) {
      throw new PolicyViolation('SELECTOR_NOT_ALLOWED', 'calldata carries no selector');
    }

    const isMargin = call.to.toLowerCase() === context.marginAccount.toLowerCase();
    const swapRouter = pinnedSwapRouter(call.to);
    const isSwapRouter = swapRouter !== undefined;
    const allowedMarket = context.markets
      ? context.markets.some((m) => m.toLowerCase() === call.to.toLowerCase())
      : isMarketAllowed(call.to);
    const isPermitToken = (context.permitTokens ?? []).some(
      (t) => t.toLowerCase() === call.to.toLowerCase(),
    );
    /** A token, as far as dispatch cares: not one of the contracts with their own
     *  branch — and never a KNOWN order book, whether or not the caller's context
     *  named it (D182 residual R4): a book is not a token, and letting a transfer or
     *  approve shape claim one would only ever reach the chain to revert. */
    const isTokenTarget = !isMargin && !isSwapRouter && !allowedMarket && !isMarketAllowed(call.to);

    // A sponsored send, of any ERC-20 the user holds (D1, owner's decision 2026-09-25;
    // three pinned dollar tokens before that, D128). Checked BEFORE the permit branch,
    // because permit tokens are sendable too and that branch refuses everything but
    // `permit`. The transfer spends the sender's own balance; what stays narrow is the
    // shape (`assertSponsoredTransfer`): a clean recipient that is no contract this app
    // can name, a positive amount, and the notional cap at par for dollar tokens.
    if (isTokenTarget && selectorOf(call.data) === TRANSFER_SELECTOR) {
      // The fee leg's transfer, and only it, is bounded by `assertFeeLeg` instead: the
      // pinned recipient, a fee token, and exactly the relayer's computed amount.
      if (index === feeTransferIndex) continue;
      assertSponsoredTransfer(call);
      continue;
    }

    // A sponsored approval (C1/D2): only ever as part of the exact triple. Checked
    // before the permit branch so the triple works on permit tokens too — the client
    // prefers permit where a token supports it, but the policy bound is the same.
    if (isTokenTarget && selectorOf(call.data) === APPROVE_SELECTOR) {
      assertSponsoredApprove(calls, index, call, context);
      continue;
    }

    // The WMON unwrap (B3): only directly after the Flow swap that delivered the
    // WMON being unwrapped, so a swap into MON really ends as native MON.
    if (isTokenTarget && selectorOf(call.data) === WMON_WITHDRAW_SELECTOR) {
      assertWmonUnwrap(calls, index, call, actionsEnd);
      continue;
    }

    if (isPermitToken) {
      // A permit token may otherwise be called for exactly one thing.
      if (selectorOf(call.data) !== PERMIT_SELECTOR) {
        throw new PolicyViolation(
          'SELECTOR_NOT_ALLOWED',
          `only permit() may be sponsored on ${call.to}, not ${selectorOf(call.data)}`,
        );
      }
      assertPermitSpenderAllowed(calls, index, call, context);
      continue;
    }

    // A pinned swap router (Kuru Flow, KyberSwap; rule 1.9) is a sponsorable target for
    // exactly one selector each: its swap. Pinned constants, never configuration, so no
    // context can introduce a different router, and any other call to one is refused
    // like any other address.
    if (swapRouter) {
      if (selectorOf(call.data) !== swapRouter.selector) {
        throw new PolicyViolation(
          'SELECTOR_NOT_ALLOWED',
          `only the swap may be sponsored on the ${swapRouter.vendor} router, not ${selectorOf(call.data)}`,
        );
      }
      const read = readPinnedSwap(call.to, call.data);
      if (!read) {
        throw new PolicyViolation(
          'SELECTOR_NOT_ALLOWED',
          `this ${swapRouter.vendor} swap is not one this policy can read, so it is not sponsored`,
        );
      }
      assertSwapPaysSender(read, context);
      // A swap is sponsorable ONLY as the second half of the allowance that paid for
      // it: a permit to the router, or the opening approve of a C1 triple (validated
      // in full at its own index — the loop reached it one call ago).
      //
      // Allowing the router on the strength of its selector alone made *any* route
      // calldata sponsorable, and a route is a command stream we cannot read: of the
      // fourteen words in the recorded quote this policy checks two, and the packed
      // blob at the end carries its own copy of the amount. A swap with no allowance
      // in front of it spends whatever allowance the user already has, for an amount
      // the head words do not have to agree with. Pairing is what bounds it: the
      // permit ahead of it is exact, capped, and expires in ten minutes, and the
      // approve ahead of it is exact and revoked by the call behind it.
      const previous = calls[index - 1];
      const routerLower = swapRouter.address.toLowerCase();
      // A permit is only ever to the Flow router (PINNED_PERMIT_SPENDERS); KyberSwap is
      // paid by the approve triple alone.
      const paidByPermit =
        previous !== undefined &&
        previous.data.length >= 10 &&
        selectorOf(previous.data) === PERMIT_SELECTOR &&
        (() => {
          try {
            return decodePermit(previous.data).spender.toLowerCase() === routerLower;
          } catch {
            return false;
          }
        })();
      const paidByApprove =
        previous !== undefined &&
        previous.data.length >= 10 &&
        selectorOf(previous.data) === APPROVE_SELECTOR &&
        (() => {
          try {
            const opened = decodeApprove(previous.data);
            return opened.spender.toLowerCase() === routerLower && opened.value > 0n;
          } catch {
            return false;
          }
        })();
      if (!paidByPermit && !paidByApprove) {
        throw new PolicyViolation(
          'TARGET_NOT_ALLOWED',
          `a ${swapRouter.vendor} swap may only be sponsored directly after the permit or exact approval that pays for it`,
        );
      }
      continue;
    }

    if (!isMargin && !allowedMarket) {
      try {
        assertMarketAllowed(call.to);
      } catch (error) {
        if (error instanceof CapExceededError) {
          throw new PolicyViolation('TARGET_NOT_ALLOWED', error.message);
        }
        throw error;
      }
    }

    if (!isForwardableSelector(call.data)) {
      throw new PolicyViolation(
        'SELECTOR_NOT_ALLOWED',
        `selector ${selectorOf(call.data)} is not sponsorable`,
      );
    }

    const notional = context.notionalOf?.(call);
    if (notional !== undefined) {
      try {
        assertOrderWithinCap(notional);
      } catch (error) {
        if (error instanceof CapExceededError) {
          throw new PolicyViolation('CAP_EXCEEDED', error.message);
        }
        throw error;
      }
    }
  }
}

export function isSponsorable(calls: readonly SponsoredCall[], context: PolicyContext): boolean {
  try {
    assertSponsorable(calls, context);
    return true;
  } catch {
    return false;
  }
}

function readPermitWord(data: Hex, wordIndex: number): Hex {
  const start = 2 + 8 + wordIndex * 64;
  return `0x${data.slice(start, start + 64)}` as Hex;
}

interface DecodedPermit {
  readonly spender: Address;
  readonly value: bigint;
  readonly deadline: bigint;
}

/**
 * Read `permit(owner, spender, value, deadline, v, r, s)`.
 *
 * Length is checked before anything is sliced, and every decode failure is turned into a
 * `PolicyViolation`. Both matter: this runs on an unauthenticated request, and a raw
 * `InvalidAddressError` escaping the policy is a 500 rather than a refusal — which reads
 * to a caller as "the server broke", not "your batch was rejected".
 */
function decodePermit(data: Hex): DecodedPermit {
  if (data.length !== PERMIT_CALLDATA_LENGTH) {
    throw new PolicyViolation(
      'PERMIT_MALFORMED',
      `a sponsored permit must carry seven words of arguments, this one has ${data.length - 10} hex characters`,
    );
  }
  try {
    const spenderWord = readPermitWord(data, 1).slice(2);
    // The top twelve bytes of an address word must be zero. A token's own decoder
    // either masks them away or reverts, so this is not exploitable — but the whole
    // job of this function is to agree with what the chain will see, and a word it
    // would read differently is one we should not be reading at all.
    if (!/^0{24}/.test(spenderWord)) {
      throw new PolicyViolation(
        'PERMIT_MALFORMED',
        'the permit spender word is not a clean address',
      );
    }
    return {
      spender: getAddress(`0x${spenderWord.slice(-40)}`),
      value: BigInt(readPermitWord(data, 2)),
      deadline: BigInt(readPermitWord(data, 3)),
    };
  } catch {
    throw new PolicyViolation('PERMIT_MALFORMED', 'a sponsored permit could not be decoded');
  }
}

/**
 * Which spender a sponsored permit may name, and what must follow it.
 *
 * A sponsored permit is the most dangerous call this app makes: it hands somebody the
 * right to move the user's tokens, inside a batch the user approved as "move my money".
 * So four things are checked, and none of them trusts the caller:
 *
 *  1. the spender is one of two **code** constants (never `context`);
 *  2. the value is non-zero and at or under `MAX_SPONSORED_PERMIT_VALUE`;
 *  3. the deadline is inside ten minutes and has not already passed;
 *  4. a permit to the Flow router is followed immediately by a swap on that router,
 *     for that same token, carrying that same amount as a whole 32-byte word.
 *
 * Point 4 is evidence rather than proof — we have no verified ABI for the Flow route, so
 * we can say the amount and the token appear in the call, not which parameter they are.
 * Point 2 is what makes that evidence safe to act on; see the constant.
 */
function assertPermitSpenderAllowed(
  calls: readonly SponsoredCall[],
  index: number,
  call: SponsoredCall,
  context: PolicyContext,
): void {
  const { spender, value, deadline } = decodePermit(call.data);

  if (!PINNED_PERMIT_SPENDERS.includes(spender.toLowerCase())) {
    throw new PolicyViolation(
      'SPENDER_NOT_ALLOWED',
      `a sponsored permit may only name the margin account or the Kuru Flow router, not ${spender}`,
    );
  }
  const isFlowSpender = spender.toLowerCase() === KURU_FLOW_ROUTER.toLowerCase();

  // Applies to both spenders. A permit to the margin account was previously unbounded,
  // so `permit(MAX_UINT256)` alongside a one-dollar deposit was sponsorable.
  if (value === 0n || value > MAX_SPONSORED_PERMIT_VALUE) {
    throw new PolicyViolation(
      'PERMIT_AMOUNT_INVALID',
      `a sponsored permit is for at most ${MAX_SPONSORED_PERMIT_VALUE} base units, not ${value}`,
    );
  }

  const nowSeconds = BigInt(Math.floor((context.now?.() ?? Date.now()) / 1000));
  if (deadline > nowSeconds + BigInt(MAX_SPONSORED_PERMIT_SECONDS)) {
    throw new PolicyViolation(
      'DEADLINE_TOO_FAR',
      `a sponsored permit expires within ${MAX_SPONSORED_PERMIT_SECONDS / 60} minutes`,
    );
  }
  if (deadline <= nowSeconds) {
    throw new PolicyViolation('DEADLINE_TOO_FAR', 'a sponsored permit has already expired');
  }
  if (deadline < nowSeconds + BigInt(MIN_SPONSORED_PERMIT_SECONDS)) {
    throw new PolicyViolation(
      'DEADLINE_TOO_SOON',
      `a sponsored permit must still have ${MIN_SPONSORED_PERMIT_SECONDS / 60} minutes to run`,
    );
  }

  if (!isFlowSpender) {
    // "Exact amount" applies to the margin account too, and an amount is only exact
    // against something. A permit alone in a batch, or a $6 permit in front of a $1
    // deposit, both leave a standing allowance behind that nothing in the batch spends.
    const next = calls[index + 1];
    if (!next || next.to.toLowerCase() !== spender.toLowerCase()) {
      throw new PolicyViolation(
        'SPENDER_NOT_ALLOWED',
        'a permit to the margin account must be followed by the deposit it is for',
      );
    }
    if (selectorOf(next.data) !== MARGIN_DEPOSIT_SELECTOR) {
      throw new PolicyViolation(
        'SELECTOR_NOT_ALLOWED',
        `the call after a margin permit must be the deposit, not ${selectorOf(next.data)}`,
      );
    }
    // deposit(address user, address token, uint256 amount)
    const depositToken = `0x${readPermitWord(next.data, 1).slice(-40)}`;
    if (depositToken.toLowerCase() !== call.to.toLowerCase()) {
      throw new PolicyViolation(
        'PERMIT_TOKEN_MISMATCH',
        `this permit is for ${call.to} but the deposit moves ${depositToken}`,
      );
    }
    if (BigInt(readPermitWord(next.data, 2)) !== value) {
      throw new PolicyViolation(
        'PERMIT_AMOUNT_INVALID',
        'the permitted amount is not the amount the deposit moves',
      );
    }
    return;
  }

  // An allowance to the router is only allowed as half of a swap.
  const next = calls[index + 1];
  if (!next) {
    throw new PolicyViolation(
      'SPENDER_NOT_ALLOWED',
      'a permit to the Flow router must be followed by the swap it is for',
    );
  }
  if (next.to.toLowerCase() !== KURU_FLOW_ROUTER.toLowerCase()) {
    throw new PolicyViolation(
      'SPENDER_NOT_ALLOWED',
      `a permit to the Flow router must be followed by a call to that router, not ${next.to}`,
    );
  }
  // "That same token, that same amount", read off the swap at the positions where a
  // Flow route puts them. Not "mentioned somewhere in the calldata": the output token is
  // mentioned too, so a mention test lets a permit on AUSD ride along with a swap that
  // only ever spends USDC, leaving an allowance behind on a token the batch never used.
  assertSwapSpends(next, call.to, value, 'permit');
}

/**
 * The spend half of an allowance to a pinned router: that router's own swap, spending
 * exactly `token` and exactly `value`. Shared by the Flow permit path and the approve
 * triple on either router.
 */
function assertSwapSpends(
  spend: SponsoredCall,
  token: Address,
  value: bigint,
  kind: 'permit' | 'approval',
): PinnedSwapRead {
  const router = pinnedSwapRouter(spend.to);
  if (!router || selectorOf(spend.data) !== router.selector) {
    throw new PolicyViolation(
      'SELECTOR_NOT_ALLOWED',
      `the call after a router ${kind} must be that router's swap, not ${selectorOf(spend.data)}`,
    );
  }
  const read = readPinnedSwap(spend.to, spend.data);
  if (!read) {
    throw new PolicyViolation(
      'PERMIT_TOKEN_MISMATCH',
      'the paired swap is too short or malformed to say which token it spends',
    );
  }
  if (read.tokenIn.toLowerCase() !== token.toLowerCase()) {
    throw new PolicyViolation(
      'PERMIT_TOKEN_MISMATCH',
      `this ${kind} is for ${token} but the swap spends ${read.tokenIn}`,
    );
  }
  if (read.amountIn !== value) {
    throw new PolicyViolation(
      'PERMIT_AMOUNT_INVALID',
      `the ${kind === 'permit' ? 'permitted' : 'approved'} amount is not the amount the swap spends`,
    );
  }
  return read;
}

/**
 * A router swap that names its receiver must pay the account itself (R4, rule 1.1).
 * Kyber's `dstReceiver` is decoded from verified ABI; zero means "the caller", which is
 * the account. Flow names no receiver and pays the caller by construction.
 */
function assertSwapPaysSender(read: PinnedSwapRead, context: PolicyContext): void {
  const recipient = read.recipient;
  if (recipient === undefined) return;
  if (recipient === '0x0000000000000000000000000000000000000000') return;
  if (!context.sender || recipient.toLowerCase() !== context.sender.toLowerCase()) {
    throw new PolicyViolation(
      'TARGET_NOT_ALLOWED',
      `a sponsored swap must pay the account that signs it, not ${recipient}`,
    );
  }
}

/**
 * A sponsored `transfer` on any token: who it may go to, and how much.
 *
 * `transfer(address to, uint256 value)` is two 32-byte words after the selector, so it
 * is read by slicing rather than by pulling in an ABI decoder — the same discipline
 * `flowCalldataWords` uses, and it means a malformed or padded call cannot decode into
 * something that looks reasonable.
 */
function assertSponsoredTransfer(call: SponsoredCall): void {
  const body = call.data.slice(10);
  if (body.length < 128) {
    throw new PolicyViolation(
      'SELECTOR_NOT_ALLOWED',
      'a sponsored transfer must carry a recipient and an amount',
    );
  }
  const recipientWord = body.slice(0, 64);
  // The top 12 bytes of an address word must be zero; anything else is not an address.
  if (!/^0{24}[0-9a-fA-F]{40}$/.test(recipientWord)) {
    throw new PolicyViolation('TARGET_NOT_ALLOWED', 'the transfer recipient is not an address');
  }
  const recipient = `0x${recipientWord.slice(24)}`.toLowerCase();
  if (SPONSORED_TRANSFER_FORBIDDEN_RECIPIENTS.includes(recipient)) {
    throw new PolicyViolation(
      'TARGET_NOT_ALLOWED',
      `${recipient} is a contract this app knows, and a sponsored transfer may not be sent to one`,
    );
  }

  const value = BigInt(`0x${body.slice(64, 128)}`);
  if (value === 0n) {
    throw new PolicyViolation('CAP_EXCEEDED', 'a sponsored transfer must move a positive amount');
  }
  assertDollarParCap(call.to, value);
}

/**
 * A sponsored plain native-MON send (D200): no calldata, a positive value, to
 * anywhere this policy does not already name as one of its own contracts — the
 * same bound `assertSponsoredTransfer` puts on an ERC-20 transfer, for the same
 * reason (the money does not arrive anywhere the user can reach it, otherwise).
 * No dollar-par cap: MON has no par to check against.
 */
function assertSponsoredNativeSend(call: SponsoredCall): void {
  if (call.data !== '0x') {
    throw new PolicyViolation('SELECTOR_NOT_ALLOWED', 'a sponsored native send carries no calldata');
  }
  const recipient = call.to.toLowerCase();
  if (SPONSORED_TRANSFER_FORBIDDEN_RECIPIENTS.includes(recipient)) {
    throw new PolicyViolation(
      'TARGET_NOT_ALLOWED',
      `${recipient} is a contract this app knows, and a sponsored native send may not be sent to one`,
    );
  }
  if ((call.value ?? 0n) === 0n) {
    throw new PolicyViolation('CAP_EXCEEDED', 'a sponsored native send must move a positive amount');
  }
}

/** `deposit(address,address,uint256)`: a selector and three words. */
const MARGIN_DEPOSIT_CALL_LENGTH = 2 + 8 + 3 * 64;

/**
 * A sponsored native-MON margin deposit (D200): `MarginAccount.deposit(user,
 * NATIVE_SENTINEL, amount)` with `value` equal to `amount`, crediting the
 * account's own MON trading balance. Confirmed on mainnet (2,125 prior calls at
 * exactly this shape, `getBalance`/`Deposit` both move) that Kuru's own
 * MarginAccount takes native MON directly like this — no WMON wrap needed, unlike
 * the swap path, which trades WMON throughout.
 */
/** A clean address word: the top 12 bytes zero, same discipline as
 *  `assertSponsoredTransfer`'s recipient check — a dirty high word is not an
 *  address this policy accepts, whatever the callee would make of it. */
function cleanAddressWord(word: string): string | undefined {
  return /^0{24}[0-9a-fA-F]{40}$/.test(word) ? word.slice(24).toLowerCase() : undefined;
}

function assertNativeMarginDeposit(call: SponsoredCall, context: PolicyContext): void {
  if (call.data.length !== MARGIN_DEPOSIT_CALL_LENGTH) {
    throw new PolicyViolation(
      'SELECTOR_NOT_ALLOWED',
      'a sponsored native deposit must carry exactly user, token and amount',
    );
  }
  const user = cleanAddressWord(argWord(call.data, 0));
  const token = cleanAddressWord(argWord(call.data, 1));
  const amount = BigInt(`0x${argWord(call.data, 2)}`);
  if (user === undefined || token === undefined) {
    throw new PolicyViolation(
      'TARGET_NOT_ALLOWED',
      'a sponsored native deposit must carry clean addresses for user and token',
    );
  }
  if (token !== '0'.repeat(40)) {
    throw new PolicyViolation(
      'TARGET_NOT_ALLOWED',
      'a sponsored native deposit must name the native-MON sentinel token',
    );
  }
  if (!context.sender || user !== context.sender.toLowerCase().slice(2)) {
    throw new PolicyViolation(
      'TARGET_NOT_ALLOWED',
      'a sponsored native deposit must credit the account that signs it',
    );
  }
  const value = call.value ?? 0n;
  if (value === 0n || value !== amount) {
    throw new PolicyViolation(
      'CAP_EXCEEDED',
      'a sponsored native deposit must carry exactly the value it claims to deposit',
    );
  }
}

/**
 * The notional cap, applied where this policy can honestly price without I/O: the three
 * pinned dollar tokens, whose six-decimal base units the AUSD-denominated cap compares
 * to directly. Any other token's value is unknown here, and per the owner's C2 decision
 * (2026-09-25) the cap does not apply to it: the cap protects the user from mispriced
 * orders, not the relayer from gas, and gas is bounded by the sponsorship budgets. The
 * amount stays exact against the spend beside it either way.
 */
function assertDollarParCap(token: Address, value: bigint): void {
  if (!SPONSORED_TRANSFER_TOKENS.includes(token.toLowerCase())) return;
  try {
    assertOrderWithinCap(value);
  } catch (error) {
    if (error instanceof CapExceededError) throw new PolicyViolation('CAP_EXCEEDED', error.message);
    throw error;
  }
}

interface DecodedApprove {
  readonly spender: Address;
  readonly value: bigint;
}

/** Read `approve(spender, value)`: a selector and exactly two clean words. */
function decodeApprove(data: Hex): DecodedApprove {
  if (data.length !== TWO_WORD_CALL_LENGTH) {
    throw new PolicyViolation(
      'PERMIT_MALFORMED',
      'a sponsored approval must carry a spender and an amount and nothing else',
    );
  }
  const spenderWord = argWord(data, 0);
  if (!/^0{24}[0-9a-fA-F]{40}$/.test(spenderWord)) {
    throw new PolicyViolation('PERMIT_MALFORMED', 'the approval spender word is not a clean address');
  }
  return {
    spender: getAddress(`0x${spenderWord.slice(24)}`),
    value: BigInt(`0x${argWord(data, 1)}`),
  };
}

/**
 * The C1/D2 triple, judged from its opening or closing half (2026-09-25, owner's
 * decision; every check reuses the exactness machinery the permit path already has):
 *
 *   token.approve(spender, amount)   spender is the Flow router or the MarginAccount,
 *                                    both code constants; amount is positive and exact;
 *   the spend                        the Flow swap whose tokenIn/amountIn words match,
 *                                    or MarginAccount.deposit(user, token, amount) —
 *                                    same token, same amount;
 *   token.approve(spender, 0)        the batch ends the allowance it opened.
 *
 * A zero approval standing anywhere else, or an opening approval without its spend and
 * its revoke, is refused. The dollar-par cap applies where a price is known (`C2`).
 */
function assertSponsoredApprove(
  calls: readonly SponsoredCall[],
  index: number,
  call: SponsoredCall,
  _context: PolicyContext,
): void {
  const { spender, value } = decodeApprove(call.data);
  // The PINNED margin account, never the context's (security review of D181,
  // finding 5): a caller-supplied margin account would make "two pinned spenders"
  // true for only one of them, exactly the hole the permit path's own
  // `PINNED_PERMIT_SPENDERS` comment describes.
  const margin = MAINNET.kuru.marginAccount.toLowerCase();
  const routerSpender = pinnedSwapRouter(spender);
  if (!routerSpender && spender.toLowerCase() !== margin) {
    throw new PolicyViolation(
      'SPENDER_NOT_ALLOWED',
      `a sponsored approval may only name a pinned swap router or the margin account, not ${spender}`,
    );
  }

  if (value === 0n) {
    // The closing half: two calls back must be the opening approval of this same
    // triple. The opening's own iteration validated the spend between them.
    const opening = calls[index - 2];
    const closesTriple =
      opening !== undefined &&
      opening.to.toLowerCase() === call.to.toLowerCase() &&
      opening.data.length >= 10 &&
      selectorOf(opening.data) === APPROVE_SELECTOR &&
      (() => {
        try {
          const decoded = decodeApprove(opening.data);
          return decoded.spender.toLowerCase() === spender.toLowerCase() && decoded.value > 0n;
        } catch {
          return false;
        }
      })();
    if (!closesTriple) {
      throw new PolicyViolation(
        'SPENDER_NOT_ALLOWED',
        'a zero approval may only close the approval opened two calls before it',
      );
    }
    return;
  }

  // The opening half: the spend must follow, and the revoke must follow that.
  const spend = calls[index + 1];
  const closing = calls[index + 2];
  if (!spend || !closing) {
    throw new PolicyViolation(
      'SPENDER_NOT_ALLOWED',
      'a sponsored approval travels as approve, the spend, then a zero approve, in one batch',
    );
  }
  if (
    closing.to.toLowerCase() !== call.to.toLowerCase() ||
    closing.data.length !== TWO_WORD_CALL_LENGTH ||
    selectorOf(closing.data) !== APPROVE_SELECTOR ||
    decodeApprove(closing.data).spender.toLowerCase() !== spender.toLowerCase() ||
    decodeApprove(closing.data).value !== 0n
  ) {
    throw new PolicyViolation(
      'SPENDER_NOT_ALLOWED',
      'the batch must end the exact allowance it opened: approve(spender, 0) on the same token',
    );
  }

  if (routerSpender) {
    if (spend.to.toLowerCase() !== routerSpender.address.toLowerCase()) {
      throw new PolicyViolation(
        'SPENDER_NOT_ALLOWED',
        `an approval to the ${routerSpender.vendor} router must be followed by a call to that router, not ${spend.to}`,
      );
    }
    // Same token, same amount, read off the swap (Flow: at the measured word
    // positions; KyberSwap: decoded with its verified ABI), made safe by the mandatory
    // revoke rather than a value ceiling: whatever the swap really does, no allowance
    // survives the batch.
    assertSwapSpends(spend, call.to, value, 'approval');
  } else {
    // MarginAccount spender (D2): the spend is the deposit of exactly this token and
    // amount — the same pairing the margin permit path enforces.
    if (spend.to.toLowerCase() !== margin || selectorOf(spend.data) !== MARGIN_DEPOSIT_SELECTOR) {
      throw new PolicyViolation(
        'SPENDER_NOT_ALLOWED',
        'an approval to the margin account must be followed by the deposit it is for',
      );
    }
    const depositToken = `0x${readPermitWord(spend.data, 1).slice(-40)}`;
    if (depositToken.toLowerCase() !== call.to.toLowerCase()) {
      throw new PolicyViolation(
        'PERMIT_TOKEN_MISMATCH',
        `this approval is for ${call.to} but the deposit moves ${depositToken}`,
      );
    }
    if (BigInt(readPermitWord(spend.data, 2)) !== value) {
      throw new PolicyViolation(
        'PERMIT_AMOUNT_INVALID',
        'the approved amount is not the amount the deposit moves',
      );
    }
  }

  assertDollarParCap(call.to, value);
}

/**
 * The one call that may carry native value in a sponsored batch: `WMON.deposit()`,
 * wrapping exactly the MON the MarginAccount withdrawal right before it credited (D3,
 * 2026-09-25). The account's native balance ends where it began, so Monad's delegated
 * reserve is untouched, and the relayer still never holds or moves MON of its own.
 * Anything else with value keeps the old refusal, word for word.
 */
/**
 * True when `previous` is the margin withdrawal of exactly `value` native MON —
 * the PINNED margin account (D182 residual R5), same rule as the approve triple.
 * A wrap right after its own withdrawal nets to zero: that MON never left the
 * account's pre-existing balance, it only passed through this transaction.
 * Shared with the relayer's reserve math (D200, `nativeValueSpent`) so the two
 * can never disagree about what "spent" means.
 */
function wrapsOwnWithdrawal(previous: SponsoredCall | undefined, value: bigint): boolean {
  return (
    previous !== undefined &&
    previous.to.toLowerCase() === MAINNET.kuru.marginAccount.toLowerCase() &&
    previous.data.length === TWO_WORD_CALL_LENGTH &&
    selectorOf(previous.data) === MARGIN_WITHDRAW_SELECTOR &&
    BigInt(`0x${argWord(previous.data, 0)}`) === value &&
    argAddressBits(previous.data, 1) === '0'.repeat(40)
  );
}

/**
 * How much of a batch's own `value` fields spends the account's pre-existing
 * native MON balance, net of any wrap that merely re-wraps the proceeds of a
 * margin withdrawal inside the same batch — see `wrapsOwnWithdrawal`. Every
 * other value-carrying call (a lone or leading wrap, a plain native send, a
 * native margin deposit — all three validated by `assertSponsorable` before
 * this is ever consulted) spends the account's own pre-existing MON in full,
 * regardless of its position in the batch (D200: the relayer's own reserve math
 * used to assume only `actions[0]` could ever carry value, which the new send
 * and deposit shapes make false).
 */
export function nativeValueSpent(actions: readonly SponsoredCall[]): bigint {
  let spent = 0n;
  for (const [i, call] of actions.entries()) {
    const value = call.value ?? 0n;
    if (value === 0n) continue;
    if (wrapsOwnWithdrawal(actions[i - 1], value)) continue;
    spent += value;
  }
  return spent;
}

function assertWmonWrap(
  calls: readonly SponsoredCall[],
  index: number,
  call: SponsoredCall,
  actionsEnd: number,
): void {
  const wmon = MAINNET.tokens.WMON.address.toLowerCase();
  if (
    call.to.toLowerCase() !== wmon ||
    call.data.length !== 10 ||
    selectorOf(call.data) !== WMON_DEPOSIT_SELECTOR
  ) {
    throw new PolicyViolation('VALUE_NOT_ZERO', 'sponsored calls never carry native MON');
  }
  const value = call.value ?? 0n;
  const previous = calls[index - 1];
  if (wrapsOwnWithdrawal(previous, value)) return;

  // Rule 1.8: the wallet's own MON into its own WMON, as the first action. Either the
  // whole action (MON to WMON), or the head of a MON-input swap: the very next call
  // opens the exact approve triple on WMON to a pinned router for exactly this value
  // (the triple's own iteration binds the swap to it). Monad refuses a delegated
  // account ending below its 10 MON reserve, and the client refuses first (rule 1.8's
  // sentence), so this cannot spend the reserve.
  if (index === 0 && value > 0n) {
    const next = calls[1];
    if (actionsEnd === 1) return;
    const opensWmonSwap =
      next !== undefined &&
      next.to.toLowerCase() === wmon &&
      next.data.length === TWO_WORD_CALL_LENGTH &&
      selectorOf(next.data) === APPROVE_SELECTOR &&
      (() => {
        try {
          const opened = decodeApprove(next.data);
          return pinnedSwapRouter(opened.spender) !== undefined && opened.value === value;
        } catch {
          return false;
        }
      })();
    if (opensWmonSwap) return;
  }
  throw new PolicyViolation(
    'VALUE_NOT_ZERO',
    'native MON may be wrapped only on its own, ahead of the swap it pays for, or directly after the margin withdrawal that produced it, for exactly that amount',
  );
}

/**
 * The WMON unwrap (B3, 2026-09-25): `WMON.withdraw(amount)` may be sponsored only
 * directly after the Flow swap that delivered WMON to this account — with the C1
 * triple's own closing `approve(spender, 0)` allowed between them, since the triple
 * is validated as three adjacent calls and the unwrap can only follow it. The
 * wrapper's own construction sends the native MON to the caller and nobody else, so
 * the call spends the account's own WMON into the account's own wallet. Anywhere
 * else, the selector is refused like any other unlisted token call.
 */
function assertWmonUnwrap(
  calls: readonly SponsoredCall[],
  index: number,
  call: SponsoredCall,
  actionsEnd: number,
): void {
  const wmon = MAINNET.tokens.WMON.address.toLowerCase();
  if (call.to.toLowerCase() !== wmon) {
    throw new PolicyViolation(
      'SELECTOR_NOT_ALLOWED',
      `withdraw(uint256) is sponsorable only on WMON, not ${call.to}`,
    );
  }
  if (call.data.length !== 2 + 8 + 64 || BigInt(`0x${argWord(call.data, 0)}`) <= 0n) {
    throw new PolicyViolation(
      'SELECTOR_NOT_ALLOWED',
      'a sponsored WMON unwrap carries one positive amount and nothing else',
    );
  }
  const previous = calls[index - 1];
  const isClosingApprove = (c: SponsoredCall | undefined): boolean => {
    if (!c || c.data.length < 10 || selectorOf(c.data) !== APPROVE_SELECTOR) return false;
    try {
      return decodeApprove(c.data).value === 0n;
    } catch {
      return false;
    }
  };
  // Rule 1.8, WMON to MON: the unwrap as the whole action. The wrapper pays the caller
  // and nobody else (D183), so this is the account's own WMON becoming its own MON.
  if (index === 0 && actionsEnd === 1) return;
  // The same from the trading balance: the margin withdrawal of exactly this WMON
  // amount, then the unwrap, and nothing else.
  if (index === 1 && actionsEnd === 2 && withdrawsWmonFromMargin(previous, BigInt(`0x${argWord(call.data, 0)}`))) {
    return;
  }

  const swap = isClosingApprove(previous) ? calls[index - 2] : previous;
  // The swap's token out must be read exactly: a CLEAN WMON address (Flow's full
  // 32-byte word, high bytes zero; Kyber's decoded dstToken). Finding 2's fail-closed
  // rule, applied to every router.
  const read = swap !== undefined ? readPinnedSwap(swap.to, swap.data) : undefined;
  const followsWmonSwap = read?.tokenOut !== undefined && read.tokenOut.toLowerCase() === wmon;
  if (!followsWmonSwap) {
    throw new PolicyViolation(
      'SELECTOR_NOT_ALLOWED',
      'WMON may be unwrapped on its own or directly after the swap that delivered it',
    );
  }
}

/** `MarginAccount.withdraw(amount, WMON)` on the PINNED margin account, exactly `amount`. */
function withdrawsWmonFromMargin(call: SponsoredCall | undefined, amount: bigint): boolean {
  return (
    call !== undefined &&
    call.to.toLowerCase() === MAINNET.kuru.marginAccount.toLowerCase() &&
    call.data.length === TWO_WORD_CALL_LENGTH &&
    selectorOf(call.data) === MARGIN_WITHDRAW_SELECTOR &&
    BigInt(`0x${argWord(call.data, 0)}`) === amount &&
    argAddressBits(call.data, 1) === MAINNET.tokens.WMON.address.slice(2).toLowerCase()
  );
}

// ---------------------------------------------------------------------------------------
// The relayer's fee leg (2026-09-24)
// ---------------------------------------------------------------------------------------

/** `withdraw(uint256 _amount, address _token)` on the MarginAccount. */
const MARGIN_WITHDRAW_SELECTOR = FORWARDABLE_SELECTORS.marginAccountWithdraw;

/** `withdraw(uint256,address)` and `transfer(address,uint256)`: a selector and two words. */
const TWO_WORD_CALL_LENGTH = 2 + 8 + 2 * 64;

/** The `i`th 32-byte argument word of `data`, as 64 hex characters (fewer if it is short). */
function argWord(data: Hex, i: number): string {
  return data.slice(10 + i * 64, 10 + (i + 1) * 64);
}

/** The address in the low 20 bytes of argument word `i`, lowercased, without `0x`. */
function argAddressBits(data: Hex, i: number): string {
  const word = argWord(data, i);
  return word.length === 64 ? word.slice(24).toLowerCase() : '';
}

/** Does `data` contain the bytes `hex` (lowercase, no `0x`) at any byte boundary? */
function containsBytes(data: Hex, hex: string): boolean {
  const body = data.slice(2).toLowerCase();
  for (let i = body.indexOf(hex); i !== -1; i = body.indexOf(hex, i + 1)) {
    if (i % 2 === 0) return true;
  }
  return false;
}

export interface FeeLeg {
  readonly token: Address;
  readonly amount: bigint;
}

export interface SplitBatch {
  /** The batch without its fee leg: what the user asked to do. */
  readonly actions: readonly SponsoredCall[];
  readonly feeLeg?: FeeLeg;
}

/**
 * Separate a batch into the action and the fee leg that pays for it, or refuse.
 *
 * Modelled on the permit pairing above: a payment to the relayer exists only as the second
 * half of a pair, the pair has one fixed shape, and every half is checked against the
 * other. The one shape:
 *
 *   ...action calls...,
 *   MarginAccount.withdraw(fee, token),     // the user's own trading balance
 *   token.transfer(recipient, fee)          // the whole of it, to the pinned recipient
 *
 * Refused as FEE_LEG_MISMATCH, whatever else the batch holds:
 *
 *   - more than one payment to `recipient`, or one anywhere but the last call;
 *   - a fee leg with no action in front of it: a payment to the relayer on its own;
 *   - a token other than USDC or AUSD, or an amount of zero or over `MAX_GAS_FEE`;
 *   - a transfer with anything but a clean recipient word and an amount, or a withdraw
 *     that is not exactly `withdraw(fee, token)` on the MarginAccount right before it;
 *   - a margin deposit that credits `recipient`, which pays the relayer by another road.
 *
 * `MarginAccount.withdraw` pays `msg.sender`, which under 7702 is the user's own account,
 * so the withdraw half can only ever take the signer's own funds (`account.ts`).
 *
 * The amount is only checked for bounds here. Whether it is the right fee is the
 * caller's comparison against its own figure (`assertSponsorable`'s `gasFee.expected`).
 */
export function splitFeeLeg(
  calls: readonly SponsoredCall[],
  marginAccount: Address,
  recipient: Address,
): SplitBatch {
  const target = recipient.toLowerCase().replace(/^0x/, '');
  const margin = marginAccount.toLowerCase();
  const payments: number[] = [];
  for (const [index, call] of calls.entries()) {
    if (call.data.length < 10) continue;
    const selector = call.data.slice(0, 10).toLowerCase();
    // Matched on the low 20 bytes alone, so a word with dirt above the address is still
    // recognised as a payment to the relayer, and then refused below as malformed.
    if (selector === TRANSFER_SELECTOR && argAddressBits(call.data, 0) === target) {
      payments.push(index);
    } else if (
      call.to.toLowerCase() === margin &&
      selector === MARGIN_DEPOSIT_SELECTOR &&
      argAddressBits(call.data, 0) === target
    ) {
      throw new PolicyViolation(
        'FEE_LEG_MISMATCH',
        'a sponsored deposit may not credit the relayer’s fee address',
      );
    }
  }
  // D168: the fee address may appear in a sponsored batch in one place only, as the
  // recipient of its own fee. Not as a call target, and nowhere in any other call's bytes:
  // not a deposit's beneficiary, a permit's spender, or a recipient buried in a Flow route
  // this policy cannot parse. Searched byte-aligned anywhere in the calldata, so a packed
  // encoding is caught as well as an ABI word.
  for (const [index, call] of calls.entries()) {
    if (payments.includes(index)) continue;
    if (call.to.toLowerCase().replace(/^0x/, '') === target || containsBytes(call.data, target)) {
      throw new PolicyViolation(
        'FEE_LEG_MISMATCH',
        'the relayer’s fee address may appear in a sponsored batch only as the recipient of its fee',
      );
    }
  }
  if (payments.length === 0) return { actions: calls };

  const mismatch = (message: string) => new PolicyViolation('FEE_LEG_MISMATCH', message);
  if (payments.length > 1) throw mismatch('a batch pays the relayer’s fee at most once');
  const index = payments[0]!;
  if (index !== calls.length - 1) {
    throw mismatch('the fee leg must be the last two calls of the batch');
  }
  if (calls.length < 3) {
    throw mismatch('a fee pays for an action in the same batch, and this batch has none');
  }

  const transfer = calls[index]!;
  const withdraw = calls[index - 1]!;
  if (!isGasFeeToken(transfer.to)) throw mismatch('a fee is paid in USDC or AUSD only');
  if (transfer.data.length !== TWO_WORD_CALL_LENGTH) {
    throw mismatch('the fee transfer must carry a recipient and an amount and nothing else');
  }
  if (!/^0{24}/.test(argWord(transfer.data, 0))) {
    throw mismatch('the fee recipient word is not a clean address');
  }
  const amount = BigInt(`0x${argWord(transfer.data, 1)}`);
  if (amount === 0n || amount > MAX_GAS_FEE) {
    throw mismatch(`a fee is more than zero and at most ${MAX_GAS_FEE} base units`);
  }

  if (
    withdraw.to.toLowerCase() !== margin ||
    withdraw.data.length !== TWO_WORD_CALL_LENGTH ||
    selectorOf(withdraw.data) !== MARGIN_WITHDRAW_SELECTOR
  ) {
    throw mismatch('a fee comes from the trading balance: the call before it must withdraw it');
  }
  if (BigInt(`0x${argWord(withdraw.data, 0)}`) !== amount) {
    throw mismatch('the fee withdrawn is not the fee paid');
  }
  const tokenWord = argWord(withdraw.data, 1);
  if (!/^0{24}/.test(tokenWord) || tokenWord.slice(24).toLowerCase() !== transfer.to.toLowerCase().slice(2)) {
    throw mismatch('the fee is withdrawn in one token and paid in another');
  }

  return {
    actions: calls.slice(0, index - 1),
    feeLeg: { token: getAddress(transfer.to), amount },
  };
}

/**
 * D168, extended after independent review: no address the relayer controls appears in a
 * sponsored batch. The fee address is already held to this by `splitFeeLeg`, which permits
 * it only as the recipient of the one fee transfer, so it is skipped here when a fee
 * context names it. Every other relayer address, the hot key above all, is refused wherever
 * it appears, whether or not it is the fee address today.
 */
function assertNoRelayerAddress(calls: readonly SponsoredCall[], context: PolicyContext): void {
  const recipient = context.gasFee?.recipient.toLowerCase();
  const forbidden = (context.relayerAddresses ?? [])
    .map((a) => a.toLowerCase())
    .filter((a) => /^0x[0-9a-f]{40}$/.test(a) && a !== recipient)
    .map((a) => a.slice(2));
  if (forbidden.length === 0) return;
  for (const call of calls) {
    const to = call.to.toLowerCase().replace(/^0x/, '');
    for (const address of forbidden) {
      if (to === address || containsBytes(call.data, address)) {
        throw new PolicyViolation(
          'FEE_LEG_MISMATCH',
          'an address the relayer controls may not appear in a sponsored batch',
        );
      }
    }
  }
}

/**
 * The fee-leg half of `assertSponsorable`. Answers the index of the fee transfer, or -1.
 */
function assertFeeLeg(
  calls: readonly SponsoredCall[],
  marginAccount: Address,
  gasFee: NonNullable<PolicyContext['gasFee']>,
): number {
  const { feeLeg } = splitFeeLeg(calls, marginAccount, gasFee.recipient);
  const { expected } = gasFee;
  if (!feeLeg) {
    if (expected === 'none') return -1;
    throw new PolicyViolation(
      'FEE_LEG_MISMATCH',
      'this action is charged, and its batch carries no fee',
    );
  }
  if (expected === 'none') {
    throw new PolicyViolation(
      'FEE_LEG_MISMATCH',
      'this action is not charged, so its batch may not pay the relayer',
    );
  }
  if (
    expected !== 'unpriced' &&
    (feeLeg.token.toLowerCase() !== expected.token.toLowerCase() ||
      feeLeg.amount !== expected.amount)
  ) {
    throw new PolicyViolation(
      'FEE_LEG_MISMATCH',
      'the fee in this batch is not the fee the relayer computed for this operation',
    );
  }
  return calls.length - 1;
}

/**
 * What the batch's own MarginAccount deposits credit to `user`, per token (lowercased).
 *
 * A charged batch may pay its fee out of a deposit it makes first: an account with nothing
 * in its trading balance and no free action left is told to add funds, and adding funds is
 * itself an action. So whether an account can pay, and in which token, is judged on its
 * trading balance plus what this batch deposits for it. `deposit(address user, address
 * token, uint256 amount)` is three static words; anything else is not counted. If a counted
 * deposit fails, the whole batch fails with it, fee leg included.
 */
export function marginDepositsTo(
  calls: readonly SponsoredCall[],
  marginAccount: Address,
  user: Address,
): ReadonlyMap<string, bigint> {
  const margin = marginAccount.toLowerCase();
  const who = user.toLowerCase().replace(/^0x/, '');
  const credited = new Map<string, bigint>();
  for (const call of calls) {
    if (call.to.toLowerCase() !== margin) continue;
    if (call.data.length !== 2 + 8 + 3 * 64) continue;
    if (call.data.slice(0, 10).toLowerCase() !== MARGIN_DEPOSIT_SELECTOR) continue;
    const userWord = argWord(call.data, 0);
    const tokenWord = argWord(call.data, 1);
    if (!/^0{24}/.test(userWord) || !/^0{24}/.test(tokenWord)) continue;
    if (userWord.slice(24).toLowerCase() !== who) continue;
    const token = `0x${tokenWord.slice(24).toLowerCase()}`;
    credited.set(token, (credited.get(token) ?? 0n) + BigInt(`0x${argWord(call.data, 2)}`));
  }
  return credited;
}

/** `batchCancelOrders(uint40[])` on an order book. */
const CANCEL_SELECTOR = FORWARDABLE_SELECTORS.batchCancelOrders;

/**
 * Why a batch is never counted against the free actions and never charged, or undefined
 * when it is an ordinary, counted action.
 *
 *   'own-funds'      every call moves the user's own funds out: the MarginAccount's
 *                    `withdraw`, any token's `transfer` (any-token wallet, 2026-09-25;
 *                    the pinned three before that, owner's rule 2026-09-24), or the
 *                    WMON wrap of a withdrawal beside it (D3);
 *   'cancel'         every call is one of those or `batchCancelOrders` on an order
 *                    book, and at least one is a cancel (F3, 2026-09-24): an account
 *                    with its funds in resting orders and no free action left must
 *                    still be able to take them off the book;
 *   'swap-into-mon'  the batch is a Flow swap delivering WMON (the tokenOut word is
 *                    a clean, exact WMON address — nothing looser), with the
 *                    allowance halves around it and optionally the unwrap after it
 *                    (B3, 2026-09-25): swapping into the gas token is how an account
 *                    regains the ability to pay for everything else, so it is never
 *                    counted, and sponsored while the exempt pool has room — the
 *                    pool bounds sponsorship, like every other exempt action.
 *
 * This decides what is free, so it is exact: every call one of those kinds, nothing
 * else, and at least one call. Pass it the batch's actions (`splitFeeLeg`), never a
 * batch that still carries a fee leg, and only after `assertSponsorable` has passed the
 * batch. That is what confines a cancel to an allowed order book and a swap to the
 * paired, revoked allowance; this says what a sponsorable batch is for, not whether it
 * may be sponsored.
 */
export function exemptionOf(
  actions: readonly SponsoredCall[],
  marginAccount: Address,
): 'own-funds' | 'cancel' | 'swap-into-mon' | undefined {
  if (actions.length === 0) return undefined;
  const margin = marginAccount.toLowerCase();
  const wmon = MAINNET.tokens.WMON.address.toLowerCase();
  const isRouter = (to: string): boolean => pinnedSwapRouter(to as Address) !== undefined;
  let cancels = false;
  let swapIntoMon = false;
  for (const [i, call] of actions.entries()) {
    // A plain native-MON send (D200): the user's own funds, straight to an address
    // they chose, data-less like any other simple transfer — exempt for the same
    // reason an ERC-20 transfer is. Already shape-checked by `assertSponsoredNativeSend`
    // by the time this runs, so the empty-data, nonzero-value shape is enough here.
    if (call.data === '0x' && (call.value ?? 0n) > 0n) continue;
    if (call.data.length < 10) return undefined;
    const selector = call.data.slice(0, 10).toLowerCase();
    const to = call.to.toLowerCase();
    // The MON wrap: only beside the withdrawal that produced its value (D3). The
    // withdrawal itself passes the margin case on its own iteration.
    if (to === wmon && selector === WMON_DEPOSIT_SELECTOR && (call.value ?? 0n) > 0n) {
      const previous = actions[i - 1];
      if (
        !previous ||
        previous.to.toLowerCase() !== margin ||
        previous.data.length < 10 ||
        selectorOf(previous.data) !== MARGIN_WITHDRAW_SELECTOR
      ) {
        return undefined;
      }
      continue;
    }
    if (to === margin) {
      if (selector !== MARGIN_WITHDRAW_SELECTOR) return undefined;
    } else if (selector === CANCEL_SELECTOR && MARKET_CANDIDATES.some((c) => c.address.toLowerCase() === to)) {
      // A cancel is a cancel only on a known order book. With transfers no longer
      // bound to a pinned token list, the selector alone would otherwise claim a
      // cancel-shaped call on some token contract, which is nothing of the kind.
      cancels = true;
    } else if (selector === TRANSFER_SELECTOR) {
      // Any token's send of the user's own balance (D1). Bounded by
      // `assertSponsoredTransfer` before this is ever consulted.
    } else if (isRouter(to)) {
      // A swap is exempt only when it delivers the gas token (B3): the token out must
      // be read as a CLEAN WMON address (Flow: the full 32-byte word, high bytes zero;
      // KyberSwap: the decoded dstToken). Security review of D181, finding 2: this
      // decides what is free, so it is exact and fails closed. Anything else is a
      // counted swap.
      const read = readPinnedSwap(call.to, call.data);
      if (read?.tokenOut === undefined || read.tokenOut.toLowerCase() !== wmon) return undefined;
      swapIntoMon = true;
    } else if (to === wmon && selector === WMON_WITHDRAW_SELECTOR) {
      // The unwrap leg of a swap into MON (B3), or the whole of a WMON to MON unwrap
      // (rule 1.8): both end as native MON, the gas token. Bounded by
      // `assertWmonUnwrap` before this is ever consulted.
      if (actions.length === 1) swapIntoMon = true;
      // WMON to MON from the trading balance: the withdrawal, then this unwrap.
      if (
        actions.length === 2 &&
        i === 1 &&
        call.data.length === 2 + 8 + 64 &&
        withdrawsWmonFromMargin(actions[0], BigInt(`0x${argWord(call.data, 0)}`))
      ) {
        swapIntoMon = true;
      }
      if (!swapIntoMon) return undefined;
    } else if (selector === PERMIT_SELECTOR || selector === APPROVE_SELECTOR) {
      // The allowance halves of a swap group: exempt only when they sit against the
      // router swap they pay for (the opening before it, the revoke after it).
      const next = actions[i + 1];
      const previous = actions[i - 1];
      const opensSwap = next !== undefined && isRouter(next.to.toLowerCase());
      const closesSwap =
        selector === APPROVE_SELECTOR && previous !== undefined && isRouter(previous.to.toLowerCase());
      if (!opensSwap && !closesSwap) return undefined;
    } else {
      return undefined;
    }
  }
  if (cancels) return swapIntoMon ? undefined : 'cancel';
  return swapIntoMon ? 'swap-into-mon' : 'own-funds';
}

/** A send or a withdraw of the user's own funds, and nothing else. See `exemptionOf`. */
export function isSendOrWithdraw(
  actions: readonly SponsoredCall[],
  marginAccount: Address,
): boolean {
  return exemptionOf(actions, marginAccount) === 'own-funds';
}
