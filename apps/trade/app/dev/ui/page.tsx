'use client';

import { useState } from 'react';
import {
  Amount,
  Button,
  Card,
  Chip,
  Coin,
  Field,
  Hero,
  InstallBanner,
  LiveAmount,
  Notice,
  OrderBook,
  Passkey,
  Row,
  Segmented,
  Sheet,
  StepList,
  TicketState,
  Toast,
  type PasskeyState,
} from '@tradepro/ui';
import { formatAusd } from '@tradepro/core';

/**
 * `/dev/ui` — every component in the design system, in both themes.
 *
 * This is the Phase 0 stand-in for Storybook: one route, no extra dependency, and it
 * renders the same components the product screens will use rather than a copy of
 * them. Each block also shows the empty, loading, error and disabled states rule A5
 * requires, so those are designed here rather than improvised in Phase 2.
 */

const BOOK_BIDS = [
  { price: '0.026171', size: '95,515', depth: 1 },
  { price: '0.026170', size: '19,000', depth: 0.2 },
  { price: '0.026153', size: '8,549', depth: 0.09 },
];
const BOOK_ASKS = [
  { price: '0.026176', size: '86,201', depth: 0.9 },
  { price: '0.026179', size: '19,000', depth: 0.2 },
  { price: '0.026194', size: '8,549', depth: 0.09 },
];

const FUND_STEPS = [
  { label: 'Awaiting your deposit', detail: 'We watch the address for you' },
  { label: 'Received on Tron', detail: 'Solvers pick up your intent' },
  { label: 'Swapping to USDC', detail: 'Best price across 30 chains' },
  { label: 'Landing in your Kuru balance', detail: 'Deposited to your margin account' },
  { label: 'Ready to trade', detail: 'Nothing else to do' },
];

export default function DevUiPage() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [bookState, setBookState] = useState<'ok' | 'stale' | 'crossed'>('ok');
  const [ticket, setTicket] = useState(2);
  const [step, setStep] = useState(2);
  const [amount, setAmount] = useState('50.00');
  // Two real figures to count between, so the 900 ms count-up in design 2.4 can be
  // seen and checked rather than taken on trust.
  const [balance, setBalance] = useState(21_689_661_236n);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [toast, setToast] = useState(false);

  const dim = bookState !== 'ok';

  return (
    <div data-theme={theme} style={{ background: 'var(--bg)', minHeight: '100vh' }}>
      <main className="page">
        <div className="between" style={{ paddingTop: 16 }}>
          <h1>Design system</h1>
          <Segmented
            label="Theme"
            value={theme}
            onChange={setTheme}
            options={[
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
          />
        </div>
        <p>
          Every component in `packages/ui`, in the theme you pick. Toggle it: the contrast floor is
          4.5:1 in both.
        </p>

        <Hero label="Available to trade">
          <Amount formatted={formatAusd(21_689_661_236n)} />
          <div className="between" style={{ marginTop: 14 }}>
            <Chip tone="up">+53.12 today</Chip>
            <span className="tiny muted">Held on Kuru</span>
          </div>
          <div className="grid2" style={{ marginTop: 18 }}>
            <Button variant="primary">Add money</Button>
            <Button variant="ghost">Trade</Button>
          </div>
        </Hero>

        <Card title="Balance change" action={<Chip tone="acc">900 ms count-up</Chip>}>
          <p className="small" style={{ margin: '6px 0 12px' }}>
            The hero figure animates only when it changes, never on page entry, and lands on the
            exact string it was handed rather than a re-formatted float.
            <code> prefers-reduced-motion </code>
            jumps straight to the new value.
          </p>
          <LiveAmount formatted={formatAusd(balance)} />
          <div className="grid2" style={{ marginTop: 14 }}>
            <Button onClick={() => setBalance((b) => b + 5_312_000_000n)}>Credit 5,312.00</Button>
            <Button
              onClick={() => setBalance((b) => (b > 5_312_000_000n ? b - 5_312_000_000n : b))}
            >
              Debit 5,312.00
            </Button>
          </div>
        </Card>

        <Card title="Buttons" action={<Chip tone="acc">5 variants</Chip>}>
          <div className="grid2" style={{ marginTop: 12 }}>
            <Button variant="primary">Primary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="soft">Soft</Button>
            <Button variant="up">Buy MON</Button>
            <Button variant="down">Sell MON</Button>
            <Button
              variant="primary"
              disabled
              disabledLabel="Move money to your trading balance first"
            >
              Buy MON
            </Button>
          </div>
          <p className="tiny muted" style={{ marginTop: 10 }}>
            A disabled button carries the reason in its own label, not a tooltip.
          </p>
        </Card>

        <Card title="Chips">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
            <Chip>Neutral</Chip>
            <Chip tone="up">Live, finalized</Chip>
            <Chip tone="down">Down 0.3%</Chip>
            <Chip tone="warn">Data paused</Chip>
            <Chip tone="acc">Gas paid for you</Chip>
          </div>
        </Card>

        <Card title="Rows">
          <div className="list" style={{ marginTop: 6 }}>
            <Row
              leading={<Coin symbol="MON" color="#7C5CFF" />}
              title="MON / AUSD"
              subtitle="Kuru order book"
              value="0.02617"
              subValue="+2.4%"
            />
            <Row
              leading={<Coin symbol="WBTC" color="#F7931A" />}
              title="WBTC / AUSD"
              subtitle="Kuru order book"
              value="78,214.00"
              subValue="-0.3%"
            />
            <Row
              title="Address"
              subtitle="0x8b66…401F"
              trailing={<Button size="sm">Copy</Button>}
            />
          </div>
        </Card>

        <Card
          title="Order book"
          action={
            <Segmented
              label="Book state"
              value={bookState}
              onChange={setBookState}
              options={[
                { value: 'ok', label: 'Normal' },
                { value: 'stale', label: 'Stale' },
                { value: 'crossed', label: 'Crossed' },
              ]}
            />
          }
        >
          <OrderBook
            bids={BOOK_BIDS}
            asks={
              bookState === 'crossed'
                ? [{ ...BOOK_ASKS[0]!, price: '0.026100' }, ...BOOK_ASKS.slice(1)]
                : BOOK_ASKS
            }
            mid="0.02617"
            spread={dim ? '—' : 'Spread 1.9 bps'}
            dim={dim}
          />
          {bookState === 'stale' ? (
            <div style={{ marginTop: 10 }}>
              <Notice>
                Prices haven’t updated for 4 seconds. Trading is paused until the feed returns.
              </Notice>
            </div>
          ) : null}
          {bookState === 'crossed' ? (
            <div style={{ marginTop: 10 }}>
              <Notice tone="err">
                The book shows a bid above the best ask, which can’t be right. Trading is paused
                until the data is consistent again.
              </Notice>
            </div>
          ) : null}
        </Card>

        <Card title="Order ticket">
          <Segmented
            label="Side"
            value={side}
            onChange={setSide}
            options={[
              { value: 'buy', label: 'Buy MON', color: 'var(--up)' },
              { value: 'sell', label: 'Sell MON', color: 'var(--down)' },
            ]}
          />
          <div className="grid2" style={{ marginTop: 12 }}>
            <Field id="price" label="Price (AUSD)" value="0.026171" numeric inputMode="decimal" />
            <Field
              id="amount"
              label="Amount (AUSD)"
              value={amount}
              onChange={setAmount}
              numeric
              inputMode="decimal"
            />
          </div>
          <div className="between tiny muted" style={{ marginTop: 8 }}>
            <span>≈ 1,910 MON</span>
            <span>Available 21,689.66</span>
          </div>
          <div className="between tiny" style={{ marginTop: 6 }}>
            <span className="muted">Network fee</span>
            <span style={{ color: 'var(--up)' }}>Paid for you</span>
          </div>
          <div style={{ marginTop: 12 }}>
            <Button
              variant={side === 'buy' ? 'up' : 'down'}
              block
              disabled={dim}
              disabledLabel="Trading paused"
            >
              {side === 'buy' ? 'Buy MON' : 'Sell MON'}
            </Button>
          </div>
          <TicketState
            index={ticket}
            {...(ticket === 3
              ? {
                  error:
                    'Price moved before your order was filled. Review the price and try again.',
                }
              : {})}
          />
          <div className="grid2" style={{ marginTop: 12 }}>
            <Button size="sm" onClick={() => setTicket((t) => Math.max(0, t - 1))}>
              Previous state
            </Button>
            <Button size="sm" onClick={() => setTicket((t) => Math.min(4, t + 1))}>
              Next state
            </Button>
          </div>
        </Card>

        <Card title="Adding money">
          <StepList steps={FUND_STEPS} current={step} />
          <div className="grid2" style={{ marginTop: 12 }}>
            <Button size="sm" onClick={() => setStep((s) => Math.max(0, s - 1))}>
              Back a step
            </Button>
            <Button size="sm" onClick={() => setStep((s) => Math.min(4, s + 1))}>
              Next step
            </Button>
          </div>
        </Card>

        <Card title="Notices">
          <div className="stack" style={{ marginTop: 10 }}>
            <Notice tone="ok">1,199.10 AUSD is ready to trade.</Notice>
            <Notice>Prices haven’t updated for 4 seconds. Trading is paused.</Notice>
            <Notice tone="err">
              This passkey provider can’t create your account. Save the passkey to iCloud Keychain,
              Google Password Manager or 1Password, then try again.
            </Notice>
          </div>
        </Card>

        <Card title="Empty states">
          <div className="stack" style={{ marginTop: 10 }}>
            <p className="small muted">No positions yet. Your first trade will show up here.</p>
            <p className="small muted">No open orders.</p>
            <p className="small muted">
              Deposits, orders and fills will appear here — served from the indexer, correct to the
              cent.
            </p>
          </div>
        </Card>

        <Card title="Passkey">
          <div className="grid2" style={{ marginTop: 10 }}>
            {(['idle', 'pulsing', 'done'] as PasskeyState[]).map((state) => (
              <div key={state}>
                <Passkey state={state} />
                <p className="tiny muted" style={{ textAlign: 'center' }}>
                  {state}
                </p>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Overlays">
          <div className="grid2" style={{ marginTop: 10 }}>
            <Button onClick={() => setSheetOpen(true)}>Open sheet</Button>
            <Button onClick={() => setToast(true)}>Show toast</Button>
          </div>
        </Card>

        <InstallBanner onAdd={() => setToast(true)} />
      </main>

      <Sheet open={sheetOpen} onClose={() => setSheetOpen(false)}>
        <h3>Recovery phrase</h3>
        <p className="small" style={{ margin: '6px 0 14px' }}>
          Write these words down in order. Anyone with them controls your money. Never type them
          into a website.
        </p>
        <div className="words reveal">
          {['ledger', 'orbit', 'velvet', 'canyon', 'quiet', 'sable'].map((word, i) => (
            <span key={word}>
              <i>{i + 1}</i>
              {word}
            </span>
          ))}
        </div>
        <div style={{ marginTop: 14 }}>
          <Button variant="primary" block onClick={() => setSheetOpen(false)}>
            I’ve written it down
          </Button>
        </div>
      </Sheet>

      <Toast message="Order placed" show={toast} onDismiss={() => setToast(false)} />
    </div>
  );
}
