import { NextResponse } from 'next/server';
import { isAddress, getAddress } from 'viem';
import {
  decodeL2Book,
  decodeMarketParams,
  MarketParamsCache,
  normalizeBestBidAsk,
  orderBookAbi,
  quoteValuationFor,
  readQuoteUsdPrice,
  type QuotePriceReader,
} from '@tradepro/core';
import { readClient } from '../../../../lib/server/chain';
import { readVenueStateWith } from '../../../../lib/server/venueState';
import { isKnownMarket } from '../../../../lib/markets';

/**
 * Market data for one market.
 *
 * Browsers must not open a Kuru websocket: the venue caps connections at 5 per IP
 * and a room full of judges on one network would exhaust it (spec §6.3). So the
 * server reads the book from the chain — `bestBidAsk()` and `getL2Book()` — and the
 * client polls this route. The websocket fan-out this eventually becomes is Phase 3
 * work; this is the reduced-freshness fallback §4.3 already names.
 *
 * Everything is returned raw, in the scales the contract used, with the source named
 * so the client can hand it straight to `normalizeBook`. The route does not decide
 * whether the book is tradable; invariants I1 and I6 belong next to the ticket.
 *
 * ## `venue` — the market's own state, read per market
 *
 * I1 and I6 answer "is this book's data usable". They cannot answer "will this venue
 * accept an order", and the two are genuinely different: AUSD/USDC quotes a healthy
 * two-sided book and reverts `MarketStateError` on every trade path, while MON/AUSD
 * accepts calls and has nothing resting on it. Neither is visible in the book data,
 * so the ticket used to find out at the passkey prompt.
 *
 * `venue.state` is read here, per market, with a zero-sender `eth_call` — the same
 * read `quoteConversion()` already makes in production, which the verified OrderBook
 * answers by matching real depth while skipping both the debit and the credit. It
 * needs no balance and moves nothing, so its refusal is the market's own state and
 * never the caller's wallet.
 *
 * ## `quoteUsdPrice` — only for a market quoted in something other than a dollar
 *
 * The ticket checks the order cap before the user signs, and the cap is in dollars. For
 * a market quoted in native MON (emo/MON) that needs the live MON/USDC mid, so this
 * route reads it with the same core function the relayer uses after the user signs
 * (`readQuoteUsdPrice`), in parallel with the venue probe. It rides on the book poll the
 * ticket already makes, so it is exactly as fresh as the book, and a stale book disables
 * the ticket anyway. `null` means it could not be read or the pricing book has no
 * two-sided, uncrossed touch; the ticket then refuses rather than guessing. Absent for a
 * dollar-quoted market, which needs no price.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** The pricing book's params, read once per process and checked on every price read. */
let pricingParams: MarketParamsCache | undefined;

function quotePriceReader(): QuotePriceReader {
  const client = readClient();
  const cache = (pricingParams ??= new MarketParamsCache(client));
  return {
    params: (book) => cache.get(book),
    bestBidAsk: async (book) =>
      (await client.readContract({
        address: book,
        abi: orderBookAbi,
        functionName: 'bestBidAsk',
      })) as readonly [bigint, bigint],
  };
}

export async function GET(_request: Request, context: { params: Promise<{ market: string }> }) {
  const { market } = await context.params;

  if (!isAddress(market)) {
    return NextResponse.json({ error: 'NOT_AN_ADDRESS' }, { status: 400 });
  }
  if (!isKnownMarket(market)) {
    return NextResponse.json({ error: 'MARKET_NOT_CONFIGURED' }, { status: 404 });
  }

  const address = getAddress(market);
  const client = readClient();

  try {
    const [paramsTuple, bestBidAsk, blob] = await Promise.all([
      client.readContract({ address, abi: orderBookAbi, functionName: 'getMarketParams' }),
      client.readContract({ address, abi: orderBookAbi, functionName: 'bestBidAsk' }),
      client.readContract({ address, abi: orderBookAbi, functionName: 'getL2Book' }),
    ]);

    const params = decodeMarketParams(paramsTuple as never);
    const decoded = decodeL2Book(blob as `0x${string}`);
    const [rawBid, rawAsk] = bestBidAsk as readonly [bigint, bigint];
    // Folded exactly once, here, where the contract's convention is read. The raw
    // `2^256-1` no-bid sentinel used to reach the ticket, where "greater than zero"
    // reads as "there is a bid" and a reference price of 1.157e77 was computed from it.
    const { bestBid, bestAsk } = normalizeBestBidAsk(rawBid, rawAsk);
    const valuation = quoteValuationFor(params);
    const [venue, quoteUsdPrice] = await Promise.all([
      readVenueStateWith(address, params, bestBid, bestAsk),
      valuation?.kind === 'priced'
        ? readQuoteUsdPrice(quotePriceReader(), valuation)
        : Promise.resolve(undefined),
    ]);

    return NextResponse.json(
      {
        market: address,
        source: 'contract-getL2Book',
        state: 'finalized',
        blockNumber: decoded.blockNumber.toString(),
        readAt: Date.now(),
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
        // `bestBidAsk()` is already 1e18; the L2 prices are pricePrecision units.
        // `normalizeBook` takes bestBid/bestAsk verbatim and rescales the levels.
        bestBid: bestBid.toString(),
        bestAsk: bestAsk.toString(),
        venue,
        ...(valuation?.kind === 'priced'
          ? { quoteUsdPrice: quoteUsdPrice === undefined ? null : quoteUsdPrice.toString() }
          : {}),
        bids: decoded.bids.map((l) => [l.price.toString(), l.size.toString()]),
        asks: decoded.asks.map((l) => [l.price.toString(), l.size.toString()]),
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    // The reason goes to the server log; the client gets a fact, not a stack.
    console.error('market read failed', address, error);
    return NextResponse.json({ error: 'MARKET_READ_FAILED' }, { status: 502 });
  }
}

