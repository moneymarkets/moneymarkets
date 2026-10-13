import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { getAddress, isAddress, type Address } from 'viem';
import { kuruAmmVaultDeployedAbi } from '@tradepro/core';
import { flagAddress, flagBool, flagString, ArgError, type ParsedArgs } from './args.js';
import type { KitConfig } from './config.js';
import { heading, renderPlannedCall } from './format.js';
import { erc20Abi } from './market.js';
import { planCall, type PlannedCall } from './plan.js';
import { DryRunStop } from './send.js';

/**
 * The vault deposit for a market that has not been deployed yet.
 *
 * `kit vault --market <addr>` reads the live vault. A vault that does not exist has
 * nothing to read: `token1()`, `totalSupply()` and `previewDeposit()` all return `0x`,
 * and viem turns that into a decode error rather than a number. So this path builds
 * the call from `markets/<symbol>.pending.json` — the record `kit deploy --dry-run`
 * wrote — and is explicit that it is a *prepared* call, not a simulated one.
 *
 * It is not simulated, and the reason matters. The vault pulls both legs with
 * `safeTransferFrom(msg.sender, …)`, so a simulation would need the operator to hold
 * real USDT0 and AUSD. Overriding those balances means writing to two ERC-20 storage
 * slots whose layouts have not been read from verified source — AUSD's balance mapping
 * is not at any plain slot 0..39 and is not at the ERC-7201 namespaces tried, so it
 * would have to be guessed, and rule A2.5 forbids that. A simulation that needs a
 * guessed storage layout to pass is not evidence.
 *
 * What is checked here without guessing anything: the first deposit takes the
 * `totalSupply() == 0` branch, where both legs are used as given and shares are
 * `sqrt(base * quote) - 1000`. That number is computed and printed, so the operator
 * knows what a successful deposit should mint before signing one.
 */
export interface PendingMarketRecord {
  readonly symbol: string;
  readonly chainId: number;
  readonly predictedMarket: Address;
  readonly predictedVault: Address;
  readonly baseAsset: Address;
  readonly baseSymbol: string;
  readonly baseDecimals: number;
  readonly quoteAsset: Address;
  readonly quoteSymbol: string;
  readonly quoteDecimals: number;
  readonly kuruAmmSpread: string;
}

export function readPendingMarket(file: string): PendingMarketRecord {
  if (!existsSync(file)) {
    throw new ArgError(
      `no pending market record at ${file}. Run \`kit deploy --dry-run --markets-dir <dir>\` ` +
        'first; that is what writes it.',
    );
  }
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const address = (key: string): Address => {
    const value = raw[key];
    if (typeof value !== 'string' || !isAddress(value)) {
      throw new ArgError(`${file} has no usable ${key}`);
    }
    return getAddress(value);
  };
  const decimals = (key: string): number => {
    const value = raw[key];
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new ArgError(`${file} has no usable ${key}`);
    }
    return value;
  };
  return {
    symbol: String(raw.symbol ?? 'unknown'),
    chainId: Number(raw.chainId),
    predictedMarket: address('predictedMarket'),
    predictedVault: address('predictedVault'),
    baseAsset: address('baseAsset'),
    baseSymbol: String(raw.baseSymbol ?? '?'),
    baseDecimals: decimals('baseDecimals'),
    quoteAsset: address('quoteAsset'),
    quoteSymbol: String(raw.quoteSymbol ?? '?'),
    quoteDecimals: decimals('quoteDecimals'),
    kuruAmmSpread: String(raw.kuruAmmSpread ?? '?'),
  };
}

/** Integer square root. The first deposit mints `sqrt(base * quote) - 1000` shares. */
export function isqrt(value: bigint): bigint {
  if (value < 0n) throw new Error('isqrt of a negative');
  if (value < 2n) return value;
  let x = value;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }
  return x;
}

export const MINIMUM_LIQUIDITY = 1000n;

export async function pendingVaultCommand(
  args: ParsedArgs,
  config: KitConfig,
  file: string,
): Promise<number> {
  const record = readPendingMarket(file);
  if (record.chainId !== config.client.chain?.id) {
    throw new ArgError(
      `${file} was prepared for chain ${record.chainId}, but this run is on ` +
        `${config.client.chain?.id}.`,
    );
  }

  const depositBase = requirePositive(args, 'deposit-base', record.baseDecimals);
  const depositQuote = requirePositive(args, 'deposit-quote', record.quoteDecimals);
  const minQuoteConsumed = amountOrZero(args, 'min-quote-consumed', record.quoteDecimals);
  const receiver = flagAddress(args, 'receiver') ?? config.from;

  const deployed = await config.client.getCode({ address: record.predictedVault });
  if (deployed !== undefined && deployed !== '0x') {
    throw new ArgError(
      `${record.predictedVault} already has code — the market exists. Drop --pending and ` +
        `run \`kit vault --market ${record.predictedMarket} --simulate\`, which reads the ` +
        'real vault instead of a prepared record.',
    );
  }

  const shares = isqrt(depositBase * depositQuote) - MINIMUM_LIQUIDITY;
  const calls = buildPendingVaultCalls(record, {
    depositBase,
    depositQuote,
    minQuoteConsumed,
    receiver,
  });

  const text = [
    heading(`kit vault — ${record.symbol}  vault ${record.predictedVault}  (PREPARED)`),
    [
      '*** THE MARKET AND ITS VAULT DO NOT EXIST YET ***',
      `  prepared from   ${file}`,
      `  market          ${record.predictedMarket}`,
      `  vault           ${record.predictedVault}  (Router.computeVaultAddress)`,
      '  Both addresses are what the Router itself predicted for this parameter set. The',
      '  call below is built and printed; it is not simulated, because the vault pulls both',
      '  legs with safeTransferFrom and simulating that would need this repo to guess two',
      '  ERC-20 balance storage slots it has not read. Run `kit vault --market <addr>',
      '  --simulate` after the deploy, which reads the real contract.',
      '',
      `chain             ${config.mode} (${config.client.chain?.id})`,
      `mode              MODE=${config.gate.runMode}  CHAIN=${config.gate.mode}  ` +
        `funds acknowledged=${config.gate.realFundsAcknowledged}`,
      `operator          ${config.from}`,
      `token1 (base)     ${record.baseSymbol}  ${record.baseAsset}  ${record.baseDecimals} dp`,
      `token2 (quote)    ${record.quoteSymbol}  ${record.quoteAsset}  ${record.quoteDecimals} dp`,
      `kuruAmmSpread     ${record.kuruAmmSpread}`,
      'ERC-4626          NO. asset() does not exist; deposit takes two amounts, a floor and',
      '                  a receiver — selector 0xfad3cc4b. DECISIONS.md open item 6, and',
      '                  conflict C9 against spec §8.4.',
    ].join('\n'),
    heading('FIRST DEPOSIT'),
    [
      `base   (token1)   ${format(depositBase, record.baseDecimals)} ${record.baseSymbol}  ` +
        `[${depositBase} base units]`,
      `quote  (token2)   ${format(depositQuote, record.quoteDecimals)} ${record.quoteSymbol}  ` +
        `[${depositQuote} base units]`,
      `minQuoteConsumed  ${format(minQuoteConsumed, record.quoteDecimals)} ${record.quoteSymbol}`,
      `receiver          ${receiver}`,
      `shares minted     ${shares}  = sqrt(base * quote) - ${MINIMUM_LIQUIDITY}`,
      '',
      '  This is the totalSupply() == 0 branch, and it is the only branch where both legs',
      '  are taken exactly as given. Once shares exist the contract recomputes the quote',
      '  leg from the base leg at vaultBestAsk() and treats --deposit-quote as a ceiling,',
      '  reverting with InsufficientQuoteToken() if the recomputed value is above it.',
      '',
      '  The first 1000 shares are burned as minimum liquidity and are never redeemable.',
      '  That is why the MON/AUSD vault is stuck: it holds 1000 shares against 5,885,231,097',
      '  wei of MON and one unit of AUSD, the internal rebalance rounds one half-valuation',
      '  to zero, and both previewDeposit and deposit revert with solady MulDivFailed()',
      '  [0xad251c27]. Verified by eth_call on 2026-09-02. A fresh vault takes this branch',
      '  instead, which is the case that works.',
    ].join('\n'),
    heading(`WOULD SEND — ${calls.length} transaction(s), in this order`),
    calls.map((call, i) => renderPlannedCall(call, i + 1)).join('\n\n'),
  ].join('\n');

  console.log(text);

  const out = flagString(args, 'out');
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${text}\n`, 'utf8');
    console.log(`\nwritten to ${out}`);
  }

  console.log(
    '\nPREPARED, not submittable. There is no contract at that vault address yet.\n' +
      `Deploy ${record.symbol} first, then re-run without --pending.`,
  );
  void flagBool(args, 'dry-run');
  console.log(`\n${new DryRunStop(calls).message}`);
  return 0;
}

export interface PendingVaultInput {
  readonly depositBase: bigint;
  readonly depositQuote: bigint;
  readonly minQuoteConsumed: bigint;
  readonly receiver: Address;
}

/**
 * Two exact-amount approvals and the deposit.
 *
 * Both approvals are unconditional here, unlike the live path: with no vault deployed
 * there is no allowance to read, and an allowance to a contract that does not exist is
 * zero by definition.
 */
export function buildPendingVaultCalls(
  record: PendingMarketRecord,
  input: PendingVaultInput,
): PlannedCall[] {
  return [
    planCall({
      label: `approve ${record.baseSymbol} to the vault (exact amount)`,
      to: record.baseAsset,
      abi: erc20Abi as never,
      functionName: 'approve',
      args: [record.predictedVault, input.depositBase],
    }),
    planCall({
      label: `approve ${record.quoteSymbol} to the vault (exact amount)`,
      to: record.quoteAsset,
      abi: erc20Abi as never,
      functionName: 'approve',
      args: [record.predictedVault, input.depositQuote],
    }),
    planCall({
      label: 'KuruAMMVault.deposit(baseDeposit, quoteDeposit, minQuoteConsumed, receiver)',
      to: record.predictedVault,
      abi: kuruAmmVaultDeployedAbi as never,
      functionName: 'deposit',
      args: [input.depositBase, input.depositQuote, input.minQuoteConsumed, input.receiver],
      // Neither leg is native on a NO_NATIVE market, so nothing is attached.
      value: 0n,
    }),
  ];
}

/**
 * `parseUnits`, but truncating any digits past `decimals` instead of rounding them.
 *
 * viem's own `parseUnits` rounds half-away-from-zero when the input has more
 * fractional digits than the token supports. For `--deposit-base`, `--deposit-quote`
 * and `--min-quote-consumed` — the three amounts that decide how much actually moves
 * and what floor protects the operator — that silently inflates whatever was typed by
 * up to one base unit, which for `--min-quote-consumed` is the slippage floor itself
 * (High #15). Truncating never invents a unit the operator did not type.
 */
export function parseUnitsFloor(value: string, decimals: number): bigint {
  if (!/^\d*(\.\d*)?$/.test(value) || value === '' || value === '.') {
    throw new ArgError(`not a valid amount: ${value}`);
  }
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt((whole === '' ? '0' : whole) + fraction.slice(0, decimals).padEnd(decimals, '0'));
}

function requirePositive(args: ParsedArgs, name: string, decimals: number): bigint {
  const text = flagString(args, name);
  if (text === undefined) {
    throw new ArgError(
      `--${name} is required. The vault takes two assets; a single-sided deposit is not a ` +
        'shape it has.',
    );
  }
  const value = parseUnitsFloor(text, decimals);
  if (value <= 0n) throw new ArgError(`--${name} must be positive`);
  return value;
}

function amountOrZero(args: ParsedArgs, name: string, decimals: number): bigint {
  const text = flagString(args, name);
  return text === undefined ? 0n : parseUnitsFloor(text, decimals);
}

function format(units: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const whole = units / scale;
  const fraction = (units % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction.length === 0 ? whole.toString() : `${whole}.${fraction}`;
}
