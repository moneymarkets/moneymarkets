'use client';

import Link from 'next/link';
import { displayDp, formatMoney } from '../lib/format';

/** One asset the account holds in its own wallet — not yet in the margin account. */
export interface WalletHolding {
  readonly symbol: string;
  readonly decimals: number;
  readonly balance: bigint;
  /** From the registry (spec A5); the line is text, so this is carried, not drawn. */
  readonly iconUrl?: string | null;
  /** False for a token no registry source lists (spec A3). */
  readonly listed?: boolean;
}

/**
 * Money the account holds in its own wallet, which an order cannot spend yet.
 *
 * ## Why this is a required state, not a nicety
 *
 * The hero on Home reads the Kuru MarginAccount, because that is what an order can
 * actually spend. That is right, and it was also how an account holding 1.002926 USDC
 * came to see **0.00** on every screen: the money had arrived from another chain,
 * the app had just helped acquire it, and then the app did not mention it anywhere.
 *
 * So: any non-zero wallet balance is always shown. If it cannot be traded yet that is
 * a label — "not yet trading" — and a link to the screen that moves it. It is never a
 * reason to omit it. A user who cannot see what they own does not trust the number
 * they can see either.
 *
 * A balance that failed to read is omitted rather than drawn as zero, for the same
 * reason the hero does it: zero is a claim about the account.
 *
 * The link targets `#move`, not `/fund`. It used to land at the top of the funding
 * screen, where only the source picker is visible and the move card was at the
 * bottom of a later step — so the link went somewhere that did not contain the
 * thing it promised.
 */
export function WalletHoldings({
  holdings,
  className,
}: {
  readonly holdings: readonly WalletHolding[] | undefined;
  readonly className?: string;
}) {
  const held = (holdings ?? []).filter((h) => h.balance > 0n);
  if (held.length === 0) return null;

  // Display precision per token (spec F2), and an unlisted token says so inline.
  const parts = held.map(
    (h) =>
      `${formatMoney(h.balance, h.decimals, displayDp(h.symbol, h.decimals))} ${h.symbol}${
        h.listed === false ? ' (unverified)' : ''
      }`,
  );

  return (
    <div className={className ?? 'tiny muted'} style={{ marginTop: 6 }}>
      <span>In wallet, not yet trading: </span>
      <span className="num">{parts.join(', ')}</span>{' '}
      <Link href="/fund#move" className="link">
        Move to trading balance
      </Link>
    </div>
  );
}
