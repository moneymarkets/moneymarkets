/**
 * Which tokens Kuru's MarginAccount actually holds (owner item 3, 2026-09-29).
 *
 * Before this file, the Move sheet decided "Kuru does not hold this token" from the
 * same predicate that decides whether *this sheet's own mechanism* (permit, or the
 * D2 approve-deposit-revoke triple) can move a token in, and that predicate refuses
 * native MON outright, because neither mechanism can sign for a native asset (no
 * `permit()`, no `approve()`). That made the sheet tell the user MarginAccount does
 * not hold MON, which is false: MON is the base asset of MON/USDC and the quote
 * asset of emo/MON, both live markets, and MarginAccount holds it.
 *
 * The accepted set is native MON, always, plus whatever address the live markets
 * name as a base or quote asset, the caller's own runtime set (from
 * `useTokenRegistry`'s registry read, itself built from the live market list; see
 * `kuruTradedTokens`), never a hardcoded symbol list.
 */

export const NATIVE_MON = '0x0000000000000000000000000000000000000000';

/**
 * Does Kuru's MarginAccount hold this token? `kuruMarketAddresses` is the caller's
 * own runtime set of live markets' base and quote token addresses (lowercased) , 
 * native MON is accepted even when it is not itself in that set.
 */
export function acceptedByMarginAccount(
  tokenAddress: string,
  kuruMarketAddresses: ReadonlySet<string>,
): boolean {
  const key = tokenAddress.toLowerCase();
  return key === NATIVE_MON || kuruMarketAddresses.has(key);
}

/**
 * Whether the Move-in "swap it first" notice applies, to the currently selected
 * token only, never a list. The signature is the guarantee: there is nothing here
 * to iterate, only the one token the user has actually selected.
 */
export function moveInSwapFirstNotice(
  selected: { readonly address: string } | undefined,
  kuruMarketAddresses: ReadonlySet<string>,
): boolean {
  if (!selected) return false;
  return !acceptedByMarginAccount(selected.address, kuruMarketAddresses);
}
