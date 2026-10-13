import { NextResponse } from 'next/server';
import { erc20Abi, getAddress, isAddress, type Address } from 'viem';
import { readPermitNonce, resolvePermitDomain, type TokenInfo } from '@tradepro/core';
import { addresses, chainMode, liveEnabled, readClient } from '../../../../lib/server/chain';

/**
 * Everything the browser needs to build a gasless top-up, read from the chain.
 *
 * ## Two tokens, not one
 *
 * Path B (spec §7.2) lands **USDC** in the user's own wallet on Monad, and the app
 * trades in **AUSD**. Both can be moved into the Kuru margin account by signature, so
 * both are read here and the screen picks the one the user actually holds rather than
 * offering a button for a balance that is not there. A route that only ever read USDC
 * told an account holding 1.0134 AUSD that it had nothing to move.
 *
 * Nothing about a permit is assumed. Each domain is **proved**: `resolvePermitDomain`
 * reconstructs the EIP-712 separator and compares it byte for byte against the
 * token's own `DOMAIN_SEPARATOR()`, and throws rather than returning a domain the
 * token would silently reject. A token with no separator at all — Kuru's testnet USDC
 * mock is one — comes back with `permit: false`, which the screen renders as a stop
 * for that token rather than as a spinner.
 *
 * Nonces are read live per owner: a stale nonce produces a signature the token
 * rejects, and the failure would land after the user had already authenticated.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface TokenPreflight {
  readonly address: Address;
  readonly symbol: string;
  readonly decimals: number;
  readonly permit: boolean;
  readonly domain?: { name: string; version: string; chainId: number; verifyingContract: Address };
  readonly nonce?: string;
  readonly balance: string;
  /** Why this token cannot be moved by signature, when it cannot. */
  readonly unavailable?: string;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const owner = url.searchParams.get('address') ?? '';
  if (!isAddress(owner)) {
    return NextResponse.json({ error: 'NOT_AN_ADDRESS' }, { status: 400 });
  }

  const chain = addresses();
  const marginAccount = chain.kuru.marginAccount as Address | undefined;
  if (!marginAccount) {
    return NextResponse.json({ error: 'NO_MARGIN_ACCOUNT_ON_THIS_CHAIN' }, { status: 503 });
  }

  const account = getAddress(owner);
  const client = readClient();
  const chainId = chain.chainId;

  // AUSD first: it is the account currency, so a balance in it needs no conversion.
  const wanted: TokenInfo[] = [chain.tokens.AUSD, chain.tokens.USDC].filter(
    (t): t is TokenInfo => t !== undefined,
  );

  const requested = url.searchParams.get('token');
  const only = requested && isAddress(requested) ? getAddress(requested) : undefined;
  const list = only ? wanted.filter((t) => getAddress(t.address) === only) : wanted;
  if (list.length === 0) {
    return NextResponse.json({ error: 'UNKNOWN_TOKEN' }, { status: 404 });
  }

  let tokens: TokenPreflight[];
  try {
    tokens = await Promise.all(list.map((t) => preflightOne(client, t, account, chainId)));
  } catch (error) {
    // `preflightOne` rethrows exactly the errors that never got an answer from the
    // chain (C3) — a real "this token has no domain" fact is handled per-token below
    // and never reaches here.
    console.error('permit preflight read failed', account, error);
    return NextResponse.json(
      {
        error: 'PERMIT_READ_FAILED',
        upstream: { message: error instanceof Error ? error.message : String(error), source: 'Monad RPC' },
      },
      { status: 502 },
    );
  }

  if (tokens.every((t) => !t.permit)) {
    // Nothing here can be moved by signature at all, which is a stop rather than an
    // empty list the screen would have to interpret.
    return NextResponse.json(
      { error: 'PERMIT_UNSUPPORTED', tokens, chainId, mode: chainMode() },
      { status: 501 },
    );
  }

  return NextResponse.json(
    { chainId, mode: chainMode(), live: liveEnabled(), marginAccount, tokens, readAt: Date.now() },
    { headers: { 'cache-control': 'no-store' } },
  );
}

async function preflightOne(
  client: ReturnType<typeof readClient>,
  token: TokenInfo,
  account: Address,
  chainId: number,
): Promise<TokenPreflight> {
  const address = getAddress(token.address);

  const [balance, decimals] = await Promise.all([
    client.readContract({
      address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account],
    }) as Promise<bigint>,
    client.readContract({ address, abi: erc20Abi, functionName: 'decimals' }) as Promise<number>,
  ]);

  try {
    const [domain, nonce] = await Promise.all([
      resolvePermitDomain(client, address, chainId),
      readPermitNonce(client, address, account),
    ]);
    return {
      address,
      symbol: token.symbol,
      decimals: Number(decimals),
      permit: true,
      domain: { ...domain, chainId },
      nonce: nonce.toString(),
      balance: balance.toString(),
    };
  } catch (error) {
    // C3: a real "no domain" fact and an RPC that never answered used to collapse into
    // the same permanent-sounding sentence. Only the former is a fact about the token —
    // rethrow the latter so the outer handler reports it as the transport failure it is
    // (502 + upstream), instead of every token going permanently "cannot be moved by
    // signature" while the chain was simply unreachable.
    if (isTransportFailure(error)) throw error;
    console.error('permit domain unavailable', address, error);
    return {
      address,
      symbol: token.symbol,
      decimals: Number(decimals),
      permit: false,
      balance: balance.toString(),
      unavailable: `${token.symbol} cannot be moved by signature on this chain.`,
    };
  }
}

/**
 * Did the chain actually answer and refuse, or did this never reach a real answer?
 *
 * `resolvePermitDomain` throws two different things: its own `Error` once
 * `DOMAIN_SEPARATOR()` has already answered and simply does not match a known domain
 * (a fact about the token), or whatever `readContract` throws when the call itself
 * could not be completed (a timeout, a dropped connection, a node error) — which is a
 * fact about this request, not the token. Same technique `lib/server/rails.ts`'s
 * `ethCall` already uses to tell a revert from a transport failure: a decodable reason
 * means the chain actually answered.
 */
function isTransportFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return true;
  if (error.message.startsWith('no known EIP-712 domain') || error.message.startsWith('permit domain for')) {
    return false;
  }
  const e = error as { shortMessage?: string; details?: string; cause?: { reason?: string } };
  const generic = /transaction creation failed|unknown reason/i;
  const specific = e.cause?.reason ?? e.details;
  const reason = specific ?? (e.shortMessage && !generic.test(e.shortMessage) ? e.shortMessage : undefined);
  return reason === undefined;
}
