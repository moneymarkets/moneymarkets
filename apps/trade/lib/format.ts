import { formatUnits, monad, WIRE_PRICE_SCALE } from '@tradepro/core';

/**
 * Display formatting only. Every value that arrives here is already a `bigint`; the
 * floats below never travel back into a calculation (rule A2.6).
 *
 * Tabular figures and no monospace are the design system's rules (§2.2), so nothing
 * here pads with spaces or picks a font.
 */

/**
 * A USDC-like amount, converted to its AUSD equivalent at the live AUSD/USDC mid.
 *
 * The one formula behind every "value in AUSD" figure on the app — Home's "Available
 * to trade," Portfolio's "Total value," the Settings account list — so that a change
 * to how the conversion rounds changes it everywhere at once, not in three
 * hand-written copies that can drift (item 2d: the same fixture must produce the
 * same number on every screen).
 *
 * `mid` is `undefined` while the read is still loading and `null` when the book has
 * no resting price on either side. **Neither is priced at par (audit U5 / Section
 * 1).** A 1:1 fallback used to be invented and folded silently into a total the
 * screen rendered as a plain number — no "≈", no note, nothing distinguishing a real
 * quote from a guess. Both cases now return `undefined`: "this amount could not be
 * priced," not "assume it is worth exactly what it says." A zero amount is always
 * `0n` regardless of the mid — there is nothing to price, so nothing is uncertain.
 */
export function toAusdEquivalent(
  amountUsdcLike: bigint,
  mid: bigint | null | undefined,
): bigint | undefined {
  if (amountUsdcLike === 0n) return 0n;
  if (mid === null || mid === undefined) return undefined;
  return (amountUsdcLike * mid) / WIRE_PRICE_SCALE;
}

/**
 * The reverse of `toAusdEquivalent`: an AUSD-like amount, converted to its USDC
 * equivalent at the same live AUSD/USDC mid.
 *
 * Home's hero shows the trading balance in USDC — AUSD is not an order-book asset any
 * of the four tradable markets is quoted in, so USDC is what "available to trade"
 * actually means on this venue — with the AUSD-equivalent total (`toAusdEquivalent`)
 * shown beneath it. Same honesty rule as the function it mirrors: `undefined` while
 * the mid has not loaded or the book has no resting price on either side, never a
 * fabricated par value. A zero amount is always `0n`.
 */
export function toUsdcEquivalent(
  amountAusdLike: bigint,
  mid: bigint | null | undefined,
): bigint | undefined {
  if (amountAusdLike === 0n) return 0n;
  if (mid === null || mid === undefined || mid <= 0n) return undefined;
  return (amountAusdLike * WIRE_PRICE_SCALE) / mid;
}

/**
 * Add up a total that includes one or more `toAusdEquivalent`/`toUsdcEquivalent`
 * results. `undefined` if any part is — a total that silently dropped the unpriced
 * part would understate a real balance, which R1 rules out exactly as firmly as
 * inventing one would.
 */
export function sumAusd(...parts: readonly (bigint | undefined)[]): bigint | undefined {
  let total = 0n;
  for (const part of parts) {
    if (part === undefined) return undefined;
    total += part;
  }
  return total;
}

/**
 * B8: the most decimal places a human ever sees for one of this app's tokens,
 * whatever the token's own on-chain decimals are.
 *
 * MON, WETH and cbBTC carry 18, 18 and 8 on-chain decimals. A "Max" or percentage-fill
 * button that formats the full balance at its native decimals dumps every one of them
 * into the field — a screenshot this session showed `3.732318142700000000` filled in
 * by a Max tap. `displayDp` is what every amount-prefill in the app now runs its
 * decimal count through; it only ever narrows what a caller asked for, never widens
 * it.
 */
export const DISPLAY_DECIMALS: Record<string, number> = {
  MON: 6,
  WMON: 6,
  WETH: 6,
  USDC: 6,
  AUSD: 6,
  USDT0: 6,
  cbBTC: 8,
  XAUt0: 6,
};

/** Any token the table does not name: its own decimals, but never more than this (spec F2). */
export const DEFAULT_DISPLAY_DECIMALS = 6;

/**
 * Caps a display precision at `DISPLAY_DECIMALS`, or at `DEFAULT_DISPLAY_DECIMALS` for a
 * token the table does not name (spec F2: `min(decimals, 6)`). Only ever narrows what
 * the caller asked for, never widens it.
 */
export function displayDp(symbol: string, decimals: number): number {
  const cap = DISPLAY_DECIMALS[symbol] ?? DEFAULT_DISPLAY_DECIMALS;
  return Math.min(decimals, cap);
}

export function formatMoney(units: bigint, decimals: number, dp = 2): string {
  const raw = formatUnits(units, decimals);
  const [whole = '0', fraction = ''] = raw.split('.');
  const grouped = Number(whole).toLocaleString('en-US');
  return `${grouped}.${fraction.padEnd(dp, '0').slice(0, dp)}`;
}

/** A wire price (human * 1e18) at the precision the market's tick justifies. */
export function formatPrice(priceWire: bigint, dp = 6): string {
  const raw = formatUnits(priceWire, 18);
  const [whole = '0', fraction = ''] = raw.split('.');
  return `${whole}.${fraction.padEnd(dp, '0').slice(0, dp)}`;
}

export function formatSize(sizeBase: bigint, decimals: number, dp = 0): string {
  const raw = formatUnits(sizeBase, decimals);
  const [whole = '0', fraction = ''] = raw.split('.');
  const grouped = Number(whole).toLocaleString('en-US');
  return dp === 0 ? grouped : `${grouped}.${fraction.padEnd(dp, '0').slice(0, dp)}`;
}

/** Spread in parts-per-million to basis points, for the one line under the mid. */
export function formatSpreadBps(pps: bigint): string {
  const bps = Number(pps) / 100;
  return `Spread ${bps.toFixed(bps < 1 ? 2 : 1)} bps`;
}

/** Address for display. Never the only identifier shown, never used for routing. */
export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Human decimal string -> wire price (human * 1e18), without touching a float. */
export function parsePriceWire(input: string): bigint | undefined {
  const s = input.trim();
  if (!/^\d*(\.\d*)?$/.test(s) || s === '' || s === '.') return undefined;
  const [whole = '0', fraction = ''] = s.split('.');
  if (fraction.length > 18) return undefined;
  return BigInt((whole === '' ? '0' : whole) + fraction.padEnd(18, '0'));
}

/** Human decimal string -> base units of a token with `decimals`. */
export function parseAmount(input: string, decimals: number): bigint | undefined {
  const s = input.trim();
  if (!/^\d*(\.\d*)?$/.test(s) || s === '' || s === '.') return undefined;
  const [whole = '0', fraction = ''] = s.split('.');
  if (fraction.length > decimals) return undefined;
  return BigInt((whole === '' ? '0' : whole) + fraction.padEnd(decimals, '0'));
}

/**
 * Quote spend / price -> base size, in base units. All integer: the quote amount is
 * scaled up by the base decimals before the division, so nothing rounds through a
 * float.
 */
export function baseSizeFor(
  quoteAmount: bigint,
  priceWire: bigint,
  quoteDecimals: number,
  baseDecimals: number,
): bigint {
  if (priceWire <= 0n) return 0n;
  return (
    (quoteAmount * WIRE_PRICE_SCALE * 10n ** BigInt(baseDecimals)) /
    (10n ** BigInt(quoteDecimals) * priceWire)
  );
}

/** Base size -> quote notional in quote base units. */
export function quoteNotionalFor(
  sizeBase: bigint,
  priceWire: bigint,
  quoteDecimals: number,
  baseDecimals: number,
): bigint {
  return (
    (sizeBase * priceWire * 10n ** BigInt(quoteDecimals)) /
    (WIRE_PRICE_SCALE * 10n ** BigInt(baseDecimals))
  );
}

/**
 * The explorer page for a transaction.
 *
 * Worth one shared helper because a gasless user cannot find their own trades any
 * other way. Under EIP-7702 the transaction is sent by the **bundler** to the
 * EntryPoint — the user's address is the user operation's `sender`, never the
 * transaction's `from` — so a trade never appears under "Transactions" on their
 * address, and because margin balances are internal accounting inside MarginAccount
 * it may not appear under "Token Transfers" either. The tx hash is the only reliable
 * handle, which is why every screen that knows one now shows it.
 */
export function explorerTxUrl(txHash: string): string {
  return `${monad.blockExplorers.default.url}/tx/${txHash}`;
}
