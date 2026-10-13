'use client';

import { useState } from 'react';
import { PairIcon as UiPairIcon } from '@tradepro/ui';
import { iconHasFailed, noteIconFailed, tokenIconView } from '../lib/tokenIcon';

/**
 * A token's logo, or its honest fallback, for every place a token appears.
 *
 * The image is always our own `/api/token-icon/<address>` (Kuru's list, then
 * KyberSwap, DexScreener, GeckoTerminal, resolved and resized server-side), so the
 * browser never loads a third-party host. No address, or an image that fails to load
 * (the route answers 404 when no source has one), shows the two-letter mark, never a
 * broken image. 34px in rows, 22px in pills; the caller picks with `size`.
 */
export function TokenIcon({
  address,
  symbol,
  size = 34,
}: {
  address: string | null | undefined;
  symbol: string;
  size?: number;
}) {
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const failed = address ? failedFor === address.toLowerCase() || iconHasFailed(address) : false;
  const view = tokenIconView({ address, symbol, failed });

  if (view.kind === 'mark') {
    return (
      <span
        className="coin"
        style={{
          width: size,
          height: size,
          fontSize: Math.round(size * 0.32),
          background: 'var(--surface-2)',
          color: 'var(--ink-2)',
        }}
        aria-hidden="true"
      >
        {view.text}
      </span>
    );
  }

  return (
    <img
      key={view.src}
      src={view.src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      style={{ borderRadius: '50%', display: 'block', objectFit: 'cover', flex: 'none' }}
      onError={() => {
        if (!address) return;
        noteIconFailed(address);
        setFailedFor(address.toLowerCase());
      }}
    />
  );
}

export interface PairSide {
  readonly address?: string | undefined;
  readonly symbol: string;
  readonly color: string;
}

function side(s: PairSide) {
  const view = tokenIconView({ address: s.address, symbol: s.symbol, failed: s.address ? iconHasFailed(s.address) : false });
  return {
    symbol: s.symbol,
    color: s.color,
    ...(view.kind === 'img'
      ? {
          src: view.src,
          onImageError: () => {
            if (s.address) noteIconFailed(s.address);
          },
        }
      : {}),
  };
}

/** The market pair icon (`.pair-ic`), base over quote, each through the same icon route. */
export function PairIcon({ base, quote }: { base: PairSide; quote: PairSide }) {
  return <UiPairIcon base={side(base)} quote={side(quote)} />;
}
