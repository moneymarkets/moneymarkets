'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Address } from 'viem';
import { apiUrl } from './basePath';
import { failure, failureText, withDetail } from './failures';
import { detailFrom, type WireErrorBody } from './upstream';

/**
 * The one balance read (stabilization pass, item 2b).
 *
 * Every screen that shows a number backed by chain state — Home, Portfolio, the
 * trade ticket, the Move card, Settings' account list — calls this and nothing else.
 * The route behind it (`/api/account/balances`) reads wallet, margin and the
 * EntryPoint deposit in one multicall at one block, so two screens open at the same
 * moment cannot show two different truths about the same account.
 *
 * Polls every 5 seconds while the tab is visible (a hidden tab polling a wallet
 * balance burns RPC quota nobody is looking at), and exposes `refresh()` so a caller
 * can force an immediate read the instant its own `submit()` resolves — polling alone
 * would show a stale figure for up to 5 seconds after a real transaction landed.
 *
 * A failed read reports `status: 'error'` and leaves every figure undefined. It must
 * never come back as zero: a balance that could not be read is not a balance of zero,
 * and rendering it as one has told people their money was gone (ITEM 9).
 */

export interface TokenAmount {
  readonly value: bigint;
  readonly decimals: number;
}

/** `priceSource` on a wallet token entry — see `walletTokens.ts`'s `classifyMarketPrice`. */
export type WalletPriceSource = 'par' | 'market-mid' | 'flow-quote' | 'none';

/**
 * One row of `/api/account/balances`' dynamic `tokens[]` array (wallet spec §3, §9's
 * pending item: dynamic token enumeration). The Wallet tab's holdings list, hero
 * total and Waiting card all read this rather than the four-token `wallet`/`margin`
 * shape above, which predates the Wallet tab and still drives the screens built
 * before it.
 */
export interface WalletTokenEntry {
  readonly symbol: string;
  /** The token's full name (registry's, else the contract's own, else the symbol). */
  readonly name: string;
  readonly address: Address;
  readonly decimals: number;
  readonly wallet: TokenAmount;
  readonly margin: TokenAmount;
  readonly usd: {
    readonly price: TokenAmount | null;
    readonly wallet: TokenAmount | null;
    readonly margin: TokenAmount | null;
    readonly total: TokenAmount | null;
  };
  readonly priceSource: WalletPriceSource;
  readonly change24h: number | null;
  readonly iconUrl: string | null;
  /** Named by at least one registry source. False: an "Unlisted token" (spec A3). */
  readonly listed: boolean;
}

/** `/api/account/balances`' `freeActions` — absent until the gas-policy free-tier
 *  route ships (see that route's own doc comment). Never faked when absent. */
export interface FreeActions {
  readonly used: number;
  readonly limit: number;
  /** Unix ms. */
  readonly resetAt: number;
}

export interface AccountBalances {
  readonly status: 'signed-out' | 'loading' | 'ready' | 'error';
  readonly blockNumber?: bigint;
  readonly wallet?: {
    readonly AUSD: TokenAmount;
    readonly USDC: TokenAmount;
    readonly USDT0: TokenAmount;
    readonly MON: TokenAmount;
  };
  readonly margin?: {
    readonly AUSD: TokenAmount;
    readonly USDC: TokenAmount;
    readonly USDT0: TokenAmount;
    readonly MON: TokenAmount;
  };
  readonly entryPointDeposit?: TokenAmount;
  /** Margin balance of the `baseToken` passed to the hook, if any was. */
  readonly marginBase?: TokenAmount;
  /** AUSD per USDC, wire-scaled (human * 1e18), from the live AUSD/USDC book. `undefined` while loading, `null` if the book has no resting price on either side. */
  readonly ausdPerUsdcMid?: bigint | null;
  /** True once the wallet holds any token at all — item 3c's "nothing waiting" gate. */
  readonly walletHasFunds?: boolean;
  /** Non-zero holdings with no price; the total excludes them and says so (spec A4/E2). */
  readonly unpricedCount?: number;
  /** Wallet tab (spec §3, §9): every base/quote asset of every live market, plus the
   *  address book, dynamically enumerated. `undefined` while loading or on error —
   *  never an empty array standing in for "not read yet". */
  readonly tokens?: readonly WalletTokenEntry[];
  /** Wallet tab (spec §5.5): the relayer's free-action ledger. `undefined` when the
   *  route has not populated it yet (see `FreeActions`'s doc comment) — render its
   *  card only when this is present, never a stale or fabricated count. */
  readonly freeActions?: FreeActions;
  readonly message?: string;
  readonly refresh: () => void;
  /**
   * ITEM 6 — apply a confirmed order's fill immediately, from the receipt's own
   * decoded `Trade` logs (`filledFromReceipt` in `@tradepro/core`), instead of
   * waiting on the next `/api/account/balances` read. `refresh()` still runs
   * afterwards as a background consistency check — this is what the user sees while
   * that read is in flight, not a replacement for it.
   *
   * A no-op before the first successful read (`status !== 'ready'`): there is
   * nothing to adjust a delta against yet, and the very next `refresh()` will bring
   * the real numbers anyway.
   */
  readonly applyConfirmedFill: (input: {
    readonly quoteSymbol: 'AUSD' | 'USDC' | 'USDT0' | 'MON';
    /** Signed. Positive increases the margin balance for `quoteSymbol`. */
    readonly quoteDelta: bigint;
    /** Signed. Positive increases `marginBase`, when one was requested from this hook. */
    readonly baseDelta: bigint;
  }) => void;
}

const POLL_MS = 5000;
/** Discovery ticks (spec A2b) are separate from balance polls and far less frequent. */
const SCAN_MS = 30_000;

import { readAddedTokens } from './wallet/addedTokens';

interface WireAmount {
  value: string;
  decimals: number;
}

interface WireTokenEntry {
  symbol: string;
  address: string;
  name?: string;
  decimals: number;
  wallet: WireAmount;
  margin: WireAmount;
  usd: {
    price: WireAmount | null;
    wallet: WireAmount | null;
    margin: WireAmount | null;
    total: WireAmount | null;
  };
  priceSource: WalletPriceSource;
  change24h: number | null;
  iconUrl: string | null;
  listed: boolean;
}

interface Body {
  blockNumber: string;
  wallet: Record<'AUSD' | 'USDC' | 'USDT0' | 'MON', { value: string; decimals: number }>;
  margin: Record<'AUSD' | 'USDC' | 'USDT0' | 'MON', { value: string; decimals: number }>;
  entryPointDeposit: { value: string; decimals: number };
  marginBase?: { value: string; decimals: number };
  ausdPerUsdcMid: string | null;
  tokens: readonly WireTokenEntry[];
  unpricedCount?: number;
  freeActions?: { used: number; limit: number; resetAt: number };
}

function toAmount(t: { value: string; decimals: number }): TokenAmount {
  return { value: BigInt(t.value), decimals: t.decimals };
}

function toAmountOrNull(t: WireAmount | null): TokenAmount | null {
  return t === null ? null : toAmount(t);
}

function toTokenEntry(t: WireTokenEntry): WalletTokenEntry {
  return {
    symbol: t.symbol,
    // A body from before v2.1 has no `name`; the symbol is the honest stand-in.
    name: t.name ?? t.symbol,
    address: t.address as Address,
    decimals: t.decimals,
    wallet: toAmount(t.wallet),
    margin: toAmount(t.margin),
    usd: {
      price: toAmountOrNull(t.usd.price),
      wallet: toAmountOrNull(t.usd.wallet),
      margin: toAmountOrNull(t.usd.margin),
      total: toAmountOrNull(t.usd.total),
    },
    priceSource: t.priceSource,
    change24h: t.change24h,
    iconUrl: t.iconUrl,
    // A body from before the registry shipped has no `listed`; nothing it named was
    // ever unlisted, so `true` is the honest default, not a guess.
    listed: t.listed ?? true,
  };
}

type MarginRecord = Record<'AUSD' | 'USDC' | 'USDT0' | 'MON', TokenAmount>;

/**
 * ITEM 6's actual math, pulled out as a pure function so it can be tested directly
 * against a real captured receipt (`useAccountBalances.test.ts`) without rendering
 * the hook — this codebase has no React-hook test harness, and every other pure
 * calculation here is already tested the same way.
 *
 * Clamped at zero rather than allowed to go negative: a delta this app computed
 * wrong is a bug to find in the next `refresh()`, not a balance the user should ever
 * see written as negative.
 */
export function applyFillDelta(
  margin: MarginRecord,
  marginBase: TokenAmount | undefined,
  input: {
    readonly quoteSymbol: keyof MarginRecord;
    readonly quoteDelta: bigint;
    readonly baseDelta: bigint;
  },
): { readonly margin: MarginRecord; readonly marginBase: TokenAmount | undefined } {
  const current = margin[input.quoteSymbol];
  const nextQuote = current.value + input.quoteDelta;
  const nextMargin: MarginRecord = {
    ...margin,
    [input.quoteSymbol]: { value: nextQuote < 0n ? 0n : nextQuote, decimals: current.decimals },
  };
  if (!marginBase) return { margin: nextMargin, marginBase: undefined };
  const nextBase = marginBase.value + input.baseDelta;
  return {
    margin: nextMargin,
    marginBase: { value: nextBase < 0n ? 0n : nextBase, decimals: marginBase.decimals },
  };
}

export function useAccountBalances(
  address: Address | undefined,
  baseToken?: { readonly address: Address; readonly decimals: number },
): AccountBalances {
  const [state, setState] = useState<Omit<AccountBalances, 'refresh' | 'applyConfirmedFill'>>({
    status: address ? 'loading' : 'signed-out',
  });
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const applyConfirmedFill = useCallback<AccountBalances['applyConfirmedFill']>((input) => {
    setState((s) => {
      if (s.status !== 'ready' || !s.margin) return s;
      const { margin, marginBase } = applyFillDelta(s.margin, s.marginBase, input);
      return { ...s, margin, ...(marginBase ? { marginBase } : {}) };
    });
  }, []);

  useEffect(() => {
    if (!address) {
      setState({ status: 'signed-out' });
      return;
    }
    // Narrowed once here: the nested async functions below do not see the guard above.
    const account: Address = address;
    let cancelled = false;
    let timer: number | undefined;
    /**
     * Per-effect, deliberately NOT a `useRef` shared across effect runs.
     *
     * It was a ref, and that starved the very read this hook exists to provide. The
     * trade screen mounts with `params` unknown, so the first run asks for balances
     * with **no** `baseToken`; when params arrive the deps change and a second run
     * asks for the one that includes `marginBase` — the sell side's whole "Available"
     * figure. With one shared flag the second run hit `inFlight === true` from the
     * first and returned without fetching, so `marginBase` stayed undefined and the
     * ticket rendered "Available —" while the account really did hold the asset.
     */
    let inFlight = false;

    async function load(showLoading: boolean) {
      if (inFlight || cancelled) return;
      inFlight = true;
      if (showLoading) setState((s) => ({ ...s, status: 'loading' }));
      try {
        // Tokens the user added by address (spec A2c) ride along on every poll, so a
        // just-added token renders on the next read without waiting for the server's
        // own copy of the account's set to be consulted.
        const added = readAddedTokens(account);
        const extra = added.length > 0 ? `&extraTokens=${added.join(',')}` : '';
        const query = baseToken
          ? `address=${address}&baseToken=${baseToken.address}&baseDecimals=${baseToken.decimals}${extra}`
          : `address=${address}${extra}`;
        const res = await fetch(apiUrl(`/api/account/balances?${query}`), {
          cache: 'no-store',
        });
        if (!res.ok) {
          if (!cancelled) {
            // The route already carries the real RPC error as `upstream` (R5) — read it
            // rather than showing the same generic line for every failure, which is what
            // made a transient RPC hiccup read exactly like something permanent.
            const errorBody = (await res.json().catch(() => undefined)) as WireErrorBody | undefined;
            const f = withDetail(
              failure('BALANCE_UNREADABLE'),
              errorBody ? detailFrom(errorBody, 'Monad RPC') : undefined,
            );
            setState({
              status: 'error',
              message: f.detail ? `${failureText(f)} ${f.detail}` : failureText(f),
            });
          }
          return;
        }
        const body = (await res.json()) as Body;
        if (cancelled) return;
        const wallet = {
          AUSD: toAmount(body.wallet.AUSD),
          USDC: toAmount(body.wallet.USDC),
          USDT0: toAmount(body.wallet.USDT0),
          MON: toAmount(body.wallet.MON),
        };
        const tokens = (body.tokens ?? []).map(toTokenEntry);
        setState({
          status: 'ready',
          blockNumber: BigInt(body.blockNumber),
          wallet,
          margin: {
            AUSD: toAmount(body.margin.AUSD),
            USDC: toAmount(body.margin.USDC),
            USDT0: toAmount(body.margin.USDT0),
            MON: toAmount(body.margin.MON),
          },
          entryPointDeposit: toAmount(body.entryPointDeposit),
          ...(body.marginBase ? { marginBase: toAmount(body.marginBase) } : {}),
          ausdPerUsdcMid: body.ausdPerUsdcMid === null ? null : BigInt(body.ausdPerUsdcMid),
          // Any token, not a fixed three (spec A2d).
          walletHasFunds: tokens.some((t) => t.wallet.value > 0n),
          tokens,
          ...(body.unpricedCount !== undefined ? { unpricedCount: body.unpricedCount } : {}),
          ...(body.freeActions ? { freeActions: body.freeActions } : {}),
        });
      } catch {
        if (!cancelled) {
          setState({ status: 'error', message: failureText(failure('BALANCE_UNREADABLE')) });
        }
      } finally {
        inFlight = false;
      }
    }

    function scheduleNext() {
      // A cancelled run must not arm another timer. `load()` resolves after this
      // effect's cleanup has already run, so without this check the timer is set
      // *after* cleanup cleared it and polls forever — a second, orphaned poller
      // fetching the stale query for the life of the page.
      if (cancelled) return;
      timer = window.setTimeout(() => {
        if (document.visibilityState === 'visible') void load(false).then(scheduleNext);
        else scheduleNext();
      }, POLL_MS);
    }

    void load(true).then(scheduleNext);

    function onVisible() {
      if (document.visibilityState === 'visible') void load(false);
    }
    document.addEventListener('visibilitychange', onVisible);

    /**
     * Holdings discovery (spec A2b): one bounded tick of the server's Transfer-log
     * scan for this account, on its own cadence, never inside a balance read. Anything
     * it finds joins the account's token set server-side and shows up on the next
     * poll; this hook never blocks on it and ignores its failures.
     */
    let scanTimer: number | undefined;
    async function scan() {
      if (cancelled) return;
      try {
        await fetch(apiUrl(`/api/account/tokens/scan?address=${address}`), { cache: 'no-store' });
      } catch {
        // The next tick tries again; the balance poll is unaffected.
      }
      if (!cancelled) scanTimer = window.setTimeout(() => void scan(), SCAN_MS);
    }
    void scan();

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      if (scanTimer !== undefined) window.clearTimeout(scanTimer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [address, nonce, baseToken?.address, baseToken?.decimals]);

  return { ...state, refresh, applyConfirmedFill };
}
