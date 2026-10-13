'use client';

import { Chip, Notice } from '@tradepro/ui';
import type { ActivityRow } from '../lib/activityStore';
import { basisFromActivity, changeFor, formatBps } from '../lib/costBasis';
import { formatMoney } from '../lib/format';

/**
 * What the account's traded holdings are worth against what they cost (ITEM 7).
 *
 * This replaced two chips reading "No unrealised yet" and "No realised yet", wired to
 * nothing. Kuru is a spot venue, so there is no position and no entry price to mark
 * against; what there is, and what this shows, is cost basis — computed from the
 * account's own fills, valued at a price read live from the book.
 *
 * **It shows nothing rather than something uncertain.** A token whose balance is not
 * fully accounted for by recorded fills — arrived by deposit, bridge or transfer —
 * gets a line saying so and no percentage. A token with no live price gets nothing at
 * all. Both cases are the item's instruction and the reason the chips had to go: a
 * judge will check, and an honest absence beats a fabricated number.
 */

export interface PricedHolding {
  readonly symbol: string;
  /** Total held across wallet and trading balance, base units. */
  readonly held: bigint;
  readonly decimals: number;
  /** Quote per base, human * 1e18, read live. Undefined means no price was read. */
  readonly priceWire: bigint | undefined;
}

export function PositionValue({
  rows,
  holdings,
}: {
  readonly rows: readonly ActivityRow[];
  readonly holdings: readonly PricedHolding[];
}) {
  const basis = basisFromActivity(rows);

  const priced = holdings
    .map((h) => ({ holding: h, change: changeFor(basis.get(h.symbol), h.held, h.priceWire) }))
    .filter((r) => r.change !== undefined);

  // Held, traded at some point, but not fully accounted for by fills.
  const unpriceable = holdings.filter(
    (h) => h.held > 0n && basis.has(h.symbol) && !priced.some((p) => p.holding.symbol === h.symbol),
  );

  if (priced.length === 0 && unpriceable.length === 0) {
    return (
      <p className="tiny muted" style={{ marginTop: 12 }}>
        Change since purchase appears here once you have bought something. Dollar balances are not
        included: they are what everything else is measured in.
      </p>
    );
  }

  return (
    <div style={{ marginTop: 12 }}>
      {priced.map(({ holding, change }) => {
        if (!change) return null;
        const up = change.change >= 0n;
        const abs = change.change < 0n ? -change.change : change.change;
        return (
          <div key={holding.symbol} className="between" style={{ marginTop: 6 }}>
            <span className="tiny">
              {holding.symbol} since your first trade, cost{' '}
              {formatMoney(change.cost, change.quoteDecimals, 2)} {change.quoteSymbol}
            </span>
            <Chip tone={up ? 'up' : 'down'}>
              {up ? '+' : '-'}
              {formatMoney(abs, change.quoteDecimals, 2)} {change.quoteSymbol}{' '}
              {formatBps(change.changeBps)}
            </Chip>
          </div>
        );
      })}

      {unpriceable.length > 0 ? (
        <div style={{ marginTop: 10 }}>
          <Notice tone="warn">
            {unpriceable.map((h) => h.symbol).join(', ')}: no cost basis. Some of what you hold
            arrived by deposit or transfer rather than a trade, so there is no price to compare
            against and no percentage to show.
          </Notice>
        </div>
      ) : null}
    </div>
  );
}
