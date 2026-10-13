'use client';

import {
  AUSD_USDC_MARKET,
  buildConversion,
  buildDeposit,
  buildPermitCall,
  buildPermitMessage,
  isSponsorable,
  KURU_FLOW_ROUTER,
  permitTypedData,
  type BuiltConversion,
  type MarketParams,
  type PermitDomain,
  type PolicyContext,
} from '@tradepro/core';
import type { Address, Hex } from 'viem';
import type { MeraAccount } from '@tradepro/core';
import { apiUrl } from '../basePath';
import { run, type OnProgress, type Progress } from '../ticket';
import { upstreamLine, type WireErrorBody } from '../upstream';
import { runWithGasCharge, type FeeLegPlan } from '../wallet/gasCharge';

/**
 * Path B, the funding leg this build implements (spec §7.2, §6.4).
 *
 * The solver network delivers **USDC** to the user's own account on Monad. It is
 * theirs at that point and nothing of ours has touched it — which is the whole reason
 * this path is the fallback rather than a compromise. What is left is to get it into
 * the Kuru margin account **as AUSD**, the currency the app trades and quotes in,
 * without the user ever holding MON for gas.
 *
 * That is one sponsored user operation carrying three calls:
 *
 *   1. `USDC.permit(owner, MarginAccount, amount, deadline, v, r, s)`
 *   2. `MarginAccount.deposit(owner, USDC, amount)`
 *   3. `AUSD_USDC.placeAndExecuteMarketBuy(wireAmountIn, minAmountOut, isMargin=true, …)`
 *
 * Atomic, so there is never a window where an approval stands with no deposit behind
 * it, or USDC sits in the margin account in a currency the app does not trade.
 *
 * ## The direction is derived, never asserted
 *
 * AUSD/USDC has **baseAsset AUSD, quoteAsset USDC**. Spending USDC to receive AUSD is
 * a market **buy**; a market sell would spend AUSD and hand back the USDC the user is
 * trying to be rid of. `core`'s `conversionRoute()` reads the side off the market's
 * own params and `buildConversion` takes no side argument, so this file cannot get it
 * backwards. `minAmountOut` comes from a live zero-sender quote of the real book at
 * 0.1% tolerance — never zero, which would be a standing offer to accept any fill.
 *
 * ## When the user already holds AUSD
 *
 * There is nothing to convert. The batch is the permit and the deposit alone, and the
 * screen says so. Converting AUSD into AUSD is not a no-op; it is a round trip
 * through a book that would cost the user the spread for nothing.
 *
 * ## Sponsorship
 *
 * The AUSD/USDC book is **not** in `LIVE_MARKET_ALLOWLIST`: it was from 2026-09-09
 * (D127) until 2026-09-23, when it became shown-but-not-traded. So this file names the
 * market through `PolicyContext.markets`, and that is what makes the conversion leg
 * sponsorable — `markets` only ever widens. The context is built here and checked
 * before the user is asked for a passkey — a batch that a sponsor would refuse should
 * not cost anyone a Face ID prompt first.
 *
 * Gas is paid for the user (design §6). Nothing here can move funds anywhere except
 * from the user's own wallet into the user's own margin balance and, from there, into
 * the user's own AUSD.
 */

export interface TokenPreflight {
  readonly address: Address;
  readonly symbol: string;
  readonly decimals: number;
  readonly permit: boolean;
  readonly domain?: PermitDomain;
  readonly nonce?: bigint;
  readonly balance: bigint;
  readonly unavailable?: string;
}

export interface PermitPreflight {
  /** Whether this deployment would actually send. False in dryrun. */
  readonly live?: boolean;
  readonly chainId: number;
  readonly marginAccount: Address;
  readonly tokens: readonly TokenPreflight[];
}

export type PreflightFailure = 'PERMIT_UNSUPPORTED' | 'RPC_UNAVAILABLE' | 'NO_MARGIN_ACCOUNT';

export class PreflightError extends Error {
  /** The upstream's own words, source-named, when the server carried them (R5). */
  readonly upstream?: string;
  constructor(readonly kind: PreflightFailure, upstream?: string) {
    super(kind);
    this.name = 'PreflightError';
    if (upstream) this.upstream = upstream;
  }
}

interface WireToken {
  address: Address;
  symbol: string;
  decimals: number;
  permit: boolean;
  domain?: PermitDomain;
  nonce?: string;
  balance: string;
  unavailable?: string;
}

/** Read the permit domains, live nonces and wallet balances for every movable token. */
export async function preflight(owner: Address): Promise<PermitPreflight> {
  let res: Response;
  try {
    res = await fetch(apiUrl(`/api/fund/permit?address=${owner}`), { cache: 'no-store' });
  } catch {
    throw new PreflightError('RPC_UNAVAILABLE');
  }
  if (res.status === 501) throw new PreflightError('PERMIT_UNSUPPORTED');
  if (res.status === 503) throw new PreflightError('NO_MARGIN_ACCOUNT');
  if (!res.ok) {
    // The route now branches a real RPC failure from a token fact (C3) and carries the
    // real reason as `upstream` — read it rather than a bare "unavailable".
    const errorBody = (await res.json().catch(() => undefined)) as WireErrorBody | undefined;
    throw new PreflightError('RPC_UNAVAILABLE', upstreamOf(errorBody));
  }

  const body = (await res.json()) as {
    chainId: number;
    marginAccount: Address;
    live?: boolean;
    tokens: WireToken[];
  };

  return {
    chainId: body.chainId,
    marginAccount: body.marginAccount,
    ...(body.live === undefined ? {} : { live: body.live }),
    tokens: body.tokens.map((t) => ({
      address: t.address,
      symbol: t.symbol,
      decimals: t.decimals,
      permit: t.permit,
      ...(t.domain ? { domain: t.domain } : {}),
      ...(t.nonce !== undefined ? { nonce: BigInt(t.nonce) } : {}),
      balance: BigInt(t.balance),
      ...(t.unavailable ? { unavailable: t.unavailable } : {}),
    })),
  };
}

/**
 * The token the top-up offers by default: the first of `movableHoldings`, so USDC when
 * the user holds it. A token that cannot be permitted is never chosen, whatever its
 * balance — there is no gasless path for it.
 */
export function tokenToMove(pre: PermitPreflight): TokenPreflight | undefined {
  return movableHoldings(pre)[0] ?? pre.tokens.filter((t) => t.permit)[0];
}

/**
 * Every permitted token the user actually holds, most-converted-first.
 *
 * `tokenToMove` answers "which one do we offer by default" and used to be the whole
 * story, which meant an account holding **both** USDC and AUSD had one of them offered
 * and the other silently absent from the screen. That contradicts the rule in
 * design §5.2: nothing a user holds is invisible.
 *
 * USDC sorts before AUSD deliberately. Funding lands USDC, so it is what someone who
 * has just funded is looking for; AUSD is already the account currency and its path is
 * the boring one. A token that cannot be permitted is never included at all — there is
 * no gasless route for it, and offering one would be a button that cannot work.
 */
export function movableHoldings(pre: PermitPreflight): readonly TokenPreflight[] {
  return pre.tokens
    .filter((t) => t.permit && t.balance > 0n)
    .sort((a, b) => {
      if (a.symbol === b.symbol) return 0;
      if (a.symbol === 'AUSD') return 1;
      if (b.symbol === 'AUSD') return -1;
      return a.symbol.localeCompare(b.symbol);
    });
}

export function tokenBySymbol(pre: PermitPreflight, symbol: string): TokenPreflight | undefined {
  return pre.tokens.find((t) => t.symbol === symbol);
}

export type VenueCheck =
  { readonly clear: true } | { readonly clear: false; readonly message: string };

/**
 * A fresh read of `/api/status`, taken immediately before a batch is prepared.
 *
 * `TopUpCard`'s own polled status (`useLiveStatus`, ten-minute interval) is what
 * disables the button most of the time, but a page can sit open for up to that whole
 * window between polls. Reading that stale value at the moment of the tap was how a
 * batch already known to fail (Kuru paused) still reached the permit signature —
 * "AA21 didn't pay prefund" then arrived on screen after Face ID had already fired,
 * because nothing checked again between the click and the signature.
 *
 * Anything short of an explicit, fresh `paused === false` is treated as not-clear —
 * including the fetch itself failing. Unknown is not evidence the venue is clear.
 */
export async function checkVenueClear(fetchImpl: typeof fetch = fetch): Promise<VenueCheck> {
  let paused: boolean | null | undefined;
  try {
    const res = await fetchImpl(apiUrl('/api/status'), { cache: 'no-store' });
    if (res.ok) ({ paused } = (await res.json()) as { paused: boolean | null });
  } catch {
    // paused stays undefined; the check below treats that as not-clear.
  }
  if (paused === false) return { clear: true };
  return {
    clear: false,
    message:
      paused === true
        ? "Kuru has paused deposits right now. Your money stays in your wallet. We'll retry automatically."
        : 'Could not confirm Kuru is clear right now. Nothing was signed — try again in a moment.',
  };
}

/* --------------------------------- the AUSD leg --------------------------------- */

export interface ConversionQuoteWire {
  readonly market: Address;
  readonly side: 'buy' | 'sell';
  readonly amountIn: bigint;
  readonly expectedOut: bigint;
  readonly minAmountOut: bigint;
  readonly slippageBps: bigint;
  readonly adjusted: boolean;
  readonly blockNumber: bigint;
  readonly params: MarketParams;
  readonly outDecimals: number;
}

/**
 * `Kuru said: “SizeError”` from a server error body — the upstream words carried
 * through, never masked (error-handling rule, 2026-09-08). Formatted by `upstream.ts`'s
 * own `upstreamLine`, not a second copy of the same template — this file's only
 * difference from that module's default is the fallback name ("The venue" — the
 * server-side default of "NEAR Intents" is wrong here, since these routes speak to
 * Kuru or the Flow router, not 1Click).
 */
function upstreamOf(body: WireErrorBody | undefined): string | undefined {
  if (!body?.upstream?.message) return undefined;
  return upstreamLine({ source: body.upstream.source ?? 'The venue', message: body.upstream.message });
}

export class ConversionUnquotable extends Error {
  /** The upstream's own words, source-named, when the server carried them. */
  readonly upstream?: string;
  constructor(upstream?: string) {
    super('CONVERSION_UNQUOTABLE');
    this.name = 'ConversionUnquotable';
    if (upstream) this.upstream = upstream;
  }
}

/**
 * A Flow route exists but was refused because it is not safe for a gasless,
 * EIP-7702-delegated account — see `/api/fund/flow-quote`'s doc comment. Distinct
 * from `ConversionUnquotable` (no route at all) so the card can say the true thing:
 * a route exists, it just cannot be used here yet.
 */
export class FlowRouteUnavailable extends Error {
  /** The upstream's own words, source-named, when the server carried them. */
  readonly upstream?: string;
  constructor(upstream?: string) {
    super('FLOW_ROUTE_NEEDS_NATIVE_VALUE');
    this.name = 'FlowRouteUnavailable';
    if (upstream) this.upstream = upstream;
  }
}

/**
 * Five seconds, matching the ticket's own "never an indefinite loading label" rule.
 * `/api/fund/convert` answers in well under a second against a live RPC, so this
 * bounds a stalled connection rather than a slow-but-real read — if it fires, the
 * card shows the clear failed state instead of "Reading the AUSD price" forever.
 */
export const CONVERSION_QUOTE_TIMEOUT_MS = 5000;

/** What `amount` USDC would fill for in AUSD, read from the live book. */
export async function quoteToAusd(amount: bigint): Promise<ConversionQuoteWire> {
  let res: Response;
  try {
    res = await fetch(apiUrl(`/api/fund/convert?amount=${amount.toString()}`), {
      cache: 'no-store',
      signal: AbortSignal.timeout(CONVERSION_QUOTE_TIMEOUT_MS),
    });
  } catch {
    throw new ConversionUnquotable();
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => undefined)) as
      { upstream?: { source?: string; message?: string } } | undefined;
    throw new ConversionUnquotable(upstreamOf(body));
  }

  const body = (await res.json()) as {
    market: Address;
    side: 'buy' | 'sell';
    amountIn: string;
    expectedOut: string;
    minAmountOut: string;
    slippageBps: string;
    adjusted: boolean;
    blockNumber: string;
    outDecimals: number;
    params: Record<string, string | number>;
  };

  return {
    market: body.market,
    side: body.side,
    amountIn: BigInt(body.amountIn),
    expectedOut: BigInt(body.expectedOut),
    minAmountOut: BigInt(body.minAmountOut),
    slippageBps: BigInt(body.slippageBps),
    adjusted: body.adjusted,
    blockNumber: BigInt(body.blockNumber),
    outDecimals: body.outDecimals,
    params: {
      pricePrecision: BigInt(body.params.pricePrecision as string),
      sizePrecision: BigInt(body.params.sizePrecision as string),
      baseAsset: body.params.baseAsset as Address,
      baseDecimals: Number(body.params.baseDecimals),
      quoteAsset: body.params.quoteAsset as Address,
      quoteDecimals: Number(body.params.quoteDecimals),
      tickSize: BigInt(body.params.tickSize as string),
      minSize: BigInt(body.params.minSize as string),
      maxSize: BigInt(body.params.maxSize as string),
      takerFeeBps: BigInt(body.params.takerFeeBps as string),
      makerFeeBps: BigInt(body.params.makerFeeBps as string),
    },
  };
}

/**
 * Below this, a book conversion cannot fill: AUSD/USDC's own minimum order is 10 AUSD
 * (`getMarketParams().minSize`, read live), and the two trade near 1:1. Rather than let
 * an amount under that revert on chain, the amount decides the route before anything
 * is quoted — this is the one-line note, not a blocker (spec: never disable Convert).
 *
 * Not a slippage tolerance — that is `/api/fund/convert`'s `CONVERSION_SLIPPAGE_BPS`,
 * a different number for a different question (audit High #16's third floor).
 */
export const BOOK_CONVERSION_MIN_USDC = 10_000_000n; // 10.000000 USDC, 6 decimals

/** Which route `quoteConvertToAusd` picked, so the card can show why. */
export type ConversionRouteKind = 'book' | 'flow';

export interface FlowConversionQuoteWire {
  readonly router: Address;
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
  readonly amountIn: bigint;
  /** Expected AUSD out, base units. */
  readonly output: bigint;
  /** The floor this route's own quote reports — not a slippage floor we set. */
  readonly minOut: bigint;
}

/**
 * A live Flow swap quote, USDC -> AUSD, landing in the user's own wallet.
 *
 * Unlike the book quote this is not a zero-sender simulation of our own market order —
 * it is the aggregator's real quote for the real route it will submit, `to`/`data`
 * included. `assertFlowQuoteMatchesRequest` (core, re-run again server-side in the
 * route) is what stands behind trusting bytes we cannot decode.
 */
export async function quoteFlowConvert(
  userAddress: Address,
  amount: bigint,
): Promise<FlowConversionQuoteWire> {
  let res: Response;
  try {
    res = await fetch(
      apiUrl(`/api/fund/flow-quote?amount=${amount.toString()}&address=${userAddress}`),
      { cache: 'no-store', signal: AbortSignal.timeout(CONVERSION_QUOTE_TIMEOUT_MS) },
    );
  } catch {
    throw new ConversionUnquotable();
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => undefined)) as
      { error?: string; upstream?: { source?: string; message?: string } } | undefined;
    if (res.status === 503 && body?.error === 'FLOW_ROUTE_NEEDS_NATIVE_VALUE') {
      throw new FlowRouteUnavailable(upstreamOf(body));
    }
    throw new ConversionUnquotable(upstreamOf(body));
  }

  const body = (await res.json()) as {
    router: Address;
    to: Address;
    data: Hex;
    value: string;
    amountIn: string;
    output: string;
    minOut: string;
  };
  return {
    router: body.router,
    to: body.to,
    data: body.data,
    value: BigInt(body.value),
    amountIn: BigInt(body.amountIn),
    output: BigInt(body.output),
    minOut: BigInt(body.minOut),
  };
}

/**
 * One call, sponsored: `USDC.permit(owner, KURU_FLOW_ROUTER, amount, …)` followed
 * immediately by the swap the quote returned. The relayer refuses to sponsor the
 * second call unless it is directly preceded by exactly this permit (D101) — pairing
 * order matters and is not incidental here.
 *
 * The output lands in the caller's own wallet (Flow's own convention: the swap
 * recipient is the address that submits it, which under 7702 is the user's own EOA) —
 * **not** the margin account. Moving it from there into trading balance is the
 * existing plain `topUp()` with no conversion, run again as a second, separate step,
 * once the wallet actually holds it. Never assembled as one atomic batch: a permit
 * for the *next* leg would have to guess the swap's exact output ahead of the fact,
 * and a market swap rarely lands exactly on its own quote.
 */
export async function prepareFlowConvert(input: {
  readonly account: MeraAccount;
  readonly preflight: PermitPreflight;
  readonly usdc: TokenPreflight;
  readonly amount: bigint;
  readonly quote: FlowConversionQuoteWire;
}): Promise<PreparedTopUp> {
  const { account, usdc, amount, quote } = input;
  if (amount <= 0n) throw new Error('flow-convert amount must be positive');
  if (amount > usdc.balance) {
    throw new Error('flow-convert amount is larger than the wallet balance that was read');
  }
  if (!usdc.permit || !usdc.domain || usdc.nonce === undefined) {
    throw new Error(`${usdc.symbol} cannot be moved by signature`);
  }

  const message = buildPermitMessage({
    owner: account.address,
    spender: KURU_FLOW_ROUTER,
    marginAccount: input.preflight.marginAccount,
    value: amount,
    nonce: usdc.nonce,
    deadlineSeconds: TOP_UP_DEADLINE_SECONDS,
  });
  const signature: Hex = await account.account.signTypedData(permitTypedData(message, usdc.domain));
  const permitCall = buildPermitCall(usdc.address, message, signature);
  const swapCall = { to: quote.to, data: quote.data };

  return { calls: [permitCall, swapCall], logCalls: [swapCall] };
}

/** Sign the router permit, assemble the batch, hand it to `submit()`. */
export async function flowConvert(input: {
  readonly account: MeraAccount;
  readonly preflight: PermitPreflight;
  readonly usdc: TokenPreflight;
  readonly amount: bigint;
  readonly quote: FlowConversionQuoteWire;
  readonly onProgress: OnProgress;
}): Promise<Progress> {
  input.onProgress({ state: 'VALIDATING' });
  const prepared = await prepareFlowConvert(input);
  return run({
    sender: input.account.address,
    calls: prepared.calls,
    logCalls: prepared.logCalls,
    purpose: 'deposit',
    onProgress: input.onProgress,
    owner: input.account.account,
  });
}

/* ----------------------------------- the batch ----------------------------------- */

/** Ten minutes is the ceiling core enforces; five is what a top-up needs. */
export const TOP_UP_DEADLINE_SECONDS = 300;

export interface TopUpInput {
  readonly account: MeraAccount;
  readonly preflight: PermitPreflight;
  readonly token: TokenPreflight;
  /** Base units of `token`. Never more than the wallet holds. */
  readonly amount: bigint;
  /** Present when the deposit has to be converted into AUSD. */
  readonly conversion?: ConversionQuoteWire;
  readonly onProgress: OnProgress;
  /** Fired once the gas-charge quote is known, before the batch is signed — see
   *  `runWithGasCharge`'s own doc comment in `lib/wallet/gasCharge.ts`. Lets a
   *  caller (`MoveSheet.tsx`) show the real fee instead of a placeholder. */
  readonly onFeePlan?: (plan: FeeLegPlan) => void;
}

/**
 * The sponsor policy this batch needs.
 *
 * Written out rather than left implicit because one line of it is the difference
 * between a sponsored batch and `TARGET_NOT_ALLOWED`: the AUSD/USDC book is not in
 * the code allowlist, so it has to be named.
 */
export function policyFor(pre: PermitPreflight, token: Address, market?: Address): PolicyContext {
  return {
    marginAccount: pre.marginAccount,
    permitTokens: [token],
    ...(market ? { markets: [market] } : {}),
  };
}

export interface PreparedTopUp {
  /** Everything the operation carries, in order. */
  readonly calls: readonly { readonly to: Address; readonly data: Hex }[];
  /** What is safe to keep afterwards: the permit's calldata embeds a signature. */
  readonly logCalls: readonly { readonly to: Address; readonly data: Hex }[];
  readonly conversion?: BuiltConversion;
}

/**
 * Sign the permit and assemble the batch.
 *
 * The signature is produced in the browser by the account the passkey derived, is
 * passed straight into the calldata, and is never logged, stored or sent anywhere
 * else. The dry-run log deliberately drops the permit call: a permit's calldata
 * carries a bearer authorisation for its amount and nonce, and one sitting in browser
 * storage would outlive the moment it was meant for.
 */
export async function prepareTopUp(input: TopUpInput): Promise<PreparedTopUp> {
  const { account, preflight: pre, token, amount } = input;
  if (amount <= 0n) throw new Error('top-up amount must be positive');
  if (amount > token.balance) {
    throw new Error('top-up amount is larger than the wallet balance that was read');
  }
  if (!token.permit || !token.domain || token.nonce === undefined) {
    throw new Error(`${token.symbol} cannot be moved by signature`);
  }

  const message = buildPermitMessage({
    owner: account.address,
    spender: pre.marginAccount,
    marginAccount: pre.marginAccount,
    value: amount,
    nonce: token.nonce,
    deadlineSeconds: TOP_UP_DEADLINE_SECONDS,
  });

  const signature: Hex = await account.account.signTypedData(
    permitTypedData(message, token.domain),
  );

  const permitCall = buildPermitCall(token.address, message, signature);
  const depositCall = buildDeposit(pre.marginAccount, account.address, token.address, amount);

  if (!input.conversion) {
    return { calls: [permitCall, depositCall], logCalls: [depositCall] };
  }

  const conversion = buildConversion({
    market: input.conversion.market,
    params: input.conversion.params,
    tokenIn: token.address,
    tokenOut: input.conversion.params.baseAsset,
    amountIn: amount,
    expectedOut: input.conversion.expectedOut,
    minAmountOut: input.conversion.minAmountOut,
    // The USDC is in the margin account by the time this call runs, which is where
    // the balance has to be drawn from.
    isMargin: true,
  });

  return {
    calls: [permitCall, depositCall, { to: conversion.to, data: conversion.data }],
    logCalls: [depositCall, { to: conversion.to, data: conversion.data }],
    conversion,
  };
}

/**
 * Sign, assemble, quote (a top-up is an ordinary action — not exempt like a send or
 * a withdraw — so once the free tier is used it is charged, per the gas-policy
 * task), append a fee leg if the quote says one is owed, and hand the whole batch to
 * `submit()`.
 *
 * Shared by `TopUpCard.tsx`'s own "Move to trading balance" button and
 * `MoveSheet.tsx`'s Move-in — both go through this one function, so both are
 * correctly gas-charge-aware rather than one being wired and the other left to hit
 * the relayer's refusal with no way to pay past it (the deploy blocker this task
 * exists to close).
 */
export async function topUp(input: TopUpInput): Promise<Progress> {
  input.onProgress({ state: 'VALIDATING' });

  const prepared = await prepareTopUp(input);

  return runWithGasCharge({
    sender: input.account.address,
    actionCalls: prepared.calls,
    logCalls: prepared.logCalls,
    purpose: 'deposit',
    marginAccount: input.preflight.marginAccount,
    onProgress: input.onProgress,
    ...(input.onFeePlan ? { onFeePlan: input.onFeePlan } : {}),
    // The key that signs the operation and, on a first-time account, the EIP-7702
    // authorization. Without it `submit()` has no transport and cannot send.
    owner: input.account.account,
  });
}

/**
 * Would a sponsor take this batch?
 *
 * Checked before the passkey prompt, using the same `assertSponsorable` the relayer
 * runs. `market` must be passed for the conversion leg — see the note at the top.
 */
export function sponsorWouldAccept(
  pre: PermitPreflight,
  token: Address,
  calls: readonly { readonly to: Address; readonly data: Hex }[],
  market: Address = AUSD_USDC_MARKET,
): boolean {
  return isSponsorable(
    calls.map((c) => ({ to: c.to, data: c.data, value: 0n })),
    policyFor(pre, token, market),
  );
}
