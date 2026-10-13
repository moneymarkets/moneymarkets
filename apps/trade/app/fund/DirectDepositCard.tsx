'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ActionResult, Button, Chip, Notice } from '@tradepro/ui';
import type { Address } from 'viem';
import { QrCode } from '../../components/QrCode';
import { TokenIcon } from '../../components/TokenIcon';
import { apiUrl } from '../../lib/basePath';
import { displayDp, explorerTxUrl, formatMoney } from '../../lib/format';
import { recordActivity } from '../../lib/activityStore';
import { useAccountBalances } from '../../lib/useAccountBalances';
import { kuruTradedTokens, useTokenRegistry } from '../../lib/useTokenRegistry';

/**
 * "Already on Monad" — the funding route that depends on nobody.
 *
 * Every other tile on this screen goes through the 1Click solver network, and on
 * 2026-09-09 that network refused every swap under $1,000 — verified against its own
 * API with this app removed from the path. A plain transfer to the user's own address
 * on Monad has no bridge, no solver, no quote and no minimum. It is the simplest path
 * in the product and it was never specified; this is it.
 *
 * ## What it does not do
 *
 * It does not quote, does not call anything external, and does not reserve anything.
 * The address shown is the account the user is already signed in as — there is nothing
 * to allocate, which is exactly why this route cannot be refused.
 *
 * ## Arrival
 *
 * The shared balances hook already reads every wallet balance in one multicall on a
 * five-second poll. An arrival is that reading going up. The transaction behind it is
 * then looked up over a bounded recent range (`/api/account/incoming`), because a
 * balance that rose tells the user something landed but not what to click on — and
 * under this account model their own address never lists the transfer among their own
 * transactions.
 */

interface Arrival {
  readonly symbol: string;
  readonly amount: bigint;
  readonly decimals: number;
  readonly txHash?: string;
}

export function DirectDepositCard({
  account,
  onGoToMove,
}: {
  account: Address;
  /**
   * Switches Add money to its "From my wallet" tab, so a deposit that just arrived
   * can be moved from somewhere the user can see it, now that the three methods are
   * tabs instead of one long scroll. Falls back to the old scroll-to-`#move` when
   * absent (e.g. a future caller that still renders this standalone).
   */
  onGoToMove?: () => void;
}) {
  const balance = useAccountBalances(account);
  const [copied, setCopied] = useState<string | undefined>();
  const [arrival, setArrival] = useState<Arrival | undefined>();
  /** The last reading each token was seen at. Undefined until the first read lands. */
  const seen = useRef<Record<string, bigint> | undefined>(undefined);

  const tokens = balance.tokens;
  const registry = useTokenRegistry();
  const kuruTokens = kuruTradedTokens(registry.tokens);

  useEffect(() => {
    if (!tokens) return;
    // Any token, by address (spec A2d, D4): whatever arrives here is an arrival.
    const now: Record<string, bigint> = {};
    for (const t of tokens) now[t.address.toLowerCase()] = t.wallet.value;
    const before = seen.current;
    seen.current = now;
    // The first reading is a baseline, never an arrival — otherwise opening the card
    // with money already in the wallet would announce a deposit that never happened.
    if (!before) return;

    for (const t of tokens) {
      const key = t.address.toLowerCase();
      const previous = before[key];
      const value = now[key] ?? 0n;
      if (previous === undefined || value <= previous) continue;
      const gained = value - previous;
      const symbol = t.symbol;
      const decimals = t.decimals;
      setArrival({ symbol, amount: gained, decimals });
      const summary = `Received ${formatMoney(gained, decimals, displayDp(symbol, decimals))} ${symbol}`;
      const isNative = key === '0x0000000000000000000000000000000000000000';

      // The transaction behind it, from a bounded scan. The arrival is already true
      // without it; this only decides whether there is a link to show.
      const lookup = isNative
        ? Promise.resolve(undefined)
        : fetch(apiUrl(`/api/account/incoming?address=${account}&token=${t.address}`), { cache: 'no-store' })
            .then((r) => (r.ok ? r.json() : undefined))
            .then((body: { txHash?: string | null } | undefined) => body?.txHash ?? undefined);
      void lookup
        .then((txHash) => {
          if (txHash) setArrival((a) => (a ? { ...a, txHash } : a));
          recordActivity(account, {
            id: txHash ?? `direct-deposit:${symbol}:${value.toString()}`,
            kind: 'direct-deposit',
            summary,
            amount: gained.toString(),
            decimals,
            symbol,
            token: t.address,
            ...(txHash ? { txHash } : {}),
            at: Date.now(),
          });
        })
        .catch(() => {
          // The arrival stands on the balance read; only the link is missing.
          recordActivity(account, {
            id: `direct-deposit:${symbol}:${value.toString()}`,
            kind: 'direct-deposit',
            summary,
            amount: gained.toString(),
            decimals,
            symbol,
            token: t.address,
            at: Date.now(),
          });
        });
      break;
    }
  }, [tokens, account]);

  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      window.setTimeout(() => setCopied(undefined), 2000);
    } catch {
      setCopied(undefined);
    }
  }

  return (
    <div className="pg-fund-pane">
      {arrival ? (
        <div style={{ marginBottom: 12 }}>
          <ActionResult
            headline={`Received ${formatMoney(arrival.amount, arrival.decimals, arrival.decimals)} ${arrival.symbol}`}
            resultingBalance={`It is in your wallet on Monad. Move it across to trade with it.`}
            {...(arrival.txHash
              ? { txHash: arrival.txHash, explorerUrl: explorerTxUrl(arrival.txHash) }
              : {})}
            actionLabel="Move it to your trading balance"
            onAction={() => {
              if (onGoToMove) {
                onGoToMove();
              } else {
                document.getElementById('move')?.scrollIntoView({ behavior: 'smooth' });
              }
              setArrival(undefined);
            }}
            {...(arrival.txHash
              ? { onCopyHash: () => void copy(arrival.txHash as string, 'Hash copied') }
              : {})}
          />
        </div>
      ) : null}

      <div className="pg-fund-recv">
        <QrCode value={account} title="Your account address on Monad" />
        <div className="pg-fund-recv-addr">
          <div className="between" style={{ gap: 10, flexWrap: 'wrap' }}>
            <h2 style={{ margin: 0 }}>Your account on Monad</h2>
            <Chip tone="ok">No minimum</Chip>
          </div>
          <p className="small" style={{ margin: '6px 0 12px' }}>
            This is your own account on Monad. Anything sent here arrives directly — no
            bridge, no solver, no minimum.
          </p>
          <div className="addr">{account}</div>
          <div style={{ marginTop: 10 }}>
            <Button
              variant="ghost"
              size="sm"
              block
              onClick={() => void copy(account, 'Address copied')}
            >
              {copied === 'Address copied' ? 'Address copied' : 'Copy address'}
            </Button>
          </div>
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <Notice tone="warn">
          Send only on Monad. Tokens sent on another network will not arrive.
        </Notice>
      </div>

      <p className="small" style={{ marginTop: 16, marginBottom: 6, fontWeight: 600 }}>
        Any Monad token. Kuru trades these: USDC, AUSD, USDT0, MON, cbBTC, WETH, XAUt0.
      </p>
      {/* The chips are the registry's own Kuru-market entries, read live, not a copy of
          the sentence above; a token Kuru lists tomorrow appears here without an edit. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {kuruTokens.map((token) => (
          <button
            key={token.address}
            type="button"
            className="chip"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            onClick={() => void copy(token.address, `${token.symbol} contract copied`)}
            title={token.address}
          >
            <TokenIcon address={token.address} symbol={token.symbol} size={18} />
            {copied === `${token.symbol} contract copied` ? 'Copied' : token.symbol}
          </button>
        ))}
      </div>
      <p className="tiny muted" style={{ marginTop: 8 }}>
        Tap a token to copy its contract address. Anything else sent here shows up in your wallet
        too; Kuru cannot hold it, so swap it first to trade.
      </p>

      <p className="tiny muted" style={{ marginTop: 14 }}>
        Anything you send here lands in your wallet.{' '}
        <Link
          href="#move"
          onClick={(e) => {
            if (!onGoToMove) return;
            e.preventDefault();
            onGoToMove();
          }}
        >
          Move it to your trading balance
        </Link>{' '}
        to trade with it.
      </p>
    </div>
  );
}
