import {
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  type Address,
  type PublicClient,
} from 'viem';
import { orderBookAbi } from '../abi/orderBook.js';
import type { SponsoredCall } from '../gas/account.js';
import {
  submit,
  type SubmitOptions,
  type SubmitResult,
  type SubmitTransport,
} from '../gas/submit.js';
import { BPS_PER_UNIT } from '../math/fixed.js';
import {
  FORWARDABLE_SELECTORS,
  selectorOf,
  UINT96_MAX,
  type BuiltCall,
  type ForwardablePurpose,
  type Side,
} from './orders.js';
import type { MarketParams } from './params.js';

/**
 * USDC <-> AUSD conversion on Kuru's AUSD/USDC order book.
 *
 * This is the leg that turns funding which lands as USDC into the AUSD the app
 * actually trades in (spec section 6.4, phases section 5.1 task 3.5).
 *
 * ## The direction, read off the venue rather than off the market's name
 *
 * `getMarketParams()` on `0x699AbC15...`, read live on 2026-09-02 at block
 * 101352461, returns:
 *
 *   pricePrecision 100000000 (1e8)   sizePrecision 1000000 (1e6)
 *   baseAsset   0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a  (AUSD, 6 dp)
 *   quoteAsset  0x754704Bc059F8C67012fEd69BC8A327a5aafb603  (USDC, 6 dp)
 *   tickSize 100   minSize 10000000   maxSize 10000000000000
 *   takerFeeBps 0  makerFeeBps 0
 *
 * **AUSD is the base and USDC is the quote.** So USDC -> AUSD spends quote to receive
 * base, which on this venue is `placeAndExecuteMarketBuy`; it is
 * `placeAndExecuteMarketSell` that runs the other way, AUSD -> USDC.
 *
 * `docs/04-phases-milestones.md` section 5.1 task 3.5 describes the USDC->AUSD
 * convert as a "market sell on AUSD_USDC". That is the wrong function for that
 * direction on the book that exists. See DECISIONS.md conflict C12. The side here is
 * derived from the market's own params by `conversionRoute()` and cannot be passed
 * in, so the two cannot drift again.
 *
 * ## Proof, from the chain, with no state overrides and nothing written
 *
 * Both market functions in the verified `OrderBook` implementation
 * (`0xea2cc8769fb04ff1893ed11cf517b7f040c823cd`, name `OrderBook`, solc v0.8.30,
 * Etherscan V2 chainid 143) carry an explicit quote path:
 *
 *     (_quoteSize, _baseTokensCredited) = _marketBuyMatch(_quoteSize, _isMargin);
 *     if (msg.sender == address(0)) { return _baseTokensCredited; }
 *
 * With `msg.sender == address(0)` the debit is skipped, the credit is skipped and the
 * matched amount is returned. An `eth_call` sent from the zero address is therefore a
 * real quote against real live depth: no funds, no approvals, no state overrides, no
 * write of any kind. `quoteConversion()` below is exactly that call, and it is where
 * every `expectedOut` in this module comes from. Nothing here invents a price.
 *
 * Measured that way at block 101352729 on 2026-09-02:
 *
 *   BUY  1 USDC   -> 0.999851 AUSD      SELL 1 AUSD   -> 1.000148 USDC
 *   BUY  5 USDC   -> 4.999255 AUSD      SELL 5 AUSD   -> 5.000740 USDC
 *   BUY  100 USDC -> 99.985102 AUSD     SELL 100 AUSD -> 100.014800 USDC
 *
 * which is the book's own bestBidAsk of 1.000147 / 1.000149 at that block, and settles
 * the direction: spending USDC yields AUSD only through the buy side.
 */

/**
 * Kuru's AUSD/USDC order book on Monad mainnet.
 *
 * Held here rather than in `chain/addresses.ts` for the same reason every other market
 * address is: markets are discovered from the registry and re-verified on chain
 * (`kuru/registry.ts`). `conversionRoute()` re-derives the pair from
 * `getMarketParams()` before anything is encoded, so this constant is a starting point
 * and never a trusted fact.
 */
export const AUSD_USDC_MARKET: Address = getAddress('0x699AbC15308156E9a3AB89Ec7387e9CfE1c86A3b');

/**
 * The verified implementation behind that proxy, read from ERC-1967 slot
 * `0x360894...382bbc` on 2026-09-02. Recorded because the zero-sender quote path this
 * module depends on was read from this implementation's verified source, and the
 * MON/AUSD book runs a different, unverified one (`0x4C0bA1BA...`).
 */
export const AUSD_USDC_IMPLEMENTATION: Address = getAddress(
  '0xea2cc8769fb04ff1893ed11cf517b7f040c823cd',
);

/** The sender that turns a Kuru market order into a read-only quote. */
export const QUOTE_SENDER: Address = '0x0000000000000000000000000000000000000000';

/**
 * The widest slippage a conversion may ask for: **1%**.
 *
 * A stablecoin pair one tick wide does not need more, and the cap is what makes an
 * absurd `minAmountOut` unrepresentable rather than merely discouraged.
 */
export const MAX_CONVERSION_SLIPPAGE_BPS = 100n;

/** Default slippage: 25 bps. Comfortably past the 1.5 bp spread this book quotes. */
export const DEFAULT_CONVERSION_SLIPPAGE_BPS = 25n;

export class ConversionPairError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversionPairError';
  }
}

export class SlippageFloorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlippageFloorError';
  }
}

export interface ConversionRoute {
  readonly market: Address;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  /** `buy` spends the quote asset and receives the base asset. */
  readonly side: Side;
  readonly direction: 'quote-to-base' | 'base-to-quote';
  readonly inDecimals: number;
  readonly outDecimals: number;
}

const eq = (a: Address, b: Address): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * Work out which side of the book converts `tokenIn` into `tokenOut`.
 *
 * The side is a function of the market's own `getMarketParams()` and of nothing else.
 * There is deliberately no way to pass a side in: that is the mistake this module
 * exists to make impossible, and it is the one that would spend a user's USDC to
 * receive USDC back.
 */
export function conversionRoute(
  market: Address,
  params: MarketParams,
  tokenIn: Address,
  tokenOut: Address,
): ConversionRoute {
  if (eq(tokenIn, tokenOut)) {
    throw new ConversionPairError('a conversion needs two different tokens');
  }
  if (eq(tokenIn, params.quoteAsset) && eq(tokenOut, params.baseAsset)) {
    return {
      market,
      tokenIn,
      tokenOut,
      side: 'buy',
      direction: 'quote-to-base',
      inDecimals: params.quoteDecimals,
      outDecimals: params.baseDecimals,
    };
  }
  if (eq(tokenIn, params.baseAsset) && eq(tokenOut, params.quoteAsset)) {
    return {
      market,
      tokenIn,
      tokenOut,
      side: 'sell',
      direction: 'base-to-quote',
      inDecimals: params.baseDecimals,
      outDecimals: params.quoteDecimals,
    };
  }
  throw new ConversionPairError(
    `market ${market} trades ${params.baseAsset} against ${params.quoteAsset}; ` +
      `it cannot convert ${tokenIn} into ${tokenOut}`,
  );
}

/**
 * Refuse a market whose params are not the pair this conversion was written against.
 * Cheap, and it catches a swapped or stale market address before any amount is
 * encoded.
 */
export function assertConversionMarket(
  params: MarketParams,
  expected: { readonly base: Address; readonly quote: Address },
): void {
  if (!eq(params.baseAsset, expected.base) || !eq(params.quoteAsset, expected.quote)) {
    throw new ConversionPairError(
      `expected a ${expected.base}/${expected.quote} book; this one is ` +
        `${params.baseAsset}/${params.quoteAsset}`,
    );
  }
}

/* --------------------------------- the wire amount --------------------------------- */

export interface ConversionAmount {
  /** What the contract is handed: `uint96`, in the units that side wants. */
  readonly wire: bigint;
  /** What that `uint96` really spends, back in `tokenIn` base units. */
  readonly effectiveIn: bigint;
  /** True when the market's precision could not express `amountIn` exactly. */
  readonly adjusted: boolean;
}

/**
 * Convert `amountIn` into the `uint96` the chosen side takes.
 *
 * A market buy's first argument is the quote spend in `pricePrecision` units, and the
 * contract turns it back with `_quote * quoteDecimalMultiplier / pricePrecision`; a
 * market sell's is the base size in `sizePrecision` units, turned back with
 * `_size * baseDecimalMultiplier / sizePrecision`. Both round-trips are reproduced
 * here, so `effectiveIn` is what the venue will really debit rather than what was
 * asked for.
 */
export function conversionAmountIn(
  amountIn: bigint,
  params: MarketParams,
  side: Side,
): ConversionAmount {
  if (amountIn <= 0n) throw new Error('conversion amount must be positive');
  const scale =
    side === 'buy' ? 10n ** BigInt(params.quoteDecimals) : 10n ** BigInt(params.baseDecimals);
  const precision = side === 'buy' ? params.pricePrecision : params.sizePrecision;
  const wire = (amountIn * precision) / scale;
  if (wire <= 0n) {
    throw new Error(
      `${amountIn} is below one unit of this market's precision; there is nothing to convert`,
    );
  }
  const effectiveIn = (wire * scale) / precision;
  return { wire, effectiveIn, adjusted: effectiveIn !== amountIn };
}

/* ---------------------------------- the live quote --------------------------------- */

export interface ConversionQuote {
  readonly route: ConversionRoute;
  /** `tokenIn` base units the venue will actually take. */
  readonly amountIn: bigint;
  /** `tokenOut` base units the venue returned, net of its taker fee. */
  readonly expectedOut: bigint;
  /** The `uint96` handed to the contract. */
  readonly wireAmountIn: bigint;
  readonly adjusted: boolean;
  readonly blockNumber: bigint;
  /** Always `eth_call` from the zero address. Never a mid-price, never a model. */
  readonly source: 'zero-sender-eth_call';
}

/**
 * Quote a conversion against live depth.
 *
 * Read-only: `eth_call` from `address(0)`, which the verified `OrderBook` answers by
 * matching against the real book and returning the credit without touching state.
 * Nothing is written and nothing is signed.
 */
export async function quoteConversion(
  client: PublicClient,
  route: ConversionRoute,
  params: MarketParams,
  amountIn: bigint,
): Promise<ConversionQuote> {
  const amount = conversionAmountIn(amountIn, params, route.side);
  const functionName =
    route.side === 'buy' ? 'placeAndExecuteMarketBuy' : 'placeAndExecuteMarketSell';
  const data = encodeFunctionData({
    abi: orderBookAbi,
    functionName,
    args: [amount.wire, 0n, false, false],
  });

  const [result, blockNumber] = await Promise.all([
    client.call({ account: QUOTE_SENDER, to: route.market, data }),
    client.getBlockNumber(),
  ]);
  if (!result.data) {
    throw new Error(`quoting ${functionName} on ${route.market} returned no data`);
  }
  const expectedOut = decodeFunctionResult({
    abi: orderBookAbi,
    functionName,
    data: result.data,
  }) as bigint;

  return {
    route,
    amountIn: amount.effectiveIn,
    expectedOut,
    wireAmountIn: amount.wire,
    adjusted: amount.adjusted,
    blockNumber,
    source: 'zero-sender-eth_call',
  };
}

/* -------------------------------- the slippage floor ------------------------------- */

/**
 * The floor a conversion will accept, computed from a quote the venue actually gave.
 *
 * Zero is not reachable: `expectedOut` must be positive, slippage is capped at
 * {@link MAX_CONVERSION_SLIPPAGE_BPS}, and a floor that rounds to zero throws rather
 * than being sent. A `minAmountOut` of 0 on a market order is a standing offer to
 * accept any fill at any price, which is the shape of every sandwiched swap.
 */
export function minAmountOutFor(expectedOut: bigint, slippageBps: bigint): bigint {
  if (expectedOut <= 0n) {
    throw new SlippageFloorError(
      'the book quoted nothing out at this size, so there is no floor to set. Either the ' +
        'size is below one tick of depth or the book is empty.',
    );
  }
  if (slippageBps < 0n) throw new SlippageFloorError('slippage cannot be negative');
  if (slippageBps > MAX_CONVERSION_SLIPPAGE_BPS) {
    throw new SlippageFloorError(
      `slippage ${slippageBps} bps is above the ${MAX_CONVERSION_SLIPPAGE_BPS} bps cap for a ` +
        'conversion. A stablecoin pair one tick wide does not need more.',
    );
  }
  const min = (expectedOut * (BPS_PER_UNIT - slippageBps)) / BPS_PER_UNIT;
  if (min <= 0n) {
    throw new SlippageFloorError(
      `a ${slippageBps} bps floor under ${expectedOut} rounds to zero; refusing to send a ` +
        'market order that would accept any fill.',
    );
  }
  return min;
}

/**
 * Every `minAmountOut` this module can produce, and every one a caller overrides with,
 * passes through here. Three things are impossible afterwards: zero, above the quote
 * (which can only revert), and further below the quote than the cap allows.
 */
export function assertMinAmountOut(minAmountOut: bigint, expectedOut: bigint): void {
  if (minAmountOut <= 0n) {
    throw new SlippageFloorError(
      'minAmountOut of zero accepts any fill at any price. Refusing to build the call.',
    );
  }
  if (expectedOut <= 0n) {
    throw new SlippageFloorError('cannot check a floor against a quote of zero');
  }
  if (minAmountOut > expectedOut) {
    throw new SlippageFloorError(
      `minAmountOut ${minAmountOut} is above the quoted ${expectedOut}; that order can only revert`,
    );
  }
  const floor = (expectedOut * (BPS_PER_UNIT - MAX_CONVERSION_SLIPPAGE_BPS)) / BPS_PER_UNIT;
  if (minAmountOut < floor) {
    throw new SlippageFloorError(
      `minAmountOut ${minAmountOut} is more than ${MAX_CONVERSION_SLIPPAGE_BPS} bps below the ` +
        `quoted ${expectedOut}. The cap is a cap, not a default.`,
    );
  }
}

/* ------------------------------------ the call ------------------------------------- */

export interface ConversionInput {
  readonly market: Address;
  readonly params: MarketParams;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  /** `tokenIn` base units. */
  readonly amountIn: bigint;
  /** From {@link quoteConversion}. There is no default: a floor needs a real quote. */
  readonly expectedOut: bigint;
  readonly slippageBps?: bigint;
  /** An explicit floor. Still checked against the quote by {@link assertMinAmountOut}. */
  readonly minAmountOut?: bigint;
  /** Draw from the MarginAccount balance, which is where a funded account holds AUSD. */
  readonly isMargin?: boolean;
  readonly isFillOrKill?: boolean;
}

export interface BuiltConversion extends BuiltCall {
  readonly route: ConversionRoute;
  readonly amountIn: bigint;
  readonly wireAmountIn: bigint;
  readonly expectedOut: bigint;
  readonly minAmountOut: bigint;
  readonly slippageBps: bigint;
  readonly adjusted: boolean;
}

/**
 * Encode the conversion.
 *
 * It does **not** go through `buildMarketOrder()`, and the reason is a venue fact
 * rather than a preference. `buildMarketOrder()`'s sell path calls `toContractSize()`,
 * which enforces the market's `minSize` — and on the verified `OrderBook`
 * `minSize`/`maxSize` are checked only on the resting-order paths (`addBuyOrder` line
 * 185, `addSellOrder` line 255, `addFlipBuyOrder`, `addFlipSellOrder`, `batchUpdate`).
 * `placeAndExecuteMarketBuy` and `placeAndExecuteMarketSell` check neither. AUSD/USDC
 * has `minSize` 10_000_000 = **10 AUSD**, so routing the sell leg through
 * `buildMarketOrder()` refuses a legal 5 AUSD conversion for a limit-order reason that
 * does not apply to a taker. The two market selectors are the same ones
 * `FORWARDABLE_SELECTORS` names, and the assertion below keeps that true by
 * construction.
 */
export function buildConversion(input: ConversionInput): BuiltConversion {
  const route = conversionRoute(input.market, input.params, input.tokenIn, input.tokenOut);
  const amount = conversionAmountIn(input.amountIn, input.params, route.side);
  if (amount.wire > UINT96_MAX)
    throw new Error(`conversion amount ${amount.wire} overflows uint96`);
  const slippageBps = input.slippageBps ?? DEFAULT_CONVERSION_SLIPPAGE_BPS;
  const minAmountOut = input.minAmountOut ?? minAmountOutFor(input.expectedOut, slippageBps);
  assertMinAmountOut(minAmountOut, input.expectedOut);

  const purpose: ForwardablePurpose =
    route.side === 'buy' ? 'placeAndExecuteMarketBuy' : 'placeAndExecuteMarketSell';
  const data = encodeFunctionData({
    abi: orderBookAbi,
    functionName: purpose,
    args: [amount.wire, minAmountOut, input.isMargin ?? true, input.isFillOrKill ?? false],
  });
  if (selectorOf(data) !== FORWARDABLE_SELECTORS[purpose]) {
    throw new Error(
      `encoded ${purpose} as ${selectorOf(data)}, which is not the selector this repo ` +
        'allowlists. The OrderBook ABI and the allowlist have drifted.',
    );
  }

  return {
    to: input.market,
    data,
    purpose,
    route,
    amountIn: amount.effectiveIn,
    wireAmountIn: amount.wire,
    expectedOut: input.expectedOut,
    minAmountOut,
    slippageBps,
    adjusted: amount.adjusted,
  };
}

/**
 * Quote, build and submit a conversion.
 *
 * `submit()` is the only way anything leaves this repo, and in `MODE=dryrun` — the
 * default everywhere — it validates the whole path and returns `DRYRUN` having sent
 * nothing. The quote above it is a live read either way.
 *
 * The AUSD/USDC book left `LIVE_MARKET_ALLOWLIST` on 2026-09-23 (it was in it from
 * 2026-09-09, D127). A sponsoring relayer allows this leg only because the caller names
 * the market in `PolicyContext.markets`, as `/v1/bundler` does.
 */
export async function submitConversion(
  sender: Address,
  built: BuiltConversion,
  transport?: SubmitTransport,
  options: SubmitOptions = {},
): Promise<SubmitResult> {
  const calls: readonly SponsoredCall[] = [{ to: built.to, data: built.data, value: 0n }];
  return submit({ sender, calls, purpose: 'order' }, transport, options);
}
