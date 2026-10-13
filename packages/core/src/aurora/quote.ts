import { z } from 'zod';
import type { Address } from 'viem';

/**
 * NEAR Intents / 1Click quotes — the "any chain to Monad" funding leg (spec §7).
 *
 * ## What was measured, not assumed
 *
 * Read live from `POST https://1click.chaindefuser.com/v0/quote` on 2026-09-02, with
 * no JWT, for 25 USDT on Tron to USDC on Monad delivered to the M0 test account:
 *
 *   amountIn        25000000        (25.0 USDT, $24.9886)
 *   amountOut       24962280        (24.96228 USDC, $24.9545916)
 *   minAmountOut    24712657        at slippageTolerance 100 bps
 *   timeEstimate    82 seconds
 *   refundFee       883706          (0.883706 USDT, charged only if it refunds)
 *   withdrawFee     685
 *
 * The effective spread is **0.1509%**, not the 0.2% quoted for keyless use — the
 * documented 0.2% is a ceiling, so the fee is read from each quote rather than
 * assumed. A free JWT removes it; see `ONE_CLICK_JWT` below.
 *
 * ## Two constraints the API enforces that are easy to get wrong
 *
 * 1. **`refundTo` must be an address on the ORIGIN chain**, not the destination. A
 *    Tron-origin quote with an EVM `refundTo` is rejected outright with
 *    `"refundTo is not valid"`, and so is `refundType: 'INTENTS'` given an EVM
 *    address. For a Tron deposit the user must supply a Tron address they control.
 *    This is not cosmetic: `refundTo` is where the money goes if the swap fails.
 * 2. **`dry: true` returns no `depositAddress`.** Only a real quote allocates one.
 *    So a UI cannot preview a deposit address; it previews a price, and the address
 *    appears only once the user commits to a real quote.
 *
 * Responses are signed — the payload carries a `signature` — so a quote shown to a
 * user can be checked rather than trusted.
 */

export const ONE_CLICK_QUOTE_URL = 'https://1click.chaindefuser.com/v0/quote';
export const ONE_CLICK_STATUS_URL = 'https://1click.chaindefuser.com/v0/status';

/** The published ceiling for keyless use. Real quotes have come in under it. */
export const ONE_CLICK_KEYLESS_FEE_BPS = 20;

export type SwapType = 'EXACT_INPUT' | 'EXACT_OUTPUT';
export type DepositType = 'ORIGIN_CHAIN' | 'INTENTS';
export type RefundType = 'ORIGIN_CHAIN' | 'INTENTS';
export type RecipientType = 'DESTINATION_CHAIN' | 'INTENTS';

export interface QuoteRequestInput {
  readonly originAsset: string;
  readonly destinationAsset: string;
  /** Base units of the origin asset, as a decimal string. */
  readonly amount: bigint;
  /** Where the funds land on Monad. */
  readonly recipient: Address;
  /**
   * Where a failed swap returns to. Must be an address on the ORIGIN chain — an EVM
   * address is rejected for a Tron-origin quote.
   */
  readonly refundTo: string;
  readonly slippageToleranceBps?: number;
  readonly deadline?: Date;
  readonly swapType?: SwapType;
  readonly depositType?: DepositType;
  readonly refundType?: RefundType;
  readonly recipientType?: RecipientType;
  /** `true` prices the route without allocating a deposit address. */
  readonly dry: boolean;
}

export function buildQuoteRequest(input: QuoteRequestInput): Record<string, unknown> {
  if (input.amount <= 0n) throw new Error('quote amount must be positive');
  const slippage = input.slippageToleranceBps ?? 100;
  if (!Number.isInteger(slippage) || slippage < 0 || slippage > 10_000) {
    throw new Error(`slippageTolerance ${slippage} is not a sane basis-point value`);
  }
  if (!input.refundTo) {
    throw new Error('refundTo is required: it is where the money goes if the swap fails');
  }
  const deadline = input.deadline ?? new Date(Date.now() + 3_600_000);
  return {
    dry: input.dry,
    swapType: input.swapType ?? 'EXACT_INPUT',
    slippageTolerance: slippage,
    originAsset: input.originAsset,
    depositType: input.depositType ?? 'ORIGIN_CHAIN',
    destinationAsset: input.destinationAsset,
    amount: input.amount.toString(),
    refundTo: input.refundTo,
    refundType: input.refundType ?? 'ORIGIN_CHAIN',
    recipient: input.recipient,
    recipientType: input.recipientType ?? 'DESTINATION_CHAIN',
    deadline: deadline.toISOString(),
  };
}

/** Every external payload gets a schema (rule A5). */
export const oneClickQuoteSchema = z.object({
  quote: z.object({
    amountIn: z.string(),
    amountInFormatted: z.string().optional(),
    amountInUsd: z.string().optional(),
    minAmountIn: z.string().optional(),
    amountOut: z.string(),
    amountOutFormatted: z.string().optional(),
    amountOutUsd: z.string().optional(),
    minAmountOut: z.string(),
    timeEstimate: z.number().optional(),
    refundFee: z.string().optional(),
    withdrawFee: z.string().optional(),
    // Present only when `dry` is false.
    depositAddress: z.string().optional(),
    /** When the deposit address stops accepting funds. Real quotes only. */
    deadline: z.string().optional(),
    timeWhenInactive: z.string().optional(),
  }),
  signature: z.string().optional(),
  timestamp: z.string().optional(),
  correlationId: z.string().optional(),
});

export type OneClickQuote = z.infer<typeof oneClickQuoteSchema>;

/**
 * USD figures are carried at six decimal places, which is the precision the network
 * itself publishes them at (`amountInUsd: "4.999045000000"`).
 */
export const USD_DECIMALS = 6;

/**
 * Read a decimal USD string into base units without touching a float (rule A2.6).
 * Extra places are truncated, never rounded up: a fee must not grow in the parser.
 */
export function parseUsd(value: string | undefined): bigint | undefined {
  if (value === undefined) return undefined;
  const s = value.trim();
  if (!/^-?\d*(\.\d*)?$/.test(s) || s === '' || s === '.' || s === '-') return undefined;
  const negative = s.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? s.slice(1) : s).split('.');
  const units = BigInt(
    (whole === '' ? '0' : whole) + fraction.padEnd(USD_DECIMALS, '0').slice(0, USD_DECIMALS),
  );
  return negative ? -units : units;
}

export interface QuoteEconomics {
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly minAmountOut: bigint;
  /** What the deposit is worth, in USD base units. Absent if the quote omitted it. */
  readonly valueInUsd?: bigint;
  /** What the delivery is worth, in USD base units. */
  readonly valueOutUsd?: bigint;
  /** The whole cost of the route, in USD base units. Only when both values exist. */
  readonly feeUsd?: bigint;
  /** That same cost as a ratio, in basis points. Only when both values exist. */
  readonly feeBps?: bigint;
  /**
   * How far below the quote the delivery may land before it is refused, in basis
   * points of the **destination** asset. Always available, because both sides of it
   * are the same asset.
   */
  readonly slippageBps: bigint;
  /**
   * The exact fee in destination base units — available **only** when the origin and
   * destination are the same asset with the same decimals. `undefined` otherwise.
   */
  readonly feeSameAsset?: bigint;
  /** Charged only if the deposit is refunded, in origin base units. */
  readonly refundFee?: bigint;
  /** Charged on delivery, in destination base units. */
  readonly withdrawFee?: bigint;
}

/**
 * What the route actually costs, from the quote's own numbers rather than from the
 * published fee. Integer math throughout (rule A2.6).
 *
 * ## Why the fee is not `amountIn - amountOut`
 *
 * It was, and it was wrong by two orders of magnitude on any route whose two sides
 * are not the same asset. `amountIn` is base units of the **origin** asset and
 * `amountOut` is base units of the **destination** asset: for SOL to USDC that is
 * 9 decimals against 6, at a hundred dollars a unit against one. Subtracting them
 * subtracts nine-decimal lamports from six-decimal cents and calls the remainder a
 * fee. A ~$1 SOL deposit that really costs about 1% came out as **9008 bps**, which
 * is not a rounding error but a category error — and it read as plausible on
 * USDC-to-USDC only because there both sides happen to be six-decimal dollars.
 *
 * The two sides have exactly one common denominator, and the network publishes it:
 * `amountInUsd` and `amountOutUsd`. The fee is the gap between them. Where the
 * network omits them the fee is reported as unknown rather than computed from
 * incomparable units, because a number nobody can compare is worse than no number.
 *
 * Slippage is a different quantity and does not have this problem: `amountOut` and
 * `minAmountOut` are both the destination asset, so their ratio is exact and always
 * available. It is the one figure that stays a ratio.
 */
export function quoteEconomics(quote: OneClickQuote): QuoteEconomics {
  const q = quote.quote;
  const amountIn = BigInt(q.amountIn);
  const amountOut = BigInt(q.amountOut);
  const minAmountOut = BigInt(q.minAmountOut);
  if (amountIn <= 0n) throw new Error('quote amountIn must be positive');
  if (amountOut <= 0n) throw new Error('quote amountOut must be positive');

  const valueInUsd = parseUsd(q.amountInUsd);
  const valueOutUsd = parseUsd(q.amountOutUsd);
  const comparable = valueInUsd !== undefined && valueOutUsd !== undefined && valueInUsd > 0n;

  return {
    amountIn,
    amountOut,
    minAmountOut,
    ...(valueInUsd !== undefined ? { valueInUsd } : {}),
    ...(valueOutUsd !== undefined ? { valueOutUsd } : {}),
    ...(comparable
      ? {
          feeUsd: valueInUsd - valueOutUsd,
          feeBps: ((valueInUsd - valueOutUsd) * 10_000n) / valueInUsd,
        }
      : {}),
    slippageBps: ((amountOut - minAmountOut) * 10_000n) / amountOut,
    ...(q.refundFee !== undefined ? { refundFee: BigInt(q.refundFee) } : {}),
    ...(q.withdrawFee !== undefined ? { withdrawFee: BigInt(q.withdrawFee) } : {}),
  };
}

/**
 * The fee in destination base units, for a route whose two sides really are the same
 * asset at the same precision. Anything else returns `undefined`: there is no
 * subtraction to do across two different assets.
 */
export function sameAssetFee(
  economics: Pick<QuoteEconomics, 'amountIn' | 'amountOut'>,
  originDecimals: number,
  destinationDecimals: number,
  originSymbol: string,
  destinationSymbol: string,
): bigint | undefined {
  if (originDecimals !== destinationDecimals) return undefined;
  if (originSymbol !== destinationSymbol) return undefined;
  return economics.amountIn - economics.amountOut;
}

/**
 * A deposit address exists only on a real quote. Callers must not present a dry
 * quote as something a user can send money to.
 */
export function depositAddressOf(quote: OneClickQuote): string | undefined {
  return quote.quote.depositAddress;
}

/**
 * ## Why a refusal is a value, not a string
 *
 * 1Click answers a bad quote with a 400 and one sentence. Two of those sentences
 * carry the whole answer and the third is a genuine stop, and a screen that collapses
 * them into "no price available" throws away the only actionable part:
 *
 *   `Amount is too low for bridge, try at least 150000`
 *     — measured 2026-09-03, USDC on Base -> USDC on Monad. **150000 is base units**,
 *       so 0.15 USDC. The boundary is exact: 149999 is refused and 150000 is priced.
 *       The minimum is not in the token list — `GET /v0/tokens` carries only
 *       assetId, decimals, blockchain, symbol, price, priceUpdatedAt,
 *       contractAddress and coingeckoId — so the quote's own refusal is the *only*
 *       published source for it, and it is read from there rather than remembered.
 *
 *   `refundTo is not valid`
 *     — the address is not on the origin chain. Checked **before** the amount:
 *       a Tron-origin quote with an EVM refundTo is refused for the address even
 *       when the amount is one base unit, so an origin chain's minimum cannot be
 *       discovered until a valid refund address for it exists.
 *
 * Anything else is a route that genuinely did not price, which is a different screen.
 */

export const oneClickErrorSchema = z.object({
  message: z.string(),
  correlationId: z.string().optional(),
  timestamp: z.string().optional(),
  path: z.string().optional(),
  statusCode: z.number().optional(),
  error: z.string().optional(),
});

export type OneClickError = z.infer<typeof oneClickErrorSchema>;

/** `try at least N` — N is base units of the origin asset. */
const MINIMUM_HINT = /try at least\s+(\d+)/i;

/**
 * `minimum swap amount is $1,000` — a USD-denominated floor, first seen live
 * 2026-09-08 as `Temporary swap limits: minimum swap amount is $1,000`. A different
 * unit from `try at least N` (which is origin-asset base units), so it is carried as
 * `minimumUsd`, never converted into base units by guessing a price.
 */
const USD_MINIMUM_HINT = /minimum swap amount is\s+\$\s?([\d,]+(?:\.\d+)?)/i;

export type QuoteRefusal =
  /**
   * The amount is under the route's floor. Exactly one of the two figures is set:
   * `minimum` is base units of the origin asset (`try at least N`), `minimumUsd` is
   * USD base units at {@link USD_DECIMALS} (`minimum swap amount is $X`). Both come
   * out of the network's own sentence, which is kept verbatim in `message`.
   */
  | {
      readonly kind: 'AMOUNT_BELOW_MINIMUM';
      readonly minimum?: bigint;
      readonly minimumUsd?: bigint;
      readonly message: string;
      readonly status: number;
    }
  /** `refundTo` is not an address on the origin chain. */
  | { readonly kind: 'REFUND_ADDRESS_INVALID'; readonly message: string; readonly status: number }
  /** The network answered, and the answer was no. */
  | { readonly kind: 'ROUTE_UNAVAILABLE'; readonly message: string; readonly status: number };

/**
 * Turn a refused quote into one of three answers.
 *
 * `body` is the raw response text: a refusal is not always JSON, and a parser that
 * throws on a gateway's HTML would hide the status code that mattered.
 *
 * Whatever the classification, `message` is the network's own sentence verbatim —
 * classification never rewrites or drops it. `classifyQuoteRefusal.test.ts` holds
 * that line.
 */
export function classifyQuoteRefusal(status: number, body: string): QuoteRefusal {
  let message = body.trim().slice(0, 300);
  const parsed = oneClickErrorSchema.safeParse(safeJson(body));
  if (parsed.success) message = parsed.data.message;

  const hint = MINIMUM_HINT.exec(message);
  if (hint?.[1]) {
    return { kind: 'AMOUNT_BELOW_MINIMUM', minimum: BigInt(hint[1]), message, status };
  }
  const usdHint = USD_MINIMUM_HINT.exec(message);
  if (usdHint?.[1]) {
    const minimumUsd = parseUsd(usdHint[1].replace(/,/g, ''));
    if (minimumUsd !== undefined) {
      return { kind: 'AMOUNT_BELOW_MINIMUM', minimumUsd, message, status };
    }
  }
  if (/refundto/i.test(message)) {
    return { kind: 'REFUND_ADDRESS_INVALID', message, status };
  }
  return {
    kind: 'ROUTE_UNAVAILABLE',
    message: message || `the network answered ${status}`,
    status,
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The real deadline is the one the network sends back, not the one that was asked
 * for. A quote requested with a one-hour deadline came back with
 * `deadline`/`timeWhenInactive` three days out (measured 2026-09-03), so counting
 * down our own request would tell the user their address had expired while it was
 * still live.
 */
export function depositExpiryOf(quote: OneClickQuote): number | undefined {
  const raw = quote.quote.timeWhenInactive ?? quote.quote.deadline;
  if (!raw) return undefined;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : at;
}
