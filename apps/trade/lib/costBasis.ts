'use client';

import type { ActivityRow } from './activityStore';

/**
 * Cost basis, from this account's own fills and nothing else (ITEM 7).
 *
 * ## Why the requirement had to change first
 *
 * US-6 AC1 asked for "unrealised and realised PnL" without defining a position, and
 * Kuru is a **spot** venue — there are no positions, no entry price, nothing to mark
 * against. So the screen shipped two chips reading "No unrealised yet" and "No
 * realised yet", wired to nothing, which is a fabricated number with the number left
 * out. This computes the thing that is actually true of a spot account: what was paid
 * for what is held.
 *
 * ## Weighted average, and what happens on a sell
 *
 * Buys add to both the quantity held and the amount paid. A sell removes quantity at
 * the *average* cost, leaving the average unchanged — the standard weighted-average
 * treatment, chosen over FIFO because FIFO needs a per-lot history this app does not
 * have and would produce a different answer while looking equally confident.
 *
 * ## Where it refuses to answer
 *
 * A holding is only given a basis when the recorded fills account for **all** of it.
 * Tokens arrive by deposit, bridge and transfer as well as by trading, and those
 * arrivals have no price — so an account holding 10 USDC of which 2 came from a fill
 * has a basis for 2 and no honest basis for 10. Rather than quietly pricing the
 * other 8 at zero (which would invent a profit) or at par (which would invent a
 * price), `basisFor` returns `undefined` and the row says "no cost basis" and shows
 * no percentage. That is the item's own instruction, and it is the whole point:
 * an honest absence beats a fabricated number.
 *
 * Everything is bigint. The percentage is computed in basis points and only becomes
 * a float at the moment it is rendered.
 */

export interface TokenBasis {
  readonly symbol: string;
  readonly decimals: number;
  /** Base units still held according to the fills — buys minus sells. */
  readonly quantity: bigint;
  /** What that quantity cost, in quote base units. */
  readonly cost: bigint;
  /** The quote asset the cost is denominated in. Mixed quotes are refused; see below. */
  readonly quoteSymbol: string;
  readonly quoteDecimals: number;
  /** When the first fill in this basis happened. "Since your first trade" means this. */
  readonly firstAt: number;
}

/**
 * Build a basis per base token from the activity rows that carry both sides.
 *
 * Rows without a `trade` block are skipped rather than guessed at — a row recorded
 * before this app knew to keep both sides, or an order that rested without filling.
 */
export function basisFromActivity(rows: readonly ActivityRow[]): Map<string, TokenBasis> {
  const out = new Map<string, TokenBasis>();

  // Oldest first, so a sell can never precede the buy it draws down.
  const fills = rows.filter((r) => r.trade !== undefined).sort((a, b) => a.at - b.at);

  for (const row of fills) {
    const t = row.trade;
    if (!t) continue;
    const base = BigInt(t.baseAmount);
    const quote = BigInt(t.quoteAmount);
    if (base <= 0n) continue;

    const existing = out.get(t.baseSymbol);
    if (!existing) {
      // A first fill that is a sell means the token was acquired some other way, so
      // there is no basis to draw down and starting one here would invent it.
      if (t.side === 'sell') continue;
      out.set(t.baseSymbol, {
        symbol: t.baseSymbol,
        decimals: t.baseDecimals,
        quantity: base,
        cost: quote,
        quoteSymbol: t.quoteSymbol,
        quoteDecimals: t.quoteDecimals,
        firstAt: row.at,
      });
      continue;
    }

    /**
     * Two quote assets for one base token is a question this cannot answer.
     *
     * MON trades against both AUSD and USDC here. Adding a USDC cost to an AUSD cost
     * would be arithmetic on two different units that happen to both be near a
     * dollar, and "near a dollar" is a price, not an identity — converting would need
     * the rate at the time of each fill, which is not recorded. So the basis is
     * dropped entirely and the holding reports no basis, rather than reporting one
     * built on a conversion nobody measured.
     */
    if (existing.quoteSymbol !== t.quoteSymbol) {
      out.delete(t.baseSymbol);
      continue;
    }

    if (t.side === 'buy') {
      out.set(t.baseSymbol, {
        ...existing,
        quantity: existing.quantity + base,
        cost: existing.cost + quote,
      });
    } else {
      // Sell at the running average: quantity falls, the average per unit does not.
      const sold = base > existing.quantity ? existing.quantity : base;
      const costOut = existing.quantity === 0n ? 0n : (existing.cost * sold) / existing.quantity;
      out.set(t.baseSymbol, {
        ...existing,
        quantity: existing.quantity - sold,
        cost: existing.cost - costOut,
      });
    }
  }

  // A basis for nothing is not a basis.
  for (const [symbol, basis] of out) {
    if (basis.quantity <= 0n) out.delete(symbol);
  }
  return out;
}

export interface HoldingChange {
  readonly cost: bigint;
  readonly value: bigint;
  readonly change: bigint;
  /** Basis points, signed. 250 is +2.50%. */
  readonly changeBps: bigint;
  readonly quoteSymbol: string;
  readonly quoteDecimals: number;
  readonly firstAt: number;
}

/**
 * Value a holding against a basis, at a price the caller read live.
 *
 * `held` is the account's real balance across both locations. It must be fully
 * accounted for by the basis or this returns `undefined` — see the header. The
 * tolerance is exact: an account whose fills account for 0.999 of what it holds has
 * a holding that came from somewhere else, and the honest answer is that we cannot
 * price it.
 *
 * `priceWire` is human * 1e18 of quote per base, from the live book. There is no
 * fallback price and no default: without one there is no value, and no change.
 */
export function changeFor(
  basis: TokenBasis | undefined,
  held: bigint,
  priceWire: bigint | undefined,
): HoldingChange | undefined {
  if (!basis || priceWire === undefined || priceWire <= 0n) return undefined;
  if (held <= 0n) return undefined;
  // Fills must cover the whole holding. More recorded than held is fine — a send or
  // a withdrawal moved some out — but less means part of it arrived unpriced.
  if (basis.quantity < held) return undefined;

  const baseScale = 10n ** BigInt(basis.decimals);
  const quoteScale = 10n ** BigInt(basis.quoteDecimals);
  const value = (held * priceWire * quoteScale) / (baseScale * 10n ** 18n);
  // The cost of exactly the quantity still held, at the running average.
  const cost = (basis.cost * held) / basis.quantity;
  const change = value - cost;
  return {
    cost,
    value,
    change,
    changeBps: cost === 0n ? 0n : (change * 10_000n) / cost,
    quoteSymbol: basis.quoteSymbol,
    quoteDecimals: basis.quoteDecimals,
    firstAt: basis.firstAt,
  };
}

/** Basis points to a signed percentage string, two decimals. Display only. */
export function formatBps(bps: bigint): string {
  const sign = bps < 0n ? '-' : '+';
  const abs = bps < 0n ? -bps : bps;
  return `${sign}${(Number(abs) / 100).toFixed(2)}%`;
}
