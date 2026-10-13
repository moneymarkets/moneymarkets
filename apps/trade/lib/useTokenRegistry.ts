'use client';

import { useEffect, useState } from 'react';
import { apiUrl } from './basePath';

/**
 * The token registry as the browser sees it (spec A1): `/api/tokens/registry`, read
 * once per page and shared across mounts. Screens that need to know which tokens Kuru
 * trades (Add money's chips, the Move sheet's "Kuru does not hold this token") read
 * `sources`; everything balance-related reads `useAccountBalances` instead.
 */
export interface RegistryToken {
  readonly address: string;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly logoUrl?: string;
  readonly sources: readonly ('kuru-market' | 'kuru-flow' | 'base')[];
  readonly verified: boolean;
}

interface RegistryState {
  readonly status: 'loading' | 'ready' | 'error';
  readonly tokens: readonly RegistryToken[];
}

let shared: RegistryState | undefined;
let inflight: Promise<RegistryState> | undefined;
const listeners = new Set<(s: RegistryState) => void>();

async function fetchRegistry(): Promise<RegistryState> {
  try {
    const res = await fetch(apiUrl('/api/tokens/registry'), { cache: 'no-store' });
    if (!res.ok) return { status: 'error', tokens: [] };
    const body = (await res.json()) as { tokens: RegistryToken[] };
    return { status: 'ready', tokens: body.tokens };
  } catch {
    return { status: 'error', tokens: [] };
  }
}

function load(): Promise<RegistryState> {
  if (inflight) return inflight;
  inflight = fetchRegistry()
    .then((s) => {
      shared = s;
      for (const l of listeners) l(s);
      return s;
    })
    .finally(() => {
      inflight = undefined;
    });
  return inflight;
}

export function useTokenRegistry(): RegistryState {
  const [state, setState] = useState<RegistryState>(shared ?? { status: 'loading', tokens: [] });
  useEffect(() => {
    listeners.add(setState);
    if (!shared) void load();
    return () => {
      listeners.delete(setState);
    };
  }, []);
  return state;
}

/** The tokens Kuru's own markets trade: what MarginAccount holds and Move in accepts. */
export function kuruTradedTokens(tokens: readonly RegistryToken[]): RegistryToken[] {
  return tokens.filter((t) => t.sources.includes('kuru-market'));
}
