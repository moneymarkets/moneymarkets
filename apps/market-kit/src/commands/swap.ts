import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { formatUnits, isAddress, type Address } from 'viem';
import { KuruFlowClient, isNativeAsset, type FlowQuote } from '@tradepro/core';
import {
  assertKnownFlags,
  flagBool,
  flagInt,
  flagString,
  requireAddress,
  requireAmount,
  ArgError,
  type ParsedArgs,
} from '../args.js';
import { loadConfig, type KitConfig } from '../config.js';
import { heading, renderPlannedCall } from '../format.js';
import { erc20Abi, readToken, type TokenView } from '../market.js';
import { planCall, type PlannedCall } from '../plan.js';
import { simulatePlan, submitPlan, DryRunStop } from '../send.js';
import { readChain } from './seed.js';

export const SWAP_FLAGS = [
  'token-in',
  'token-out',
  'amount',
  'slippage',
  'referrer',
  'referrer-bps',
  'dry-run',
  'simulate',
  'from',
  'chain',
  'rpc',
  'out',
] as const;

/**
 * `kit swap` — buy the base asset a new market needs, through Kuru Flow.
 *
 * Seeding USDT0/AUSD needs USDT0, and the operator is funded in AUSD. There is no
 * USDT0/AUSD book to buy it on — that is the market being created — so the purchase
 * goes through Kuru's own aggregator, which is also the venue's revenue surface.
 *
 * Two facts about the Flow API that this command exists to keep straight, both
 * measured rather than remembered (see `core/kuru/flow.ts`):
 *
 *  - `transaction.calldata` comes back **without an `0x` prefix**. Passed straight to
 *    a wallet it produces an empty call that succeeds and swaps nothing.
 *  - the quote JWT is rate-limited to **one request per second, burst one**, so this
 *    command takes exactly one quote per run and never polls.
 *
 * The router the quote points at is not ERC-2771 aware (open item 9), so this swap can
 * never be relayed: it is signed by the operator's own key, on the operator's own gas,
 * and only when the `MODE` gate is open.
 */
export async function swapCommand(args: ParsedArgs): Promise<number> {
  assertKnownFlags(args, SWAP_FLAGS);

  const config = loadConfig({
    mode: readChain(args),
    from: flagString(args, 'from'),
    rpcUrl: flagString(args, 'rpc'),
  });

  const tokenInAddress = requireAddress(args, 'token-in');
  const tokenOutAddress = requireAddress(args, 'token-out');
  if (isNativeAsset(tokenInAddress)) {
    throw new ArgError(
      '--token-in must be an ERC-20. A native MON swap attaches msg.value, which this ' +
        'command does not build; use the Kuru app for that leg.',
    );
  }

  const [tokenIn, tokenOut] = await Promise.all([
    readTokenLive(config, tokenInAddress),
    readTokenLive(config, tokenOutAddress),
  ]);
  const amountIn = requireAmount(args, 'amount', tokenIn.decimals);

  const referrer = readReferrer(args, config);
  const client = new KuruFlowClient({});

  let quote: FlowQuote | undefined;
  let failure: string | undefined;
  try {
    quote = await client.quote({
      userAddress: config.from,
      tokenIn: tokenIn.address,
      tokenOut: tokenOut.address,
      amount: amountIn,
      ...(flagInt(args, 'slippage') !== undefined
        ? { slippageTolerance: flagInt(args, 'slippage')! }
        : { autoSlippage: true }),
      ...(referrer.address ? { referrerAddress: referrer.address } : {}),
      ...(referrer.feeBps !== undefined ? { referrerFeeBps: referrer.feeBps } : {}),
    });
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }

  if (!quote) {
    const text = [
      heading(
        `kit swap — ${formatUnits(amountIn, tokenIn.decimals)} ${tokenIn.symbol} -> ${tokenOut.symbol}`,
      ),
      header(config, tokenIn, tokenOut, amountIn),
      '',
      'NO QUOTE',
      `  The Kuru Flow API did not answer: ${failure}`,
      '',
      '  Nothing is built from a quote that does not exist. Re-run when the API is',
      '  reachable, or buy the base asset by hand and skip this step — the deploy and',
      '  seed commands only need the tokens to be in the operator wallet.',
    ].join('\n');
    console.log(text);
    writeOut(args, text);
    return 1;
  }

  const confirmed = assertQuoteValuesAppear(quote, tokenIn.address, tokenOut.address, amountIn);
  const calls = await buildSwapCalls(config, tokenIn, amountIn, quote);
  const text = renderSwap(config, tokenIn, tokenOut, amountIn, quote, referrer, calls, confirmed);
  console.log(text);

  let full = text;
  // Not a signal of a real problem the way deploy/seed's simulation is — the swap leg
  // is *expected* to revert until the operator actually holds and has approved the
  // input token, and the text below says so. Still reported truthfully in the exit
  // code (High #22): this command's own doc comment is the context that tells an
  // operator or a script whether a given nonzero exit was expected.
  let simulationRejected = false;
  if (flagBool(args, 'simulate')) {
    const results = await simulatePlan(config.client, config.from, calls);
    simulationRejected = results.some((r) => !r.ok);
    const simulation = [
      heading('SIMULATION (eth_call, current state)'),
      results
        .map(
          (r, i) =>
            `  [${i + 1}] ${r.ok ? 'ok    ' : 'REVERT'} ${r.call.label}` +
            (r.reason ? `\n        ${r.reason}` : ''),
        )
        .join('\n'),
      '',
      '  The swap leg reverts until the operator actually holds the input token and the',
      '  approve above has been mined. That is the expected answer before funding, and it',
      "  is reported rather than papered over: the input token's balance slot has not been",
      '  read from its verified source, so there is no honest way to override it here.',
    ].join('\n');
    console.log(`\n${simulation}`);
    full = `${text}\n${simulation}`;
  }

  writeOut(args, full);
  const exitCode = simulationRejected ? 1 : 0;

  if (flagBool(args, 'dry-run') || config.dryRun) {
    console.log(`\n${new DryRunStop(calls).message}`);
    return exitCode;
  }
  if (simulationRejected) {
    console.log('\n--simulate found a revert. Nothing was sent.');
    return exitCode;
  }
  await submitPlan(config, calls);
  return exitCode;
}

function writeOut(args: ParsedArgs, text: string): void {
  const out = flagString(args, 'out');
  if (!out) return;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${text}\n`, 'utf8');
  console.log(`\nwritten to ${out}`);
}

async function readTokenLive(config: KitConfig, address: Address): Promise<TokenView> {
  if (isNativeAsset(address)) return readToken(config.client, address, 18);
  const decimals = (await config.client.readContract({
    address,
    abi: erc20Abi,
    functionName: 'decimals',
  })) as number;
  return readToken(config.client, address, Number(decimals));
}

export interface ReferrerConfig {
  readonly address?: Address;
  readonly feeBps?: number;
  readonly note: string;
}

/**
 * The routing fee, and who gets it.
 *
 * Kuru Flow charges the referrer fee on top of the route; with no referrer configured
 * there is no such fee, and saying so is the point — a dry run that silently omits a
 * fee line reads the same whether the fee is zero or unread.
 */
export function readReferrer(args: ParsedArgs, config: KitConfig): ReferrerConfig {
  const env = process.env;
  const address = flagString(args, 'referrer') ?? env.KURU_FLOW_REFERRER;
  const bpsText = flagString(args, 'referrer-bps') ?? env.KURU_FLOW_REFERRER_BPS;
  void config;
  if (!address || address.length === 0) {
    return { note: 'none configured, so Flow charges no routing fee on this swap' };
  }
  if (!isAddress(address)) throw new ArgError(`--referrer ${address} is not an address`);
  const feeBps = bpsText === undefined ? undefined : Number(bpsText);
  if (feeBps !== undefined && (!Number.isInteger(feeBps) || feeBps < 0)) {
    throw new ArgError(`--referrer-bps ${bpsText} must be a non-negative integer`);
  }
  return {
    address,
    ...(feeBps !== undefined ? { feeBps } : {}),
    note: `${address}${feeBps !== undefined ? ` at ${feeBps} bps` : ''}`,
  };
}

/**
 * The approve, then the swap.
 *
 * The approve is for the exact input amount and only appears when the standing
 * allowance is short of it — the same rule `kit seed` uses. The swap call is the
 * quote's own `to`, `value` and calldata, `0x`-prefixed by `core`'s parser; nothing
 * here re-encodes it, because the route inside it is the aggregator's and this kit
 * does not claim to know its layout.
 */
export async function buildSwapCalls(
  config: KitConfig,
  tokenIn: TokenView,
  amountIn: bigint,
  quote: FlowQuote,
): Promise<PlannedCall[]> {
  const calls: PlannedCall[] = [];
  const allowance = (await config.client.readContract({
    address: tokenIn.address,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [config.from, quote.to],
  })) as bigint;

  if (allowance < amountIn) {
    calls.push(
      planCall({
        label: `approve ${tokenIn.symbol} to the Kuru Flow router (exact amount)`,
        to: tokenIn.address,
        abi: erc20Abi as never,
        functionName: 'approve',
        args: [quote.to, amountIn],
      }),
    );
  }

  calls.push({
    label: `Kuru Flow swap — ${tokenIn.symbol} in`,
    to: quote.to,
    data: quote.calldata,
    value: quote.value,
    // UNVERIFIED: the Kuru Flow router's function at selector 0xce1e7030. Its name,
    // argument list and embedded route encoding are undocumented and were not read
    // from verified source, so no ABI is attached and nothing here decodes the bytes.
    // `assertQuoteValuesAppear` below is the check that is actually possible: the four
    // values the API reported must be present in the calldata it returned.
    abi: [],
    functionName: '(not identified — selector 0xce1e7030)',
  });
  return calls;
}

/**
 * The only claim this kit can honestly make about an undecodable call: the numbers the
 * quote reported are the numbers in the bytes.
 *
 * Each of `tokenIn`, `tokenOut`, `amount` and `minOut` is searched for as a 32-byte
 * left-padded word in the calldata. That does not prove the route is what the API says
 * it is — nothing available here could — but it does catch a quote whose JSON and
 * whose calldata disagree, which is the failure that would silently swap the wrong
 * amount or send the output somewhere else.
 */
export function assertQuoteValuesAppear(
  quote: FlowQuote,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
): string[] {
  const body = quote.calldata.slice(2).toLowerCase();
  const word = (value: bigint | Address): string =>
    typeof value === 'bigint'
      ? value.toString(16).padStart(64, '0')
      : value.slice(2).toLowerCase().padStart(64, '0');

  const checks: [string, string][] = [
    ['tokenIn', word(tokenIn)],
    ['tokenOut', word(tokenOut)],
    ['amount', word(amountIn)],
    ['minOut', word(quote.minOut)],
  ];
  const missing = checks.filter(([, w]) => !body.includes(w)).map(([name]) => name);
  if (missing.length > 0) {
    throw new ArgError(
      `the Kuru Flow quote's calldata does not contain ${missing.join(', ')} from its own ` +
        'JSON. Refusing to build a transaction from a quote that disagrees with itself.',
    );
  }
  return checks.map(([name]) => name);
}

function header(
  config: KitConfig,
  tokenIn: TokenView,
  tokenOut: TokenView,
  amountIn: bigint,
): string {
  return [
    `chain             ${config.mode} (${config.client.chain?.id})`,
    `mode              MODE=${config.gate.runMode}  CHAIN=${config.gate.mode}  ` +
      `funds acknowledged=${config.gate.realFundsAcknowledged}`,
    `operator          ${config.from}`,
    `token in          ${tokenIn.symbol}  ${tokenIn.address}  ${tokenIn.decimals} dp`,
    `token out         ${tokenOut.symbol}  ${tokenOut.address}  ${tokenOut.decimals} dp`,
    `amount in         ${formatUnits(amountIn, tokenIn.decimals)} ${tokenIn.symbol}  ` +
      `[${amountIn} base units]`,
  ].join('\n');
}

export function renderSwap(
  config: KitConfig,
  tokenIn: TokenView,
  tokenOut: TokenView,
  amountIn: bigint,
  quote: FlowQuote,
  referrer: ReferrerConfig,
  calls: readonly PlannedCall[],
  confirmed: readonly string[],
): string {
  // Price to 12 decimal places, in integers: out * 1e12 / in, both already scaled to
  // their own decimals. Display only (rule A2.6).
  const scale = 10n ** 12n;
  const priceScaled =
    (quote.output * 10n ** BigInt(tokenIn.decimals) * scale) /
    (amountIn * 10n ** BigInt(tokenOut.decimals));
  const slippageTenthBps = ((quote.output - quote.minOut) * 100_000n) / quote.output;

  return [
    heading(
      `kit swap — ${formatUnits(amountIn, tokenIn.decimals)} ${tokenIn.symbol} -> ${tokenOut.symbol}`,
    ),
    header(config, tokenIn, tokenOut, amountIn),
    '',
    'QUOTE  (Kuru Flow, https://ws.kuru.io/api/quote, taken once — the JWT allows 1 rps)',
    `  output          ${formatUnits(quote.output, tokenOut.decimals)} ${tokenOut.symbol}  ` +
      `[${quote.output} base units]`,
    `  minOut          ${formatUnits(quote.minOut, tokenOut.decimals)} ${tokenOut.symbol}  ` +
      `[${quote.minOut} base units]`,
    `  price           ${formatUnits(priceScaled, 12)} ${tokenOut.symbol} per ${tokenIn.symbol}`,
    `  slippage room   ${slippageTenthBps / 10n}.${slippageTenthBps % 10n} bps between output and minOut`,
    `  routing fee     ${referrer.note}`,
    `  router          ${quote.to}`,
    `  relayable       no — that router answers neither isTrustedForwarder() nor`,
    `                  TRUSTED_FORWARDER(), so this swap cannot go through the sponsored`,
    `                  path (DECISIONS.md open item 9). The operator signs and pays gas.`,
    '',
    "  The route inside the calldata is the aggregator's own encoding. This kit does not",
    '  decode it and does not claim to. What it does check is that the calldata is whole',
    '  hex with the 0x the API omits, and that these four values from the quote JSON',
    `  really appear in those bytes: ${confirmed.join(', ')}.`,
    heading(`WOULD SEND — ${calls.length} transaction(s), in this order`),
    calls.map((call, i) => renderPlannedCall(call, i + 1)).join('\n\n'),
  ].join('\n');
}
