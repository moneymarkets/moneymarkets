'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Card, Chip, Notice, Row, Skeleton } from '@tradepro/ui';
import { MAINNET, monad } from '@tradepro/core';
import { Chrome } from '../../components/Chrome';
import { apiUrl } from '../../lib/basePath';
import { MARKETS } from '../../lib/markets';

/**
 * `/help` — somewhere to go when stuck (ITEM 10).
 *
 * The one page in the app that explains itself. Everything else states a fact at the
 * point it matters; this is for the person who wants the whole shape of it, or who has
 * hit something and needs to know whether it is broken or working as intended.
 *
 * ## The limitations section is read, not written
 *
 * A page listing "current known limitations" as static prose is a page that starts
 * lying the day something changes, and the two that matter here both move: the solver
 * network's minimum is theirs and has moved twice already, and a market's paused state
 * is the venue's and can change in a block. So both are read live — the solver floor
 * from `/api/fund/routes`, which carries the network's own verbatim sentence, and
 * market state from `/api/status`, which probes each book. When a read fails, the
 * section says it could not read rather than showing a stale reassurance.
 */

interface RouteProbe {
  readonly state: string;
  readonly message?: string;
}
interface RouteRow {
  readonly key: string;
  readonly symbol: string;
  readonly chain: string;
  readonly probe?: RouteProbe;
}
interface StatusMarket {
  readonly market: string;
  readonly state: string;
}

const explorer = monad.blockExplorers.default.url;
const addressUrl = (a: string) => `${explorer}/address/${a}`;

export default function HelpPage() {
  const [routes, setRoutes] = useState<readonly RouteRow[] | undefined>();
  const [markets, setMarkets] = useState<readonly StatusMarket[] | undefined>();
  const [readFailed, setReadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [r, s] = await Promise.all([
          fetch(apiUrl('/api/fund/routes'), { cache: 'no-store' }),
          fetch(apiUrl('/api/status'), { cache: 'no-store' }),
        ]);
        if (cancelled) return;
        if (r.ok) setRoutes(((await r.json()) as { sources: RouteRow[] }).sources);
        else setReadFailed(true);
        if (s.ok) setMarkets(((await s.json()) as { markets: StatusMarket[] }).markets);
        else setReadFailed(true);
      } catch {
        if (!cancelled) setReadFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // The solver network states one floor across its routes; whichever route reports it,
  // the sentence is theirs and is shown as theirs.
  //
  // Only `state === 'unavailable'` is the network actually answering and refusing —
  // that is the one case `lib/server/probe.ts` puts the network's own sentence in
  // `message`. `state === 'unprobed'` is this app's own probe failing to get an
  // answer at all (a timeout, a network error, a probe defect) and `message` there is
  // our own text, not theirs — attributing it to "NEAR Intents said" was High #20.
  const floorMessage = routes?.find((r) => r.probe?.state === 'unavailable' && r.probe.message)
    ?.probe?.message;
  const pausedMarkets = (markets ?? []).filter((m) => m.state === 'paused');
  const emptyMarkets = (markets ?? []).filter((m) => m.state === 'empty');
  const nameOf = (address: string) =>
    MARKETS.find((m) => m.address?.toLowerCase() === address.toLowerCase())?.symbol ?? address;

  return (
    <Chrome>
      <div className="page">
        <div className="between" style={{ paddingTop: 6 }}>
          <div>
            <h2>Help</h2>
            <p className="tiny">What this is, what it uses, and what is not working today</p>
          </div>
        </div>

        <Card title="What this app is">
          <p className="small" style={{ marginTop: 6 }}>
            It is a wallet and a trading screen for Kuru, a spot order book on Monad. You sign in
            with a passkey — a fingerprint or a face, no seed phrase to write down on day one — and
            the app creates an account on Monad for you.
          </p>
          <p className="small" style={{ marginTop: 8 }}>
            You add dollars from another chain, move them into your Kuru trading balance, and buy
            and sell against a real order book. Every transaction is signed by your own key and sent
            by us on your behalf, so you never have to hold MON to pay a network fee.
          </p>
          <p className="small" style={{ marginTop: 8 }}>
            Nothing here custodies your money. The account is yours, the key is on your device, and
            every balance shown is read from the chain rather than from a database of ours.
          </p>
        </Card>

        <Card title="Network fees">
          <p className="small" style={{ marginTop: 6 }}>
            Every account gets 20 free actions per day — placing or cancelling an order, moving
            money into your trading balance, or a swap — counted on a rolling 24 hours, not a
            calendar day. <b>Sending, withdrawing and cancelling an order are always free</b> and
            never count against the 20, however many you do.
          </p>
          <p className="small" style={{ marginTop: 8 }}>
            Once those 20 are used for the day, an action that would otherwise be free instead
            carries its own network fee, paid from your trading balance in USDC or AUSD. The fee is
            the real cost of the gas that action needs, plus 20%, rounded up to the nearest tenth of
            a cent, with a minimum of half a cent — you see the exact figure before it is charged,
            on the same screen as the action. Your free actions renew as the oldest ones roll out of
            the last 24 hours.
          </p>
          <p className="small" style={{ marginTop: 8 }}>
            You always see the real amount before you sign, never a placeholder. If your trading
            balance cannot cover the fee, the action is refused rather than sent unpaid — nothing
            here can leave you owing money.
          </p>
        </Card>

        <Card title="The contracts it uses">
          <p className="tiny muted" style={{ marginTop: 6 }}>
            All on Monad, chain {monad.id}. Every one of these is worth checking for yourself.
          </p>
          <div className="list" style={{ marginTop: 8 }}>
            <ContractRow
              title="Kuru MarginAccount"
              subtitle="Holds your trading balance. Deposits, withdrawals and settlement."
              address={MAINNET.kuru.marginAccount}
            />
            {MARKETS.filter((m) => m.status === 'live' && m.address).map((m) => (
              <ContractRow
                key={m.key}
                title={`${m.symbol} order book`}
                subtitle="One Kuru OrderBook contract"
                address={m.address as string}
              />
            ))}
            <ContractRow
              title="AUSD"
              subtitle="A dollar stablecoin issued by Agora. One AUSD is one dollar."
              address={MAINNET.tokens.AUSD.address}
            />
            <ContractRow
              title="USDC"
              subtitle="Circle's dollar on Monad"
              address={MAINNET.tokens.USDC.address}
            />
            <ContractRow
              title="USDT0"
              subtitle="Tether's dollar on Monad"
              address={MAINNET.tokens.USDT0.address}
            />
          </div>
        </Card>

        <Card title="If you lose your device">
          <p className="small" style={{ marginTop: 6 }}>
            Your passkey is the only key to this account. It lives on your device and in whatever
            your device syncs to — an iCloud Keychain, a Google Password Manager, a hardware key.
            Signing in on a new device works as long as your passkey is there.
          </p>
          <p className="small" style={{ marginTop: 8 }}>
            If you lose every device that has it, the 24-word recovery phrase is what is left. You
            can read it at any time in{' '}
            <Link href="/settings">Settings, under Back up your account</Link>. It asks for your
            passkey first, every time, and it is shown blurred until you tap to reveal it.
          </p>
          <p className="small" style={{ marginTop: 8 }}>
            Be clear about what that phrase does. It is a standard BIP-39 phrase on the usual
            Ethereum derivation path, so it reproduces this exact address in any standard wallet and
            gives whoever holds it full control of the money. What it does not do — yet — is sign
            you back in here: this app has no phrase sign-in, only passkeys. So the phrase recovers
            your funds in another wallet rather than your access to this app.
          </p>
          <p className="small" style={{ marginTop: 8 }}>
            Two things to expect in that other wallet. The account is delegated under EIP-7702 and
            therefore carries code, which some wallets warn about; the key still signs normally. And
            nobody sponsors your fees outside this app, so the account needs some MON before it can
            transact — and because Monad requires a delegated account to hold a MON reserve, sending
            the last of it out is refused by the network.
          </p>
          <p className="small" style={{ marginTop: 8 }}>
            Write the words on paper and keep them somewhere only you can reach. We never see them,
            never store them, and cannot recover them for you.
          </p>
        </Card>

        <Card title="What is not working today">
          {routes === undefined && markets === undefined && !readFailed ? (
            <Skeleton rows={3} />
          ) : (
            <>
              {readFailed ? (
                <div style={{ marginTop: 6 }}>
                  <Notice tone="warn">
                    This section could not be read just now, so it is not showing anything. It is
                    read live rather than written down, because both of the things it reports change
                    without notice.
                  </Notice>
                </div>
              ) : null}

              {floorMessage ? (
                <div style={{ marginTop: 6 }}>
                  <p className="small" style={{ margin: '0 0 6px' }}>
                    <b>Adding money from another chain has a minimum right now.</b> It is the solver
                    network&rsquo;s limit, not ours, and it is temporary. Their words:
                  </p>
                  <Notice tone="warn">NEAR Intents said: &ldquo;{floorMessage}&rdquo;</Notice>
                  <p className="tiny muted" style={{ marginTop: 6 }}>
                    Read from them a moment ago, not from a note in our code. Direct deposits
                    straight to Monad have no minimum and are unaffected.
                  </p>
                </div>
              ) : null}

              {pausedMarkets.length > 0 ? (
                <p className="small" style={{ marginTop: 10 }}>
                  <b>Paused by the venue:</b>{' '}
                  {pausedMarkets.map((m) => nameOf(m.market)).join(', ')}. Kuru has halted trading
                  on {pausedMarkets.length === 1 ? 'it' : 'them'}. Nothing can be sent there and
                  nothing you hold is affected.
                </p>
              ) : null}

              {emptyMarkets.length > 0 ? (
                <p className="small" style={{ marginTop: 10 }}>
                  <b>No orders resting:</b> {emptyMarkets.map((m) => nameOf(m.market)).join(', ')}.
                  The book is open and empty, so there is nothing to trade against yet.
                </p>
              ) : null}

              <p className="small" style={{ marginTop: 10 }}>
                <b>MON cannot be sent out of this account.</b> It is an EIP-7702 account and Monad
                requires those to keep a native balance in reserve, so the network refuses the
                transfer. Tokens are unaffected.
              </p>
              <p className="small" style={{ marginTop: 10 }}>
                <b>There is a cap on what we will pay fees for.</b> A single order or send above it
                is refused, and the refusal names the figure. Split it into two if you hit it.
              </p>

              {!readFailed && !floorMessage && pausedMarkets.length === 0 ? (
                <p className="tiny muted" style={{ marginTop: 10 }}>
                  Nothing else is currently limited. Every market read as tradable and the deposit
                  routes reported no minimum.
                </p>
              ) : null}
            </>
          )}
        </Card>

        <Card title="If you are still stuck">
          <p className="small" style={{ marginTop: 6 }}>
            Every action you take shows its transaction hash, and every one links to the explorer.
            That hash is the thing to keep: under this account model the transaction is sent by a
            bundler, so it never appears under your own address on the explorer, and the hash is the
            only reliable way to find it.
          </p>
          <div className="list" style={{ marginTop: 10 }}>
            <Row
              title="Your own record of everything"
              subtitle="Every deposit, trade, transfer and withdrawal this app watched happen"
              trailing={
                <Link href="/portfolio" style={{ textDecoration: 'none' }}>
                  <Chip>Activity</Chip>
                </Link>
              }
            />
            <Row
              title="Monad explorer"
              subtitle="Read any address or transaction for yourself"
              trailing={
                <a className="tiny" href={explorer} target="_blank" rel="noreferrer">
                  Open
                </a>
              }
            />
            <Row
              title="Report a problem"
              subtitle="Send the transaction hash and what you expected to happen"
              trailing={
                <a
                  className="tiny"
                  href="https://github.com/moneymarkets/moneymarkets/issues"
                  target="_blank"
                  rel="noreferrer"
                >
                  Report
                </a>
              }
            />
          </div>
        </Card>
      </div>
    </Chrome>
  );
}

function ContractRow({
  title,
  subtitle,
  address,
}: {
  title: string;
  subtitle: string;
  address: string | undefined;
}) {
  if (!address) return null;
  return (
    <Row
      title={title}
      subtitle={subtitle}
      trailing={
        <a className="tiny" href={addressUrl(address)} target="_blank" rel="noreferrer">
          View
        </a>
      }
    />
  );
}
