'use client';

import Link from 'next/link';
import type { GasChargeRefusalData } from '@tradepro/core';
import { refusalChoices, type GasQuoteResult } from '../lib/wallet/gasCharge';
import { SWAP_INTO_MON_HREF } from '../lib/wallet/freeActionsView';

/**
 * B2c's two live choices, rendered under a gas refusal: "Swap into MON" (opens
 * Swap prefilled per B3 — sponsored always, so it is a real way out whatever
 * bound) and "Add money". Renders nothing unless the refusal actually named the
 * choices (or is the exact no-trading-balance quote state they belong to) — a
 * pricing or configuration failure gets no buttons, because neither would fix it.
 */
export function GasRefusalActions({
  quote,
  refusalData,
}: {
  readonly quote?: GasQuoteResult;
  readonly refusalData?: GasChargeRefusalData;
}) {
  const choices = refusalChoices({
    ...(quote ? { quote } : {}),
    ...(refusalData ? { refusalData } : {}),
  });
  if (choices.length === 0) return null;
  return (
    <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
      {choices.includes('swap-into-mon') ? (
        <Link href={SWAP_INTO_MON_HREF} className="btn primary sm">
          Swap into MON
        </Link>
      ) : null}
      {choices.includes('add-money') ? (
        <Link href="/fund" className="btn ghost sm">
          Add money
        </Link>
      ) : null}
    </div>
  );
}
