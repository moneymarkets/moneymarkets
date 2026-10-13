/**
 * Loader for the REAL log fixtures in `test/fixtures/`.
 *
 * Every file it reads was fetched from Monad mainnet (chain 143) by
 * `scripts/fetch-fixtures.ts`. Nothing in this directory was written by hand, and
 * there is no fallback that invents a log when a file is missing — a missing fixture
 * is a hard failure, because a test that quietly runs against a substitute is a test
 * that proves nothing about the venue.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { decodeEventLog, type AbiEvent, type Hex } from 'viem';
import {
  MARKET_REGISTERED_EVENT,
  ORDERS_CANCELED_EVENT,
  ORDER_CREATED_EVENT,
  TOPIC0,
  TRADE_EVENT,
  type KuruEventName,
} from '../src/events.js';
import type {
  MarketRegisteredParams,
  OrderCreatedParams,
  OrdersCanceledParams,
  TradeParams,
} from '../src/normalize.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** A log exactly as the JSON-RPC returned it: every numeric field is a hex string. */
export interface RawLog {
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

export interface FixtureFile {
  note: string;
  fetchedAt: string;
  rpc: string;
  chainId: number;
  blockRange?: { from: number; to: number };
  logs: RawLog[];
  [key: string]: unknown;
}

function load(name: string): FixtureFile {
  const path = join(HERE, 'fixtures', name);
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as FixtureFile;
  if (!Array.isArray(parsed.logs)) {
    throw new Error(`fixture ${name} has no logs array`);
  }
  return parsed;
}

export const groundTruth = load('ground-truth-order-13130679.json');
export const marketRegistered = load('market-registered-mon-ausd.json');
export const recentSweep = load('recent-sweep.json');
export const batchCancels = load('batch-cancels.json');

export const ALL_FIXTURES = {
  'ground-truth-order-13130679.json': groundTruth,
  'market-registered-mon-ausd.json': marketRegistered,
  'recent-sweep.json': recentSweep,
  'batch-cancels.json': batchCancels,
} as const;

/** Which of the four handled events a log is, or `undefined` for one we ignore. */
export function eventNameOf(log: RawLog): KuruEventName | undefined {
  const topic = log.topics[0];
  for (const [name, value] of Object.entries(TOPIC0) as [KuruEventName, Hex][]) {
    if (value === topic) return name;
  }
  return undefined;
}

export const logsOfType = (fixture: FixtureFile, name: KuruEventName): RawLog[] =>
  fixture.logs.filter((log) => eventNameOf(log) === name);

/**
 * Decode a raw log with one event ABI.
 *
 * This mirrors exactly what Envio does before it calls a handler, so the params these
 * tests feed into `normalize.ts` have the same shape the real handlers receive. If the
 * decode is wrong, the tests are testing the wrong thing — which is why every decoder
 * below is exercised against a log whose expected values are known independently.
 */
function decodeAs<T>(event: AbiEvent, log: RawLog): T {
  const { args } = decodeEventLog({
    abi: [event],
    data: log.data as Hex,
    topics: log.topics as [Hex, ...Hex[]],
  });
  return args as T;
}

export const decodeTrade = (log: RawLog): TradeParams => decodeAs<TradeParams>(TRADE_EVENT, log);

export const decodeOrderCreated = (log: RawLog): OrderCreatedParams =>
  decodeAs<OrderCreatedParams>(ORDER_CREATED_EVENT, log);

export const decodeOrdersCanceled = (log: RawLog): OrdersCanceledParams =>
  decodeAs<OrdersCanceledParams>(ORDERS_CANCELED_EVENT, log);

export const decodeMarketRegistered = (log: RawLog): MarketRegisteredParams =>
  decodeAs<MarketRegisteredParams>(MARKET_REGISTERED_EVENT, log);

/** Block number / log index as numbers, from the hex strings the RPC returned. */
export const position = (log: RawLog): { blockNumber: number; txHash: Hex; logIndex: number } => ({
  blockNumber: Number(BigInt(log.blockNumber)),
  txHash: log.transactionHash as Hex,
  logIndex: Number(BigInt(log.logIndex)),
});
