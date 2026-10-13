'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  Button,
  Card,
  Chip,
  Hero,
  LiveAmount,
  Row,
  Skeleton,
  Toast,
} from '@tradepro/ui';
import { Chrome } from '../../components/Chrome';
import { TokenIcon } from '../../components/TokenIcon';
import {
  disabledMarketLabel,
  disabledVenueFor,
  marketStateLabel,
  useLiveStatus,
  venueFor,
} from '../../components/LiveStatus';
import { ActivityList } from '../../components/ActivityList';
import { useActivity, useArrivalWatcher } from '../../lib/activity';
import { InstallPrompt } from '../../components/InstallPrompt';
import { SignedOut } from '../../components/SignedOut';
import { useSession } from '../../lib/session';
import { FailureNotice } from '../../components/FailureNotice';
import { failure } from '../../lib/failures';
import { useAccountBalances } from '../../lib/useAccountBalances';
import {
  marginHoldings,
  tokenBySymbol,
  walletHoldings as walletHoldingsOf,
} from '../../lib/wallet/holdingsModel';
import { DEFAULT_MARKET, MARKETS } from '../../lib/markets';
import {
  displayDp,
  formatMoney,
  sumAusd,
  toAusdEquivalent,
  toUsdcEquivalent,
} from '../../lib/format';
import './home.css';

/**
 * `/home` — the balance hero, pockets, markets, install banner (design §5.2).
 *
 * Funded and unfunded are both drawn. Positions are empty until the indexer lands in
 * Phase 3, and the empty copy says what will fill it rather than pretending to know
 * a position exists.
 */
export default function HomePage() {
  const session = useSession();
  const balance = useAccountBalances(session.account?.address);
  // Per-market venue state for the Markets list. Ten-minute poll, shared with the
  // footer, so this costs nothing extra.
  const status = useLiveStatus();
  const activity = useActivity(session.account?.address);

  // An arrival the user did not cause still gets a row, from the poll already running.
  useArrivalWatcher(session.account?.address, balance.tokens);
  const [toast, setToast] = useState<string | undefined>();

  if (session.status !== 'signed-in' || !session.account) {
    return (
      <Chrome>
        <div className="page">
          <h2 style={{ paddingTop: 6 }}>Home</h2>
          <SignedOut />
        </div>
      </Chrome>
    );
  }

  // "Available to trade" is every margin balance, converted to one figure (item 3a) —
  // not just one leg, which used to leave the other out of the headline number
  // entirely. The headline is USDC, not AUSD: every one of the four markets this app
  // actually trades is quoted in USDC, and AUSD is not an order-book asset any of
  // them trades against — MON/AUSD and AUSD/USDC are both shown, not traded. The AUSD
  // total is still shown, underneath, as what the same balance is worth.
  // The two dollar assets every market here settles in, read from the one holdings
  // model by symbol (spec A2d): not a fixed record, and the hero's own concept is
  // "what can an order spend", which is exactly these two.
  const tokens = balance.tokens ?? [];
  const marginAusd = tokenBySymbol(tokens, 'AUSD')?.margin.value ?? 0n;
  const marginUsdc = tokenBySymbol(tokens, 'USDC')?.margin.value ?? 0n;
  // `undefined` when a nonzero AUSD margin balance has no live mid to price it at —
  // never a fabricated par figure (audit U5). A zero AUSD balance needs no price, so
  // this is `undefined` only while it would otherwise matter.
  const usdcTotal = sumAusd(marginUsdc, toUsdcEquivalent(marginAusd, balance.ausdPerUsdcMid));
  // The same balance, in AUSD — the figure this hero used to lead with. Same
  // conversion, same honesty rule, now the secondary line.
  const ausdEquivalent = sumAusd(marginAusd, toAusdEquivalent(marginUsdc, balance.ausdPerUsdcMid));
  const funded = balance.status === 'ready' && usdcTotal !== undefined && usdcTotal > 0n;

  // Every token in the trading balance, listed or not (spec E1), at display precision —
  // the left pocket card's chips.
  const tradingTokens = marginHoldings(tokens);

  // Every token the wallet holds, listed or not (spec A2d, A6) — the right pocket
  // card's chips. No fixed list.
  const walletTokens = walletHoldingsOf(tokens);

  const tradeHref = `/trade/${DEFAULT_MARKET.key}`;

  return (
    <Chrome>
      <div className="page pg-home">
        <h2 className="rise" style={{ paddingTop: 6 }}>
          Good morning
        </h2>

        <Hero label="Available to trade" className="rise" style={{ animationDelay: '60ms' }}>
          <div className="hero-row">
            <div>
              {balance.status === 'loading' ? (
                <Skeleton rows={2} width="70%" />
              ) : balance.status === 'error' ? (
                <>
                  <p className="small" style={{ marginTop: 6 }}>
                    Balance unavailable
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
              ) : usdcTotal === undefined ? (
                <>
                  {/* The USDC leg is real; only converting the AUSD leg needs a live mid
                      this book does not have right now. Shown honestly rather than
                      guessed at par (audit U5) — the known part, not an invented total. */}
                  <LiveAmount formatted={formatMoney(marginUsdc, 6)} currency="USDC" />
                  <p className="tiny muted" style={{ marginTop: 4 }}>
                    Plus {formatMoney(marginAusd, 6)} AUSD not yet priced in USDC — the book has no
                    live price for it right now.
                  </p>
                </>
              ) : (
                <>
                  <LiveAmount formatted={formatMoney(usdcTotal, 6)} currency="USDC" />
                  {ausdEquivalent !== undefined ? (
                    <p className="tiny muted num" style={{ marginTop: 4 }}>
                      ≈ {formatMoney(ausdEquivalent, 6)} AUSD
                    </p>
                  ) : null}
                </>
              )}
              {/* ITEM 8. Two places money can sit, and nothing in the app had ever said
                  which was which. The person who commissioned this was confused by it. */}
              <p className="tiny muted" style={{ marginTop: 8 }}>
                Your trading balance is money held inside Kuru, ready to trade this second. Your
                wallet is money on Monad that is yours but not tradable yet — move it across first.
              </p>
            </div>
            {/* Desktop (design's `.home-hero`): beside the figure. Under 720px, or
                installed (`display-mode: standalone`), `home.css` drops this back to a
                full-width, side-by-side pair below it. */}
            <div className="hero-btns">
              <Link href="/fund" style={{ textDecoration: 'none' }}>
                <Button variant="primary" size="lg">
                  Add money
                </Button>
              </Link>
              <Link href={tradeHref} style={{ textDecoration: 'none' }}>
                <Button variant="ghost" size="lg">
                  Trade
                </Button>
              </Link>
            </div>
          </div>
        </Hero>

        {!funded ? (
          <Card title="Start with money you already have" className="rise" style={{ animationDelay: '120ms' }}>
            <p className="small" style={{ marginTop: 6 }}>
              {balance.status === 'ready'
                ? 'Your trading balance is empty. Add USDC — every market this app trades is quoted in it, so it is ready to trade immediately.'
                : 'We will show what is available once your balance loads.'}
            </p>
            <div style={{ marginTop: 12 }}>
              <Link href="/fund" style={{ textDecoration: 'none' }}>
                <Button variant="soft" size="sm">
                  Choose a source
                </Button>
              </Link>
            </div>
          </Card>
        ) : null}

        {/* Two pocket cards (design §5.2): where the money is, and what each place
            can do. Money in the trading balance is an order away; money in the
            wallet needs a Move first — the same two facts the hero text already
            states, here as the tokens themselves. */}
        <div className="split">
          <Card
            title="Trading balance on Kuru"
            action={<span className="tiny muted">Settles in USDC</span>}
            className="rise"
            style={{ animationDelay: '160ms' }}
          >
            {balance.status === 'loading' ? (
              <Skeleton rows={1} />
            ) : tradingTokens.length === 0 ? (
              <p className="tiny muted" style={{ marginTop: 6 }}>
                Nothing in your trading balance yet.
              </p>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                {tradingTokens.map((t) => (
                  <Chip key={t.address} tone="trading">
                    {formatMoney(t.margin.value, t.decimals, displayDp(t.symbol, t.decimals))} {t.symbol}
                  </Chip>
                ))}
              </div>
            )}
          </Card>

          <Card
            title="In your wallet"
            action={<span className="tiny muted">Not tradable yet</span>}
            className="rise"
            style={{ animationDelay: '200ms' }}
          >
            {balance.status === 'loading' ? (
              <Skeleton rows={1} />
            ) : walletTokens.length === 0 ? (
              <p className="tiny muted" style={{ marginTop: 6 }}>
                Nothing waiting in your wallet.
              </p>
            ) : (
              <>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                  {walletTokens.map((t) => (
                    <span key={t.address} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <Chip tone="wallet">
                        {formatMoney(t.wallet.value, t.decimals, displayDp(t.symbol, t.decimals))} {t.symbol}
                      </Chip>
                      {t.listed === false ? <Chip tone="warn">unverified</Chip> : null}
                    </span>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 16, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                  <Link href="/fund#move" style={{ textDecoration: 'none' }}>
                    <Button variant="soft" size="sm">
                      Move to trading balance
                    </Button>
                  </Link>
                  <Link href="/send" className="tiny">
                    Send from your wallet
                  </Link>
                </div>
              </>
            )}
          </Card>
        </div>

        {/* 2-column grid (design §5.2): Markets first — also first on mobile — then
            Recent activity. `.split` collapses to one column under the shared
            breakpoint, so the DOM order above is also the mobile order. */}
        <div className="split">
          <Card title="Markets" className="rise" style={{ animationDelay: '240ms' }}>
            <div className="list" style={{ marginTop: 6 }}>
              {MARKETS.map((market) => {
                // MON/AUSD and AUSD/USDC are shown, never traded, and are never in
                // `status.markets` (that array is the tradable allowlist). Their state
                // comes from `disabledMarkets` instead, and the label never says "not
                // listed" — Kuru still lists both (design ground truth, 2026-09-23).
                if (market.role === 'disabled') {
                  const dm = disabledVenueFor(status?.disabledMarkets, market.address);
                  const label = disabledMarketLabel(dm);
                  // "Checking" states pulse (design §3: the one sanctioned
                  // animate-on-its-own chip, because it means "still working").
                  const checking = !dm || dm.reason === 'unknown';
                  return (
                    <Row
                      key={market.key}
                      leading={
                        <TokenIcon address={market.baseAddress} symbol={market.base} />
                      }
                      title={market.symbol}
                      subtitle={label}
                      trailing={
                        <Chip tone="warn" pulse={checking}>
                          {dm?.reason === 'empty' ? 'Empty book' : label}
                        </Chip>
                      }
                    />
                  );
                }

                const venue = venueFor(status?.markets, market.address);
                const stateLabel = marketStateLabel(venue?.state);
                const checking = venue === undefined;
                return (
                  <Link
                    key={market.key}
                    href={`/trade/${market.key}`}
                    style={{ textDecoration: 'none', color: 'inherit' }}
                  >
                    <Row
                      leading={
                        <TokenIcon address={market.baseAddress} symbol={market.base} />
                      }
                      title={market.symbol}
                      // The market's own live state, read per market — not one probe
                      // speaking for all four, and never a bare "Kuru order book" over
                      // a book that is paused or empty.
                      subtitle={
                        market.status !== 'live' ? 'Not deployed yet' : stateLabel
                      }
                      trailing={
                        market.status !== 'live' ? (
                          <Chip tone="warn">Soon</Chip>
                        ) : venue?.state === 'tradable' ? (
                          <Chip>Trade</Chip>
                        ) : venue?.state === 'paused' ? (
                          <Chip tone="warn">Paused</Chip>
                        ) : venue?.state === 'empty' || venue?.state === 'one-sided' ? (
                          <Chip tone="warn">No book</Chip>
                        ) : (
                          // Read and could not be established, or not read yet. Either
                          // way this is not a market to present as ready (ITEM 5b).
                          <Chip tone="warn" pulse={checking}>
                            {stateLabel}
                          </Chip>
                        )
                      }
                    />
                  </Link>
                );
              })}
            </div>
          </Card>

          {/* ITEM 3, then ITEM 4a. The five most recent, each linking into /activity at
              its own row. This card used to assert "No positions yet" without reading
              anything at all. */}
          <Card
            title="Recent activity"
            action={
              <Link href="/activity" className="tiny" style={{ color: 'var(--accent)' }}>
                See all
              </Link>
            }
            className="rise"
            style={{ animationDelay: '280ms' }}
          >
            {activity.status === 'loading' ? (
              <Skeleton rows={2} />
            ) : (
              <ActivityList rows={activity.rows} limit={5} />
            )}
          </Card>
        </div>

        <InstallPrompt onMessage={setToast} />
      </div>
      <Toast message={toast ?? ''} show={Boolean(toast)} onDismiss={() => setToast(undefined)} />
    </Chrome>
  );
}
