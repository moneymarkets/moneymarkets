import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mainnetAllowed } from '@tradepro/core';
import type { FlagValue, ParsedArgs } from '../args.js';
import { loadConfig, marginAccountAddress, type KitConfig } from '../config.js';
import { buildSeedReport, resolveMarketView } from '../commands/seed.js';
import { buildDeployPlan, renderDeployPlan } from '../commands/deploy.js';
import { buildTeardownReport } from '../commands/teardown.js';
import { deployerAddress, deployerKeystoreExists } from '../keystore.js';
import { formatPrice, formatQuote, formatSize } from '../format.js';
import { readMarginBalance, readMarket, readVault } from '../market.js';
import { submitPlan } from '../send.js';
import type { PlannedCall } from '../plan.js';

/**
 * The market-kit operator UI, served from localhost.
 *
 * Design §5.7. Three things about its shape are deliberate:
 *
 *  1. **No key ever reaches the browser.** The page has no wallet connection and no
 *     signing code. `POST /api/sign` runs on this process, unlocks
 *     `.secrets/deployer-keystore.json`, and submits — and refuses unless the same
 *     three-switch gate the CLI uses is open. A page that cannot sign cannot be
 *     tricked into signing.
 *  2. **The page runs the CLI's own builders.** Every endpoint constructs the exact
 *     `ParsedArgs` the command line would produce and calls `buildSeedReport`,
 *     `buildDeployPlan` or `buildTeardownReport`. There is no second implementation of
 *     the ladder, the funding, or the flip/plain split to drift from the first, and
 *     each response carries the equivalent `kit …` command so a review can be repeated
 *     in a terminal.
 *  3. **It binds to 127.0.0.1.** This is operator tooling for one machine, not a
 *     service. It has no authentication because it must never be reachable by anything
 *     that would need to authenticate.
 */

const HOST = '127.0.0.1';

export function webRoot(): URL {
  return new URL('./', import.meta.url);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

/**
 * `packages/ui/src/tokens.css` is the design system's class contract, and it is served
 * from its own file rather than copied. A copy would drift from `apps/trade`, and the
 * two surfaces are supposed to look like one product.
 */
function tokensCssPath(): string {
  let dir = new URL('./', import.meta.url);
  for (let i = 0; i < 8; i += 1) {
    const candidate = new URL('packages/ui/src/tokens.css', dir);
    if (existsSync(candidate)) return fileURLToPath(candidate);
    dir = new URL('../', dir);
  }
  throw new Error('could not find packages/ui/src/tokens.css');
}

function assetPath(name: string): string | undefined {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '');
  const candidates = [new URL(safe, webRoot()), new URL(`../../web/${safe}`, webRoot())];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return fileURLToPath(candidate);
  }
  return undefined;
}

/* ────────────────────────────── request plumbing ──────────────────────────── */

function send(res: ServerResponse, status: number, body: string, type: string): void {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    // The page loads nothing it did not ship. No CDN, no remote font, no wallet.
    'content-security-policy':
      "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(body);
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  send(res, status, JSON.stringify(payload, bigintReplacer), 'application/json; charset=utf-8');
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

async function readBody(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // A form of flags cannot be large. A body that is is not a form.
    if (size > 64 * 1024) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('the request body must be a JSON object of flags');
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value === undefined || value === null || value === '') continue;
    out[key] = String(value);
  }
  return out;
}

/**
 * A form of flags becomes the same `ParsedArgs` the CLI builds.
 *
 * `--dry-run` is forced on every request. The sign endpoint is the only path that
 * submits anything, and it re-reads the gate itself; nothing that merely renders a
 * plan can send one.
 */
export function argsFromForm(command: string, form: Record<string, string>): ParsedArgs {
  const flags = new Map<string, FlagValue>();
  for (const [key, value] of Object.entries(form)) {
    if (!/^[a-z][a-z0-9-]*$/.test(key)) continue;
    flags.set(key, value === 'true' ? true : value);
  }
  flags.set('dry-run', true);
  return { command, flags, positional: [] };
}

/** The `kit …` line that reproduces a request in a terminal. */
export function commandLine(command: string, form: Record<string, string>): string {
  const parts = [`kit ${command}`];
  for (const [key, value] of Object.entries(form)) {
    if (!/^[a-z][a-z0-9-]*$/.test(key)) continue;
    parts.push(value === 'true' ? `--${key}` : `--${key} ${quote(value)}`);
  }
  parts.push('--dry-run');
  return parts.join(' ');
}

function quote(value: string): string {
  return /^[A-Za-z0-9._:/=-]+$/.test(value) ? value : JSON.stringify(value);
}

/* ─────────────────────────────────── state ────────────────────────────────── */

export interface KitWebState {
  readonly chain: string;
  readonly chainId: number | undefined;
  readonly runMode: string;
  readonly realFundsAcknowledged: boolean;
  readonly canSign: boolean;
  readonly signReason: string;
  readonly operator: string;
  readonly keystore: boolean;
  readonly rpcUrl: string;
  readonly block: string;
}

export async function readState(config: KitConfig): Promise<KitWebState> {
  const allowed = mainnetAllowed(config.gate);
  const keystore = deployerKeystoreExists();
  const reason = !allowed
    ? 'Signing is off. It needs MODE=live alongside CHAIN=mainnet and ' +
      'I_UNDERSTAND_THIS_USES_REAL_FUNDS=true, and nothing in this repo sets them.'
    : !keystore
      ? 'Signing is off. There is no deployer keystore — run pnpm generate-deployer.'
      : 'Signing is armed. The deployer keystore will be unlocked on this machine.';
  return {
    chain: config.gate.mode,
    chainId: config.client.chain?.id,
    runMode: config.gate.runMode,
    realFundsAcknowledged: config.gate.realFundsAcknowledged,
    canSign: allowed && keystore,
    signReason: reason,
    operator: config.from,
    keystore,
    rpcUrl: config.rpcUrl,
    block: (await config.client.getBlockNumber()).toString(),
  };
}

/* ─────────────────────────────────── views ────────────────────────────────── */

export function describeCalls(calls: readonly PlannedCall[]): unknown[] {
  return calls.map((call) => ({
    label: call.label,
    to: call.to,
    selector: call.data.slice(0, 10),
    value: call.value.toString(),
    bytes: (call.data.length - 2) / 2,
    data: call.data,
  }));
}

async function marketView(config: KitConfig, address: `0x${string}`): Promise<unknown> {
  const view = await readMarket(config.client, address);
  const marginAccount = marginAccountAddress(config);
  const [vault, baseHeld, quoteHeld] = await Promise.all([
    readVault(config.client, view.vault.vault, config.from),
    readMarginBalance(config.client, marginAccount, config.from, view.base.address),
    readMarginBalance(config.client, marginAccount, config.from, view.quote.address),
  ]);
  return {
    address: view.address,
    symbol: view.symbol,
    block: view.blockNumber.toString(),
    base: view.base,
    quote: view.quote,
    params: {
      pricePrecision: view.params.pricePrecision.toString(),
      sizePrecision: view.params.sizePrecision.toString(),
      tickSize: view.params.tickSize.toString(),
      tickHuman: formatPrice(view.params.tickSize, view.params),
      minSize: view.params.minSize.toString(),
      minSizeHuman: formatSize(view.params.minSize, view.params),
      maxSize: view.params.maxSize.toString(),
      maxSizeHuman: formatSize(view.params.maxSize, view.params),
      takerFeeBps: view.params.takerFeeBps.toString(),
      makerFeeBps: view.params.makerFeeBps.toString(),
    },
    book: {
      bidWire: view.bestBidWire.toString(),
      askWire: view.bestAskWire.toString(),
      twoSided: view.bestBidWire > 0n && view.bestAskWire > 0n,
    },
    vault: {
      address: vault.address,
      name: vault.name,
      totalSupply: vault.totalSupply.toString(),
      reserveBase: vault.reserve1.toString(),
      reserveQuote: vault.reserve2.toString(),
      spread: vault.spreadConstant.toString(),
      shares: vault.shares.toString(),
    },
    margin: {
      base: baseHeld.toString(),
      quote: quoteHeld.toString(),
      quoteHuman: formatQuote(quoteHeld, view.params),
    },
  };
}

/* ─────────────────────────────────── routes ───────────────────────────────── */

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${HOST}`);
  const path = url.pathname;

  if (path === '/' || path === '/index.html') {
    const file = assetPath('index.html');
    if (!file) return send(res, 500, 'index.html is missing from the build', 'text/plain');
    return send(res, 200, readFileSync(file, 'utf8'), MIME['.html']!);
  }
  if (path === '/tokens.css') {
    return send(res, 200, readFileSync(tokensCssPath(), 'utf8'), MIME['.css']!);
  }
  if (path === '/kit.css' || path === '/kit.js') {
    const file = assetPath(path.slice(1));
    if (!file) return send(res, 404, 'not found', 'text/plain');
    return send(res, 200, readFileSync(file, 'utf8'), MIME[extname(file)] ?? 'text/plain');
  }

  const config = loadConfig({ from: url.searchParams.get('from') ?? undefined });

  if (path === '/api/state') return json(res, 200, await readState(config));

  if (path === '/api/market') {
    const address = url.searchParams.get('address');
    if (!address) return json(res, 400, { error: 'address is required' });
    return json(res, 200, await marketView(config, address as `0x${string}`));
  }

  if (req.method !== 'POST') return json(res, 405, { error: 'use POST' });
  const form = await readBody(req);

  if (path === '/api/seed') {
    const args = argsFromForm('seed', form);
    const view = await resolveMarketView(config, args);
    const report = await buildSeedReport(config, view, args);
    return json(res, 200, {
      command: commandLine('seed', form),
      text: report.text,
      calls: describeCalls(report.calls),
      totals: {
        quote: report.ladder.totalQuote.toString(),
        base: report.ladder.totalBase.toString(),
        feePps: report.ladder.feePps.toString(),
        anchor: report.ladder.anchor.source,
        anchorNote: report.ladder.anchor.note,
      },
      levels: report.ladder.levels.map((level) => ({
        side: level.side,
        index: level.index,
        price: formatPrice(level.price, report.ladder.params),
        flip: formatPrice(level.flipPrice, report.ladder.params),
        size: formatSize(level.size, report.ladder.params),
        priceRaw: level.price.toString(),
        flipRaw: level.flipPrice.toString(),
        sizeRaw: level.size.toString(),
      })),
    });
  }

  if (path === '/api/deploy') {
    const args = argsFromForm('deploy', form);
    const plan = await buildDeployPlan(config, args);
    return json(res, 200, {
      command: commandLine('deploy', form),
      text: renderDeployPlan(config, plan),
      calls: describeCalls([plan.call]),
      predictedMarket: plan.predictedMarket,
      predictedVault: plan.predictedVault,
      alreadyDeployed: plan.alreadyDeployed,
      type: plan.type,
      typeName: plan.typeName,
    });
  }

  if (path === '/api/teardown') {
    const args = argsFromForm('teardown', form);
    const report = await buildTeardownReport(config, args);
    return json(res, 200, {
      command: commandLine('teardown', form),
      text: report.text,
      calls: describeCalls(report.calls),
      flips: report.flips.length,
      plains: report.plains.length,
      scanned: `${report.scannedFrom}..${report.scannedTo}`,
    });
  }

  if (path === '/api/sign') return sign(config, form, res);

  return json(res, 404, { error: `no route ${path}` });
}

/**
 * The one endpoint that can move money, and the one that refuses by default.
 *
 * It rebuilds the plan from the same flags rather than accepting calldata from the
 * page: a browser must not be able to hand this process arbitrary bytes to sign. Then
 * `submitPlan` applies the three-switch gate again — this check is not the gate, it is
 * an early and readable refusal in front of it.
 */
async function sign(
  config: KitConfig,
  form: Record<string, string>,
  res: ServerResponse,
): Promise<void> {
  const state = await readState(config);
  if (!state.canSign) return json(res, 403, { error: state.signReason });

  const command = form.command;
  if (command !== 'seed' && command !== 'deploy' && command !== 'teardown') {
    return json(res, 400, { error: 'command must be seed, deploy or teardown' });
  }
  const { command: _drop, ...flags } = form;
  // `argsFromForm` forces --dry-run on every request, which is what makes every other
  // endpoint unable to send. This is the one place that undoes it, and it is the one
  // place the three-switch gate is checked twice.
  const dryRunArgs = argsFromForm(command, flags);
  const live = new Map(dryRunArgs.flags);
  live.delete('dry-run');
  const args: ParsedArgs = { command, flags: live, positional: [] };

  let calls: readonly PlannedCall[];
  if (command === 'seed') {
    const view = await resolveMarketView(config, args);
    calls = (await buildSeedReport(config, view, args)).calls;
  } else if (command === 'deploy') {
    calls = [(await buildDeployPlan(config, args)).call];
  } else {
    calls = (await buildTeardownReport(config, args)).calls;
  }

  const hashes = await submitPlan(config, calls);
  return json(res, 200, { hashes });
}

export function createKitServer() {
  return createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (res.headersSent) return res.end();
      json(res, 400, { error: message });
    });
  });
}

export function startKitServer(port: number): void {
  const server = createKitServer();
  server.listen(port, HOST, () => {
    const operator = deployerAddress() ?? process.env.DEPLOYER_ADDRESS ?? 'not set';
    console.log(`market-kit UI  http://${HOST}:${port}`);
    console.log(`  operator     ${operator}`);
    console.log(
      `  mode         MODE=${process.env.MODE ?? 'dryrun'} CHAIN=${process.env.CHAIN ?? 'testnet'}`,
    );
    console.log('  Bound to loopback only. No key reaches the browser; signing runs here.');
  });
}
