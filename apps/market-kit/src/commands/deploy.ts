import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { decodeEventLog, parseUnits, zeroAddress, type Address, type Hash } from 'viem';
import {
  decodeMarketParams,
  decodeVaultParams,
  isNativeAsset,
  isPowerOfTen,
  orderBookTypeFor,
  orderBookTypeName,
  orderBookAbi,
  routerAbi,
} from '@tradepro/core';
import {
  assertKnownFlags,
  flagAmount,
  flagBigInt,
  flagBool,
  flagString,
  requireAddress,
  ArgError,
  type ParsedArgs,
} from '../args.js';
import { loadConfig, routerAddress, type KitConfig } from '../config.js';
import { heading, renderPlannedCall } from '../format.js';
import { erc20Abi, readToken, type TokenView } from '../market.js';
import { planCall, type PlannedCall } from '../plan.js';
import { simulatePlan, submitPlan, DryRunStop } from '../send.js';
import { readChain } from './seed.js';

export const DEPLOY_FLAGS = [
  'base',
  'quote',
  'preset-from',
  'price-precision',
  'size-precision',
  'tick',
  'min-size',
  'max-size',
  'taker-fee-bps',
  'maker-fee-bps',
  'amm-spread',
  'symbol',
  'dry-run',
  'simulate',
  'from',
  'chain',
  'rpc',
  'out',
  'markets-dir',
] as const;

/**
 * The market the presets are copied from unless `--preset-from` says otherwise:
 * MON/AUSD, the first market this repo deployed and gate-tested live on Monad
 * mainnet.
 *
 * Not an arbitrary or unverified address (audit High #24). It is the same one
 * `packages/core/src/kuru/params.ts`'s own decoders are cross-checked against (a live
 * `getMarketParams()` read on 2026-09-02), the one `caps.ts` allowlists for the
 * sponsored gate, and the one DECISIONS.md D126 discusses at length as an already-live
 * book at chain 143. Pinned by `commands.test.ts`, so a change here fails a test
 * rather than silently reaching a live deploy.
 */
export const DEFAULT_PRESET_MARKET: Address = '0x131A2e70A5b31a517A74b8c567149bc294470Da9';

export interface DeployPreset {
  readonly source: Address;
  readonly pricePrecision: bigint;
  readonly sizePrecision: bigint;
  readonly tickSize: bigint;
  readonly takerFeeBps: bigint;
  readonly makerFeeBps: bigint;
  readonly kuruAmmSpread: bigint;
}

/**
 * Read a live market's parameter scheme.
 *
 * Only the *scheme* is copied — precisions, tick, fees, AMM spread. `minSize` and
 * `maxSize` are deliberately not, because they are denominated in the base asset:
 * MON/AUSD's `minSize` of 2e12 sizePrecision units is 200 MON, and copying that
 * number onto a six-decimal stablecoin base would set a minimum order 12 orders of
 * magnitude out. The CLI requires them explicitly.
 */
export async function readPreset(config: KitConfig, source: Address): Promise<DeployPreset> {
  const [paramsTuple, vaultTuple] = await Promise.all([
    config.client.readContract({
      address: source,
      abi: orderBookAbi,
      functionName: 'getMarketParams',
    }),
    config.client.readContract({
      address: source,
      abi: orderBookAbi,
      functionName: 'getVaultParams',
    }),
  ]);
  const params = decodeMarketParams(paramsTuple as never);
  // The arity-checking decoder core already has for this exact tuple (High #23) — a
  // raw positional cast here would silently read the wrong field if `getVaultParams`
  // ever returned a different shape than the eight fields this was written against.
  const vault = decodeVaultParams(vaultTuple as never);
  return {
    source,
    pricePrecision: params.pricePrecision,
    sizePrecision: params.sizePrecision,
    tickSize: params.tickSize,
    takerFeeBps: params.takerFeeBps,
    makerFeeBps: params.makerFeeBps,
    kuruAmmSpread: vault.spread,
  };
}

export interface DeployPlan {
  readonly base: TokenView;
  readonly quote: TokenView;
  readonly type: number;
  readonly typeName: string;
  readonly pricePrecision: bigint;
  readonly sizePrecision: bigint;
  readonly tickSize: bigint;
  readonly minSize: bigint;
  readonly maxSize: bigint;
  readonly takerFeeBps: bigint;
  readonly makerFeeBps: bigint;
  readonly kuruAmmSpread: bigint;
  readonly predictedMarket: Address;
  readonly predictedVault: Address;
  readonly alreadyDeployed: boolean;
  readonly symbol: string;
  readonly preset: DeployPreset;
  readonly call: PlannedCall;
}

/**
 * `Router.deployProxy` refuses a precision that is not an exact power of ten
 * (`10 ** Math.log10(x) == x`) and a zero tick. Checked here so a typo costs a line
 * of output rather than a reverted transaction and a lost deployment slot.
 */
export function assertDeployParams(plan: {
  pricePrecision: bigint;
  sizePrecision: bigint;
  tickSize: bigint;
  minSize: bigint;
  maxSize: bigint;
}): void {
  if (!isPowerOfTen(plan.pricePrecision)) {
    throw new ArgError(
      `--price-precision ${plan.pricePrecision} is not a power of ten; Router.deployProxy ` +
        'reverts with InvalidPricePrecision()',
    );
  }
  if (!isPowerOfTen(plan.sizePrecision)) {
    throw new ArgError(
      `--size-precision ${plan.sizePrecision} is not a power of ten; Router.deployProxy ` +
        'reverts with InvalidSizePrecision()',
    );
  }
  if (plan.tickSize <= 0n) {
    throw new ArgError(
      '--tick must be positive; Router.deployProxy reverts with InvalidTickSize()',
    );
  }
  if (plan.tickSize > plan.pricePrecision) {
    throw new ArgError(
      `--tick ${plan.tickSize} is larger than --price-precision ${plan.pricePrecision}; ` +
        'every price would round to a whole unit',
    );
  }
  if (plan.minSize <= 0n) throw new ArgError('--min-size must be positive');
  if (plan.minSize > plan.maxSize) throw new ArgError('--min-size is above --max-size');
}

export async function buildDeployPlan(config: KitConfig, args: ParsedArgs): Promise<DeployPlan> {
  const router = routerAddress(config);
  const baseAddress = requireAddress(args, 'base');
  const quoteAddress = requireAddress(args, 'quote');

  const type = orderBookTypeFor(baseAddress, quoteAddress);
  const typeName = orderBookTypeName(type);

  const [base, quote] = await Promise.all([
    resolveToken(config, baseAddress),
    resolveToken(config, quoteAddress),
  ]);

  const presetSource =
    (flagString(args, 'preset-from') as Address | undefined) ?? DEFAULT_PRESET_MARKET;
  const preset = await readPreset(config, presetSource);

  const pricePrecision = flagBigInt(args, 'price-precision') ?? preset.pricePrecision;
  const sizePrecision = flagBigInt(args, 'size-precision') ?? preset.sizePrecision;
  const tickSize = flagBigInt(args, 'tick') ?? preset.tickSize;
  const takerFeeBps = flagBigInt(args, 'taker-fee-bps') ?? preset.takerFeeBps;
  const makerFeeBps = flagBigInt(args, 'maker-fee-bps') ?? preset.makerFeeBps;
  const kuruAmmSpread = flagBigInt(args, 'amm-spread') ?? preset.kuruAmmSpread;

  const minSizeHuman = flagAmount(args, 'min-size', base.decimals);
  const maxSizeHuman = flagAmount(args, 'max-size', base.decimals);
  if (minSizeHuman === undefined || maxSizeHuman === undefined) {
    throw new ArgError(
      '--min-size and --max-size are required, in whole units of the base asset. They are ' +
        'not copied from the preset: they are denominated in the base asset, so a preset ' +
        'value would be meaningless on a different base.',
    );
  }
  const minSize = (minSizeHuman * sizePrecision) / 10n ** BigInt(base.decimals);
  const maxSize = (maxSizeHuman * sizePrecision) / 10n ** BigInt(base.decimals);

  assertDeployParams({ pricePrecision, sizePrecision, tickSize, minSize, maxSize });

  const [predictedMarket, predictedVaultFor] = [
    (await config.client.readContract({
      address: router,
      abi: routerAbi,
      functionName: 'computeAddress',
      args: [
        base.address,
        quote.address,
        sizePrecision,
        Number(pricePrecision),
        Number(tickSize),
        minSize,
        maxSize,
        takerFeeBps,
        makerFeeBps,
        kuruAmmSpread,
        zeroAddress,
        false,
      ],
    })) as Address,
    router,
  ];

  const predictedVault = (await config.client.readContract({
    address: predictedVaultFor,
    abi: routerAbi,
    functionName: 'computeVaultAddress',
    args: [predictedMarket, zeroAddress, false],
  })) as Address;

  const code = await config.client.getCode({ address: predictedMarket });
  const alreadyDeployed = code !== undefined && code !== '0x';

  const call = planCall({
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
      minSize,
      maxSize,
      takerFeeBps,
      makerFeeBps,
      kuruAmmSpread,
    ],
  });

  return {
    base,
    quote,
    type,
    typeName,
    pricePrecision,
    sizePrecision,
    tickSize,
    minSize,
    maxSize,
    takerFeeBps,
    makerFeeBps,
    kuruAmmSpread,
    predictedMarket,
    predictedVault,
    alreadyDeployed,
    symbol: flagString(args, 'symbol') ?? `${base.symbol}_${quote.symbol}`,
    preset,
    call,
  };
}

async function resolveToken(config: KitConfig, address: Address): Promise<TokenView> {
  if (isNativeAsset(address)) return readToken(config.client, address, 18);
  const decimals = (await config.client.readContract({
    address,
    abi: erc20Abi,
    functionName: 'decimals',
  })) as number;
  return readToken(config.client, address, Number(decimals));
}

export function renderDeployPlan(config: KitConfig, plan: DeployPlan): string {
  return [
    heading(`kit deploy — ${plan.base.symbol}/${plan.quote.symbol}`),
    [
      `chain             ${config.mode} (${config.client.chain?.id})`,
      `mode              MODE=${config.gate.runMode}  CHAIN=${config.gate.mode}  ` +
        `funds acknowledged=${config.gate.realFundsAcknowledged}`,
      `operator          ${config.from}`,
      `router            ${routerAddress(config)}`,
      '',
      `_type             ${plan.type} (${plan.typeName})`,
      `                  DECISIONS.md open item 5. enum OrderBookType ` +
        `{ NO_NATIVE=0, NATIVE_IN_BASE=1, NATIVE_IN_QUOTE=2 } from the verified Router`,
      `                  implementation; the Router requires it to agree with which side is`,
      `                  address(0), so it is derived, not chosen.`,
      '',
      `base              ${plan.base.symbol}  ${plan.base.address}  ${plan.base.decimals} dp`,
      `quote             ${plan.quote.symbol}  ${plan.quote.address}  ${plan.quote.decimals} dp`,
      '',
      `preset copied from ${plan.preset.source} (read live)`,
      `  pricePrecision  ${plan.pricePrecision}${mark(plan.pricePrecision, plan.preset.pricePrecision)}`,
      `  sizePrecision   ${plan.sizePrecision}${mark(plan.sizePrecision, plan.preset.sizePrecision)}`,
      `  tickSize        ${plan.tickSize}${mark(plan.tickSize, plan.preset.tickSize)}`,
      `  takerFeeBps     ${plan.takerFeeBps}${mark(plan.takerFeeBps, plan.preset.takerFeeBps)}`,
      `  makerFeeBps     ${plan.makerFeeBps}${mark(plan.makerFeeBps, plan.preset.makerFeeBps)}`,
      `  kuruAmmSpread   ${plan.kuruAmmSpread}${mark(plan.kuruAmmSpread, plan.preset.kuruAmmSpread)}`,
      `  minSize         ${plan.minSize} sizePrecision units  (explicit, never copied)`,
      `  maxSize         ${plan.maxSize} sizePrecision units  (explicit, never copied)`,
      '',
      `predicted market  ${plan.predictedMarket}`,
      `predicted vault   ${plan.predictedVault}`,
      `already deployed  ${plan.alreadyDeployed ? 'YES — this exact parameter set is already live' : 'no'}`,
    ].join('\n'),
    heading('WOULD SEND — 1 transaction'),
    renderPlannedCall(plan.call, 1),
  ].join('\n');
}

function mark(chosen: bigint, preset: bigint): string {
  return chosen === preset ? '' : `   (overridden; preset was ${preset})`;
}

export async function deployCommand(args: ParsedArgs): Promise<number> {
  assertKnownFlags(args, DEPLOY_FLAGS);
  const config = loadConfig({
    mode: readChain(args),
    from: flagString(args, 'from'),
    rpcUrl: flagString(args, 'rpc'),
  });
  const plan = await buildDeployPlan(config, args);

  let text = renderDeployPlan(config, plan);
  let simulationRejected = false;
  if (flagBool(args, 'simulate')) {
    const [result] = await simulatePlan(config.client, config.from, [plan.call]);
    simulationRejected = !result?.ok;
    text += `\n${heading('SIMULATION (eth_call)')}\n  ${
      result?.ok ? 'ok' : `REVERT — ${result?.reason ?? 'unknown'}`
    }`;
  }
  console.log(text);

  const out = flagString(args, 'out');
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${text}\n`, 'utf8');
    console.log(`\nwritten to ${out}`);
  }

  if (plan.alreadyDeployed) {
    console.log(
      `\nRefusing to deploy: ${plan.predictedMarket} already has code. The CREATE2 salt is ` +
        'this exact parameter set, so a redeploy would revert with FailedDeployment(). ' +
        'Change a parameter or use the existing market.',
    );
    return 1;
  }

  const dir = flagString(args, 'markets-dir') ?? join(process.cwd(), 'markets');
  // A REJECTED simulation is a real answer, not a note in the printout (High #22) —
  // this used to exit 0 whatever the simulation said.
  const exitCode = simulationRejected ? 1 : 0;

  if (flagBool(args, 'dry-run') || config.dryRun) {
    const pending = writePendingRecord(config, plan, dir);
    console.log(`\nwritten ${pending}`);
    console.log(
      '\nThat file is the contract this deploy is held to: the same predicted addresses\n' +
        'and the same eleven parameters the calldata above carries. After the live run,\n' +
        '`kit deploy` reads getMarketParams() back off the new market and compares it to\n' +
        'this record before writing the confirmed one.',
    );
    console.log(`\n${new DryRunStop([plan.call]).message}`);
    return exitCode;
  }

  if (simulationRejected) {
    // Never submit what --simulate just showed would revert.
    console.log('\n--simulate found this deploy would revert. Nothing was sent.');
    return exitCode;
  }

  const [hash] = await submitPlan(config, [plan.call]);
  const registered = await confirmRegistration(config, hash!, plan);
  assertMatchesPending(plan, dir, registered);
  const file = join(dir, `${plan.symbol}.json`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(registered, null, 2) + '\n', 'utf8');
  console.log(`\nwritten ${file}`);
  return exitCode;
}

/**
 * What `deployProxy` is about to be asked for, written before it is asked.
 *
 * A dry run that only prints is reviewable but not checkable: nothing afterwards can
 * say whether the transaction that eventually ran carried the parameters the owner
 * approved. `markets/<symbol>.pending.json` is that record — the derived `_type`, the
 * eleven arguments, the calldata, and the CREATE2 addresses the Router itself
 * predicted. The live path reads it back and refuses to write a confirmed record that
 * disagrees with it.
 */
export function pendingRecord(config: KitConfig, plan: DeployPlan): Record<string, unknown> {
  return {
    status: 'pending',
    symbol: plan.symbol,
    chainId: config.client.chain?.id,
    router: routerAddress(config),
    operator: config.from,
    predictedMarket: plan.predictedMarket,
    predictedVault: plan.predictedVault,
    type: plan.type,
    typeName: plan.typeName,
    baseAsset: plan.base.address,
    baseSymbol: plan.base.symbol,
    baseDecimals: plan.base.decimals,
    quoteAsset: plan.quote.address,
    quoteSymbol: plan.quote.symbol,
    quoteDecimals: plan.quote.decimals,
    pricePrecision: plan.pricePrecision.toString(),
    sizePrecision: plan.sizePrecision.toString(),
    tickSize: plan.tickSize.toString(),
    minSize: plan.minSize.toString(),
    maxSize: plan.maxSize.toString(),
    takerFeeBps: plan.takerFeeBps.toString(),
    makerFeeBps: plan.makerFeeBps.toString(),
    kuruAmmSpread: plan.kuruAmmSpread.toString(),
    presetFrom: plan.preset.source,
    call: {
      to: plan.call.to,
      selector: plan.call.data.slice(0, 10),
      value: plan.call.value.toString(),
      data: plan.call.data,
    },
    preparedAt: new Date().toISOString(),
  };
}

export function writePendingRecord(config: KitConfig, plan: DeployPlan, dir: string): string {
  const file = join(dir, `${plan.symbol}.pending.json`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(pendingRecord(config, plan), null, 2) + '\n', 'utf8');
  return file;
}

/**
 * Refuse to record a deployment that does not match the one that was approved.
 *
 * No pending file is not an error — a first live run may never have had one — but a
 * pending file that disagrees is, because it means the parameters changed between
 * review and signing.
 */
export function assertMatchesPending(
  plan: DeployPlan,
  dir: string,
  registered: Record<string, unknown>,
): void {
  const file = join(dir, `${plan.symbol}.pending.json`);
  if (!existsSync(file)) return;
  const approved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const compared = [
    'type',
    'baseAsset',
    'quoteAsset',
    'pricePrecision',
    'sizePrecision',
    'tickSize',
    'minSize',
    'maxSize',
    'takerFeeBps',
    'makerFeeBps',
  ] as const;
  const differences = compared.filter(
    (key) => String(approved[key]).toLowerCase() !== String(registered[key]).toLowerCase(),
  );
  if (approved.predictedMarket !== undefined && registered.market !== undefined) {
    if (
      String(approved.predictedMarket).toLowerCase() !== String(registered.market).toLowerCase()
    ) {
      differences.push('predictedMarket' as never);
    }
  }
  if (differences.length > 0) {
    throw new Error(
      `the deployed market disagrees with ${file} on ${differences.join(', ')}. ` +
        'That file records what was reviewed; refusing to overwrite the confirmed record.',
    );
  }
}

/**
 * Wait for `MarketRegistered`, then read `getMarketParams()` back off the new market.
 *
 * The event is the Router's account of what it did; the read-back is the market's.
 * They are compared, because a mismatch would mean the address in the event is not
 * the contract that holds those params.
 */
export async function confirmRegistration(
  config: KitConfig,
  hash: Hash,
  plan: DeployPlan,
): Promise<Record<string, unknown>> {
  const receipt = await config.client.waitForTransactionReceipt({ hash });
  let registered: Record<string, unknown> | undefined;
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({ abi: routerAbi, data: log.data, topics: log.topics });
      if (decoded.eventName === 'MarketRegistered') {
        registered = decoded.args as unknown as Record<string, unknown>;
      }
    } catch {
      // Not a Router event; the receipt also carries the market's own logs.
    }
  }
  if (!registered) throw new Error(`no MarketRegistered event in ${hash}`);
  const market = registered.market as Address;
  if (market.toLowerCase() !== plan.predictedMarket.toLowerCase()) {
    throw new Error(
      `MarketRegistered names ${market} but computeAddress predicted ${plan.predictedMarket}`,
    );
  }
  const readBack = decodeMarketParams(
    (await config.client.readContract({
      address: market,
      abi: orderBookAbi,
      functionName: 'getMarketParams',
    })) as never,
  );
  if (
    readBack.pricePrecision !== plan.pricePrecision ||
    readBack.sizePrecision !== plan.sizePrecision ||
    readBack.tickSize !== plan.tickSize ||
    readBack.minSize !== plan.minSize ||
    readBack.maxSize !== plan.maxSize
  ) {
    throw new Error('getMarketParams() read back from the new market does not match what was sent');
  }
  return {
    symbol: plan.symbol,
    chainId: config.client.chain?.id,
    market,
    vault: registered.vaultAddress,
    deployTx: hash,
    block: receipt.blockNumber.toString(),
    type: plan.type,
    typeName: plan.typeName,
    baseAsset: readBack.baseAsset,
    baseDecimals: readBack.baseDecimals,
    quoteAsset: readBack.quoteAsset,
    quoteDecimals: readBack.quoteDecimals,
    pricePrecision: readBack.pricePrecision.toString(),
    sizePrecision: readBack.sizePrecision.toString(),
    tickSize: readBack.tickSize.toString(),
    minSize: readBack.minSize.toString(),
    maxSize: readBack.maxSize.toString(),
    takerFeeBps: readBack.takerFeeBps.toString(),
    makerFeeBps: readBack.makerFeeBps.toString(),
    kuruAmmSpread: plan.kuruAmmSpread.toString(),
    presetFrom: plan.preset.source,
    readBackAt: new Date().toISOString(),
  };
}

/** Exported for tests: human base units -> sizePrecision units. */
export function toSizePrecisionUnits(
  human: string,
  baseDecimals: number,
  sizePrecision: bigint,
): bigint {
  return (parseUnits(human, baseDecimals) * sizePrecision) / 10n ** BigInt(baseDecimals);
}
