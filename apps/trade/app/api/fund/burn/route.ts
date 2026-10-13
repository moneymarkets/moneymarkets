import { NextResponse } from 'next/server';
import { getAddress, isAddress, type Address } from 'viem';
import { CCTP_DOMAINS, MONAD_CCTP_DOMAIN, readBurnFromReceipt } from '@tradepro/core';
import { depositDb } from '../../../../lib/server/deposits/db';
import { clientFor } from '../../../../lib/server/rails';

/**
 * `POST /api/fund/burn` — record a wallet-signed burn so the watcher can finish it.
 *
 * A deposit-address rail records itself: the server issues the address, so it writes the
 * row before handing it over. A wallet-signed rail has no such moment — the user signs in
 * their own wallet and the server never sees it unless the browser says so. Without this
 * the burn is invisible: nothing polls Circle, nothing submits the mint, and the money
 * sits burned on one side with no one to complete it.
 *
 * ## What is trusted here, and what is not (B2, 2026-09-23)
 *
 * The transaction hash is a lookup key, nothing more — but before this row is written,
 * the source chain's own receipt for that hash is read and its `MessageSent` log is
 * decoded (`readBurnFromReceipt`, `packages/core/src/funding/cctp.ts`, byte offsets
 * verified against Circle's own source and cross-checked against live burns, not
 * guessed). A hash that never burned, or burned somewhere else, or reverted, is
 * refused here and never reaches the watcher at all.
 *
 * The one field that has to be right is `mintRecipient`, decoded from the burn body —
 * **not** the header's own `recipient` field, which is Circle's `TokenMessengerV2` on
 * every chain and would make every burn "verify" against the wrong address. It must
 * equal the account making this request: Circle's signature is what actually decides
 * who a mint can go to, so a mismatch here does not let anyone steal a mint, but it
 * would let a client fill the watcher and the Recent list with rows for a transfer that
 * was never theirs to claim — refused for that reason, with a clear reason, not a
 * silent accept.
 *
 * This still does not need the *attestation* — Circle has not finished by the time the
 * browser calls this route, and requiring one here would reject every legitimate burn
 * in the first seconds after it lands. That check stays where it already lived: the
 * relayer re-fetches the attestation from Circle itself before ever submitting a mint.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface Body {
  recipient?: string;
  chainId?: number;
  chainName?: string;
  assetSymbol?: string;
  assetDecimals?: number;
  amount?: string;
  /** The burn transaction the user just signed on the source chain. */
  txHash?: string;
  rail?: string;
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
  if (!body.txHash || !/^0x[0-9a-fA-F]{64}$/.test(body.txHash)) {
    return NextResponse.json({ error: 'NOT_A_TX_HASH' }, { status: 400 });
  }
  if (typeof body.chainId !== 'number' || !body.amount || !/^\d+$/.test(body.amount)) {
    return NextResponse.json({ error: 'INCOMPLETE_REQUEST' }, { status: 400 });
  }
  // This one is written to the row (below) and rendered every time this recipient's
  // deposit history is drawn — an unbounded value here is a stored, cross-user render
  // DoS, not a one-request one (audit M9). Same bound `/api/account/balances` already
  // applies to a client-named decimals value.
  if (
    body.assetDecimals !== undefined &&
    (!Number.isInteger(body.assetDecimals) || body.assetDecimals < 0 || body.assetDecimals > 36)
  ) {
    return NextResponse.json({ error: 'BAD_ASSET_DECIMALS' }, { status: 400 });
  }
  // Only CCTP is followed up this way today. Another rail's burn would need its own
  // poller, and recording it here would imply one exists.
  if (body.rail !== 'cctp') {
    return NextResponse.json({ error: 'RAIL_NOT_FOLLOWED', rail: body.rail ?? null }, { status: 400 });
  }
  const domain = CCTP_DOMAINS[body.chainId];
  if (domain === undefined || domain === MONAD_CCTP_DOMAIN) {
    return NextResponse.json({ error: 'CHAIN_NOT_SUPPORTED' }, { status: 400 });
  }

  const recipient = getAddress(body.recipient) as Address;
  const txHash = body.txHash as `0x${string}`;

  const sourceClient = clientFor(body.chainId);
  if (!sourceClient) {
    return NextResponse.json({ error: 'CHAIN_NOT_SUPPORTED' }, { status: 400 });
  }

  let burn: Awaited<ReturnType<typeof readBurnFromReceipt>>;
  try {
    burn = await readBurnFromReceipt(sourceClient, txHash);
  } catch (error) {
    // Could not even read the receipt — a transport failure, not a fact about the
    // burn. Told apart from a real refusal below (R5): this is retryable, that is not.
    console.error('could not read the burn receipt', body.chainId, txHash, error);
    return NextResponse.json(
      {
        error: 'BURN_UNVERIFIABLE',
        upstream: {
          message: error instanceof Error ? error.message : String(error),
          source: 'Monad RPC',
        },
      },
      { status: 502 },
    );
  }

  if (!burn) {
    return NextResponse.json(
      {
        error: 'BURN_NOT_FOUND',
        reason:
          'That transaction was not found, did not succeed, or is not a Circle CCTP burn ' +
          'on that chain. Nothing was recorded.',
      },
      { status: 422 },
    );
  }
  if (burn.destinationDomain !== MONAD_CCTP_DOMAIN) {
    return NextResponse.json(
      {
        error: 'BURN_WRONG_DESTINATION',
        reason: 'That burn is not addressed to Monad. Nothing was recorded.',
      },
      { status: 409 },
    );
  }
  if (burn.mintRecipient.toLowerCase() !== recipient.toLowerCase()) {
    return NextResponse.json(
      {
        error: 'BURN_WRONG_RECIPIENT',
        reason: 'That burn does not mint to your account. Nothing was recorded.',
      },
      { status: 409 },
    );
  }

  try {
    depositDb().register({
      // The burn hash is the row's identity: there is no deposit address on this path.
      depositAddress: body.txHash.toLowerCase(),
      recipient,
      sourceKey: `${body.chainId}-${(body.assetSymbol ?? 'USDC').toLowerCase()}`,
      chain: body.chainName ?? String(body.chainId),
      route: 'cctp',
      // No refund address: a CCTP burn is not refundable, it is completed or it waits.
      refundTo: recipient,
      // The amount decoded from the burn's own receipt, not the figure the client
      // claimed — the chain already answered this question above.
      amountIn: burn.amount.toString(),
      originDecimals: body.assetDecimals ?? 6,
      originSymbol: body.assetSymbol ?? 'USDC',
      // Circle attests on its own schedule; nothing here expires the way a quote does.
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      rail: 'cctp',
      railRef: body.txHash.toLowerCase(),
      sourceChainId: body.chainId,
      // CCTP always delivers USDC, and this route already confirmed the burn's own
      // receipt above — step 2's evidence is this app's own read, not a vendor claim.
      outToken: 'USDC',
    });
    depositDb().applySourceEvidence(body.txHash.toLowerCase(), {
      hash: body.txHash,
      source: 'our-watcher-cctp-burn',
    });
  } catch (error) {
    console.error('could not record the burn', error);
    return NextResponse.json(
      {
        error: 'NOT_RECORDED',
        upstream: { message: error instanceof Error ? error.message : String(error) },
      },
      { status: 500 },
    );
  }

  return NextResponse.json({ recorded: true }, { headers: { 'cache-control': 'no-store' } });
}
