/**
 * Read `getMarketParams()` from the live Kuru order books and print the result as the
 * seed table in `src/markets.ts`.
 *
 * Why a seed table exists at all: the indexer learns a market's `pricePrecision` from
 * `Router.MarketRegistered`, but MON_AUSD was registered in block 45,440,066 and the
 * chain is past 101,000,000. Indexing every order book from block 45M forward to pick
 * up four registration events is not a reasonable trade, and starting later means the
 * registration is never seen. So the four known-live books are seeded from a direct
 * chain read - which is a *read*, not a guess (rule A2.5), and this script is how it
 * is reproduced and re-verified.
 *
 * Read-only: one `eth_call` per market, no key, no transaction.
 */

import { createPublicClient, http } from 'viem';
import type { Address } from 'viem';
import { monad, orderBookAbi, decodeMarketParams } from '@tradepro/core';

const RPC = process.env.RPC_URL_MONAD_MAINNET ?? 'https://rpc.monad.xyz';

const MARKETS: Record<string, Address> = {
  MON_AUSD: '0x131A2e70A5b31a517A74b8c567149bc294470Da9',
  MON_USDC: '0x065C9d28E428A0db40191a54d33d5b7c71a9C394',
  AUSD_USDC: '0x699AbC15308156E9a3AB89Ec7387e9CfE1c86A3b',
  WBTC_AUSD: '0xbDC776284Bf593981b1F0237F053A7Ad11Eb596F',
};

async function main(): Promise<void> {
  const client = createPublicClient({ chain: monad, transport: http(RPC) });
  const blockNumber = await client.getBlockNumber();
  console.log(`// getMarketParams() read from ${RPC} at block ${blockNumber}`);
  console.log(`// ${new Date().toISOString()}`);

  for (const [symbol, market] of Object.entries(MARKETS)) {
    const tuple = await client.readContract({
      address: market,
      abi: orderBookAbi,
      functionName: 'getMarketParams',
    });
    const p = decodeMarketParams(tuple as never);
    console.log(`\n${symbol} ${market}`);
    console.log(
      JSON.stringify(
        {
          pricePrecision: p.pricePrecision.toString(),
          sizePrecision: p.sizePrecision.toString(),
          baseAsset: p.baseAsset,
          baseDecimals: p.baseDecimals,
          quoteAsset: p.quoteAsset,
          quoteDecimals: p.quoteDecimals,
          tickSize: p.tickSize.toString(),
          minSize: p.minSize.toString(),
          maxSize: p.maxSize.toString(),
          takerFeeBps: p.takerFeeBps.toString(),
          makerFeeBps: p.makerFeeBps.toString(),
        },
        null,
        2,
      ),
    );
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
