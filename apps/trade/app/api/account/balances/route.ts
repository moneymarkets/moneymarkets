import { NextResponse } from 'next/server';
import { getAddress, isAddress, type Address } from 'viem';
import {
  AUSD_USDC_MARKET,
  DISABLED_MARKET_CANDIDATES,
  ENTRY_POINT_V08,
  TRADING_MARKET_CANDIDATES,
  type MAINNET,
  type MarketParams,
} from '@tradepro/core';
import { z } from 'zod';
import { addresses, readClient } from '../../../../lib/server/chain';
import { flowUsdPerWholePeek } from '../../../../lib/server/tokens/flowPrice';
import { kuruMarketMetaCached } from '../../../../lib/server/tokens/kuruMarketMeta';
import { tokenDb } from '../../../../lib/server/tokens/tokenDb';
import { registryEntry, tokenRegistry } from '../../../../lib/server/tokens/tokenRegistryLive';
import {
  classifyMarketPrice,
  enumerateTokenSpecs,
  isUsdDenominated,
  NATIVE_MON,
  readableTokenPlans,
  toUsd,
  toUsdPar,
  usdcQuotedMarkets,
  usdFromFlow,
  USD_DECIMALS,
  type KnownToken,
  type LegacyToken,
} from '../../../../lib/server/walletTokens';

const UINT256_MAX = 2n ** 256n - 1n;

/**
 * Minimal, single-function ABIs, one per call. Multicall's type inference walks the
 * `contracts` array as a positional tuple; mixing the full (10-entry) `erc20Abi` and
 * the full (51-entry) `marginAccountAbi` in one literal made every position's ABI
 * check itself against every other position's shape. One function each sidesteps
 * that entirely, and it is all this route ever calls.
 */
const balanceOfAbi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

const marginGetBalanceAbi = [
  {
    type: 'function',
    name: 'getBalance',
    stateMutability: 'view',
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'token', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const;

const bestBidAskAbi = [
  {
    type: 'function',
    name: 'bestBidAsk',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }, { type: 'uint256' }],
  },
] as const;

/** For tokens this route did not already know the decimals of (item 9: activity-seen tokens). */
const decimalsAbi = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const;

/** Best-effort display name for a token this route had to discover at read time. */
const symbolAbi = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
] as const;

/**
 * The one balance route (stabilization pass, item 2a).
 *
 * Before this, four different places read an account's balance four different ways —
 * `/api/account` (margin + a hand-picked wallet list), `/api/fund/permit` (its own
 * wallet reads, for a different reason), `TradeScreen`'s two `useBalance` calls, and
 * `useSettlement`'s own margin poll — and nothing guaranteed any two of them agreed at
 * the same moment. The Move card vanishing while real USDC sat in the wallet, and the
 * ticket showing an AUSD figure under a "USDC" label, both trace back to that: not one
 * read being wrong, but two reads never being the same read.
 *
 * This route is now the only place `apps/trade` reads a Monad balance for display.
 * Everything in one `eth_call` via Multicall3 (`chain/chains.ts`'s `monad` definition
 * carries the address, confirmed live on Monad 2026-09-08), one block, so every
 * figure in the response is consistent with every other — there is no window where
 * `wallet.USDC` and `margin.USDC` were read a block apart. `entryPointDeposit` is
 * exposed too, since it decided whether an order or a move could send at all.
 *
 * `useSettlement.ts` is the one caller that does not move to this route: it needs a
 * *baseline* captured at a specific moment (right before a move starts) and a tighter
 * poll while a settlement is in flight, which this route's flat "current value" shape
 * does not express. It reads margin AUSD on its own, for that one purpose, and drives
 * no balance display.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const tokenBalanceSchema = z.object({ value: z.string(), decimals: z.number().int() });

/**
 * Wallet tab, data layer (WALLET-IMPLEMENTATION.md section 3 / section 9's pending
 * item): dynamic token enumeration, so the owner's cbBTC, WETH and XAUt0 in margin —
 * invisible under the old hand-picked list — show up without another hardcoded row
 * being added by hand next time a market ships.
 *
 * `tokens[]` covers every base and quote asset of every `TRADING_MARKET_CANDIDATES`
 * market (read live, not copied from today's snapshot, so a new market needs no
 * change here), plus the address book (AUSD, USDC, USDT0, MON, WMON), plus any
 * address the caller names in `?extraTokens=` (see the comment on that below for why
 * this route cannot read the activity store itself).
 */
const usdAmountSchema = tokenBalanceSchema;

const tokenEntrySchema = z.object({
  symbol: z.string(),
  /** The token's full name (v2.1 spec 1.4/2.2): the registry's, else the contract's
   *  own from `token_meta`, else the symbol — never invented. */
  name: z.string(),
  /** Checksummed. The native-MON row uses the zero address, same convention as `margin`. */
  address: z.string(),
  decimals: z.number().int(),
  wallet: tokenBalanceSchema,
  margin: tokenBalanceSchema,
  usd: z.object({
    /** Dollar price of one whole token unit, six-decimal dollars. `null` with no source. */
    price: usdAmountSchema.nullable(),
    wallet: usdAmountSchema.nullable(),
    margin: usdAmountSchema.nullable(),
    total: usdAmountSchema.nullable(),
  }),
  /**
   * `'par'` — AUSD/USDC, one-for-one.
   * `'market-mid'` — the live mid of a market quoted in USDC (MON and WMON reuse
   *   the MON/USDC book; cbBTC, WETH, XAUt0 and any future USDC-quoted market's
   *   base read their own book).
   * `'flow-quote'` — a live Kuru Flow quote against USDC (everything else, e.g.
   *   USDT0 and emo, which is quoted in MON, not a dollar).
   * `'none'` — no source answered. `usd` is all `null`; render "No price available".
   */
  priceSource: z.enum(['par', 'market-mid', 'flow-quote', 'none']),
  /**
   * Real `priceChange24h` from Kuru's own `GET /api/v1/markets/<address>` (confirmed
   * live 2026-09-24: the field exists and is populated), carried only for a token
   * priced by its own USDC-quoted book — that is the only case where the number is a
   * dollar-denominated change. `null` otherwise, or while the background refresh
   * (`kuruMarketMetaCached`) has not resolved yet. Never synthesised.
   */
  change24h: z.number().nullable(),
  /**
   * From Kuru's market token list (`basetoken`/`quotetoken.imageurl`), read live.
   * Confirmed hosts: `dsvxs4ecepqgj.cloudfront.net` (most tokens) and
   * `crypto-token-logos-production.s3.us-west-2.amazonaws.com` (emo). `null` when
   * the token is not the base or quote of any market Kuru still lists — true today
   * for USDT0 and WMON, which are not on any book.
   */
  iconUrl: z.string().nullable(),
  /**
   * Any-token wallet (spec A3): true when at least one registry source (Kuru's market
   * list, Flow's list, the base set) names this token. False for a token the account
   * holds that no list names, which the UI groups under "Unlisted tokens" with an
   * "unverified" chip and its contract address. Display only; actions are identical.
   */
  listed: z.boolean(),
});

/**
 * Reserved for the gas-policy free-tier work landing in parallel (not this pass —
 * see the repo's own note that `apps/relayer` gas-charge files are mid-change right
 * now). This route does not populate the field; it is typed and optional so the
 * later integration is one assignment, not a response-shape change downstream UI
 * code has to be rewritten against.
 *
 * TODO(gas-policy): fill from the relayer's free-action ledger once that route
 * ships (`FREE_ACTIONS_PER_DAY`, `freeActionHeadroom` in `@tradepro/core`'s gas
 * layer name the shape this will likely read from).
 */
const freeActionsSchema = z.object({
  used: z.number().int(),
  limit: z.number().int(),
  /** Unix ms. */
  resetAt: z.number(),
});

const responseSchema = z.object({
  address: z.string(),
  blockNumber: z.string(),
  wallet: z.object({
    AUSD: tokenBalanceSchema,
    USDC: tokenBalanceSchema,
    USDT0: tokenBalanceSchema,
    MON: tokenBalanceSchema,
  }),
  margin: z.object({
    AUSD: tokenBalanceSchema,
    USDC: tokenBalanceSchema,
    // Added for withdraw: "every token with a non-zero margin balance" cannot be
    // answered from AUSD and USDC alone. A trade settles into the market's base
    // asset, so an account that has bought MON holds MON *in margin* — 0.774 MON in
    // the owner's case — and without these legs there was no way to see it, and no
    // way to take it out.
    USDT0: tokenBalanceSchema,
    MON: tokenBalanceSchema,
  }),
  entryPointDeposit: tokenBalanceSchema,
  /**
   * Margin balance of one extra, caller-named token — the trade ticket's sell side,
   * which can be any market's base asset (MON, WBTC, …), not just AUSD or USDC.
   * Present only when `?baseToken=` was given. Still one multicall, one block, same
   * as everything else here — this is the one place the fixed AUSD/USDC shape
   * above cannot cover, not a second balance read living outside this route.
   */
  marginBase: tokenBalanceSchema.optional(),
  /**
   * AUSD per USDC, wire-scaled (human * 1e18) — same convention `ticket.ts` uses for
   * a price. `null` when the book has no resting liquidity on one side (the sentinel
   * `bestBidAsk` returns), so a caller can fall back to par rather than divide by a
   * number that means "empty," not "one."
   */
  ausdPerUsdcMid: z.string().nullable(),
  readAt: z.number(),
  /** Dynamic token enumeration, Wallet tab data layer. See the comment above. */
  tokens: z.array(tokenEntrySchema),
  /**
   * How many non-zero holdings carry no price (spec A4/E2): the total excludes them,
   * and the screen says so with this number, not by inference.
   */
  unpricedCount: z.number().int(),
  /** Absent until the gas-policy free-tier route ships. See `freeActionsSchema`. */
  freeActions: freeActionsSchema.optional(),
});

export type AccountBalancesResponse = z.infer<typeof responseSchema>;

/** Never longer than the "no caching beyond 3 seconds" rule (item 2a). */
const CACHE_MS = 3000;
const cache = new Map<string, { at: number; body: AccountBalancesResponse }>();

/*
 * Kuru's per-market metadata (icons, 24h change) and the Flow one-unit price now live in
 * `lib/server/tokens/kuruMarketMeta.ts` and `lib/server/tokens/flowPrice.ts`, shared with
 * the token registry and the lazy per-row price route. This route reads them; it no
 * longer fires a Flow quote for every unpriced token on every poll (spec A4: lazily,
 * when the row is on screen).
 */

export async function GET(request: Request) {
  const url = new URL(request.url);
  const owner = url.searchParams.get('address') ?? '';
  if (!isAddress(owner)) {
    return NextResponse.json({ error: 'NOT_AN_ADDRESS' }, { status: 400 });
  }
  const account = getAddress(owner);

  const baseTokenRaw = url.searchParams.get('baseToken');
  if (baseTokenRaw !== null && !isAddress(baseTokenRaw)) {
    return NextResponse.json({ error: 'BAD_BASE_TOKEN' }, { status: 400 });
  }
  const baseToken = baseTokenRaw === null ? undefined : getAddress(baseTokenRaw);
  // The caller (the ticket, which already read the market's own params) names its
  // decimals rather than this route reading a fourth thing to learn one number.
  const baseDecimalsRaw = url.searchParams.get('baseDecimals');
  const baseTokenDecimals = baseDecimalsRaw === null ? 18 : Number(baseDecimalsRaw);
  if (!Number.isInteger(baseTokenDecimals) || baseTokenDecimals < 0 || baseTokenDecimals > 36) {
    return NextResponse.json({ error: 'BAD_BASE_DECIMALS' }, { status: 400 });
  }

  // Wallet tab data layer, item 1: "any token this account's activity store has
  // recorded receiving". The activity store (`apps/trade/lib/activityStore.ts`) is
  // `window.localStorage`, per browser — there is no server-side twin for a route
  // handler to read, and its rows do not carry a token address today, only a
  // `symbol` string (checked: `ActivityRow`, `WireDeposit` in
  // `useDepositArrivals.ts` — neither has an address field). So this route cannot
  // itself discover an address from past activity without guessing one from a
  // symbol, which rule A2.5 forbids. What it can honestly do is accept addresses
  // the caller already resolved some other way, so a later pass that teaches the
  // activity store to carry real addresses is a one-line change on the caller's
  // side, not a reopening of this route. Every symbol the app's activity rows use
  // today (AUSD, USDC, USDT0, MON, WMON, and every live market's base) already has
  // a known address below regardless.
  const extraTokensRaw = url.searchParams.get('extraTokens');
  const extraTokenAddresses: Address[] = [];
  if (extraTokensRaw) {
    for (const piece of extraTokensRaw.split(',').map((s) => s.trim()).filter(Boolean)) {
      if (!isAddress(piece)) {
        return NextResponse.json({ error: 'BAD_EXTRA_TOKEN' }, { status: 400 });
      }
      extraTokenAddresses.push(getAddress(piece));
    }
  }

  const cacheKey = `${account}:${baseToken ?? ''}:${[...extraTokenAddresses]
    .map((a) => a.toLowerCase())
    .sort()
    .join(',')}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return NextResponse.json(cached.body, { headers: { 'cache-control': 'no-store' } });
  }

  const chain = addresses();
  const marginAccountRaw = chain.kuru.marginAccount as Address | undefined;
  if (!marginAccountRaw) {
    return NextResponse.json({ error: 'NO_MARGIN_ACCOUNT_ON_THIS_CHAIN' }, { status: 503 });
  }
  // Reassigned to a non-optional binding: TS does not carry the narrowing above
  // into the nested `planToken`/`planBook` closures below, which both close over it.
  const marginAccount: Address = marginAccountRaw;
  // Only mainnet's chain object carries a MarginAccount (TESTNET.kuru.marginAccount
  // is `undefined`), so reaching here means `chain` really is MAINNET, USDT0 key
  // included — the cast makes that already-true fact visible to the type checker.
  const mainnetChain = chain as typeof MAINNET;

  const ausd = mainnetChain.tokens.AUSD;
  const usdc = mainnetChain.tokens.USDC;
  const usdt0 = mainnetChain.tokens.USDT0;
  const mon = mainnetChain.tokens.MON;
  const wmon = mainnetChain.tokens.WMON;

  try {
    const client = readClient();

    // ---- Wallet tab data layer: dynamic token + pricing-book plan ----
    //
    // Built before the multicall so every extra leg lands in the same one-block
    // read as everything else in this file (the whole point of this route, per the
    // doc comment above). Four tokens (AUSD, USDC, USDT0, native MON) already have
    // fixed legs below; the plan reuses those instead of reading them twice.
    //
    // Untyped on purpose, same reasoning as `paramsTuple as never` in
    // `lib/server/venueState.ts`: viem's multicall infers its return type from the
    // literal shape of `contracts` as a positional tuple, which is exactly why the
    // file's own doc comment above keeps every ABI here to one function — a legs
    // array whose length is only known at request time cannot be that literal
    // tuple, so it is built loosely and read back through the same `readOrThrow`
    // every fixed leg already goes through, never trusted at the type level.
    interface MulticallLeg {
      readonly address: Address;
      readonly abi: readonly unknown[];
      readonly functionName: string;
      readonly args: readonly unknown[];
    }

    const legs: MulticallLeg[] = [
      { address: ausd.address, abi: balanceOfAbi, functionName: 'balanceOf', args: [account] },
      { address: usdc.address, abi: balanceOfAbi, functionName: 'balanceOf', args: [account] },
      { address: usdt0.address, abi: balanceOfAbi, functionName: 'balanceOf', args: [account] },
      {
        address: marginAccount,
        abi: marginGetBalanceAbi,
        functionName: 'getBalance',
        args: [account, ausd.address],
      },
      {
        address: marginAccount,
        abi: marginGetBalanceAbi,
        functionName: 'getBalance',
        args: [account, usdc.address],
      },
      {
        address: ENTRY_POINT_V08,
        abi: balanceOfAbi,
        functionName: 'balanceOf',
        args: [account],
      },
      {
        address: AUSD_USDC_MARKET,
        abi: bestBidAskAbi,
        functionName: 'bestBidAsk',
        args: [],
      },
      // Always present, fixed array length (a conditional spread here made the
      // multicall result a union of tuple lengths, which viem's own typing
      // cannot index into safely) — harmlessly re-queries AUSD when no
      // `baseToken` was requested, and that leg is simply not read below.
      {
        address: marginAccount,
        abi: marginGetBalanceAbi,
        functionName: 'getBalance',
        args: [account, baseToken ?? ausd.address],
      },
      {
        address: marginAccount,
        abi: marginGetBalanceAbi,
        functionName: 'getBalance',
        args: [account, usdt0.address],
      },
      {
        // Native MON in the margin account is keyed by the zero address, the same
        // convention `getMarketParams().baseAsset` uses for a native base.
        address: marginAccount,
        abi: marginGetBalanceAbi,
        functionName: 'getBalance',
        args: [account, NATIVE_MON],
      },
    ];

    interface TokenPlan {
      symbol: string;
      address: Address;
      decimals: number;
      legacy?: LegacyToken;
      walletIdx?: number;
      marginIdx?: number;
      decimalsIdx?: number;
      symbolIdx?: number;
    }

    // "What tokens" is `enumerateTokenSpecs` (pure, unit tested in
    // `walletTokens.test.ts` against the real `TRADING_MARKET_CANDIDATES` list —
    // that test is what proves cbBTC/WETH/XAUt0 are enumerated at all). "How to
    // read them" — which multicall leg each one needs — is this route's own I/O
    // concern and stays here.
    // Any-token wallet (spec A2a-c): every registry token, plus every token the
    // account's own set names (found by the Transfer-log scan or added by address).
    // A token whose contract metadata is already on record is planned with its known
    // decimals; one that is not is planned as an unknown and read live below.
    const registry = await tokenRegistry();
    const accountTokens = tokenDb().accountTokens(account);
    const storedMeta = tokenDb().getMeta(accountTokens.map((r) => r.token));
    const knownTokens: KnownToken[] = registry.tokens.map((t) => ({
      address: t.address,
      symbol: t.symbol,
      decimals: t.decimals,
    }));
    const allExtra: Address[] = [...extraTokenAddresses];
    for (const row of accountTokens) {
      const token = getAddress(row.token);
      const meta = storedMeta.get(row.token.toLowerCase());
      if (meta) knownTokens.push({ address: token, symbol: meta.symbol, decimals: meta.decimals });
      else allExtra.push(token);
    }
    const tokenSpecs = enumerateTokenSpecs(
      { AUSD: ausd, USDC: usdc, USDT0: usdt0, MON: mon, WMON: wmon },
      allExtra,
      TRADING_MARKET_CANDIDATES,
      knownTokens,
    );

    const tokenPlans: TokenPlan[] = tokenSpecs.map((spec) => {
      if (spec.legacy) return { ...spec };
      const plan: TokenPlan = { ...spec };
      const isNative = spec.address.toLowerCase() === NATIVE_MON.toLowerCase();
      if (!isNative) {
        plan.walletIdx = legs.length;
        legs.push({ address: spec.address, abi: balanceOfAbi, functionName: 'balanceOf', args: [account] });
      }
      plan.marginIdx = legs.length;
      legs.push({
        address: marginAccount,
        abi: marginGetBalanceAbi,
        functionName: 'getBalance',
        args: [account, spec.address],
      });
      if (spec.decimals < 0) {
        plan.decimalsIdx = legs.length;
        legs.push({ address: spec.address, abi: decimalsAbi, functionName: 'decimals', args: [] });
        plan.symbolIdx = legs.length;
        legs.push({ address: spec.address, abi: symbolAbi, functionName: 'symbol', args: [] });
      }
      return plan;
    });

    interface BookPlan {
      market: Address;
      params: MarketParams;
      bidAskIdx: number;
    }
    // A pricing-book leg for every trading candidate quoted in USDC — MON, WETH,
    // cbBTC, XAUt0 today, and any future market with the same quote asset.
    const usdcMarkets = usdcQuotedMarkets(usdc.address);
    const bookPlans: BookPlan[] = usdcMarkets.map((candidate) => {
      const bidAskIdx = legs.length;
      legs.push({ address: candidate.address, abi: bestBidAskAbi, functionName: 'bestBidAsk', args: [] });
      return { market: candidate.address, params: candidate.params, bidAskIdx };
    });

    const [blockNumber, walletMon, multicallRaw] = await Promise.all([
      client.getBlockNumber(),
      client.getBalance({ address: account }),
      client.multicall({ contracts: legs as never }),
    ]);

    // `contracts: legs as never` above (necessary because `legs`'s length is only
    // known at request time — see the comment on `MulticallLeg`) makes viem infer
    // this call's result as `never[]`, which is unusable for indexing. Recast
    // through `unknown` to the shape multicall actually returns at runtime,
    // exactly what the rest of this file already assumed before this change.
    interface LegResult {
      readonly status: 'success' | 'failure';
      readonly result?: unknown;
      readonly error?: { message?: string };
    }
    const multicallResults = multicallRaw as unknown as readonly LegResult[];

    const readOrThrow = (index: number): bigint => {
      const r = multicallResults[index];
      if (!r || r.status !== 'success') {
        throw new Error(`balances multicall leg ${index} failed: ${r?.error?.message ?? 'no result'}`);
      }
      return r.result as bigint;
    };

    const walletAusd = readOrThrow(0);
    const walletUsdc = readOrThrow(1);
    const walletUsdt0 = readOrThrow(2);
    const marginAusd = readOrThrow(3);
    const marginUsdc = readOrThrow(4);
    const epDeposit = readOrThrow(5);

    // bestBidAsk() has two unnamed outputs, so viem's multicall result is the tuple.
    const bidAskResult = multicallResults[6];
    let mid: bigint | null = null;
    if (bidAskResult && bidAskResult.status === 'success') {
      const [bid, ask] = bidAskResult.result as readonly [bigint, bigint];
      const bidReal = bid < UINT256_MAX;
      const askReal = ask > 0n;
      if (bidReal && askReal) mid = (bid + ask) / 2n;
      else if (bidReal) mid = bid;
      else if (askReal) mid = ask;
      // else: no resting liquidity on either side, stays null.
    }

    // ---- Wallet tab data layer: resolve each planned token ----
    //
    // Balance and decimals legs use `readOrThrow` like every other leg in this
    // file: a failed read here is not a balance of zero, so it fails the whole
    // request rather than quietly omitting one row (the rule item 9 in the file's
    // own doc history exists to enforce). Pricing is different — the spec is
    // explicit that a token with no price source shows its quantity with no dollar
    // value, so a missing or unreadable book never throws, only leaves `usd: null`.
    function midFromBidAsk(index: number): bigint | null {
      const r = multicallResults[index];
      if (!r || r.status !== 'success') return null;
      const [bid, ask] = r.result as readonly [bigint, bigint];
      const bidReal = bid < UINT256_MAX;
      const askReal = ask > 0n;
      if (bidReal && askReal) return (bid + ask) / 2n;
      if (bidReal) return bid;
      if (askReal) return ask;
      return null;
    }

    const bookMids = new Map<string, bigint | null>();
    for (const b of bookPlans) bookMids.set(b.market.toLowerCase(), midFromBidAsk(b.bidAskIdx));

    // Icons and 24h change: Kuru's own market list, read live and cached with
    // background refresh (`kuruMarketMetaCached`). Never blocks this response —
    // a cold cache reads as `undefined` for that market this time, and the next
    // request (this process, any account) sees it once the refresh lands.
    const iconByToken = new Map<string, string | null>();
    const change24hByToken = new Map<string, number | null>();
    for (const candidate of [...TRADING_MARKET_CANDIDATES, ...DISABLED_MARKET_CANDIDATES]) {
      const meta = kuruMarketMetaCached(candidate.address, mainnetChain.kuru.restApi);
      if (!meta) continue;
      if (meta.baseIconUrl) iconByToken.set(candidate.params.baseAsset.toLowerCase(), meta.baseIconUrl);
      if (meta.quoteIconUrl) iconByToken.set(candidate.params.quoteAsset.toLowerCase(), meta.quoteIconUrl);
      // Only a market quoted in USDC carries a dollar-denominated change. emo/MON's
      // `priceChange24h` is emo priced in MON, not USD — not usable here.
      if (isUsdDenominated(candidate.params, usdc.address)) {
        change24hByToken.set(candidate.params.baseAsset.toLowerCase(), meta.priceChange24h);
      }
    }
    // WMON is native MON's wrapped form, priced at the same book (see the MON/WMON
    // branch below) — its 24h change is the same real number, not a synthesised one.
    const monChange = change24hByToken.get(NATIVE_MON.toLowerCase());
    if (monChange !== undefined) change24hByToken.set(wmon.address.toLowerCase(), monChange);
    // The registry's own logo URLs (the same Kuru metadata, joined by address) fill any
    // token the market loop above did not reach.
    for (const entry of registry.tokens) {
      if (entry.logoUrl && !iconByToken.has(entry.address.toLowerCase())) {
        iconByToken.set(entry.address.toLowerCase(), entry.logoUrl);
      }
    }

    function shortSymbolFallback(address: Address): string {
      return `${address.slice(0, 6)}…${address.slice(-4)}`;
    }

    function usdAmountFor(
      amount: bigint,
      decimals: number,
      source: 'market-mid' | 'flow-quote',
      priceWire: bigint | undefined,
      flowPerWhole: bigint | undefined,
    ): bigint {
      if (source === 'market-mid') return toUsd(amount, decimals, priceWire as bigint);
      return usdFromFlow(amount, decimals, flowPerWhole as bigint);
    }

    // A token this app found on its own (the account's Transfer-log scan), outside the
    // registry and the core tokens, whose balance or decimals read fails is left out of
    // the answer instead of failing it (owner, 2026-09-30). An address-poisoning token
    // ("AỤSD", 0x2794...B933) sent a Transfer to a proof account, was discovered, and
    // its balanceOf reverts: every wallet read for that account failed from then on. Every
    // other leg still fails the whole request, so a real balance never reads as zero.
    const registryAddresses = new Set(registry.tokens.map((t) => t.address.toLowerCase()));
    const scannedOnly = new Set(
      accountTokens
        .filter((r) => r.source === 'scan' && !registryAddresses.has(r.token.toLowerCase()))
        .map((r) => r.token.toLowerCase()),
    );
    const { kept: readablePlans, dropped } = readableTokenPlans(tokenPlans, multicallResults, scannedOnly);
    for (const plan of dropped) {
      console.warn(JSON.stringify({ level: 'warn', msg: 'discovered token left out: its read failed', account, token: plan.address }));
    }

    const tokens: AccountBalancesResponse['tokens'] = readablePlans.map((plan) => {
      const addressLower = plan.address.toLowerCase();

      let decimals = plan.decimals;
      let symbol = plan.symbol;
      if (decimals < 0) {
        const rawDecimals = Number(readOrThrow(plan.decimalsIdx as number));
        if (!Number.isInteger(rawDecimals) || rawDecimals < 0 || rawDecimals > 36) {
          throw new Error(`token ${plan.address} returned an unusable decimals() value: ${rawDecimals}`);
        }
        decimals = rawDecimals;
        const symResult = multicallResults[plan.symbolIdx as number];
        symbol =
          symResult && symResult.status === 'success' && typeof symResult.result === 'string' && symResult.result.length > 0
            ? symResult.result
            : shortSymbolFallback(plan.address);
      }

      let walletValue: bigint;
      let marginValue: bigint;
      switch (plan.legacy) {
        case 'AUSD':
          walletValue = walletAusd;
          marginValue = marginAusd;
          break;
        case 'USDC':
          walletValue = walletUsdc;
          marginValue = marginUsdc;
          break;
        case 'USDT0':
          walletValue = walletUsdt0;
          marginValue = readOrThrow(8);
          break;
        case 'MON':
          walletValue = walletMon;
          marginValue = readOrThrow(9);
          break;
        default:
          // Every non-legacy plan always got a wallet leg (native MON is always
          // `legacy: 'MON'` above, never reaches here) and a margin leg.
          if (plan.walletIdx === undefined || plan.marginIdx === undefined) {
            throw new Error(`token ${plan.address} plan is missing a balance leg`);
          }
          walletValue = readOrThrow(plan.walletIdx);
          marginValue = readOrThrow(plan.marginIdx);
      }

      // `classifyMarketPrice` (walletTokens.ts, unit tested) knows par and the two
      // on-chain book sources — MON/WMON reusing the MON/USDC book, exactly what
      // `chain/quoteValuation.ts`'s `quoteValuationFor`/`MON_USDC_PRICING_BOOK`
      // does, not rebuilt here; and any other token that is itself the base of a
      // USDC-quoted market. `'none'` from it means try a live Flow quote next.
      const decision = classifyMarketPrice(plan.address, { AUSD: ausd, USDC: usdc, WMON: wmon }, usdcMarkets, bookMids);
      let priceSource = decision.source;
      const priceWire = decision.priceWire;
      let flowPerWhole: bigint | undefined;
      if (priceSource === 'none') {
        // Only what the lazy per-row price route (`/api/token/price`) already learned:
        // this poll never asks Flow itself (spec A4, and Flow's 1 rps limit).
        const flow = flowUsdPerWholePeek(plan.address);
        if (flow !== undefined) {
          priceSource = 'flow-quote';
          flowPerWhole = flow;
        }
      }

      let usd: {
        price: { value: string; decimals: number } | null;
        wallet: { value: string; decimals: number } | null;
        margin: { value: string; decimals: number } | null;
        total: { value: string; decimals: number } | null;
      } = { price: null, wallet: null, margin: null, total: null };

      if (priceSource === 'par') {
        const priceUsd = toUsdPar(10n ** BigInt(decimals), decimals);
        const walletUsd = toUsdPar(walletValue, decimals);
        const marginUsd = toUsdPar(marginValue, decimals);
        usd = {
          price: { value: priceUsd.toString(), decimals: USD_DECIMALS },
          wallet: { value: walletUsd.toString(), decimals: USD_DECIMALS },
          margin: { value: marginUsd.toString(), decimals: USD_DECIMALS },
          total: { value: (walletUsd + marginUsd).toString(), decimals: USD_DECIMALS },
        };
      } else if (priceSource === 'market-mid' || priceSource === 'flow-quote') {
        const priceUsd = usdAmountFor(10n ** BigInt(decimals), decimals, priceSource, priceWire, flowPerWhole);
        const walletUsd = usdAmountFor(walletValue, decimals, priceSource, priceWire, flowPerWhole);
        const marginUsd = usdAmountFor(marginValue, decimals, priceSource, priceWire, flowPerWhole);
        usd = {
          price: { value: priceUsd.toString(), decimals: USD_DECIMALS },
          wallet: { value: walletUsd.toString(), decimals: USD_DECIMALS },
          margin: { value: marginUsd.toString(), decimals: USD_DECIMALS },
          total: { value: (walletUsd + marginUsd).toString(), decimals: USD_DECIMALS },
        };
      }

      const reg = registryEntry(registry, plan.address);
      return {
        symbol,
        name: reg?.name ?? storedMeta.get(addressLower)?.name ?? symbol,
        address: plan.address,
        decimals,
        wallet: { value: walletValue.toString(), decimals },
        margin: { value: marginValue.toString(), decimals },
        usd,
        priceSource,
        change24h: change24hByToken.get(addressLower) ?? null,
        iconUrl: iconByToken.get(addressLower) ?? null,
        listed: reg !== undefined,
      };
    });

    const unpricedCount = tokens.filter(
      (t) => t.priceSource === 'none' && (BigInt(t.wallet.value) > 0n || BigInt(t.margin.value) > 0n),
    ).length;

    const body: AccountBalancesResponse = {
      address: account,
      blockNumber: blockNumber.toString(),
      wallet: {
        AUSD: { value: walletAusd.toString(), decimals: ausd.decimals },
        USDC: { value: walletUsdc.toString(), decimals: usdc.decimals },
        USDT0: { value: walletUsdt0.toString(), decimals: usdt0.decimals },
        MON: { value: walletMon.toString(), decimals: 18 },
      },
      margin: {
        AUSD: { value: marginAusd.toString(), decimals: ausd.decimals },
        USDC: { value: marginUsdc.toString(), decimals: usdc.decimals },
        USDT0: { value: readOrThrow(8).toString(), decimals: usdt0.decimals },
        MON: { value: readOrThrow(9).toString(), decimals: 18 },
      },
      entryPointDeposit: { value: epDeposit.toString(), decimals: 18 },
      ...(baseToken
        ? { marginBase: { value: readOrThrow(7).toString(), decimals: baseTokenDecimals } }
        : {}),
      ausdPerUsdcMid: mid === null ? null : mid.toString(),
      readAt: Date.now(),
      tokens,
      unpricedCount,
      // `freeActions` is intentionally omitted — see `freeActionsSchema`'s doc
      // comment. TODO(gas-policy): assign it once the relayer ledger route ships.
    };

    const parsed = responseSchema.parse(body);
    // `cacheKey`, not `account`: the body differs by `baseToken` (it carries
    // `marginBase` only when one was asked for), and writing under the bare account
    // meant a request WITH a base token could be served a cached body without it.
    cache.set(cacheKey, { at: Date.now(), body: parsed });

    return NextResponse.json(parsed, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    console.error('account balances read failed', account, error);
    return NextResponse.json(
      {
        error: 'BALANCES_READ_FAILED',
        upstream: { message: error instanceof Error ? error.message : String(error), source: 'Monad RPC' },
      },
      { status: 502 },
    );
  }
}
