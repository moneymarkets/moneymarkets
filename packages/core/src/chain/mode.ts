import { z } from 'zod';
import type { ChainMode } from './chains.js';

/**
 * Rule A2.4 — real money is gated — as amended by the owner on 2026-09-02.
 *
 * There are now two independent switches, and both must be thrown before anything
 * can be submitted:
 *
 *   CHAIN   which network. `mainnet` is where the gate runs; `testnet` remains
 *           available but Kuru has no usable deployment there (open item 7).
 *   MODE    what the code is allowed to do. **`dryrun` is the default everywhere.**
 *           A dry run builds, validates and simulates, and stops before submitting.
 *           `live` is required to submit, and only ever alongside
 *           `I_UNDERSTAND_THIS_USES_REAL_FUNDS=true`.
 *
 * Splitting "which chain" from "may I spend" means pointing at mainnet to *read* —
 * which the gate script and the relayer's allowlist both do constantly — never
 * implies permission to write. Nothing in this repo sets `MODE=live` or the funds
 * flag; the owner does.
 */

const boolish = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .pipe(z.enum(['true', 'false']))
  .transform((v) => v === 'true');

export const chainModeSchema = z.enum(['mainnet', 'testnet']).default('testnet');
export const runModeSchema = z.enum(['dryrun', 'live']).default('dryrun');

export type RunMode = z.infer<typeof runModeSchema>;

export interface ModeGate {
  readonly mode: ChainMode;
  readonly runMode: RunMode;
  readonly realFundsAcknowledged: boolean;
}

export function readModeGate(env: NodeJS.ProcessEnv = process.env): ModeGate {
  return {
    mode: chainModeSchema.parse(env.CHAIN ?? 'testnet'),
    runMode: runModeSchema.catch('dryrun').parse(env.MODE ?? 'dryrun'),
    realFundsAcknowledged: boolish
      .catch(false)
      .parse(env.I_UNDERSTAND_THIS_USES_REAL_FUNDS ?? 'false'),
  };
}

export class MainnetNotUnlockedError extends Error {
  constructor(what: string, gate: ModeGate) {
    const missing: string[] = [];
    if (gate.mode !== 'mainnet') missing.push('CHAIN=mainnet');
    if (gate.runMode !== 'live') missing.push('MODE=live');
    if (!gate.realFundsAcknowledged) missing.push('I_UNDERSTAND_THIS_USES_REAL_FUNDS=true');
    super(
      `${what} would spend real funds on Monad mainnet. Still missing: ` +
        `${missing.join(', ')}. This repo never sets them.`,
    );
    this.name = 'MainnetNotUnlockedError';
  }
}

/** Call before anything that can move real funds. Throws unless all three are set. */
export function assertMainnetAllowed(what: string, gate: ModeGate = readModeGate()): void {
  if (!mainnetAllowed(gate)) throw new MainnetNotUnlockedError(what, gate);
}

/** True only when all three switches are thrown. */
export function mainnetAllowed(gate: ModeGate = readModeGate()): boolean {
  return gate.mode === 'mainnet' && gate.runMode === 'live' && gate.realFundsAcknowledged;
}

/** A dry run may read anything and submit nothing. */
export function isDryRun(gate: ModeGate = readModeGate()): boolean {
  return gate.runMode !== 'live';
}
