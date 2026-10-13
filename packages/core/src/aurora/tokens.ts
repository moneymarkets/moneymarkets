import { z } from 'zod';
import type { Address } from 'viem';

/**
 * What can actually be delivered to Monad by the NEAR Intents solver network.
 *
 * Read live from `GET https://1click.chaindefuser.com/v0/tokens` on 2026-09-02:
 * 188 assets across 34 source chains, of which **exactly three** land on Monad.
 * AUSD is not one of them, so every funding route either lands USDC and hops through
 * Kuru's AUSD_USDC book, or comes in as AUSD over LayerZero instead (spec §7).
 *
 * The three entries below are verbatim from that response.
 */

export interface AuroraAsset {
  readonly assetId: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly contractAddress?: Address;
}

export const MONAD_DELIVERABLE_ASSETS: readonly AuroraAsset[] = [
  {
    assetId: 'nep245:v2_1.omni.hot.tg:143_11111111111111111111',
    symbol: 'MON',
    decimals: 18,
  },
  {
    assetId: 'nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx',
    symbol: 'USDC',
    decimals: 6,
    contractAddress: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603',
  },
  {
    assetId: 'nep245:v2_1.omni.hot.tg:143_4EJiJxSALvGoTZbnc8K7Ft9533et',
    symbol: 'USDT0',
    decimals: 6,
    contractAddress: '0xe7cd86e13AC4309349F30B3435a9d337750fC82D',
  },
];

/**
 * Source chains the same response offered, for the funding source picker. `tron`
 * leads the demo (framework §4.5).
 */
export const AURORA_SOURCE_CHAINS = [
  'abs',
  'adi',
  'aleo',
  'aptos',
  'arb',
  'avax',
  'base',
  'bch',
  'bera',
  'bsc',
  'btc',
  'cardano',
  'dash',
  'doge',
  'eth',
  'fogo',
  'gnosis',
  'hypercore',
  'ltc',
  'monad',
  'movement',
  'near',
  'op',
  'plasma',
  'pol',
  'scroll',
  'sol',
  'starknet',
  'stellar',
  'sui',
  'ton',
  'tron',
  'xlayer',
  'xrp',
  'zec',
] as const;

export const ONE_CLICK_TOKENS_URL = 'https://1click.chaindefuser.com/v0/tokens';

const oneClickToken = z.object({
  assetId: z.string(),
  symbol: z.string(),
  decimals: z.number(),
  blockchain: z.string(),
  contractAddress: z.string().optional(),
});

export interface DeliverableDiff {
  readonly added: AuroraAsset[];
  readonly removed: AuroraAsset[];
  readonly unchanged: number;
}

/**
 * FR-18 — the nightly check that the three assets above are still the three assets.
 * A silent addition (AUSD becoming deliverable) or removal (USDC disappearing)
 * changes the whole funding story, so this runs on a schedule and reports rather
 * than being remembered.
 */
export function diffDeliverableAssets(
  payload: unknown,
  known: readonly AuroraAsset[] = MONAD_DELIVERABLE_ASSETS,
): DeliverableDiff {
  const all = z.array(oneClickToken).parse(payload);
  const live = all
    .filter((t) => t.blockchain.toLowerCase() === 'monad')
    .map<AuroraAsset>((t) => ({
      assetId: t.assetId,
      symbol: t.symbol,
      decimals: t.decimals,
      ...(t.contractAddress ? { contractAddress: t.contractAddress as Address } : {}),
    }));

  const knownIds = new Set(known.map((a) => a.assetId));
  const liveIds = new Set(live.map((a) => a.assetId));

  return {
    added: live.filter((a) => !knownIds.has(a.assetId)),
    removed: known.filter((a) => !liveIds.has(a.assetId)).map((a) => ({ ...a })),
    unchanged: live.filter((a) => knownIds.has(a.assetId)).length,
  };
}

export async function fetchDeliverableAssets(
  fetchImpl: typeof fetch = fetch,
): Promise<DeliverableDiff> {
  const res = await fetchImpl(ONE_CLICK_TOKENS_URL);
  if (!res.ok) throw new Error(`1Click token list returned ${res.status}`);
  return diffDeliverableAssets(await res.json());
}

export function assetForSymbol(symbol: string): AuroraAsset | undefined {
  return MONAD_DELIVERABLE_ASSETS.find((a) => a.symbol === symbol);
}
