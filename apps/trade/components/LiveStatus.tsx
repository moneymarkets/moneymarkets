'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { apiUrl } from '../lib/basePath';

/**
 * The gate state, on every screen, read from the server.
 *
 * ## Why this is in the chrome and not a dev tool
 *
 * "Is this build armed?" was previously answerable only by reading a log, and the one
 * time it mattered the browser was running a bundle compiled before the fix while the
 * server was armed — so the screen said "simulated mode" and nothing on it could
 * explain why. Printing the build id alongside the state makes a stale tab visible
 * instead of mysterious: if the id does not change after a rebuild and a hard reload,
 * the browser is serving cache.
 *
 * The value comes from `/api/status`, which evaluates the **server** gate. Client code
 * cannot read `MODE`, and the last thing this app should do is guess at it again.
 */

export type KuruState = 'clear' | 'margin-paused' | 'orders-paused' | 'all-paused' | 'unknown';

export interface LiveState {
  readonly live: boolean;
  readonly buildId: string;
  readonly paused: boolean | null;
  /** Deposits and withdrawals. */
  readonly marginPaused: boolean | null;
  /** Placing and cancelling orders. */
  readonly ordersPaused: boolean | null;
  readonly kuru: KuruState;
  /**
   * Per-market state, one entry per allowlisted book. `kuru`/`ordersPaused` summarise
   * these; a screen that shows a market should read the market rather than the
   * summary — one probe never described four books (see `lib/server/venueState.ts`).
   */
  readonly markets?: readonly MarketVenue[];
  /**
   * MON/AUSD and AUSD/USDC — shown, never traded, so they are never in `markets`
   * above. Kuru still lists both; `disabledMarketLabel` below turns this into copy
   * that never claims otherwise.
   */
  readonly disabledMarkets?: readonly DisabledMarketWire[];
}

export interface DisabledMarketWire {
  readonly address: string;
  readonly symbol: string;
  readonly base: string;
  readonly quote: string;
  /** `undefined` means not known yet — never treat that as "not listed" (see below). */
  readonly stillListedByKuru: boolean | undefined;
  readonly reason: 'paused' | 'empty' | 'unknown';
}

export interface MarketVenue {
  readonly market: string;
  readonly state: 'tradable' | 'paused' | 'empty' | 'one-sided' | 'delisted' | 'unknown';
  /** The venue's own words, verbatim (D124). */
  readonly reason?: string;
  /** Kuru's fees for this book, basis points, from `getMarketParams()`. */
  readonly takerFeeBps?: string;
  readonly makerFeeBps?: string;
  /** What Kuru actually answered the probe, and the exact call that asked. */
  readonly probeSelector?: string;
  readonly probeError?: string;
  readonly probeCall?: string;
}

/**
 * What to call a market's state, in the market picker and the markets list.
 *
 * Two absences are deliberately different words (ITEM 5b). `undefined` means the status
 * poll has not answered yet — the app is checking. `'unknown'` means it did answer and
 * could not establish the state, which today is true of AUSD/USDC and WBTC/AUSD. Saying
 * "Checking" for both would promise an answer that is not coming; saying nothing for
 * both, as this did until 2026-09-09, offered four markets as equally tradable when
 * only one of them is.
 */
export function marketStateLabel(state: MarketVenue['state'] | undefined): string {
  if (state === 'tradable') return 'Tradable';
  // "Paused" implies temporary. A delisted market is gone, and a user told the wrong
  // one of those two waits instead of going elsewhere.
  if (state === 'delisted') return 'Not listed by Kuru';
  if (state === 'paused') return 'Paused';
  if (state === 'empty') return 'Empty book';
  if (state === 'one-sided') return 'One side only';
  if (state === 'unknown') return 'State unknown';
  return 'Checking';
}

/** Look one market up by address, case-insensitively. */
export function venueFor(
  markets: readonly MarketVenue[] | undefined,
  market: string | undefined,
): MarketVenue | undefined {
  if (!markets || !market) return undefined;
  return markets.find((m) => m.market.toLowerCase() === market.toLowerCase());
}

/** Look one disabled market up by address, case-insensitively. */
export function disabledVenueFor(
  disabledMarkets: readonly DisabledMarketWire[] | undefined,
  market: string | undefined,
): DisabledMarketWire | undefined {
  if (!disabledMarkets || !market) return undefined;
  return disabledMarkets.find((m) => m.address.toLowerCase() === market.toLowerCase());
}

/**
 * What to call a shown-but-disabled market — MON/AUSD or AUSD/USDC — without ever
 * saying "not listed": Kuru still lists both (design ground truth, 2026-09-23). Keyed
 * on the probe's own classification, because the two disabled markets are disabled
 * for genuinely different reasons and a blanket label would flatten that.
 *
 * `undefined` (not read yet) reads the same as `'unknown'`: honest, and it never
 * claims a listing state it does not have.
 */
export function disabledMarketLabel(dm: DisabledMarketWire | undefined): string {
  if (!dm) return 'Checking with Kuru';
  if (dm.reason === 'paused') return 'Paused by Kuru';
  if (dm.reason === 'empty') return 'No active market on Kuru today';
  return 'Checking with Kuru';
}

/**
 * What is actually blocked, in the fewest words that are still true.
 *
 * The order book calls into MarginAccount, so a margin pause usually stops orders
 * too — but not always, and "deposits are paused" and "everything is paused" are
 * different things to tell somebody holding money. `unknown` is its own state: an RPC
 * that did not answer is not evidence the venue is healthy.
 */
export const KURU_LABEL: Record<KuruState, string> = {
  clear: 'Kuru: all clear',
  'margin-paused': 'Kuru: deposits paused',
  'orders-paused': 'Kuru: orders paused',
  'all-paused': 'Kuru: deposits and orders paused',
  unknown: 'Kuru: status unknown',
};

/**
 * One `/api/status` poll shared by the whole tree.
 *
 * `useLiveStatus` used to run this fetch-and-poll effect itself, so every caller —
 * the chrome's own footer, plus whichever screen also calls it (`/trade/[market]`
 * calls it twice, `/home` once more) — opened an independent interval and issued its
 * own request for the same venue-level fact. Three components asking the identical
 * question at mount is three round trips a real network can measure and a user can
 * wait on; nothing about the answer differs per caller. `LiveStatusProvider` is
 * mounted once, in `Chrome`, and every `useLiveStatus()` call below just reads its
 * context — one request per page load no matter how many screens ask.
 */
const LiveStatusContext = createContext<LiveState | undefined>(undefined);

export function LiveStatusProvider({
  children,
  pollMs = 600_000,
}: {
  children: ReactNode;
  pollMs?: number;
}) {
  const [state, setState] = useState<LiveState | undefined>();

  useEffect(() => {
    let cancelled = false;
    const read = async () => {
      try {
        const res = await fetch(apiUrl('/api/status'), { cache: 'no-store' });
        if (!res.ok) return;
        const body = (await res.json()) as LiveState;
        if (!cancelled) setState(body);
      } catch {
        // Leave the last known state. A failed read is not evidence of anything.
      }
    };
    void read();
    // Ten minutes: this is a venue-level fact, not a price.
    const id = window.setInterval(read, pollMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [pollMs]);

  return <LiveStatusContext.Provider value={state}>{children}</LiveStatusContext.Provider>;
}

/** Polled by the funding card too, so both agree about the venue. */
export function useLiveStatus(): LiveState | undefined {
  return useContext(LiveStatusContext);
}

export function LiveStatus() {
  const status = useLiveStatus();
  if (!status) return null;

  const label = status.live ? 'Live actions: ON' : 'Live actions: OFF (simulated)';

  return (
    <div className="footer-status">
      <span className={status.live ? 'live' : undefined}>{label}</span>
      <span
        style={{
          color:
            status.kuru === 'clear'
              ? 'var(--up)'
              : status.kuru === 'unknown'
                ? 'var(--ink-3)'
                : 'var(--warn)',
        }}
      >
        {KURU_LABEL[status.kuru] ?? KURU_LABEL.unknown}
      </span>
      <span className="num">build {status.buildId}</span>
    </div>
  );
}
