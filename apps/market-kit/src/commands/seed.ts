import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Address } from 'viem';
import {
  formatAusd,
  marginAccountAbi,
  MAX_ORDER_NOTIONAL_AUSD,
  orderBookAbi,
} from '@tradepro/core';
import {
  assertKnownFlags,
  flagBool,
  flagInt,
  flagPriceWire,
  flagString,
  requireAddress,
  requireAmount,
  requireBigInt,
  ArgError,
  type ParsedArgs,
} from '../args.js';
import { loadConfig, marginAccountAddress, type KitConfig } from '../config.js';
import { buildLadder, parseBand, resolveAnchor, type Ladder, type LadderSide } from '../ladder.js';
import {
  formatBase,
  formatQuote,
  heading,
  renderLadder,
  renderLadderSummary,
  renderPlannedCall,
} from '../format.js';
import { erc20Abi, readMarginBalance, readMarket, type MarketView } from '../market.js';
import { buildHypotheticalMarket, HYPOTHETICAL_FLAGS, isHypothetical } from '../hypothetical.js';
import { renderNewMarketSimulation } from '../simulateNewMarket.js';
import { readPreset, DEFAULT_PRESET_MARKET } from './deploy.js';
import { planCall, type PlannedCall } from '../plan.js';
import { simulatePlan, simulateProvisionFunded, submitPlan, DryRunStop } from '../send.js';

export const SEED_FLAGS = [
  ...HYPOTHETICAL_FLAGS,
  'preset-from',
  'market',
  'band',
  'levels',
  'size-per-level',
  'fee-bps',
  'side',
  'ref',
  'ref-source',
  'dry-run',
  'from',
  'chain',
  'rpc',
  'no-deposit',
  'simulate',
  'out',
] as const;

/**
 * `kit seed` — spec §8.3.
 *
 * The dry run is not a preview of a different code path: the plan printed here is the
 * exact array `submitPlan` would send, in order. `--dry-run` forces the stop; without
 * it the `MODE` gate stops it anyway, since `MODE=dryrun` is the default everywhere.
 */
export async function seedCommand(args: ParsedArgs): Promise<number> {
  assertKnownFlags(args, SEED_FLAGS);

  const config = loadConfig({
    mode: readChain(args),
    from: flagString(args, 'from'),
    rpcUrl: flagString(args, 'rpc'),
  });
  const view = await resolveMarketView(config, args);

  const report = await buildSeedReport(config, view, args);
  console.log(report.text);

  const out = flagString(args, 'out');
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${report.text}\n`, 'utf8');
    console.log(`\nwritten to ${out}`);
  }

  // A REJECTED simulation is a real answer, not a note in the printout — used to exit
  // 0 regardless, which is indistinguishable from "the ladder is fine" to a script
  // (High #22).
  if (report.simulationRejected) {
    console.log('\n--simulate found the book would reject this ladder. See above for which call.');
  }
  const exitCode = report.simulationRejected ? 1 : 0;

  if (isHypothetical(view)) {
    console.log(
      '\nHYPOTHETICAL market: nothing is deployed at that address. This plan cannot be ' +
        'submitted.\nRun `kit deploy` first, then re-run `kit seed --market <the real address>`.',
    );
    console.log(`\n${new DryRunStop(report.calls).message}`);
    return exitCode;
  }

  const forcedDryRun = flagBool(args, 'dry-run');
  if (forcedDryRun || config.dryRun) {
    console.log(`\n${new DryRunStop(report.calls).message}`);
    return exitCode;
  }
  if (report.simulationRejected) {
    // Never submit what --simulate just showed the book would refuse.
    return exitCode;
  }
  await submitPlan(config, report.calls);
  return exitCode;
}

/**
 * The market to seed: a live OrderBook, or — with `--hypothetical` — a market that
 * would exist if `kit deploy` were run with the same parameters. See
 * `src/hypothetical.ts` for why that mode exists and what stays chain-derived in it.
 */
export async function resolveMarketView(config: KitConfig, args: ParsedArgs): Promise<MarketView> {
  if (!flagBool(args, 'hypothetical')) {
    return readMarket(config.client, requireAddress(args, 'market'));
  }
  const presetSource = flagString(args, 'preset-from');
  const preset = await readPreset(
    config,
    presetSource ? requireAddress(args, 'preset-from') : DEFAULT_PRESET_MARKET,
  );
  return buildHypotheticalMarket(config, args, preset);
}

export function readChain(args: ParsedArgs): 'mainnet' | 'testnet' | undefined {
  const chain = flagString(args, 'chain');
  if (chain === undefined) return undefined;
  if (chain !== 'mainnet' && chain !== 'testnet') {
    throw new ArgError(`--chain must be mainnet or testnet, got ${chain}`);
  }
  return chain;
}

export interface SeedReport {
  readonly text: string;
  readonly ladder: Ladder;
  readonly calls: readonly PlannedCall[];
  /**
   * True when `--simulate` ran and found the book would reject the ladder. `undefined`
   * when `--simulate` was not passed at all — the caller has no evidence either way.
   * The command exits nonzero on `true` rather than the 0 it always returned before
   * (High #22): a REJECTED simulation is a real answer, not a note in the printout.
   */
  readonly simulationRejected?: boolean;
}

export async function buildSeedReport(
  config: KitConfig,
  view: MarketView,
  args: ParsedArgs,
): Promise<SeedReport> {
  const band = parseBand(flagString(args, 'band') ?? '0.98..1.02');
  const levels = flagInt(args, 'levels') ?? 6;
  const feeBps = requireBigInt(args, 'fee-bps');
  const side = readSide(args);
  const sizePerLevelQuote = requireAmount(args, 'size-per-level', view.params.quoteDecimals);
  const refWire = flagPriceWire(args, 'ref');

  const anchor = resolveAnchor({ bidWire: view.bestBidWire, askWire: view.bestAskWire }, refWire);
  const refSource = requireRefSource(args, anchor);

  const ladder = buildLadder(
    { address: view.address, symbol: view.symbol },
    {
      params: view.params,
      anchor,
      feeBps,
      levels,
      bandLow: band.low,
      bandHigh: band.high,
      sizePerLevelQuote,
      side,
    },
  );

  const marginAccount = marginAccountAddress(config);
  const skipDeposits = flagBool(args, 'no-deposit');
  const funding = skipDeposits
    ? { calls: [] as PlannedCall[], lines: ['deposits skipped (--no-deposit)'] }
    : await buildFundingCalls(config, view, ladder, marginAccount);

  const provision = planCall({
    label: `batchProvisionLiquidity — ${ladder.levels.length} flip orders`,
    to: view.address,
    abi: orderBookAbi as never,
    functionName: 'batchProvisionLiquidity',
    args: [
      ladder.levels.map((l) => l.price),
      ladder.levels.map((l) => l.flipPrice),
      ladder.levels.map((l) => l.size),
      ladder.levels.map((l) => l.side === 'buy'),
      true,
    ],
  });

  const calls: PlannedCall[] = [...funding.calls, provision];

  const sections: string[] = [
    heading(`kit seed — ${view.symbol}  ${view.address}`),
    marketHeader(config, view),
    heading('LADDER'),
    renderLadderSummary(ladder, refSource),
    '',
    renderLadder(ladder),
    heading('FUNDING'),
    funding.lines.join('\n'),
    heading(`WOULD SEND — ${calls.length} transaction(s), in this order`),
    calls.map((call, i) => renderPlannedCall(call, i + 1)).join('\n\n'),
    capitalNote(ladder),
  ];

  let simulationRejected: boolean | undefined;

  if (flagBool(args, 'simulate') && isHypothetical(view)) {
    sections.push(
      heading('WOULD THE BOOK ACCEPT THIS LADDER? (eth_simulateV1: deploy, then provision)'),
    );
    const simulation = await renderNewMarketSimulation(config, view, ladder, provision, marginAccount);
    sections.push(simulation.text);
    simulationRejected = !simulation.ok;
  } else if (flagBool(args, 'simulate')) {
    const results = await simulatePlan(config.client, config.from, calls);
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
    sections.push(
      '\n  Note: each call is simulated against CURRENT state, not against the state the\n' +
        '  previous call in this plan would create. The deposits revert while the operator\n' +
        '  has not moved the money yet, and the provision reverts after them for want of\n' +
        '  collateral. That says nothing about the ladder itself, which is what the next\n' +
        '  section is for.',
    );

    const funded = await simulateProvisionFunded(
      config.client,
      config.from,
      provision,
      marginAccount,
      [
        { token: view.quote.address, amount: ladder.totalQuote },
        { token: view.base.address, amount: ladder.totalBase },
      ],
    );
    sections.push(heading('WOULD THE BOOK ACCEPT THIS LADDER? (eth_call, MarginAccount funded)'));
    simulationRejected = !funded.ok;
    sections.push(
      [
        `  batchProvisionLiquidity  ${funded.ok ? 'ACCEPTED' : `REJECTED — ${funded.reason}`}`,
        '',
        "  The operator's MarginAccount balances were overridden to exactly the ladder's",
        `  requirement (${ladder.totalQuote} ${view.quote.symbol} and ${ladder.totalBase} ` +
          `${view.base.symbol}, both in base units)`,
        '  and the real OrderBook was called. Nothing was sent: eth_call cannot send. Every',
        '  price, tick, size and provisioning check in the contract still ran, so PriceError,',
        '  TickSizeError, SizeError and ProvisionError would all have surfaced here.',
      ].join('\n'),
    );
  }

  return {
    text: sections.join('\n'),
    ladder,
    calls,
    ...(simulationRejected === undefined ? {} : { simulationRejected }),
  };
}

/**
 * `caps.ts` caps a *user* order at $6 of notional and allowlists one market. Those
 * caps govern the sponsored live path in spec §5 — a leaked relayer key, a user
 * mis-typing an amount. Seeding is the operator spending their own capital from their
 * own key, sized by phases §3.1 task 1.8 at about $100 a side, so the kit does not
 * apply them. It says so out loud instead of applying a limit that would make the
 * command useless, or applying nothing and saying nothing.
 */
export function capitalNote(ladder: Ladder): string {
  const perLevel = ladder.sizePerLevelQuote;
  if (perLevel <= MAX_ORDER_NOTIONAL_AUSD) return '';
  return (
    `\nNOTE  Each level is ${formatAusd(perLevel)} of quote, above the ` +
    `${formatAusd(MAX_ORDER_NOTIONAL_AUSD)} per-order cap in core/chain/caps.ts.\n` +
    `      That cap governs the sponsored user path (spec §5), not operator seeding: the\n` +
    `      kit signs with the deployer key and spends the operator's own capital. Sizing\n` +
    `      here is the owner's call.`
  );
}

/**
 * A `--ref` price has to say where it came from.
 *
 * `resolveAnchor` already refuses to invent a reference price. This goes one step
 * further: when the ladder is anchored on `--ref` rather than on the book, the dry run
 * must carry the provenance of that number, because it is the one figure in the whole
 * plan that no reader can check against the chain. "1.0000, because stablecoins" is a
 * guess; "1.0000, cross-checked against the live AUSD/USDC book and a Kuru Flow
 * round-trip on <date>" is a measurement someone can repeat.
 */
export function requireRefSource(args: ParsedArgs, anchor: { source: string }): string | undefined {
  const given = flagString(args, 'ref-source');
  if (anchor.source !== 'ref') return given;
  if (!given || given.trim().length === 0) {
    throw new ArgError(
      '--ref-source is required whenever the ladder is anchored on --ref. Say where the ' +
        'price came from — a book you read, a quote you took, a date — so the dry run ' +
        'records it. This tool will not print an unsourced reference price.',
    );
  }
  return given.trim();
}

function readSide(args: ParsedArgs): LadderSide {
  const side = flagString(args, 'side') ?? 'both';
  if (side !== 'buy' && side !== 'sell' && side !== 'both') {
    throw new ArgError(`--side must be buy, sell or both; got ${side}`);
  }
  return side;
}

export function marketHeader(config: KitConfig, view: MarketView): string {
  const hypothetical = isHypothetical(view)
    ? [
        '*** HYPOTHETICAL MARKET — NOTHING IS DEPLOYED AT THIS ADDRESS ***',
        `  _type           ${view.type} (${view.typeName})`,
        `  param preset    copied live from ${view.presetFrom}`,
        '  The address above is Router.computeAddress() for these exact parameters, so it is',
        '  where `kit deploy` would put this market. Both token addresses were read on chain',
        '  for their real decimals() and symbol(). The book is empty by definition, which is',
        '  why --ref is required. This plan cannot be submitted.',
        '',
      ]
    : [];
  return [
    ...hypothetical,
    `chain             ${config.mode} (${config.client.chain?.id})  block ${view.blockNumber}`,
    `mode              MODE=${config.gate.runMode}  CHAIN=${config.gate.mode}  ` +
      `funds acknowledged=${config.gate.realFundsAcknowledged}`,
    `operator          ${config.from}`,
    `base              ${view.base.symbol}  ${view.base.address}  ${view.base.decimals} dp` +
      `${view.base.native ? '  (native MON)' : ''}`,
    `quote             ${view.quote.symbol}  ${view.quote.address}  ${view.quote.decimals} dp` +
      `${view.quote.native ? '  (native MON)' : ''}`,
    `pricePrecision    ${view.params.pricePrecision}`,
    `sizePrecision     ${view.params.sizePrecision}`,
    `fees              taker ${view.params.takerFeeBps} bps / maker ${view.params.makerFeeBps} bps`,
    `kuruAmmVault      ${view.vault.vault}  spread ${view.vault.spread}`,
  ].join('\n');
}

/**
 * Deposits, and the ERC-20 approvals they need.
 *
 * `MarginAccount.deposit(user, token, amount)` pulls with `safeTransferFrom` for an
 * ERC-20 and requires `msg.value == amount` for the native asset — both read from the
 * verified MarginAccount implementation `0x57cf97fe…` on 2026-09-02. Only the
 * shortfall is deposited: an operator who is already funded should not be asked to
 * move money twice.
 */
export async function buildFundingCalls(
  config: KitConfig,
  view: MarketView,
  ladder: Ladder,
  marginAccount: Address,
): Promise<{ calls: PlannedCall[]; lines: string[] }> {
  const calls: PlannedCall[] = [];
  const lines: string[] = [];

  const needs = [
    { token: view.quote, required: ladder.totalQuote, what: 'quote (buy side)' },
    { token: view.base, required: ladder.totalBase, what: 'base (sell side)' },
  ] as const;

  for (const need of needs) {
    if (need.required === 0n) {
      lines.push(`  ${need.token.symbol.padEnd(8)} not needed (${need.what} is empty)`);
      continue;
    }
    const held = await readMarginBalance(
      config.client,
      marginAccount,
      config.from,
      need.token.address,
    );
    const shortfall = need.required > held ? need.required - held : 0n;
    const human = (v: bigint) =>
      need.token.native
        ? formatBase(v, view.params)
        : need.token.address === view.quote.address
          ? formatQuote(v, view.params)
          : formatBase(v, view.params);

    lines.push(
      `  ${need.token.symbol.padEnd(8)} need ${human(need.required)}  ` +
        `in MarginAccount ${human(held)}  shortfall ${human(shortfall)}`,
    );
    if (shortfall === 0n) continue;

    if (!need.token.native) {
      const allowance = (await config.client.readContract({
        address: need.token.address,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [config.from, marginAccount],
      })) as bigint;
      if (allowance < shortfall) {
        calls.push(
          planCall({
            label: `approve ${need.token.symbol} to MarginAccount (exact amount)`,
            to: need.token.address,
            abi: erc20Abi as never,
            functionName: 'approve',
            args: [marginAccount, shortfall],
          }),
        );
        lines.push(
          `  ${' '.repeat(8)} allowance ${allowance} < ${shortfall}; an exact-amount approve is included`,
        );
      }
    }

    calls.push(
      planCall({
        label: `deposit ${human(shortfall)} ${need.token.symbol} into MarginAccount`,
        to: marginAccount,
        abi: marginAccountAbi as never,
        functionName: 'deposit',
        args: [config.from, need.token.address, shortfall],
        ...(need.token.native ? { value: shortfall } : {}),
      }),
    );
  }

  if (calls.length === 0) lines.push('  nothing to deposit; the MarginAccount is already funded');
  return { calls, lines };
}
