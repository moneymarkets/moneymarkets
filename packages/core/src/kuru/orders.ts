import { encodeFunctionData, type Address, type Hex } from 'viem';
import { marginAccountAbi } from '../abi/marginAccount.js';
import { orderBookAbi } from '../abi/orderBook.js';
import {
  rescale,
  rescaleWithRounding,
  roundToTickForSide,
  WIRE_PRICE_SCALE,
} from '../math/fixed.js';
import type { MarketParams } from './params.js';

/**
 * Calldata construction. Every byte the relayer is ever asked to forward is built
 * here and nowhere else, so the selector allowlist below is exhaustive by
 * construction (spec §4.5, §5.3).
 */

export const UINT32_MAX = 4_294_967_295n;
export const UINT96_MAX = 79_228_162_514_264_337_593_543_950_335n;
export const UINT40_MAX = 1_099_511_627_775n;

export type Side = 'buy' | 'sell';

/**
 * The complete set of calls the relayer will forward. Anything outside this list is
 * rejected before a signature is even checked.
 *
 * Selectors verified 2026-09-02 against the deployed OrderBook and MarginAccount
 * dispatchers on Monad mainnet.
 */
export const FORWARDABLE_SELECTORS = {
  addBuyOrder: '0xa09e9040',
  addSellOrder: '0x40e79b1b',
  placeAndExecuteMarketBuy: '0x7c51d6cf',
  placeAndExecuteMarketSell: '0x532c46db',
  batchCancelOrders: '0x23afbff3',
  marginAccountDeposit: '0x8340f549',
  marginAccountWithdraw: '0x00f714ce',
} as const satisfies Record<string, Hex>;

export type ForwardablePurpose = keyof typeof FORWARDABLE_SELECTORS;

export const FORWARDABLE_SELECTOR_SET: ReadonlySet<string> = new Set(
  Object.values(FORWARDABLE_SELECTORS).map((s) => s.toLowerCase()),
);

export function selectorOf(data: Hex): Hex {
  if (data.length < 10) throw new Error(`calldata too short to carry a selector: ${data}`);
  return data.slice(0, 10).toLowerCase() as Hex;
}

export function isForwardableSelector(data: Hex): boolean {
  return FORWARDABLE_SELECTOR_SET.has(selectorOf(data));
}

/* ────────────────────────────── price and size ────────────────────────────── */

export interface PriceAdjustment {
  /** The `uint32` the contract wants: pricePrecision units, tick-aligned. */
  readonly price: bigint;
  /** The same value back in human * 1e18, for showing the user what will be sent. */
  readonly priceWire: bigint;
  /** True when rounding moved the price, so the UI can say so (design §5.4). */
  readonly adjusted: boolean;
}

/**
 * Convert a human * 1e18 price into the market's `uint32` price, aligned to the tick
 * by integer math.
 *
 * Buys round down and sells round up, so alignment never pushes an order through the
 * price the user chose. `clipToDecimals` in the SDK truncates the decimal string,
 * which is not alignment and reverts with `TickSizeError` (framework §4.1, error 5).
 */
export function toContractPrice(
  priceWire: bigint,
  params: MarketParams,
  side: Side,
): PriceAdjustment {
  if (priceWire <= 0n) throw new Error('price must be positive');
  // Scale down in the side's own direction first: a plain truncation here can put a
  // sell below the price the user typed before tick alignment ever runs.
  const raw = rescaleWithRounding(
    priceWire,
    WIRE_PRICE_SCALE,
    params.pricePrecision,
    side === 'buy' ? 'floor' : 'ceil',
  );
  const aligned = roundToTickForSide(raw, params.tickSize, side);
  if (aligned <= 0n) {
    throw new Error(
      `price ${priceWire} rounds to zero at tick ${params.tickSize}; it is below one tick`,
    );
  }
  if (aligned > UINT32_MAX) {
    throw new Error(`price ${aligned} overflows uint32 for this market`);
  }
  return {
    price: aligned,
    priceWire: rescale(aligned, params.pricePrecision, WIRE_PRICE_SCALE),
    adjusted: aligned !== raw,
  };
}

export interface SizeAdjustment {
  /** The `uint96` the contract wants: sizePrecision units. */
  readonly size: bigint;
  /** The same value back in base-asset base units. */
  readonly sizeBase: bigint;
  readonly adjusted: boolean;
}

/**
 * Convert base-asset base units into the market's `uint96` size.
 *
 * A size below `minSize` is rejected here rather than on chain: `SizeError` costs a
 * round trip and shows the user nothing useful (spec §4.5).
 *
 * **`minSize` is a resting-order rule, so `enforceMinimum` is a parameter.** The
 * verified `OrderBook` checks `minSize`/`maxSize` only on the paths that put an order
 * on the book (`addBuyOrder`, `addSellOrder`, the flip variants, `batchUpdate`) — not
 * on `placeAndExecuteMarketBuy`/`placeAndExecuteMarketSell`. Measured live on chain
 * 143 at block 103,110,791 (`scripts/probe-market-order-minsize.ts`): a market buy of
 * 0.10 USDC on MON/USDC — 3.837 MON against a 200 MON resting minimum, 52x under it —
 * returns a real fill, and `SizeError` (`0x0a5c4f1f`) appears in none of the market-order
 * calls tried. Applying the resting minimum to a taker refuses a trade the venue itself
 * would accept, which is why the market paths pass `false`.
 */
export function toContractSize(
  sizeBase: bigint,
  params: MarketParams,
  enforceMinimum = true,
): SizeAdjustment {
  if (sizeBase <= 0n) throw new Error('size must be positive');
  const scale = 10n ** BigInt(params.baseDecimals);
  const raw = (sizeBase * params.sizePrecision) / scale;
  if (enforceMinimum && raw < params.minSize) {
    throw new Error(
      `size ${raw} is below the market minimum ${params.minSize} (in sizePrecision units)`,
    );
  }
  if (raw <= 0n) {
    throw new Error(
      `size ${sizeBase} is below one unit of this market's size precision; there is nothing to trade`,
    );
  }
  if (raw > params.maxSize) {
    throw new Error(`size ${raw} is above the market maximum ${params.maxSize}`);
  }
  if (raw > UINT96_MAX) throw new Error(`size ${raw} overflows uint96`);
  return {
    size: raw,
    sizeBase: (raw * scale) / params.sizePrecision,
    adjusted: (raw * scale) / params.sizePrecision !== sizeBase,
  };
}

/**
 * `params.minSize`, in base-asset base units — the inverse of `toContractSize`'s own
 * scaling. `minSize` and `maxSize` are `sizePrecision`-scaled `uint96`s, not
 * base-asset decimals, and reading them as if they already were base units undercounts
 * a market's real minimum by orders of magnitude (MON/AUSD's `minSize` reads `2e12`,
 * which is not "0.000002 MON" — it is 200 MON, once rescaled through `sizePrecision`).
 */
export function minSizeBase(params: MarketParams): bigint {
  return (params.minSize * 10n ** BigInt(params.baseDecimals)) / params.sizePrecision;
}

/* ─────────────────────────────── call builders ────────────────────────────── */

export interface BuiltCall {
  readonly to: Address;
  readonly data: Hex;
  readonly purpose: ForwardablePurpose;
}

export interface LimitOrderInput {
  readonly market: Address;
  readonly params: MarketParams;
  readonly side: Side;
  /** human * 1e18 */
  readonly priceWire: bigint;
  /** base-asset base units */
  readonly sizeBase: bigint;
  readonly postOnly?: boolean;
}

export interface BuiltLimitOrder extends BuiltCall {
  readonly price: PriceAdjustment;
  readonly size: SizeAdjustment;
}

export function buildLimitOrder(input: LimitOrderInput): BuiltLimitOrder {
  const price = toContractPrice(input.priceWire, input.params, input.side);
  const size = toContractSize(input.sizeBase, input.params);
  const postOnly = input.postOnly ?? false;
  const purpose: ForwardablePurpose = input.side === 'buy' ? 'addBuyOrder' : 'addSellOrder';
  const data = encodeFunctionData({
    abi: orderBookAbi,
    functionName: input.side === 'buy' ? 'addBuyOrder' : 'addSellOrder',
    args: [Number(price.price), size.size, postOnly],
  });
  return { to: input.market, data, purpose, price, size };
}

export interface MarketOrderInput {
  readonly market: Address;
  readonly params: MarketParams;
  readonly side: Side;
  /**
   * Buy: quote spend in quote base units. Sell: base size in base base units.
   * Both are converted to the market's `uint96` scale.
   */
  readonly amount: bigint;
  readonly minAmountOut: bigint;
  /**
   * `true` draws from the user's MarginAccount balance, which is what a funded
   * account in this app always wants (spec §4.5).
   */
  readonly isMargin?: boolean;
  readonly isFillOrKill?: boolean;
}

export function buildMarketOrder(input: MarketOrderInput): BuiltCall {
  const isMargin = input.isMargin ?? true;
  const isFok = input.isFillOrKill ?? false;
  if (input.amount <= 0n) throw new Error('market order amount must be positive');

  if (input.side === 'buy') {
    // quoteSize is expressed in pricePrecision units of the quote asset.
    const quoteSize =
      (input.amount * input.params.pricePrecision) / 10n ** BigInt(input.params.quoteDecimals);
    if (quoteSize <= 0n) throw new Error('market buy is too small to express in pricePrecision');
    if (quoteSize > UINT96_MAX) throw new Error('market buy overflows uint96');
    return {
      to: input.market,
      purpose: 'placeAndExecuteMarketBuy',
      data: encodeFunctionData({
        abi: orderBookAbi,
        functionName: 'placeAndExecuteMarketBuy',
        args: [quoteSize, input.minAmountOut, isMargin, isFok],
      }),
    };
  }

  // `false`: a market sell is a taker, and `minSize` gates only resting orders — see
  // `toContractSize`. Enforcing it here refused fills the venue accepts.
  const size = toContractSize(input.amount, input.params, false);
  return {
    to: input.market,
    purpose: 'placeAndExecuteMarketSell',
    data: encodeFunctionData({
      abi: orderBookAbi,
      functionName: 'placeAndExecuteMarketSell',
      args: [size.size, input.minAmountOut, isMargin, isFok],
    }),
  };
}

/**
 * A plain ERC-20 transfer, for `/send`.
 *
 * Not a Kuru call and deliberately not in `FORWARDABLE_SELECTORS` — the relayer's
 * sponsorship policy allows it on its own narrow terms (three pinned tokens, a
 * recipient that is not a contract this app knows, the per-order notional cap; D128),
 * and the forwardable list is about Kuru's own contracts.
 */
export interface BuiltTransfer {
  readonly to: Address;
  readonly data: Hex;
  readonly purpose: 'erc20Transfer';
}

export function buildErc20Transfer(token: Address, to: Address, amount: bigint): BuiltTransfer {
  if (amount <= 0n) throw new Error('a transfer must move a positive amount');
  return {
    to: token,
    purpose: 'erc20Transfer',
    data: encodeFunctionData({
      abi: [
        {
          type: 'function',
          name: 'transfer',
          stateMutability: 'nonpayable',
          inputs: [
            { name: 'to', type: 'address' },
            { name: 'amount', type: 'uint256' },
          ],
          outputs: [{ type: 'bool' }],
        },
      ] as const,
      functionName: 'transfer',
      args: [to, amount],
    }),
  };
}

/**
 * A plain native-MON send, for `/send` (D200).
 *
 * No calldata and no selector — a native transfer is just `value` arriving at `to` —
 * so this is not a Kuru call and not in `FORWARDABLE_SELECTORS` either, the same as
 * `buildErc20Transfer`. The relayer's sponsorship policy allows it on its own narrow
 * terms: no calldata, a recipient that is not a contract this app knows, a positive
 * amount (`assertSponsoredNativeSend`).
 */
export interface BuiltNativeSend {
  readonly to: Address;
  readonly data: '0x';
  readonly value: bigint;
  readonly purpose: 'nativeSend';
}

export function buildNativeSend(to: Address, amount: bigint): BuiltNativeSend {
  if (amount <= 0n) throw new Error('a send must move a positive amount');
  return { to, data: '0x', value: amount, purpose: 'nativeSend' };
}

export function buildCancelOrders(market: Address, orderIds: readonly bigint[]): BuiltCall {
  if (orderIds.length === 0) throw new Error('batchCancelOrders needs at least one order id');
  for (const id of orderIds) {
    if (id < 0n || id > UINT40_MAX) throw new Error(`order id ${id} does not fit in uint40`);
  }
  return {
    to: market,
    purpose: 'batchCancelOrders',
    data: encodeFunctionData({
      abi: orderBookAbi,
      functionName: 'batchCancelOrders',
      args: [orderIds.map((id) => Number(id))],
    }),
  };
}

/**
 * `MarginAccount.deposit(user, token, amount)`.
 *
 * Verified 2026-09-02 that the pull is against `_msgSender()` and not raw
 * `msg.sender`: an `eth_call` from the forwarder with the ERC-2771 sender suffix
 * appended succeeded against a token mock that only accepts `transferFrom` from the
 * suffixed address, and reverted against mocks expecting the forwarder. So a
 * forwarded deposit debits the user, and the `DepositHelper` fallback in spec §4.2
 * is not needed. See DECISIONS.md open item 11.
 */
export function buildDeposit(
  marginAccount: Address,
  user: Address,
  token: Address,
  amount: bigint,
): BuiltCall {
  if (amount <= 0n) throw new Error('deposit amount must be positive');
  return {
    to: marginAccount,
    purpose: 'marginAccountDeposit',
    data: encodeFunctionData({
      abi: marginAccountAbi,
      functionName: 'deposit',
      args: [user, token, amount],
    }),
  };
}

export function buildWithdraw(marginAccount: Address, token: Address, amount: bigint): BuiltCall {
  if (amount <= 0n) throw new Error('withdraw amount must be positive');
  return {
    to: marginAccount,
    purpose: 'marginAccountWithdraw',
    data: encodeFunctionData({
      abi: marginAccountAbi,
      functionName: 'withdraw',
      args: [amount, token],
    }),
  };
}
