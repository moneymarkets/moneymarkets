'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button, Card, Notice, Sheet, Toast } from '@tradepro/ui';
import { PairIcon } from '../../../components/TokenIcon';
import { BookCard, FeedChip, priceDecimals } from '../../../components/BookCard';
import { OpenOrdersCard } from '../../../components/OpenOrdersCard';
import { TicketCard } from '../../../components/TicketCard';
import { SignedOut } from '../../../components/SignedOut';
import { useSession } from '../../../lib/session';
import { useAccountBalances } from '../../../lib/useAccountBalances';
import { useMarketData } from '../../../lib/useMarketData';
import { useOpenOrders } from '../../../lib/openOrders';
import { useFillWatcher, type WatchedOrder } from '../../../lib/activity';
import { recordActivity } from '../../../lib/activityStore';
import { formatMoney, formatPrice, formatSize, formatSpreadBps } from '../../../lib/format';
import { MARKETS, type MarketConfig } from '../../../lib/markets';
import { WALLET_SWAP_HREF } from '../../../lib/wallet/routeHrefs';
import {
  filledFromReceipt,
  MAINNET,
  orderIdsCreatedFor,
  WIRE_PRICE_SCALE,
  type Side,
} from '@tradepro/core';
import {
  disabledMarketLabel,
  disabledVenueFor,
  marketStateLabel,
  useLiveStatus,
  venueFor,
} from '../../../components/LiveStatus';
import type { PlacedOrder } from '../../../lib/ticket';
import { prefetchDelegation, startOrderPrecompute } from '../../../lib/fund/bundlerTransport';
import { recordPerfStage } from '../../../lib/perf/orderPerf';
import './trade.css';

/** The picker's own non-market entry (C4): any pair with no Kuru book swaps instead. */
const SWAP_INSTEAD_KEY = '__swap-instead';

/**
 * Decorative icon colour for a market's quote asset — there is no live data behind
 * this, same as `COIN_COLOR` in `lib/markets.ts` ("decorative only, never the only
 * signal", design §7). Base-asset colour still comes from `market.color`.
 */
function quoteIconColor(quote: string): string {
  if (quote === 'USDC') return '#2775CA';
  if (quote === 'MON') return '#7C5CFF';
  if (quote === 'AUSD') return '#00B894';
  return '#5B6472';
}

function ChevronIcon() {
  return (
    <svg
      className="cv"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/**
 * The market picker (design: `.pair-btn` / `.pair-menu`): a pair icon, the current
 * market's name and settlement line, replacing the plain `<select>` — same markets
 * list, same `onSelect` the old `<select onChange>` called, nothing about which
 * market gets picked or how routing happens is new here.
 *
 * Desktop gets an inline dropdown under the button; under 720px the same option
 * rows render a second time inside the foundation's `Sheet` as a bottom sheet
 * (design/REDESIGN-FOUNDATION.md). CSS alone decides which copy is visible, so
 * opening the picker never mounts two copies of anything with a live data
 * subscription — this list has none.
 */
function MarketPicker({
  market,
  venueStatus,
  onSelect,
}: {
  market: MarketConfig;
  venueStatus: ReturnType<typeof useLiveStatus>;
  onSelect: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    function onDocPointer(e: PointerEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('pointerdown', onDocPointer);
    return () => document.removeEventListener('pointerdown', onDocPointer);
  }, [open]);

  function pick(value: string) {
    setOpen(false);
    onSelect(value);
  }

  function optionRows() {
    return (
      <>
        {MARKETS.map((m) => {
          if (m.status !== 'live') {
            return (
              <button
                key={m.key}
                type="button"
                role="option"
                aria-selected={false}
                className="pair-option"
                disabled
              >
                <PairIcon
                  base={{ address: m.baseAddress, symbol: m.base, color: m.color }}
                  quote={{ address: m.quoteAddress, symbol: m.quote, color: quoteIconColor(m.quote) }}
                />
                <span>{m.symbol} — not yet deployed</span>
              </button>
            );
          }
          if (m.role === 'disabled') {
            // Shown, never offered as a plain option — Kuru still lists both, so the
            // reason is the probe's own classification, never "not listed" (design
            // ground truth, 2026-09-23).
            const dm = disabledVenueFor(venueStatus?.disabledMarkets, m.address);
            return (
              <button
                key={m.key}
                type="button"
                role="option"
                aria-selected={false}
                className="pair-option"
                disabled
              >
                <PairIcon
                  base={{ address: m.baseAddress, symbol: m.base, color: m.color }}
                  quote={{ address: m.quoteAddress, symbol: m.quote, color: quoteIconColor(m.quote) }}
                />
                <span>
                  {m.symbol} — {disabledMarketLabel(dm)}
                </span>
              </button>
            );
          }
          // ITEM 5b: every option carries its state, always. A bare symbol next to a
          // labelled one reads as "this one is fine", and three of the four are not.
          const label = marketStateLabel(venueFor(venueStatus?.markets, m.address)?.state);
          return (
            <button
              key={m.key}
              type="button"
              role="option"
              aria-selected={m.key === market.key}
              className="pair-option"
              onClick={() => pick(m.key)}
            >
              <PairIcon
                base={{ address: m.baseAddress, symbol: m.base, color: m.color }}
                quote={{ address: m.quoteAddress, symbol: m.quote, color: quoteIconColor(m.quote) }}
              />
              <span>
                {m.symbol} — {label}
              </span>
            </button>
          );
        })}
        {/* C4: a pair Kuru has no book for is still tradable as a swap, so the
            picker itself offers the way there rather than only dead entries. */}
        <button
          type="button"
          role="option"
          aria-selected={false}
          className="pair-option"
          onClick={() => pick(SWAP_INSTEAD_KEY)}
        >
          <span>Swap instead — any pair, via Kuru Flow</span>
        </button>
      </>
    );
  }

  return (
    <div className="pair-wrap" ref={wrapRef}>
      <button
        type="button"
        id="market-picker"
        className="pair-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <PairIcon
          base={{ address: market.baseAddress, symbol: market.base, color: market.color }}
          quote={{ address: market.quoteAddress, symbol: market.quote, color: quoteIconColor(market.quote) }}
        />
        <span className="t">
          <b>{market.symbol}</b>
          <span>Kuru order book, settles in {market.quote}</span>
        </span>
        <ChevronIcon />
      </button>
      <div className={open ? 'pair-menu show' : 'pair-menu'} role="listbox" aria-label="Markets">
        {optionRows()}
      </div>
      <div className="picker-sheet">
        <Sheet open={open} onClose={() => setOpen(false)} labelledBy="market-picker-title">
          <h3 id="market-picker-title">Choose a market</h3>
          <div role="listbox" aria-label="Markets" style={{ marginTop: 14 }}>
            {optionRows()}
          </div>
        </Sheet>
      </div>
    </div>
  );
}

/**
 * The trade screen. Two columns on desktop, one on a phone (design 4).
 *
 * Everything the ticket needs to decide whether it may act comes from the book:
 * `tradable` is `isTradable()` from core, which is I1 and I6 together. This screen
 * never reasons about crossed or stale itself.
 *
 * A market that has not been deployed takes the branch at the top: the picker still
 * lists it, and choosing it says so. It never reaches `useMarketData`, so no request
 * is made for a book that does not exist and no empty book is drawn.
 */
export function TradeScreen({ market }: { market: MarketConfig }) {
  const router = useRouter();
  // Every market's own live state, so the picker says which ones can actually trade
  // before the user switches into one. Shared ten-minute poll with the footer.
  const venueStatus = useLiveStatus();

  function selectMarket(value: string) {
    if (value === SWAP_INSTEAD_KEY) router.push(WALLET_SWAP_HREF);
    else router.push(`/trade/${value}`);
  }

  const picker = <MarketPicker market={market} venueStatus={venueStatus} onSelect={selectMarket} />;
  const pickAnother =
    market.status === 'live' ? null : (
      <p className="tiny muted" style={{ marginTop: 8 }}>
        Pick another market to trade, or <Link href={WALLET_SWAP_HREF}>swap instead</Link>.
      </p>
    );

  if (market.status !== 'live' || !market.address) {
    return (
      <div className="page pg-trade">
        <div className="between" style={{ paddingTop: 6 }}>
          <div>
            <h2>{market.symbol}</h2>
            <p className="tiny">Not on Kuru yet</p>
          </div>
        </div>
        <div className="trade-head rise">{picker}</div>
        {pickAnother}
        <Card title="Order book">
          <div style={{ marginTop: 10 }}>
            <Notice tone="warn">{market.note ?? 'This market has not been created yet.'}</Notice>
          </div>
        </Card>
      </div>
    );
  }

  return <LiveMarket market={market} address={market.address} picker={picker} pickAnother={pickAnother} />;
}

function LiveMarket({
  market,
  address,
  picker,
  pickAnother,
}: {
  market: MarketConfig;
  address: `0x${string}`;
  picker: React.ReactNode;
  pickAnother: React.ReactNode;
}) {
  const session = useSession();
  const [toast, setToast] = useState<string | undefined>();
  // Whether this deployment actually sends. Drives item 5's purge of dry-run rows.
  const liveStatus = useLiveStatus();

  const data = useMarketData(address);
  // One hook, one read: margin AUSD and USDC (the two figures "Available" ever means,
  // item 4a) plus the market's own base asset (a sell spends that, not AUSD — the
  // base address and decimals come from the market's own live params, never a table
  // in the app) all come back from the same block.
  const balance = useAccountBalances(
    session.account?.address,
    data.params
      ? { address: data.params.baseAsset, decimals: data.params.baseDecimals }
      : undefined,
  );
  // Live actions on means dry-run rows are not real and must not be listed (item 5).
  const orders = useOpenOrders(address, session.account?.address, liveStatus?.live);

  /**
   * A resting order that fills while the user is away leaves the book, and this
   * notices. A targeted re-read of ids the app already tracks, not a search.
   *
   * The whole record goes in, not just the id: `isBuy` on it is the user's own resting
   * side from `s_orders`, so the row the watcher writes says "your buy order filled"
   * rather than "an order left the book". Size and price are rendered here because this
   * is where `params` is — the watcher must never have to guess a scale.
   */
  const watched = useMemo<WatchedOrder[]>(
    () =>
      orders.orders.map((o) => {
        const p = data.params;
        return {
          id: o.id,
          isBuy: o.isBuy,
          ...(p
            ? {
                sizeText: `${formatSize((BigInt(o.size) * 10n ** BigInt(p.baseDecimals)) / p.sizePrecision, p.baseDecimals, 2)} ${market.base}`,
                priceText: `${formatPrice((BigInt(o.price) * WIRE_PRICE_SCALE) / p.pricePrecision, priceDecimals(p))} ${market.quote}`,
              }
            : {}),
        };
      }),
    [orders.orders, data.params, market.base, market.quote],
  );
  useFillWatcher(session.account?.address, watched, market.symbol);

  /**
   * Warm the delegation read before the user commits to anything.
   *
   * It was 328 ms on the critical path of every submission, for an answer that has
   * been the same since this account's first operation. Reading it at mount moves it
   * off the path entirely — by the time anyone presses Buy it is already cached.
   */
  useEffect(() => {
    const address = session.account?.address;
    if (address) void prefetchDelegation(address);
  }, [session.account?.address]);

  /**
   * ITEM 2 — warm the nonce and fee reads before the user commits to anything, the
   * same way the delegation read above already is. Kept as its own effect: this one
   * needs the signing account, not just the address, and it runs a per-block fee
   * refresh for as long as this screen stays mounted, stopped on unmount or account
   * change by the cleanup `startOrderPrecompute` returns.
   */
  useEffect(() => {
    const owner = session.account?.account;
    if (!owner) return;
    return startOrderPrecompute(owner);
  }, [session.account?.address, session.account?.account]);

  // Mobile/PWA: the sticky ticket becomes a bottom sheet opened from the
  // `.trade-bar` Buy/Sell buttons (redesign PWA spec, "Trade"). `ticketSide` only
  // ever changes from a tap on the trade bar — on desktop, where the bar is
  // `display:none`, nothing can set it, so the ticket keeps its original default of
  // `buy` exactly as before. Remounting the (single) `TicketCard` instance by key on
  // a side change is what "preselects" it: the side-switch inside the ticket already
  // clears price/amount/state the same way, so a remount is a no-op to the ticket's
  // own rules, not a new one.
  const [ticketOpen, setTicketOpen] = useState(false);
  const [ticketSide, setTicketSide] = useState<Side>('buy');
  const ticketRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!ticketOpen) return undefined;
    ticketRef.current?.focus();
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setTicketOpen(false);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [ticketOpen]);

  /**
   * What happened to an order.
   *
   * A confirmed order is on chain and is re-read from `s_orders`. A dry run is not:
   * nothing was sent, so it is recorded as a **simulated** order carrying the real
   * calldata that was built, and shown as simulated everywhere it appears. The two
   * are never mixed in one list without a label.
   */
  function onPlaced(placed: PlacedOrder) {
    if (placed.progress.state === 'CONFIRMED') {
      // Remember the ids this receipt created. There is no on-chain call that
      // enumerates a user's orders and the public RPC caps `eth_getLogs` at 100
      // blocks, so the receipt is the one moment these exist — and until now nothing
      // read them, `track()` was called from nowhere, and a real resting order was
      // invisible and uncancellable from this screen. Each id is re-confirmed against
      // `s_orders` by `/api/orders`, so a filled or cancelled one drops straight back
      // out; tracking is remembering what to ask about, never a claim that it rests.
      const logs = placed.progress.result?.logs;
      if (logs && session.account) {
        for (const id of orderIdsCreatedFor(
          logs as Parameters<typeof orderIdsCreatedFor>[0],
          address,
          session.account.address,
        )) {
          // What we already know, so the row appears now instead of after a round
          // trip. The next `/api/orders` read replaces it whatever it says.
          orders.track(
            id.toString(),
            placed.progress.result?.txHash,
            placed.optimistic ? placed.optimistic : undefined,
          );
        }
      }
      /**
       * Write the fill down while the receipt still exists.
       *
       * Both sides of a trade — base in, quote out — live in the `Trade` events of
       * this one receipt and nowhere the app can cheaply reach afterwards. Cost basis
       * (ITEM 7) needs both, so it is recorded here or it is never recorded at all,
       * and a holding with no recorded fill honestly says it has no cost basis rather
       * than having one invented for it.
       *
       * A resting order that did not cross fills nothing now: `filledFromReceipt`
       * returns nothing and no trade row is written. The order row is written either
       * way, so the action is never silently absent from the feed.
       */
      if (logs && session.account && data.params) {
        const filled = filledFromReceipt(
          logs as Parameters<typeof filledFromReceipt>[0],
          address,
          session.account.address,
          data.params,
        );
        const txHash = placed.progress.result?.txHash;
        if (filled && filled.baseFilled > 0n) {
          const side = placed.side ?? 'buy';
          const base = formatMoney(filled.baseFilled, data.params.baseDecimals, 6);
          const quote = formatMoney(filled.quoteFilled, data.params.quoteDecimals, 6);

          /**
           * ITEM 6 — update the balance the user is looking at from the receipt's own
           * decoded fill, immediately, rather than waiting on `balance.refresh()`'s
           * round trip below. A buy spends `quoteFilled` of the market's quote asset
           * and receives `baseFilled` of the base asset; a sell is the opposite. The
           * quote-asset key matches the same mapping `available` (below) already uses
           * for this market, so a MON-quoted market adjusts margin MON, never AUSD.
           */
          const quoteSymbol =
            market.quote === 'USDC' ? 'USDC' : market.quote === 'MON' ? 'MON' : 'AUSD';
          balance.applyConfirmedFill({
            quoteSymbol,
            quoteDelta: side === 'buy' ? -filled.quoteFilled : filled.quoteFilled,
            baseDelta: side === 'buy' ? filled.baseFilled : -filled.baseFilled,
          });
          recordActivity(session.account.address, {
            id: txHash ?? `fill:${address}:${Date.now()}`,
            kind: 'order',
            summary:
              side === 'buy'
                ? `Bought ${base} ${market.base} for ${quote} ${market.quote} on ${market.symbol}`
                : `Sold ${base} ${market.base} for ${quote} ${market.quote} on ${market.symbol}`,
            amount: filled.baseFilled.toString(),
            decimals: data.params.baseDecimals,
            symbol: market.base,
            ...(txHash ? { txHash } : {}),
            at: Date.now(),
            trade: {
              side,
              baseAmount: filled.baseFilled.toString(),
              baseSymbol: market.base,
              baseDecimals: data.params.baseDecimals,
              quoteAmount: filled.quoteFilled.toString(),
              quoteSymbol: market.quote,
              quoteDecimals: data.params.quoteDecimals,
            },
          });
        } else {
          recordActivity(session.account.address, {
            id: txHash ?? `order:${address}:${Date.now()}`,
            kind: 'order',
            summary: `Placed an order on ${market.symbol}`,
            ...(txHash ? { txHash } : {}),
            at: Date.now(),
          });
        }
      }

      // `/dev/perf`'s `ui-updated` stage: the synchronous state work above — the
      // balance delta from the receipt's own decoded fill, and the tracked order id —
      // has been applied. `orders.refresh()`/`balance.refresh()` below are a
      // background consistency check, not what the user sees change right now.
      if (placed.perfActionId) recordPerfStage(placed.perfActionId, 'ui-updated');

      setToast('Order placed');
      orders.refresh();
      balance.refresh();
    } else if (placed.progress.state === 'RELAYING' && placed.simulated) {
      setToast('Checked. Nothing sent in this mode');
      orders.trackSimulated(placed.simulated);
    }
  }

  // "Available" is the market's own quote asset, from the hook, never a fixed
  // default — an AUSD balance shown under a "USDC" label on MON/USDC was exactly
  // this being wired backwards (item 4a). emo/MON is quoted in native MON, so its buy
  // side spends margin MON; falling through to AUSD there would compare a six-decimal
  // AUSD balance with an 18-decimal MON amount.
  const available =
    market.quote === 'USDC'
      ? balance.margin?.USDC.value
      : market.quote === 'MON'
        ? balance.margin?.MON.value
        : balance.margin?.AUSD.value;
  const availableBase = balance.marginBase?.value;

  // The market's own state comes first: a paused market quotes a healthy book, so a
  // reason derived from the feed alone would say nothing about it. `venue.reason`
  // carries the venue's own words verbatim (D124).
  const feedReason =
    data.venue?.state === 'paused'
      ? `This market is paused. ${data.venue.reason ?? 'Kuru is refusing orders on it.'}`
      : data.venue?.state === 'empty'
        ? 'No orders on this book — a market order would fill nothing, and a limit order would rest alone until someone trades against it.'
        : data.venue?.state === 'one-sided'
          ? 'Only one side of this book has orders. A market order into the empty side would fill nothing.'
          : data.status === 'invalid'
            ? 'The ticket is disabled because the book is inconsistent.'
            : data.status === 'paused'
              ? 'The ticket is disabled because prices have stopped updating.'
              : data.status === 'error'
                ? 'The ticket is disabled because prices are not reaching us.'
                : undefined;

  const dp = data.params ? priceDecimals(data.params) : 6;
  const midText = data.mid === undefined ? 'No price' : formatPrice(data.mid, dp);
  const spreadText =
    data.status !== 'live' || data.spread === undefined ? 'No spread' : formatSpreadBps(data.spread);
  const blockText =
    data.blockNumber === undefined
      ? 'Reading the book from Monad.'
      : `Read from Monad at block ${data.blockNumber.toString()}.`;

  const ticket =
    session.status !== 'signed-in' ? (
      <SignedOut />
    ) : (
      <TicketCard
        key={ticketSide}
        initialSide={ticketSide}
        market={address}
        marginAccount={MAINNET.kuru.marginAccount as `0x${string}`}
        {...(data.params ? { params: data.params } : {})}
        {...(data.book ? { book: data.book } : {})}
        tradable={data.tradable}
        {...(data.venue ? { venueState: data.venue.state } : {})}
        {...(feedReason ? { feedReason } : {})}
        base={market.base}
        quote={market.quote}
        {...(session.account ? { sender: session.account.address } : {})}
        {...(session.account ? { owner: session.account.account } : {})}
        {...(available === undefined ? {} : { available })}
        {...(availableBase === undefined ? {} : { availableBase })}
        {...(data.quoteUsdPrice === undefined ? {} : { quoteUsdPrice: data.quoteUsdPrice })}
        onPlaced={onPlaced}
      />
    );

  return (
    <div className="page pg-trade">
      <div className="trade-head rise">
        {picker}
        <div className="tick">
          <b className="num">{midText}</b>
          <span>Mid price</span>
        </div>
        <div className="tick">
          <b className="num">{spreadText}</b>
          <span>Spread</span>
        </div>
        <div className="live-info">
          <FeedChip status={data.status} />
          <span className="tiny muted">{blockText}</span>
        </div>
      </div>
      {pickAnother}

      <div className="split trade-grid">
        <div className="stack" style={{ gap: 14 }}>
          <BookCard
            {...(data.book ? { book: data.book } : {})}
            {...(data.params ? { params: data.params } : {})}
            status={data.status}
            {...(data.mid === undefined ? {} : { mid: data.mid })}
            {...(data.spread === undefined ? {} : { spread: data.spread })}
            {...(data.error ? { error: data.error } : {})}
            {...(data.venue ? { venue: data.venue } : {})}
          />

          <OpenOrdersCard
            market={address}
            {...(data.params ? { params: data.params } : {})}
            base={market.base}
            marketSymbol={market.symbol}
            {...(session.account ? { sender: session.account.address } : {})}
            {...(session.account ? { owner: session.account.account } : {})}
            state={orders}
          />
        </div>

        <div
          className={ticketOpen ? 'ticket-col open' : 'ticket-col'}
          ref={ticketRef}
          tabIndex={-1}
          aria-label="Place order"
        >
          <button
            type="button"
            className="ticket-close"
            aria-label="Close order ticket"
            onClick={() => setTicketOpen(false)}
          >
            <CloseIcon />
          </button>
          {ticket}
        </div>
      </div>

      <div className="trade-bar-lift">
        <div className="trade-bar" aria-label="Quick trade">
          <Button
            variant="up"
            size="lg"
            block
            onClick={() => {
              setTicketSide('buy');
              setTicketOpen(true);
            }}
          >
            Buy {market.base}
          </Button>
          <Button
            variant="down"
            size="lg"
            block
            onClick={() => {
              setTicketSide('sell');
              setTicketOpen(true);
            }}
          >
            Sell {market.base}
          </Button>
        </div>
      </div>
      <div
        className={ticketOpen ? 'scrim show' : 'scrim'}
        onClick={() => setTicketOpen(false)}
        aria-hidden={!ticketOpen}
      />

      <Toast message={toast ?? ''} show={Boolean(toast)} onDismiss={() => setToast(undefined)} />
    </div>
  );
}
