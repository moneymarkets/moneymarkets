import { zeroAddress, type Address } from 'viem';
import {
  assertUsableMarketParams,
  isNativeAsset,
  orderBookTypeFor,
  orderBookTypeName,
  routerAbi,
  type MarketParams,
} from '@tradepro/core';
import { flagAmount, flagBigInt, requireAddress, ArgError, type ParsedArgs } from './args.js';
import { routerAddress, type KitConfig } from './config.js';
import { erc20Abi, readToken, type MarketView } from './market.js';
import { planCall, type PlannedCall } from './plan.js';

/**
 * A market that does not exist yet, described honestly.
 *
 * `kit seed --dry-run` normally reads its parameters off a deployed OrderBook. For a
 * market the owner is *considering* deploying — USDT0/AUSD is the one the plan names
 * (phases §3.1 task 1.7) — there is no OrderBook to read, and Kuru's public testnet
 * runs an older build with no compatible market to stand in for it (open item 7).
 *
 * So `--hypothetical` builds the `MarketView` from the same inputs `kit deploy`
 * would send, and everything that *can* come from the chain still does: both token
 * addresses are read for their real `decimals()` and `symbol()`, and the market and
 * vault addresses come from `Router.computeAddress` / `computeVaultAddress`, so they
 * are the addresses the deploy would actually produce. The book is treated as empty,
 * which makes `--ref` mandatory — exactly the case correction 2 exists for.
 *
 * Nothing here is a substitute for the real thing: the dry-run output is stamped
 * HYPOTHETICAL and `kit seed` refuses to leave dry-run mode with this flag set.
 */
export interface HypotheticalMarket extends MarketView {
  readonly hypothetical: true;
  readonly type: number;
  readonly typeName: string;
  readonly presetFrom: Address;
  /**
   * The `Router.deployProxy` call that would bring this market into existence, built
   * from the same eleven values as the `MarketParams` above. `kit seed --simulate`
   * runs it as the first call of an `eth_simulateV1` bundle, so the ladder that
   * follows is checked against a contract the Router really produced rather than
   * against an address with no code.
   */
  readonly deployCall: PlannedCall;
}

export const HYPOTHETICAL_FLAGS = [
  'hypothetical',
  'base',
  'quote',
  'price-precision',
  'size-precision',
  'tick',
  'min-size',
  'max-size',
  'taker-fee-bps',
  'maker-fee-bps',
  'amm-spread',
] as const;

export async function buildHypotheticalMarket(
  config: KitConfig,
  args: ParsedArgs,
  preset: {
    source: Address;
    pricePrecision: bigint;
    sizePrecision: bigint;
    tickSize: bigint;
    takerFeeBps: bigint;
    makerFeeBps: bigint;
    kuruAmmSpread: bigint;
  },
): Promise<HypotheticalMarket> {
  const router = routerAddress(config);
  const baseAddress = requireAddress(args, 'base');
  const quoteAddress = requireAddress(args, 'quote');
  const type = orderBookTypeFor(baseAddress, quoteAddress);

  const [base, quote] = await Promise.all([
    resolveToken(config, baseAddress),
    resolveToken(config, quoteAddress),
  ]);

  const pricePrecision = flagBigInt(args, 'price-precision') ?? preset.pricePrecision;
  const sizePrecision = flagBigInt(args, 'size-precision') ?? preset.sizePrecision;
  const tickSize = flagBigInt(args, 'tick') ?? preset.tickSize;
  const takerFeeBps = flagBigInt(args, 'taker-fee-bps') ?? preset.takerFeeBps;
  const makerFeeBps = flagBigInt(args, 'maker-fee-bps') ?? preset.makerFeeBps;
  const kuruAmmSpread = flagBigInt(args, 'amm-spread') ?? preset.kuruAmmSpread;

  const minHuman = flagAmount(args, 'min-size', base.decimals);
  const maxHuman = flagAmount(args, 'max-size', base.decimals);
  if (minHuman === undefined || maxHuman === undefined) {
    throw new ArgError('--hypothetical needs --min-size and --max-size in base-asset units');
  }
  const scale = 10n ** BigInt(base.decimals);
  const params: MarketParams = {
    pricePrecision,
    sizePrecision,
    baseAsset: base.address,
    baseDecimals: base.decimals,
    quoteAsset: quote.address,
    quoteDecimals: quote.decimals,
    tickSize,
    minSize: (minHuman * sizePrecision) / scale,
    maxSize: (maxHuman * sizePrecision) / scale,
    takerFeeBps,
    makerFeeBps,
  };
  assertUsableMarketParams(params);

  const address = (await config.client.readContract({
    address: router,
    abi: routerAbi,
    functionName: 'computeAddress',
    args: [
      base.address,
      quote.address,
      sizePrecision,
      Number(pricePrecision),
      Number(tickSize),
      params.minSize,
      params.maxSize,
      takerFeeBps,
      makerFeeBps,
      kuruAmmSpread,
      zeroAddress,
      false,
    ],
  })) as Address;

  const code = await config.client.getCode({ address });
  if (code !== undefined && code !== '0x') {
    throw new ArgError(
      `${address} already has code: this parameter set is already a live market. Drop ` +
        '--hypothetical and pass --market ' +
        address,
    );
  }

  const vaultAddress = (await config.client.readContract({
    address: router,
    abi: routerAbi,
    functionName: 'computeVaultAddress',
    args: [address, zeroAddress, false],
  })) as Address;

  const deployCall = planCall({
    label: `Router.deployProxy — ${base.symbol}/${quote.symbol}`,
    to: router,
    abi: routerAbi as never,
    functionName: 'deployProxy',
    args: [
      type,
      base.address,
      quote.address,
      sizePrecision,
      Number(pricePrecision),
      Number(tickSize),
      params.minSize,
      params.maxSize,
      takerFeeBps,
      makerFeeBps,
      kuruAmmSpread,
    ],
  });

  return {
    hypothetical: true,
    type,
    typeName: orderBookTypeName(type),
    presetFrom: preset.source,
    deployCall,
    address,
    symbol: `${base.symbol}/${quote.symbol}`,
    params,
    base,
    quote,
    // A market that does not exist has no book. This is what forces --ref.
    bestBidWire: 0n,
    bestAskWire: 0n,
    vault: {
      vault: vaultAddress,
      vaultBestBid: 0n,
      bidPartiallyFilledSize: 0n,
      vaultBestAsk: 0n,
      askPartiallyFilledSize: 0n,
      vaultBidOrderSize: 0n,
      vaultAskOrderSize: 0n,
      spread: kuruAmmSpread,
    },
    blockNumber: await config.client.getBlockNumber(),
  };
}

async function resolveToken(config: KitConfig, address: Address) {
  if (isNativeAsset(address)) return readToken(config.client, address, 18);
  const decimals = (await config.client.readContract({
    address,
    abi: erc20Abi,
    functionName: 'decimals',
  })) as number;
  return readToken(config.client, address, Number(decimals));
}

export function isHypothetical(view: MarketView): view is HypotheticalMarket {
  return (view as HypotheticalMarket).hypothetical === true;
}
