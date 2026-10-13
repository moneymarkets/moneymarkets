import { isAddress } from 'viem';
import type { WalletTokenEntry } from '../useAccountBalances';
import type { RegistryToken } from '../useTokenRegistry';

/**
 * The token selector's pure model (v2.1 spec 2.2): one merged, searchable list over
 * the account's balances and the whole registry, held tokens first, then the rest of
 * the registry. Shared by Swap, Send and the Move sheet, so all three answer the
 * same question the same way. No fetching here — the component supplies the two
 * inputs it already has — and no fabricated fields: a token's USD value renders only
 * where the balances body priced it, and a registry token the account does not hold
 * shows no balance line at all rather than a made-up zero price.
 */

export interface SelectorRow {
  readonly address: string;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly iconUrl: string | null;
  /** Named by at least one registry source; false renders the unverified chip. */
  readonly listed: boolean;
  /** Base units held, split by location; 0n when the account holds none. */
  readonly walletValue: bigint;
  readonly marginValue: bigint;
  /** The held quantity's USD value, when the balances body priced it. */
  readonly usdValue?: { readonly value: bigint; readonly decimals: number };
}

export interface SelectorList {
  /** Tokens the account holds (wallet or trading balance), largest USD first. */
  readonly held: readonly SelectorRow[];
  /** The rest of the registry, alphabetical by symbol. */
  readonly rest: readonly SelectorRow[];
  /** Set when the query is a full contract address not already in the list. */
  readonly pastedAddress?: string;
}

const NATIVE = '0x0000000000000000000000000000000000000000';

function rowFromBalance(t: WalletTokenEntry): SelectorRow {
  return {
    address: t.address,
    symbol: t.symbol,
    name: t.name,
    decimals: t.decimals,
    iconUrl: t.iconUrl,
    listed: t.listed,
    walletValue: t.wallet.value,
    marginValue: t.margin.value,
    ...(t.usd.total ? { usdValue: { value: t.usd.total.value, decimals: t.usd.total.decimals } } : {}),
  };
}

function rowFromRegistry(t: RegistryToken): SelectorRow {
  return {
    address: t.address,
    symbol: t.symbol,
    name: t.name,
    decimals: t.decimals,
    iconUrl: t.logoUrl ?? null,
    listed: true,
    walletValue: 0n,
    marginValue: 0n,
  };
}

function usdOf(r: SelectorRow): bigint {
  return r.usdValue ? r.usdValue.value : 0n;
}

export function selectorList(input: {
  readonly tokens: readonly WalletTokenEntry[];
  readonly registry: readonly RegistryToken[];
  readonly query: string;
  /** Leave native MON out (Send: it cannot leave a delegated account). */
  readonly excludeNative?: boolean;
  /** Keep only rows this predicate accepts (Move in: Kuru-traded only). */
  readonly accept?: (row: SelectorRow) => boolean;
}): SelectorList {
  const q = input.query.trim().toLowerCase();

  const byAddress = new Map<string, SelectorRow>();
  for (const t of input.registry) {
    byAddress.set(t.address.toLowerCase(), rowFromRegistry(t));
  }
  // Balance rows win: they carry the held quantities, the price, and the honest
  // `listed` flag for tokens no registry source names.
  for (const t of input.tokens) {
    byAddress.set(t.address.toLowerCase(), rowFromBalance(t));
  }

  let rows = [...byAddress.values()];
  if (input.excludeNative) rows = rows.filter((r) => r.address.toLowerCase() !== NATIVE);
  if (input.accept) rows = rows.filter(input.accept);

  const matches = (r: SelectorRow) =>
    q === '' ||
    r.symbol.toLowerCase().includes(q) ||
    r.name.toLowerCase().includes(q) ||
    r.address.toLowerCase() === q;

  const held = rows
    .filter((r) => (r.walletValue > 0n || r.marginValue > 0n) && matches(r))
    .sort((a, b) => (usdOf(b) > usdOf(a) ? 1 : usdOf(b) < usdOf(a) ? -1 : a.symbol.localeCompare(b.symbol)));
  const rest = rows
    .filter((r) => r.walletValue === 0n && r.marginValue === 0n && matches(r))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));

  const pasted =
    isAddress(input.query.trim()) &&
    !byAddress.has(input.query.trim().toLowerCase())
      ? input.query.trim()
      : undefined;

  return { held, rest, ...(pasted ? { pastedAddress: pasted } : {}) };
}
