import { readFileSync } from 'node:fs';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

/**
 * Load the repo-root `.env` before anything reads `process.env`.
 *
 * The dependency was declared from the start but never imported, so the service read
 * a bare environment and silently defaulted to `CHAIN=testnet` with no Pimlico key —
 * which is how it came up on chain 10143 with an empty allowlist when everything else
 * in the repo was pointed at mainnet. A service that quietly runs against the wrong
 * chain is worse than one that refuses to start.
 *
 * Values already set in the real environment win, so a deployment that injects
 * configuration directly is unaffected.
 */
loadDotenv({ path: new URL('../../../.env', import.meta.url), quiet: true });
import { MAX_RELAYER_FLOAT_WEI, readModeGate, tighten, type ChainMode } from '@tradepro/core';

/**
 * Relayer configuration.
 *
 * Every value is validated at boot. A relayer that starts with a missing rate limit
 * or an unparsed float cap is worse than one that refuses to start.
 */

const positiveInt = z.coerce.number().int().positive();

/** Exported so tests can assert the env traps directly. */
export const relayerEnvSchema = z.object({
  CHAIN: z.enum(['mainnet', 'testnet']).default('testnet'),
  I_UNDERSTAND_THIS_USES_REAL_FUNDS: z.string().default('false'),
  RPC_URL_MONAD: z.string().url().optional(),
  RELAYER_PORT: positiveInt.default(8787),
  // `.finite()` matters: zod's number check rejects NaN but not Infinity, and an
  // infinite cap survives Math.round only to make BigInt() throw a RangeError deep
  // inside a health check. The code cap in caps.ts is 20 MON and this may only
  // tighten it, so the default is 20 rather than a larger number the env cannot
  // actually reach.
  // Validated at boot like everything else. Read straight from process.env it
  // escaped this schema's own contract, and a one-character token was accepted.
  // dotenv turns a bare `KEY=` into '', and `.min(16)` rejects that — so copying
  // .env.example verbatim, which tells you to leave this blank, made the relayer
  // refuse to start. Empty means unset.
  RELAYER_METRICS_TOKEN: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().min(16).optional(),
  ),
  RELAYER_MAX_FLOAT_MON: z.coerce.number().positive().finite().default(20),
  // Tightens PREFUND_MAX_MON (caps.ts) and every budget derived from it. It cannot raise
  // them: `prefundBudgets` passes it through `tighten()`. Unset or blank means the code cap.
  // The floor of one micro-MON keeps a value that would round to zero wei, which
  // `tighten()` ignores, from silently meaning "no limit tighter than the code".
  RELAYER_PREFUND_MAX_MON: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().min(0.000001).finite().optional(),
  ),
  RELAYER_FLOAT_ALERT_PCT: z.coerce.number().min(1).max(100).default(20),
  RELAYER_RATE_LIMIT_PER_ADDR_HOUR: positiveInt.default(60),
  RELAYER_RATE_LIMIT_PER_IP_HOUR: positiveInt.default(300),
  RELAYER_MAX_GAS: z.coerce.bigint().default(2_000_000n),
  RELAYER_DEADLINE_MAX_SECONDS: positiveInt.default(300),
  RELAYER_DB_PATH: z.string().default('./data/relayer.sqlite'),
  /**
   * Read but never logged, never returned by any endpoint, and never used to sign
   * anything a user did not sign first.
   */
  // Same empty-string trap as the metrics token: .env.example ships this blank, and
  // dotenv turns `KEY=` into '', which the regex rejects — so a verbatim copy of the
  // example refused to boot.
  RELAYER_PRIVATE_KEY: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/, 'RELAYER_PRIVATE_KEY must be 0x + 64 hex characters')
      .optional(),
  ),
  /**
   * Server-side only. Under the EIP-7702 gas layer this is what the relayer holds
   * instead of a MON float: the paymaster pays gas, and this key is the authority to
   * ask it to. It must never reach a browser.
   */
  PIMLICO_API_KEY: z.string().min(8).optional(),
  /**
   * Where a charged action's gas fee is paid (free actions, then gas at cost; D168).
   * Required: the relayer refuses to start without it (D169). It may be the relayer's own
   * signing address for testing, which is warned about at boot and reported by
   * `/v1/health`. Blank means unset, the same trap as the keys above.
   */
  RELAYER_FEE_ADDRESS: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/, 'RELAYER_FEE_ADDRESS must be 0x + 40 hex characters')
      .optional(),
  ),
  /**
   * The Swap feature's Kuru Flow referrer (read by the trade app). The relayer reads it only
   * to warn at boot when it is an address the relayer controls, which D168 would refuse in
   * every swap. Another feature's setting, so a malformed value is ignored, never fatal.
   */
  KURU_FLOW_REFERRER: z.preprocess(
    (v) => (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) ? v : undefined),
    z.string().optional(),
  ),
});

export interface RelayerConfig {
  readonly mode: ChainMode;
  readonly realFundsAcknowledged: boolean;
  readonly rpcUrl: string | undefined;
  readonly port: number;
  readonly metricsToken: string | undefined;
  readonly maxFloatMon: number;
  /** Optional tightening of PREFUND_MAX_MON. Undefined means the code cap. */
  readonly prefundMaxMon?: number | undefined;
  readonly floatAlertPct: number;
  readonly rateLimitPerAddressHour: number;
  readonly rateLimitPerIpHour: number;
  readonly maxGas: bigint;
  readonly maxDeadlineSeconds: number;
  readonly dbPath: string;
  readonly hasSigningKey: boolean;
  readonly hasPimlicoKey: boolean;
  /** `RELAYER_FEE_ADDRESS`. Required at boot (`resolveFeeRecipient`, D169). */
  readonly feeAddress?: `0x${string}` | undefined;
  /** `KURU_FLOW_REFERRER`, for the boot warning only. */
  readonly flowReferrer?: string | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayerConfig {
  const parsed = relayerEnvSchema.parse(env);
  const gate = readModeGate(env);
  return {
    mode: gate.mode,
    realFundsAcknowledged: gate.realFundsAcknowledged,
    rpcUrl: parsed.RPC_URL_MONAD,
    port: parsed.RELAYER_PORT,
    metricsToken: parsed.RELAYER_METRICS_TOKEN,
    maxFloatMon: parsed.RELAYER_MAX_FLOAT_MON,
    prefundMaxMon: parsed.RELAYER_PREFUND_MAX_MON,
    floatAlertPct: parsed.RELAYER_FLOAT_ALERT_PCT,
    rateLimitPerAddressHour: parsed.RELAYER_RATE_LIMIT_PER_ADDR_HOUR,
    rateLimitPerIpHour: parsed.RELAYER_RATE_LIMIT_PER_IP_HOUR,
    maxGas: parsed.RELAYER_MAX_GAS,
    maxDeadlineSeconds: parsed.RELAYER_DEADLINE_MAX_SECONDS,
    dbPath: parsed.RELAYER_DB_PATH,
    hasSigningKey: parsed.RELAYER_PRIVATE_KEY !== undefined,
    hasPimlicoKey: parsed.PIMLICO_API_KEY !== undefined,
    feeAddress: parsed.RELAYER_FEE_ADDRESS as `0x${string}` | undefined,
    flowReferrer: parsed.KURU_FLOW_REFERRER,
  };
}

/**
 * The float alert line, in wei (rule A4: alert when the float is under 20%).
 *
 * `RELAYER_FLOAT_ALERT_PCT` of the EFFECTIVE float cap: the code cap in caps.ts, which
 * `RELAYER_MAX_FLOAT_MON` may only tighten. The one definition of the line: `/v1/health`
 * and `/v1/metrics` report `balance < line`, and self-bundling will not send a bundle whose
 * worst case could take the balance to or below it.
 *
 * Rounded up, so for a whole-wei balance `balance < line` is exactly the
 * `balance * 100 < cap * pct` comparison `/v1/health` has always made. Integer wei
 * throughout. Throws, as that comparison did, for a percentage that is not a whole number.
 */
export function floatAlertThresholdWei(
  config: Pick<RelayerConfig, 'maxFloatMon' | 'floatAlertPct'>,
): bigint {
  const envFloatWei = BigInt(Math.round(config.maxFloatMon * 1e6)) * 10n ** 12n;
  const capWei = tighten(MAX_RELAYER_FLOAT_WEI, envFloatWei);
  return (capWei * BigInt(config.floatAlertPct) + 99n) / 100n;
}

/**
 * The Pimlico key, handed out only to the sponsorship path and never stored on the
 * config object — so nothing that serializes the config can leak it.
 */
export function readPimlicoKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.PIMLICO_API_KEY;
}

/**
 * The signing key, handed out only to the submitter and never stored on the config
 * object — so nothing that serializes the config can leak it.
 */
/**
 * The relayer's address, however its key is supplied.
 *
 * The float cap is a property of the account, not of how the key reaches us, so this
 * falls back to the keystore's plaintext `address` field when no env key is set.
 * Without this, a deployment that keeps its key in `.secrets/` would skip the cap
 * check entirely — which is exactly what happened on 2026-09-02, when the relayer was
 * funded with 5 MON against a 2 MON cap and nothing objected.
 */
export function readRelayerAddress(
  env: NodeJS.ProcessEnv = process.env,
): `0x${string}` | undefined {
  const fromEnv = env.RELAYER_ADDRESS;
  if (fromEnv && /^0x[0-9a-fA-F]{40}$/.test(fromEnv)) return fromEnv as `0x${string}`;

  const key = readSigningKey(env);
  if (key) {
    // Derived lazily by the caller; returning undefined here would hide the account.
    return undefined;
  }

  try {
    // Same override as `keystore.ts`'s `loadRelayerAccount` — this hardcoded relative
    // path is only correct in the repo layout, and a bundled deploy has no such
    // structure. Missing this the first time round is exactly the failure this
    // function exists to prevent: it silently fell through to `return undefined`
    // rather than throwing, so the float-cap check it backs was quietly disabled
    // rather than loud about being unable to run.
    const path = process.env.RELAYER_KEYSTORE_PATH
      ? process.env.RELAYER_KEYSTORE_PATH
      : new URL('../../../.secrets/relayer-keystore.json', import.meta.url);
    const store = JSON.parse(readFileSync(path, 'utf8')) as { address?: string };
    if (store.address) return `0x${store.address.replace(/^0x/, '')}` as `0x${string}`;
  } catch {
    /* no keystore: nothing to check against */
  }
  return undefined;
}

export function readSigningKey(env: NodeJS.ProcessEnv = process.env): `0x${string}` | undefined {
  const key = env.RELAYER_PRIVATE_KEY;
  if (!key) return undefined;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error('RELAYER_PRIVATE_KEY must be 0x + 64 hex characters');
  }
  return key as `0x${string}`;
}
