'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button, Card, Skeleton } from '@tradepro/ui';
import { Chrome } from '../../components/Chrome';
import { SignedOut } from '../../components/SignedOut';
import { ActivityTable } from '../../components/ActivityTable';
import { ActivityDetail } from '../../components/ActivityDetail';
import { useSession } from '../../lib/session';
import { useAccountBalances } from '../../lib/useAccountBalances';
import { useActivity } from '../../lib/activity';
import { FILTERS, matchesFilter, type FilterKey } from '../../lib/activityView';
import { FailureNotice } from '../../components/FailureNotice';
import { failure } from '../../lib/failures';
import './activity.css';

/**
 * `/activity` — everything that happened, as its own destination (ITEM 4).
 *
 * It used to be a card at the bottom of Portfolio, which put "what happened to my
 * money" behind a scroll on a screen about what the money is worth now. Those are
 * different questions, and the second one gets asked far less often. It is also the
 * screen people open when something has gone wrong, and a place you reach by scrolling
 * somewhere else cannot be linked to — which notifications and `?id=` both need.
 *
 * ## The URL is the state
 *
 * `?id=<rowId>` opens that row's detail directly, so a notification, a support message
 * or a bookmark all land on the same thing. Opening pushes exactly one history entry
 * and closing pops it, so the stack ends the length it started — the modal is a view
 * of this page, not another page, and closing it must not leave an entry the user has
 * to press back through twice.
 *
 * That pairing is also what gives Android's hardware back and the PWA back gesture the
 * behaviour ITEM 4d asks for, at no extra cost: back pops the entry, `popstate` reads
 * the URL, the modal closes — and because the entry exists, back never leaves the app.
 */

const PAGE = 50;

function ActivityView() {
  const session = useSession();
  const account = session.account?.address;
  const activity = useActivity(account);
  // For each row's token icon and "unverified" chip (spec E4), from the one balance source.
  const balance = useAccountBalances(account);
  const params = useSearchParams();

  const [filter, setFilter] = useState<FilterKey>('all');
  const [shown, setShown] = useState(PAGE);

  /**
   * Which row's detail is open, held here and mirrored into the URL.
   *
   * Seeded from `?id=` so a deep link opens the modal on arrival, and kept in step
   * with the URL by the `popstate` listener below. State rather than reading
   * `useSearchParams` on every render, because opening the modal is a
   * `history.pushState` this component makes itself and Next does not re-render for
   * one of those.
   */
  const [openId, setOpenId] = useState<string | undefined>(params?.get('id') ?? undefined);

  const rows = useMemo(
    () => activity.rows.filter((r) => matchesFilter(r, filter)),
    [activity.rows, filter],
  );
  const row = useMemo(() => activity.rows.find((r) => r.id === openId), [activity.rows, openId]);

  const open = useCallback((id: string) => {
    // Exactly one history entry, so exactly one back press closes it.
    window.history.pushState({ activityId: id }, '', `?id=${encodeURIComponent(id)}`);
    setOpenId(id);
  }, []);

  /**
   * Close by going back, not by replacing.
   *
   * Opening pushed an entry; going back pops it, which leaves the history stack the
   * length it was and gives Android's hardware back and the PWA back gesture the
   * behaviour ITEM 4d asks for at no extra cost — back closes the modal, and because
   * the entry exists, it never leaves the app.
   */
  const close = useCallback(() => {
    if (window.history.state?.activityId) window.history.back();
    else setOpenId(undefined);
  }, []);

  useEffect(() => {
    const onPop = () => {
      const id = new URLSearchParams(window.location.search).get('id') ?? undefined;
      setOpenId(id);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  if (session.status !== 'signed-in') {
    return (
      <Chrome>
        <div className="page">
          <h2 style={{ paddingTop: 6 }}>Activity</h2>
          <SignedOut />
        </div>
      </Chrome>
    );
  }

  const visible = rows.slice(0, shown);
  // Real counts, from the rows already loaded for this screen — no extra fetch.
  const counts = Object.fromEntries(
    FILTERS.map((f) => [f.key, f.key === 'all' ? activity.rows.length : activity.rows.filter((r) => matchesFilter(r, f.key)).length]),
  ) as Record<FilterKey, number>;

  return (
    <Chrome>
      <div className="page pg-activity">
        <div className="between rise" style={{ paddingTop: 6 }}>
          <div>
            <h2>Activity</h2>
            <p className="tiny">
              Everything this app watched happen, newest first. Written when it happened, never
              recomputed.
            </p>
          </div>
        </div>

        <Card className="rise" style={{ animationDelay: '80ms' }}>
          <div className="filters act-filters" role="group" aria-label="Filter activity">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                aria-pressed={filter === f.key}
                onClick={() => {
                  setFilter(f.key);
                  setShown(PAGE);
                }}
              >
                {f.label} ({counts[f.key]})
              </button>
            ))}
          </div>

          {/* A source that did not load is named, not hidden. A short list with no
              explanation is how a user concludes a deposit was lost. */}
          {activity.depositsUnavailable ? (
            <div style={{ marginTop: 12 }}>
              <FailureNotice
                failure={failure('RPC_UNAVAILABLE')}
                onRetry={() => activity.refresh()}
              />
              <p className="tiny muted" style={{ marginTop: 6 }}>
                Deposits from other chains are missing from this list. Everything this app
                recorded itself is still here.
              </p>
            </div>
          ) : null}

          <div style={{ marginTop: 12 }}>
            {activity.status === 'loading' ? (
              <Skeleton rows={4} />
            ) : (
              <ActivityTable
                rows={visible}
                tokens={balance.tokens ?? []}
                onOpen={(r) => open(r.id)}
                emptyText={
                  filter === 'all'
                    ? 'Nothing yet. Your trades, deposits and transfers will appear here.'
                    : 'Nothing of this kind yet. Try another filter.'
                }
              />
            )}
          </div>

          {rows.length > visible.length ? (
            <div style={{ marginTop: 14 }}>
              <Button variant="soft" block onClick={() => setShown((n) => n + PAGE)}>
                Load more
              </Button>
              <p className="tiny muted" style={{ marginTop: 8, textAlign: 'center' }}>
                Showing {visible.length} of {rows.length}
              </p>
            </div>
          ) : null}
        </Card>
      </div>

      <ActivityDetail row={row} open={row !== undefined} onClose={close} />
    </Chrome>
  );
}

export default function ActivityPage() {
  // `useSearchParams` needs a Suspense boundary in the App Router.
  return (
    <Suspense
      fallback={
        <Chrome>
          <div className="page">
            <h2 style={{ paddingTop: 6 }}>Activity</h2>
            <Card>
              <Skeleton rows={4} />
            </Card>
          </div>
        </Chrome>
      }
    >
      <ActivityView />
    </Suspense>
  );
}
