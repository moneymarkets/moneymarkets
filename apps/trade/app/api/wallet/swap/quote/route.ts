import { NextResponse } from 'next/server';
import { getAddress, isAddress, type Address } from 'viem';
import {
  aggregateQuotes,
  DEFAULT_SLIPPAGE_BPS,
  flowVendor,
  isSlippageChoice,
  KYBER_MAX_SLIPPAGE_BPS,
  kyberSwapVendor,
  MAINNET,
  minOutFor,
  bpsReaching,
  MONAD_DELEGATED_RESERVE_WEI,
  NO_ROUTE_MESSAGE,
  type SwapTx,
  type SwapVendor,
} from '@tradepro/core';
import { readClient } from '../../../../../lib/server/chain';
import { simulateDelivery, type DeliveryResult } from '../../../../../lib/server/simulateDelivery';
import {
  buildSwapBatch,
  isNative,
  maxNativeSpend,
  routeToWire,
  swapKindOf,
  vendorToken,
  type SwapRoute,
  type SwapSource,
} from '../../../../../lib/wallet/swapPlan';

/**
 * `GET /api/wallet/swap/quote`: every keyless aggregator at once (KyberSwap, Kuru Flow;
 * Monorail dropped, reports/SWAP-VERIFY.md), ranked by this app's own minimum out, each
 * route simulated from the account before the screen ever offers it (rules 1.1 to 1.8).
 * Server-side only: the browser never talks to a vendor.
 *
 * Query: tokenIn, tokenOut (native MON is the zero address), amount (base units),
 * address (the signed-in account: taker and recipient, R4), slippageBps (10, 50, 100 or
 * 300; default 50), source ("wallet" or "trading").
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** Rule 1.5: a quote older than this is re-quoted before any Face ID prompt. */
export const SWAP_QUOTE_MAX_AGE_SECONDS = 20;

/** Tax probe (rule 1.7): the widest slippage both vendors accept, KyberSwap's cap. */
const PROBE_SLIPPAGE_BPS = KYBER_MAX_SLIPPAGE_BPS;

function referrer(): { referrerAddress?: Address; referrerFeeBps?: number } {
  const address = process.env.KURU_FLOW_REFERRER;
  if (!address || !isAddress(address)) return {};
  const raw = process.env.KURU_FLOW_REFERRER_BPS;
  const bps = raw === undefined || raw === '' ? undefined : Number(raw);
  return {
    referrerAddress: getAddress(address),
    ...(bps !== undefined && Number.isInteger(bps) && bps >= 0 ? { referrerFeeBps: bps } : {}),
  };
}

function vendors(): SwapVendor[] {
  return [kyberSwapVendor(), flowVendor(referrer())];
}

function toRoute(tx: SwapTx): SwapRoute {
  return {
    vendor: tx.vendor,
    displayName: tx.vendor === 'kyberswap' ? 'KyberSwap' : 'Kuru Flow',
    to: tx.to,
    data: tx.data,
    tokenIn: tx.tokenIn,
    tokenOut: tx.tokenOut,
    amountIn: tx.amountIn,
    expectedOut: tx.expectedOut,
    minOut: tx.minOut,
    ...(tx.gasEstimate !== undefined ? { gasEstimate: tx.gasEstimate } : {}),
  };
}

function simulationWire(result: DeliveryResult) {
  if (result.status === 'ok') return { status: 'ok' as const, delivered: result.delivered.toString() };
  if (result.status === 'reverted') return { status: 'reverted' as const, reason: result.reason };
  return { status: 'unchecked' as const };
}

function bad(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const tokenInRaw = url.searchParams.get('tokenIn') ?? '';
  const tokenOutRaw = url.searchParams.get('tokenOut') ?? '';
  const addressRaw = url.searchParams.get('address') ?? '';
  const amountRaw = url.searchParams.get('amount') ?? '';
  const slippageRaw = url.searchParams.get('slippageBps');
  const sourceRaw = url.searchParams.get('source') ?? 'wallet';

  if (!isAddress(tokenInRaw) || !isAddress(tokenOutRaw) || !isAddress(addressRaw)) return bad('BAD_REQUEST');
  if (!/^\d+$/.test(amountRaw) || BigInt(amountRaw) <= 0n) return bad('BAD_REQUEST');
  const slippageBps = slippageRaw === null ? DEFAULT_SLIPPAGE_BPS : Number(slippageRaw);
  if (!isSlippageChoice(slippageBps)) return bad('BAD_SLIPPAGE');
  if (sourceRaw !== 'wallet' && sourceRaw !== 'trading') return bad('BAD_REQUEST');
  const source: SwapSource = sourceRaw;

  const payToken = getAddress(tokenInRaw);
  const receiveToken = getAddress(tokenOutRaw);
  const account = getAddress(addressRaw);
  const amountIn = BigInt(amountRaw);
  if (payToken === receiveToken) return bad('SAME_TOKEN');

  const client = readClient();
  const marginAccount = MAINNET.kuru.marginAccount;
  const kind = swapKindOf(payToken, receiveToken);
  const base = {
    kind,
    tokenIn: payToken,
    tokenOut: receiveToken,
    amountIn: amountIn.toString(),
    slippageBps,
    source,
    holdSeconds: SWAP_QUOTE_MAX_AGE_SECONDS,
    readAt: Date.now(),
  };
  const headers = { 'cache-control': 'no-store' };

  // Rule 1.8: native MON leaves the wallet only if the wallet still ends at the reserve.
  const nativeBalance = await client.getBalance({ address: account });
  if (isNative(payToken) && source === 'wallet' && nativeBalance - amountIn < MONAD_DELEGATED_RESERVE_WEI) {
    return NextResponse.json(
      {
        ...base,
        routes: [],
        offered: null,
        reserve: { maxSpend: maxNativeSpend(nativeBalance, MONAD_DELEGATED_RESERVE_WEI).toString() },
      },
      { headers },
    );
  }

  // WMON to MON and MON to WMON: the wrapper itself, one to one, no aggregator.
  if (kind !== 'aggregated') {
    const calls = buildSwapBatch({ kind, marginAccount, payToken, amountIn, source });
    const sim = await simulateDelivery(client, account, calls, receiveToken);
    return NextResponse.json(
      {
        ...base,
        routes: [],
        offered: null,
        direct: {
          expectedOut: amountIn.toString(),
          minOut: amountIn.toString(),
          simulation: simulationWire(sim.status === 'ok' ? { status: 'ok', delivered: amountIn } : sim),
        },
      },
      { headers },
    );
  }

  const quoteRequest = {
    tokenIn: vendorToken(payToken),
    tokenOut: vendorToken(receiveToken),
    amountIn,
    taker: account,
    slippageBps,
  };

  const aggregated = await aggregateQuotes(vendors(), quoteRequest);
  for (const failure of aggregated.failures) {
    // Rule 1.4: the raw body goes to the server log, never to a screen.
    console.warn(
      JSON.stringify({
        at: 'swap-quote',
        vendor: failure.vendor,
        reason: failure.reason,
        rawBody: failure.rawBody?.slice(0, 2_000),
      }),
    );
  }
  if (aggregated.routes.length === 0) {
    return NextResponse.json({ ...base, routes: [], offered: null, message: NO_ROUTE_MESSAGE }, { headers });
  }

  // B3: a swap to native MON is quoted to WMON and unwraps the guaranteed minimum at
  // the end, but only when that leaves the wallet at or above the reserve (decided per
  // route below, on each route's own minimum).
  const wantsNative = isNative(receiveToken);
  const plan = (route: SwapRoute) => {
    const deliverNative = wantsNative && nativeBalance + route.minOut >= MONAD_DELEGATED_RESERVE_WEI;
    return {
      deliverNative,
      calls: buildSwapBatch({ kind, marginAccount, payToken, amountIn, source, route, deliverNative }),
    };
  };

  const routes = aggregated.routes.map(toRoute);
  const simulations = await Promise.all(
    routes.map((route) => simulateDelivery(client, account, plan(route).calls, route.tokenOut)),
  );

  // Rule 1.6: offer the first route, best first, whose simulation passes. A read that
  // could not run is not evidence either way and does not skip a route.
  let offered = simulations.findIndex((s) => s.status !== 'reverted');
  let feeOnTransfer: { delivered: string } | undefined;
  const finalRoutes = [...routes];
  const finalSims = [...simulations];

  // Rule 1.7: a route that passes but delivers less than its own minimum, or every route
  // reverting, can mean a token that takes a fee on transfer. Probe the best vendor with
  // the widest slippage to measure the real delivery, then quote again with the minimum
  // set from what actually arrives.
  const passedShort =
    offered >= 0 &&
    finalSims[offered]?.status === 'ok' &&
    (finalSims[offered] as { delivered: bigint }).delivered < finalRoutes[offered]!.minOut;
  if (offered < 0 || passedShort) {
    const best = routes[offered < 0 ? 0 : offered]!;
    const vendor = vendors().find((v) => v.id === best.vendor)!;
    const probe = await aggregateQuotes([vendor], { ...quoteRequest, slippageBps: PROBE_SLIPPAGE_BPS });
    const probeRoute = probe.routes[0] ? toRoute(probe.routes[0]) : undefined;
    const probeSim = probeRoute
      ? await simulateDelivery(client, account, plan(probeRoute).calls, probeRoute.tokenOut)
      : undefined;
    if (probeRoute && probeSim?.status === 'ok' && probeSim.delivered < minOutFor(probeRoute.expectedOut, slippageBps)) {
      const target = minOutFor(probeSim.delivered, slippageBps);
      const bps = bpsReaching(probeRoute.expectedOut, target, PROBE_SLIPPAGE_BPS);
      const retry = bps === undefined ? undefined : await aggregateQuotes([vendor], { ...quoteRequest, slippageBps: bps });
      const retryRoute = retry?.routes[0] ? toRoute(retry.routes[0]) : undefined;
      const retrySim = retryRoute
        ? await simulateDelivery(client, account, plan(retryRoute).calls, retryRoute.tokenOut)
        : undefined;
      if (retryRoute && retrySim && retrySim.status !== 'reverted') {
        // The re-quoted route replaces that vendor's first answer: one entry per vendor.
        const stale = finalRoutes.findIndex((r) => r.vendor === retryRoute.vendor);
        if (stale >= 0) {
          finalRoutes.splice(stale, 1);
          finalSims.splice(stale, 1);
        }
        finalRoutes.unshift(retryRoute);
        finalSims.unshift(retrySim);
        offered = 0;
        feeOnTransfer = {
          delivered: (retrySim.status === 'ok' ? retrySim.delivered : probeSim.delivered).toString(),
        };
      }
    }
  }

  const revert =
    offered < 0 ? (simulations[0]?.status === 'reverted' ? simulations[0].reason : undefined) : undefined;
  const offeredRoute = offered >= 0 ? finalRoutes[offered] : undefined;

  return NextResponse.json(
    {
      ...base,
      routes: finalRoutes.map((route, i) => ({ ...routeToWire(route), simulation: simulationWire(finalSims[i]!) })),
      offered: offered >= 0 ? offered : null,
      ...(offeredRoute ? { deliverNative: plan(offeredRoute).deliverNative } : {}),
      ...(feeOnTransfer ? { feeOnTransfer } : {}),
      ...(revert ? { revert } : {}),
    },
    { headers },
  );
}
