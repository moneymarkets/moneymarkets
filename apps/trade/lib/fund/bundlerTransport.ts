'use client';

import {
  createPublicClient,
  http,
  webSocket,
  type Address,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type Transport,
} from 'viem';
import {
  createBundlerClient,
  entryPoint08Abi,
  getUserOperationHash,
  UserOperationReceiptNotFoundError,
  type SmartAccount,
} from 'viem/account-abstraction';
import {
  BLOCK_TIME_MS,
  chainFor,
  ENTRY_POINT_V08,
  isGasChargeRefusalData,
  isSponsorshipAllowanceData,
  PROTOCOL_PAUSED_SELECTOR,
  SIMPLE_7702_DELEGATE,
  SPONSORSHIP_ALLOWANCE_USED,
  SPONSORSHIP_PAUSED_MESSAGE,
  toGaslessAccount,
  withSignedEstimates,
  type GasChargeRefusalData,
  type SponsorshipAllowanceData,
  type SubmitRequest,
  type SubmitResult,
  type SubmitStage,
  type SubmitTransport,
} from '@tradepro/core';
import { apiUrl } from '../basePath';
import { failure, failureText } from '../failures';
import { recordPerfStage } from '../perf/orderPerf';

/**
 * The submission transport — the browser half of the path `scripts/m0-live.ts` proved
 * on mainnet.
 *
 * The sequence is deliberately identical to the script's, because that sequence is the
 * one that worked and every deviation from it cost a failed attempt:
 *
 *   1. build the 7702 smart account over the user's own key (the address is the EOA)
 *   2. **sign the authorization explicitly** when the account is not yet delegated
 *   3. `sendUserOperation`
 *   4. `waitForUserOperationReceipt`
 *
 * ## Step 2 is not optional and not automatic
 *
 * Left to itself, viem fills `eip7702Auth` with a placeholder signature
 * (`r = 0xfff…`, `s = 0x7aaa…`) for gas estimation and never replaces it. The bundler
 * then rejects the operation with "The recovered signer address does not match the
 * userOperation sender address". That is exactly how M0's first live attempt failed.
 * The authorization nonce is the EOA's own transaction nonce — 0 for an account that
 * has never sent one.
 *
 * ## Where the keys are
 *
 * The user's key never leaves the browser; the Pimlico key never enters it. The
 * bundler transport points at our own `/api/submit`, which checks the mode gate and
 * the sponsor policy server-side and forwards with the key attached. A gate evaluated
 * in the browser is permanently closed — `MODE` is not a `NEXT_PUBLIC_` variable — so
 * it is not evaluated here at all.
 */

/** What `toGaslessAccount` needs: an account that can sign and authorize. */
type Owner = Parameters<typeof toGaslessAccount>[1];

/**
 * `LocalAccount` types `sign` and `signAuthorization` as optional, but the Mera
 * account is built by `mnemonicToAccount`, which always provides both. Rather than
 * cast that away, check it — if a future account type genuinely lacks them, the
 * failure should be this sentence and not a crash inside viem.
 */
function asOwner(account: LocalAccount): Owner {
  if (typeof account.sign !== 'function' || typeof account.signAuthorization !== 'function') {
    throw new Error('this account cannot sign an EIP-7702 authorization');
  }
  return account as Owner;
}

/**
 * One client per session, not one per submission.
 *
 * `cacheTime` is what earns this: viem reuses a block read and a fee read within the
 * window rather than re-fetching them, and `prepareUserOperation` asks for both on
 * every submission. Measured 2026-09-10, those two were 285 ms of a 3.1 s action, and
 * neither answer changes meaningfully inside two seconds on a 400 ms chain.
 *
 * `pollingInterval` matters more. viem's default is **4000 ms**, so a user operation
 * that mined in 500 ms was still reported when the next poll came round. One Monad
 * block is 400 ms; polling at 500 ms means the receipt is noticed about when it
 * exists instead of up to four seconds later. This changes only how often we ask,
 * never what we send.
 */
let sharedClient: PublicClient | undefined;
function browserClient(): PublicClient {
  // The chain's own default RPC. Read-only, public, and carries no key.
  sharedClient ??= createPublicClient({
    chain: chainFor('mainnet'),
    transport: http(),
    pollingInterval: 500,
    cacheTime: 2_000,
  }) as PublicClient;
  return sharedClient;
}

/**
 * Which addresses are known to be delegated already.
 *
 * The transport read `eth_getCode` before every single submission to decide whether
 * an EIP-7702 authorization had to ride along. Measured at **328 ms**, on the
 * critical path, for an answer that had been the same since the account's first
 * operation — delegation is one-way for our purposes, and an account that has code
 * does not lose it between two orders.
 *
 * So the *true* answer is cached and the *false* one is not. A not-yet-delegated
 * account is re-read every time, because that is the answer that legitimately
 * changes, and getting it wrong means omitting an authorization the operation needs.
 * Session-scoped: a reload re-reads once and caches again.
 */
const delegated = new Set<string>();

/** Warm the delegation read before the user commits, so it is not on the hot path. */
export async function prefetchDelegation(address: Address): Promise<void> {
  if (delegated.has(address.toLowerCase())) return;
  try {
    const code = await browserClient().getCode({ address });
    if (code !== undefined && code !== '0x') delegated.add(address.toLowerCase());
  } catch {
    // A failed warm-up costs nothing: the submission path reads it again.
  }
}

/**
 * ITEM 2 — the nonce and fee pair `send()` needs, read ahead of the tap.
 *
 * The nonce is read once, from the smart account's own `getNonce()`. That draws a
 * fresh key nobody has used before (viem's default `nonceKeyManager` keys on
 * `Date.now()` — see `userOpSignature.ts`'s note on why the relayer's replay check
 * cannot assume key zero), so the value is correct and unused until *this app*
 * actually spends it; nothing else expires it. `resolveNonce` below pops it rather
 * than peeking, so two submissions that overlap can never sign the same one — the
 * second finds the cache empty and reads its own, exactly as it would have before
 * this change — and a fresh one is drawn in the background the instant this one is
 * taken, so the *next* tap is never the one waiting on it.
 *
 * The fee pair mirrors exactly what `prepareUserOperation` would have read itself:
 * `client.estimateFeesPerGas({ type: 'eip1559' })` with the same 2x buffer viem's own
 * `account-abstraction/actions/bundler/prepareUserOperation.js` applies, because the
 * bundler's prechecks need that headroom — replicated, not re-derived, so a
 * precomputed fee never asks for less than a fresh read would have (rule A2.5).
 * Cached for one Monad block (`BLOCK_TIME_MS`) and refreshed on every new block for
 * as long as `startOrderPrecompute` is running, so it is never older than that when a
 * tap needs it.
 */
interface NonceEntry {
  readonly value: bigint;
}
const nonceCache = new Map<string, NonceEntry>();

interface FeeEntry {
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly readAt: number;
}
let feeCache: FeeEntry | undefined;
const FEE_MAX_AGE_MS = BLOCK_TIME_MS;

async function readFreshNonce(account: SmartAccount, sender: Address): Promise<bigint> {
  const value = await account.getNonce();
  nonceCache.set(sender.toLowerCase(), { value });
  return value;
}

function takePrecomputedNonce(sender: Address): bigint | undefined {
  const key = sender.toLowerCase();
  const cached = nonceCache.get(key);
  if (cached === undefined) return undefined;
  nonceCache.delete(key);
  return cached.value;
}

/** The nonce `send()` actually signs over. See the doc above for why pop, not peek. */
async function resolveNonce(account: SmartAccount, sender: Address): Promise<bigint> {
  const taken = takePrecomputedNonce(sender);
  if (taken === undefined) return account.getNonce();
  void readFreshNonce(account, sender).catch(() => {
    // A failed background refill costs nothing: the next call finds no cache and
    // reads fresh itself, same as before this change existed.
  });
  return taken;
}

/**
 * The fee the operation is signed with: 1.2x viem's estimate (R9 speed, 2026-10-07).
 *
 * It was 2x. viem's estimate is already 1.2x the base fee plus the node's tip (122 gwei at
 * Monad's 100 gwei base fee), so 2x signed 244 gwei while Monad charged about 102. Every
 * figure built from the SIGNED max fee was 2.4x too high: the operation's required prefund
 * (0.43 MON for a KyberSwap swap, above the 0.3 MON a sponsored top-up adds, so the relayer
 * refused it: "The network fee for this action cannot be covered right now") and the
 * relayer's self-bundle worst case. 1.2x signs 146 gwei: still inside the relayer's
 * self-bundle band (at least 1.2x the base fee, at most 3x), and enough for the base fee to
 * rise at Monad's maximum 3.6% per block for several blocks before the operation would no
 * longer be includable. Monad charges the gas used at the effective price, not the max fee.
 */
const FEE_OVER_ESTIMATE = { numerator: 12n, denominator: 10n } as const;

async function readFees(client: PublicClient): Promise<FeeEntry> {
  const fees = await client.estimateFeesPerGas({ chain: client.chain, type: 'eip1559' });
  const entry: FeeEntry = {
    maxFeePerGas: (fees.maxFeePerGas * FEE_OVER_ESTIMATE.numerator) / FEE_OVER_ESTIMATE.denominator,
    maxPriorityFeePerGas: (fees.maxPriorityFeePerGas * FEE_OVER_ESTIMATE.numerator) / FEE_OVER_ESTIMATE.denominator,
    readAt: Date.now(),
  };
  feeCache = entry;
  return entry;
}

async function resolveFees(client: PublicClient): Promise<FeeEntry> {
  if (feeCache && Date.now() - feeCache.readAt < FEE_MAX_AGE_MS) return feeCache;
  return readFees(client);
}

/** A failed attempt cannot trust whatever fee reading led to it (ITEM 2). */
function invalidateFees(): void {
  feeCache = undefined;
}

/**
 * The fee pair a gas-charge quote should be priced against, read the same way
 * `send()` below reads it for the operation it actually signs (same cache, same 2x
 * buffer over `estimateFeesPerGas`). `/v1/gas/quote` answers a fee "to the unit" only
 * when it is given both fields — see `apps/relayer/src/server.ts`'s `/v1/gas/quote`
 * doc comment — so `gasCharge.ts` calls this before every quote it needs an exact
 * figure from, rather than reading fees a second, different way. Read-only: this
 * never signs anything, it only shares the same cached read `send()` would have made
 * anyway. `undefined` on a read failure — the caller falls back to an unpriced quote
 * rather than guessing a fee pair.
 */
export async function readGasQuoteFeePair(): Promise<
  { readonly maxFeePerGas: bigint; readonly maxPriorityFeePerGas: bigint } | undefined
> {
  try {
    const { maxFeePerGas, maxPriorityFeePerGas } = await resolveFees(browserClient());
    return { maxFeePerGas, maxPriorityFeePerGas };
  } catch {
    return undefined;
  }
}

/**
 * ITEM 5 — a dedicated WebSocket client, for block-push notifications only.
 *
 * Tested directly against this app's own RPC host on 2026-09-24: `wss://rpc.monad.xyz`
 * answered `eth_chainId` with `0x8f` (143, this chain) over a raw WebSocket connection,
 * and a raw `eth_subscribe("newHeads")` on that same connection delivered three
 * headers roughly 260-350 ms apart — consistent with the ~400 ms Monad block time
 * `BLOCK_TIME_MS` already records. Nothing here is guessed (rule A2.5): the wss
 * variant of the http endpoint this app already trusts was connected to and read from
 * directly, not assumed to exist because the http one does.
 *
 * Kept as its own client rather than folded into `browserClient()`: a WebSocket that
 * drops must not take the HTTP client's cached reads down with it, and
 * `watchBlocks({ poll: false })` only subscribes when the client's own transport type
 * is `'webSocket'` — mixing transports on one client would silently fall back to
 * polling everywhere, not just here.
 */
let wsClient: PublicClient | undefined;
let wsUnavailable = false;
function websocketClient(): PublicClient | undefined {
  if (wsUnavailable || typeof window === 'undefined') return undefined;
  try {
    wsClient ??= createPublicClient({
      chain: chainFor('mainnet'),
      transport: webSocket('wss://rpc.monad.xyz'),
    }) as PublicClient;
    return wsClient;
  } catch {
    wsUnavailable = true;
    return undefined;
  }
}

/**
 * One new-block notifier: WebSocket push when `wss://rpc.monad.xyz` is reachable,
 * `browserClient()`'s existing 500 ms poll otherwise (ITEM 5's documented fallback —
 * the same interval `pollingInterval: 500` already used above, so losing the
 * WebSocket never makes anything slower than this transport already was).
 */
function watchNewBlocks(onBlock: () => void, deps: BundlerTransportDeps): () => void {
  const ws = deps.wsClient === null ? undefined : (deps.wsClient ?? websocketClient());
  if (ws) {
    try {
      // `poll` is deliberately omitted, not forced to `false`: viem's own runtime
      // check (`client.transport.type === 'webSocket'`) decides, and the static
      // type of `ws` here (plain `PublicClient`, erased on purpose so a test can
      // inject any client shape via `deps.wsClient`) cannot prove that statically.
      // A real WebSocket-transport client still subscribes; anything else polls.
      return ws.watchBlocks({
        onBlock: () => onBlock(),
        onError: () => {
          // The live connection broke; later calls fall back to the poll rather
          // than retrying a dead socket.
          wsUnavailable = true;
        },
        emitOnBegin: false,
      });
    } catch {
      wsUnavailable = true;
      // fall through to the poll below
    }
  }
  const client = deps.client ?? browserClient();
  return client.watchBlocks({
    onBlock: () => onBlock(),
    emitOnBegin: false,
    poll: true,
    pollingInterval: 500,
  });
}

/**
 * ITEM 2 — warm the nonce and fee caches before the user commits, and keep the fee
 * cache block-fresh for as long as the ticket screen is mounted. Mirrors
 * `prefetchDelegation`'s shape: called at mount, costs nothing on the tap.
 */
export function startOrderPrecompute(
  owner: LocalAccount,
  deps: BundlerTransportDeps = {},
): () => void {
  const client = deps.client ?? browserClient();
  const wrapped = asOwner(owner);
  let stopped = false;
  let stopBlocks: (() => void) | undefined;

  void toGaslessAccount(client, wrapped)
    .then(({ address, account }) => {
      if (stopped) return;
      void readFreshNonce(account, address).catch(() => {
        // A failed warm-up costs nothing: `send()` reads it again when it needs it.
      });
      void readFees(client).catch(() => {});
      stopBlocks = watchNewBlocks(() => {
        if (!stopped) void readFees(client).catch(() => {});
      }, deps);
    })
    .catch(() => {
      // Nothing to warm if the account cannot even be resolved; `send()` hits the
      // same failure and reports it properly.
    });

  return () => {
    stopped = true;
    stopBlocks?.();
  };
}

type Bundler = ReturnType<typeof createBundlerClient>;
type UserOpReceipt = Awaited<ReturnType<Bundler['getUserOperationReceipt']>>;

/**
 * R9 (2026-10-07): the operation's estimate, started alongside the gas quote instead of
 * after it. `prewarmOperation` runs exactly what `send()` would run before signing (the
 * delegation read, the nonce and fee pair, `prepareUserOperation`), for the exact calls
 * the action will send, and `send()` uses the result only when its own request carries the
 * same sender and the same calls, byte for byte, within `WARM_MAX_AGE_MS`. A charged action
 * whose batch gains a fee leg after the quote does not match, and is prepared fresh as
 * before. A first operation (no delegation yet) is never pre-warmed: its authorization is
 * signed in `send()` itself.
 */
/** The one way a bundler client is built here, so a warmed one and a fresh one are alike. */
function makeBundler(account: SmartAccount, client: PublicClient, deps: BundlerTransportDeps) {
  return createBundlerClient({
    /**
     * Estimates are signed for real, not with viem's placeholder (2026-09-23).
     *
     * The relayer funds a thin EntryPoint deposit during the estimate, because the
     * bundler checks the prefund there first, and it now spends only for a request
     * whose signature recovers to its sender (audit S4-C1). The signature is over the
     * estimate's own fields, gas limits all zero, so it cannot execute. It proves the
     * key and nothing more. The operation actually sent is signed again below, over
     * its real limits, exactly as before. No prompt: an in-memory signature.
     */
    account: withSignedEstimates(account),
    client: client as never,
    transport: deps.bundler ?? http(apiUrl('/api/submit')),
    pollingInterval: 500,
  });
}

interface Warmed {
  readonly client: PublicClient;
  readonly account: SmartAccount;
  readonly bundler: ReturnType<typeof makeBundler>;
  readonly prepared: Record<string, unknown>;
}
const WARM_MAX_AGE_MS = 5_000;
const warmCache = new Map<string, { readonly at: number; readonly promise: Promise<Warmed> }>();

function warmKey(sender: Address, calls: SubmitRequest['calls']): string {
  return `${sender.toLowerCase()}|${JSON.stringify(
    calls.map((c) => [c.to.toLowerCase(), c.data.toLowerCase(), (c.value ?? 0n).toString()]),
  )}`;
}

function takeWarm(sender: Address, calls: SubmitRequest['calls']): Promise<Warmed> | undefined {
  const key = warmKey(sender, calls);
  const hit = warmCache.get(key);
  warmCache.delete(key);
  if (!hit || Date.now() - hit.at > WARM_MAX_AGE_MS) return undefined;
  return hit.promise;
}

export function prewarmOperation(
  owner: LocalAccount,
  request: Pick<SubmitRequest, 'sender' | 'calls'>,
  deps: BundlerTransportDeps = {},
): void {
  if (!isDelegatedKnown(request.sender)) return;
  const calls = request.calls.map((c) => ({
    to: c.to,
    data: c.data,
    ...(c.value !== undefined && c.value !== 0n ? { value: c.value } : {}),
  }));
  const promise = (async (): Promise<Warmed> => {
    const client = deps.client ?? browserClient();
    const { account } = await toGaslessAccount(client, asOwner(owner));
    const bundler = makeBundler(account, client, deps);
    const [nonce, fees] = await Promise.all([resolveNonce(account, request.sender), resolveFees(client)]);
    const prepared = (await bundler.prepareUserOperation({
      calls: calls.map((c) => ({ to: c.to as Address, data: c.data, value: c.value ?? 0n })),
      nonce,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    })) as Record<string, unknown>;
    return { client, account, bundler, prepared };
  })();
  promise.catch(() => {
    // An unused or failed warm-up costs nothing: `send()` prepares fresh.
  });
  warmCache.set(warmKey(request.sender, calls), { at: Date.now(), promise });
}

function isDelegatedKnown(sender: Address): boolean {
  return delegated.has(sender.toLowerCase());
}

/**
 * ITEM 5 — replaces viem's own `waitForUserOperationReceipt`, which asks the bundler
 * again on a fixed timer (`pollingInterval`). This instead asks again only when a
 * genuinely new block has arrived, so the receipt is noticed about when it exists
 * rather than up to one polling interval later. Error handling matches viem's own
 * `waitForUserOperationReceipt` exactly: `UserOperationReceiptNotFoundError` means
 * "not yet" and the wait continues; anything else is a real failure and propagates.
 */
/**
 * R9 speed (2026-10-07): the moment the operation is in a block, straight from the chain.
 *
 * Asking the bundler for the receipt costs a round trip through this app's server, the
 * relayer and, for a Pimlico-bundled operation, Pimlico: 0.44 to 1.06 s per ask, measured
 * on production. The EntryPoint emits `UserOperationEvent(userOpHash, ...)` in the block
 * that runs the operation, and `wss://rpc.monad.xyz` pushes a matching log with that
 * block. So "Mined" is signalled when the log arrives; the receipt is still fetched from
 * the bundler for the result and for "Confirmed". Nothing else changes: no log here only
 * means the receipt path below answers, exactly as before.
 */
function watchIncluded(userOpHash: Hex, deps: BundlerTransportDeps, onIncluded: () => void): () => void {
  const ws = deps.wsClient === null ? undefined : (deps.wsClient ?? websocketClient());
  if (!ws) return () => {};
  try {
    return ws.watchContractEvent({
      address: ENTRY_POINT_V08,
      abi: entryPoint08Abi,
      eventName: 'UserOperationEvent',
      args: { userOpHash },
      onLogs: (logs) => {
        if (logs.length > 0) onIncluded();
      },
      onError: () => {
        // The receipt path still answers.
      },
    });
  } catch {
    return () => {};
  }
}

async function waitForReceiptByBlocks(
  bundler: Bundler,
  userOpHash: Hex,
  deps: BundlerTransportDeps,
  timeoutMs: number,
): Promise<UserOpReceipt | undefined> {
  const immediate = await bundler
    .getUserOperationReceipt({ hash: userOpHash })
    .catch((caught: unknown) => {
      if (caught instanceof UserOperationReceiptNotFoundError) return undefined;
      throw caught;
    });
  if (immediate) return immediate;

  return new Promise((resolve, reject) => {
    let settled = false;
    let stop: () => void = () => {};
    const finish = (value: UserOpReceipt | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      resolve(value);
    };
    const fail = (caught: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      reject(caught as Error);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    stop = watchNewBlocks(() => {
      if (settled) return;
      bundler
        .getUserOperationReceipt({ hash: userOpHash })
        .then((receipt) => finish(receipt))
        .catch((caught: unknown) => {
          if (caught instanceof UserOperationReceiptNotFoundError) return; // try again next block
          fail(caught);
        });
    }, deps);
  });
}

/**
 * ITEM 5 — "Confirmed" is finality, not the receipt itself: one further block past
 * the one the receipt landed in. Never rejects: a finality-detection hiccup must not
 * turn an already-successful order into a failure, it only shows the pill's last step
 * a little late. Bounded at 5 seconds for the same reason.
 */
async function waitOneMoreBlock(deps: BundlerTransportDeps): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    let stop: () => void = () => {};
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      resolve();
    };
    const timer = setTimeout(finish, 5_000);
    stop = watchNewBlocks(finish, deps);
  });
}

/**
 * What the transport talks to. Production passes nothing: the chain's public RPC for
 * reads and our own `/api/submit` for the bundler. A test injects both, so the real
 * sequence below runs end to end without a network.
 */
export interface BundlerTransportDeps {
  readonly client?: PublicClient;
  readonly bundler?: Transport;
  /**
   * ITEM 5 test hook. Omit to use the real `wss://rpc.monad.xyz` client when it is
   * reachable, falling back to `browserClient()`'s poll. Pass `null` to force that
   * fallback deterministically — no real WebSocket, for a test. Pass a `PublicClient`
   * to supply the block source directly.
   */
  readonly wsClient?: PublicClient | null;
  /** ITEM 5 test hook. Defaults to 90 seconds — the SUBMITTED timeout (ITEM 9). */
  readonly receiptTimeoutMs?: number;
}

export function bundlerTransport(
  local: LocalAccount,
  deps: BundlerTransportDeps = {},
  /**
   * `/dev/perf`'s action id (see `lib/perf/orderPerf.ts`), threaded through from
   * `run()`'s `RunOptions.perfActionId`. Undefined outside a tap that started one —
   * every `recordPerfStage` call below is a no-op then, so this changes nothing about
   * what the order does.
   */
  perfActionId?: string,
): SubmitTransport {
  const owner = asOwner(local);
  return {
    async send(
      request: SubmitRequest,
      onStage?: (stage: SubmitStage) => void,
    ): Promise<SubmitResult> {
      onStage?.('preparing');
      // R9: the estimate this exact request's calls were pre-warmed with, if any.
      const warmPromise = takeWarm(request.sender, request.calls);
      let warm: Warmed | undefined;
      if (warmPromise) {
        try {
          warm = await warmPromise;
        } catch {
          warm = undefined;
        }
      }
      const client = warm?.client ?? deps.client ?? browserClient();
      const { account } = warm ? { account: warm.account } : await toGaslessAccount(client, owner);

      const bundler = warm?.bundler ?? makeBundler(account, client, deps);

      // `getCode` returns undefined for an account that has never been delegated.
      // Cached once true — see `delegated` above for why only the true answer is.
      const key = request.sender.toLowerCase();
      let isDelegated = warm !== undefined || delegated.has(key);
      if (!isDelegated) {
        const code = await client.getCode({ address: request.sender });
        isDelegated = code !== undefined && code !== '0x';
        if (isDelegated) delegated.add(key);
      }
      const authorization = isDelegated
        ? undefined
        : await owner.signAuthorization({
            address: SIMPLE_7702_DELEGATE,
            chainId: client.chain?.id ?? 143,
            nonce: await client.getTransactionCount({ address: request.sender }),
          });

      // "Mined" as soon as the chain shows the operation in a block (see `watchIncluded`),
      // ahead of the bundler's receipt; once only, whichever arrives first, and never before
      // the bundler has accepted the hash ("Sent").
      let minedSignalled = false;
      let accepted = false;
      let includedBeforeAccepted = false;
      const signalMined = () => {
        if (minedSignalled) return;
        minedSignalled = true;
        onStage?.('mining');
        if (perfActionId) recordPerfStage(perfActionId, 'mined');
      };
      const onIncluded = () => {
        if (accepted) signalMined();
        else includedBeforeAccepted = true;
      };
      // R9: subscribed before signing, from the hash the operation will have, so a bundle
      // included in the block right after the hand-off is never missed.
      let watchedHash: Hex | undefined;
      let stopIncluded: () => void = () => {};

      let userOpHash: Hex;
      try {
        /**
         * Prepare, sign and send as three steps rather than one.
         *
         * `sendUserOperation` does exactly these three internally, so the operation
         * submitted is byte-for-byte what it was — this only makes the boundaries
         * observable. It matters because preparing and estimating is over a second of
         * a roughly two-and-a-half second action (measured 2026-09-10), and rolling it
         * into one opaque call is what made the pill sit still while the slowest part
         * of the whole flow went by unannounced.
         *
         * ITEM 2 — the nonce and fee pair below are read ahead of the tap when
         * `startOrderPrecompute` warmed them; passing them explicitly is what skips
         * `prepareUserOperation`'s own internal reads for both.
         */
        onStage?.('estimating');
        // Peeked, not popped: `resolveNonce`/`resolveFees` below decide warm-or-cold
        // for themselves (and pop the nonce cache as a side effect), so whether this
        // specific submission actually got a precomputed value has to be read first.
        let prepared: Record<string, unknown>;
        if (warm) {
          prepared = warm.prepared;
          if (perfActionId) recordPerfStage(perfActionId, 'precomputed-inputs-used', 'estimate pre-warmed');
        } else {
          const nonceWasWarm = nonceCache.has(request.sender.toLowerCase());
          const feesWereWarm = feeCache !== undefined && Date.now() - feeCache.readAt < FEE_MAX_AGE_MS;
          const [nonce, fees] = await Promise.all([
            resolveNonce(account, request.sender),
            resolveFees(client),
          ]);
          // The moment the precompute cache's answer — warm or freshly read — is
          // actually consumed for this submission (ITEM 2, `/dev/perf`).
          if (perfActionId) {
            recordPerfStage(
              perfActionId,
              'precomputed-inputs-used',
              `nonce ${nonceWasWarm ? 'warm' : 'cold'}, fees ${feesWereWarm ? 'warm' : 'cold'}`,
            );
          }
          prepared = (await bundler.prepareUserOperation({
            calls: request.calls.map((c) => ({ to: c.to as Address, data: c.data, value: c.value ?? 0n })),
            nonce,
            maxFeePerGas: fees.maxFeePerGas,
            maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
            ...(authorization ? { authorization } : {}),
          })) as Record<string, unknown>;
        }
        if (perfActionId) recordPerfStage(perfActionId, 'estimated');

        try {
          watchedHash = getUserOperationHash({
            userOperation: prepared as never,
            entryPointAddress: ENTRY_POINT_V08,
            entryPointVersion: '0.8',
            chainId: client.chain?.id ?? 143,
          });
          stopIncluded = watchIncluded(watchedHash, deps, onIncluded);
        } catch {
          // No early watch; the one after the hand-off below still runs.
        }

        onStage?.('signing');
        const signature = await account.signUserOperation(prepared as never);
        if (perfActionId) recordPerfStage(perfActionId, 'signed');

        userOpHash = await bundler.sendUserOperation({ ...prepared, signature } as never);
        // "Sent" — the RPC/bundler has accepted the hash. Fired here, after the call
        // resolves, not before it (ITEM 5): the old placement lit "Sending" the
        // instant the request went out, which claimed acceptance a full round trip
        // before it was actually true.
        onStage?.('submitting');
        accepted = true;
        if (watchedHash === undefined || watchedHash.toLowerCase() !== userOpHash.toLowerCase()) {
          // Never expected; watch the hash the bundler answered with instead.
          stopIncluded();
          includedBeforeAccepted = false;
          stopIncluded = watchIncluded(userOpHash, deps, onIncluded);
        } else if (includedBeforeAccepted) {
          signalMined();
        }
        if (perfActionId) {
          // `sendUserOperation`'s own resolution IS the accepted hash in this
          // codebase — there is no separate round trip between "accepted" and "we
          // have the hash", so both stages land on the same instant rather than one
          // being invented to look distinct.
          recordPerfStage(perfActionId, 'submitted');
          recordPerfStage(perfActionId, 'hash-received');
        }
      } catch (caught) {
        stopIncluded();
        // Correctness first: nothing cached going into a failed attempt is trusted
        // for the next one (ITEM 2). The popped nonce is not restored — a background
        // refill was already kicked off the moment it was taken, in `resolveNonce`.
        invalidateFees();
        return rejectedResult(request.sender, caught);
      }

      /**
       * A bounded wait, and an honest answer when it runs out (ITEM 9).
       *
       * Block-driven rather than polled on a fixed timer (ITEM 5) — see
       * `waitForReceiptByBlocks`, which asks the bundler again only when a genuinely
       * new block has arrived instead of on a 500 ms clock. An operation the bundler
       * accepted and never mined would otherwise leave the ticket sitting on "Sending"
       * for as long as the tab stayed open, with nothing said. That is the one state
       * where the truthful answer is "we do not know yet": it may still land, so
       * saying it failed would be a guess, and a user told it failed sends it twice.
       *
       * So: 90 seconds, then return the operation hash with `SUBMITTED` — accepted,
       * unconfirmed — and let the copy say exactly that. Nothing here claims the money
       * did or did not move.
       */
      const receiptTimeoutMs = deps.receiptTimeoutMs ?? 90_000;
      let receipt: UserOpReceipt | undefined;
      try {
        receipt = await waitForReceiptByBlocks(bundler, userOpHash, deps, receiptTimeoutMs);
      } finally {
        stopIncluded();
      }
      if (!receipt) {
        return {
          status: 'SUBMITTED',
          sender: request.sender,
          userOpHash,
          message: failureText(failure('SUBMIT_TIMED_OUT')),
          detail: `The bundler accepted it and has not returned a receipt in 90 seconds.`,
        };
      }

      // "Mined" — the instant a receipt exists, whatever it says (ITEM 5). Nothing
      // downstream waits for `send()` itself to resolve before showing this: `run()`
      // reacts to `onStage` the moment it fires, mid-flight, well before the finality
      // wait below lets this function's own promise resolve.
      signalMined();
      const txHash = receipt.receipt.transactionHash;

      if (receipt.success) {
        // "Confirmed" is finality, not the receipt itself: one further block past the
        // one the receipt landed in (ITEM 5).
        await waitOneMoreBlock(deps);
        if (perfActionId) recordPerfStage(perfActionId, 'confirmed');
      }

      return receipt.success
        ? {
            status: 'CONFIRMED',
            sender: request.sender,
            userOpHash,
            txHash,
            message: 'Moved into your trading balance.',
            // The one moment an order's id exists to be read. Without these the app
            // could never remember an order it had just placed.
            ...(receipt.logs ? { logs: receipt.logs } : {}),
          }
        : {
            status: 'REVERTED',
            sender: request.sender,
            userOpHash,
            txHash,
            message: 'That did not go through on chain. Nothing was spent beyond the network fee.',
            // The bundler's own stated revert reason, when it gave one — carried as
            // `reason` so the ticket can decode a Kuru revert to its name, and never
            // silently dropped (2026-09-08 rule).
            ...(receipt.reason ? { reason: receipt.reason } : {}),
          };
    },
  };
}

/** A rejected submission, as the ticket reads it. `reason` carries the refusal's code. */
export function rejectedResult(sender: Address, caught: unknown): SubmitResult {
  const { message, detail, reason, refusalData } = messageFrom(caught);
  return {
    status: 'REJECTED',
    sender,
    reason: reason ?? 'SUBMIT_REJECTED',
    message,
    ...(detail ? { detail } : {}),
    ...(refusalData ? { refusalData } : {}),
  };
}

/**
 * The relayer's sponsorship-allowance refusal, if that is what this is.
 *
 * viem wraps a JSON-RPC error several layers deep (execution error, bundler error, RPC
 * error), and only the innermost request error keeps the response's `data`. So the
 * cause chain is walked rather than one level assumed. The depth bound stops a cyclic
 * `cause` from spinning.
 */
function allowanceDataOf(caught: unknown): SponsorshipAllowanceData | undefined {
  let current: unknown = caught;
  for (let depth = 0; current && depth < 10; depth += 1) {
    const data = (current as { data?: unknown }).data;
    if (isSponsorshipAllowanceData(data)) return data;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * The same walk as `allowanceDataOf`, for the gas-charge refusal shape
 * (`FREE_ACTIONS_USED`, `GAS_FEE_REQUIRED`, `GAS_FEE_QUOTE_EXPIRED`,
 * `GAS_FEE_UNPRICED`, `FEE_LEG_MISMATCH`) instead of the sponsorship-allowance one.
 * The two are disjoint shapes — `isGasChargeRefusalData`'s `reason` values never
 * overlap `isSponsorshipAllowanceData`'s — so either can be checked first.
 */
function gasChargeRefusalDataOf(caught: unknown): GasChargeRefusalData | undefined {
  let current: unknown = caught;
  for (let depth = 0; current && depth < 10; depth += 1) {
    const data = (current as { data?: unknown }).data;
    if (isGasChargeRefusalData(data)) return data;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** `3:00 PM`, in the viewer's own zone. The relayer cannot know it, so the browser says it. */
export function localClock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * A rejection, split the way the error-handling rule (2026-09-08) requires: a
 * one-line plain-language lead in `message`, and the upstream's own words VERBATIM
 * in `detail`, source-named. The old version substituted its own sentence for the
 * upstream reason in three places — the pause, the MON-reserve rule, and any line
 * containing a long hex string — and every substitution threw away the one thing
 * the user could act on or report. Nothing is substituted any more; the lead
 * explains, the detail quotes.
 */
export function messageFrom(caught: unknown): {
  message: string;
  detail?: string;
  reason?: string;
  refusalData?: GasChargeRefusalData;
} {
  /**
   * A gas-charge refusal (`FREE_ACTIONS_USED`, `GAS_FEE_REQUIRED`,
   * `GAS_FEE_QUOTE_EXPIRED`, `GAS_FEE_UNPRICED`, `FEE_LEG_MISMATCH`).
   *
   * Every one of these carries its own already-written, user-facing sentence as the
   * JSON-RPC error's top-level `message` (`policy.ts`'s exported `*_MESSAGE`
   * constants, or the mismatch's own sentence) — shown directly, the same way the
   * sponsorship-allowance refusal below is, rather than routed through the generic
   * "That did not go through" fallback. `refusalData` is what lets
   * `lib/wallet/gasCharge.ts` rebuild the batch once on `FEE_LEG_MISMATCH` or
   * `GAS_FEE_QUOTE_EXPIRED` instead of treating either as terminal.
   */
  const gasCharge = gasChargeRefusalDataOf(caught);
  if (gasCharge) {
    const raw =
      caught instanceof Error
        ? ((caught as { details?: string }).details ?? caught.message)
        : String(caught);
    const first = raw.split('\n')[0]?.trim() ?? '';
    const message = first
      ? first.charAt(0).toUpperCase() + first.slice(1)
      : "The network fee couldn't be worked out, so nothing was sent. Try again.";
    return { message, reason: gasCharge.reason, refusalData: gasCharge };
  }

  /**
   * A sponsorship budget bound (B2c, 2026-09-25): whatever internal scope was tight,
   * the user reads the ONE gas sentence with its two live choices. The relayer
   * already converts these before they reach the wire; this branch is defense in
   * depth for a refusal that slips through with its old `data` shape intact.
   * `reason` is what lets the ticket stop at "Checking" instead of lighting
   * "Sending".
   */
  const allowance = allowanceDataOf(caught);
  if (allowance) {
    return { message: SPONSORSHIP_PAUSED_MESSAGE, reason: SPONSORSHIP_ALLOWANCE_USED };
  }

  const raw =
    caught instanceof Error
      ? ((caught as { details?: string }).details ?? caught.message)
      : String(caught);
  const first = raw.split('\n')[0]?.trim() ?? '';

  // The same refusal with its `data` lost somewhere in between: an old relayer's
  // scope-naming sentence still converts to the one gas sentence here (B2c).
  if (/^Network fees are covered\. .*allowance.* is used up/.test(first)) {
    return { message: SPONSORSHIP_PAUSED_MESSAGE, reason: SPONSORSHIP_ALLOWANCE_USED };
  }
  // The path is /api/submit -> our relayer -> Pimlico, so what came back is the
  // relay's answer — sometimes its own policy sentence, sometimes Pimlico's or the
  // chain's words forwarded. Named as the relay because that is who spoke to us.
  const detail = first ? `The relay answered: “${first}”` : undefined;

  /**
   * Three refusals from our own relayer that had no words of their own (ITEM 9).
   *
   * Each one is matched on the relayer's actual sentence, and each one keeps that
   * sentence verbatim in `detail` — the lead is what happened, the detail is who said
   * it and why. Without these they all arrived as "That did not go through", which
   * tells a rate-limited user nothing and tells a user whose sponsorship ran out that
   * they did something wrong.
   */
  if (/too many requests/i.test(raw)) {
    return {
      message: failureText(failure('RATE_LIMITED')),
      ...(detail ? { detail } : {}),
    };
  }
  if (/float|relayer balance|insufficient .*relayer|would take the relayer/i.test(raw)) {
    return {
      message: failureText(failure('SPONSORSHIP_UNAVAILABLE')),
      ...(detail ? { detail } : {}),
    };
  }
  if (/does not forward/i.test(raw)) {
    return {
      message: 'This app asked the relay for something it does not carry. Nothing was sent.',
      ...(detail ? { detail } : {}),
    };
  }

  // Kuru pausing is the venue's state, and the lead says so rather than implying
  // the app did something wrong. The selector still shows in the detail line.
  if (raw.includes(PROTOCOL_PAUSED_SELECTOR)) {
    return {
      message: 'Kuru has paused deposits right now. Your money stays in your wallet.',
      detail: 'Kuru answered: ProtocolPaused',
    };
  }
  // Monad's EIP-7702 10-MON reserve rule surfacing from the chain itself: the one
  // fact stated plainly (v2.1 spec 3.1 deleted every gate sentence of that class).
  if (/needs at least \d+ MON/i.test(raw)) {
    return {
      message: 'The network requires this account to keep 10 MON in reserve, so nothing was sent.',
      ...(detail ? { detail } : {}),
    };
  }
  return {
    message: 'That did not go through. Nothing was spent.',
    ...(detail ? { detail } : {}),
  };
}
