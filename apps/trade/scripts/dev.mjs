#!/usr/bin/env node
/**
 * The dev server launcher.
 *
 * WebAuthn refuses an IP origin. `http://127.0.0.1:3117` is a secure context, so the
 * page loads and the buttons work, but `navigator.credentials.create()` throws a
 * `SecurityError` because an IPv4 literal is not a registrable domain and therefore
 * cannot be an `rp.id`. The symptom is a passkey ceremony that fails for a reason the
 * screen cannot explain, which is exactly what happened on 127.0.0.1:3117.
 *
 * So this refuses to start on an IP origin rather than letting someone rediscover it,
 * and it prints the URL that actually works. `localhost` is the only loopback name
 * WebAuthn treats as a registrable domain, so `localhost` is what it prints.
 *
 * ## It also builds `@tradepro/core` first, and then watches it
 *
 * `packages/core`'s `exports` map points at `dist`, not `src`, so the browser only
 * ever sees what `tsc` last emitted. Nothing rebuilt it automatically, which meant a
 * function added to `packages/core/src` existed in the editor, typechecked, passed its
 * tests, and was **missing at runtime** — on 2026-09-09 the trade screen crashed with
 * `minSizeBase is not a function` from `dist/kuru/orders.js` for exactly this reason,
 * a full day after `minSizeBase` was written and shipped.
 *
 * A build before the server starts fixes the stale-on-boot case; the watch alongside
 * it fixes the edit-during-a-session case. Together they mean `dist` is never the
 * thing that is out of date.
 */
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** True for anything WebAuthn will not accept as a relying-party id. */
export function isIpOrigin(host) {
  const bare = host.trim().replace(/^\[|\]$/g, '');
  if (bare === '') return false;
  if (IPV4.test(bare)) return true;
  // An IPv6 literal is the only other host form with a colon in it.
  return bare.includes(':');
}

function readFlag(argv, long, short) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === long || arg === short) return argv[i + 1];
    if (arg?.startsWith(`${long}=`)) return arg.slice(long.length + 1);
  }
  return undefined;
}

function refuse(host) {
  process.stderr.write(
    `\n  MoneyMarkets dev server refused to start on ${host}.\n\n` +
      '  WebAuthn rejects an IP origin: an address literal cannot be a relying-party\n' +
      '  id, so every passkey ceremony on it fails with a SecurityError and no copy\n' +
      '  on the screen can make that better.\n\n' +
      '  Use localhost instead:  pnpm --filter @tradepro/trade dev\n' +
      '  For a phone, use the tunnel hostname and set NEXT_PUBLIC_RP_ID to match.\n\n',
  );
  process.exit(1);
}

/** Everything except the host and port, which are re-supplied in a canonical form. */
function withoutHostAndPort(args) {
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--hostname' || arg === '-H' || arg === '--port' || arg === '-p') {
      i += 1;
      continue;
    }
    if (arg?.startsWith('--hostname=') || arg?.startsWith('--port=')) continue;
    rest.push(arg);
  }
  return rest;
}

/**
 * The banner must not disagree with the server it is about. `next.config.mjs` copies
 * an allowlist of keys from the monorepo-root `.env` into the Next process; this
 * reads the same two for display only, so the line says what the app will run as
 * rather than what this shell happened to inherit.
 */
function announcedMode() {
  const fromEnv = { CHAIN: process.env.CHAIN, MODE: process.env.MODE };
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const contents = readFileSync(resolve(here, '../../../.env'), 'utf8');
    for (const line of contents.split(/\r?\n/)) {
      const match = /^\s*(CHAIN|MODE)\s*=\s*(.*?)\s*$/.exec(line);
      if (match && fromEnv[match[1]] === undefined) {
        fromEnv[match[1]] = match[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    // No root .env. The deployment supplies its own environment.
  }
  return { chain: fromEnv.CHAIN ?? 'testnet', mode: fromEnv.MODE ?? 'dryrun' };
}

/** Where `packages/core` lives, from here. */
function coreDir() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../packages/core');
}

function tscFor(cwd) {
  return resolve(
    cwd,
    '..',
    '..',
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tsc.cmd' : 'tsc',
  );
}

/**
 * Emit `packages/core/dist` before Next reads it, and fail loudly if it cannot.
 *
 * Synchronous on purpose: starting the dev server against a `dist` that did not
 * compile is the situation this exists to prevent, and doing it in the background
 * would race the first request.
 */
function buildCore() {
  const cwd = coreDir();
  process.stdout.write('  building @tradepro/core ...');
  const result = spawnSync(tscFor(cwd), ['-p', 'tsconfig.json'], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    process.stdout.write(' failed\n\n');
    process.stderr.write(String(result.stdout ?? '') + String(result.stderr ?? ''));
    process.stderr.write(
      '\n  @tradepro/core did not compile, so the app would run against a stale dist.\n' +
        '  Fix the errors above and start again.\n\n',
    );
    process.exit(1);
  }
  process.stdout.write(' ok\n');
}

/** Keep emitting while the session runs. Its output is quiet unless something breaks. */
function watchCore() {
  const cwd = coreDir();
  const child = spawn(tscFor(cwd), ['-p', 'tsconfig.json', '--watch', '--preserveWatchOutput'], {
    cwd,
    stdio: ['ignore', 'pipe', 'inherit'],
    shell: process.platform === 'win32',
  });
  child.stdout?.on('data', (chunk) => {
    const text = String(chunk);
    // Only the lines that matter. The watcher is chatty about starting compilations
    // and about finding zero errors, and neither is worth interleaving with Next's.
    if (/error/i.test(text)) process.stderr.write(`  @tradepro/core  ${text.trim()}\n`);
  });
  return child;
}

function main() {
  const argv = process.argv.slice(2);
  const host = readFlag(argv, '--hostname', '-H') ?? process.env.HOSTNAME ?? 'localhost';
  const port = readFlag(argv, '--port', '-p') ?? process.env.PORT ?? '3000';

  if (isIpOrigin(host)) refuse(host);

  const rpId = process.env.NEXT_PUBLIC_RP_ID;
  if (rpId && isIpOrigin(rpId)) refuse(`NEXT_PUBLIC_RP_ID=${rpId}`);

  // Before anything is printed about a server that is about to start.
  buildCore();

  const announced = announcedMode();
  const basePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/$/, '');
  const lines = [
    '',
    `  MoneyMarkets  ->  http://localhost:${port}${basePath}`,
    rpId
      ? `  passkeys resolve against the pinned rpId "${rpId}"`
      : "  passkeys resolve against the page's own host (NEXT_PUBLIC_RP_ID is not set)",
    `  MODE=${announced.mode}  CHAIN=${announced.chain}`,
    '',
    '',
  ];
  process.stdout.write(lines.join('\n'));

  const here = dirname(fileURLToPath(import.meta.url));
  const next = resolve(
    here,
    '..',
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'next.cmd' : 'next',
  );

  const watcher = watchCore();
  const child = spawn(
    next,
    ['dev', '--hostname', host, '--port', String(port), ...withoutHostAndPort(argv)],
    { stdio: 'inherit', shell: process.platform === 'win32' },
  );
  child.on('exit', (code) => {
    watcher.kill();
    process.exit(code ?? 0);
  });
}

// Importing this file for its guard must not start a server.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
