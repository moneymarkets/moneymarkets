'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Card, Chip, Row } from '@tradepro/ui';
import { displayDp, formatMoney, shortAddress } from '../lib/format';
import type { UnlistedGroupState, UnlistedRow } from '../lib/wallet/holdingsModel';
import { TokenIcon } from './TokenIcon';

/**
 * "Unlisted tokens" (spec A3): tokens the account holds that no registry source
 * names, in one collapsed group at the bottom of Holdings. Each row shows an
 * "unverified" chip and the contract address, and offers exactly the actions a listed
 * row does; the caller passes those through `actions`. Nothing is deleted or hidden
 * for good: "Hide unlisted" only decides whether the group starts collapsed.
 *
 * The header is the prototype's own toggle idiom, a `button[aria-pressed]` (no
 * collapsible-row class exists in the design system, so none is invented).
 */
export function UnlistedTokensCard({
  group,
  actions,
}: {
  readonly group: UnlistedGroupState;
  /** Trailing controls for a row, identical to a listed row's. */
  readonly actions?: (row: UnlistedRow) => ReactNode;
}) {
  const [open, setOpen] = useState(!group.collapsed);
  // Follow the preference when it changes; a manual open still holds for the session.
  useEffect(() => {
    setOpen((current) => (group.collapsed ? current : true));
  }, [group.collapsed]);

  if (group.count === 0) return null;

  return (
    <Card
      title={
        <button
          type="button"
          aria-pressed={open}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          style={{ background: 'none', border: 0, padding: 0, font: 'inherit', color: 'inherit', cursor: 'pointer' }}
        >
          Unlisted tokens ({group.count}) {open ? '▾' : '▸'}
        </button>
      }
    >
      {open ? (
        <div className="list">
          {group.rows.map((row) => {
            const held = row.wallet.value > 0n ? row.wallet : row.margin;
            const where = row.wallet.value > 0n ? 'in wallet' : 'in trading balance';
            return (
              <Row
                key={row.address}
                leading={<TokenIcon address={row.address} symbol={row.symbol} />}
                title={
                  <span>
                    {row.symbol} <Chip tone="warn">unverified</Chip>
                  </span>
                }
                subtitle={`${shortAddress(row.address)} · ${where}`}
                value={`${formatMoney(held.value, held.decimals, displayDp(row.symbol, held.decimals))} ${row.symbol}`}
                subValue="No price"
                {...(actions ? { trailing: actions(row) } : {})}
              />
            );
          })}
        </div>
      ) : (
        <p className="tiny muted">Not listed by Kuru or Flow. Tap to show.</p>
      )}
    </Card>
  );
}
