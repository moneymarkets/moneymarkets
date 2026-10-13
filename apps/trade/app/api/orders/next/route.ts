import { NextResponse } from 'next/server';
import { getAddress, isAddress } from 'viem';
import { orderBookAbi } from '@tradepro/core';
import { readClient } from '../../../../lib/server/chain';
import { isKnownMarket } from '../../../../lib/markets';

/**
 * The market's order counter, and the block it was read at.
 *
 * A dry run has to build a cancel for an order that was never placed. Rather than
 * invent an id, the app reads `s_orderIdCounter()` from the market contract: a real
 * number, from the real venue, at a stated block. It is what the simulated order's
 * cancel calldata encodes.
 *
 * **It is the id the venue last assigned, not the one it would assign next.** On
 * MON/AUSD on 2026-09-02 it returned `13130679`, which is exactly the order the M0
 * gate created and cancelled — so the counter is a high-water mark, and this route
 * reports it as one. Which id a new order would receive depends on what else lands in
 * the same block, and nothing here pretends to know that. The number is never shown
 * on screen; it exists so a dry run's cancel encodes something real instead of a
 * placeholder.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  const market = new URL(request.url).searchParams.get('market') ?? '';
  if (!isAddress(market) || !isKnownMarket(market)) {
    return NextResponse.json({ error: 'MARKET_NOT_CONFIGURED' }, { status: 404 });
  }

  try {
    const address = getAddress(market);
    const client = readClient();
    const [counter, block] = await Promise.all([
      client.readContract({
        address,
        abi: orderBookAbi,
        functionName: 's_orderIdCounter',
      }) as Promise<bigint | number>,
      client.getBlockNumber(),
    ]);

    return NextResponse.json(
      {
        market: address,
        orderIdCounter: counter.toString(),
        blockNumber: block.toString(),
        readAt: Date.now(),
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    console.error('order counter read failed', market, error);
    return NextResponse.json({ error: 'ORDER_COUNTER_READ_FAILED' }, { status: 502 });
  }
}
