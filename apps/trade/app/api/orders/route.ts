import { NextResponse } from 'next/server';
import { getAddress, isAddress } from 'viem';
import { orderBookAbi } from '@tradepro/core';
import { readClient } from '../../../lib/server/chain';
import { isKnownMarket } from '../../../lib/markets';

/**
 * Confirm which of a set of order ids are still resting.
 *
 * There is no on-chain getter that enumerates a user's orders, and the public RPC
 * caps `eth_getLogs` at a 100-block range, so a full order history needs the indexer
 * (spec §9, Phase 3). What this route can do honestly today is take the ids the app
 * saw itself create and read `s_orders(id)` for each: a cancelled or fully filled
 * order has `ownerAddress == 0`, so the open set is exact for those ids.
 *
 * It never invents an order. If the app has no ids, the answer is an empty list and
 * the screen says so.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const ZERO = '0x0000000000000000000000000000000000000000';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const market = url.searchParams.get('market') ?? '';
  const owner = url.searchParams.get('address') ?? '';
  const idsParam = url.searchParams.get('ids') ?? '';

  if (!isAddress(market) || !isKnownMarket(market)) {
    return NextResponse.json({ error: 'MARKET_NOT_CONFIGURED' }, { status: 404 });
  }
  if (!isAddress(owner)) {
    return NextResponse.json({ error: 'NOT_AN_ADDRESS' }, { status: 400 });
  }

  const ids = idsParam
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s))
    .slice(0, 50)
    .map((s) => BigInt(s));

  if (ids.length === 0) {
    return NextResponse.json({ market: getAddress(market), open: [], readAt: Date.now() });
  }

  try {
    const address = getAddress(market);
    const account = getAddress(owner).toLowerCase();
    const rows = await Promise.all(
      ids.map(async (id) => {
        const tuple = (await readClient().readContract({
          address,
          abi: orderBookAbi,
          functionName: 's_orders',
          args: [Number(id)],
        })) as readonly [string, bigint, number, number, number, number, number, boolean];
        return { id, tuple };
      }),
    );

    const open = rows
      .filter(({ tuple }) => tuple[0] !== ZERO && tuple[0].toLowerCase() === account)
      .map(({ id, tuple }) => ({
        id: id.toString(),
        owner: getAddress(tuple[0]),
        size: tuple[1].toString(),
        price: tuple[5].toString(),
        isBuy: tuple[7],
      }));

    return NextResponse.json(
      { market: getAddress(market), open, readAt: Date.now() },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    console.error('open orders read failed', market, error);
    return NextResponse.json(
      {
        error: 'ORDERS_READ_FAILED',
        upstream: { message: error instanceof Error ? error.message : String(error), source: 'Monad RPC' },
      },
      { status: 502 },
    );
  }
}
