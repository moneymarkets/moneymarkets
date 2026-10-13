import { formatMoney } from '../format';

/**
 * How the funding card writes a fee and a slippage figure.
 *
 * Both live here rather than inside the screen because both were wrong on the screen
 * and neither was testable there.
 *
 * ## The fee is money
 *
 * Design section 6: basis points are not consumer copy. And on `/fund` they were not
 * even the right basis points — the model subtracted base units of the origin asset
 * from base units of the destination asset, so a one-dollar SOL deposit that costs
 * about 1% rendered as "9000 bps". `core`'s `quoteEconomics` now gives an exact unit
 * fee when the two sides really are the same asset and a USD figure otherwise, and
 * this turns whichever exists into a currency string. When the network publishes
 * neither, the card says the fee is inside the amount rather than printing a number
 * nobody computed.
 *
 * ## Slippage is a ratio, and stays one
 *
 * `amountOut` and `minAmountOut` are both the destination asset, so their ratio is
 * exact. A percentage with one decimal is how a person reads it.
 */

export interface FeeShape {
  /** Exact fee in destination base units. Null unless origin and destination are one asset. */
  readonly feeExact: bigint | null;
  /** Total cost in USD base units (6dp). Null when the network omitted its USD figures. */
  readonly feeUsd: bigint | null;
  readonly destination: { readonly symbol: string; readonly decimals: number };
}

/** USD figures are carried at six decimal places; four is what a fee needs. */
export const USD_DISPLAY_DECIMALS = 6;

export function feeLine(quote: FeeShape): string {
  if (quote.feeExact !== null) {
    return `${formatMoney(quote.feeExact, quote.destination.decimals, 4)} ${quote.destination.symbol}`;
  }
  if (quote.feeUsd !== null) {
    return `$${formatMoney(quote.feeUsd, USD_DISPLAY_DECIMALS, 4)}`;
  }
  return 'Included in the amount below';
}

/**
 * Basis points to a percentage with one decimal. 100 bps is 1.0%.
 *
 * Integer until the decimal point is drawn (rule A2.6): dividing by ten gives tenths
 * of a percent, and the tenths are split into the two sides of the point.
 */
export function percent(bps: bigint): string {
  const tenths = bps / 10n;
  return `${tenths / 10n}.${tenths % 10n}%`;
}

/**
 * The live state a probed route shows on its /fund tile.
 *
 * The wire shape mirrors `lib/server/probe.ts`'s `RouteProbe`. **No minimum appears
 * here.** The tile says whether the route is answering, never what the user is
 * allowed to type — removed at the owner's instruction, 2026-09-09, after a cached
 * floor blocked amounts the network would have priced. The network's own sentence is
 * still rendered verbatim beneath the grid.
 */
export interface WireRouteProbe {
  readonly state: 'available' | 'unavailable' | 'unprobed';
  readonly message?: string;
  readonly at?: number;
}

export function routeStateLine(probe: WireRouteProbe | undefined): string | undefined {
  if (probe?.state === 'unavailable') return 'Declined by the solver network right now';
  return undefined;
}
