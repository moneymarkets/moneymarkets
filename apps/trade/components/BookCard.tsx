'use client';

import { useEffect, useRef, useState } from 'react';
import { Card, Chip, Notice, Skeleton, type BookLevel } from '@tradepro/ui';
import type { Book, MarketParams } from '@tradepro/core';
import { failure, withDetail } from '../lib/failures';
import { formatPrice, formatSize, formatSpreadBps } from '../lib/format';
import { FailureNotice } from './FailureNotice';
import type { FeedStatus } from '../lib/useMarketData';
import type { VenueReading } from '../lib/server/venueState';

/**
 * The order book (design §5.4, redesign trade-head/trade-grid).
 *
 * Six levels a side, asks above the mid and spread, bids below (redesign layout —
 * the book used to run bids-left/asks-right; same two values per level, same
 * invariant-driven `dim` state, just stacked instead of side by side). The `dim`
 * state and the notice under it are driven by invariants I1 (crossed) and I6
 * (stale) as decided by `@tradepro/core` — this component does not re-derive
 * either, it renders what it is told and says why.
 *
 * A Normal / Stale / Crossed preview control used to sit on this card. It was removed
 * on 2026-09-10 — see the note in the component body for what it cost.
 *
 * Rendered by hand rather than through `@tradepro/ui`'s `OrderBook`: that component
 * has no hook for "this row's price or size just changed", which the redesign brief
 * asks for ("a row only flashes when its real data actually changes"), and it is not
 * this file's place to add one to a shared component. Same class names
 * (`.book`/`.side`/`.lvl`), same two cells a row, same depth-bar math — just drawn
 * here so a changed level can carry a one-off `flash` class.
 */

function cx(...parts: (string | false | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export const LEVELS = 6;

export function priceDecimals(params: MarketParams): number {
  const ticksPerUnit = params.pricePrecision / (params.tickSize === 0n ? 1n : params.tickSize);
  return Math.max(2, Math.min(8, ticksPerUnit.toString().length - 1));
}

interface KeyedLevel {
  key: string;
  level: BookLevel;
}

function levels(
  side: readonly { price: bigint; size: bigint }[],
  params: MarketParams,
  max: bigint,
  keyPrefix: 'bid' | 'ask',
): KeyedLevel[] {
  const dp = priceDecimals(params);
  const one = 10n ** BigInt(params.baseDecimals);
  return side.slice(0, LEVELS).map((level, i) => ({
    key: `${keyPrefix}-${i}`,
    level: {
      price: formatPrice(level.price, dp),
      // A level smaller than one whole unit is real — the AMM vault leaves dust on the
      // AUSD books — so it gets decimals rather than being rounded to a misleading 0.
      size: formatSize(level.size, params.baseDecimals, level.size < one ? 4 : 0),
      depth: max === 0n ? 0 : Number((level.size * 1000n) / max) / 1000,
    },
  }));
}

/**
 * Which rows changed since the last render, by their `${side}-${index}` key.
 *
 * Compared on the raw bigints the feed returned, not the formatted strings — the
 * same real-data check the redesign brief asks for ("no fake ticking"). Nothing is
 * marked changed on the first read a `book` ever arrives with: `prev` starts empty,
 * so that pass only records a baseline. Every row that did change flashes for 900ms
 * (`prefers-reduced-motion` already collapses this globally) and then the set is
 * cleared, same one-shot shape as the holdings `.row.flash` this reuses the keyframe
 * from.
 */
function useChangedLevels(book: Book | undefined): ReadonlySet<string> {
  const prev = useRef<Map<string, { price: bigint; size: bigint }>>(new Map());
  const [changed, setChanged] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (!book) return undefined;
    const next = new Map<string, { price: bigint; size: bigint }>();
    const diffs: string[] = [];

    function track(side: 'bid' | 'ask', rows: readonly { price: bigint; size: bigint }[]) {
      rows.slice(0, LEVELS).forEach((row, i) => {
        const key = `${side}-${i}`;
        const prior = prev.current.get(key);
        if (prior && (prior.price !== row.price || prior.size !== row.size)) diffs.push(key);
        next.set(key, { price: row.price, size: row.size });
      });
    }
    track('bid', book.bids);
    track('ask', book.asks);
    prev.current = next;

    if (diffs.length === 0) return undefined;
    setChanged(new Set(diffs));
    const timer = window.setTimeout(() => setChanged(new Set()), 900);
    return () => window.clearTimeout(timer);
  }, [book]);

  return changed;
}

function Row({ item, side, flashing }: { item: KeyedLevel; side: 'bid' | 'ask'; flashing: boolean }) {
  return (
    <div className={cx('lvl', side, flashing && 'flash')}>
      <span className="bar" style={{ width: `${item.level.depth * 100}%` }} />
      <span className="px num">{item.level.price}</span>
      <span className="num muted">{item.level.size}</span>
    </div>
  );
}

export interface BookCardProps {
  book?: Book;
  params?: MarketParams;
  status: FeedStatus;
  mid?: bigint;
  spread?: bigint;
  error?: string;
  /** The venue probe's own reading, so the card can show what Kuru answered. */
  venue?: VenueReading;
}

export function BookCard({
  book,
  params,
  status,
  mid,
  spread,
  error,
  venue,
}: BookCardProps) {
  /**
   * There is no book-state preview control here any more, and there must not be one.
   *
   * A `Normal / Stale / Crossed` segmented control sat on this card **in production**.
   * Choosing "Crossed" swapped `bestBid` and `bestAsk` before normalisation, so I1
   * fired and the ticket disabled itself with "bid at or above the best ask" — on a
   * book whose real bid was 0.023356 against a real ask of 0.023368. The owner hit it
   * on 2026-09-10 and reasonably read it as a bug in the invariant.
   *
   * The invariant was right; it was handed falsified data by a control that should
   * never have been reachable from a live screen. Fabricating invalid market state is
   * a test concern, and the tests own it — the crossed fixture from `MON_AUSD_V4_5`
   * and the sentinel cases are unit tests in `packages/core/src/kuru/book.test.ts`,
   * where they cannot be triggered by a fingertip on a real market. See D143.
   */

  const changed = useChangedLevels(book);

  if (status === 'loading') {
    return (
      <Card title="Order book">
        <Skeleton rows={6} />
      </Card>
    );
  }

  if (status === 'error' || !book || !params) {
    return (
      <Card title="Order book">
        {error ? (
          <div style={{ marginTop: 10 }}>
            <Notice tone="err">{error}</Notice>
          </div>
        ) : (
          <FailureNotice failure={failure('RPC_UNAVAILABLE')} />
        )}
      </Card>
    );
  }

  /**
   * Kuru's own answer to the probe, verbatim (item 1c).
   *
   * Shown whenever the probe got a decodable revert — including the cases we
   * deliberately do NOT call a pause — so the reading can be checked against what the
   * venue actually said rather than taken on trust.
   */
  const venueNote = venue?.probeSelector
    ? `Venue probe: ${venue.probeCall ?? 'market buy'} answered ${venue.probeError ?? 'an unknown error'} (${venue.probeSelector}). Read as "${venue.state}".`
    : undefined;

  const shown = [...book.bids.slice(0, LEVELS), ...book.asks.slice(0, LEVELS)];
  const max = shown.reduce((acc, level) => (level.size > acc ? level.size : acc), 0n);
  const dim = status !== 'live';
  const dp = priceDecimals(params);

  const bids = levels(book.bids, params, max, 'bid');
  // Worst-to-best top to bottom, so the best ask lands next to the mid — the same
  // "closest to the middle is the best price" reading a horizontal book gives, just
  // stacked (redesign: asks above the mid, bids below).
  const asks = [...levels(book.asks, params, max, 'ask')].reverse();

  return (
    <Card title="Order book">
      {book.bids.length === 0 && book.asks.length === 0 ? (
        <FailureNotice failure={failure('BOOK_EMPTY')} />
      ) : (
        <div className={cx('book', dim && 'dim')} style={{ marginTop: 8 }}>
          <div className="side">
            {asks.map((item) => (
              <Row key={item.key} item={item} side="ask" flashing={changed.has(item.key)} />
            ))}
          </div>
          <div className="mid num">{mid === undefined ? 'No price' : formatPrice(mid, dp)}</div>
          {/* "No spread" rather than a dash. The book is dimmed in this state anyway,
              and a dash reads as a value that happens to be missing rather than as a
              book with nothing resting on it. */}
          <div className="spread num">
            {dim || spread === undefined ? 'No spread' : formatSpreadBps(spread)}
          </div>
          <div className="side">
            {bids.map((item) => (
              <Row key={item.key} item={item} side="bid" flashing={changed.has(item.key)} />
            ))}
          </div>
        </div>
      )}

      {status === 'paused' ? <FailureNotice failure={failure('BOOK_STALE')} /> : null}
      {/* Item 1d: name the check that failed and the values that failed it, so a
          false positive is visible rather than mysterious. */}
      {status === 'invalid' ? (
        <FailureNotice
          failure={
            book.invalidReason
              ? withDetail(failure('BOOK_CROSSED'), book.invalidReason)
              : failure('BOOK_CROSSED')
          }
        />
      ) : null}
      {venueNote ? (
        <p className="tiny muted" style={{ marginTop: 8 }}>
          {venueNote}
        </p>
      ) : null}
    </Card>
  );
}

export function FeedChip({ status }: { status: FeedStatus }) {
  if (status === 'loading') return <Chip>Loading prices</Chip>;
  // The chip stays short; the reason with its values is rendered beside the book.
  if (status === 'invalid') return <Chip tone="down">Market data invalid</Chip>;
  if (status === 'paused') return <Chip tone="warn">Data paused</Chip>;
  if (status === 'error') return <Chip tone="down">Prices unavailable</Chip>;
  return <Chip tone="up">Live, finalized</Chip>;
}
