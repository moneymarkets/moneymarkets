import { NextResponse } from 'next/server';
import { getAddress, isAddress, type Address } from 'viem';
import { assertFlowQuoteMatchesRequest, KuruFlowClient, KURU_FLOW_ROUTER } from '@tradepro/core';
import { addresses } from '../../../../lib/server/chain';
import { upstreamFrom } from '../../../../lib/server/revertDetail';

/**
 * A live Kuru Flow quote for converting USDC into AUSD, proxied server-side.
 *
 * Flow's own API rate-limits to 1 request/second, burst 1, per its generated token,
 * and that token is requested fresh here rather than cached across users — this route
 * is called on user intent (typing an amount, debounced), never in a render loop, the
 * same discipline `/api/fund/convert` already follows for the book quote.
 *
 * `assertFlowQuoteMatchesRequest` is re-run here, server-side, before this quote is
 * ever shown to a user or signed against — the same honesty check the relayer's
 * policy re-runs at submission time (rule D101/D102), so a quote whose JSON and whose
 * calldata disagree is refused before a passkey prompt, not after.
 *
 * ## The WMON refusal
 *
 * Traced live 2026-09-08 (`debug_traceCall`): a route past what the direct AUSD/USDC
 * book can fill goes through WMON instead, wrapping and unwrapping native MON inside
 * the router. The trace found no case where that native MON reaches the caller's own
 * address, but the router publishes no ABI and no verified source, so nothing outside
 * it can prove every branch is that clean — and the account signing this is exactly
 * the kind Monad enforces a 10-MON native-balance reserve against under EIP-7702. A
 * route this app cannot verify is refused here, before a quote is ever shown, rather
 * than let a delegated, near-zero-MON account discover the reserve rule by reverting.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  const url = new URL(request.url);

  const amountRaw = url.searchParams.get('amount') ?? '';
  if (!/^\d+$/.test(amountRaw) || BigInt(amountRaw) <= 0n) {
    return NextResponse.json({ error: 'BAD_REQUEST' }, { status: 400 });
  }
  const amount = BigInt(amountRaw);

  const addressRaw = url.searchParams.get('address') ?? '';
  if (!isAddress(addressRaw)) {
    return NextResponse.json({ error: 'BAD_REQUEST' }, { status: 400 });
  }
  const userAddress = getAddress(addressRaw);

  const chain = addresses();
  const usdc = chain.tokens.USDC?.address as Address | undefined;
  const ausd = chain.tokens.AUSD?.address as Address | undefined;
  if (!usdc || !ausd) {
    return NextResponse.json({ error: 'NO_CONVERSION_PAIR_ON_THIS_CHAIN' }, { status: 503 });
  }

  try {
    const client = new KuruFlowClient();
    const quote = await client.quote({
      userAddress,
      tokenIn: usdc,
      tokenOut: ausd,
      amount,
    });
    // Belt and suspenders: the client already runs this, but a route that hands a
    // signature-worthy quote to the browser checks it again itself rather than
    // trusting an import to have done so.
    assertFlowQuoteMatchesRequest(quote, { tokenIn: usdc, tokenOut: ausd, amount });

    // v2.1 spec 3.1: a zero-value route is executed as returned — the account's
    // native balance cannot move in it, and the WMON-in-the-route heuristic refusal
    // is deleted with every sentence like it. Only a route DEMANDING native value
    // with the call is refused (the relayer's VALUE_NOT_ZERO non-negotiable cannot
    // carry it), stated as the route's own requirement.
    if (quote.value !== 0n) {
      return NextResponse.json(
        {
          error: 'FLOW_ROUTE_NEEDS_NATIVE_VALUE',
          upstream: {
            source: 'Kuru Flow',
            message: `the returned route requires ${quote.value.toString()} wei of native MON sent with the call`,
          },
        },
        { status: 503 },
      );
    }

    return NextResponse.json(
      {
        router: KURU_FLOW_ROUTER,
        to: quote.to,
        data: quote.calldata,
        value: quote.value.toString(),
        amountIn: amount.toString(),
        output: quote.output.toString(),
        minOut: quote.minOut.toString(),
        readAt: Date.now(),
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    console.error('Kuru Flow quote failed', error);
    // Flow's own words ride along, verbatim (error-handling rule, 2026-09-08).
    return NextResponse.json(
      { error: 'CONVERSION_UNQUOTABLE', upstream: upstreamFrom('Kuru Flow', error) },
      { status: 502 },
    );
  }
}
