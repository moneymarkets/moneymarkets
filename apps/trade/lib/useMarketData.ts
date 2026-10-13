'use client';

import { apiUrl } from './basePath';

import { useEffect, useMemo, useState } from 'react';
import {
  isStale,
  isTradable,
  midPrice,
  normalizeBook,
  spreadPps,
  type Book,
  type MarketParams,
  type RawLevel,
} from '@tradepro/core';
import type { Address } from 'viem';
import { failure, failureText } from './failures';

/**
 * Poll one market's book from our own route handler and turn it into a `Book`.
 *
 * The client does the normalizing rather than the server, because the invariants the
 * ticket depends on — I1 crossed, I6 stale — have to be decided next to the ticket
 * and from `@tradepro/core`, not re-implemented in a JSON payload.
 *
 * `receivedAt` is stamped when a poll **succeeds in this tab**. That is what makes
 * I6 mean something: if the route stops answering, or the tab loses the network,
 * nothing updates the stamp and the book greys out after the heartbeat, exactly as
 * it would if a websocket went quiet.
 *
 * ## Which clock the 3 s heartbeat is measured against
 *
 * Against this stamp, and nothing else. `isStale()` in `@tradepro/core` computes
 * `now - book.receivedAt`; the block timestamp never enters the comparison, and this
 * payload does not even carry one — only `blockNumber`, which is displayed and not
 * used for freshness.
 *
 * That distinction is load-bearing at Monad's measured numbers. On 2026-09-02, over
 * fifteen reads of MON/AUSD against `https://rpc.monad.xyz`, the **block age at the
 * moment of reading** was p50 2.7 s, p95 5.0 s — that is finality lag, because the
 * app deliberately reads the finalized tip and labels it so. Comparing that age to a
 * 3 s heartbeat would flip the feed chip between "Live, finalized" and "Data paused"
 * on a completely healthy venue. Measured against arrival in this tab, where the read
 * itself took p50 76 ms and p95 485 ms, a 3 s heartbeat means three consecutive
 * missed polls at `POLL_MS = 1000` — which is a feed that has actually stopped.
 */

export const POLL_MS = 1_000;

export type FeedStatus = 'loading' | 'live' | 'paused' | 'invalid' | 'error';


/**
 * The market's own state, read per market by `/api/market/[market]` — distinct from
 * `status`, which is about the freshness and consistency of the book data. A market
 * can be paused while quoting a perfect two-sided book (AUSD/USDC does), and it can
 * accept every call while having nothing resting on it (MON/AUSD does). Undefined
 * when the probe did not answer: the ticket then falls back to the book invariants
 * rather than claiming a state nobody established.
 */
export interface VenueReading {
  readonly state: 'tradable' | 'paused' | 'empty' | 'one-sided';
  /** The venue's own words, verbatim and source-named (D124). */
  readonly reason?: string;
}

export interface MarketData {
  readonly book?: Book;
  readonly params?: MarketParams;
  readonly status: FeedStatus;
  readonly tradable: boolean;
  readonly venue?: VenueReading;
  readonly mid?: bigint;
  readonly spread?: bigint;
  readonly error?: string;
  readonly blockNumber?: bigint;
  /**
   * The dollar price of one whole unit of this market's quote asset, wire scale — the
   * MON/USDC mid for a market quoted in native MON. Read by the market route alongside
   * the book, so it is exactly as fresh. Undefined for a dollar-quoted market (none is
   * needed) and when the route could not read a usable one; the ticket's cap check then
   * refuses a MON-quoted order rather than guessing its size.
   */
  readonly quoteUsdPrice?: bigint;
}

interface Payload {
  market: string;
  source: string;
  state: string;
  blockNumber: string;
  bestBid: string;
  bestAsk: string;
  bids: [string, string][];
  asks: [string, string][];
  venue?: VenueReading;
  /** Present only for a market whose quote asset is priced; `null` when it was unreadable. */
  quoteUsdPrice?: string | null;
  params: {
    pricePrecision: string;
    sizePrecision: string;
    baseAsset: string;
    baseDecimals: number;
    quoteAsset: string;
    quoteDecimals: number;
    tickSize: string;
    minSize: string;
    maxSize: string;
    takerFeeBps: string;
    makerFeeBps: string;
  };
}

function toParams(p: Payload['params']): MarketParams {
  return {
    pricePrecision: BigInt(p.pricePrecision),
    sizePrecision: BigInt(p.sizePrecision),
    baseAsset: p.baseAsset as Address,
    baseDecimals: p.baseDecimals,
    quoteAsset: p.quoteAsset as Address,
    quoteDecimals: p.quoteDecimals,
    tickSize: BigInt(p.tickSize),
    minSize: BigInt(p.minSize),
    maxSize: BigInt(p.maxSize),
    takerFeeBps: BigInt(p.takerFeeBps),
    makerFeeBps: BigInt(p.makerFeeBps),
  };
}

const toLevels = (rows: [string, string][]): RawLevel[] =>
  rows.map(([price, size]) => ({ price, size }));

export function useMarketData(market: Address): MarketData {
  const [book, setBook] = useState<Book | undefined>();
  const [params, setParams] = useState<MarketParams | undefined>();
  const [venue, setVenue] = useState<VenueReading | undefined>();
  const [quoteUsdPrice, setQuoteUsdPrice] = useState<bigint | undefined>();
  const [error, setError] = useState<string | undefined>();
  // Re-render on a timer so I6 can flip the screen to stale with no new data.
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch(apiUrl(`/api/market/${market}`), { cache: 'no-store' });
        if (!res.ok) {
          if (!cancelled) {
            setError(
              res.status === 404
                ? 'This market is not part of this deployment. Pick one from Home.'
                : failureText(failure('RPC_UNAVAILABLE')),
            );
          }
          return;
        }
        const payload = (await res.json()) as Payload;
        if (cancelled) return;

        const marketParams = toParams(payload.params);
        const bestBid = BigInt(payload.bestBid);
        const bestAsk = BigInt(payload.bestAsk);
        const next = normalizeBook({
          market: payload.market as Address,
          source: 'contract-getL2Book',
          state: 'finalized',
          params: marketParams,
          bids: toLevels(payload.bids),
          asks: toLevels(payload.asks),
          // Verbatim from the payload. Nothing in this file may alter a reading of a
          // real market: a preview mode used to swap these two to demonstrate I1, and
          // on 2026-09-10 it disabled the ticket on a healthy book with "bid at or
          // above the best ask". The invariants are exercised by unit tests against
          // fixtures, where falsified data cannot reach a real market (D143).
          bestBid,
          bestAsk,
          blockNumber: BigInt(payload.blockNumber),
          receivedAt: Date.now(),
        });

        setParams(marketParams);
        setVenue(payload.venue);
        // Set from this payload alone, together with the book it arrived with: a payload
        // without a usable price clears it rather than keeping an earlier one. A poll that
        // fails leaves the book to go stale, which disables the ticket (I6).
        setQuoteUsdPrice(
          typeof payload.quoteUsdPrice === 'string' && /^\d+$/.test(payload.quoteUsdPrice)
            ? BigInt(payload.quoteUsdPrice)
            : undefined,
        );
        setBook(next);
        setError(undefined);
      } catch {
        if (!cancelled) {
          setError(failureText(failure('RPC_UNAVAILABLE')));
        }
      }
    }

    void poll();
    const id = window.setInterval(poll, POLL_MS);
    const beat = window.setInterval(() => setTick((n) => n + 1), 500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      window.clearInterval(beat);
    };
  }, [market]);

  return useMemo<MarketData>(() => {
    if (!book) {
      return {
        status: error ? 'error' : 'loading',
        tradable: false,
        ...(venue ? { venue } : {}),
        ...(error ? { error } : {}),
      };
    }
    const now = Date.now();
    const stale = isStale(book, now);
    const status: FeedStatus =
      book.validity === 'INVALID' ? 'invalid' : stale ? 'paused' : error ? 'error' : 'live';
    const mid = midPrice(book);
    const spread = spreadPps(book);
    return {
      book,
      ...(params ? { params } : {}),
      status,
      // The venue's own answer outranks the book invariants: a paused market can quote
      // a perfect two-sided book, so `isTradable` alone would call it tradable.
      tradable: isTradable(book, now) && venue?.state !== 'paused',
      ...(venue ? { venue } : {}),
      ...(mid === undefined ? {} : { mid }),
      ...(spread === undefined ? {} : { spread }),
      ...(error ? { error } : {}),
      ...(book.blockNumber === undefined ? {} : { blockNumber: book.blockNumber }),
      ...(quoteUsdPrice === undefined ? {} : { quoteUsdPrice }),
    };
    // `tick` is intentionally in the dependency list: it is the clock that makes a
    // book go stale without a new payload arriving.
  }, [book, params, venue, error, tick, quoteUsdPrice]);
}
