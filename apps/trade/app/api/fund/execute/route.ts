import { NextResponse } from 'next/server';
import { getAddress, isAddress, zeroAddress, type Address } from 'viem';
import { MONAD_TOKEN_DECIMALS, type FundingRequest, type Quote } from '@tradepro/core';
import { addresses } from '../../../../lib/server/chain';
import { registerDeposit } from '../../../../lib/server/deposits/watcher';
import { railById, simulate } from '../../../../lib/server/rails';

/**
 * `POST /api/fund/execute` — turn a chosen quote into something the user can act on.
 *
 * Two shapes come back, because rails come in two kinds.
 *
 * **A deposit address**, for a rail that issues one: an address, an amount and an expiry.
 * The user sends from wherever their money already is. No wallet, no signature.
 *
 * **A signing plan**, for a rail that needs the user's own wallet on the source chain:
 * the transactions to sign, in order, each labelled, each already checked with `eth_call`.
 *
 * ## It re-quotes rather than trusting what the browser sends back
 *
 * The client could hand back a quote object it had edited. Nothing here reads an amount,
 * a recipient or a route from that object: the request is rebuilt from the same fields the
 * route call used, re-quoted at the vendor, and the plan is built against **that** fresh
 * quote. A quote is a price, and a price the server did not just obtain is not one it
 * should act on.
 *
 * The recipient is asserted inside every rail before it returns anything (R4), and it is
 * always the signed-in account.
 *
 * ## Nothing is offered that the chain has already refused
 *
 * A signing plan is simulated before it is returned. A step that genuinely reverts blocks
 * the plan and the chain's own words are handed back — `NoPeer(30390)`, `ERC20: transfer
 * amount exceeds allowance`. A step that cannot be checked, because it runs after an
 * approval nobody has signed yet, is reported as unchecked and does **not** block: a
 * refusal invented by this app would be as wrong as a pass it never earned.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface Body {
  rail?: string;
  recipient?: string;
  senderAddress?: string;
  chainId?: number;
  chainKey?: string;
  chainName?: string;
  vm?: FundingRequest['sourceChain']['vm'];
  assetSymbol?: string;
  assetAddress?: string;
  assetDecimals?: number;
  amount?: string;
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
  const rail = body.rail ? railById(body.rail) : undefined;
  if (!rail) return NextResponse.json({ error: 'UNKNOWN_RAIL' }, { status: 400 });
  if (
    typeof body.chainId !== 'number' ||
    !body.assetSymbol ||
    !body.assetAddress ||
    typeof body.assetDecimals !== 'number' ||
    !body.amount
  ) {
    return NextResponse.json({ error: 'INCOMPLETE_REQUEST' }, { status: 400 });
  }
  // Client-supplied, and stored as-is against whatever `recipient` was named — an
  // unbounded value here is a render DoS the next time that account's deposit history
  // is drawn, for anyone (audit M9). Same bound `/api/account/balances` already
  // applies to a client-named `baseDecimals`.
  if (!Number.isInteger(body.assetDecimals) || body.assetDecimals < 0 || body.assetDecimals > 36) {
    return NextResponse.json({ error: 'BAD_ASSET_DECIMALS' }, { status: 400 });
  }

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
    amount: BigInt(body.amount),
    recipient: getAddress(body.recipient) as Address,
    ...(body.senderAddress ? { senderAddress: body.senderAddress } : {}),
    wantsMargin: false,
  };

  try {
    const controller = new AbortController();
    const fresh = await rail.quote(req, controller.signal);
    if (!('amountOut' in fresh)) {
      // The vendor's own refusal, unchanged.
      return NextResponse.json({ error: 'DECLINED', reason: fresh.reason }, { status: 409 });
    }
    const quote = fresh as Quote;

    if (rail.depositAddress) {
      return await issueDepositAddress(rail, req, quote);
    }
    if (rail.buildSourceTx) {
      return await issueSigningPlan(rail, req, quote);
    }

    return NextResponse.json(
      {
        error: 'NOT_EXECUTABLE',
        reason: `${rail.displayName} priced this route but this app cannot yet send on it.`,
      },
      { status: 409 },
    );
  } catch (error) {
    const message =
      error instanceof Error ? (error.message.split('\n')[0]?.trim() ?? '') : String(error);
    // The vendor's sentence, source-named, never replaced by ours. A screening refusal in
    // particular reaches the user intact.
    return NextResponse.json(
      { error: 'EXECUTE_FAILED', upstream: { source: rail.displayName, message } },
      { status: 502 },
    );
  }
}

type RailWith = NonNullable<ReturnType<typeof railById>>;

/** The tracker's step-5 evidence needs the delivered token's own address to read its margin balance. */
function resolveTokenAddress(symbol: string): string | null {
  const token = (addresses().tokens as Record<string, { address?: string }>)[symbol];
  return token?.address ?? null;
}

async function issueDepositAddress(rail: RailWith, req: FundingRequest, quote: Quote) {
  const instruction = await rail.depositAddress!(quote);
  const ref = (instruction.raw as { requestId?: string }).requestId ?? instruction.address;

  /**
   * Record it before returning it.
   *
   * The watcher polls `deposit_attempts`, so an address handed to a user without a row is
   * an address nobody is watching — the money arrives and nothing notices. Registering
   * first means the worst case is a row for an address the user never funds, which
   * expires quietly, rather than a funded address with no record.
   */
  try {
    // `registerDeposit` (not the bare `depositDb().register`) so the refund wallet's
    // "before" balance actually gets read — the wrapper that does that has existed
    // since the watcher was built and nothing was ever wired to call it, so
    // `refund_balance_before` was written for zero real deposits (audit Section 1).
    await registerDeposit({
      depositAddress: instruction.address,
      recipient: req.recipient,
      sourceKey: `${req.sourceChain.key}-${req.sourceAsset.symbol.toLowerCase()}`,
      chain: req.sourceChain.displayName,
      route: rail.id,
      // Relay refunds to the sender it saw and no refund address is collected (verified
      // 2026-09-11), so this records who was expected to send rather than inventing one.
      refundTo: req.senderAddress ?? req.recipient,
      amountIn: instruction.amount.toString(),
      originDecimals: req.sourceAsset.decimals,
      originSymbol: req.sourceAsset.symbol,
      expiresAt: instruction.expiresAt,
      rail: rail.id,
      railRef: ref,
      etaSeconds: quote.etaSeconds,
      outToken: quote.outToken,
      landsIn: quote.landsIn,
      quotedAmountOut: quote.amountOut.toString(),
      ...(isAddress(req.sourceAsset.address) && req.sourceAsset.address !== zeroAddress
        ? { tokenContract: getAddress(req.sourceAsset.address) }
        : {}),
    });
  } catch (error) {
    // A failed write must not hand back an unwatched address.
    console.error('could not register the issued deposit address', error);
    return NextResponse.json(
      {
        error: 'NOT_RECORDED',
        reason:
          'An address was issued but could not be recorded, so nothing would be watching ' +
          'it. Nothing was sent. Try again.',
        upstream: { message: error instanceof Error ? error.message : String(error) },
      },
      { status: 500 },
    );
  }

  return NextResponse.json(
    {
      kind: instruction.kind,
      rail: instruction.rail,
      address: instruction.address,
      chainName: instruction.chain.displayName,
      assetSymbol: instruction.asset.symbol,
      assetDecimals: instruction.asset.decimals,
      amount: instruction.amount.toString(),
      amountOut: quote.amountOut.toString(),
      outToken: quote.outToken,
      outTokenAddress: resolveTokenAddress(quote.outToken),
      outDecimals: MONAD_TOKEN_DECIMALS[quote.outToken],
      etaSeconds: quote.etaSeconds,
      expiresAt: instruction.expiresAt,
      refundAddressRequired: instruction.refundAddressRequired,
      /** For the watcher: Relay keys its status on this. */
      ref,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}

async function issueSigningPlan(rail: RailWith, req: FundingRequest, quote: Quote) {
  const from = req.senderAddress;
  if (!from || !isAddress(from)) {
    return NextResponse.json(
      {
        error: 'NEEDS_WALLET',
        reason: `${rail.displayName} needs your own wallet on ${req.sourceChain.displayName} to sign this. Connect it and try again.`,
      },
      { status: 409 },
    );
  }

  const plan = await rail.buildSourceTx!(quote);
  const simulation = await simulate(plan, from);

  if (!simulation.executable && simulation.blockedBy) {
    // The chain's own refusal, named with the step it refused. Not softened, and not
    // turned into a generic failure that tells the user nothing to act on.
    return NextResponse.json(
      {
        error: 'WOULD_REVERT',
        reason: simulation.blockedBy.reason ?? 'The network refused this transaction.',
        step: simulation.blockedBy.label,
        steps: simulation.steps,
      },
      { status: 409 },
    );
  }

  return NextResponse.json(
    {
      kind: 'wallet-signed',
      rail: plan.rail,
      chainId: plan.chain.id,
      chainName: plan.chain.displayName,
      assetSymbol: req.sourceAsset.symbol,
      assetDecimals: req.sourceAsset.decimals,
      amount: quote.amountIn.toString(),
      amountOut: quote.amountOut.toString(),
      outToken: quote.outToken,
      outDecimals: MONAD_TOKEN_DECIMALS[quote.outToken],
      etaSeconds: quote.etaSeconds,
      txs: plan.txs.map((tx) => ({
        chainId: tx.chainId,
        to: tx.to,
        data: tx.data,
        value: tx.value,
        label: tx.label,
      })),
      // Shown as it is: which steps were checked and which could not be, never blurred
      // into one word.
      simulation: simulation.steps,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
