'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, Chip, Notice, Skeleton } from '@tradepro/ui';
import { apiUrl } from '../../lib/basePath';
import { formatMoney } from '../../lib/format';

/**
 * `/rails` — what every funding rail is doing, read live.
 *
 * ## Why this page exists
 *
 * The answer to "which rails work today" lived in reports somebody had typed, and those
 * reports went stale within a day, twice. deBridge and Mayan were both recorded as
 * permanently unable to carry Monad on the same morning they were quoting it. Relay was
 * described as having funded deposits that Relay itself says it never saw.
 *
 * Every one of those was a true observation that stopped being true. A page that asks the
 * vendors on load cannot go stale that way: the numbers are from a minute ago at worst,
 * and the parts that **are** remembered — the R9 evidence — carry the date they were last
 * confirmed and go amber when nobody has re-checked them in a fortnight.
 *
 * ## Two columns that mean different things
 *
 * **Live** is what the vendor said just now. **Recorded** is what has been proven about
 * the rail over time, in A8.1's three words. A rail can be answering happily and still be
 * EXISTS, because quoting is not sending — that gap is the most important thing on the
 * page and it is why the two columns sit next to each other rather than being merged into
 * one reassuring green tick.
 *
 * No account data is rendered. The watcher is counts, the environment is key names with a
 * yes or no, and there is not a single address on the page.
 */

interface LiveRow {
  rail: string;
  answering: boolean;
  declined?: boolean;
  reason?: string;
  amountOut?: string;
  outToken?: string;
  etaSeconds?: number;
  needsWallet?: boolean;
  executable?: boolean;
  fees?: { label: string; amount: string; token: string }[];
}

interface EvidenceRow {
  rail: string;
  displayName: string;
  needsWallet: boolean;
  state: 'EXERCISED' | 'EXISTS' | 'MISSING';
  evidence: string;
  checkedOn: string;
}

interface Payload {
  readAt: number;
  buildId: string;
  reference: { asset: string; chain: string; amount: string; decimals: number };
  live: LiveRow[];
  routerError?: string;
  evidence: EvidenceRow[];
  watcher: Record<string, number | string>;
  env: { key: string; configured: boolean }[];
}

const STATE_TONE: Record<EvidenceRow['state'], 'up' | 'acc' | 'warn'> = {
  EXERCISED: 'up',
  EXISTS: 'acc',
  MISSING: 'warn',
};

function ageDays(iso: string): number {
  const then = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(then) ? Math.floor((Date.now() - then) / 86_400_000) : Number.NaN;
}

export default function RailsStatusPage() {
  const [data, setData] = useState<Payload | undefined>();
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    void fetch(apiUrl('/api/rails-status'), { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body: Payload) => {
        setData(body);
        setFailed(false);
      })
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  // Re-read while the page is open, so a tab left up does not quietly show an old
  // answer. The endpoint caches for a minute, so this costs one vendor sweep a minute.
  useEffect(() => {
    const id = window.setInterval(load, 60_000);
    return () => window.clearInterval(id);
  }, [load]);

  const byRail = new Map((data?.live ?? []).map((l) => [l.rail, l]));

  return (
    <div className="page">
      <div className="between" style={{ paddingTop: 6 }}>
        <div>
          <h2>Funding rails</h2>
          <p className="tiny">
            {data
              ? `Read ${new Date(data.readAt).toLocaleTimeString()}, refreshes every minute`
              : 'Reading every bridge'}
          </p>
        </div>
        <Chip tone={loading ? 'neutral' : 'acc'}>{loading ? 'Reading' : 'Live'}</Chip>
      </div>

      {failed ? (
        <div style={{ marginTop: 12 }}>
          <Notice tone="warn">
            The status endpoint could not be read. That is this page failing, not
            necessarily the rails.
          </Notice>
        </div>
      ) : null}

      {!data ? (
        <Card title="Asking every bridge">
          <Skeleton rows={6} />
        </Card>
      ) : (
        <>
          <Card title="Right now">
            <p className="tiny muted" style={{ marginTop: 4 }}>
              Every rail asked for the same thing:{' '}
              {formatMoney(BigInt(data.reference.amount), data.reference.decimals, 2)}{' '}
              {data.reference.asset} on {data.reference.chain}, delivered to Monad. Nothing
              is issued and no money moves to produce this.
            </p>

            {data.routerError ? (
              <div style={{ marginTop: 10 }}>
                <Notice tone="warn">{data.routerError}</Notice>
              </div>
            ) : null}

            <div className="stack" style={{ gap: 10, marginTop: 12 }}>
              {data.evidence.map((e) => {
                const live = byRail.get(e.rail);
                const age = ageDays(e.checkedOn);
                return (
                  <div
                    key={e.rail}
                    style={{ paddingBottom: 10, borderBottom: '1px solid var(--line)' }}
                  >
                    <div className="between">
                      <span className="small" style={{ fontWeight: 600 }}>
                        {e.displayName}
                      </span>
                      <Chip tone={STATE_TONE[e.state]}>{e.state}</Chip>
                    </div>

                    <div className="between tiny" style={{ marginTop: 4 }}>
                      <span className="muted">
                        {e.needsWallet ? 'Needs a wallet signature' : 'No wallet needed'}
                      </span>
                      <span>
                        {!live
                          ? // `supports()` returned false for the reference pair. The
                            // OFT rails carry AUSD and USDT, not USDC, so they are not
                            // asked for this one - which is a fact about the pair, not
                            // about the rail being unwell.
                            'does not carry this pair'
                          : live.declined
                            ? 'declined'
                            : !live.answering
                              ? 'no answer'
                              : live.amountOut
                                ? `${formatMoney(
                                    BigInt(live.amountOut),
                                    data.reference.decimals,
                                    6,
                                  )} ${live.outToken} on Monad, ${live.etaSeconds}s`
                                : 'answered'}
                      </span>
                    </div>

                    {/* The vendor's own sentence, never ours. */}
                    {live?.reason ? (
                      <p className="tiny" style={{ margin: '4px 0 0' }}>
                        Said: &ldquo;{live.reason}&rdquo;
                      </p>
                    ) : null}

                    <p className="tiny muted" style={{ margin: '4px 0 0' }}>
                      {e.evidence}
                    </p>

                    <p
                      className="tiny"
                      style={{
                        margin: '4px 0 0',
                        color: age >= 14 ? 'var(--danger, #c0392b)' : undefined,
                      }}
                    >
                      Last confirmed {e.checkedOn}
                      {Number.isFinite(age)
                        ? age === 0
                          ? ' (today)'
                          : ` (${age} day${age === 1 ? '' : 's'} ago)`
                        : ''}
                      {age >= 14 ? ' — worth re-checking' : ''}
                    </p>
                  </div>
                );
              })}
            </div>
          </Card>

          <Card title="The watcher">
            <p className="tiny muted" style={{ marginTop: 4 }}>
              Deposits still being followed up, by rail. Counts only — no addresses and no
              accounts are shown on this page.
            </p>
            <div className="stack" style={{ gap: 6, marginTop: 10 }}>
              {Object.entries(data.watcher).map(([key, value]) => (
                <div className="between tiny" key={key}>
                  <span className="muted">{key}</span>
                  <span className="num">{String(value)}</span>
                </div>
              ))}
            </div>
          </Card>

          <Card title="Configuration">
            <p className="tiny muted" style={{ marginTop: 4 }}>
              Which server-side settings are present. Key names and yes or no — never a
              value, not even partly.
            </p>
            <div className="stack" style={{ gap: 6, marginTop: 10 }}>
              {data.env.map((e) => (
                <div className="between tiny" key={e.key}>
                  <span className="muted">{e.key}</span>
                  <span style={{ color: e.configured ? 'var(--up)' : undefined }}>
                    {e.configured ? 'set' : 'not set'}
                  </span>
                </div>
              ))}
            </div>
            <div className="between tiny" style={{ marginTop: 10 }}>
              <span className="muted">build</span>
              <span className="num">{data.buildId}</span>
            </div>
          </Card>

          <Card title="What the two columns mean">
            <p className="small" style={{ marginTop: 6 }}>
              The number on the right of each rail is what that vendor answered a moment
              ago. The badge is what has been <b>proven</b> about it.
            </p>
            <p className="small" style={{ marginTop: 8 }}>
              <b>EXERCISED</b> means it has carried real money and there is a transaction
              to point at. <b>EXISTS</b> means the code is written and checked against the
              real contract or API, but it has never moved anyone&rsquo;s money.{' '}
              <b>MISSING</b> means it cannot run, with the reason next to it.
            </p>
            <p className="small" style={{ marginTop: 8 }}>
              A rail can be quoting perfectly and still be EXISTS, because quoting is not
              sending. That gap is the point of this page.
            </p>
          </Card>
        </>
      )}
    </div>
  );
}
