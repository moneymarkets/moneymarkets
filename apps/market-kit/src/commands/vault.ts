import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Address } from 'viem';
import { kuruAmmVaultDeployedAbi } from '@tradepro/core';
import {
  assertKnownFlags,
  flagAddress,
  flagAmount,
  flagBool,
  flagString,
  requireAddress,
  ArgError,
  type ParsedArgs,
} from '../args.js';
import { loadConfig, type KitConfig } from '../config.js';
import { formatBase, formatQuote, heading, renderPlannedCall } from '../format.js';
import {
  erc20Abi,
  previewVaultDeposit,
  readMarket,
  readVault,
  type MarketView,
  type VaultView,
} from '../market.js';
import { planCall, type PlannedCall } from '../plan.js';
import { simulatePlan, submitPlan, DryRunStop } from '../send.js';
import { pendingVaultCommand } from '../pendingVault.js';
import { readChain } from './seed.js';

export const VAULT_FLAGS = [
  'market',
  'pending',
  'deposit-base',
  'deposit-quote',
  'min-quote-consumed',
  'receiver',
  'dry-run',
  'simulate',
  'from',
  'chain',
  'rpc',
  'out',
] as const;

/**
 * `kit vault` — spec §8.4, and DECISIONS.md open item 6.
 *
 * The spec calls this an ERC-4626 deposit. **It is not.** Read from the verified
 * implementation `0xDC2A82E321866C30d62077945e067172C5f970F4` (`KuruAMMVault`,
 * solc 0.8.30, Etherscan V2 chainid 143, 2026-09-02) and confirmed against the live
 * MON/AUSD vault `0xf7Fbe88e3a15463a66e7Ce9946E56a9878EEba30`:
 *
 *   - `asset()` does not exist and reverts on chain. The vault holds **two** assets,
 *     `token1()` (base) and `token2()` (quote), and its share token is a plain
 *     solady ERC-20 with `permit`.
 *   - the deposit entry point is
 *     `deposit(uint256 baseDeposit, uint256 quoteDeposit, uint256 minQuoteConsumed,
 *      address receiver) payable returns (uint256 shares)` — selector `0xfad3cc4b`.
 *     The SDK 0.0.95 ABI in `core/abi/kuruAmmVault.ts` carries a three-argument
 *     `deposit(uint256,uint256,address)` whose selector does not occur anywhere in
 *     the deployed bytecode. `core/abi/kuruAmmVaultDeployed.ts` is what this command
 *     uses.
 *   - `totalAssets()` returns a **pair**: the vault's MarginAccount balance in each
 *     token, not a single ERC-4626 total.
 *   - `--deposit-quote` is a **ceiling, not an amount**. When the vault already has
 *     shares outstanding the contract recomputes the quote leg from the base leg at
 *     `vaultBestAsk()` and requires the recomputed value to be at or below what you
 *     passed (`InsufficientQuoteToken()` otherwise). Only the recomputed amount is
 *     pulled. On the very first deposit (`totalSupply() == 0`) both legs are taken as
 *     given and shares are `sqrt(base * quote) - 1000`.
 *   - `minQuoteConsumed` is the floor on that recomputed leg.
 */
export async function vaultCommand(args: ParsedArgs): Promise<number> {
  assertKnownFlags(args, VAULT_FLAGS);
  const config = loadConfig({
    mode: readChain(args),
    from: flagString(args, 'from'),
    rpcUrl: flagString(args, 'rpc'),
  });
  const pendingFile = flagString(args, 'pending');
  if (pendingFile !== undefined) return pendingVaultCommand(args, config, pendingFile);

  const market = requireAddress(args, 'market');
  const view = await readMarket(config.client, market);
  const vaultAddress = view.vault.vault;
  if (vaultAddress === '0x0000000000000000000000000000000000000000') {
    throw new ArgError(`${market} reports no KuruAMMVault`);
  }

  const vault = await readVault(config.client, vaultAddress, config.from);
  const depositBase = flagAmount(args, 'deposit-base', view.base.decimals) ?? 0n;
  const depositQuote = flagAmount(args, 'deposit-quote', view.quote.decimals) ?? 0n;
  if (depositBase <= 0n || depositQuote <= 0n) {
    throw new ArgError(
      '--deposit-base and --deposit-quote are both required and must be positive. The vault ' +
        'takes two assets; a single-sided deposit is not a shape it has.',
    );
  }
  const minQuoteConsumed = flagAmount(args, 'min-quote-consumed', view.quote.decimals) ?? 0n;
  const receiver = flagAddress(args, 'receiver') ?? config.from;

  const preview = await previewVaultDeposit(config.client, vaultAddress, depositBase, depositQuote);
  const calls = await buildVaultCalls(config, view, vault, {
    depositBase,
    depositQuote,
    minQuoteConsumed,
    receiver,
  });

  const sections = [
    heading(`kit vault — ${view.symbol}  vault ${vaultAddress}`),
    renderVaultState(config, view, vault),
    heading('DEPOSIT'),
    [
      `base   (token1)   ${formatBase(depositBase, view.params)} ${view.base.symbol}` +
        `${view.base.native ? '   attached as msg.value' : ''}`,
      `quote  (token2)   ${formatQuote(depositQuote, view.params)} ${view.quote.symbol}   ` +
        `CEILING — the contract recomputes this leg from the base leg when totalSupply > 0`,
      `minQuoteConsumed  ${formatQuote(minQuoteConsumed, view.params)} ${view.quote.symbol}`,
      `receiver          ${receiver}`,
      `previewDeposit    ${
        'shares' in preview ? `${preview.shares} shares` : `REVERTED — ${preview.revert}`
      }`,
      ...('revert' in preview
        ? [
            '',
            '  previewDeposit reverting is a property of the vault, not of this call. When a',
            '  vault has shares outstanding but effectively no reserves, the internal',
            '  rebalance rounds one reserve to zero and the share maths divides by it. A',
            '  deposit would revert the same way. See the note at the end of this report.',
          ]
        : []),
    ].join('\n'),
    heading(`WOULD SEND — ${calls.length} transaction(s), in this order`),
    calls.map((call, i) => renderPlannedCall(call, i + 1)).join('\n\n'),
  ];

  let simulationRejected = false;
  if (flagBool(args, 'simulate')) {
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
  console.log(text);

  const out = flagString(args, 'out');
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${text}\n`, 'utf8');
    console.log(`\nwritten to ${out}`);
  }

  // A REJECTED simulation is a real answer, not a note in the printout (High #22).
  const exitCode = simulationRejected ? 1 : 0;

  if (flagBool(args, 'dry-run') || config.dryRun) {
    console.log(`\n${new DryRunStop(calls).message}`);
    return exitCode;
  }
  if (simulationRejected) {
    console.log('\n--simulate found a call that would revert. Nothing was sent.');
    return exitCode;
  }
  await submitPlan(config, calls);
  return exitCode;
}

export interface VaultDepositInput {
  readonly depositBase: bigint;
  readonly depositQuote: bigint;
  readonly minQuoteConsumed: bigint;
  readonly receiver: Address;
}

export async function buildVaultCalls(
  config: KitConfig,
  view: MarketView,
  vault: VaultView,
  input: VaultDepositInput,
): Promise<PlannedCall[]> {
  const calls: PlannedCall[] = [];

  // The vault pulls ERC-20 legs with `safeTransferFrom(msg.sender, …)` before handing
  // them to the MarginAccount, so the approval is to the vault, not to MarginAccount.
  for (const leg of [
    { token: view.base, amount: input.depositBase },
    { token: view.quote, amount: input.depositQuote },
  ] as const) {
    if (leg.token.native) continue;
    const allowance = (await config.client.readContract({
      address: leg.token.address,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [config.from, vault.address],
    })) as bigint;
    if (allowance < leg.amount) {
      calls.push(
        planCall({
          label: `approve ${leg.token.symbol} to the vault (exact amount)`,
          to: leg.token.address,
          abi: erc20Abi as never,
          functionName: 'approve',
          args: [vault.address, leg.amount],
        }),
      );
    }
  }

  const nativeValue = view.base.native
    ? input.depositBase
    : view.quote.native
      ? input.depositQuote
      : 0n;

  calls.push(
    planCall({
      label: 'KuruAMMVault.deposit(baseDeposit, quoteDeposit, minQuoteConsumed, receiver)',
      to: vault.address,
      abi: kuruAmmVaultDeployedAbi as never,
      functionName: 'deposit',
      args: [input.depositBase, input.depositQuote, input.minQuoteConsumed, input.receiver],
      value: nativeValue,
    }),
  );
  return calls;
}

export function renderVaultState(config: KitConfig, view: MarketView, vault: VaultView): string {
  return [
    `chain             ${config.mode} (${config.client.chain?.id})  block ${view.blockNumber}`,
    `operator          ${config.from}`,
    `vault name        ${vault.name}`,
    `token1 (base)     ${vault.token1}`,
    `token2 (quote)    ${vault.token2}`,
    `SPREAD_CONSTANT   ${vault.spreadConstant}`,
    `totalSupply       ${vault.totalSupply} shares (${vault.shareDecimals} dp)`,
    `totalAssets       base ${formatBase(vault.reserve1, view.params)} ${view.base.symbol}  ` +
      `quote ${formatQuote(vault.reserve2, view.params)} ${view.quote.symbol}`,
    `                  (both are the vault's MarginAccount balances, not token balances)`,
    `your shares       ${vault.shares}`,
    `ERC-4626          NO. asset() reverts; deposit takes two assets plus a floor and a`,
    `                  receiver. See DECISIONS.md open item 6.`,
  ].join('\n');
}
