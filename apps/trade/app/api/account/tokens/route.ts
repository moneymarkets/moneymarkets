import { NextResponse } from 'next/server';
import { getAddress, isAddress } from 'viem';
import { z } from 'zod';
import { tokenDb } from '../../../../lib/server/tokens/tokenDb';
import { readContractMetaLive } from '../../../../lib/server/tokens/tokenRegistryLive';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const bodySchema = z.object({ account: z.string(), address: z.string() });

/**
 * Add a token by contract address (spec A2c). The address must answer `decimals()`
 * as an ERC-20 would before it is recorded; symbol and decimals come from the contract,
 * and the row then appears on the next balance read through the account's own token
 * set. Nothing is guessed from a symbol.
 */
export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'BAD_BODY' }, { status: 400 });
  const { account: accountRaw, address: addressRaw } = parsed.data;
  if (!isAddress(accountRaw) || !isAddress(addressRaw)) {
    return NextResponse.json({ error: 'NOT_AN_ADDRESS' }, { status: 400 });
  }
  const account = getAddress(accountRaw);
  const address = getAddress(addressRaw);
  try {
    const meta = (await readContractMetaLive([address])).get(address.toLowerCase());
    if (meta === undefined) {
      return NextResponse.json({ error: 'CHAIN_UNAVAILABLE' }, { status: 502 });
    }
    if (meta === null) {
      return NextResponse.json({ error: 'NOT_ERC20' }, { status: 422 });
    }
    const db = tokenDb();
    db.putMeta([{ address, ...meta }]);
    const added = db.addAccountToken({ account, token: address, firstSeenBlock: null, source: 'manual' });
    return NextResponse.json(
      { address, symbol: meta.symbol, name: meta.name, decimals: meta.decimals, added },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    console.error('add token by address failed', account, address, error);
    return NextResponse.json(
      { error: 'ADD_TOKEN_FAILED', upstream: { message: error instanceof Error ? error.message : String(error) } },
      { status: 502 },
    );
  }
}

/** The account's own token set: discovered by scan or added by address. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const raw = url.searchParams.get('address') ?? '';
  if (!isAddress(raw)) return NextResponse.json({ error: 'NOT_AN_ADDRESS' }, { status: 400 });
  const rows = tokenDb().accountTokens(getAddress(raw));
  return NextResponse.json(
    {
      address: getAddress(raw),
      tokens: rows.map((r) => ({
        token: getAddress(r.token),
        source: r.source,
        firstSeenBlock: r.firstSeenBlock === null ? null : r.firstSeenBlock.toString(),
        addedAt: r.addedAt,
      })),
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
