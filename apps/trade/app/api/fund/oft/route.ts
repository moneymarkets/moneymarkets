import { NextResponse } from 'next/server';
import { upstreamFrom } from '../../../../lib/server/revertDetail';
import {
  createPublicClient,
  erc20Abi,
  getAddress,
  http,
  isAddress,
  type Address,
  type PublicClient,
  type Transport,
} from 'viem';
import {
  addressToBytes32,
  buildSendParam,
  LZ_EID,
  MAINNET,
  OFT_FEE_ASSET,
  quoteSend,
  readOftConfig,
} from '@tradepro/core';

/**
 * AUSD from Base to Monad, over LayerZero — priced live, never sent from here.
 *
 * ## What this reads, and from where
 *
 * `BASE_RPC_URL` (default `https://mainnet.base.org`), read-only, against the AUSD
 * OFT at `0x9CaB7Ede13dc56652E44D2404E969C212f22689b`. Four reads:
 *
 *   `token()`             the AUSD the adapter moves
 *   `approvalRequired()`  **false** — the adapter is the token, so `send()` burns
 *                         from the caller directly and there is no approve step. It
 *                         is read rather than remembered, because the contract can
 *                         be replaced.
 *   `sharedDecimals()`    6
 *   `quoteSend()`         the LayerZero messaging fee for this exact send
 *
 * Measured at Base block 50812266 on 2026-09-03: `nativeFee` 100701869744601 wei —
 * about 0.0001007 ETH — and identical at 1, 5 and 25 AUSD, because a LayerZero fee
 * pays for a message rather than for an amount.
 *
 * ## Why the fee is in ETH and why nobody sponsors it
 *
 * `quoteSend` prices the message in the **source** chain's native asset. This app
 * sponsors gas on Monad; it has no standing on Base, and rule A2.3 keeps it that way.
 * So the Base-side `send()` is the user's own transaction from their own wallet, and
 * this route exists to tell them what it will cost before they decide — it is the
 * documented manual step, priced honestly rather than hidden.
 *
 * ## dstEid is not a chain id
 *
 * Monad's LayerZero endpoint id is 30390 and its EVM chain id is 143. `buildSendParam`
 * refuses 143 outright for exactly that reason.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * The public Base endpoint rate-limits, and it does so under exactly the load this
 * card creates: five reads per view. Two answers to that, both of which reduce the
 * asking rather than paper over a refusal.
 *
 * The adapter's own configuration — `token()`, `approvalRequired()`,
 * `sharedDecimals()` — is a property of a deployed contract. It is read once and held
 * for five minutes, so a repeat view costs two calls instead of five. It is still
 * read, not remembered across restarts, because the contract can be replaced.
 *
 * `over rate limit` is a refusal to answer, not an answer, so it is retried twice
 * with a pause. Anything else fails immediately: a revert is a fact and repeating it
 * only makes the user wait.
 */
const CONFIG_CACHE_MS = 5 * 60_000;
/** A quoted fee, held briefly. Measured: `eth_call` is throttled after ~5 in a row. */
const FEE_CACHE_MS = 60_000;
const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_PAUSE_MS = 1_500;

let configCache: { at: number; value: Awaited<ReturnType<typeof readOftConfig>> } | undefined;
const feeCache = new Map<string, { at: number; nativeFee: bigint; lzTokenFee: bigint }>();

function isRateLimited(error: unknown): boolean {
  const text =
    error instanceof Error ? `${error.message} ${String(error.cause ?? '')}` : String(error);
  return /rate limit|429|too many requests|timeout|fetch failed/i.test(text);
}

async function withRateLimitRetry<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      if (attempt >= RATE_LIMIT_RETRIES || !isRateLimited(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_PAUSE_MS * (attempt + 1)));
    }
  }
}

/** Monad mainnet, from `@layerzerolabs/lz-definitions` (DECISIONS open item 3). */
const DST_EID = LZ_EID.MONAD_MAINNET;

let cached: PublicClient<Transport> | undefined;

/**
 * No `chain` is attached deliberately. Every call here is `eth_call` or
 * `eth_blockNumber` against Base — read-only, no signing, no chain-specific
 * formatting — and leaving the chain off keeps this client unable to send anything
 * even by accident.
 */
function baseClient(): PublicClient<Transport> {
  if (cached) return cached;
  cached = createPublicClient({
    transport: http(process.env.BASE_RPC_URL ?? 'https://mainnet.base.org'),
  });
  return cached;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const who = url.searchParams.get('address') ?? '';
  if (!isAddress(who)) {
    return NextResponse.json({ error: 'NOT_AN_ADDRESS' }, { status: 400 });
  }
  const account = getAddress(who);

  const amountRaw = url.searchParams.get('amount');
  if (amountRaw !== null && !/^\d+$/.test(amountRaw)) {
    return NextResponse.json({ error: 'BAD_REQUEST' }, { status: 400 });
  }
  // 5 AUSD is the size the reference reading was taken at. The fee does not vary
  // with it, but the quote is still asked for the amount the caller means.
  const amount = amountRaw ? BigInt(amountRaw) : 5_000_000n;
  if (amount <= 0n) {
    return NextResponse.json({ error: 'BAD_REQUEST' }, { status: 400 });
  }

  const adapter = MAINNET.ausdOftAdapter as Address;
  const client = baseClient();

  try {
    let config =
      configCache && Date.now() - configCache.at < CONFIG_CACHE_MS ? configCache.value : undefined;
    if (!config) {
      config = await withRateLimitRetry(() => readOftConfig(client, adapter));
      configCache = { at: Date.now(), value: config };
    }

    const sendParam = buildSendParam({ dstEid: DST_EID, recipient: account, amount });

    // Sequential, not parallel: simultaneous calls are what trip the public
    // endpoint's limiter in the first place.
    const feeKey = `${account}:${amount.toString()}`;
    const cachedFee = feeCache.get(feeKey);
    let fee: { nativeFee: bigint; lzTokenFee: bigint };
    if (cachedFee && Date.now() - cachedFee.at < FEE_CACHE_MS) {
      fee = { nativeFee: cachedFee.nativeFee, lzTokenFee: cachedFee.lzTokenFee };
    } else {
      fee = await withRateLimitRetry(() => quoteSend(client, adapter, sendParam));
      feeCache.set(feeKey, { at: Date.now(), ...fee });
    }

    // The fee is what this card exists for. A balance and a block number are context,
    // and a card that has the fee must not fail because the context read was
    // throttled — so these are best-effort and come back null when they do not answer.
    // One attempt each, deliberately. Retrying context behind a fee the card already
    // has only makes the user wait for something they did not ask for.
    const balance = await optional(
      () =>
        client.readContract({
          address: config.token,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [account],
        }) as Promise<bigint>,
    );
    const blockNumber = await optional(() => client.getBlockNumber());

    return NextResponse.json(
      {
        adapter,
        token: config.token,
        /** False on this adapter, read live. A UI that draws an approve step is inventing one. */
        approvalRequired: config.approvalRequired,
        sharedDecimals: config.sharedDecimals,
        dstEid: DST_EID,
        amount: amount.toString(),
        /** LayerZero messaging fee, in wei of the source chain's native asset. */
        nativeFee: fee.nativeFee.toString(),
        lzTokenFee: fee.lzTokenFee.toString(),
        feeAsset: OFT_FEE_ASSET,
        /** AUSD the account holds on Base, in base units. Null if Base would not say. */
        balance: balance?.toString() ?? null,
        recipientBytes32: addressToBytes32(account),
        blockNumber: blockNumber?.toString() ?? null,
        readAt: Date.now(),
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    console.error('LayerZero quoteSend on Base failed', error);
    // The upstream's words ride along, verbatim (error-handling rule, 2026-09-08).
    return NextResponse.json(
      { error: 'OFT_QUOTE_UNAVAILABLE', upstream: upstreamFrom('Base RPC', error) },
      { status: 502 },
    );
  }
}

/** A read whose failure is not worth failing the response for. */
async function optional<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    console.error('optional Base read failed', error);
    return undefined;
  }
}
