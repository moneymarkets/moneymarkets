import { NextResponse } from 'next/server';
import { getAddress, isAddress } from 'viem';
import { buildNativeSend } from '@tradepro/core';
import { readClient } from '../../../../../lib/server/chain';
import { simulateSponsoredBatch } from '../../../../../lib/server/simulateSponsoredBatch';

/**
 * `POST /api/wallet/send/simulate`: native MON's pre-sign gate (D200), run at the
 * tap and before any Face ID prompt (rule 1.6) — the same ordering `/api/wallet/
 * swap/simulate` already uses. The browser sends `to` and `amount`; this rebuilds
 * the exact call with `buildNativeSend`, never trusting calldata sent from the
 * page, and simulates it from the account.
 *
 * ERC-20 sends need no such gate — a plain `transfer` of the sender's own balance
 * essentially never reverts for a reason the screen has not already checked. A
 * native send can: the 10 MON reserve, confirmed on mainnet (D199), is a chain rule
 * no client-side arithmetic fully replaces (a balance that changed since the last
 * read, an estimate off by the gas this send's own sponsorship might burn).
 *
 * Nothing here signs, sends, or holds a key.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface Body {
  sender?: string;
  to?: string;
  amount?: string;
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
    !body.to ||
    !isAddress(body.to) ||
    !body.amount ||
    !/^\d+$/.test(body.amount) ||
    BigInt(body.amount) <= 0n
  ) {
    return NextResponse.json({ error: 'BAD_REQUEST' }, { status: 400 });
  }

  const sender = getAddress(body.sender);
  const to = getAddress(body.to);
  const amount = BigInt(body.amount);
  const client = readClient();

  const call = buildNativeSend(to, amount);
  const result = await simulateSponsoredBatch(client, sender, [call]);

  return NextResponse.json(
    result.executable
      ? { executable: true, checked: result.checked }
      : { executable: false, checked: true, reason: result.reason },
    { headers: { 'cache-control': 'no-store' } },
  );
}
