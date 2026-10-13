'use client';

import type { GasAllowance } from '../lib/wallet/gasCharge';
import { freeActionsPill } from '../lib/wallet/freeActionsView';

const RING_R = 8;
const RING_C = 2 * Math.PI * RING_R;

/**
 * B4's header counter: the free-actions ring plus count, from the relayer ledger,
 * on every screen at every width (the top bar renders it once; CSS hides the " of
 * N free" suffix under 720px, the mockup's own `.meter-pill .txt` rule — matching
 * design/tradepro-redesign.html rather than the two-mount split this replaces).
 * Red from 15 used. Renders nothing while the ledger has not answered — there is
 * no honest number to show yet, and a placeholder would be a fake value.
 */
export function FreeActionsPill({ allowance }: { readonly allowance: GasAllowance | undefined }) {
  if (!allowance) return null;
  const view = freeActionsPill(allowance.freeActions);
  const { limit, remaining } = allowance.freeActions;
  const fraction = limit > 0 ? Math.max(0, Math.min(1, remaining / limit)) : 0;
  const offset = RING_C * (1 - fraction);
  return (
    <span className={`meter-pill${view.alert ? ' alert' : ''}`} title="Free actions left today">
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true" className="meter-ring">
        <circle className="track" cx="11" cy="11" r={RING_R} />
        <circle
          className="fill"
          cx="11"
          cy="11"
          r={RING_R}
          strokeDasharray={RING_C}
          strokeDashoffset={offset}
          transform="rotate(-90 11 11)"
        />
      </svg>
      <span>
        <b className="num">{Math.max(remaining, 0)}</b>
        <span className="txt num"> of {limit} free</span>
      </span>
      <span className="visually-hidden" style={{ position: 'absolute', left: -9999 }}>
        {view.text}
      </span>
    </span>
  );
}
