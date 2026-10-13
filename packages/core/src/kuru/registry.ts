import { z } from 'zod';
import { getAddress, isAddress, type Address, type PublicClient } from 'viem';
import { orderBookAbi } from '../abi/orderBook.js';
import { decodeMarketParams, type MarketParams } from './params.js';

/**
 * Market discovery.
 *
 * Kuru has no endpoint literally called `exchangeInfo`; the registry lives at
 * `GET {restApi}/api/v1/markets` (verified 2026-09-02 against
 * `https://api.kuru.io/api/v1/markets`, which returned 100 rows with a
 * `pagination` block). Mainnet and testnet return **different shapes** — the testnet
 * service at `https://api.testnet.kuru.io` uses camelCase and `marketAddress` — so
 * both are parsed here rather than assumed.
 *
 * The registry is a discovery hint, never an authority. Every address that reaches
 * the relayer's allowlist is confirmed on chain first (`verifyMarket`), because the
 * same feed also lists AMM pools and other venues whose "market" ids are not Kuru
 * OrderBooks at all.
 */

const mainnetRow = z.object({
  market: z.string(),
  baseasset: z.string(),
  quoteasset: z.string(),
  kuruammvault: z.string().nullable().optional(),
  priceprecision: z.string(),
  sizeprecision: z.string(),
  ticksize: z.string(),
  minsize: z.string(),
  maxsize: z.string(),
  takerfeebps: z.string(),
  makerfeebps: z.string(),
  transactionhash: z.string().nullable().optional(),
  basetoken: z
    .object({
      ticker: z.string().nullable().optional(),
      decimal: z.union([z.string(), z.number()]),
    })
    .partial()
    .nullable()
    .optional(),
  quotetoken: z
    .object({
      ticker: z.string().nullable().optional(),
      decimal: z.union([z.string(), z.number()]),
    })
    .partial()
    .nullable()
    .optional(),
});

const mainnetResponse = z.object({
  success: z.boolean().optional(),
  data: z.object({ data: z.array(mainnetRow) }),
});

const testnetRow = z.object({
  marketAddress: z.string(),
  symbol: z.string(),
  status: z.string().optional(),
  pricePrecision: z.string(),
  sizePrecision: z.string(),
  tickSize: z.string(),
  baseToken: z.object({ tokenAddress: z.string(), symbol: z.string(), decimals: z.number() }),
  quoteToken: z.object({ tokenAddress: z.string(), symbol: z.string(), decimals: z.number() }),
});

const testnetResponse = z.object({ data: z.array(testnetRow) });

export interface RegistryMarket {
  readonly market: Address;
  readonly symbol: string;
  readonly baseAsset: Address;
  readonly quoteAsset: Address;
  readonly vault?: Address;
  /** Straight from the feed, unverified. `verifyMarket` is what makes it trustworthy. */
  readonly pricePrecision: bigint;
  readonly sizePrecision: bigint;
  readonly tickSize: bigint;
}

function looksLikeOrderBookAddress(value: string): value is Address {
  // The mainnet feed mixes in AMM pool ids like `0xabc…:0-1` and 32-byte pool keys.
  return isAddress(value);
}

export function parseMarketRegistry(payload: unknown): RegistryMarket[] {
  const mainnet = mainnetResponse.safeParse(payload);
  if (mainnet.success) {
    const out: RegistryMarket[] = [];
    for (const row of mainnet.data.data.data) {
      if (!looksLikeOrderBookAddress(row.market)) continue;
      // A Kuru OrderBook always has non-zero precisions; rows with zeros are other
      // venue types the aggregator folds into the same feed.
      const pp = BigInt(row.priceprecision);
      const sp = BigInt(row.sizeprecision);
      if (pp === 0n || sp === 0n) continue;
      if (!isAddress(row.baseasset) || !isAddress(row.quoteasset)) continue;
      const base = row.basetoken?.ticker ?? row.baseasset.slice(0, 8);
      const quote = row.quotetoken?.ticker ?? row.quoteasset.slice(0, 8);
      out.push({
        market: getAddress(row.market),
        symbol: `${base}/${quote}`,
        baseAsset: getAddress(row.baseasset),
        quoteAsset: getAddress(row.quoteasset),
        ...(row.kuruammvault && isAddress(row.kuruammvault)
          ? { vault: getAddress(row.kuruammvault) }
          : {}),
        pricePrecision: pp,
        sizePrecision: sp,
        tickSize: BigInt(row.ticksize),
      });
    }
    return out;
  }

  const testnet = testnetResponse.safeParse(payload);
  if (testnet.success) {
    return testnet.data.data
      .filter((row) => looksLikeOrderBookAddress(row.marketAddress))
      .map((row) => ({
        market: getAddress(row.marketAddress),
        symbol: `${row.baseToken.symbol}/${row.quoteToken.symbol}`,
        baseAsset: getAddress(row.baseToken.tokenAddress),
        quoteAsset: getAddress(row.quoteToken.tokenAddress),
        pricePrecision: BigInt(row.pricePrecision),
        sizePrecision: BigInt(row.sizePrecision),
        tickSize: BigInt(row.tickSize),
      }));
  }

  throw new Error(
    'market registry response matched neither the mainnet nor the testnet shape; ' +
      'refusing to guess which fields are which',
  );
}

export async function fetchMarketRegistry(
  restApi: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RegistryMarket[]> {
  const res = await fetchImpl(`${restApi.replace(/\/$/, '')}/api/v1/markets`);
  if (!res.ok) throw new Error(`market registry returned ${res.status}`);
  return parseMarketRegistry(await res.json());
}

export interface VerifiedMarket extends RegistryMarket {
  readonly params: MarketParams;
  readonly trustsForwarder: boolean;
}

/**
 * Confirm on chain that an address really is a Kuru OrderBook, and whether it trusts
 * the forwarder. This is the gate an address must pass before the relayer will ever
 * send it calldata (spec §5.3).
 */
export async function verifyMarket(
  client: PublicClient,
  market: Address,
  forwarder: Address | undefined,
): Promise<VerifiedMarket | undefined> {
  let params: MarketParams;
  try {
    const tuple = await client.readContract({
      address: market,
      abi: orderBookAbi,
      functionName: 'getMarketParams',
    });
    params = decodeMarketParams(tuple as never);
  } catch {
    return undefined;
  }

  let trustsForwarder = false;
  if (forwarder) {
    try {
      trustsForwarder = (await client.readContract({
        address: market,
        abi: orderBookAbi,
        functionName: 'isTrustedForwarder',
        args: [forwarder],
      })) as boolean;
    } catch {
      trustsForwarder = false;
    }
  }

  return {
    market,
    symbol: `${params.baseAsset.slice(0, 8)}/${params.quoteAsset.slice(0, 8)}`,
    baseAsset: params.baseAsset,
    quoteAsset: params.quoteAsset,
    pricePrecision: params.pricePrecision,
    sizePrecision: params.sizePrecision,
    tickSize: params.tickSize,
    params,
    trustsForwarder,
  };
}
