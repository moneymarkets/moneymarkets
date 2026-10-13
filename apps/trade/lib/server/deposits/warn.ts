import { USD_DECIMALS } from '@tradepro/core';
import { depositDb } from './db';

/**
 * "Below the amount at which our last N attempts refunded, warn" (D105 item 4).
 *
 * The threshold is evidence, not a constant: the largest amount actually refunded in
 * the last `sampleSize` attempts on this route. Until a route has refund evidence,
 * there is **no** threshold and no warning — the earlier $5 default was a number this
 * app invented, and the error-handling rule of 2026-09-08 removes every invented
 * stand-in for something an API can say itself. Route minimums now come from the
 * solver network's own refusals (`lib/server/limits.ts`) and are shown on the source
 * tiles before the user types.
 */
const SAMPLE_SIZE = 20;

export interface WarningThreshold {
  readonly usd: bigint;
  readonly sampleSize: number;
}

export function warningThreshold(sourceKey: string): WarningThreshold | undefined {
  const amounts = depositDb().recentRefundedUsdAmounts(sourceKey, SAMPLE_SIZE);
  if (amounts.length === 0) return undefined;
  const max = amounts.reduce((a, b) => (b > a ? b : a));
  return { usd: max, sampleSize: amounts.length };
}

export function formatUsd(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const s = abs.toString().padStart(USD_DECIMALS + 1, '0');
  const whole = s.slice(0, -USD_DECIMALS);
  const cents = s.slice(-USD_DECIMALS, -USD_DECIMALS + 2);
  return `${negative ? '-' : ''}$${whole}.${cents}`;
}
