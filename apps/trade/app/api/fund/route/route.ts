import { NextResponse } from 'next/server';
import { getAddress, isAddress, type Address } from 'viem';
import {
  MONAD_TOKEN_DECIMALS,
  route as runRouter,
  type FundingRequest,
  type Quote,
} from '@tradepro/core';
import { allRails } from '../../../../lib/server/rails';

/**
 * `POST /api/fund/route` — ask every rail that can carry this, return what they said.
 *
 * ## Why this is a server route and not a browser call
 *
 * Vendor credentials. Relay's app-fee recipient and API key, Across's integrator id and
 * deBridge's referral code are server-only (R6) — a key in the bundle is a key anyone can
 * lift. The browser asks this route; this route asks the vendors.
 *
 * ## What it returns, and what it refuses to invent
 *
 * `{ best, alternatives, declines, silent }`. A rail that refused is returned **with the
 * vendor's own sentence**, because "NEAR Intents said: minimum swap amount is $1,000" is
 * actionable and "no route available" is not. A rail that threw or timed out is reported
 * as `silent` rather than being turned into a refusal it never made.
 *
 * Nothing here caches: a quote carries its own `expiresAt` and is worthless after it.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface Body {
  recipient?: string;
  chainId?: number;
  chainKey?: string;
  chainName?: string;
  vm?: FundingRequest['sourceChain']['vm'];
  assetSymbol?: string;
  assetAddress?: string;
  assetDecimals?: number;
  amount?: string;
  senderAddress?: string;
  wantsMargin?: boolean;
}

export async function POST(request: Request) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'BAD_REQUEST' }, { status: 400 });
  }

  if (!body.recipient || !isAddress(body.recipient)) {
    return NextResponse.json({ error: 'NOT_AN_ADDRESS' }, { status: 400 });
  }
  if (
    typeof body.chainId !== 'number' ||
    !body.assetSymbol ||
    !body.assetAddress ||
    typeof body.assetDecimals !== 'number' ||
    !body.amount
  ) {
    return NextResponse.json({ error: 'INCOMPLETE_REQUEST' }, { status: 400 });
  }
  // Same bound `/api/account/balances` and `/api/fund/execute` apply to a
  // client-named decimals value (audit M9) — this one also reaches quote-formatting
  // arithmetic downstream, unbounded until now.
  if (!Number.isInteger(body.assetDecimals) || body.assetDecimals < 0 || body.assetDecimals > 36) {
    return NextResponse.json({ error: 'BAD_ASSET_DECIMALS' }, { status: 400 });
  }

  let amount: bigint;
  try {
    amount = BigInt(body.amount);
  } catch {
    return NextResponse.json({ error: 'BAD_AMOUNT' }, { status: 400 });
  }
  if (amount <= 0n) return NextResponse.json({ error: 'BAD_AMOUNT' }, { status: 400 });

  const recipient = getAddress(body.recipient) as Address;
  const req: FundingRequest = {
    sourceChain: {
      id: body.chainId,
      key: body.chainKey ?? String(body.chainId),
      displayName: body.chainName ?? String(body.chainId),
      vm: body.vm ?? 'evm',
    },
    sourceAsset: {
      symbol: body.assetSymbol,
      address: body.assetAddress,
      decimals: body.assetDecimals,
    },
    amount,
    recipient,
    // Relay validates `user` against the origin chain, NEAR Intents needs a refund
    // address there, and every wallet-signed rail needs to know who will sign. All three
    // at quote time, not only at execute time.
    ...(body.senderAddress ? { senderAddress: body.senderAddress } : {}),
    wantsMargin: body.wantsMargin === true,
  };

  try {
    const result = await runRouter(allRails(), req);
    return NextResponse.json(
      {
        best: result.best ? wire(result.best) : null,
        alternatives: result.alternatives.map(wire),
        // The vendor's own words, source-named by the client from `rail`.
        declines: result.declines.map((d) => ({ rail: d.rail, reason: d.reason })),
        silent: result.silent,
        readAt: Date.now(),
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    console.error('funding route failed', error);
    return NextResponse.json(
      {
        error: 'ROUTE_FAILED',
        upstream: {
          source: 'funding router',
          message:
            error instanceof Error
              ? (error.message.split('\n')[0]?.trim() ?? 'no reason given')
              : String(error),
        },
      },
      { status: 502 },
    );
  }
}

/** bigint does not survive JSON, so every amount crosses as a decimal string. */
function wire(q: Quote) {
  return {
    rail: q.rail,
    amountIn: q.amountIn.toString(),
    amountOut: q.amountOut.toString(),
    outToken: q.outToken,
    // The destination token's own decimals. Formatting `amountOut` with the source
    // asset's was correct only while the two happened to match.
    outDecimals: MONAD_TOKEN_DECIMALS[q.outToken],
    fees: q.fees.map((f) => ({
      label: f.label,
      amount: f.amount.toString(),
      token: f.token,
      ...(f.usd ? { usd: f.usd } : {}),
    })),
    etaSeconds: q.etaSeconds,
    expiresAt: q.expiresAt,
    landsIn: q.landsIn,
    executable: q.executable,
    // What decides which section of the card this quote renders in.
    needsWallet: q.needsWallet,
  };
}
