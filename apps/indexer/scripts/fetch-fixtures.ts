/**
 * Fetch REAL Kuru logs from Monad mainnet and write them to `test/fixtures/`.
 *
 * Everything this script writes came off chain 143. Nothing is synthesised, and the
 * script has no "if the fetch fails, use a sample" branch on purpose: a fixture that
 * is not a real log is worse than no fixture, because it tests the decoder against
 * the author's belief instead of against the venue.
 *
 * Read-only. It issues `eth_chainId`, `eth_blockNumber`, `eth_getLogs` and
 * `eth_getTransactionReceipt` and nothing else — no key is loaded and no transaction
 * is ever built.
 *
 * **Why `eth_getLogs` and not HyperSync.** HyperSync would be the better bulk source
 * (no range cap), and `https://monad.hypersync.xyz/height` answers unauthenticated,
 * but `POST /query` now requires an Envio API token and this repo has none
 * (2026-09-02: the endpoint answers `{"error":"Your token is malformed..."}`). So
 * this falls back to the public RPC, which caps `eth_getLogs` at a **100-block
 * range** — a wider request is refused with
 * `{"code":-32614,"message":"eth_getLogs is limited to a 100 range"}`. Hence the
 * paging below. That cap is the whole reason the indexer exists (spec section 9).
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MAINNET, PUBLIC_RPC_GET_LOGS_MAX_RANGE } from '@tradepro/core';
import { TOPIC0 } from '../src/events.js';

const RPC = process.env.RPC_URL_MONAD_MAINNET ?? 'https://rpc.monad.xyz';
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');

/** Live order books, from the spec's known-good set. */
const MARKETS = {
  MON_AUSD: '0x131A2e70A5b31a517A74b8c567149bc294470Da9',
  MON_USDC: '0x065C9d28E428A0db40191a54d33d5b7c71a9C394',
  AUSD_USDC: '0x699AbC15308156E9a3AB89Ec7387e9CfE1c86A3b',
  WBTC_AUSD: '0xbDC776284Bf593981b1F0237F053A7Ad11Eb596F',
} as const;

/**
 * The registration transaction for MON_AUSD, from
 * `GET https://api.kuru.io/api/v1/markets` (field `transactionhash`). Used only to
 * locate a real `MarketRegistered` log; the log itself still comes from the chain.
 */
const REGISTRATION_TX_MON_AUSD =
  '0x8642018193e395f73e79d0f5bc357de4c735ae37baa28194565816f39ba6d57e';

/** Ground truth from the spec: a real order and the block its cancel landed in. */
const GROUND_TRUTH = {
  orderId: 13130679n,
  owner: '0x43a275C3Eb0BE7313f847FFA4fb6Bd366606A961',
  market: MARKETS.MON_AUSD,
  createdBlock: 101310782n,
  canceledBlock: 101310801n,
} as const;

interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  transactionIndex: string;
  logIndex: string;
  removed: boolean;
}

let rpcCalls = 0;

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  rpcCalls += 1;
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcCalls, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
  if (body.error) throw new Error(`${method} failed: ${body.error.code} ${body.error.message}`);
  if (body.result === undefined) throw new Error(`${method} returned no result`);
  return body.result;
}

const hex = (n: bigint): string => `0x${n.toString(16)}`;

/**
 * `eth_getLogs` over a range wider than the node allows, one legal window at a time.
 * The window is `PUBLIC_RPC_GET_LOGS_MAX_RANGE` from core, so this script and the app
 * share one number rather than two that can drift apart.
 */
async function getLogsPaged(
  addresses: readonly string[],
  fromBlock: bigint,
  toBlock: bigint,
): Promise<RawLog[]> {
  const span = BigInt(PUBLIC_RPC_GET_LOGS_MAX_RANGE);
  const out: RawLog[] = [];
  for (let start = fromBlock; start <= toBlock; start += span) {
    // Inclusive on both ends, so a `span`-wide window is `start .. start+span-1`.
    const last = start + span - 1n;
    const end = last > toBlock ? toBlock : last;
    const page = await rpc<RawLog[]>('eth_getLogs', [
      { address: addresses, fromBlock: hex(start), toBlock: hex(end) },
    ]);
    out.push(...page);
  }
  return out;
}

function countByTopic(logs: readonly RawLog[]): Record<string, number> {
  const names = Object.entries(TOPIC0);
  const counts: Record<string, number> = {};
  for (const log of logs) {
    const topic = log.topics[0];
    const hit = names.find(([, t]) => t === topic);
    const key = hit ? hit[0] : `unrecognised:${topic ?? 'none'}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function write(name: string, payload: unknown): void {
  writeFileSync(join(FIXTURES, name), `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`  wrote test/fixtures/${name}`);
}

async function main(): Promise<void> {
  const fetchedAt = new Date().toISOString();

  const chainId = await rpc<string>('eth_chainId', []);
  if (BigInt(chainId) !== BigInt(MAINNET.chainId)) {
    throw new Error(`expected chain ${MAINNET.chainId}, RPC says ${BigInt(chainId)}`);
  }
  const tip = BigInt(await rpc<string>('eth_blockNumber', []));
  console.log(`chain ${BigInt(chainId)} @ ${RPC}, tip ${tip}`);

  // 1. Ground truth: the known order's creation and its cancel, in one paged sweep
  //    that spans both blocks.
  console.log('\nground truth - order 13130679 on MON_AUSD');
  const gtFrom = GROUND_TRUTH.createdBlock;
  const gtTo = GROUND_TRUTH.canceledBlock;
  const gtLogs = await getLogsPaged([GROUND_TRUTH.market], gtFrom, gtTo);
  console.log(`  ${gtLogs.length} logs over blocks ${gtFrom}..${gtTo}`, countByTopic(gtLogs));
  write('ground-truth-order-13130679.json', {
    note:
      'REAL logs from Monad mainnet (chain 143), fetched via eth_getLogs from ' +
      `${RPC}. Nothing here is synthetic. Order 13130679 is created in block ` +
      `${GROUND_TRUTH.createdBlock} and cancelled in block ${GROUND_TRUTH.canceledBlock}; ` +
      'the OrdersCanceled log carries it inside an ARRAY, which is the point of the fixture.',
    fetchedAt,
    rpc: RPC,
    chainId: Number(BigInt(chainId)),
    market: GROUND_TRUTH.market,
    marketSymbol: 'MON_AUSD',
    blockRange: { from: Number(gtFrom), to: Number(gtTo) },
    expected: {
      orderId: GROUND_TRUTH.orderId.toString(),
      owner: GROUND_TRUTH.owner,
    },
    logs: gtLogs,
  });

  // 2. A real MarketRegistered, taken from the receipt of the transaction that
  //    actually registered MON_AUSD.
  console.log('\nMarketRegistered - from the MON_AUSD registration receipt');
  const receipt = await rpc<{ blockNumber: string; logs: RawLog[] }>('eth_getTransactionReceipt', [
    REGISTRATION_TX_MON_AUSD,
  ]);
  const routerLogs = receipt.logs.filter(
    (l) =>
      l.address.toLowerCase() === MAINNET.kuru.router.toLowerCase() &&
      l.topics[0] === TOPIC0.MarketRegistered,
  );
  console.log(
    `  block ${BigInt(receipt.blockNumber)}, ${receipt.logs.length} logs, ` +
      `${routerLogs.length} MarketRegistered from the Router`,
  );
  write('market-registered-mon-ausd.json', {
    note:
      'REAL log. The transaction that registered MON_AUSD on the Kuru Router, read ' +
      'with eth_getTransactionReceipt. The tx hash came from the Kuru market registry ' +
      '(GET https://api.kuru.io/api/v1/markets, field transactionhash); the log itself ' +
      'was read from the chain.',
    fetchedAt,
    rpc: RPC,
    chainId: Number(BigInt(chainId)),
    router: MAINNET.kuru.router,
    transactionHash: REGISTRATION_TX_MON_AUSD,
    blockNumber: Number(BigInt(receipt.blockNumber)),
    logs: routerLogs,
  });

  // 3. A COMPLETE window across all four live books. Complete, not sampled: this is
  //    every log those four addresses emitted between two blocks, so the decoders
  //    meet whatever the venue actually produced — including the events this indexer
  //    does not handle, which it must ignore rather than mis-decode. Kept narrow so
  //    the fixture stays small enough to read in a review.
  const sweepSpan = 60n;
  const sweepTo = tip - 10n; // stay clear of the very tip
  const sweepFrom = sweepTo - sweepSpan + 1n;
  console.log(`\ncomplete window - 4 markets, blocks ${sweepFrom}..${sweepTo}`);
  const sweep = await getLogsPaged(Object.values(MARKETS), sweepFrom, sweepTo);
  const counts = countByTopic(sweep);
  console.log(`  ${sweep.length} logs`, counts);
  write('recent-sweep.json', {
    note:
      'REAL logs from Monad mainnet (chain 143). This is the COMPLETE set of logs ' +
      `emitted by the four live Kuru order books over blocks ${sweepFrom}..${sweepTo} - ` +
      'no filtering and no sampling, so counts here are the venue’s own mix. ' +
      `Fetched with ${PUBLIC_RPC_GET_LOGS_MAX_RANGE}-block eth_getLogs pages; the public ` +
      'RPC refuses anything wider with -32614. Unrecognised topic0s are retained on ' +
      'purpose: the indexer must skip events it does not handle.',
    fetchedAt,
    rpc: RPC,
    chainId: Number(BigInt(chainId)),
    markets: MARKETS,
    blockRange: { from: Number(sweepFrom), to: Number(sweepTo) },
    pageSize: Number(PUBLIC_RPC_GET_LOGS_MAX_RANGE),
    complete: true,
    countsByEvent: counts,
    logs: sweep,
  });

  // 4. Batch cancels. A wide sweep produces plenty of single-id cancels and only a
  //    few multi-id ones, and the multi-id ones are the whole point of the plural
  //    pitfall — so they get their own fixture. The FILTER is stated (topic0 is
  //    OrdersCanceled and the array holds more than one id); every log is real and
  //    unedited, and the surrounding counts record what it was filtered out of.
  const batchSpan = 600n;
  const batchTo = sweepFrom - 1n;
  const batchFrom = batchTo - batchSpan + 1n;
  console.log(`\nbatch cancels - 4 markets, blocks ${batchFrom}..${batchTo}`);
  const wide = await getLogsPaged(Object.values(MARKETS), batchFrom, batchTo);
  const allCancels = wide.filter((l) => l.topics[0] === TOPIC0.OrdersCanceled);
  const idCount = (log: RawLog): number => {
    // `OrdersCanceled(uint40[] orderId, address owner)`: word 0 is the offset to the
    // array, word 1 is `owner`, and the word at that offset is the array length.
    const body = log.data.slice(2);
    const offset = Number(BigInt(`0x${body.slice(0, 64)}`)) * 2;
    return Number(BigInt(`0x${body.slice(offset, offset + 64)}`));
  };
  const multi = allCancels.filter((l) => idCount(l) > 1);
  const totalIds = allCancels.reduce((n, l) => n + idCount(l), 0);
  console.log(
    `  ${allCancels.length} OrdersCanceled logs carrying ${totalIds} order ids; ` +
      `${multi.length} of them carry more than one`,
  );
  write('batch-cancels.json', {
    note:
      'REAL OrdersCanceled logs from Monad mainnet (chain 143). Filter, stated: ' +
      `topic0 == OrdersCanceled AND the uint40[] holds more than one id, over blocks ` +
      `${batchFrom}..${batchTo} on the four live books. Every log is unedited. ` +
      'The counts below are the evidence for venue pitfall 2: across the whole ' +
      `window ${allCancels.length} cancel logs carried ${totalIds} order ids, so an ` +
      `indexer that read one id per log would silently lose ${totalIds - allCancels.length} ` +
      'cancellations.',
    fetchedAt,
    rpc: RPC,
    chainId: Number(BigInt(chainId)),
    markets: MARKETS,
    blockRange: { from: Number(batchFrom), to: Number(batchTo) },
    population: {
      cancelLogs: allCancels.length,
      orderIdsCancelled: totalIds,
      cancelLogsCarryingMoreThanOneId: multi.length,
      idsLostByASingularHandler: totalIds - allCancels.length,
    },
    logs: multi,
  });

  console.log(`\ndone - ${rpcCalls} RPC calls, all read-only.`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
