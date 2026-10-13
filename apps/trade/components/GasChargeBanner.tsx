'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Address } from 'viem';
import { Button, Notice } from '@tradepro/ui';
import type { GasAllowance } from '../lib/wallet/gasCharge';
import { freeActionsBanner, SWAP_INTO_MON_HREF } from '../lib/wallet/freeActionsView';

/**
 * B4's banner under the header, app-wide (mounted once in `Chrome.tsx`):
 *
 *   - at 18 used, thin and blinking: "Two free actions left today. Swap into MON
 *     now and every action after that is paid from your own MON." (at 19, the same
 *     banner honestly says "One" — see `freeActionsView.ts`);
 *   - at 20 used: "Your 20 free actions for today are used. Swapping into MON is
 *     still free and gives you MON to pay your own gas. Or pay gas from your
 *     trading balance at cost."
 *
 * Both carry the same Swap link, opening Swap prefilled per B3. Both are gated on
 * `allowance.charging` — a deployment with no fee address never charges, so its
 * copy about paid gas would be false there.
 *
 * Dismissible per account per day, returns on the next threshold or the next daily
 * reset: a dismissal is remembered against the free-actions `used` count and
 * today's date at the moment it was dismissed, in `localStorage` (not
 * `sessionStorage` — a dismissal must survive a reload or a new tab within the same
 * day, not just the current tab), and reappears once another action has actually
 * changed that count, or the date has rolled over — never after some fixed timer
 * regardless of activity.
 *
 * The allowance is passed down from `Chrome.tsx`'s one `useGasAllowance` read —
 * the pill in the header and this banner never disagree about the count.
 */

const DISMISS_KEY = 'tradepro.gasChargeBannerDismissed';

interface Dismissal {
  readonly address: string;
  readonly day: string;
  readonly used: number;
}

/** Today's date (local, `YYYY-MM-DD`) — the same day a dismissal is scoped to. */
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

function readDismissal(): Dismissal | undefined {
  try {
    const raw = window.localStorage.getItem(DISMISS_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<Dismissal>;
    if (
      typeof parsed.address !== 'string' ||
      typeof parsed.day !== 'string' ||
      typeof parsed.used !== 'number'
    ) {
      return undefined;
    }
    return { address: parsed.address, day: parsed.day, used: parsed.used };
  } catch {
    return undefined;
  }
}

function writeDismissal(value: Dismissal): void {
  try {
    window.localStorage.setItem(DISMISS_KEY, JSON.stringify(value));
  } catch {
    // Storage blocked — the banner simply shows again next time; nothing breaks.
  }
}

export function GasChargeBanner({
  address,
  allowance,
}: {
  readonly address: Address | undefined;
  readonly allowance: GasAllowance | undefined;
}) {
  const [dismissal, setDismissal] = useState<Dismissal | undefined>(undefined);

  useEffect(() => {
    setDismissal(readDismissal());
  }, [address]);

  if (!address || !allowance || !allowance.charging) return null;
  const view = freeActionsBanner(allowance.freeActions);
  if (!view) return null;
  if (
    dismissal &&
    dismissal.address === address &&
    dismissal.day === today() &&
    dismissal.used === allowance.freeActions.used
  ) {
    return null;
  }

  return (
    <div className={`app-banner${view.level === 'low' ? ' blink' : ''}`}>
      <Notice tone="warn">
        <span className="app-banner-row">
          <span className="app-banner-text">{view.message}</span>
          <span className="app-banner-actions">
            <Link href={SWAP_INTO_MON_HREF} className="btn primary sm">
              Swap
            </Link>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const next: Dismissal = { address, day: today(), used: allowance.freeActions.used };
                setDismissal(next);
                writeDismissal(next);
              }}
            >
              Dismiss
            </Button>
          </span>
        </span>
      </Notice>
    </div>
  );
}
