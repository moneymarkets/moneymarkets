import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { timingSafeEqual } from 'node:crypto';
import {
  createWalletClient,
  decodeFunctionData,
  encodeFunctionData,
  formatEther,
  getAddress,
  http,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import {
  addressesFor,
  assertFloatWithinCap,
  assertMarketAllowed,
  CapExceededError,
  configureLiveMarkets,
  createChainClient,
  FORWARD_REQUEST_SCHEMA_VERIFIED,
  KURU_FORWARDER_ADDRESS,
  assertSponsorable,
  decideTopUp,
  effectiveExemptAllAddressesHourCap,
  effectiveExemptPerAddressDayCap,
  effectiveExemptPerAddressHourCap,
  effectiveFeePaidPerAddressHourCap,
  ENTRY_POINT_V08,
  FALLBACK_RPC_URL_MAINNET,
  nonExemptAllAddressesHour,
  ENTRYPOINT_TOPUP_WEI,
  MIN_ENTRYPOINT_DEPOSIT_WEI,
  namesPaymaster,
  nonceKeyOf,
  planUserOperationGas,
  prefundBudgets,
  prefundHeadroom,
  readEntryPointDeposit,
  requiredPrefund,
  rpcUserOperationSchema,
  verifyUserOperationSignature,
  GAS_LAYER_PROVEN,
  LIVE_MARKET_ALLOWLIST,
  MarketParamsCache,
  PolicyViolation,
  SIMPLE_7702_DELEGATE,
  delegationCodeFor,
  MAX_ORDER_NOTIONAL_AUSD,
  MAX_SPONSORED_PERMIT_VALUE,
  MAINNET,
  SPONSORED_TRANSFER_TOKENS,
  APPROVE_SELECTOR,
  TRANSFER_SELECTOR,
  WMON_DEPOSIT_SELECTOR,
  WMON_WITHDRAW_SELECTOR,
  isPinnedSwapRouter,
  readPinnedSwap,
  MAX_RELAYER_FLOAT_WEI,
  AUSD_USDC_MARKET,
  chainFor,
  pimlicoUrl,
  readForwarderNonce,
  readModeGate,
  selectorOf,
  orderBookAbi,
  type ChainMode,
  type GasPlan,
  type ModeGate,
  type SponsoredCall,
  MESSAGE_TRANSMITTER_V2,
  MESSAGE_TRANSMITTER_ABI,
  MONAD_CCTP_DOMAIN,
  buildFeeLeg,
  exemptionOf,
  GAS_ENVELOPE_REFUSED_MESSAGE,
  limitsOffPlan,
  operationWouldFailMessage,
  type GasChargeCause,
  FREE_ACTIONS_PER_DAY,
  gasRefusalMessage,
  GAS_REFUSAL_CHOICES,
  MONAD_DELEGATED_RESERVE_WEI,
  GAS_FEE_MARGIN,
  GAS_FEE_MINIMUM,
  GAS_FEE_QUOTE_EXPIRED_MESSAGE,
  GAS_FEE_STEP,
  GAS_FEE_TOKENS,
  GAS_FEE_UNPRICED_MESSAGE,
  gasFeeTokenFor,
  MAX_GAS_FEE,
  operationGasFee,
  nativeValueSpent,
  splitFeeLeg,
  SPONSORSHIP_ALLOWANCE_USED,
  type FreeActionHeadroom,
  type GasChargeRefusalData,
  type PolicyContext,
  type SplitBatch,
} from '@tradepro/core';
import {
  assertFeeRecipient,
  FeePricingBook,
  freeActionsBody,
  freeActionsOf,
  gasQuoteBodySchema,
  judgeFeeLeg,
  liveFeePaidWatch,
  readBaseFee,
  readFeePricing,
  readMarginDollars,
  withBatchDeposits,
} from './gasCharge.js';
import { assertNotionalWithinCap, readNotionalContext, type NotionalReader } from './notional.js';
import {
  floatAlertThresholdWei,
  loadConfig,
  readPimlicoKey,
  readRelayerAddress,
  readSigningKey,
  type RelayerConfig,
} from './config.js';
import { TargetAllowlist } from './allowlist.js';
import { entryPoint08Abi } from 'viem/account-abstraction';
import {
  cctpReceiveBodySchema,
  fetchAttestation,
  CCTP_MINTS_PER_USER_PER_DAY,
} from './cctp.js';
import { EXEMPT_PURPOSE, RELAY_STATUSES, RelayerDb } from './db.js';
import { loadRelayerAccount } from './keystore.js';
import {
  budgetsFor,
  depositNeeded,
  FEE_PAID_MAX_PREFUND_WEI,
  isPrefundFailure,
  liveTopUpExecutor,
  PrefundGate,
  PRIOR_TOPUP_NEVER_LANDED_MESSAGE,
  RECEIPT_POLL_MS,
  SerialLock,
  TOPUP_RECEIPT_TIMEOUT_MS,
  type Refusal,
  type TopUpExecutor,
} from './prefund.js';
import { simulateForwardedCall } from './simulate.js';
import {
  intrinsicGasOf,
  isSimple7702,
  isVerifiedFirstOperation,
  liveBundleExecutor,
  SELF_BUNDLE_MAX_FEE_OVER_BASE,
  SELF_BUNDLE_MIN_FEE_OVER_BASE,
  SELF_BUNDLE_MIN_PRIORITY_FEE_WEI,
  SelfBundler,
  simulateFundedRun,
  simulateInnerCall,
  type BundleExecutor,
  type SelfBundlePrefetch,
} from './selfBundle.js';
import {
  bundleBodySchema,
  forwardBodySchema,
  permitBodySchema,
  Rejection,
  sponsorBodySchema,
  toForwardRequest,
  validateForwardSignature,
  validateForwardStructure,
  validatePermit,
  type ValidationContext,
} from './validate.js';

/**
 * The relayer.
 *
 * It pays gas so a user never holds MON. It does exactly two things: submit
 * user-signed ERC-2771 requests to an allowlist of Kuru contracts, and submit
 * user-signed ERC-2612 permits whose spender is the MarginAccount. It never signs on
 * a user's behalf and never takes custody (rule A2.3).
 *
 * Today it validates and simulates every request fully but **refuses to submit**: the
 * KuruForwarder `execute` signature is open item 1, and submitting against a guessed
 * struct is exactly the failure rule A2.5 exists to prevent. `/v1/forward` therefore
 * answers 503 `FORWARDER_SCHEMA_UNVERIFIED` after passing every other check, so the
 * whole validation path is exercised and reviewable now.
 */

export interface BuildServerOptions {
  readonly config?: RelayerConfig;
  /**
   * The run-mode gate. Injected in tests so a server built for a test never reads the
   * developer's real `.env` — which is exactly what happened once MODE=live was set
   * for the M0 run and a health test started reporting `canSubmit: true`.
   */
  readonly gate?: ModeGate;
  readonly client?: PublicClient;
  /**
   * A client against a second public RPC, for the one-time self-bundle send retry
   * (D201) — defaults to a real one against `FALLBACK_RPC_URL_MAINNET` on mainnet,
   * `undefined` (no retry) on testnet. Injected in tests the same way `client` is.
   */
  readonly retryClient?: PublicClient;
  readonly allowlist?: TargetAllowlist;
  readonly db?: RelayerDb;
  readonly now?: () => number;
  /**
   * How EntryPoint top-ups are paid. Production builds the live one from the relayer's
   * keystore. Every test injects a fake, because on a machine holding
   * `.secrets/relayer-keystore.json` the live one signs with the real mainnet key.
   */
  readonly topUpExecutor?: TopUpExecutor;
  /**
   * The background refill after a free self-bundled action lands (R9). On unless a test
   * turns it off to pin an exact sequence of top-ups.
   */
  readonly backgroundRefill?: boolean;
  /**
   * Where `/v1/bundler` forwards an operation that passed every check. Production posts
   * to Pimlico with the key attached. Tests inject a recorder so a passing request is
   * observable and never leaves the process.
   */
  readonly bundlerUpstream?: (payload: string) => Promise<string>;
  /**
   * What signs a self-bundled `handleOps`. `null` turns self-bundling off. When absent,
   * production builds the live one, but only when it also built its own chain client: a
   * server handed an injected client is a test or a harness, and it gets no live signer
   * unless it asks for one by passing it here. On this machine the live one signs with
   * the real mainnet key.
   */
  readonly bundleExecutor?: BundleExecutor | null;
  /** Test hook: how long a self-bundle waits for its receipt, and how often it looks. */
  readonly selfBundleTiming?: {
    readonly receiptTimeoutMs: number;
    readonly receiptPollMs: number;
    readonly readTimeoutMs?: number;
  };
  /**
   * Test hook: the relayer key's one lock. A self-bundle answers on its hash and settles
   * inside this lock afterwards, so a test that reads the ledger after an answer first
   * waits for the lock to drain. Production always builds its own.
   */
  readonly relayerTxLock?: SerialLock;
  /**
   * Test override for where charged actions pay their gas fee. `null` means nowhere:
   * nothing is charged, and an account out of free actions is told when they renew.
   * When absent, the fee address is `RELAYER_FEE_ADDRESS` (`config.feeAddress`), and a
   * production server without one refuses to start (D169). A server handed an injected
   * client with no fee address configured is a test harness, and charges nothing.
   */
  readonly feeRecipient?: Address | null;
  /**
   * The relayer's own signing address, for `feeAddressIsHotKey` and the boot warning.
   * Production reads it the way the float gauge does (the env key, else the keystore's
   * plaintext address field). Injected in tests so no test reads this machine's keystore.
   */
  readonly relayerAddress?: () => Promise<Address | undefined>;
  /** Test hook: where the server's structured log lines go. Production logs to stdout. */
  readonly logStream?: { write(line: string): void };
}

/**
 * Where fees are paid, resolved once at boot (D169).
 *
 * `RELAYER_FEE_ADDRESS` must be set: unset, a production relayer refuses to start rather
 * than charge into an address nobody chose. It may be the relayer's own signing address,
 * the hot key, which is allowed for testing and reported by a boot warning and by
 * `/v1/health` `feeAddressIsHotKey` for as long as it stays so. A known contract is still
 * refused (`assertFeeRecipient`).
 */
export function resolveFeeRecipient(input: {
  readonly override?: Address | null;
  readonly feeAddress: string | undefined;
  readonly harness: boolean;
}): Address | undefined {
  if (input.override !== undefined) {
    return input.override === null ? undefined : assertFeeRecipient(input.override);
  }
  if (input.feeAddress) return assertFeeRecipient(input.feeAddress);
  if (input.harness) return undefined;
  throw new Error(
    'RELAYER_FEE_ADDRESS is not set. It names where charged actions pay their gas fee; ' +
      'the relayer will not start without it (DECISIONS.md D169).',
  );
}

/** The relayer's own address, read the way the float gauge reads it. */
async function ownSigningAddress(): Promise<Address | undefined> {
  const signer = readSigningKey();
  if (signer) {
    const { privateKeyToAccount } = await import('viem/accounts');
    return privateKeyToAccount(signer).address;
  }
  const address = readRelayerAddress();
  return address && /^0x[0-9a-fA-F]{40}$/.test(address) ? (address as Address) : undefined;
}

export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const mode: ChainMode = config.mode;
  const addresses = addressesFor(mode);

  // First, before anything else is built: no fee address, no relayer (D169).
  const feeRecipient = resolveFeeRecipient({
    ...(options.feeRecipient !== undefined ? { override: options.feeRecipient } : {}),
    feeAddress: config.feeAddress,
    harness: options.client !== undefined,
  });
  const relayerOwnAddress = options.relayerAddress ?? ownSigningAddress;
  /**
   * Is the fee address the relayer's own signing address? `'unknown'` when the relayer
   * cannot read its own address, never `false`: the D169 checklist item is "reads false",
   * and an address nobody could read must not pass it (independent review, 2026-09-24).
   * `false` only when there is no fee address at all, or the two genuinely differ.
   */
  const feeAddressIsHotKey = async (): Promise<boolean | 'unknown'> => {
    if (!feeRecipient) return false;
    const own = await relayerOwnAddress().catch(() => undefined);
    if (own === undefined) return 'unknown';
    return own.toLowerCase() === feeRecipient.toLowerCase();
  };
  /**
   * Every address the relayer controls, forbidden anywhere in a sponsored batch but the fee
   * leg (D168, extended): the signing address as read at boot, for as long as this process
   * signs with it, and the fee address. The hot key stays on this list after the fee
   * address moves off it.
   */
  const relayerSelf = await relayerOwnAddress().catch(() => undefined);
  const relayerAddresses: readonly Address[] = [relayerSelf, feeRecipient].filter(
    (a): a is Address => a !== undefined,
  );

  const client =
    options.client ??
    createChainClient({
      mode,
      readOnly: true,
      ...(config.rpcUrl ? { rpcUrl: config.rpcUrl } : {}),
    });
  // D201: a second public RPC the self-bundle send retries on once, only after
  // proving the primary took nothing. Real on mainnet, none on testnet (no fallback
  // verified there) — and, like `client` just above, only ever built for real when
  // no `options.client` was supplied: a harness that injects its own fake `client`
  // but leaves `mode: 'mainnet'` (most of this suite does) must not get a real
  // network client by default (security review, 2026-10-08 — the first version of
  // this gated on `mode` alone, which reached the real rpc2.monad.xyz from inside
  // test runs that never asked for it). Tests that are about the retry itself
  // inject their own fake `retryClient` the same way they do for `client`.
  const retryClient =
    options.retryClient ??
    (options.client === undefined && mode === 'mainnet'
      ? createChainClient({ mode, readOnly: true, rpcUrl: FALLBACK_RPC_URL_MAINNET })
      : undefined);

  const allowlist = options.allowlist ?? new TargetAllowlist(client, mode);
  const db = options.db ?? new RelayerDb(config.dbPath);
  const now = options.now ?? (() => Date.now());
  const marketParams = new MarketParamsCache(client);
  const gate = options.gate ?? readModeGate();

  // The sponsorship budgets: PREFUND_MAX_MON, tightened by the environment if at all.
  // Integer wei, the same conversion the float cap uses.
  const budgets = prefundBudgets(
    config.prefundMaxMon === undefined
      ? undefined
      : BigInt(Math.round(config.prefundMaxMon * 1e6)) * 10n ** 12n,
  );

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      // Rule A4: never log key, mnemonic or signature material, and never log a
      // /v1/forward body beyond its hashes.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.body.signature',
          'req.body.forward.signature',
          'req.body.request.data',
          'req.body.forward.request.data',
          'req.body.r',
          'req.body.s',
          'req.body.permit.r',
          'req.body.permit.s',
          '*.privateKey',
          '*.mnemonic',
        ],
        censor: '[redacted]',
      },
      ...(options.logStream ? { stream: options.logStream } : {}),
    },
    disableRequestLogging: true,
  });

  // D169: fees may land on the hot key for testing, and every boot says so.
  const hotKey = await feeAddressIsHotKey();
  if (hotKey === true) {
    app.log.warn(
      { feeAddressIsHotKey: true },
      'RELAYER_FEE_ADDRESS is the relayer’s own signing address: gas fees land on the hot key. ' +
        'Allowed for testing only; move it to an address whose key is not on this server ' +
        'before this goes fully live (DECISIONS.md D169).',
    );
  } else if (hotKey === 'unknown') {
    app.log.warn(
      { feeAddressIsHotKey: 'unknown' },
      'The relayer could not read its own signing address, so it cannot tell whether gas fees ' +
        'land on the hot key, and cannot keep that address out of sponsored batches (D168, D169).',
    );
  }
  // A Flow referrer that is a relayer address makes D168 refuse every swap that names it:
  // correct, but a mystery "all swaps refused" to whoever set it. Say so at boot.
  if (
    config.flowReferrer &&
    relayerAddresses.some((a) => a.toLowerCase() === config.flowReferrer!.toLowerCase())
  ) {
    app.log.warn(
      { flowReferrerIsRelayerAddress: true },
      'KURU_FLOW_REFERRER is an address the relayer controls; every sponsored swap naming it ' +
        'as referrer will be refused (DECISIONS.md D168). Set it to a different address.',
    );
  }

  await app.register(cors, { origin: true });

  /**
   * One lock for every transaction the relayer key sends: EntryPoint top-ups and CCTP
   * mints alike. Two sends from one key at once both read the same pending nonce, and
   * one of them fails. It failed closed before, but a failed mint or top-up is still a
   * failure the user sees.
   */
  const relayerTxLock = options.relayerTxLock ?? new SerialLock();

  const prefund = new PrefundGate({
    db,
    client,
    executor:
      options.topUpExecutor ??
      liveTopUpExecutor({ client, mode, rpcUrl: config.rpcUrl, fallbackRpcUrl: FALLBACK_RPC_URL_MAINNET }),
    budgets,
    now,
    log: app.log,
    lock: relayerTxLock,
    // The durable backstop's eyes on the chain (D172).
    feePaidWatch: liveFeePaidWatch(client),
  });

  /**
   * Self-bundling (speed pass, 2026-09-24): `handleOps` from the relayer's own key, under
   * the same one lock as top-ups and CCTP mints, so there is still exactly one nonce
   * manager for that key. It draws on its own allowance, not on `budgets`: the loss limit,
   * the in-flight cap, and the float alert line below, the same line `/v1/health` reports.
   * A line that cannot be computed from the config turns self-bundling off, not the floor.
   */
  let floatAlertWei: bigint | undefined;
  try {
    floatAlertWei = floatAlertThresholdWei(config);
  } catch {
    floatAlertWei = undefined;
  }
  const selfBundler = new SelfBundler({
    client,
    executor:
      options.bundleExecutor !== undefined
        ? options.bundleExecutor
        : options.client
          ? null
          : liveBundleExecutor({ mode, chainId: addresses.chainId }),
    db,
    floatAlertWei,
    now,
    log: app.log,
    lock: relayerTxLock,
    ...(retryClient ? { retryClient } : {}),
    // R9: after a free action this relayer sent has landed, put back what it burned, in
    // the background, so the next action does not wait on a top-up. Scheduled, never
    // awaited: this runs inside the lock, and the refill takes the lock itself.
    onLanded: ({ sender, actualGasCost, success }) => {
      if (options.backgroundRefill === false) return;
      setImmediate(() => {
        prefund.refill(sender, actualGasCost).catch((error: unknown) => {
          app.log.warn(
            { sender, success, err: error instanceof Error ? error.message.split('\n')[0] : String(error) },
            'entrypoint refill failed',
          );
        });
      });
    },
    ...(options.selfBundleTiming
      ? {
          receiptTimeoutMs: options.selfBundleTiming.receiptTimeoutMs,
          receiptPollMs: options.selfBundleTiming.receiptPollMs,
          ...(options.selfBundleTiming.readTimeoutMs !== undefined
            ? { readTimeoutMs: options.selfBundleTiming.readTimeoutMs }
            : {}),
        }
      : {}),
  });

  // Free actions, then gas at cost (owner's policy, 2026-09-24). `feeRecipient` was
  // resolved at the top of this function, from configuration and never from a request.
  const feePricings = new FeePricingBook();

  /**
   * The fee half of every policy context: what this batch must pay (absent when this relayer
   * charges nothing), and the relayer addresses no batch may name, always.
   */
  const gasFeeContext = (
    expected: NonNullable<PolicyContext['gasFee']>['expected'],
  ): Pick<PolicyContext, 'gasFee' | 'relayerAddresses'> => ({
    relayerAddresses,
    ...(feeRecipient ? { gasFee: { recipient: feeRecipient, expected } } : {}),
  });

  const forwarderAddress = addresses.kuru.forwarder as Address | undefined;
  const validationContext = (): ValidationContext => ({
    allowlist,
    maxGas: config.maxGas,
    maxDeadlineSeconds: config.maxDeadlineSeconds,
    now,
    ...(forwarderAddress
      ? { readNonce: (from: Address) => readForwarderNonce(client, forwarderAddress, from) }
      : {}),
  });

  /**
   * The caller's own address, not the proxy's.
   *
   * Every browser request arrives through the trade server's `/api/submit`, so without
   * this the per-IP bucket holds one address for the entire user base: real users
   * throttle each other, and an attacker gets the whole 300/hour budget to themselves.
   * A4 requires a per-IP limit and this is what makes it mean anything.
   *
   * Only the first hop is read, and only from a host we put there ourselves. Fastify's
   * `trustProxy` is deliberately not enabled globally — `/v1/metrics` reads
   * `req.socket.remoteAddress` precisely so that a header can never reach its loopback
   * gate, and that must stay true.
   */
  const clientIp = (req: { ip: string; headers?: Record<string, unknown> }): string => {
    const forwarded = req.headers?.['x-forwarded-for'];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.toString().split(',')[0]?.trim();
    return first && first.length > 0 && first.length < 64 ? first : req.ip;
  };

  /**
   * The owner's hard caps for the mainnet run, enforced here because this is the
   * last place a request passes through before it would cost money. The limits are
   * constants in `@tradepro/core`; the environment can tighten them and cannot raise
   * them. On mainnet the market allowlist is the live set `liveMarkets.ts` confirms
   * (widened from MON/AUSD alone on 2026-09-09, D127; emo/MON added 2026-09-23); every
   * one of them is still capped by notional, valued in dollars.
   */
  /**
   * Tokens whose `permit` may travel in a sponsored batch under 7702.
   *
   * USDC belongs here as well as AUSD because a Flow swap into AUSD spends USDC, so the
   * permit it needs is a USDC permit. Named once here rather than repeated inline, and
   * deliberately not shared with `/v1/forward`, which stays AUSD-only: the 2771 path has
   * no USDC flow, and widening it would be scope this change has no reason to take.
   */
  const sponsoredPermitTokens: readonly Address[] = [
    addresses.tokens.AUSD.address,
    addresses.tokens.USDC.address,
  ];

  /**
   * The two chain reads the cap may need, and nothing else: a book's `bestBidAsk()` and a
   * book's params (cached). `readNotionalContext` decides which, if any, a call needs.
   */
  const capPriceReader: NotionalReader = {
    bestBidAsk: async (book) =>
      (await client.readContract({
        address: book,
        abi: orderBookAbi,
        functionName: 'bestBidAsk',
      })) as readonly [bigint, bigint],
    params: (book) => marketParams.get(book),
  };

  async function enforceHardCaps(
    to: Address,
    data: Hex,
    extraMarkets: readonly Address[] = [],
  ): Promise<void> {
    if (mode !== 'mainnet') return;
    try {
      const marginAccount = addresses.kuru.marginAccount;
      if (marginAccount && to.toLowerCase() === marginAccount.toLowerCase()) return;

      // A permit is not a market and has no notional to read. Its own bound is the
      // value cap in `assertSponsorable`, which has already run on this batch.
      if (sponsoredPermitTokens.some((t) => t.toLowerCase() === to.toLowerCase())) return;

      // Nor is a sponsored token action (D1/C1/D2, 2026-09-25 — three pinned transfer
      // tokens before that, D128). A `transfer` or an `approve` on ANY token target is
      // bounded by `assertSponsorable` itself, which runs on every batch before
      // anything is forwarded: the transfer's shape and the par cap on dollar tokens,
      // the approve's exact opened-and-revoked triple. These selectors are not
      // forwardable on an order book, so early-returning them here removes no bound —
      // it only stops the fall-through to `assertMarketAllowed`, which used to refuse
      // them with a sentence about order books after the user had already signed
      // (security review of D181, finding 1).
      if (selectorOf(data) === TRANSFER_SELECTOR || selectorOf(data) === APPROVE_SELECTOR) {
        return;
      }

      // The WMON wrap and unwrap (D3/B3): the pinned WMON address only. Their bound is
      // the policy's own pairing rules (`assertWmonWrap`: value only beside the margin
      // withdrawal that produced it; `assertWmonUnwrap`: only after the Flow swap that
      // delivered WMON) — a notional cap has nothing to measure on the account's own
      // money passing through its own wrapper.
      if (
        to.toLowerCase() === MAINNET.tokens.WMON.address.toLowerCase() &&
        (selectorOf(data) === WMON_DEPOSIT_SELECTOR || selectorOf(data) === WMON_WITHDRAW_SELECTOR)
      ) {
        return;
      }

      // A Flow swap is not a market either, so the order cap cannot be applied to it —
      // but it must not therefore be uncapped where a cap means anything. Bound what a
      // DOLLAR-token swap spends, read at the words where a Flow route carries
      // tokenIn/amountIn (see FLOW_WORD_* in core policy): a permit-paid swap (always a
      // dollar token) leaves a standing allowance its value cap must bound, and a
      // dollar amount is what the 6-unit figure measures. A swap spending any other
      // token has arbitrary decimals — 6e6 base units of an 18-decimal token is dust,
      // so the old unconditional cap refused every real amount (review finding 1) —
      // and its bound is the C1 triple's own revoke: no allowance survives the batch.
      // The same holds for every pinned swap router (rule 1.9): Flow read at its measured
      // words, KyberSwap decoded with its verified ABI (`readPinnedSwap`).
      if (isPinnedSwapRouter(to)) {
        const read = readPinnedSwap(to, data);
        if (!read) {
          throw new CapExceededError(
            'sponsored swap notional',
            'a sponsored swap must say what it spends, and this one could not be read',
          );
        }
        const tokenIn = read.tokenIn.toLowerCase();
        const dollarTokenIn =
          SPONSORED_TRANSFER_TOKENS.includes(tokenIn) ||
          sponsoredPermitTokens.some((t) => t.toLowerCase() === tokenIn);
        if (dollarTokenIn) {
          const amountIn = read.amountIn;
          if (amountIn === 0n || amountIn > MAX_SPONSORED_PERMIT_VALUE) {
            throw new CapExceededError(
              'sponsored swap notional',
              `a sponsored swap spends at most ${MAX_SPONSORED_PERMIT_VALUE} base units, this one spends ${amountIn}`,
            );
          }
        }
        return;
      }

      // A book the caller's own policy already allowed. `/v1/bundler` permits the
      // AUSD/USDC conversion leg explicitly rather than by widening the code allowlist,
      // and without this the caps then refused the very leg the policy had just let
      // through — a 403 the bundler client could not even parse, because it left this
      // route as an HTTP error rather than a JSON-RPC one.
      if (!extraMarkets.some((m) => m.toLowerCase() === to.toLowerCase())) assertMarketAllowed(to);
      const params = await marketParams.get(to);
      // Live prices, read here rather than trusted from anything in the calldata or the
      // request: the book's best bid for a market sell, which carries base size and no
      // quote figure, and the MON/USDC mid for any order on a market quoted in MON, so
      // the order is measured in dollars (see `notional.ts`). A cancel, or an order on a
      // dollar-quoted market that is not a market sell, needs no price and pays for no read.
      const context = await readNotionalContext(capPriceReader, to, data, params);
      assertNotionalWithinCap(data, params, context);
    } catch (error) {
      if (error instanceof CapExceededError) {
        throw new Rejection('CAP_EXCEEDED', error.message, 403);
      }
      throw error;
    }
  }

  function enforceRateLimits(subject: Address, ip: string): void {
    if (db.hitRateLimit(subject, 'address', config.rateLimitPerAddressHour, now())) {
      throw new Rejection('RATE_LIMITED', 'too many requests from this account this hour', 429);
    }
    if (db.hitRateLimit(ip, 'ip', config.rateLimitPerIpHour, now())) {
      throw new Rejection('RATE_LIMITED', 'too many requests from this network this hour', 429);
    }
  }

  /**
   * Decide what the account needs before its operation can be validated. Read-only:
   * this is `/v1/sponsor`'s dry run, and it never moves anything.
   *
   * The EntryPoint requires the deposit to cover the whole prefund reservation, not
   * just the gas actually burned, so an account whose deposit is thin is refused by
   * the bundler with `AA21 didn't pay prefund`. Checking here turns that into a
   * decision the relayer makes on purpose.
   */
  async function planTopUp(sender: Address) {
    const state = await readEntryPointDeposit(client, sender);
    const signer = readSigningKey();
    let relayerBalance = 0n;
    if (signer) {
      const { privateKeyToAccount } = await import('viem/accounts');
      relayerBalance = await client.getBalance({
        address: privateKeyToAccount(signer).address,
      });
    }
    const t = now();
    const headroom = prefundHeadroom(db.prefundUsage(sender, t), budgets, t);
    const decision = decideTopUp({
      deposit: state.deposit,
      budgetRemaining: headroom.remaining,
      relayerBalance,
    });
    return {
      entryPointDeposit: state.deposit.toString(),
      minDeposit: MIN_ENTRYPOINT_DEPOSIT_WEI.toString(),
      needsTopUp: state.needsTopUp,
      willTopUp: decision.topUp,
      topUpAmount: decision.amount.toString(),
      allowanceRemainingWei: headroom.remaining.toString(),
      ...(headroom.resetsAt !== undefined
        ? { allowanceResetsAt: new Date(headroom.resetsAt).toISOString() }
        : {}),
      ...(decision.refusal ? { refusal: decision.refusal } : {}),
    };
  }

  app.setErrorHandler((error: unknown, _req, reply) => {
    if (error instanceof Rejection) {
      return reply.status(error.status).send({ code: error.code, message: error.message });
    }
    const named = error as { validation?: unknown; name?: string; message?: string };
    if (named.validation || named.name === 'ZodError') {
      return reply.status(400).send({ code: 'BAD_REQUEST', message: 'request body is not valid' });
    }
    app.log.error({ err: named.message }, 'unhandled relayer error');
    return reply
      .status(500)
      .send({ code: 'INTERNAL', message: 'the relayer could not handle that request' });
  });

  app.post('/v1/forward', async (req, reply) => {
    const body = forwardBodySchema.parse(req.body);
    const request = toForwardRequest(body.request);

    enforceRateLimits(request.from, clientIp(req));
    validateForwardStructure(request, validationContext());
    await enforceHardCaps(request.to, request.data);
    await validateForwardSignature(request, body.signature as Hex, validationContext());

    const forwarder = (addresses.kuru.forwarder ?? KURU_FORWARDER_ADDRESS) as Address;
    const simulation = await simulateForwardedCall(client, forwarder, request);
    if (!simulation.ok) {
      db.recordRelay({
        from: request.from,
        to: request.to,
        selector: selectorOf(request.data),
        purpose: body.purpose,
        status: 'rejected',
        error: simulation.errorName ?? 'simulation reverted',
        now: now(),
      });
      throw new Rejection(
        'SIMULATION_REVERTED',
        simulation.userMessage ?? 'that order would not go through',
        409,
      );
    }

    // Everything a user-signed request can be checked for has passed. The one thing
    // missing is ours, not theirs.
    db.recordRelay({
      from: request.from,
      to: request.to,
      selector: selectorOf(request.data),
      purpose: body.purpose,
      status: 'rejected',
      error: 'FORWARDER_SCHEMA_UNVERIFIED',
      now: now(),
    });
    return reply.status(503).send({
      code: 'FORWARDER_SCHEMA_UNVERIFIED',
      message:
        'This request is valid and would succeed on chain, but the relayer cannot ' +
        'submit it yet: the KuruForwarder request format is not verified ' +
        '(DECISIONS.md open item 1).',
      simulated: 'ok',
    });
  });

  app.post('/v1/permit', async (req, reply) => {
    const body = permitBodySchema.parse(req.body);
    const marginAccount = addresses.kuru.marginAccount;
    if (!marginAccount) {
      throw new Rejection(
        'TARGET_NOT_ALLOWED',
        `no MarginAccount is known for ${mode}; permits cannot be relayed there`,
        503,
      );
    }
    enforceRateLimits(body.owner as Address, clientIp(req));
    validatePermit(body, { marginAccount, now });

    if (!config.hasSigningKey) {
      throw new Rejection(
        'BAD_REQUEST',
        'this relayer has no signing key configured and cannot submit transactions',
        503,
      );
    }
    return reply.status(503).send({
      code: 'NOT_IMPLEMENTED',
      message: 'permit submission lands with the forwarder work; validation passed',
    });
  });

  app.post('/v1/bundle', async (req, reply) => {
    const body = bundleBodySchema.parse(req.body);
    const marginAccount = addresses.kuru.marginAccount;
    if (body.permit) {
      if (!marginAccount) {
        throw new Rejection('TARGET_NOT_ALLOWED', `no MarginAccount known for ${mode}`, 503);
      }
      validatePermit(body.permit, { marginAccount, now });
    }
    const request = toForwardRequest(body.forward.request);
    enforceRateLimits(request.from, clientIp(req));
    validateForwardStructure(request, validationContext());
    await validateForwardSignature(request, body.forward.signature as Hex, validationContext());

    return reply.status(503).send({
      code: 'FORWARDER_SCHEMA_UNVERIFIED',
      message:
        'Both halves of this bundle are valid; submission waits on the KuruForwarder ' +
        'request format (DECISIONS.md open item 1).',
    });
  });

  /**
   * `/v1/sponsor` — the EIP-7702 replacement for `/v1/forward`.
   *
   * The client sends the calls it wants in a user operation. The relayer applies the
   * sponsorship policy — same targets, same selectors, same caps as before — and only
   * then would ask Pimlico to sponsor. It never signs: under 7702 the only signature
   * that authorizes anything is the user's own, over their own user operation.
   */
  app.post('/v1/sponsor', async (req, reply) => {
    const body = sponsorBodySchema.parse(req.body);
    const marginAccount = addresses.kuru.marginAccount;
    if (!marginAccount) {
      throw new Rejection('TARGET_NOT_ALLOWED', `no MarginAccount known for ${mode}`, 503);
    }
    enforceRateLimits(body.sender as Address, clientIp(req));

    const calls = body.calls.map((c) => ({ to: c.to as Address, data: c.data as Hex }));
    try {
      // Notional is enforced separately below, against the market's own params. This dry
      // run never charges, so nothing in it may pay the fee address.
      assertSponsorable(calls, {
        marginAccount,
        permitTokens: [addresses.tokens.AUSD.address],
        sender: getAddress(body.sender),
        ...gasFeeContext('none'),
      });
    } catch (error) {
      if (error instanceof PolicyViolation) {
        // Carry the policy's own reason through. Collapsing everything that is not a
        // cap into SELECTOR_NOT_ALLOWED told a client the wrong thing: a call to the
        // wrong market came back as a bad selector.
        const status = error.reason === 'CAP_EXCEEDED' ? 403 : 400;
        const code =
          error.reason === 'EMPTY_BATCH'
            ? 'BAD_REQUEST'
            : (error.reason as
                | 'TARGET_NOT_ALLOWED'
                | 'SELECTOR_NOT_ALLOWED'
                | 'VALUE_NOT_ZERO'
                | 'CAP_EXCEEDED'
                | 'FEE_LEG_MISMATCH');
        throw new Rejection(code, error.message, status);
      }
      throw error;
    }

    // Notional is checked against the market's own params, same as before.
    for (const call of calls) {
      await enforceHardCaps(call.to, call.data);
    }

    if (!config.hasPimlicoKey) {
      throw new Rejection(
        'BAD_REQUEST',
        'this relayer has no Pimlico key configured and cannot reach a bundler',
        503,
      );
    }

    // Gas comes from the account's own EntryPoint deposit, which this service keeps
    // topped up from its MON float. There is no paymaster.
    const funding = await planTopUp(body.sender as Address);

    return reply.status(503).send({
      code: 'SUBMIT_GAS_LAYER_UNPROVEN',
      message:
        'This batch is valid and within policy. Submission is not enabled until the ' +
        'M0 gate has passed on chain.',
      policy: 'ok',
      sender: body.sender,
      funding,
    });
  });

  /**
   * `POST /v1/cctp/receive` — finish a CCTP transfer the user cannot finish themselves.
   *
   * The user burned USDC on the source chain with their own wallet and their own gas.
   * The mint on Monad needs a transaction, and their Monad account has no MON to pay for
   * one. Without this, a burn is money destroyed.
   *
   * ## Why this does not widen the relayer's policy
   *
   * `/v1/forward` executes calldata a **user** signed, so an allowlist of targets and
   * selectors is what bounds it. This executes calldata **Circle** signed. The
   * MessageTransmitter verifies Circle's signature against its own attester set on chain
   * and mints to the recipient baked into the message — the relayer chooses no amount, no
   * destination and no token, and a message altered by one byte mints nothing. The float
   * is what is at risk here, not anyone's funds, and the cap below is what bounds that.
   *
   * The attestation is fetched from Circle by this service. The request carries a
   * transaction hash and nothing else that is trusted.
   */
  app.post('/v1/cctp/receive', async (req, reply) => {
    const body = cctpReceiveBodySchema.parse(req.body);
    const recipient = body.recipient as Address;
    enforceRateLimits(recipient, clientIp(req));

    // Gas, not money: a bound on how much of the float one account can consume in a day.
    if (
      db.hitRateLimit(`cctp:${recipient}`, 'address', CCTP_MINTS_PER_USER_PER_DAY, now())
    ) {
      throw new Rejection(
        'RATE_LIMITED',
        `this account has reached its ${CCTP_MINTS_PER_USER_PER_DAY} completed transfers for now`,
        429,
      );
    }

    const outcome = await fetchAttestation(body, MONAD_CCTP_DOMAIN);
    if (!outcome.ready) {
      /**
       * 202 means "ask again"; 409 means "never".
       *
       * Both used to be 202, so a caller that could not tell them apart retried a
       * permanent refusal forever. The watcher did exactly that, every three seconds,
       * and each retry consumed the shared rate-limit bucket that also gates
       * `/v1/bundler` — five forged rows were enough to keep sponsorship off for
       * everyone.
       */
      if (outcome.permanent) {
        return reply.status(409).send({ code: 'RECIPIENT_MISMATCH', message: outcome.reason });
      }
      // The ordinary case: Circle is still attesting, and the client should poll.
      return reply.status(202).send({ code: 'NOT_READY', message: outcome.reason });
    }

    const relayer = loadRelayerAccount();
    if (!relayer) {
      throw new Rejection(
        'BAD_REQUEST',
        'this relayer cannot unlock its key, so it cannot complete the transfer',
        503,
      );
    }

    const data = encodeFunctionData({
      abi: MESSAGE_TRANSMITTER_ABI,
      functionName: 'receiveMessage',
      args: [outcome.message, outcome.attestation],
    });

    /**
     * Simulate before spending. A message already received reverts, and the float should
     * not pay to discover that — a second submission of the same transfer is the most
     * likely duplicate, because a client that did not see the first receipt retries.
     */
    try {
      await client.call({ account: relayer.address, to: MESSAGE_TRANSMITTER_V2, data });
    } catch (error) {
      const reason =
        error instanceof Error ? (error.message.split('\n')[0] ?? 'reverted') : String(error);
      return reply
        .status(409)
        .send({ code: 'WOULD_REVERT', message: `Monad refused this mint: ${reason}` });
    }

    const wallet = createWalletClient({
      account: relayer,
      chain: chainFor(mode),
      ...(config.rpcUrl ? { transport: http(config.rpcUrl) } : { transport: http() }),
    });
    // Under the relayer key's one lock, so a mint and a top-up never race for its nonce.
    // The receipt wait is bounded for the same reason the top-up's is: while it runs,
    // nothing else from this key can send.
    const { hash, receipt } = await relayerTxLock.run(async () => {
      const sent = await wallet.sendTransaction({ to: MESSAGE_TRANSMITTER_V2, data });
      const mined = await client.waitForTransactionReceipt({
        hash: sent,
        timeout: TOPUP_RECEIPT_TIMEOUT_MS,
        pollingInterval: RECEIPT_POLL_MS,
      });
      return { hash: sent, receipt: mined };
    });
    app.log.info(
      { recipient, hash, status: receipt.status, amount: outcome.amount },
      'cctp receiveMessage',
    );

    if (receipt.status !== 'success') {
      return reply
        .status(502)
        .send({ code: 'MINT_FAILED', message: 'The mint transaction did not go through', hash });
    }
    return reply.send({
      code: 'MINTED',
      hash,
      ...(outcome.amount ? { amount: outcome.amount } : {}),
    });
  });

  app.get<{ Params: { hash: string } }>('/v1/tx/:hash', async (req, reply) => {
    const row = db.findByTxHash(req.params.hash);
    if (!row) {
      return reply.status(404).send({ code: 'NOT_FOUND', message: 'no such relay' });
    }
    return {
      status: row.status,
      ...(row.error ? { error: row.error } : {}),
    };
  });

  /**
   * `/v1/health` reports `forwarderTrusted` from a **live** `eth_call`, never from
   * config (spec §5.2). A relayer that says "trusted" because a file said so is
   * reporting on a file.
   */
  /**
   * Compare two secrets without leaking their common prefix through timing.
   *
   * Network jitter dominates here, so this is precaution rather than a live hole —
   * but a short-circuiting compare on a credential is not worth keeping.
   */
  const constantTimeEquals = (a: string, b: string): boolean => {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
  };

  // Built from char codes: a literal escape here keeps getting rewritten by the
  // tooling that edits this file, the same reason scripts/m0-gate.ts does it.
  const BACKSLASH = String.fromCharCode(92);
  const DQUOTE = String.fromCharCode(34);
  const LINEFEED = String.fromCharCode(10);

  /**
   * Is this request from the machine itself?
   *
   * Fastify reports an IPv6-mapped address for a v4 loopback connection, so a plain
   * equality against '127.0.0.1' would lock out a local scraper.
   */
  const isLoopback = (ip: string | undefined): boolean => {
    if (!ip) return false;
    const bare = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
    return bare === '::1' || bare.startsWith('127.');
  };

  /**
   * Read the relayer float and record it. One reader, so `/v1/health` and
   * `/v1/metrics` cannot disagree about the same number.
   *
   * Resolved by ADDRESS, never by whether a private key happens to be in the
   * environment — keys live in a keystore in every real deployment. A missing or
   * malformed address returns `known: false` rather than throwing, so a bad keystore
   * degrades a gauge instead of turning an operational endpoint into a 500.
   */
  const readFloat = async (): Promise<{
    known: boolean;
    balance: bigint;
    belowAlert: boolean;
    overCap: boolean;
  }> => {
    const unknown = { known: false, balance: 0n, belowAlert: true, overCap: false };
    const signer = readSigningKey();
    let relayerAddress: Address | undefined;
    if (signer) {
      const { privateKeyToAccount } = await import('viem/accounts');
      relayerAddress = privateKeyToAccount(signer).address;
    } else {
      relayerAddress = readRelayerAddress();
    }
    if (!relayerAddress || !/^0x[0-9a-fA-F]{40}$/.test(relayerAddress)) return unknown;
    try {
      const balance = await client.getBalance({ address: relayerAddress });
      db.recordFloat(balance, now());
      // Alert against the EFFECTIVE cap, not a raw env number. The code cap is 20 MON
      // and the environment may only tighten it (caps.ts `tighten`), but
      // RELAYER_MAX_FLOAT_MON defaults to 50 — so the old arithmetic warned below
      // 10 MON for a cap that is really 20, and would have honoured an env value
      // above the cap it is meant to be bounded by. Integer wei throughout. The line is
      // `floatAlertThresholdWei`, shared with self-bundling's float floor.
      return {
        known: true,
        balance,
        belowAlert: balance < floatAlertThresholdWei(config),
        overCap: balance > MAX_RELAYER_FLOAT_WEI,
      };
    } catch {
      return unknown;
    }
  };

  /**
   * Operational metrics, Prometheus text exposition format.
   *
   * Deliberately boring: counters the relayer already keeps, plus the float gauge
   * an operator has to watch (rule A4 — "alert when float < 20%"). No request
   * bodies, no addresses, no hashes; a metrics scrape must not become a way to read
   * who used the relayer. `relayer_float_wei` is the one an alert should fire on.
   */
  /**
   * Decode a user operation's calls, single or batched.
   *
   * `toSimple7702SmartAccount.encodeCalls` (viem, `account-abstraction/accounts/
   * implementations/toSimple7702SmartAccount.ts`) special-cases a one-call batch: it
   * encodes `execute(address,uint256,bytes)` instead of `executeBatch`. Every plain
   * order and every cancel is exactly one call, so before this every single-call
   * operation decoded to `undefined` here and was refused with "the operation
   * carries no calls this relayer can read" — a policy check that never got to run,
   * not a policy decision. A deposit or a funding batch is two or three calls and
   * always took the `executeBatch` branch, which is why this never showed up there.
   */
  function decodeExecuteBatch(callData: Hex | undefined): SponsoredCall[] | undefined {
    if (!callData || callData.length < 10) return undefined;
    try {
      const decoded = decodeFunctionData({
        abi: [
          {
            type: 'function',
            name: 'executeBatch',
            stateMutability: 'payable',
            inputs: [
              {
                name: 'calls',
                type: 'tuple[]',
                components: [
                  { name: 'target', type: 'address' },
                  { name: 'value', type: 'uint256' },
                  { name: 'data', type: 'bytes' },
                ],
              },
            ],
            outputs: [],
          },
        ],
        data: callData,
      });
      const calls = decoded.args?.[0] as
        ReadonlyArray<{ target: Address; value: bigint; data: Hex }> | undefined;
      return calls?.map((c) => ({ to: c.target, data: c.data, value: c.value }));
    } catch {
      // Fall through to the single-call encoding below.
    }
    try {
      const decoded = decodeFunctionData({
        abi: [
          {
            type: 'function',
            name: 'execute',
            stateMutability: 'payable',
            inputs: [
              { name: 'target', type: 'address' },
              { name: 'value', type: 'uint256' },
              { name: 'data', type: 'bytes' },
            ],
            outputs: [],
          },
        ],
        data: callData,
      });
      const [target, value, data] = decoded.args as unknown as [Address, bigint, Hex];
      return [{ to: target, data, value }];
    } catch {
      return undefined;
    }
  }

  /**
   * Is `nonce` the EntryPoint's next nonce for `sender`, under this nonce's own key?
   *
   * A valid signature over a nonce that has already been used is a replay of an old
   * operation, not proof of a new one. viem draws a fresh 192-bit key per operation, so
   * the read is for this operation's key, never key zero. A read that fails is not a
   * match: the relayer does not spend on a nonce it could not check.
   */
  async function isNextNonce(sender: Address, nonce: bigint): Promise<boolean> {
    try {
      const expected = (await client.readContract({
        address: ENTRY_POINT_V08,
        abi: entryPoint08Abi,
        functionName: 'getNonce',
        args: [sender, nonceKeyOf(nonce)],
      })) as bigint;
      return expected === nonce;
    } catch {
      return false;
    }
  }

  /**
   * What a decoded batch is for, read from its own shape rather than trusted from the
   * client. This exists only so a top-up lands in `topups` next to a reason an operator
   * can read — it is not a security boundary, `assertSponsorable` already is that.
   */
  function inferPurpose(calls: readonly SponsoredCall[]): string {
    if (
      calls.length === 2 &&
      calls[1]?.to.toLowerCase() === addresses.kuru.marginAccount?.toLowerCase()
    ) {
      return 'deposit';
    }
    if (
      calls.length === 3 &&
      calls[1]?.to.toLowerCase() === addresses.kuru.marginAccount?.toLowerCase()
    ) {
      return 'deposit+convert';
    }
    if (calls.some((c) => isPinnedSwapRouter(c.to))) {
      return 'flow-convert';
    }
    return 'other';
  }

  /**
   * The bundler RPC methods that carry a real `UserOperation` naming a `sender`.
   * `pm_*` paymaster methods are not in this list because this project uses none.
   */
  const USER_OP_POLICY_METHODS = new Set(['eth_sendUserOperation', 'eth_estimateUserOperationGas']);

  /**
   * Everything else this proxy will forward, and nothing beyond it.
   *
   * The route used to forward any method it did not recognise straight to Pimlico with
   * the API key attached and no check at all. That is an open bundler proxy: it cannot
   * drain the float (`prefund.ensure` never runs for those methods) and it cannot take
   * custody (the operation is still user-signed), but it hands anyone who can reach the
   * relayer our paid quota, and it would carry any alternative submission method Pimlico
   * ever exposes straight past the sponsor policy. (Security review, 2026-09-09,
   * finding 4.)
   *
   * These are the read-only methods viem's bundler client actually calls on this path —
   * gas price, receipt, lookup, chain id, entry points. A method not on either list is
   * refused by name so the gap is visible rather than silently permitted.
   */
  const FORWARDABLE_BUNDLER_METHODS = new Set([
    'eth_chainId',
    'eth_supportedEntryPoints',
    'eth_getUserOperationByHash',
    'eth_getUserOperationReceipt',
    'pimlico_getUserOperationGasPrice',
    'pimlico_getUserOperationStatus',
  ]);

  /**
   * `/v1/bundler` — a JSON-RPC proxy in front of Pimlico, and the only way a user
   * operation leaves this system.
   *
   * A user operation is signed by its sender, and the sender is the user's own
   * passkey-derived key in their browser. The Pimlico key is the mirror image and must
   * never reach a browser. So the client keeps the exact sequence `scripts/m0-live.ts`
   * proved on mainnet and points its bundler transport here; this forwards with the key
   * attached, after checking what only a server can check:
   *
   *   - the **mode gate**, which the browser can never evaluate because `MODE` and
   *     `I_UNDERSTAND_THIS_USES_REAL_FUNDS` are not `NEXT_PUBLIC_` variables. A gate
   *     checked in the browser is permanently closed, which is why an armed build
   *     answered "simulated mode" and sent nothing;
   *   - the **sponsor policy**, before a send is forwarded rather than after;
   *   - the **sender's signature and nonce**, before anything is spent for it (S4-C1);
   *   - the **EntryPoint top-up**, because an account with a thin deposit is refused
   *     by the bundler with `AA21 didn't pay prefund`. It is paid only for a proven
   *     request, inside rolling budgets, one top-up at a time (`prefund.ts`).
   *
   * The relayer key signs exactly one thing here: `EntryPoint.depositTo` for the
   * user's own account. It never signs a user operation and never holds user funds.
   *
   * Since 2026-09-24 it also decides what an operation costs its sender: nothing (a send
   * or a withdraw of their own funds, or one of their free actions), or its own gas at
   * cost, paid by a fee leg at the end of the batch the sender signed. The relayer never
   * adds that leg and never signs it: it computes the fee, and refuses any batch whose
   * leg is not exactly that fee, to exactly its own fee address.
   *
   * The wrapper settles a free action this request reserved, on every exit: used when the
   * operation reached a bundler, released otherwise.
   */
  app.post('/v1/bundler', async (req, reply) => {
    const track: FreeActionTrack = { handedToBundler: false };
    try {
      return await bundlerRoute(req, reply, track);
    } finally {
      if (track.reservationId !== undefined) {
        db.settleFreeAction(track.reservationId, track.handedToBundler ? 'used' : 'released', now());
      }
    }
  });

  interface FreeActionTrack {
    reservationId?: number;
    handedToBundler: boolean;
  }

  /**
   * The owed-fee refusal: the action is charged and its batch carries no fee leg.
   *
   * Rebuild, 2026-09-25: one message, always, regardless of *why* the action is charged
   * — its free tier is used, or its own per-address MON budget is tight (F4). Before
   * this, the F4 case showed the raw sponsorship-allowance sentence ("this account's
   * allowance for today is used up"), which is exactly the wrong refusal a user with
   * free actions remaining saw for a withdraw-adjacent bug this rebuild fixes. No
   * longer takes a `budgetRefusal` to choose between sentences — there is only one.
   *
   * Reads the trading balance; spends nothing.
   */
  /**
   * Only the choices that are really live (D181 review, finding 6): a swap into MON
   * is funded from the exempt pool, so it is offered only while that pool could
   * still pay one more top-up — an offer the very next request would refuse is a
   * fake value, not a choice. "Add money" is always live: the fee lane's own caps
   * reset on their own clock, and money added is money held either way.
   */
  function liveGasChoices(sender: Address): readonly ('swap-into-mon' | 'add-money')[] {
    const swapWayOut = prefund.scopeRemaining(sender, 'exempt') >= ENTRYPOINT_TOPUP_WEI;
    return swapWayOut ? [...GAS_REFUSAL_CHOICES] : ['add-money'];
  }

  async function owedRefusal(
    sender: Address,
    freeActions: FreeActionHeadroom,
    actions: readonly SponsoredCall[],
  ): Promise<{ message: string; data: GasChargeRefusalData }> {
    const counted = countedFreeActions(freeActions);
    const cannotPay = () => ({
      message: gasRefusalMessage(freeActions.remaining),
      data: {
        reason: 'FREE_ACTIONS_USED' as const,
        choices: liveGasChoices(sender),
        freeActions: counted,
      },
    });
    const marginAccount = addresses.kuru.marginAccount;
    if (!feeRecipient || !marginAccount) return cannotPay();
    const margin = await readMarginDollars(client, marginAccount, sender);
    if (!margin) {
      return { message: GAS_FEE_UNPRICED_MESSAGE, data: { reason: 'GAS_FEE_UNPRICED', freeActions: counted } };
    }
    const balances = withBatchDeposits(margin, actions, marginAccount, sender);
    if (!gasFeeTokenFor(balances, GAS_FEE_MINIMUM)) return cannotPay();
    // Can pay, but the signed batch carries no fee leg — a client that quoted first
    // (every screen that can be charged does) never reaches this; it exists only for a
    // stale client or a race against a concurrent free action. Same message: the client
    // retries, and a fresh quote tells it what to include.
    return cannotPay();
  }

  /**
   * Which budget a charged or refused action ran into, for the fall-through log line
   * (owner item 2, 2026-09-29): the free tier, an exhausted MON budget by scope, or the
   * exempt pool.
   */
  function budgetReached(
    freeTierUsed: boolean,
    budgetRefusal: Refusal | undefined,
    exempt: boolean,
  ): string {
    if (freeTierUsed) return 'free-actions';
    const data = budgetRefusal?.data;
    if (data && 'scope' in data && typeof data.scope === 'string') {
      return data.scope === 'account'
        ? 'per-address-day'
        : data.scope === 'account-hour'
          ? 'per-address-hour'
          : 'shared-hour';
    }
    if (budgetRefusal) return 'per-address';
    return exempt ? 'exempt-pool' : 'unknown';
  }

  /** The exempt backstop's own refusals that a lane change can get past (finding 4). */
  function isExemptBackstopRefusal(refusal: Refusal): boolean {
    const data = refusal.data;
    if (!data || !('reason' in data)) return false;
    return (
      data.reason === 'TOP_UP_ABOVE_GAS_USED' ||
      (data.reason === 'PRIOR_FEE_UNCONFIRMED' && refusal.message === PRIOR_TOPUP_NEVER_LANDED_MESSAGE)
    );
  }

  /** A refusal's `freeActions`: the count and, when there is one, when it next frees up. */
  function countedFreeActions(h: FreeActionHeadroom): NonNullable<GasChargeRefusalData['freeActions']> {
    return {
      limit: h.limit,
      used: h.used,
      remaining: h.remaining,
      ...(h.resetsAt !== undefined ? { resetsAt: h.resetsAt } : {}),
    };
  }

  async function bundlerRoute(
    req: FastifyRequest,
    reply: FastifyReply,
    track: FreeActionTrack,
  ): Promise<FastifyReply> {
    const body = (req.body ?? {}) as { id?: number | string; method?: string; params?: unknown[] };
    // R9 (2026-10-07): each stage of a send, in ms since it arrived, logged once at the end.
    const receivedAt = Date.now();
    const stages: Record<string, number> = {};
    const stageDetail: Record<string, unknown> = {};
    const mark = (stage: string, detail?: Record<string, unknown>) => {
      stages[stage] = Date.now() - receivedAt;
      if (detail) Object.assign(stageDetail, detail);
    };
    const logTiming = (path: string, userOpHash?: string) => {
      if (body.method !== 'eth_sendUserOperation') return;
      app.log.info(
        { path, userOpHash, stages: { ...stages, answered: Date.now() - receivedAt }, ...stageDetail },
        'send path timing',
      );
    };
    const rpcErr = (code: number, message: string) =>
      reply.send({ jsonrpc: '2.0', id: body.id ?? null, error: { code, message } });
    // A funding refusal. Only a used-up allowance carries `data`: the browser reads
    // `resetsAt` from it to say the time in the user's own zone. No amount, no wei.
    const refusalReply = (refusal: Refusal) =>
      reply.send({
        jsonrpc: '2.0',
        id: body.id ?? null,
        error: {
          code: -32000,
          message: refusal.message,
          ...(refusal.data ? { data: refusal.data } : {}),
        },
      });
    // A gas-charge refusal: the words, and `data` the browser can act on without parsing them.
    const chargeReply = (refusal: {
      message: string;
      data: GasChargeRefusalData | NonNullable<Refusal['data']>;
    }) =>
      reply.send({
        jsonrpc: '2.0',
        id: body.id ?? null,
        error: { code: -32000, message: refusal.message, data: refusal.data },
      });
    /**
     * A MON budget refusal from `ensure`, converted to the one gas sentence with its
     * live choices (B2c, 2026-09-25).
     *
     * `ensure`'s own internal budget check (`prefund.ts`) is a necessary defense in
     * depth against a race: this route steers every action to its funding lane before
     * anything is signed (free tier, then the user's own MON, then a charged fee), but
     * a concurrent request can still spend the last of a budget between the quote's
     * read and the send's. By the time a budget refusal is actually shown, the route
     * has already found the account's own MON short and the fee lane unavailable, so
     * which internal ledger was tight is a log line, not a sentence: every scope, the
     * shared hour included, converts to the same message. The choices carried with it
     * are the ones that are really live (`liveGasChoices`): a swap into MON is funded
     * from the exempt pool — carved from the same shared hour — so it is offered only
     * while that pool has room (D181 review, finding 6). The internal bound's own
     * reset time survives in `resetsAt`, machine-readably, so a client can show a
     * real time to wait instead of an endless retry.
     */
    const convertBudgetRefusal = (refusal: Refusal, sender: Address): Refusal => {
      const data = refusal.data;
      if (!data || !('reason' in data) || data.reason !== SPONSORSHIP_ALLOWANCE_USED) {
        return refusal;
      }
      const freeRemaining = freeActionsOf(db, sender, now()).remaining;
      app.log.info(
        { sender, budget: budgetReached(false, refusal, false), freeRemaining },
        'gas fall-through: top-up refused by a MON budget',
      );
      return {
        message: gasRefusalMessage(freeRemaining),
        data: {
          reason: 'FREE_ACTIONS_USED',
          choices: liveGasChoices(sender),
          ...('resetsAt' in data && typeof data.resetsAt === 'number'
            ? { resetsAt: data.resetsAt }
            : {}),
        },
      };
    };
    // Set when an operation is forwarded unfunded because no top-up was possible.
    let prefundRefusal: Refusal | undefined;
    // The verified operation, when there is one, in place of the raw request params.
    let forwardParams: unknown[] | undefined;

    if (typeof body.method !== 'string') return rpcErr(-32600, 'no method');
    if (!USER_OP_POLICY_METHODS.has(body.method) && !FORWARDABLE_BUNDLER_METHODS.has(body.method)) {
      return rpcErr(-32601, `this relayer does not forward ${body.method}`);
    }

    const armed =
      GAS_LAYER_PROVEN &&
      config.hasPimlicoKey &&
      gate.runMode === 'live' &&
      gate.realFundsAcknowledged;
    if (!armed) {
      return rpcErr(
        -32000,
        'This relayer is not armed, so nothing was sent. Everything up to sending was checked.',
      );
    }

    const apiKey = readPimlicoKey();
    if (!apiKey) return rpcErr(-32000, 'no bundler is configured');

    // Both methods carry a real UserOperation naming a sender, and Pimlico checks the
    // prefund on either one — estimation simulates against the account's actual
    // EntryPoint deposit exactly as a send does. Gating this block on send alone meant
    // an under-funded account got "AA21 didn't pay prefund" from the ESTIMATE call,
    // before the code that would have funded it ever ran: the browser saw the raw
    // bundler error and the passkey prompt for the batch's permit had already fired.
    if (USER_OP_POLICY_METHODS.has(body.method)) {
      const op = (body.params?.[0] ?? {}) as Record<string, unknown>;
      const sender = op.sender as string | undefined;
      if (!sender || !/^0x[0-9a-fA-F]{40}$/.test(sender)) {
        return rpcErr(-32602, 'the operation has no sender');
      }
      const senderAddress = sender as Address;

      /**
       * Rate-limit here, not only on `/v1/sponsor`.
       *
       * This is the route through which anything is actually submitted — the browser
       * reaches it via `/api/submit` — and it was the only submitting route with
       * neither a per-address nor a per-IP limit, which A4 requires of all of them.
       * The top-up below pays out of the relayer float *before* the operation is
       * forwarded. Since 2026-09-23 it pays only for a request whose signature recovers
       * to the sender. But fresh keys are free, so the limits here and the
       * all-addresses budget in `prefund.ts` are still what bound a sweep of new
       * addresses. (Security review, 2026-09-09, finding 3; audit S4-C1.)
       */
      try {
        enforceRateLimits(senderAddress, clientIp(req));
      } catch (error) {
        if (error instanceof Rejection) return rpcErr(-32000, error.message);
        throw error;
      }

      const calls = decodeExecuteBatch(op.callData as Hex | undefined);
      if (!calls) return rpcErr(-32602, 'the operation carries no calls this relayer can read');

      const marginAccount = addresses.kuru.marginAccount;
      if (!marginAccount) return rpcErr(-32000, `no MarginAccount is known for ${mode}`);

      /**
       * What this operation costs its sender (2026-09-24), decided from the relayer's own
       * ledger and the batch's own shape, never from anything the client says about it:
       *
       *   - a send or a withdraw of the user's own funds: free, never counted;
       *   - otherwise, with a free action left: free, and it takes one when it is sent;
       *   - otherwise: charged. The batch must end in the fee leg, and on a send the leg
       *     must be exactly the fee the relayer recomputes below from the signed operation.
       *
       * `splitFeeLeg` finds the leg by its payment to the fee address and checks its shape;
       * `assertSponsorable` then checks it against `expected`. A leg on a batch that is not
       * charged, or a charged batch without one, is refused there as FEE_LEG_MISMATCH.
       */
      let split: SplitBatch;
      try {
        split = feeRecipient ? splitFeeLeg(calls, marginAccount, feeRecipient) : { actions: calls };
      } catch (error) {
        if (error instanceof PolicyViolation) {
          return chargeReply({ message: error.message, data: { reason: 'FEE_LEG_MISMATCH' } });
        }
        throw error;
      }
      // Sends, withdraws and cancels (F3) are never counted and never charged.
      const exempt = exemptionOf(split.actions, marginAccount) !== undefined;
      const freeActions = freeActionsOf(db, senderAddress, now());
      // Charged for want of free actions. The other reason, the account's own budget (F4),
      // needs the operation's prefund and deposit and is decided further down.
      const freeTierUsed = !exempt && freeActions.remaining === 0;
      const policyContext: PolicyContext = {
        marginAccount,
        permitTokens: sponsoredPermitTokens,
        // The operation's own sender: a pinned router swap that names a receiver must
        // name this account (rule 1.9, KyberSwap's dstReceiver).
        sender: senderAddress,
        // Load-bearing again since 2026-09-23: AUSD/USDC left LIVE_MARKET_ALLOWLIST
        // (shown, not traded), so this is once more the only thing that lets the
        // funding conversion leg through. `markets` only ever widens — `policy.ts`
        // falls through to `assertMarketAllowed` for anything not named here.
        markets: [AUSD_USDC_MARKET],
      };

      try {
        // The fee leg's shape only, here. Whether this action is charged at all, and at
        // what figure, is settled below and checked again before anything is spent.
        assertSponsorable(calls, {
          ...policyContext,
          // An exempt action's fee leg is real too (B2d's fall-through to the fee
          // lane), so `exempt` no longer gates the expectation.
          ...gasFeeContext(split.feeLeg ? 'unpriced' : 'none'),
        });
      } catch (error) {
        if (error instanceof PolicyViolation) {
          if (error.reason === 'FEE_LEG_MISMATCH') {
            return chargeReply({ message: error.message, data: { reason: 'FEE_LEG_MISMATCH' } });
          }
          return rpcErr(-32000, error.message);
        }
        throw error;
      }

      // A spent free tier is no longer answered here: whether the account's own MON can
      // pay instead (B2a) needs the operation's prefund, its deposit and its native
      // balance, all read below — the refusal, when it really is one, comes from the
      // one decision point further down, estimate and send alike.

      // A possibly-charged send's live reads, started now alongside the others. None
      // spends. An exempt action carrying a fee leg is charged too (B2d: the exempt
      // pool's bounds fall through to the fee lane), so `exempt` does not gate this.
      const mayBeChargedSend = split.feeLeg !== undefined && body.method === 'eth_sendUserOperation';
      const chargedBalances = mayBeChargedSend
        ? readMarginDollars(client, marginAccount, senderAddress)
        : undefined;
      // The base fee the charged send's max fee is held to, read fresh, not the quote's.
      const chargedBaseFee = mayBeChargedSend ? readBaseFee(client) : undefined;
      /**
       * Start this request's chain reads now, alongside the caps, the signature check and
       * each other, rather than one after another (speed pass, 2026-09-24). Every one is a
       * read, none spends, and none can reject. Their answers are only acted on below, in
       * the same order the checks always ran, so a request refused by the caps is still
       * refused by the caps.
       *
       * The inner-call read is the chain's own answer on what the operation does. It is
       * only started for an operation that could use it: addressed to EntryPoint v0.8,
       * well formed, with no EIP-7702 authorization (a first operation, which Pimlico
       * still estimates and sends) and no paymaster.
       */
      const entryPoint = body.params?.[1];
      const entryPointIsV08 =
        typeof entryPoint === 'string' && entryPoint.toLowerCase() === ENTRY_POINT_V08.toLowerCase();
      const parsed = rpcUserOperationSchema.safeParse(op);
      const verified =
        entryPointIsV08 &&
        parsed.success &&
        parsed.data.sender.toLowerCase() === senderAddress.toLowerCase()
          ? parsed.data
          : undefined;
      /**
       * A first operation (the EIP-7702 marker plus an authorization to exactly this
       * relayer's delegate) is planned here too (owner items 1 and 3, 2026-09-29, D191):
       * its call is simulated with that delegation set by state override, so its estimate
       * is answered from its own simulation and needs no deposit, and its gas limits are
       * this relayer's, not Pimlico's. Its send still goes to Pimlico, which the type-4
       * transaction needs (`SelfBundler` declines an authorization).
       *
       * Only a VERIFIED first operation is one (security review of D191, finding 2): its
       * authorization recovers to the sender, for this chain, at its current transaction
       * count (`isVerifiedFirstOperation`). Anything else carrying an authorization is
       * handled exactly as before this change: Pimlico estimates it, nothing reads it.
       */
      const firstOperationCandidate =
        verified !== undefined &&
        verified.eip7702Auth !== undefined &&
        verified.eip7702Auth.address.toLowerCase() === SIMPLE_7702_DELEGATE.toLowerCase();
      const localGas =
        verified !== undefined &&
        (firstOperationCandidate || (verified.factory === undefined && verified.eip7702Auth === undefined)) &&
        !namesPaymaster(verified);
      const innerRead = localGas
        ? firstOperationCandidate
          ? Promise.all([
              simulateInnerCall(
                client,
                senderAddress,
                verified.callData as Hex,
                undefined,
                delegationCodeFor(SIMPLE_7702_DELEGATE),
              ),
              isVerifiedFirstOperation(client, senderAddress, verified, addresses.chainId),
            ]).then(([simulated, authorized]) => {
              // An estimate no larger than the call's intrinsic gas means the node ignored
              // the delegation override (finding 5): not an answer.
              const overrideHonoured =
                simulated.kind !== 'ok' || simulated.gas > intrinsicGasOf(verified.callData as Hex);
              return [simulated, authorized && overrideHonoured] as const;
            })
          : Promise.all([
              simulateInnerCall(client, senderAddress, verified.callData as Hex),
              isSimple7702(client, senderAddress),
            ])
        : undefined;
      const depositRead = verified
        ? readEntryPointDeposit(client, senderAddress).then(
            (state) => state.deposit,
            () => undefined,
          )
        : undefined;
      // The account's own native MON (B2a): read alongside the deposit, spent by the
      // EntryPoint itself when the deposit is short (verified 2026-09-25: the delegate's
      // `_payPrefund` pays `missingAccountFunds` from the account's balance, and Monad's
      // reserve is judged on the transaction's ENDING balance). A failed read means the
      // own-MON lane is simply not offered this time, never guessed.
      const nativeRead = verified
        ? client.getBalance({ address: senderAddress }).then(
            (balance) => balance,
            () => undefined,
          )
        : undefined;
      const signatureRead = verified
        ? verifyUserOperationSignature(verified, {
            chainId: addresses.chainId,
            entryPoint: ENTRY_POINT_V08,
          }).catch(() => ({ ok: false as const, reason: 'the signature could not be checked' }))
        : undefined;
      mark('parsed');

      try {
        for (const call of calls) await enforceHardCaps(call.to, call.data, [AUSD_USDC_MARKET]);
      } catch (error) {
        // This route speaks JSON-RPC. A Rejection thrown here would otherwise leave as
        // a bare HTTP error that a bundler client cannot read as a result.
        if (error instanceof Rejection) return rpcErr(-32000, error.message);
        throw error;
      }

      /**
       * Proof of the sender's key, before anything can be spent for it (S4-C1).
       *
       * The deposit this relayer tops up is EntryPoint v0.8's, so an operation addressed
       * to any other entry point is refused rather than funded into the wrong place.
       */
      if (!entryPointIsV08) {
        return rpcErr(-32602, 'this relayer carries operations for EntryPoint v0.8 only');
      }
      if (!parsed.success) return rpcErr(-32602, 'the operation is not well formed');
      if (!verified || !signatureRead) {
        // Unreachable while `sender` is read from the same object, and kept so it stays so.
        return rpcErr(-32602, 'the operation has no sender');
      }

      /**
       * A send must be signed by its sender, and its nonce must be the next one.
       * Otherwise it is refused outright: the chain would refuse it anyway, and refusing
       * here means no top-up can ride on it.
       *
       * An estimate is treated differently only in what it may cost. The browser signs
       * its estimate (`withSignedEstimates`) so a first operation can be funded before the
       * bundler checks the prefund. An estimate carrying viem's placeholder signature is
       * still forwarded, so a funded account estimates exactly as before, but it is never
       * funded. A `prove` that resolves true is the only thing that lets `prefund.ensure`
       * spend, and there is no `prove` at all without a valid signature.
       */
      const isSend = body.method === 'eth_sendUserOperation';
      const signature = await signatureRead;
      /**
       * R9 (2026-10-07): a signed send that may be self-bundled has its bundle's reads started
       * now, alongside the checks below, instead of after them. Only once its signature has
       * recovered to its sender (a local check), so an unsigned request costs no reads. Reads
       * only, nothing reserved or spent; `SelfBundler` uses them only if no relayer-key
       * transaction went out in between, and otherwise reads again inside its lock.
       */
      let bundlePrefetch: SelfBundlePrefetch | undefined;
      if (isSend && signature.ok && localGas && !firstOperationCandidate && selfBundler.enabled) {
        try {
          bundlePrefetch = selfBundler.prefetch({ op: verified, sender: senderAddress });
        } catch {
          bundlePrefetch = undefined;
        }
      }
      mark('signature', { prefetched: bundlePrefetch !== undefined });
      if (!signature.ok && isSend) {
        return rpcErr(-32602, 'the operation is not signed by its sender');
      }

      /**
       * The nonce half of the proof is read only when it could decide a spend.
       *
       * It costs a chain read. Most requests come from an account whose deposit is
       * already funded, and for those nothing is spent and the bundler checks the nonce
       * itself. So `prefund.ensure` calls this only once it knows a top-up is needed and
       * the budget has room. It still runs before the lock and before any reservation.
       */
      const prove = signature.ok
        ? () => isNextNonce(senderAddress, signature.nonce)
        : undefined;

      /**
       * The chain's own answer on the operation's call, before anything is spent for it.
       *
       * Only read from an account delegated to `Simple7702Account`. The read sends the
       * account its own call data, and only that delegate is known to run it as the
       * EntryPoint would. For anything else the answer means nothing and is ignored, and
       * Pimlico handles the operation as before.
       *
       * A revert blocks the operation here, with the chain's reason, and never falls back
       * to Pimlico: it would be mined and charged and fail regardless of any gas limit. A
       * read that failed any other way (timeout, RPC error) is not an answer, and the
       * operation goes to Pimlico exactly as it did before this pass.
       */
      const [inner, delegated] = innerRead ? await innerRead : [undefined, false];
      // A first operation, verified and simulated with its delegation (finding 2).
      const firstOperation = firstOperationCandidate && delegated;
      if (delegated && inner?.kind === 'reverted') {
        return reply.send({
          jsonrpc: '2.0',
          id: body.id ?? null,
          error: {
            code: -32521,
            message: inner.message,
            ...(inner.revertData ? { data: inner.revertData } : {}),
          },
        });
      }
      const innerGas = delegated && inner?.kind === 'ok' ? inner.gas : undefined;

      // Part A: the estimate is answered here, from the inner call and measured constants.
      let plan: GasPlan | undefined;
      if (!isSend && innerGas !== undefined) {
        const planned = planUserOperationGas({
          innerEstimate: innerGas,
          callCount: calls.length,
          callDataBytes: BigInt((verified.callData.length - 2) / 2),
        });
        if (!planned.ok) return rpcErr(-32000, planned.reason);
        plan = planned.plan;
      }

      // A send's own prefund, from the limits and fee its sender signed; an estimate's,
      // from the limits it is about to be given. The EntryPoint v0.8 formula with no
      // paymaster, which is refused above. An estimate Pimlico will answer has no known
      // limits, so its prefund is left for the bundler to judge.
      const op08 = parsed.data;
      const ownPrefund = isSend
        ? requiredPrefund({
            callGasLimit: BigInt(op08.callGasLimit ?? '0x0'),
            verificationGasLimit: BigInt(op08.verificationGasLimit ?? '0x0'),
            preVerificationGas: BigInt(op08.preVerificationGas ?? '0x0'),
            maxFeePerGas: BigInt(op08.maxFeePerGas),
          })
        : plan
          ? requiredPrefund({ ...plan, maxFeePerGas: BigInt(op08.maxFeePerGas) })
          : undefined;

      const knownDeposit = depositRead ? await depositRead : undefined;

      /**
       * F4: free actions remain, but the account's own sponsorship budget cannot fund this
       * operation and its deposit cannot run it alone. Then it is charged instead of
       * refused: "never blocked because of gas". Decided from this operation's own prefund
       * (as signed, or as the estimate is about to answer it) and its deposit.
       */
      const budgetRefusal =
        !exempt && !freeTierUsed
          ? await prefund.addressBudgetBlocks(senderAddress, {
              ...(ownPrefund !== undefined ? { requiredPrefund: ownPrefund } : {}),
              ...(knownDeposit !== undefined ? { deposit: knownDeposit } : {}),
            })
          : undefined;
      /**
       * B2a, the own-MON lane. What the EntryPoint will draw from the account's native
       * balance is the shortfall of the prefund over the deposit; Monad requires the
       * ending balance to stay at or above the delegated reserve, so the lane exists
       * exactly when `native >= reserve + shortfall` (both facts verified on mainnet,
       * 2026-09-25: the delegate pays `missingAccountFunds` itself, and the reserve is
       * checked once, on the whole transaction's ending balance). A deposit that could
       * not be read counts as zero here, which only ever OVERSTATES the shortfall — the
       * lane is offered less often, never on a balance that could not carry it.
       */
      const nativeBalance = nativeRead ? await nativeRead : undefined;
      mark('chain-reads');
      const prefundShortfall =
        ownPrefund === undefined
          ? undefined
          : ownPrefund > (knownDeposit ?? 0n)
            ? ownPrefund - (knownDeposit ?? 0n)
            : 0n;
      // The owner's own rule, to the letter: the lane exists when the wallet holds the
      // reserve PLUS the operation's whole prefund — not merely the shortfall, though
      // the EntryPoint will only draw that much. A deposit that already covers the
      // prefund needs no lane at all: `ensure` answers not-needed and nothing changes.
      // Security review F2 (2026-09-29): a first-call WMON wrap (rule 1.8) spends native
      // MON in this same operation, so the lane is judged on what the wallet will hold
      // after it, not before. D200 widened this to every value-carrying shape
      // (a plain send, a native margin deposit), not just a wrap.
      const nativeSpend = nativeValueSpent(split.actions);
      const ownMonCovers =
        ownPrefund !== undefined &&
        prefundShortfall !== undefined &&
        prefundShortfall > 0n &&
        nativeBalance !== undefined &&
        nativeBalance >= MONAD_DELEGATED_RESERVE_WEI + ownPrefund + nativeSpend;

      // An exempt action carrying a verified fee leg is the exempt lane's own fall-
      // through (B2d): its sponsored pool was spent at quote time, its own MON did not
      // cover, and the client attached the fee the quote named. It is charged exactly
      // as a free-tier action past its allowance is.
      const exemptCharged = exempt && split.feeLeg !== undefined;
      const charged = freeTierUsed || budgetRefusal !== undefined || exemptCharged;
      // Charged with no fee leg: the account's own MON is the next lane (B2 order —
      // free tier, then own MON, then the trading balance). Only when that lane is
      // short too does the one refusal, with its live choices, come back.
      const ownMon = charged && !split.feeLeg && ownMonCovers;
      if (charged) {
        app.log.info(
          {
            sender: senderAddress,
            method: body.method,
            budget: budgetReached(freeTierUsed, budgetRefusal, exempt),
            freeRemaining: freeActions.remaining,
            lane: split.feeLeg ? 'trading-balance' : ownMon ? 'own-mon' : 'none',
          },
          'gas fall-through: budget reached',
        );
      }
      if (charged && !split.feeLeg && !ownMon) {
        return chargeReply(await owedRefusal(senderAddress, freeActions, split.actions));
      }
      if (!charged && split.feeLeg) {
        return chargeReply({
          message: 'this action is not charged, so its batch may not pay the relayer',
          data: { reason: 'FEE_LEG_MISMATCH' },
        });
      }

      /**
       * A charged send, checked in three steps before anything is spent for it
       * (independent review, 2026-09-24, two rounds).
       *
       * First, the envelope. A top-up is paid only for an operation that can run, so a
       * charged operation is refused, never funded, unless it is signed the way the quote
       * handed it out: gas limits exactly this relayer's fresh plan for the same call data
       * (above it the deposit is short, AA21; below it validation can starve, AA23, or a
       * bundler never includes it); a max fee from 1.2x to 3x a freshly read base fee and a
       * tip of at least 1 gwei (self-bundling's own band, `SELF_BUNDLE_MIN_FEE_OVER_BASE`,
       * `SELF_BUNDLE_MAX_FEE_OVER_BASE`, `SELF_BUNDLE_MIN_PRIORITY_FEE_WEI`: under it nothing
       * includes it, over it the prefund balloons); and a prefund of at most
       * `FEE_PAID_MAX_PREFUND_WEI`.
       *
       * Then the fee: recomputed from the operation as signed, at a pricing this relayer read
       * (`/v1/gas/quote`), and the whole batch refused unless its fee leg is exactly that fee,
       * in the token the trading balance pays it in, to this relayer's fee address. The
       * client's amount is compared, never used.
       *
       * Last, before any top-up is paid, `verifyRun` below: the deposit and the bundle
       * simulated together, and nothing paid unless the operation runs.
       */
      if (charged && isSend && split.feeLeg) {
        if (namesPaymaster(op08)) {
          // Someone else would pay the gas this fee is for.
          return chargeReply({
            message: 'an operation paid for by a paymaster is not charged a network fee',
            data: { reason: 'FEE_LEG_MISMATCH' },
          });
        }
        const pricings = feePricings.recent(now());
        if (pricings.length === 0) {
          return chargeReply({
            message: GAS_FEE_QUOTE_EXPIRED_MESSAGE,
            data: { reason: 'GAS_FEE_QUOTE_EXPIRED' },
          });
        }
        // The relayer's own plan for this call data, from the fresh inner estimate this
        // request already read. Without one there is nothing to hold the limits to, and a
        // charged send is refused rather than funded on limits the relayer cannot vouch for.
        // A first operation is never charged-funded (security review of D191, finding 2):
        // its run cannot be simulated through handleOps without the authorization, so the
        // `verifyRun` every charged top-up needs is impossible for it.
        const freshPlan =
          innerGas === undefined || firstOperation
            ? undefined
            : planUserOperationGas({
                innerEstimate: innerGas,
                callCount: calls.length,
                callDataBytes: BigInt((verified.callData.length - 2) / 2),
              });
        const [margin, baseFee] = await Promise.all([
          chargedBalances ?? Promise.resolve(undefined),
          chargedBaseFee ?? Promise.resolve(undefined),
        ]);
        if (!margin || !split.feeLeg || !freshPlan?.ok || baseFee === undefined) {
          return chargeReply({ message: GAS_FEE_UNPRICED_MESSAGE, data: { reason: 'GAS_FEE_UNPRICED' } });
        }
        const envelope = {
          callGasLimit: BigInt(op08.callGasLimit ?? '0x0'),
          verificationGasLimit: BigInt(op08.verificationGasLimit ?? '0x0'),
          preVerificationGas: BigInt(op08.preVerificationGas ?? '0x0'),
          maxFeePerGas: BigInt(op08.maxFeePerGas),
          maxPriorityFeePerGas: BigInt(op08.maxPriorityFeePerGas),
        };
        const maxFeeCeiling = baseFee * SELF_BUNDLE_MAX_FEE_OVER_BASE;
        const maxFeeFloor =
          (baseFee * SELF_BUNDLE_MIN_FEE_OVER_BASE.numerator +
            SELF_BUNDLE_MIN_FEE_OVER_BASE.denominator -
            1n) /
          SELF_BUNDLE_MIN_FEE_OVER_BASE.denominator;
        const outside = [
          ...limitsOffPlan(envelope, freshPlan.plan),
          ...(envelope.maxFeePerGas > maxFeeCeiling || envelope.maxFeePerGas < maxFeeFloor
            ? (['maxFeePerGas'] as const)
            : []),
          ...(envelope.maxPriorityFeePerGas < SELF_BUNDLE_MIN_PRIORITY_FEE_WEI ||
          envelope.maxPriorityFeePerGas > envelope.maxFeePerGas
            ? (['maxPriorityFeePerGas'] as const)
            : []),
          ...(ownPrefund === undefined || ownPrefund > FEE_PAID_MAX_PREFUND_WEI ? (['prefund'] as const) : []),
        ];
        if (outside.length > 0) {
          app.log.info(
            {
              sender: senderAddress,
              outside,
              maxFeeFloorWei: maxFeeFloor.toString(),
              maxFeeCeilingWei: maxFeeCeiling.toString(),
            },
            'charged operation refused: not signed the way the relayer will fund',
          );
          return chargeReply({
            message: GAS_ENVELOPE_REFUSED_MESSAGE,
            data: {
              reason: 'GAS_ENVELOPE_REFUSED',
              envelope: {
                outside,
                plan: {
                  callGasLimit: toHex(freshPlan.plan.callGasLimit),
                  verificationGasLimit: toHex(freshPlan.plan.verificationGasLimit),
                  preVerificationGas: toHex(freshPlan.plan.preVerificationGas),
                },
                maxFeePerGasFloor: toHex(maxFeeFloor),
                maxFeePerGasCeiling: toHex(maxFeeCeiling),
                minPriorityFeePerGas: toHex(SELF_BUNDLE_MIN_PRIORITY_FEE_WEI),
              },
            },
          });
        }
        const balances = withBatchDeposits(margin, split.actions, marginAccount, senderAddress);
        const verdict = judgeFeeLeg(envelope, pricings, balances, split.feeLeg);
        if (verdict.kind === 'unpriced') {
          return chargeReply({ message: GAS_FEE_UNPRICED_MESSAGE, data: { reason: 'GAS_FEE_UNPRICED' } });
        }
        if (verdict.kind === 'cannot-pay') {
          // The trading balance cannot cover this fee. One message, whatever made this
          // action charged (rebuild, 2026-09-25).
          return chargeReply({
            message: gasRefusalMessage(freeActions.remaining),
            data: { reason: 'FREE_ACTIONS_USED', freeActions: countedFreeActions(freeActions) },
          });
        }
        if (verdict.kind === 'mismatch') {
          return chargeReply({
            message: 'the fee in this batch is not the fee the relayer computed for this operation',
            data: {
              reason: 'FEE_LEG_MISMATCH',
              expectedFee: {
                token: verdict.expected.token.asset,
                amount: verdict.expected.amount.toString(),
              },
            },
          });
        }
        // The policy is the one place a payment to the relayer is allowed; it checks the
        // matched figure again rather than trusting the comparison above.
        try {
          assertSponsorable(calls, {
            ...policyContext,
            ...gasFeeContext({ token: verdict.token.asset, amount: verdict.amount }),
          });
        } catch (error) {
          if (error instanceof PolicyViolation) {
            return chargeReply({ message: error.message, data: { reason: 'FEE_LEG_MISMATCH' } });
          }
          throw error;
        }
        app.log.info(
          { sender: senderAddress, feeToken: verdict.token.symbol, fee: verdict.amount.toString() },
          'charged operation: fee leg verified',
        );
      }

      /**
       * A free send takes one of the sender's free actions now, before anything is spent
       * for it, in one transaction with the count (`reserveFreeAction`). The wrapper marks it
       * used once the operation reaches a bundler, and releases it on every other exit. A
       * concurrent send that took the last one leaves this one charged, so it is refused
       * exactly as if the ledger had said so when it was read above.
       */
      if (isSend && !exempt && !charged) {
        const reserved = db.reserveFreeAction({
          address: senderAddress,
          purpose: inferPurpose(split.actions),
          limit: FREE_ACTIONS_PER_DAY,
          now: now(),
        });
        if (!reserved.ok) {
          return chargeReply(
            await owedRefusal(senderAddress, freeActionsOf(db, senderAddress, now()), split.actions),
          );
        }
        track.reservationId = reserved.id;
      }

      // Every send is funded against its own SIGNED prefund: exactly it on the charged path
      // (F1), and never short of it on either path (the `#fund` fail-safe).
      //
      // A withdraw, a send or a cancel (`exempt`) is funded on the 'exempt' scope
      // (2026-09-25 rebuild, bounded the same day after security review finding 1),
      // its own carved pool on its own ledger — and since B2d, that pool's edge is a
      // bound on SPONSORSHIP only: past it, the action falls through to the account's
      // own MON (`ownMon`, no top-up at all) and then to a charged fee leg
      // (`exemptCharged`, the fee-paid scope with all of D172's backstops), so the
      // pool bounds what the relayer advances, never whether the user can act.
      //
      // On the own-MON lane `ensure` is not asked at all: the EntryPoint draws the
      // prefund from the account's balance (verified 2026-09-25), the relayer pays
      // nothing and reserves nothing, and an AA21 lost to a balance race reads back
      // through `prefundRefusal` as the one gas sentence.
      // D201 widened `sendFirst` (R9, 2026-10-07) from the sponsored lane alone to the
      // charged lane too: the deposit already covering the signed prefund means nothing
      // to top up either way, charged or not — only a top-up that IS needed cares which
      // ledger pays for it. Still excluded: pure 'exempt' (D172's backstop below is
      // unaffected, and the owner scoped this to the charged lane only).
      const fundingBudgetScope = exemptCharged ? 'fee-paid' : exempt ? 'exempt' : charged ? 'fee-paid' : 'sponsored';
      const funding = ownMon
        ? {
            kind: 'forward-without-top-up' as const,
            refusal: {
              message: gasRefusalMessage(freeActions.remaining),
              data: { reason: 'FREE_ACTIONS_USED' as const, choices: liveGasChoices(senderAddress) },
            },
          }
        : await prefund.ensure(senderAddress, {
        // A charged estimate is never funded: its fee leg is not priced until the send,
        // and the all-addresses-only budget is for a fee that has been verified. An
        // exempt estimate is never funded either (security review finding 1): funding an
        // unsigned-intent estimate paid a top-up for an operation that never has to run
        // or land, which a stream of fresh addresses used to draw MON for free. Only a
        // real send, with its own signed nonce proven next, is funded.
        // R9 (2026-10-07): nor is an estimate this relayer answers itself (`plan`): it
        // checks no deposit, so funding it only made the action wait on a top-up during
        // its estimate. The send funds itself, after the action when it can (`sendFirst`).
        ...(prove && !((charged || exempt) && !isSend) && !(plan && !isSend) ? { prove } : {}),
        ...(isSend && fundingBudgetScope !== 'exempt' ? { sendFirst: true } : {}),
        // The exempt scope's backstop (D191): the operation, by hash and nonce.
        ...(exempt && !exemptCharged && isSend && signature.ok
          ? { exemptOp: { userOpHash: signature.hash, nonce: signature.nonce } }
          : {}),
        purpose: exemptCharged || !exempt ? inferPurpose(split.actions) : EXEMPT_PURPOSE,
        budgetScope: fundingBudgetScope,
        ...(ownPrefund !== undefined ? { requiredPrefund: ownPrefund } : {}),
        ...(knownDeposit !== undefined ? { deposit: knownDeposit } : {}),
        // Any send's top-up, charged or free, is paid only if the deposit and the bundle,
        // simulated together two minutes ahead, show the operation running (independent
        // review, 2026-09-24). Needs an account this relayer can simulate: delegated, no
        // first-operation authorization, which is what `innerGas` being known means. A
        // charged send always is (it is refused above without a fresh plan); a free first
        // operation is not, and is funded on the per-address budgets as before.
        ...(isSend && signature.ok && innerGas !== undefined && !firstOperation
          ? {
              verifyRun: (topUp: bigint, payer: Address) =>
                simulateFundedRun({
                  client,
                  relayer: payer,
                  op: op08,
                  userOpHash: signature.hash,
                  topUp,
                  nowSeconds: Math.floor(now() / 1000),
                }),
            }
          : {}),
        // The durable backstop records which operation a charged top-up is for (D172).
        ...(charged && isSend && signature.ok ? { feePaidOp: { userOpHash: signature.hash } } : {}),
      });
      if (funding.kind === 'unproven' && isSend) {
        // Signed, so what failed is the nonce: a replay of an operation already used.
        return rpcErr(-32602, 'the operation does not carry this account’s next nonce');
      }
      if (funding.kind === 'would-fail') {
        return reply.send({
          jsonrpc: '2.0',
          id: body.id ?? null,
          error: { code: -32521, message: operationWouldFailMessage(funding.reason) },
        });
      }
      // A refused top-up is a bound on sponsorship, not on the action (B2d): when the
      // batch carries no fee leg and the account's own MON covers the shortfall, the
      // operation forwards unfunded and the EntryPoint draws the prefund from the
      // account itself — the refusal is kept only so a lost balance race reads back as
      // the one gas sentence. A batch that DOES carry a fee leg is already paying the
      // relayer; forwarding it self-funded on top would charge the user twice, so
      // there the refusal stands (D172's own backstops among them, untouched), with
      // any budget wording converted to the one sentence and its choices.
      if (funding.kind === 'refused') {
        if (ownMonCovers && !split.feeLeg) {
          prefundRefusal = convertBudgetRefusal(funding.refusal, senderAddress);
        } else if (exempt && !exemptCharged && isExemptBackstopRefusal(funding.refusal)) {
          // The exempt backstop bounds sponsorship, not the action (B2d; security review of
          // D191, finding 4): the refusal names the live ways forward, as a budget does.
          const freeRemaining = freeActionsOf(db, senderAddress, now()).remaining;
          app.log.info(
            { sender: senderAddress, budget: 'exempt-backstop', freeRemaining },
            'gas fall-through: exempt backstop refused a top-up',
          );
          return refusalReply({
            message: gasRefusalMessage(freeRemaining),
            data: { reason: 'FREE_ACTIONS_USED', choices: liveGasChoices(senderAddress) },
          });
        } else {
          return refusalReply(convertBudgetRefusal(funding.refusal, senderAddress));
        }
      } else if (funding.kind === 'forward-without-top-up') {
        prefundRefusal = convertBudgetRefusal(funding.refusal, senderAddress);
      }
      if (isSend) mark('funding', { funding: funding.kind });
      // 'not-needed', 'funded' and 'unproven' forward as they are. An unproven estimate
      // for a thin deposit meets the bundler's own prefund check, exactly as it would
      // have without this relayer, and nothing here paid for it.

      if (plan) {
        return reply.send({
          jsonrpc: '2.0',
          id: body.id ?? null,
          result: {
            preVerificationGas: toHex(plan.preVerificationGas),
            verificationGasLimit: toHex(plan.verificationGasLimit),
            callGasLimit: toHex(plan.callGasLimit),
          },
        });
      }

      /**
       * Part B: send it ourselves, as `handleOps` from the relayer key, when everything
       * above passed: the policy, the caps, the sender's signature, the funding decision,
       * and the chain's answer on the call. Anything `SelfBundler` declines goes to Pimlico
       * below, unchanged. A revert it finds in simulation is the chain's answer, as above.
       *
       * `submitted` arrives as soon as the node has taken the bundle, before it is mined,
       * the same moment Pimlico would answer. The browser then asks for the receipt with
       * `eth_getUserOperationReceipt`, answered below from `receiptFor`.
       */
      if (isSend && signature.ok && innerGas !== undefined && selfBundler.enabled) {
        const outcome = await selfBundler.submit(
          {
            op: op08,
            userOpHash: signature.hash,
            sender: senderAddress,
            purpose: inferPurpose(split.actions),
            sponsored: !charged && !exempt,
          },
          { ...(bundlePrefetch ? { prefetch: bundlePrefetch } : {}), mark },
        );
        if (outcome.kind === 'submitted') {
          track.handedToBundler = true;
          logTiming('self', outcome.userOpHash);
          return reply.send({ jsonrpc: '2.0', id: body.id ?? null, result: outcome.userOpHash });
        }
        if (outcome.kind === 'fallback') mark('self-declined', { declined: outcome.reason });
        if (outcome.kind === 'refused') {
          return reply.send({
            jsonrpc: '2.0',
            id: body.id ?? null,
            error: {
              code: -32521,
              message: outcome.message,
              ...(outcome.revertData ? { data: outcome.revertData } : {}),
            },
          });
        }
      }

      // Forward exactly what was verified (F4). The schema strips anything it does not
      // name, so what reaches the bundler is the operation whose signature was checked,
      // not the raw object it was parsed from. The entry point and any state override
      // are passed through unchanged.
      forwardParams = [op08, ...(body.params ?? []).slice(1)];
    }

    // An operation this relayer bundled itself is not in Pimlico's records, so its receipt
    // is answered here, in Pimlico's shape. Anything else is asked of Pimlico as before.
    if (body.method === 'eth_getUserOperationReceipt') {
      const hash = body.params?.[0];
      if (typeof hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(hash)) {
        const local = await selfBundler.receiptFor(hash as Hex);
        if (local !== undefined) {
          return reply.send({ jsonrpc: '2.0', id: body.id ?? null, result: local });
        }
      }
    }

    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id: body.id ?? 1,
      method: body.method,
      params: forwardParams ?? body.params ?? [],
    });
    const answer = options.bundlerUpstream
      ? await options.bundlerUpstream(payload)
      : await (
          await fetch(pimlicoUrl(addresses.chainId, apiKey), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: payload,
          })
        ).text();

    // A free action is used once Pimlico has taken the operation: it answered with a hash.
    if (track.reservationId !== undefined) track.handedToBundler = bundlerAccepted(answer);
    if (body.method === 'eth_sendUserOperation') {
      mark('pimlico-answered');
      logTiming('pimlico');
    }

    // Forwarded unfunded because no top-up was possible, and the bundler says the
    // deposit could not pay: then the reason is ours, and the user gets it in our words
    // (and, for a used-up allowance, stops at "Checking" rather than seeing AA21).
    if (prefundRefusal && isPrefundFailure(answer)) return refusalReply(prefundRefusal);
    return reply.type('application/json').send(answer);
  }

  /** Did the bundler take the operation: a JSON-RPC answer with a result and no error. */
  function bundlerAccepted(answer: string): boolean {
    try {
      const parsed = JSON.parse(answer) as { result?: unknown; error?: unknown };
      return parsed.error === undefined && typeof parsed.result === 'string';
    } catch {
      return false;
    }
  }

  /**
   * `POST /v1/gas/quote` — what one action will cost its sender, before it is signed.
   *
   * Read-only: it spends nothing and reserves nothing. It answers from the relayer's own
   * ledger (free actions) and, for a charged action, from the chain: the trading balance,
   * the base fee and the MON/USDC mid. That pricing is remembered for this sender for
   * `FEE_PRICING_TTL_MS`, and it is what the send is checked against. A later quote
   * replaces it.
   *
   * Given the fee pair the client will sign, it also simulates the action with its fee leg
   * appended, plans the gas exactly as the estimate would, and answers the exact fee, the
   * exact two calls to append, and the three gas limits to sign. Signed with those limits
   * and that fee pair, the send's own recomputation gives the same fee.
   */
  app.post('/v1/gas/quote', async (req, reply) => {
    const body = gasQuoteBodySchema.parse(req.body);
    const sender = getAddress(body.sender);
    // Per network only. A quote is a read that spends nothing, and `sender` is not
    // authenticated here: a per-address bucket would let anyone use up a victim's quotes
    // and so block every paid action the victim tried for the rest of the hour.
    if (db.hitRateLimit(clientIp(req), 'quote', config.rateLimitPerIpHour, now())) {
      throw new Rejection('RATE_LIMITED', 'too many fee quotes from this network this hour', 429);
    }
    const marginAccount = addresses.kuru.marginAccount;
    if (!marginAccount) {
      throw new Rejection('TARGET_NOT_ALLOWED', `no MarginAccount known for ${mode}`, 503);
    }

    const actions: SponsoredCall[] = body.calls.map((c) => ({
      to: getAddress(c.to),
      data: c.data as Hex,
      value: c.value === undefined ? 0n : BigInt(c.value),
    }));
    try {
      if (feeRecipient && splitFeeLeg(actions, marginAccount, feeRecipient).feeLeg) {
        throw new PolicyViolation(
          'FEE_LEG_MISMATCH',
          'a quote is for the action alone; the relayer builds the fee leg',
        );
      }
      assertSponsorable(actions, {
        marginAccount,
        permitTokens: sponsoredPermitTokens,
        markets: [AUSD_USDC_MARKET],
        sender,
        ...gasFeeContext('none'),
      });
    } catch (error) {
      if (error instanceof PolicyViolation) {
        const code =
          error.reason === 'EMPTY_BATCH'
            ? 'BAD_REQUEST'
            : error.reason === 'FEE_LEG_MISMATCH' ||
                error.reason === 'TARGET_NOT_ALLOWED' ||
                error.reason === 'SELECTOR_NOT_ALLOWED' ||
                error.reason === 'VALUE_NOT_ZERO' ||
                error.reason === 'CAP_EXCEEDED'
              ? error.reason
              : 'BAD_REQUEST';
        throw new Rejection(code, error.message, error.reason === 'CAP_EXCEEDED' ? 403 : 400);
      }
      throw error;
    }

    const t = now();
    const freeActions = freeActionsOf(db, sender, t);
    const base = { sender, freeActions: freeActionsBody(freeActions) };

    // Sends, withdraws, cancels (F3) and swaps into MON (B3): never counted, never
    // charged — and sponsored while the exempt pool has room. Past the pool's edge
    // (B2d) the pool bounds sponsorship only: the quote falls through to the same
    // chain as every other action, the account's own MON and then the fee.
    const exemption = exemptionOf(actions, marginAccount);
    if (exemption) {
      // Sponsored only while the pool can still pay THIS operation's top-up — the same
      // arithmetic `ensure` will apply, so a quote never says 'sponsored' for a send
      // `ensure` would refuse (a remainder smaller than one top-up used to do exactly
      // that). When the plan cannot be computed, the top-up unit alone is the bar.
      // Conservative on purpose: near the pool's edge an operation whose deposit would
      // have covered it is steered to the fee lane a step early rather than ever
      // quoting a lane the send cannot deliver.
      const remaining = prefund.scopeRemaining(sender, 'exempt');
      if (remaining >= ENTRYPOINT_TOPUP_WEI) {
        const planned = await quotePrefundWei(sender, actions, body.maxFeePerGas);
        // The exempt backstop's two rules, read-only (security review of D191, finding
        // 4): a send they would refuse is steered to the next lane, never quoted sponsored.
        if (
          (planned === undefined || remaining >= planned) &&
          !(await prefund.exemptBackstopBlocks(sender, planned))
        ) {
          return reply.send({ ...base, charge: 'sponsored', reason: exemption });
        }
      }
    }
    // F4: free actions remain, but the account's own budget may still stop this one.
    // An exempt action never draws a free action, so the free tier is not its lane.
    let budgetRefusal: Refusal | undefined;
    // The hour every address shares, spent while this operation still needs a top-up:
    // no lane the relayer advances MON for can carry it (the fee lane draws the same
    // hour), so only the account's own MON can (owner item 2, 2026-09-29).
    let sharedHourSpent = false;
    if (!exemption && freeActions.remaining > 0) {
      budgetRefusal = await quoteBudgetRefusal(
        sender,
        actions,
        body.maxFeePerGas !== undefined ? body.maxFeePerGas : undefined,
      );
      if (!budgetRefusal) {
        sharedHourSpent = await quoteSharedHourSpent(sender, actions, body.maxFeePerGas);
        if (!sharedHourSpent) {
          return reply.send({ ...base, charge: 'sponsored', reason: 'free-action' });
        }
      }
    }
    const reached = sharedHourSpent
      ? 'shared-hour'
      : budgetReached(!exemption && freeActions.remaining === 0, budgetRefusal, exemption !== undefined);
    app.log.info(
      { sender, budget: reached, freeRemaining: freeActions.remaining },
      'gas quote fall-through: budget reached',
    );
    // B2a: the account's own MON, before the trading balance. Answered with the real
    // figures so the screen can say "about 0.07 MON from your wallet (balance 12.40
    // MON, 10 MON must stay)" — read, never guessed.
    const ownMonBody = await quoteOwnMon(sender, actions, body.maxFeePerGas);
    if (ownMonBody) {
      return reply.send({ ...base, charge: 'own-mon', reason: 'own-mon', ownMon: ownMonBody });
    }
    const cause: GasChargeCause =
      budgetRefusal || exemption ? 'sponsorship-budget-used' : 'free-actions-used';
    const budgetBody =
      budgetRefusal?.data && 'resetsAt' in budgetRefusal.data
        ? { sponsorshipResetsAt: budgetRefusal.data.resetsAt }
        : {};
    // "Free actions for today are used" only when the free tier is really at 0.
    const cannotPayMessage = gasRefusalMessage(freeActions.remaining);
    if (sharedHourSpent) {
      return reply.send({
        ...base,
        charge: 'refused',
        reason: 'no-trading-balance',
        message: cannotPayMessage,
        choices: liveGasChoices(sender),
      });
    }
    if (!feeRecipient) {
      const owed = await owedRefusal(sender, freeActions, actions);
      return reply.send({ ...base, charge: 'refused', reason: 'not-charging', message: owed.message });
    }

    const [margin, pricing] = await Promise.all([
      readMarginDollars(client, marginAccount, sender),
      readFeePricing(client, capPriceReader),
    ]);
    if (!margin || !pricing) {
      return reply.send({ ...base, charge: 'refused', reason: 'unpriced', message: GAS_FEE_UNPRICED_MESSAGE });
    }
    // What the batch deposits first counts: "add funds" is itself an action.
    const balances = withBatchDeposits(margin, actions, marginAccount, sender);
    // The least a fee can be. Below it in both tokens, nothing can pay.
    const payable = gasFeeTokenFor(balances, GAS_FEE_MINIMUM);
    if (!payable) {
      // The quote-level refusal names its live choices too (D182 residual R2): the
      // browser quotes before it sends, so this is the refusal users actually meet.
      return reply.send({
        ...base,
        ...budgetBody,
        charge: 'refused',
        reason: 'no-trading-balance',
        message: cannotPayMessage,
        choices: liveGasChoices(sender),
      });
    }
    const recorded = feePricings.record(pricing, t);
    const pricingBody = {
      baseFeePerGas: recorded.baseFeePerGas.toString(),
      monUsdMid: recorded.monUsdMid.toString(),
      quotedAt: recorded.quotedAt,
      expiresAt: recorded.expiresAt,
    };
    const feeBase = {
      recipient: feeRecipient,
      decimals: 6,
      minimum: GAS_FEE_MINIMUM.toString(),
      step: GAS_FEE_STEP.toString(),
      marginPct: Number(((GAS_FEE_MARGIN.numerator - GAS_FEE_MARGIN.denominator) * 100n) / GAS_FEE_MARGIN.denominator),
      pricing: pricingBody,
    };

    const exact =
      body.maxFeePerGas !== undefined && body.maxPriorityFeePerGas !== undefined
        ? await priceExactly({
            sender,
            actions,
            marginAccount,
            recipient: feeRecipient,
            balances,
            firstToken: payable.asset,
            maxFeePerGas: body.maxFeePerGas,
            maxPriorityFeePerGas: body.maxPriorityFeePerGas,
            pricing: recorded,
          })
        : undefined;

    if (exact?.kind === 'cannot-pay') {
      return reply.send({
        ...base,
        ...budgetBody,
        charge: 'refused',
        reason: 'no-trading-balance',
        message: cannotPayMessage,
        choices: liveGasChoices(sender),
      });
    }
    if (exact?.kind === 'priced') {
      const token = GAS_FEE_TOKENS.find((v) => v.asset === exact.token)!;
      return reply.send({
        ...base,
        ...budgetBody,
        charge: 'fee',
        reason: cause,
        fee: {
          ...feeBase,
          token: token.asset,
          symbol: token.symbol,
          amount: exact.amount.toString(),
          calls: exact.calls.map((c) => ({ to: c.to, data: c.data })),
          gas: {
            callGasLimit: toHex(exact.plan.callGasLimit),
            verificationGasLimit: toHex(exact.plan.verificationGasLimit),
            preVerificationGas: toHex(exact.plan.preVerificationGas),
          },
          maxFeePerGas: toHex(body.maxFeePerGas!),
          maxPriorityFeePerGas: toHex(body.maxPriorityFeePerGas!),
        },
      });
    }
    // Priced, but not to the unit: no fee pair was given, or the action could not be
    // simulated here. The client prices it itself from `pricing` with `operationGasFee`.
    const token = GAS_FEE_TOKENS.find((v) => v.asset === payable.asset)!;
    return reply.send({
      ...base,
      ...budgetBody,
      charge: 'fee',
      reason: cause,
      fee: {
        ...feeBase,
        token: token.asset,
        symbol: token.symbol,
        ...(exact?.kind === 'unsimulated' ? { unsimulated: exact.reason } : {}),
      },
    });
  });

  /**
   * F4 for a quote: would the free path's own-budget refusal stop this action? The same
   * `addressBudgetBlocks` the send uses, fed the prefund the estimate would give the
   * action alone. The ledger is read first, so an account with budget left costs no chain
   * read. Without a fee pair, or with no delegated account to simulate against, the prefund
   * is unknown and only an empty deposit counts as blocked, exactly as on the send path.
   */
  async function quoteBudgetRefusal(
    sender: Address,
    actions: readonly SponsoredCall[],
    maxFeePerGas: bigint | undefined,
  ): Promise<Refusal | undefined> {
    const t = now();
    const h = prefundHeadroom(db.prefundUsage(sender, t), budgets, t);
    const addressSpent = h.detail.addressDayLeft === 0n || h.detail.addressHourLeft === 0n;
    if (!addressSpent || h.detail.allAddressesHourLeft === 0n) return undefined;
    const prefundWei = await quotePrefundWei(sender, actions, maxFeePerGas);
    return prefund.addressBudgetBlocks(sender, {
      ...(prefundWei !== undefined ? { requiredPrefund: prefundWei } : {}),
    });
  }

  /**
   * Is the sponsored lane closed by the shared hour for this operation? True when that
   * hour has nothing left and the account's deposit cannot run the operation on its own.
   * Read-only. The same carved ceiling `ensure` checks for the 'sponsored' scope.
   */
  async function quoteSharedHourSpent(
    sender: Address,
    actions: readonly SponsoredCall[],
    maxFeePerGas: bigint | undefined,
  ): Promise<boolean> {
    const t = now();
    const h = prefundHeadroom(db.prefundUsage(sender, t), budgetsFor(budgets, 'sponsored'), t);
    if (h.detail.allAddressesHourLeft > 0n) return false;
    const [prefundWei, deposit] = await Promise.all([
      quotePrefundWei(sender, actions, maxFeePerGas),
      readEntryPointDeposit(client, sender).then(
        (s) => s.deposit,
        () => 0n,
      ),
    ]);
    return deposit < depositNeeded(prefundWei);
  }

  /**
   * The prefund this batch would need, planned exactly as the estimate would plan it:
   * the account's own inner call simulated, the gas envelope from the same
   * `planUserOperationGas`, at the caller's max fee. Undefined when the account is not
   * yet delegated, the caller named no fee, or the inner call cannot be simulated —
   * every lane that needs the figure simply is not offered then, never guessed.
   */
  async function quotePrefundWei(
    sender: Address,
    actions: readonly SponsoredCall[],
    maxFeePerGas: bigint | undefined,
  ): Promise<bigint | undefined> {
    if (maxFeePerGas === undefined || !(await isSimple7702(client, sender))) return undefined;
    const callData = encodeAccountCalls(actions);
    const inner = await simulateInnerCall(client, sender, callData);
    if (inner.kind !== 'ok') return undefined;
    const planned = planUserOperationGas({
      innerEstimate: inner.gas,
      callCount: actions.length,
      callDataBytes: BigInt((callData.length - 2) / 2),
    });
    return planned.ok ? requiredPrefund({ ...planned.plan, maxFeePerGas }) : undefined;
  }

  /**
   * The own-MON lane, at quote time (B2a; both underlying facts verified on mainnet,
   * 2026-09-25): the EntryPoint draws the prefund's shortfall over the deposit from
   * the account's own balance, and Monad's delegated reserve is judged on the whole
   * transaction's ending balance. The lane is offered on the owner's rule to the
   * letter: the wallet holds the reserve plus the operation's whole prefund. A deposit
   * that already covers the prefund is not this lane — `ensure` answers not-needed
   * there and the action needs no funding decision at all.
   */
  async function quoteOwnMon(
    sender: Address,
    actions: readonly SponsoredCall[],
    maxFeePerGas: bigint | undefined,
  ): Promise<
    { gasWei: string; balanceWei: string; reserveWei: string; depositWei: string } | undefined
  > {
    const prefundWei = await quotePrefundWei(sender, actions, maxFeePerGas);
    if (prefundWei === undefined) return undefined;
    const [deposit, balance] = await Promise.all([
      readEntryPointDeposit(client, sender).then(
        (state) => state.deposit,
        () => undefined,
      ),
      client.getBalance({ address: sender }).then(
        (b) => b,
        () => undefined,
      ),
    ]);
    if (balance === undefined) return undefined;
    const shortfall = prefundWei > (deposit ?? 0n) ? prefundWei - (deposit ?? 0n) : 0n;
    // The owner's rule to the letter: the wallet holds the reserve plus the whole
    // prefund, though the EntryPoint will only draw the shortfall. A deposit that
    // already covers the prefund needs no lane and no fee at all — but that state is
    // decided by `ensure`, not quoted here.
    if (shortfall === 0n) return undefined;
    if (balance < MONAD_DELEGATED_RESERVE_WEI + prefundWei + nativeValueSpent(actions)) return undefined;
    return {
      gasWei: shortfall.toString(),
      balanceWei: balance.toString(),
      reserveWei: MONAD_DELEGATED_RESERVE_WEI.toString(),
      depositWei: (deposit ?? 0n).toString(),
    };
  }

  /**
   * The call data `toSimple7702SmartAccount.encodeCalls` builds: `execute` for one call,
   * `executeBatch` for more. The same bytes, so the same plan as the estimate would give.
   */
  function encodeAccountCalls(calls: readonly SponsoredCall[]): Hex {
    if (calls.length === 1) {
      const [call] = calls;
      return encodeFunctionData({
        abi: [
          {
            type: 'function',
            name: 'execute',
            stateMutability: 'payable',
            inputs: [
              { name: 'target', type: 'address' },
              { name: 'value', type: 'uint256' },
              { name: 'data', type: 'bytes' },
            ],
            outputs: [],
          },
        ],
        functionName: 'execute',
        args: [call!.to, call!.value ?? 0n, call!.data],
      });
    }
    return encodeExecuteBatch(calls);
  }

  /** The encoding `Simple7702Account.executeBatch` takes, and `decodeExecuteBatch` reads. */
  function encodeExecuteBatch(calls: readonly SponsoredCall[]): Hex {
    return encodeFunctionData({
      abi: [
        {
          type: 'function',
          name: 'executeBatch',
          stateMutability: 'payable',
          inputs: [
            {
              name: 'calls',
              type: 'tuple[]',
              components: [
                { name: 'target', type: 'address' },
                { name: 'value', type: 'uint256' },
                { name: 'data', type: 'bytes' },
              ],
            },
          ],
          outputs: [],
        },
      ],
      functionName: 'executeBatch',
      args: [calls.map((c) => ({ target: c.to, value: c.value ?? 0n, data: c.data }))],
    });
  }

  /**
   * The exact fee for an action at a fee pair: simulate the action with its fee leg
   * appended, plan its gas the way the estimate does, and price those limits. The token is
   * re-chosen from the fee and the batch re-simulated if it changed, at most once more.
   * The amount in the simulated leg does not change the plan's inputs (same length), and
   * the fee is always the pricing of the limits returned, which is what the send checks.
   */
  async function priceExactly(input: {
    sender: Address;
    actions: readonly SponsoredCall[];
    marginAccount: Address;
    recipient: Address;
    balances: { USDC: bigint; AUSD: bigint };
    firstToken: Address;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
    pricing: { baseFeePerGas: bigint; monUsdMid: bigint };
  }): Promise<
    | { kind: 'priced'; token: Address; amount: bigint; plan: GasPlan; calls: readonly SponsoredCall[] }
    | { kind: 'cannot-pay' }
    | { kind: 'unsimulated'; reason: string }
  > {
    if (!(await isSimple7702(client, input.sender))) {
      return { kind: 'unsimulated', reason: 'the account is not delegated yet' };
    }
    let token = input.firstToken;
    let amount = GAS_FEE_MINIMUM;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const leg = buildFeeLeg(input.marginAccount, token, input.recipient, amount);
      const all = [...input.actions, ...leg];
      const callData = encodeExecuteBatch(all);
      const inner = await simulateInnerCall(client, input.sender, callData);
      if (inner.kind !== 'ok') {
        return {
          kind: 'unsimulated',
          reason: inner.kind === 'reverted' ? inner.message : inner.reason,
        };
      }
      const planned = planUserOperationGas({
        innerEstimate: inner.gas,
        callCount: all.length,
        callDataBytes: BigInt((callData.length - 2) / 2),
      });
      if (!planned.ok) return { kind: 'unsimulated', reason: planned.reason };
      const fee = operationGasFee(
        {
          ...planned.plan,
          maxFeePerGas: input.maxFeePerGas,
          maxPriorityFeePerGas: input.maxPriorityFeePerGas,
        },
        input.pricing,
      );
      if (fee === undefined || fee > MAX_GAS_FEE) {
        return { kind: 'unsimulated', reason: 'the fee is above what one action may be charged' };
      }
      const chosen = gasFeeTokenFor(input.balances, fee);
      if (!chosen) return { kind: 'cannot-pay' };
      if (chosen.asset === token) {
        return {
          kind: 'priced',
          token,
          amount: fee,
          plan: planned.plan,
          calls: buildFeeLeg(input.marginAccount, token, input.recipient, fee),
        };
      }
      token = chosen.asset;
      amount = fee;
    }
    return { kind: 'unsimulated', reason: 'the fee token could not be settled' };
  }

  /**
   * `GET /v1/gas/allowance?address=` — an account's free actions, from the ledger alone.
   * No chain read, so a banner can ask for it with every balance refresh.
   */
  app.get<{ Querystring: { address?: string } }>('/v1/gas/allowance', async (req, reply) => {
    const raw = req.query.address ?? '';
    if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
      throw new Rejection('BAD_REQUEST', 'address must be 0x + 40 hex characters', 400);
    }
    // Its own bucket, the size of the metrics one, so a polling banner never eats the
    // allowance that protects submission.
    if (db.hitRateLimit(clientIp(req), 'allowance', 3600, now())) {
      throw new Rejection('RATE_LIMITED', 'too many allowance reads from this network', 429);
    }
    const address = getAddress(raw);
    const freeActions = freeActionsOf(db, address, now());
    return reply.send({
      address,
      freeActions: freeActionsBody(freeActions),
      charging: feeRecipient !== undefined,
      fee: {
        tokens: GAS_FEE_TOKENS.map((t) => t.symbol),
        decimals: 6,
        minimum: GAS_FEE_MINIMUM.toString(),
        step: GAS_FEE_STEP.toString(),
      },
    });
  });

  app.get('/v1/metrics', async (req, reply) => {
    // Gate it. Unauthenticated, this is a synchronous SQLite read on the event loop
    // that anyone reachable can hold down, and node:sqlite blocks — so a scrape
    // flood stalls /v1/forward alongside it. A bearer token when one is configured;
    // otherwise loopback only, which is the shape a Prometheus sidecar actually uses.
    const metricsToken = config.metricsToken;
    if (metricsToken) {
      const offered = (req.headers.authorization ?? '').replace(/^Bearer /i, '');
      if (!constantTimeEquals(offered, metricsToken)) {
        throw new Rejection('UNAUTHORIZED', 'metrics requires a bearer token', 401);
      }
    } else if (!isLoopback(req.socket.remoteAddress)) {
      // Deliberately `req.socket.remoteAddress`, NOT `req.ip`. The per-IP limiter is
      // already wrong behind a reverse proxy — every user collapses into one bucket —
      // and the natural fix for that is `trustProxy: true`. The moment anyone sets it,
      // `req.ip` becomes attacker-controlled and `X-Forwarded-For: 127.0.0.1` would
      // open this endpoint to the internet. The socket address is never rewritten, so
      // authentication and rate limiting stay independent concerns.
      throw new Rejection(
        'UNAUTHORIZED',
        'metrics is loopback-only unless RELAYER_METRICS_TOKEN is set',
        403,
      );
    }
    // Its own bucket, generous enough for a real scraper. Sharing the per-IP budget
    // meant a default 15s Prometheus interval ate 80% of the allowance that protects
    // /v1/forward, and a 10s interval tripped the limit and took the endpoint down for
    // the last ~17 minutes of every hour — a float series that disappears for a third
    // of each hour is exactly the silent alert this endpoint exists to prevent.
    if (db.hitRateLimit(req.socket.remoteAddress ?? 'unknown', 'metrics', 3600, now())) {
      throw new Rejection('RATE_LIMITED', 'too many metrics scrapes from this address', 429);
    }

    const m = db.metrics(now());
    const lines: string[] = [];
    const push = (name: string, help: string, type: string, samples: string[]) => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...samples);
    };
    // Escape at the render point rather than trusting every current writer. `purpose`
    // is a closed zod enum today, but RelayerDb.recordRelay takes a plain string, so
    // one new writer could otherwise forge an entire extra series — a fake
    // `relayer_can_submit 1` reads on a dashboard as "the relayer is armed".
    // Escaping stops injection; it does nothing about cardinality. If a future writer
    // ever put something high-cardinality in `purpose`, the GROUP BY would return
    // unboundedly many rows and the response body would grow without bound — a bomb
    // for whatever scrapes it. So collapse anything outside the known sets to "other".
    const KNOWN_PURPOSES = new Set(['order', 'cancel', 'deposit', 'withdraw']);
    // From RELAY_STATUSES, not hand-copied. The hand-copied version had already
    // drifted: it listed 'submitted' and 'mined' (written by nothing) and omitted
    // 'success' (what the submit path writes), so once the gate opened every
    // successful relay would have been bucketed as "other".
    const KNOWN_STATUSES = new Set<string>(RELAY_STATUSES);
    const bounded = (v: string, known: Set<string>) => (known.has(v) ? v : 'other');
    const label = (v: string) =>
      v
        .split(BACKSLASH)
        .join(BACKSLASH + BACKSLASH)
        .split(DQUOTE)
        .join(BACKSLASH + DQUOTE)
        .split(LINEFEED)
        .join(BACKSLASH + 'n');

    push(
      'relayer_relays_total',
      'Relay attempts by terminal status.',
      'counter',
      m.relaysByStatus.map(
        (r) =>
          `relayer_relays_total{status="${label(bounded(r.status, KNOWN_STATUSES))}"} ${r.count}`,
      ),
    );
    push(
      'relayer_relays_by_purpose_total',
      'Relay attempts by purpose.',
      'counter',
      m.relaysByPurpose.map(
        (r) =>
          `relayer_relays_by_purpose_total{purpose="${label(bounded(r.purpose, KNOWN_PURPOSES))}"} ${r.count}`,
      ),
    );
    push('relayer_pending', 'Relays submitted but not yet mined.', 'gauge', [
      `relayer_pending ${db.pendingCount()}`,
    ]);
    push('relayer_mon_spent_wei_total', 'MON spent on gas, in wei.', 'counter', [
      `relayer_mon_spent_wei_total ${m.monSpentTotalWei}`,
    ]);
    push(
      'relayer_entrypoint_topup_wei_total',
      'EntryPoint deposit top-ups paid, in wei.',
      'counter',
      [`relayer_entrypoint_topup_wei_total ${m.topupTotalWei}`],
    );
    push('relayer_topup_addresses', 'Addresses that have ever been topped up.', 'gauge', [
      `relayer_topup_addresses ${m.topupAddresses}`,
    ]);
    push(
      'relayer_rate_limited_subjects',
      'Subjects with a rate-limit counter in the current hour.',
      'gauge',
      [`relayer_rate_limited_subjects ${m.rateLimitedSubjects}`],
    );
    push('relayer_float_cap_wei', 'Hard float cap from code (env may only tighten it).', 'gauge', [
      `relayer_float_cap_wei ${MAX_RELAYER_FLOAT_WEI}`,
    ]);

    // Read the float here rather than depending on something else having polled
    // /v1/health. It is an eth_call and costs no gas, so rule A6's ban on
    // fixed-cadence timers that spend money does not apply.
    //
    // These are emitted ALWAYS, including when the read failed. A Prometheus alert
    // over an absent series returns empty and never fires, so a conditionally-emitted
    // gauge is a silent alert — which is the exact failure this endpoint exists to
    // remove. `relayer_float_known 0` is itself the thing to alert on.
    const live = await readFloat();
    push('relayer_float_known', '1 when the float could be read at all.', 'gauge', [
      `relayer_float_known ${live.known ? 1 : 0}`,
    ]);
    push('relayer_float_wei', 'Relayer MON balance, in wei.', 'gauge', [
      `relayer_float_wei ${live.balance}`,
    ]);
    // No `live.known &&` guard: an unreadable float must look the SAME here as it does
    // on /v1/health, which reports belowAlert true when it cannot tell. Guarding it
    // made health fail loud and metrics fail quiet about the identical condition, so
    // an RPC outage left the Prometheus alert green while health said the float was
    // low. Fail loud in both, and let relayer_float_known say why.
    push(
      'relayer_float_below_alert',
      '1 when the float is under the alert fraction of the effective cap, or unknown (rule A4).',
      'gauge',
      [`relayer_float_below_alert ${live.belowAlert ? 1 : 0}`],
    );
    // relayer_float_age_ms is deliberately not emitted. `m` is read before readFloat()
    // records this scrape, so the value could only ever be the previous scrape's age —
    // it can never grow large, so a staleness alert on it could never fire, and with no
    // float ever read it would render as "perfectly fresh". relayer_float_known covers
    // the real condition honestly; a gauge that cannot mean its help text is worse than
    // no gauge.

    push(
      'relayer_can_submit',
      '1 when this relayer would actually send; 0 when it only simulates.',
      'gauge',
      [
        `relayer_can_submit ${
          GAS_LAYER_PROVEN &&
          config.hasPimlicoKey &&
          gate.runMode === 'live' &&
          gate.realFundsAcknowledged
            ? 1
            : 0
        }`,
      ],
    );

    // Newline via fromCharCode: an escape written here keeps getting rewritten by
    // the tooling that edits this file, the same reason scripts/m0-gate.ts does it.
    const NL = String.fromCharCode(10);
    return reply.type('text/plain; version=0.0.4').send(lines.join(NL) + NL);
  });

  app.get('/v1/health', async () => {
    const snapshot = allowlist.snapshot ?? (await allowlist.refresh());
    // Shared with /v1/metrics, so the two endpoints cannot report different floats.
    // `floatKnown` distinguishes "0 MON" from "we could not find out", which are very
    // different things to page someone about.
    const floatState = await readFloat();
    const floatMon = formatEther(floatState.balance);
    const floatKnown = floatState.known;
    const floatBelowAlert = floatState.belowAlert;
    const floatOverCap = floatState.overCap;

    return {
      chainId: addresses.chainId,
      mode,
      floatMon,
      floatKnown,
      floatBelowAlert,
      // D169: read live, so it stops saying true the moment the fee address moves off the
      // hot key (or the key changes). No address is returned, only whether they match:
      // true, false, or 'unknown' when the relayer cannot read its own address.
      feeAddressIsHotKey: await feeAddressIsHotKey(),
      pendingCount: db.pendingCount(),
      forwarder: addresses.kuru.forwarder ?? null,
      forwarderTrusted: {
        marginAccount: snapshot.marginAccountTrustsForwarder,
        orderBooksChecked: snapshot.orderBooksChecked,
        orderBooksTrusting: snapshot.orderBooksTrusting,
      },
      gasLayer: {
        kind: 'eip-7702',
        funding: 'entrypoint-deposit',
        paymaster: null,
        bundler: config.hasPimlicoKey ? 'pimlico' : null,
        // True when this relayer submits handleOps itself and uses Pimlico as the fallback.
        selfBundling: selfBundler.enabled,
        entryPoint: ENTRY_POINT_V08,
        delegate: SIMPLE_7702_DELEGATE,
        minDepositWei: MIN_ENTRYPOINT_DEPOSIT_WEI.toString(),
        topUpWei: ENTRYPOINT_TOPUP_WEI.toString(),
        // Rolling budgets, effective after any environment tightening. Operator-facing.
        //
        // `allAddressesHour` reports the sponsored/fee-paid share, not the whole shared
        // hour, since D178 carved exempt its own slice out of it — reading this against
        // the 5 MON figure in caps.ts's own comments without `sharedTotalAllAddressesHour`
        // would under-read the relayer's real hourly exposure by exempt's own share
        // (third review round, finding 4). `sharedTotalAllAddressesHour` is the one number
        // to compare against the relayer float and PREFUND_ACCOUNTS_PER_HOUR's own docs.
        prefundBudgetsWei: {
          perAddressDay: budgets.perAddressDay.toString(),
          perAddressHour: budgets.perAddressHour.toString(),
          allAddressesHour: nonExemptAllAddressesHour(budgets.allAddressesHour).toString(),
          sharedTotalAllAddressesHour: budgets.allAddressesHour.toString(),
          // The charged path's own per-address cap (D172): code, not configuration.
          feePaidPerAddressHour: effectiveFeePaidPerAddressHourCap().toString(),
          // The exempt (withdraw/send/cancel) scope's own bounds (D177, carved in D178).
          exemptPerAddressDay: effectiveExemptPerAddressDayCap().toString(),
          exemptPerAddressHour: effectiveExemptPerAddressHourCap(
            effectiveExemptAllAddressesHourCap(budgets.allAddressesHour),
          ).toString(),
          exemptAllAddressesHour: effectiveExemptAllAddressesHourCap(budgets.allAddressesHour).toString(),
        },
        proven: GAS_LAYER_PROVEN,
      },
      // Free actions, then gas at cost (2026-09-24). No recipient address here: a quote
      // carries it, for the one action it prices.
      gasFee: {
        freeActionsPerDay: FREE_ACTIONS_PER_DAY,
        charging: feeRecipient !== undefined,
        tokens: GAS_FEE_TOKENS.map((t) => t.symbol),
        decimals: 6,
        minimum: GAS_FEE_MINIMUM.toString(),
        step: GAS_FEE_STEP.toString(),
        max: MAX_GAS_FEE.toString(),
        marginPct: Number(
          ((GAS_FEE_MARGIN.numerator - GAS_FEE_MARGIN.denominator) * 100n) /
            GAS_FEE_MARGIN.denominator,
        ),
      },
      forwarderSchemaVerified: FORWARD_REQUEST_SCHEMA_VERIFIED,
      forwarderStatus: 'dormant — replaced by the EIP-7702 gas layer',
      runMode: gate.runMode,
      realFundsAcknowledged: gate.realFundsAcknowledged,
      floatOverCap,
      caps: {
        maxOrderNotionalAusd: MAX_ORDER_NOTIONAL_AUSD.toString(),
        maxRelayerFloatWei: MAX_RELAYER_FLOAT_WEI.toString(),
        liveMarkets: LIVE_MARKET_ALLOWLIST,
      },
      canSubmit:
        GAS_LAYER_PROVEN &&
        config.hasPimlicoKey &&
        gate.runMode === 'live' &&
        gate.realFundsAcknowledged,
      allowlistSize: snapshot.entries.length,
      allowlistBuiltAt: snapshot.builtAt,
    };
  });

  return app;
}

/**
 * Refuse to start with more MON than the cap allows.
 *
 * Checked once at boot rather than per request: it is a property of the key, not of
 * any one call, and an over-funded hot key is a larger loss if it leaks. Reporting it
 * and carrying on would be treating the owner's exposure limit as advice.
 */
async function assertStartupFloat(config: RelayerConfig): Promise<void> {
  if (config.mode !== 'mainnet') return;

  const signer = readSigningKey();
  let address: Address | undefined;
  if (signer) {
    const { privateKeyToAccount } = await import('viem/accounts');
    address = privateKeyToAccount(signer).address;
  } else {
    address = readRelayerAddress();
  }
  if (!address) return;

  const client = createChainClient({
    mode: config.mode,
    readOnly: true,
    ...(config.rpcUrl ? { rpcUrl: config.rpcUrl } : {}),
  });
  assertFloatWithinCap(await client.getBalance({ address }));
}

export async function start(): Promise<void> {
  const config = loadConfig();
  // Before any chain read: a relayer with nowhere to be paid does not start (D169).
  resolveFeeRecipient({ feeAddress: config.feeAddress, harness: false });
  await assertStartupFloat(config);
  // The live market allowlist refreshes itself in the background from here on: Kuru's
  // per-address listing plus `getMarketParams()`, never on a request path. Here and not
  // in `buildServer`, so a test-built server never reaches Kuru or the chain. Mainnet
  // only, because every candidate is a chain-143 address; elsewhere the allowlist stays
  // at its MON/USDC cold-start answer.
  if (config.mode === 'mainnet') {
    configureLiveMarkets({
      client: createChainClient({
        mode: config.mode,
        readOnly: true,
        ...(config.rpcUrl ? { rpcUrl: config.rpcUrl } : {}),
      }),
    });
  }
  const app = await buildServer({ config });
  // Loopback by default. This process holds a signing key and there is no reason for
  // it to be reachable from outside the box it runs on — the trade app is the only
  // caller, and it runs on the same host. `RELAYER_HOST` exists for the rare case
  // that changes, not as something a normal deployment should need to set.
  await app.listen({ port: config.port, host: process.env.RELAYER_HOST ?? '127.0.0.1' });
  app.log.info(
    { mode: config.mode, port: config.port, canSubmit: FORWARD_REQUEST_SCHEMA_VERIFIED },
    'relayer listening',
  );
}

if (process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js')) {
  start().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
