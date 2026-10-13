import { NextResponse } from 'next/server';
import { getAddress, isAddress, isHex } from 'viem';
import { MAINNET, MONAD_DELEGATED_RESERVE_WEI } from '@tradepro/core';
import { readClient } from '../../../../../lib/server/chain';
import { simulateDelivery } from '../../../../../lib/server/simulateDelivery';
import {
  buildSwapBatch,
  isNative,
  routeFromWire,
  swapKindOf,
  type SwapRouteWire,
} from '../../../../../lib/wallet/swapPlan';

/**
 * `POST /api/wallet/swap/simulate`: the pre-sign gate, run at the tap and before any
 * Face ID prompt (rule 1.6). The browser sends the ranked routes it was quoted; this
 * rebuilds each route's batch with the same builder the browser signs with (never
 * trusting calls sent from the page), simulates them in rank order from the account,
 * and answers with the first that passes. Only when every one reverts does it return
 * the best route's decoded revert.
 *
 * Nothing here signs, sends, or holds a key.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface Body {
  sender?: string;
  tokenIn?: string;
  tokenOut?: string;
  amountIn?: string;
  source?: string;
  routes?: SwapRouteWire[];
}

const VENDORS = new Set(['kyberswap', 'kuru-flow']);

function validRoute(r: SwapRouteWire): boolean {
  return (
    VENDORS.has(r.vendor) &&
    isAddress(r.to) &&
    isHex(r.data) &&
    isAddress(r.tokenIn) &&
    isAddress(r.tokenOut) &&
    [r.amountIn, r.expectedOut, r.minOut].every((v) => typeof v === 'string' && /^\d+$/.test(v))
  );
}

export async function POST(request: Request) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'BAD_REQUEST' }, { status: 400 });
  }
  if (
    !body.sender ||
    !isAddress(body.sender) ||
    !body.tokenIn ||
    !isAddress(body.tokenIn) ||
    !body.tokenOut ||
    !isAddress(body.tokenOut) ||
    !body.amountIn ||
    !/^\d+$/.test(body.amountIn) ||
    (body.source !== 'wallet' && body.source !== 'trading')
  ) {
    return NextResponse.json({ error: 'BAD_REQUEST' }, { status: 400 });
  }

  const sender = getAddress(body.sender);
  const payToken = getAddress(body.tokenIn);
  const receiveToken = getAddress(body.tokenOut);
  const amountIn = BigInt(body.amountIn);
  const source = body.source;
  const kind = swapKindOf(payToken, receiveToken);
  const marginAccount = MAINNET.kuru.marginAccount;
  const client = readClient();
  const headers = { 'cache-control': 'no-store' };

  if (kind !== 'aggregated') {
    const result = await simulateDelivery(
      client,
      sender,
      buildSwapBatch({ kind, marginAccount, payToken, amountIn, source }),
      receiveToken,
    );
    return NextResponse.json(
      result.status === 'reverted' ? { chosen: null, revert: result.reason } : { chosen: null, direct: true },
      { headers },
    );
  }

  const wires = Array.isArray(body.routes) ? body.routes.slice(0, 4) : [];
  if (wires.length === 0 || !wires.every(validRoute)) {
    return NextResponse.json({ error: 'BAD_REQUEST' }, { status: 400 });
  }

  const nativeBalance = isNative(receiveToken) ? await client.getBalance({ address: sender }) : 0n;
  let bestRevert: string | undefined;
  for (const [index, wire] of wires.entries()) {
    const route = routeFromWire(wire);
    const deliverNative = isNative(receiveToken) && nativeBalance + route.minOut >= MONAD_DELEGATED_RESERVE_WEI;
    let calls;
    try {
      calls = buildSwapBatch({ kind, marginAccount, payToken, amountIn, source, route, deliverNative });
    } catch {
      continue;
    }
    const result = await simulateDelivery(client, sender, calls, route.tokenOut);
    if (result.status === 'reverted') {
      bestRevert ??= result.reason;
      continue;
    }
    return NextResponse.json(
      {
        chosen: index,
        deliverNative,
        checked: result.status === 'ok',
        ...(result.status === 'ok' ? { delivered: result.delivered.toString() } : {}),
      },
      { headers },
    );
  }
  return NextResponse.json(
    { chosen: null, revert: bestRevert ?? 'None of the routes would go through right now.' },
    { headers },
  );
}
