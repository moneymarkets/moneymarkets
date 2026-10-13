import { NextResponse } from 'next/server';
import { getAddress, isAddress, type Address } from 'viem';
import { z } from 'zod';
import {
  AUSD_USDC_MARKET,
  conversionRoute,
  decodeMarketParams,
  minAmountOutFor,
  orderBookAbi,
  quoteConversion,
} from '@tradepro/core';
import { addresses, readClient } from '../../../../lib/server/chain';
import { kuruUpstreamFrom } from '../../../../lib/server/revertDetail';

/**
 * What a USDC balance is worth in AUSD, quoted against the live book.
 *
 * ## Why this is a real quote and not a mid-price
 *
 * The verified `OrderBook` implementation behind AUSD/USDC answers a market order
 * sent from `address(0)` by matching against real depth and returning the credit
 * without touching state — the debit and the credit are both skipped for the zero
 * sender. `quoteConversion` is exactly that `eth_call`. Nothing is written, nothing
 * is signed, no approval exists and no state override is used. The number that comes
 * back is what the book would actually fill.
 *
 * ## The direction, and why it is not passed in
 *
 * AUSD/USDC has **baseAsset AUSD, quoteAsset USDC**. Spending USDC to receive AUSD
 * therefore spends the quote asset to receive the base asset, which on this venue is
 * `placeAndExecuteMarketBuy`. A market *sell* runs the other way and would hand back
 * the USDC the user is trying to be rid of. `conversionRoute()` derives the side from
 * the market's own `getMarketParams()` and there is no way to pass one in, so the two
 * cannot drift.
 *
 * ## The slippage floor
 *
 * 10 bps — 0.1% — as instructed, well inside the 100 bps cap `minAmountOutFor`
 * enforces and comfortably past the ~1.5 bp spread this book quotes. `minAmountOut`
 * is never zero: a market order with no floor is a standing offer to accept any fill.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * 0.1%, per the funding brief. Well inside the 100 bps cap `minAmountOutFor` enforces
 * and comfortably past the ~1.5 bp spread this book quotes.
 *
 * This is the opposite floor `lib/ticket.ts`'s live-trade market order uses for the
 * same underlying `placeAndExecuteMarketBuy` primitive (audit High #16) — reconciled,
 * not overlooked. The standard: a market order built from a quote fetched in the
 * background, with no live book shown between the quote and the signature (this
 * route, called from `/fund`), needs an explicit floor. A market order placed from a
 * screen the user is watching the live book on (`/trade/[market]`) does not — the
 * book they see is the floor, and I1/I6 already refuse to trade against one that is
 * stale or crossed. `BOOK_CONVERSION_MIN_USDC` (`lib/fund/pathB.ts`) is a different
 * number entirely — the book's own minimum order size, not a slippage floor — and
 * decides routing (book vs Kuru Flow), not tolerance.
 */
export const CONVERSION_SLIPPAGE_BPS = 10n;

// audit M6: this route's input is now bounded by a schema, not a bare regex plus a
// bigint parse. `amount` is capped at 30 digits — no real balance needs more, and an
// unbounded digit string reaching `BigInt()` is exactly the kind of shape zod exists
// to refuse before it gets there.
const querySchema = z.object({
  amount: z.string().regex(/^\d{1,30}$/),
  market: z.string().optional(),
});

export async function GET(request: Request) {
  const url = new URL(request.url);

  const parsed = querySchema.safeParse({
    amount: url.searchParams.get('amount') ?? '',
    ...(url.searchParams.get('market') ? { market: url.searchParams.get('market') } : {}),
  });
  if (!parsed.success) {
    return NextResponse.json({ error: 'BAD_REQUEST' }, { status: 400 });
  }
  const amountIn = BigInt(parsed.data.amount);
  if (amountIn <= 0n) {
    return NextResponse.json({ error: 'BAD_REQUEST' }, { status: 400 });
  }

  const chain = addresses();
  const usdc = chain.tokens.USDC?.address as Address | undefined;
  const ausd = chain.tokens.AUSD?.address as Address | undefined;
  if (!usdc || !ausd) {
    return NextResponse.json({ error: 'NO_CONVERSION_PAIR_ON_THIS_CHAIN' }, { status: 503 });
  }

  // A market that fails `isAddress` falls back to the default rather than erroring —
  // unchanged from before zod: this parameter picks a market to quote, and an
  // unrecognised one is not a request malformed enough to refuse outright.
  const requested = parsed.data.market;
  const market: Address =
    requested && isAddress(requested) ? getAddress(requested) : AUSD_USDC_MARKET;

  const client = readClient();

  try {
    const tuple = await client.readContract({
      address: market,
      abi: orderBookAbi,
      functionName: 'getMarketParams',
    });
    const params = decodeMarketParams(tuple as Parameters<typeof decodeMarketParams>[0]);
    // Derived from the market, never asserted by this file.
    const route = conversionRoute(market, params, usdc, ausd);
    const quote = await quoteConversion(client, route, params, amountIn);
    const minAmountOut = minAmountOutFor(quote.expectedOut, CONVERSION_SLIPPAGE_BPS);

    return NextResponse.json(
      {
        market,
        side: route.side,
        direction: route.direction,
        tokenIn: route.tokenIn,
        tokenOut: route.tokenOut,
        inDecimals: route.inDecimals,
        outDecimals: route.outDecimals,
        amountIn: quote.amountIn.toString(),
        expectedOut: quote.expectedOut.toString(),
        minAmountOut: minAmountOut.toString(),
        slippageBps: CONVERSION_SLIPPAGE_BPS.toString(),
        wireAmountIn: quote.wireAmountIn.toString(),
        /** True when the market's precision could not express the amount exactly. */
        adjusted: quote.adjusted,
        blockNumber: quote.blockNumber.toString(),
        source: quote.source,
        params: {
          pricePrecision: params.pricePrecision.toString(),
          sizePrecision: params.sizePrecision.toString(),
          baseAsset: params.baseAsset,
          baseDecimals: params.baseDecimals,
          quoteAsset: params.quoteAsset,
          quoteDecimals: params.quoteDecimals,
          tickSize: params.tickSize.toString(),
          minSize: params.minSize.toString(),
          maxSize: params.maxSize.toString(),
          takerFeeBps: params.takerFeeBps.toString(),
          makerFeeBps: params.makerFeeBps.toString(),
        },
        readAt: Date.now(),
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    console.error('AUSD/USDC conversion quote failed', market, error);
    // The venue's own answer rides along — a decoded revert name when the selector
    // is known, the raw first line otherwise. Never just the bare code
    // (error-handling rule, 2026-09-08).
    return NextResponse.json(
      { error: 'CONVERSION_UNQUOTABLE', upstream: kuruUpstreamFrom(error) },
      { status: 502 },
    );
  }
}
