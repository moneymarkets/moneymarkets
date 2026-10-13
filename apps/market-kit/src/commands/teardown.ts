import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { marginAccountAbi, orderBookAbi, UINT40_MAX } from '@tradepro/core';
import {
  assertKnownFlags,
  flagBool,
  flagInt,
  flagString,
  requireAddress,
  ArgError,
  type ParsedArgs,
} from '../args.js';
import { loadConfig, marginAccountAddress, type KitConfig } from '../config.js';
import {
  formatBase,
  formatPrice,
  formatQuote,
  formatSize,
  heading,
  renderPlannedCall,
} from '../format.js';
import { readMarginBalance, readMarket, scanRestingOrders, type RestingOrder } from '../market.js';
import { planCall, type PlannedCall } from '../plan.js';
import { simulatePlan, submitPlan, DryRunStop } from '../send.js';
import { readChain } from './seed.js';

export const TEARDOWN_FLAGS = [
  'market',
  'scan',
  'order-ids',
  'no-withdraw',
  'batch-size',
  'dry-run',
  'simulate',
  'from',
  'chain',
  'rpc',
  'out',
] as const;

/**
 * `kit teardown` — cancel the ladder, then take the money back.
 *
 * Flip orders and plain orders cancel through *different* functions: the deployed
 * OrderBook carries both `batchCancelFlipOrders(uint40[])` (`0xba42d8bd`) and
 * `batchCancelOrders(uint40[])` (`0x23afbff3`), and it has a `WrongOrderTypeCancel()`
 * error for passing one to the other. `s_orders(id).flippedPrice != 0` is how a flip
 * order identifies itself, so the two lists are split by that.
 */
export interface TeardownReport {
  readonly text: string;
  readonly calls: readonly PlannedCall[];
  readonly orders: readonly RestingOrder[];
  readonly flips: readonly bigint[];
  readonly plains: readonly bigint[];
  readonly scannedFrom: bigint;
  readonly scannedTo: bigint;
  readonly counter: bigint;
  /** True when `--simulate` found a call in the plan that would revert (High #22). */
  readonly simulationRejected?: boolean;
}

/**
 * Build the teardown plan and its report, without printing or sending either.
 *
 * Split out from `teardownCommand` so the web UI's teardown card runs exactly this
 * code — the same scan, the same flip/plain split, the same batching — rather than a
 * second implementation that could drift from it.
 */
export async function buildTeardownReport(
  config: KitConfig,
  args: ParsedArgs,
): Promise<TeardownReport> {
  const market = requireAddress(args, 'market');
  const window = flagInt(args, 'scan') ?? 2000;
  const batchSize = flagInt(args, 'batch-size') ?? 50;
  if (batchSize < 1) throw new ArgError('--batch-size must be at least 1');

  const view = await readMarket(config.client, market);
  const explicit = parseOrderIds(flagString(args, 'order-ids'));

  const scan = await scanRestingOrders(config.client, market, config.from, window);
  const orders = explicit ? scan.orders.filter((o) => explicit.includes(o.orderId)) : scan.orders;
  if (explicit) {
    const missing = explicit.filter((id) => !scan.orders.some((o) => o.orderId === id));
    if (missing.length > 0) {
      throw new ArgError(
        `order id(s) ${missing.join(', ')} are not resting orders owned by ${config.from} ` +
          `within the scanned window ${scan.fromId}..${scan.toId}. Widen --scan or check the ids.`,
      );
    }
  }

  const flips = orders.filter((o) => o.isFlip).map((o) => o.orderId);
  const plains = orders.filter((o) => !o.isFlip).map((o) => o.orderId);

  const calls: PlannedCall[] = [];
  for (const batch of chunk(flips, batchSize)) {
    calls.push(
      planCall({
        label: `batchCancelFlipOrders — ${batch.length} flip order(s)`,
        to: view.address,
        abi: orderBookAbi as never,
        functionName: 'batchCancelFlipOrders',
        args: [batch.map((id) => Number(id))],
      }),
    );
  }
  for (const batch of chunk(plains, batchSize)) {
    calls.push(
      planCall({
        label: `batchCancelOrders — ${batch.length} plain order(s)`,
        to: view.address,
        abi: orderBookAbi as never,
        functionName: 'batchCancelOrders',
        args: [batch.map((id) => Number(id))],
      }),
    );
  }

  const marginAccount = marginAccountAddress(config);
  const withdrawLines: string[] = [];
  if (!flagBool(args, 'no-withdraw')) {
    for (const token of [view.base, view.quote] as const) {
      const held = await readMarginBalance(
        config.client,
        marginAccount,
        config.from,
        token.address,
      );
      const human =
        token.address === view.quote.address
          ? formatQuote(held, view.params)
          : formatBase(held, view.params);
      withdrawLines.push(`  ${token.symbol.padEnd(8)} ${human} in the MarginAccount now`);
      if (held === 0n) continue;
      calls.push(
        planCall({
          label: `withdraw ${human} ${token.symbol} from MarginAccount`,
          to: marginAccount,
          abi: marginAccountAbi as never,
          functionName: 'withdraw',
          args: [held, token.address],
        }),
      );
    }
    withdrawLines.push(
      '',
      '  These amounts are read BEFORE the cancels. Cancelling releases the collateral the',
      '  ladder is holding, so the real withdrawable balance afterwards is larger. Re-run',
      '  `kit status` after the cancels, or run teardown twice.',
    );
  } else {
    withdrawLines.push('  withdrawals skipped (--no-withdraw)');
  }

  const sections = [
    heading(`kit teardown — ${view.symbol}  ${view.address}`),
    [
      `chain             ${config.mode} (${config.client.chain?.id})  block ${view.blockNumber}`,
      `operator          ${config.from}`,
      `scanned           order ids ${scan.fromId}..${scan.toId} of ${scan.counter} ` +
        `(--scan ${window})`,
      `found             ${flips.length} flip, ${plains.length} plain`,
    ].join('\n'),
    heading('ORDERS TO CANCEL'),
    orders.length === 0 ? '  none' : renderOrders(orders, view),
    heading('WITHDRAW'),
    withdrawLines.join('\n'),
    heading(`WOULD SEND — ${calls.length} transaction(s), in this order`),
    calls.length === 0
      ? '  nothing to do'
      : calls.map((call, i) => renderPlannedCall(call, i + 1)).join('\n\n'),
  ];

  let simulationRejected: boolean | undefined;
  if (flagBool(args, 'simulate') && calls.length > 0) {
    const results = await simulatePlan(config.client, config.from, calls);
    simulationRejected = results.some((r) => !r.ok);
    sections.push(
      heading('SIMULATION (eth_call, current state; operator MON balance covers msg.value)'),
    );
    sections.push(
      results
        .map(
          (r, i) =>
            `  [${i + 1}] ${r.ok ? 'ok    ' : 'REVERT'} ${r.call.label}` +
            (r.reason ? `\n        ${r.reason}` : ''),
        )
        .join('\n'),
    );
  }

  const text = sections.join('\n');
  return {
    text,
    calls,
    orders,
    flips,
    plains,
    scannedFrom: scan.fromId,
    scannedTo: scan.toId,
    counter: scan.counter,
    ...(simulationRejected === undefined ? {} : { simulationRejected }),
  };
}

export async function teardownCommand(args: ParsedArgs): Promise<number> {
  assertKnownFlags(args, TEARDOWN_FLAGS);
  const config = loadConfig({
    mode: readChain(args),
    from: flagString(args, 'from'),
    rpcUrl: flagString(args, 'rpc'),
  });
  const { text, calls, simulationRejected } = await buildTeardownReport(config, args);
  console.log(text);

  const out = flagString(args, 'out');
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${text}\n`, 'utf8');
  }

  // A REJECTED simulation is a real answer, not a note in the printout (High #22).
  const exitCode = simulationRejected ? 1 : 0;

  if (flagBool(args, 'dry-run') || config.dryRun) {
    console.log(`\n${new DryRunStop(calls).message}`);
    return exitCode;
  }
  if (calls.length === 0) return exitCode;
  if (simulationRejected) {
    console.log('\n--simulate found a call that would revert. Nothing was sent.');
    return exitCode;
  }
  await submitPlan(config, calls);
  return exitCode;
}

export function parseOrderIds(text: string | undefined): bigint[] | undefined {
  if (text === undefined) return undefined;
  const ids = text
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => {
      if (!/^\d+$/.test(t)) throw new ArgError(`--order-ids: ${JSON.stringify(t)} is not a number`);
      const id = BigInt(t);
      if (id > UINT40_MAX) throw new ArgError(`--order-ids: ${t} does not fit in uint40`);
      return id;
    });
  if (ids.length === 0) throw new ArgError('--order-ids was empty');
  return ids;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function renderOrders(
  orders: readonly RestingOrder[],
  view: Awaited<ReturnType<typeof readMarket>>,
): string {
  return orders
    .map(
      (o) =>
        `  ${o.orderId.toString().padStart(10)}  ${(o.isBuy ? 'buy' : 'sell').padEnd(4)}  ` +
        `${o.isFlip ? 'flip ' : 'plain'}  price ${formatPrice(o.price, view.params)}  ` +
        `flip ${o.isFlip ? formatPrice(o.flippedPrice, view.params) : '—'}  ` +
        `size ${formatSize(o.size, view.params)}`,
    )
    .join('\n');
}
