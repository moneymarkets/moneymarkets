import type { Address, PublicClient } from 'viem';
import { orderBookAbi } from '../abi/orderBook.js';

/**
 * Market and vault parameters, decoded from the unnamed tuples Kuru returns.
 *
 * The ordering below is the ABI's, cross-checked against a live read of MON/AUSD
 * (`0x131a2e70a5b31a517a74b8c567149bc294470da9`) on 2026-09-02:
 *
 *   [100000000, 10000000000, 0x0000…0000, 18, 0x0000…9012a, 6,
 *    100, 2000000000000, 20000000000000000000, 0, 0]
 *
 * which reads as pricePrecision 1e8, sizePrecision 1e10, base MON (18 decimals),
 * quote AUSD (6 decimals), tick 100, minSize 2e12, maxSize 2e19, fees 0/0 —
 * exactly spec §4.3.
 */
export interface MarketParams {
  readonly pricePrecision: bigint;
  readonly sizePrecision: bigint;
  readonly baseAsset: Address;
  readonly baseDecimals: number;
  readonly quoteAsset: Address;
  readonly quoteDecimals: number;
  /** Raw, in pricePrecision units. */
  readonly tickSize: bigint;
  readonly minSize: bigint;
  readonly maxSize: bigint;
  readonly takerFeeBps: bigint;
  readonly makerFeeBps: bigint;
}

export interface VaultParams {
  readonly vault: Address;
  readonly vaultBestBid: bigint;
  readonly bidPartiallyFilledSize: bigint;
  readonly vaultBestAsk: bigint;
  readonly askPartiallyFilledSize: bigint;
  readonly vaultBidOrderSize: bigint;
  readonly vaultAskOrderSize: bigint;
  readonly spread: bigint;
}

type MarketParamsTuple = readonly [
  number | bigint, // 0 pricePrecision  (uint32)
  bigint, //          1 sizePrecision   (uint96)
  Address, //         2 baseAsset
  bigint, //          3 baseDecimals
  Address, //         4 quoteAsset
  bigint, //          5 quoteDecimals
  number | bigint, // 6 tickSize        (uint32)
  bigint, //          7 minSize         (uint96)
  bigint, //          8 maxSize         (uint96)
  bigint, //          9 takerFeeBps
  bigint, //         10 makerFeeBps
];

type VaultParamsTuple = readonly [Address, bigint, bigint, bigint, bigint, bigint, bigint, bigint];

export function decodeMarketParams(tuple: MarketParamsTuple): MarketParams {
  if (tuple.length !== 11) {
    throw new Error(
      `getMarketParams returned ${tuple.length} fields, expected 11. ` +
        'This OrderBook is not the deployment this package was built against.',
    );
  }
  const decimalsOf = (v: bigint, which: string): number => {
    if (v < 0n || v > 36n) throw new Error(`${which} decimals out of range: ${v}`);
    return Number(v);
  };
  const params: MarketParams = {
    pricePrecision: BigInt(tuple[0]),
    sizePrecision: tuple[1],
    baseAsset: tuple[2],
    baseDecimals: decimalsOf(tuple[3], 'base'),
    quoteAsset: tuple[4],
    quoteDecimals: decimalsOf(tuple[5], 'quote'),
    tickSize: BigInt(tuple[6]),
    minSize: tuple[7],
    maxSize: tuple[8],
    takerFeeBps: tuple[9],
    makerFeeBps: tuple[10],
  };
  assertUsableMarketParams(params);
  return params;
}

export function decodeVaultParams(tuple: VaultParamsTuple): VaultParams {
  if (tuple.length !== 8) {
    throw new Error(`getVaultParams returned ${tuple.length} fields, expected 8.`);
  }
  return {
    vault: tuple[0],
    vaultBestBid: tuple[1],
    bidPartiallyFilledSize: tuple[2],
    vaultBestAsk: tuple[3],
    askPartiallyFilledSize: tuple[4],
    vaultBidOrderSize: tuple[5],
    vaultAskOrderSize: tuple[6],
    spread: tuple[7],
  };
}

/** Fail closed (design principle 5) rather than build orders against nonsense. */
export function assertUsableMarketParams(p: MarketParams): void {
  if (p.pricePrecision <= 0n) throw new Error('market has zero pricePrecision');
  if (p.sizePrecision <= 0n) throw new Error('market has zero sizePrecision');
  if (p.tickSize <= 0n) throw new Error('market has zero tickSize');
  if (p.minSize > p.maxSize) throw new Error('market minSize exceeds maxSize');
}

export interface CachedMarketParams extends MarketParams {
  readonly market: Address;
  readonly blockNumber: bigint;
}

/**
 * Read and cache a market's params. Params are fetched once per market per session
 * and stamped with the block they were read at (spec §4.3).
 */
export class MarketParamsCache {
  readonly #cache = new Map<string, CachedMarketParams>();

  constructor(private readonly client: PublicClient) {}

  async get(market: Address, options?: { refresh?: boolean }): Promise<CachedMarketParams> {
    const key = market.toLowerCase();
    const hit = this.#cache.get(key);
    if (hit && !options?.refresh) return hit;

    const [tuple, blockNumber] = await Promise.all([
      this.client.readContract({
        address: market,
        abi: orderBookAbi,
        functionName: 'getMarketParams',
      }) as Promise<MarketParamsTuple>,
      this.client.getBlockNumber(),
    ]);

    const entry: CachedMarketParams = {
      ...decodeMarketParams(tuple),
      market,
      blockNumber,
    };
    this.#cache.set(key, entry);
    return entry;
  }

  peek(market: Address): CachedMarketParams | undefined {
    return this.#cache.get(market.toLowerCase());
  }

  clear(): void {
    this.#cache.clear();
  }
}

export async function readVaultParams(client: PublicClient, market: Address): Promise<VaultParams> {
  const tuple = (await client.readContract({
    address: market,
    abi: orderBookAbi,
    functionName: 'getVaultParams',
  })) as VaultParamsTuple;
  return decodeVaultParams(tuple);
}
