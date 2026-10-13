'use client';

import { useEffect, useRef, useState } from 'react';
import type { Address } from 'viem';
import { apiUrl } from './basePath';
import type { TokenAmount } from './useAccountBalances';

/**
 * The lazy per-row price (spec A4): a token with no on-chain book is priced by a Kuru
 * Flow quote only once its row is on screen, from `/api/token/price`, which caches the
 * answer for 30 seconds server-side. Attach `ref` to the row. `price` is `undefined`
 * until asked, `null` when Flow cannot price the token ("No price").
 */
export interface LazyTokenPrice {
  readonly ref: (node: HTMLElement | null) => void;
  readonly price: TokenAmount | null | undefined;
}

const REFRESH_MS = 30_000;

export function useLazyTokenPrice(input: {
  readonly account: Address | undefined;
  readonly address: Address;
  /** False when the balance read already priced the row: nothing to ask. */
  readonly enabled: boolean;
}): LazyTokenPrice {
  const [price, setPrice] = useState<TokenAmount | null | undefined>(undefined);
  const [visible, setVisible] = useState(false);
  const observed = useRef<HTMLElement | null>(null);
  const [node, setNode] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!node || !input.enabled || typeof IntersectionObserver === 'undefined') return;
    observed.current = node;
    const observer = new IntersectionObserver((entries) => {
      setVisible(entries.some((e) => e.isIntersecting));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [node, input.enabled]);

  useEffect(() => {
    if (!visible || !input.enabled || !input.account) return;
    let cancelled = false;
    let timer: number | undefined;
    const account = input.account;
    async function ask() {
      try {
        const res = await fetch(apiUrl(`/api/token/price?address=${input.address}&account=${account}`), {
          cache: 'no-store',
        });
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as { price: { value: string; decimals: number } | null };
        if (cancelled) return;
        setPrice(body.price === null ? null : { value: BigInt(body.price.value), decimals: body.price.decimals });
      } catch {
        // Leave whatever was shown; the next visible tick asks again.
      }
      if (!cancelled) timer = window.setTimeout(() => void ask(), REFRESH_MS);
    }
    void ask();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [visible, input.enabled, input.account, input.address]);

  return { ref: setNode, price };
}
