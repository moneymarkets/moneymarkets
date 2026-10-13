import type { Address } from 'viem';
import type { TokenAmount, WalletTokenEntry } from '../useAccountBalances';

/**
 * The one holdings model every screen reads (spec A2d, A3, E2): pure functions over
 * `AccountBalances.tokens[]`, so Home, Wallet, Portfolio, Send, Withdraw and the Move
 * sheet all answer "what does this account hold" the same way, and no screen keeps a
 * token list of its own.
 */

export function tokenByAddress(
  tokens: readonly WalletTokenEntry[],
  address: Address | string,
): WalletTokenEntry | undefined {
  const key = address.toLowerCase();
  return tokens.find((t) => t.address.toLowerCase() === key);
}

/** Transitional: rows written before tokens carried an address still name a symbol. */
export function tokenBySymbol(tokens: readonly WalletTokenEntry[], symbol: string): WalletTokenEntry | undefined {
  return tokens.find((t) => t.symbol === symbol);
}

export function walletHoldings(tokens: readonly WalletTokenEntry[]): WalletTokenEntry[] {
  return tokens.filter((t) => t.wallet.value > 0n);
}

export function marginHoldings(tokens: readonly WalletTokenEntry[]): WalletTokenEntry[] {
  return tokens.filter((t) => t.margin.value > 0n);
}

/** Any wallet balance at all, of any token: the "nothing waiting" gate. */
export function walletHasFunds(tokens: readonly WalletTokenEntry[]): boolean {
  return tokens.some((t) => t.wallet.value > 0n);
}

export interface ListedSplit {
  readonly listed: WalletTokenEntry[];
  readonly unlisted: WalletTokenEntry[];
}

/** Listed by at least one registry source, or by none (spec A3's "Unlisted tokens"). */
export function splitListed(tokens: readonly WalletTokenEntry[]): ListedSplit {
  const listed: WalletTokenEntry[] = [];
  const unlisted: WalletTokenEntry[] = [];
  for (const t of tokens) (t.listed ? listed : unlisted).push(t);
  return { listed, unlisted };
}

export interface UnlistedRow {
  readonly symbol: string;
  readonly address: Address;
  readonly wallet: TokenAmount;
  readonly margin: TokenAmount;
}

export interface UnlistedGroupState {
  readonly count: number;
  /** Collapsed by default while "Hide unlisted" is on; a tap opens it for the session. */
  readonly collapsed: boolean;
  readonly rows: readonly UnlistedRow[];
}

/** What the collapsed group shows, as data: only non-zero holdings no list names. */
export function unlistedGroupState(
  tokens: readonly WalletTokenEntry[],
  prefs: { readonly hideUnlisted: boolean },
): UnlistedGroupState {
  const rows = splitListed(tokens)
    .unlisted.filter((t) => t.wallet.value > 0n || t.margin.value > 0n)
    .map((t) => ({ symbol: t.symbol, address: t.address, wallet: t.wallet, margin: t.margin }));
  return { count: rows.length, collapsed: prefs.hideUnlisted, rows };
}

export interface PricedTotal {
  /** Six-decimal dollars, summing only rows with a price. */
  readonly totalUsd: bigint;
  /** Non-zero holdings with no price: the total excludes them and the screen says so. */
  readonly unpricedCount: number;
}

export function pricedTotal(tokens: readonly WalletTokenEntry[]): PricedTotal {
  let totalUsd = 0n;
  let unpricedCount = 0;
  for (const t of tokens) {
    const held = t.wallet.value > 0n || t.margin.value > 0n;
    if (!held) continue;
    if (t.usd.total) totalUsd += t.usd.total.value;
    else unpricedCount += 1;
  }
  return { totalUsd, unpricedCount };
}
