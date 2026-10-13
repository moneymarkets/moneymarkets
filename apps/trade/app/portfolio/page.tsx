'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import {
  Button,
  Card,
  Chip,
  Empty,
  Hero,
  LiveAmount,
  Notice,
  Row,
  Skeleton,
} from '@tradepro/ui';
import { Chrome } from '../../components/Chrome';
import { FailureNotice } from '../../components/FailureNotice';
import { SignedOut } from '../../components/SignedOut';
import { TokenIcon } from '../../components/TokenIcon';
import { UnlistedTokensCard } from '../../components/UnlistedTokensCard';
import { useSession } from '../../lib/session';
import { failure } from '../../lib/failures';
import { useAccountBalances } from '../../lib/useAccountBalances';
import { WalletHoldings, type WalletHolding } from '../../components/WalletHoldings';
import { RecentDeposits } from '../../components/RecentDeposits';
import { displayDp, formatMoney } from '../../lib/format';
import { useActivity, useArrivalWatcher } from '../../lib/activity';
import { useWalletPreferences } from '../../lib/wallet/preferences';
import {
  marginHoldings,
  pricedTotal,
  splitListed,
  unlistedGroupState,
  walletHoldings as walletHoldingsOf,
} from '../../lib/wallet/holdingsModel';
import { PositionValue, type PricedHolding } from '../../components/PositionValue';
import { useMarketData } from '../../lib/useMarketData';
import { MARKETS } from '../../lib/markets';
import './portfolio.css';

/**
 * `/portfolio` — holdings and history (design 5.5).
 *
 * The one figure this screen can stand behind — the AUSD sitting in the margin
 * account — is read from the chain and shown as the hero. No trend is drawn, because
 * a twelve-bar chart of numbers nobody measured is a picture of nothing.
 *
 * Activity comes from this app's own record of what it watched happen, plus the
 * deposit store the server keeps — never from a block scan, and no longer from an
 * indexer. The Envio indexer was dropped on 2026-09-09 at the owner's instruction: it
 * had never run, and "History syncing" described a process that did not exist. See
 * `lib/activity.ts`.
 */
export default function PortfolioPage() {
  const session = useSession();
  const balance = useAccountBalances(session.account?.address);
  const activity = useActivity(session.account?.address);
  const prefs = useWalletPreferences(session.account?.address);

  /**
   * A live price for MON, read from the book rather than assumed (ITEM 7).
   *
   * MON is the only non-dollar asset this account can hold, and it is the only one
   * whose value moves against what was paid for it. The dollars are what everything
   * else is measured in and are not marked against themselves. If this book has no
   * two-sided quote, `mid` is undefined and nothing is shown — there is no fallback
   * price anywhere in this screen.
   */
  const monMarket = MARKETS.find((m) => m.symbol === 'MON / USDC');
  const monBook = useMarketData(monMarket?.address ?? '0x');

  // Money that arrives without the user sending it still gets a row. The poll that
  // feeds the numbers above is the detection; no extra read, no scan.
  useArrivalWatcher(session.account?.address, balance.tokens);

  if (session.status !== 'signed-in') {
    return (
      <Chrome>
        <div className="page">
          <h2 style={{ paddingTop: 6 }}>Portfolio</h2>
          <SignedOut />
        </div>
      </Chrome>
    );
  }

  // Every token the account holds, from the one holdings model every screen reads
  // (spec A2d, E2). The total is in dollars from the registry's price sources and sums
  // only rows with a price; how many it leaves out is stated, never inferred.
  const tokens = balance.tokens ?? [];
  const { totalUsd, unpricedCount } = pricedTotal(tokens);
  const { listed } = splitListed(tokens);
  const unlisted = unlistedGroupState(tokens, prefs);

  const walletHoldings: WalletHolding[] = walletHoldingsOf(tokens).map((t) => ({
    symbol: t.symbol,
    decimals: t.decimals,
    balance: t.wallet.value,
    iconUrl: t.iconUrl,
    listed: t.listed,
  }));

  // One row per non-zero balance, labelled by location — never one figure that
  // silently merges "ready to trade" and "sitting in the wallet" (item 3b). Listed
  // tokens here; unlisted ones sit in their own collapsed group below.
  const holdingRows: Array<{
    readonly key: string;
    readonly symbol: string;
    readonly location: 'margin' | 'wallet';
    readonly value: bigint;
    readonly decimals: number;
    readonly address: string;
  }> =
    balance.status === 'ready'
      ? [
          ...marginHoldings(listed).map((t) => ({
            key: `margin-${t.address}`,
            symbol: t.symbol,
            location: 'margin' as const,
            value: t.margin.value,
            decimals: t.decimals,
            address: t.address,
          })),
          ...walletHoldingsOf(listed).map((t) => ({
            key: `wallet-${t.address}`,
            symbol: t.symbol,
            location: 'wallet' as const,
            value: t.wallet.value,
            decimals: t.decimals,
            address: t.address,
          })),
        ]
      : [];

  // MON across both locations: a trade settles into margin, a withdrawal moves it to
  // the wallet, and it is one holding either way. Native MON is the zero address.
  const mon = tokens.find((t) => t.address.toLowerCase() === '0x0000000000000000000000000000000000000000');
  const monHeld = (mon?.margin.value ?? 0n) + (mon?.wallet.value ?? 0n);
  const pricedHoldings: readonly PricedHolding[] = [
    {
      symbol: 'MON',
      held: monHeld,
      decimals: 18,
      ...(monBook.mid === undefined ? { priceWire: undefined } : { priceWire: monBook.mid }),
    },
  ];

  // Allocation bar and legend (design §5.5): built only from holdings this page
  // already prices — a token with no `usd.total` is left out rather than guessed
  // at, and the whole bar is skipped when nothing here has a price at all.
  const allocation = tokens
    .filter((t) => (t.margin.value > 0n || t.wallet.value > 0n) && t.usd.total !== null)
    .map((t) => ({ symbol: t.symbol, usd: (t.usd.total as { value: bigint }).value }))
    .sort((a, b) => (b.usd > a.usd ? 1 : b.usd < a.usd ? -1 : 0));
  const allocationTotal = allocation.reduce((sum, a) => sum + a.usd, 0n);

  return (
    <Chrome>
      <div className="page pg-portfolio">
        {/* A Day/Month control used to sit here. It was deleted on 2026-09-09: there is
            no stored series behind it, so neither setting changed a number on the
            screen. A control that does nothing teaches people that controls here might
            do nothing. */}
        <h2 className="rise" style={{ paddingTop: 6 }}>
          Portfolio
        </h2>

        <Hero label="Total value" className="rise" style={{ animationDelay: '60ms' }}>
          <div className="hero-row">
            <div>
              {balance.status === 'loading' ? (
                <Skeleton rows={2} width="70%" />
              ) : balance.status === 'error' ? (
                <>
                  <p className="small" style={{ marginTop: 6 }}>
                    Value unavailable
                  </p>
                  {/* ITEM 9. A read that failed now offers the way out of it. It used to
                      state the problem and leave the user with nothing to press. */}
                  <div style={{ marginTop: 10 }}>
                    <FailureNotice
                      failure={failure('BALANCE_UNREADABLE')}
                      onRetry={() => balance.refresh()}
                    />
                  </div>
                </>
              ) : (
                <>
                  <LiveAmount formatted={formatMoney(totalUsd, 6, 2)} currency="USD" />
                  {unpricedCount > 0 ? (
                    <p className="tiny muted" style={{ marginTop: 4 }}>
                      Excludes {unpricedCount} token{unpricedCount === 1 ? '' : 's'} with no price.
                    </p>
                  ) : null}
                </>
              )}
              {/* Allocation bar and legend: only the holdings this page can already
                  price (design §5.5). Skipped entirely when nothing here has a price. */}
              {allocation.length > 0 && allocationTotal > 0n ? (
                <AllocationBar items={allocation} total={allocationTotal} />
              ) : null}
            </div>
            {/* ITEM 7. Two chips reading "No unrealised yet" and "No realised yet" used
                to sit here, wired to nothing. Kuru is spot — there is no position and no
                entry price — so what is shown instead is cost basis from this account's
                own fills, valued at a price read live, and nothing at all where a basis
                cannot honestly be established.
                Desktop (design's `.hero` + `.infobox`): its own box beside the total.
                Under 720px, or installed (`display-mode: standalone`), `portfolio.css`
                drops it back under the total, unboxed — where it already sat. */}
            <div className="cost-box">
              <PositionValue rows={activity.rows} holdings={pricedHoldings} />
            </div>
          </div>
          {/* "Total value" that omits what the wallet holds is not a total. */}
          <WalletHoldings holdings={walletHoldings} />
        </Hero>

        {/* 2-column grid (design §5.5): Holdings (and Unlisted tokens) on the left,
            Activity and Recent deposits on the right. `.split` collapses to one
            column under the shared breakpoint — Holdings first there too. */}
        <div className="split">
          <div className="stack">
            <Card title="Holdings" className="rise" style={{ animationDelay: '120ms' }}>
              <div className="list" style={{ marginTop: 6 }}>
                {balance.status === 'loading' ? (
                  <Skeleton rows={2} />
                ) : balance.status === 'error' ? (
                  <Notice tone="warn">{balance.message}</Notice>
                ) : holdingRows.length === 0 ? (
                  <Empty>Nothing here yet. Move money in to see it.</Empty>
                ) : (
                  holdingRows.map((row) => (
                    <Row
                      key={row.key}
                      leading={<TokenIcon address={row.address} symbol={row.symbol} />}
                      title={row.symbol}
                      subtitle={
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <Chip tone={row.location === 'margin' ? 'trading' : 'wallet'}>
                            {row.location === 'margin' ? 'Trading' : 'Wallet'}
                          </Chip>
                          {row.location === 'margin' ? 'Ready to trade' : 'Not tradable yet'}
                        </span>
                      }
                      value={formatMoney(row.value, row.decimals, displayDp(row.symbol, row.decimals))}
                      // Money in the trading balance had no way out until now (FR-07 was
                      // named and never built), so every margin row carries the way out.
                      // Right-aligned in a fixed-width column so the amount above never
                      // reflows against a different number of actions per row.
                      trailing={
                        <span style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', minWidth: 112 }}>
                          {row.location === 'margin' ? (
                            <Link href="/withdraw" style={{ textDecoration: 'none' }}>
                              <Chip>Withdraw</Chip>
                            </Link>
                          ) : (
                            <>
                              <Link href="/fund#move" style={{ textDecoration: 'none' }}>
                                <Chip>Move</Chip>
                              </Link>
                              <Link href="/send" style={{ textDecoration: 'none' }}>
                                <Chip>Send</Chip>
                              </Link>
                            </>
                          )}
                        </span>
                      }
                    />
                  ))
                )}
              </div>
            </Card>

            {/* Tokens no registry source lists (spec A3): collapsed, marked, addressable. */}
            {balance.status === 'ready' ? <UnlistedTokensCard group={unlisted} /> : null}
          </div>

          <div className="stack">
            {/* ITEM 4a. The list moved to its own route. What stays is the way there —
                "what happened to my money" and "what is my money worth" are different
                questions, and this screen answers the second one. */}
            <Card title="Activity" className="rise" style={{ animationDelay: '160ms' }}>
              <p className="small" style={{ marginTop: 6 }}>
                Every deposit, trade, transfer and withdrawal, with the transaction behind it.
              </p>
              <div style={{ marginTop: 12 }}>
                <Link href="/activity" style={{ textDecoration: 'none' }}>
                  <Button variant="soft" block>
                    See all activity
                  </Button>
                </Link>
              </div>
            </Card>

            {session.account ? <RecentDeposits recipient={session.account.address} /> : null}
          </div>
        </div>
      </div>
    </Chrome>
  );
}

/**
 * Allocation bar and legend (design §5.5): a horizontal bar of proportional
 * segments and a text legend below it, built only from the holdings the page
 * already prices. Colour is never the only signal (design §7) — each segment's
 * token and share are also named in the legend text.
 */
const ALLOCATION_PALETTE = ['var(--trade)', 'var(--wallet)', 'var(--down)', 'var(--ok)', 'var(--ink-3)'] as const;

function AllocationBar({
  items,
  total,
}: {
  readonly items: readonly { readonly symbol: string; readonly usd: bigint }[];
  readonly total: bigint;
}) {
  const [grown, setGrown] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setGrown(true), 30);
    return () => window.clearTimeout(id);
  }, []);

  const shares = items.map((item, i) => ({
    ...item,
    color: ALLOCATION_PALETTE[i % ALLOCATION_PALETTE.length],
    pct: total > 0n ? (Number(item.usd) / Number(total)) * 100 : 0,
  }));

  return (
    <div style={{ marginTop: 14 }}>
      <div
        role="img"
        aria-label={shares.map((s) => `${s.symbol} ${s.pct.toFixed(1)}%`).join(', ')}
        style={{
          display: 'flex',
          height: 10,
          borderRadius: 999,
          overflow: 'hidden',
          background: 'var(--surface-2)',
        }}
      >
        {shares.map((s) => (
          <span
            key={s.symbol}
            style={{
              width: grown ? `${s.pct}%` : '0%',
              background: s.color,
              transition: 'width 0.8s var(--ease)',
            }}
          />
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px', marginTop: 10 }}>
        {shares.map((s) => (
          <span key={s.symbol} className="tiny muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span
              aria-hidden="true"
              style={{ width: 8, height: 8, borderRadius: '50%', background: s.color, display: 'inline-block' }}
            />
            {s.symbol} <span className="num">{s.pct.toFixed(1)}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}
