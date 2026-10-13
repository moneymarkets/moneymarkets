'use client';

import { useState } from 'react';
import { Card, Segmented, Toast } from '@tradepro/ui';
import { SignedOut } from '../../components/SignedOut';
import { useSession } from '../../lib/session';
import { useDepositArrivals } from '../../lib/useDepositArrivals';
import { DirectDepositCard } from './DirectDepositCard';
import { RoutePicker } from './RoutePicker';
import { RecentDeposits } from '../../components/RecentDeposits';
import { TopUpCard } from './TopUpCard';
import type { TicketState as MoveState } from '../../lib/ticket';

type Method = 'monad' | 'chain' | 'move';

/**
 * `/fund` — Add money (design §5.3, spec §7.2).
 *
 * ## Two ways in, and that is the whole screen
 *
 * **Already on Monad** — send to your own address. No bridge, no vendor, no quote and
 * nothing that can refuse it. It is first because it depends on nobody.
 *
 * **Bring it from another chain** — `RoutePicker`: pick the asset, the chain and the
 * amount, and every rail that can carry it is asked in parallel. The card shows what
 * each one actually answered, refusals included, in the vendor's own words.
 *
 * ## What used to be here
 *
 * Four tiles named after vendors' routes — USDT on Tron, USDC on Base, SOL on Solana,
 * AUSD on Base — each with its own quote flow, its own deposit card and its own idea of
 * what could go wrong. All four spoke to the same solver network, which on 2026-09-11
 * was still answering every one of them:
 *
 * ```
 * POST /v0/quote  $5 · $20 · $100 · $1000 Base USDC → Monad
 *   400  Temporary swap limits: minimum swap amount is $1,000
 * ```
 *
 * So they were four tiles offering a route that could not carry an ordinary deposit,
 * and a user had no way to learn that except by typing an amount into each in turn.
 * That network is now one rail among several behind the picker: it is asked, it
 * refuses, and its sentence appears under "Not available" beside the rails that will
 * carry the money. Nothing was lost — the deposit-address flow, the watcher and the
 * refund handling all moved to the rail interface, which is what the picker executes
 * through.
 *
 * ## No minimum is enforced here, on purpose
 *
 * This screen holds no floor, caches none, and pre-checks nothing. Every amount the
 * user types goes to the vendors and only their answers are shown — the owner's
 * instruction on 2026-09-09, after a floor read from one refusal and cached per route
 * blocked amounts the network would in fact have priced. A refusal is reported with the
 * vendor's own sentence verbatim (D124), and never re-used as a rule.
 */

export function FundScreen() {
  const session = useSession();
  const [toast, setToast] = useState<string | undefined>();
  // The move's own state, lifted out of TopUpCard so a caller can drive a step list
  // from a transaction and a margin read rather than from a swap status. Passed to
  // `RoutePicker` -> `DepositProgress`, which drives the tracker's last step from it.
  const [moveState, setMoveState] = useState<MoveState | undefined>();
  const [moveTxHash, setMoveTxHash] = useState<string | undefined>();
  // Which method tab is in front. All three methods below stay mounted regardless —
  // see `fund.css`'s `.pg-fund-method` — so this only ever toggles which one shows.
  const [method, setMethod] = useState<Method>('monad');

  // Called before any early return: hooks may not be conditional, and this screen
  // returns early when signed out.
  //
  // This is the screen where somebody is actually waiting for money to land, and it
  // was the one screen that said nothing when it did — no balance poll runs here, so
  // the balance-comparison watcher on Home and Portfolio never fired. This listens to
  // the deposit watcher instead, and writes the row and the notification itself.
  useDepositArrivals(session.account?.address);


  if (session.status !== 'signed-in' || !session.account) {
    return (
      <div className="page">
        <Header />
        <SignedOut />
      </div>
    );
  }

  const recipient = session.account.address;

  /**
   * Brings "From my wallet" to the front and scrolls to it — used by both the direct
   * deposit's and the tracker's own "Move ... to your trading balance" actions, now
   * that the three methods are tabs rather than one long page. `requestAnimationFrame`
   * waits for the tab's `display: none` to lift before measuring where to scroll.
   */
  function goToMove() {
    setMethod('move');
    requestAnimationFrame(() => {
      document.getElementById('move')?.scrollIntoView({ behavior: 'smooth' });
    });
  }

  return (
    <div className="page pg-fund">
      <Header />

      <div className="pg-fund-grid">
        <Card className="pg-fund-left">
          <Segmented
            label="How to add money"
            value={method}
            onChange={setMethod}
            options={[
              { value: 'monad', label: 'Send on Monad' },
              { value: 'chain', label: 'From another chain' },
              { value: 'move', label: 'From my wallet' },
            ]}
          />

          <div className={method === 'monad' ? 'pg-fund-method on' : 'pg-fund-method'}>
            <DirectDepositCard account={recipient} onGoToMove={goToMove} />
          </div>

          <div className={method === 'chain' ? 'pg-fund-method on' : 'pg-fund-method'}>
            <RoutePicker
              account={recipient}
              moveState={moveState}
              moveTxHash={moveTxHash}
              onGoToMove={goToMove}
            />
          </div>

          {/* TopUpCard itself carries the zero/error/funded states (item 3c), so there
              is no "nothing to move" gate here that could hide it while real money sat
              in the wallet. The "Move to trading balance" link on Home still targets
              `#move`, which is why the id stays on this pane and not on the tab button. */}
          <div
            id="move"
            style={{ scrollMarginTop: 16 }}
            className={method === 'move' ? 'pg-fund-method on' : 'pg-fund-method'}
          >
            <TopUpCard
              account={session.account}
              onDone={(message) => setToast(message)}
              onProgress={(state, txHash) => {
                setMoveState(state);
                setMoveTxHash(txHash);
              }}
            />
          </div>
        </Card>

        <aside className="stack pg-fund-right">
          <Card title="Refunds">
            <p className="small" style={{ marginTop: 6 }}>
              If a deposit arrives short, late, or after the price has lapsed, the bridge
              returns it to the address it came from. Every attempt stays in the list below
              with its outcome, whatever that outcome was. Nothing disappears quietly.
            </p>
          </Card>

          <RecentDeposits recipient={recipient} />
        </aside>
      </div>

      <Toast message={toast ?? ''} show={Boolean(toast)} onDismiss={() => setToast(undefined)} />
    </div>
  );
}

function Header() {
  return (
    <div style={{ paddingTop: 6 }}>
      <h2>Add money</h2>
      <p className="tiny">Arrives as dollars, ready to trade</p>
    </div>
  );
}
