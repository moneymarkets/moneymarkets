import { getAddress, isAddress, type Address, type PublicClient } from 'viem';
import {
  addressesFor,
  chainFor,
  createChainClient,
  isDryRun,
  readModeGate,
  type ChainMode,
  type ModeGate,
} from '@tradepro/core';

/**
 * Environment wiring for the kit.
 *
 * The kit is operator tooling, so unlike `apps/trade` it is allowed to hold a
 * deployer key — but only as an environment variable, never in a file it writes, and
 * it is never printed (rule A2.2). Everything below reads the key's *address*; the
 * key itself is touched only in `send.ts`, and only on the live path.
 */

export interface KitConfig {
  readonly mode: ChainMode;
  readonly gate: ModeGate;
  readonly dryRun: boolean;
  readonly rpcUrl: string;
  readonly client: PublicClient;
  readonly addresses: ReturnType<typeof addressesFor>;
  /** The operator address the calls are built for. */
  readonly from: Address;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface ConfigInput {
  readonly mode?: ChainMode | undefined;
  readonly from?: string | undefined;
  readonly rpcUrl?: string | undefined;
  readonly env?: NodeJS.ProcessEnv;
}

export function rpcUrlFor(mode: ChainMode, env: NodeJS.ProcessEnv): string {
  const explicit = mode === 'mainnet' ? env.RPC_URL_MONAD_MAINNET : env.RPC_URL_MONAD;
  if (explicit && explicit.length > 0) return explicit;
  const fallback = chainFor(mode).rpcUrls.default.http[0];
  if (!fallback) throw new ConfigError(`no RPC url configured for ${mode}`);
  return fallback;
}

/**
 * Resolve the operator address without ever reading the key material into a value
 * this module returns. `--from` wins; then `DEPLOYER_ADDRESS`; then nothing, and the
 * caller decides whether its command can proceed without one.
 */
export function resolveFrom(input: string | undefined, env: NodeJS.ProcessEnv): Address {
  const candidate = input ?? env.DEPLOYER_ADDRESS;
  if (!candidate) {
    throw new ConfigError(
      'no operator address. Pass --from 0x… or set DEPLOYER_ADDRESS. The kit will not ' +
        'guess who is depositing.',
    );
  }
  if (!isAddress(candidate)) throw new ConfigError(`--from ${candidate} is not an address`);
  return getAddress(candidate);
}

export function loadConfig(input: ConfigInput): KitConfig {
  const env = input.env ?? process.env;
  const gate = readModeGate(env);
  const mode = input.mode ?? gate.mode;
  const dryRun = isDryRun(gate) || mode !== gate.mode;
  const rpcUrl = input.rpcUrl ?? rpcUrlFor(mode, env);

  // `readOnly` is what keeps a mainnet *read* from tripping the A2.4 gate. A write
  // never goes through this client; it goes through `send.ts`, which asserts.
  const client = createChainClient({ mode, rpcUrl, readOnly: true, gate });

  return {
    mode,
    gate,
    dryRun,
    rpcUrl,
    client,
    addresses: addressesFor(mode),
    from: resolveFrom(input.from, env),
  };
}

/** The Kuru Router for this mode, or a sentence explaining why there isn't one. */
export function routerAddress(config: KitConfig): Address {
  const router = config.addresses.kuru.router;
  if (!router) {
    throw new ConfigError(
      `no Kuru Router address is known for ${config.mode}. Kuru's public testnet runs an ` +
        'older, incompatible build (DECISIONS.md open item 7), so nothing is hardcoded ' +
        'for it. Run against CHAIN=mainnet to read, or supply the address once a current ' +
        'testnet deployment exists.',
    );
  }
  return router;
}

export function marginAccountAddress(config: KitConfig): Address {
  const marginAccount = config.addresses.kuru.marginAccount;
  if (!marginAccount) {
    throw new ConfigError(
      `no MarginAccount address is known for ${config.mode} (DECISIONS.md open item 7).`,
    );
  }
  return marginAccount;
}
