#!/usr/bin/env node
import { config as loadDotenv } from 'dotenv';
import { startKitServer } from './server.js';

/**
 * `pnpm --filter @tradepro/market-kit web` — the operator UI, on loopback.
 *
 * Same environment resolution as the CLI: the package's own `.env` if it has one, then
 * the repo root's, neither overriding what is already in the environment. A UI that
 * silently fell back to the testnet defaults would render an empty book and call it a
 * finding.
 */
loadDotenv({ path: new URL('../../.env', import.meta.url) });
loadDotenv({ path: new URL('../../../../.env', import.meta.url) });

const port = Number(process.env.MARKET_KIT_PORT ?? 8788);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`MARKET_KIT_PORT=${process.env.MARKET_KIT_PORT} is not a port number`);
}
startKitServer(port);
