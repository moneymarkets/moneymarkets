import { KNOWN_CHAINS, addChainParams, staticCoverage } from '@tradepro/core';
import { BASE_RPC, ERC20_TRANSFER_TOPIC, SOLANA_RPC, TRONGRID_API, padAddressTopic } from './chains';

/**
 * Has the money come back? Read from the source chain, independent of the vendor.
 *
 * ## Why this exists (2026-09-29)
 *
 * The owner's SOL deposit `7uNPTMxP...uw5u` went back to his Solana address at
 * 17:49:42 UTC on 2026-09-03; 1Click said PROCESSING at 17:49:20 and REFUNDED a second
 * later. Nothing in this app ever looked at the source chain again after the deposit
 * landed, so the only way a return could reach the tracker was the vendor's own word.
 * A vendor that lags, or never says it, left a returned deposit on "Bridging to Monad".
 *
 * ## What counts as a refund
 *
 * A transfer that credits the depositor's own source address (`refund_to`) and debits
 * either the deposit address itself or an account the deposit address was swept into.
 * The second case is the normal one: 1Click sweeps a Solana deposit address into its
 * own custody account (`3JUKe...` moved the deposit into `6tckHF...`) and refunds from
 * that same account (`4jVcz...` paid `CFMGos...` out of `6tckHF...`). Learning the
 * custody account from this deposit's own sweep, rather than from a list of vendor
 * addresses, means nothing here is a hand-typed address (rule A2.5).
 *
 * Every candidate must also pass:
 *
 *   - **not signed by the depositor**: a transfer the user made themselves is not a
 *     refund, even between the same two accounts;
 *   - **after the deposit was issued**;
 *   - **an amount between half and one and a half times the amount sent**, the same
 *     tolerance `destination.ts` uses for the Monad side: a refund is the deposit less
 *     the vendor's fees, never a different order of magnitude;
 *   - **not already claimed by another row** (checked by the caller, `db.ts`).
 *
 * ## Endpoints, each keyless and each already used by this app
 *
 *   - Solana: `api.mainnet-beta.solana.com` (solana.com/docs/references/clusters):
 *     `getSignaturesForAddress`, `getTransaction` (jsonParsed), and for SPL tokens
 *     `getTokenAccountsByOwner`, all documented JSON-RPC methods.
 *   - EVM: the RPC in `chainParams.ts` that answered `eth_chainId` for that chain
 *     (Base: `BASE_RPC_URL` or `mainnet.base.org`), `eth_getLogs` on the ERC-20
 *     `Transfer` event. `mainnet.base.org` refuses a range over 2,000 blocks (observed
 *     2026-09-29: "eth_getLogs is limited to a 2,000 range"), so ranges are scanned in
 *     chunks and halved on any range refusal.
 *   - Tron: TronGrid `/v1/accounts/{address}/transactions/trc20` with `only_from`,
 *     `only_to`, `contract_address` and `min_timestamp` (developers.tron.network).
 *
 * Native EVM assets (ETH and the like) move without a log, and no keyless way to read
 * an internal transfer was verified. No rail issues a deposit address for one today
 * (`coverage.ts`); if one does, this answers `unsupported` rather than guessing.
 */

export type SourceFamily = 'svm' | 'evm' | 'tvm';

export type RefundSource = 'our-watcher-solana' | 'our-watcher-evm' | 'our-watcher-tron';

export interface RefundFinding {
  readonly hash: string;
  /** Origin-token base units credited to `refund_to`. */
  readonly amount: bigint;
  /** Who paid it: the deposit address, or the account it was swept into. */
  readonly from: string;
  readonly source: RefundSource;
  /** Chain time of the refund, milliseconds. */
  readonly at: number;
}

export type RefundCheck =
  | { readonly status: 'found'; readonly finding: RefundFinding }
  | { readonly status: 'none' }
  | { readonly status: 'unsupported'; readonly why: string };

/** Between half and one and a half times what was sent, as `destination.ts` does. */
export function refundAmountPlausible(amount: bigint, reference: bigint): boolean {
  if (amount <= 0n || reference <= 0n) return false;
  return amount * 2n >= reference && amount * 2n <= reference * 3n;
}

/** A deposit issued at `createdAt` cannot be refunded by a transaction five minutes older than it. */
const CLOCK_MARGIN_MS = 5 * 60_000;

// ── Solana ────────────────────────────────────────────────────────────────────────

interface SolanaTokenBalance {
  readonly accountIndex: number;
  readonly mint: string;
  readonly owner?: string;
  readonly uiTokenAmount: { readonly amount: string };
}

/** The part of a `getTransaction` (jsonParsed) result this file reads. */
export interface SolanaTx {
  readonly blockTime: number | null;
  readonly meta: {
    readonly err: unknown;
    readonly preBalances: readonly number[];
    readonly postBalances: readonly number[];
    readonly preTokenBalances?: readonly SolanaTokenBalance[];
    readonly postTokenBalances?: readonly SolanaTokenBalance[];
  } | null;
  readonly transaction: {
    readonly signatures: readonly string[];
    readonly message: { readonly accountKeys: readonly { readonly pubkey: string; readonly signer: boolean }[] };
  };
}

/**
 * Net change per account in one transaction. Native SOL is keyed by account address;
 * an SPL token (`mint` given) is keyed by the token account's owner, which is how a
 * wallet address is credited with a token it holds in a separate account.
 */
export function solanaDeltas(tx: SolanaTx, mint?: string): Map<string, bigint> {
  const out = new Map<string, bigint>();
  const add = (key: string, v: bigint) => out.set(key, (out.get(key) ?? 0n) + v);
  const meta = tx.meta;
  if (!meta) return out;
  if (!mint) {
    tx.transaction.message.accountKeys.forEach((k, i) => {
      const pre = meta.preBalances[i];
      const post = meta.postBalances[i];
      if (pre === undefined || post === undefined) return;
      const d = BigInt(post) - BigInt(pre);
      if (d !== 0n) add(k.pubkey, d);
    });
    return out;
  }
  for (const b of meta.preTokenBalances ?? []) {
    if (b.mint === mint && b.owner) add(b.owner, -BigInt(b.uiTokenAmount.amount));
  }
  for (const b of meta.postTokenBalances ?? []) {
    if (b.mint === mint && b.owner) add(b.owner, BigInt(b.uiTokenAmount.amount));
  }
  for (const [k, v] of [...out]) if (v === 0n) out.delete(k);
  return out;
}

/** Accounts the deposit address's own money was swept into. */
export function solanaCustody(
  depositAddress: string,
  depositTxs: readonly SolanaTx[],
  refundTo: string,
  mint?: string,
): Set<string> {
  const custody = new Set<string>();
  for (const tx of depositTxs) {
    if (!tx.meta || tx.meta.err !== null) continue;
    const d = solanaDeltas(tx, mint);
    if ((d.get(depositAddress) ?? 0n) >= 0n) continue;
    for (const [account, delta] of d) {
      if (account !== depositAddress && account !== refundTo && delta > 0n) custody.add(account);
    }
  }
  return custody;
}

export function findSolanaRefund(input: {
  readonly depositAddress: string;
  readonly refundTo: string;
  readonly mint?: string;
  readonly depositTxs: readonly SolanaTx[];
  readonly refundToTxs: readonly SolanaTx[];
  readonly notBeforeMs: number;
  readonly reference: bigint;
}): RefundFinding | undefined {
  const custody = solanaCustody(input.depositAddress, input.depositTxs, input.refundTo, input.mint);
  const ordered = [...input.refundToTxs].sort((a, b) => (a.blockTime ?? 0) - (b.blockTime ?? 0));
  for (const tx of ordered) {
    if (!tx.meta || tx.meta.err !== null || tx.blockTime === null) continue;
    const at = tx.blockTime * 1000;
    if (at < input.notBeforeMs - CLOCK_MARGIN_MS) continue;
    const signedByDepositor = tx.transaction.message.accountKeys.some(
      (k) => k.pubkey === input.refundTo && k.signer,
    );
    if (signedByDepositor) continue;
    const d = solanaDeltas(tx, input.mint);
    const gain = d.get(input.refundTo) ?? 0n;
    if (gain <= 0n) continue;
    const from =
      (d.get(input.depositAddress) ?? 0n) < 0n
        ? input.depositAddress
        : [...custody].find((c) => (d.get(c) ?? 0n) < 0n);
    if (!from) continue;
    if (!refundAmountPlausible(gain, input.reference)) continue;
    const hash = tx.transaction.signatures[0];
    if (!hash) continue;
    return { hash, amount: gain, from, source: 'our-watcher-solana', at };
  }
  return undefined;
}

// ── EVM ───────────────────────────────────────────────────────────────────────────

export interface EvmTransferLog {
  readonly transactionHash: string;
  readonly blockNumber: string;
  readonly topics: readonly string[];
  readonly data: string;
}

function topicAddress(topic: string | undefined): string | undefined {
  return topic && topic.length === 66 ? `0x${topic.slice(26)}`.toLowerCase() : undefined;
}

export function findEvmRefund(input: {
  readonly depositAddress: string;
  readonly refundTo: string;
  readonly logsFromDeposit: readonly EvmTransferLog[];
  readonly logsToRefundTo: readonly EvmTransferLog[];
  readonly reference: bigint;
}): (Omit<RefundFinding, 'at'> & { readonly blockNumber: bigint }) | undefined {
  const deposit = input.depositAddress.toLowerCase();
  const refundTo = input.refundTo.toLowerCase();
  const senders = new Set<string>([deposit]);
  for (const log of input.logsFromDeposit) {
    if (topicAddress(log.topics[1]) !== deposit) continue;
    const to = topicAddress(log.topics[2]);
    if (to && to !== refundTo) senders.add(to);
  }
  const ordered = [...input.logsToRefundTo].sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)));
  for (const log of ordered) {
    if (log.topics[0] !== ERC20_TRANSFER_TOPIC) continue;
    const from = topicAddress(log.topics[1]);
    if (!from || !senders.has(from) || topicAddress(log.topics[2]) !== refundTo) continue;
    const amount = BigInt(log.data === '0x' ? 0 : log.data);
    if (!refundAmountPlausible(amount, input.reference)) continue;
    return { hash: log.transactionHash, amount, from, source: 'our-watcher-evm', blockNumber: BigInt(log.blockNumber) };
  }
  return undefined;
}

// ── Tron ──────────────────────────────────────────────────────────────────────────

/** One entry of TronGrid's `/v1/accounts/{address}/transactions/trc20` `data` array. */
export interface TronTransfer {
  readonly transaction_id: string;
  readonly block_timestamp: number;
  readonly from: string;
  readonly to: string;
  readonly value: string;
  readonly token_info?: { readonly address?: string };
}

export function findTronRefund(input: {
  readonly depositAddress: string;
  readonly refundTo: string;
  readonly token: string;
  readonly outOfDeposit: readonly TronTransfer[];
  readonly intoRefundTo: readonly TronTransfer[];
  readonly notBeforeMs: number;
  readonly reference: bigint;
}): RefundFinding | undefined {
  const senders = new Set<string>([input.depositAddress]);
  for (const t of input.outOfDeposit) {
    if (t.from === input.depositAddress && t.to !== input.refundTo) senders.add(t.to);
  }
  const ordered = [...input.intoRefundTo].sort((a, b) => a.block_timestamp - b.block_timestamp);
  for (const t of ordered) {
    if (t.to !== input.refundTo || !senders.has(t.from)) continue;
    if (t.token_info?.address && t.token_info.address !== input.token) continue;
    if (t.block_timestamp < input.notBeforeMs - CLOCK_MARGIN_MS) continue;
    const amount = BigInt(t.value);
    if (!refundAmountPlausible(amount, input.reference)) continue;
    return { hash: t.transaction_id, amount, from: t.from, source: 'our-watcher-tron', at: t.block_timestamp };
  }
  return undefined;
}

// ── Which chain, which token ──────────────────────────────────────────────────────

export interface SourceAsset {
  readonly family: SourceFamily;
  readonly chainId: number;
  /** Token contract / mint. Undefined for the chain's native coin. */
  readonly token?: string;
}

const SOLANA_NATIVE = '11111111111111111111111111111111';

/**
 * The chain family and token for a row, from `coverage.ts`'s vendor-named addresses:
 * `chain` is the display name the row stores, `symbol` its origin symbol.
 */
export function resolveSourceAsset(chain: string, symbol: string): SourceAsset | undefined {
  const known = Object.values(KNOWN_CHAINS).find((c) => c.displayName === chain);
  if (!known || (known.vm !== 'svm' && known.vm !== 'evm' && known.vm !== 'tvm')) return undefined;
  const entry = staticCoverage().find((e) => e.chain.id === known.id && e.asset === symbol);
  if (!entry) return undefined;
  const native = entry.assetAddress === SOLANA_NATIVE || /^0x0{40}$/i.test(entry.assetAddress);
  return { family: known.vm, chainId: known.id, ...(native ? {} : { token: entry.assetAddress }) };
}

// ── Reading the chains ────────────────────────────────────────────────────────────

export interface RefundRowInput {
  readonly depositAddress: string;
  readonly chain: string;
  readonly originSymbol: string;
  readonly refundTo: string;
  readonly amountIn: string;
  readonly createdAt: number;
}

/**
 * Where the chains are read. A test passes its own recorded payloads here; the
 * watcher and the reconcile script use `liveSourceReaders()`.
 */
export interface SourceChainReaders {
  solana(method: string, params: unknown[]): Promise<unknown>;
  evm(chainId: number, method: string, params: unknown[]): Promise<unknown>;
  tron(path: string): Promise<unknown>;
}

export function liveSourceReaders(): SourceChainReaders {
  return {
    async solana(method, params) {
      const res = await fetch(SOLANA_RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      if (!res.ok) throw new Error(`Solana RPC returned ${res.status}`);
      const body = (await res.json()) as { result?: unknown; error?: unknown };
      if (body.error) throw new Error(`Solana RPC error: ${JSON.stringify(body.error)}`);
      return body.result;
    },
    async evm(chainId, method, params) {
      const rpc = chainId === 8453 ? BASE_RPC : addChainParams(chainId)?.rpcUrls[0];
      if (!rpc) throw new Error(`no verified RPC for chain ${chainId}`);
      const res = await fetch(rpc, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      if (!res.ok) throw new Error(`chain ${chainId} RPC returned ${res.status}`);
      const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
      if (body.error) throw new Error(body.error.message ?? JSON.stringify(body.error));
      return body.result;
    },
    async tron(path) {
      const res = await fetch(`${TRONGRID_API}${path}`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`TronGrid returned ${res.status}`);
      return res.json();
    },
  };
}

/** Finalized transactions never change, so each is read once per process. */
const solanaTxCache = new Map<string, SolanaTx | null>();

async function solanaSignaturesSince(
  readers: SourceChainReaders,
  address: string,
  notBeforeMs: number,
): Promise<string[]> {
  const out: string[] = [];
  let before: string | undefined;
  for (let page = 0; page < 5; page += 1) {
    const result = (await readers.solana('getSignaturesForAddress', [
      address,
      { limit: 100, ...(before ? { before } : {}) },
    ])) as { signature: string; blockTime: number | null; err: unknown }[] | null;
    const list = result ?? [];
    for (const s of list) {
      if (s.err === null && s.blockTime !== null && s.blockTime * 1000 >= notBeforeMs - CLOCK_MARGIN_MS) {
        out.push(s.signature);
      }
    }
    const last = list.at(-1);
    if (list.length < 100 || !last || (last.blockTime !== null && last.blockTime * 1000 < notBeforeMs)) break;
    before = last.signature;
  }
  return out;
}

async function solanaTxs(readers: SourceChainReaders, signatures: readonly string[]): Promise<SolanaTx[]> {
  const out: SolanaTx[] = [];
  for (const sig of signatures.slice(0, 60)) {
    let tx = solanaTxCache.get(sig);
    if (tx === undefined) {
      tx = ((await readers.solana('getTransaction', [
        sig,
        { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
      ])) ?? null) as SolanaTx | null;
      if (solanaTxCache.size > 5_000) solanaTxCache.clear();
      if (tx) solanaTxCache.set(sig, tx);
    }
    if (tx) out.push(tx);
  }
  return out;
}

async function checkSolana(readers: SourceChainReaders, row: RefundRowInput, mint?: string): Promise<RefundCheck> {
  const notBeforeMs = row.createdAt;
  const depositTxs = await solanaTxs(readers, await solanaSignaturesSince(readers, row.depositAddress, notBeforeMs));
  // A native refund names `refund_to` in the transaction itself. An SPL refund credits
  // its token account, which is what has to be asked for signatures.
  let refundAccounts = [row.refundTo];
  if (mint) {
    const owned = (await readers.solana('getTokenAccountsByOwner', [
      row.refundTo,
      { mint },
      { encoding: 'jsonParsed' },
    ])) as { value?: { pubkey: string }[] } | null;
    refundAccounts = (owned?.value ?? []).map((a) => a.pubkey);
    if (refundAccounts.length === 0) return { status: 'none' };
  }
  const refundSigs: string[] = [];
  for (const account of refundAccounts) {
    refundSigs.push(...(await solanaSignaturesSince(readers, account, notBeforeMs)));
  }
  const refundToTxs = await solanaTxs(readers, [...new Set(refundSigs)]);
  const finding = findSolanaRefund({
    depositAddress: row.depositAddress,
    refundTo: row.refundTo,
    ...(mint ? { mint } : {}),
    depositTxs,
    refundToTxs,
    notBeforeMs,
    reference: BigInt(row.amountIn),
  });
  return finding ? { status: 'found', finding } : { status: 'none' };
}

/** Where each EVM scan got to, so the next poll reads only new blocks. */
const evmScanState = new Map<string, { scannedTo: bigint; logs: EvmTransferLog[] }>();
const evmStartBlock = new Map<string, bigint>();

async function evmBlockAt(readers: SourceChainReaders, chainId: number, atMs: number): Promise<bigint> {
  const key = `${chainId}:${atMs}`;
  const cached = evmStartBlock.get(key);
  if (cached !== undefined) return cached;
  const latest = BigInt((await readers.evm(chainId, 'eth_blockNumber', [])) as string);
  const target = Math.floor(atMs / 1000);
  let lo = 0n;
  let hi = latest;
  // The last block at or before `atMs`: a binary search over block timestamps.
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    const block = (await readers.evm(chainId, 'eth_getBlockByNumber', [`0x${mid.toString(16)}`, false])) as {
      timestamp: string;
    } | null;
    if (block && Number(BigInt(block.timestamp)) <= target) lo = mid;
    else hi = mid - 1n;
  }
  evmStartBlock.set(key, lo);
  return lo;
}

async function evmLogs(
  readers: SourceChainReaders,
  chainId: number,
  filter: { address: string; topics: (string | string[] | null)[] },
  fromBlock: bigint,
  maxChunks: number,
  untilBlock?: bigint,
): Promise<EvmTransferLog[]> {
  const key = `${chainId}:${JSON.stringify(filter)}:${fromBlock}`;
  const state = evmScanState.get(key) ?? { scannedTo: fromBlock - 1n, logs: [] };
  const head = BigInt((await readers.evm(chainId, 'eth_blockNumber', [])) as string);
  const latest = untilBlock !== undefined && untilBlock < head ? untilBlock : head;
  let span = 2_000n;
  let chunks = 0;
  while (state.scannedTo < latest && chunks < maxChunks) {
    const from = state.scannedTo + 1n;
    const to = from + span - 1n > latest ? latest : from + span - 1n;
    try {
      const logs = (await readers.evm(chainId, 'eth_getLogs', [
        { ...filter, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` },
      ])) as EvmTransferLog[];
      state.logs.push(...logs);
      state.scannedTo = to;
      chunks += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (span > 100n && /range|limit|too many|exceed/i.test(message)) {
        span /= 2n;
        continue;
      }
      throw error;
    }
  }
  evmScanState.set(key, state);
  return state.logs;
}

async function checkEvm(
  readers: SourceChainReaders,
  row: RefundRowInput,
  chainId: number,
  token: string,
  maxChunks: number,
): Promise<RefundCheck> {
  const fromBlock = await evmBlockAt(readers, chainId, row.createdAt - CLOCK_MARGIN_MS);
  const deposit = padAddressTopic(row.depositAddress);
  const logsFromDeposit = await evmLogs(
    readers,
    chainId,
    { address: token, topics: [ERC20_TRANSFER_TOPIC, deposit] },
    fromBlock,
    maxChunks,
  );
  const senders = new Set<string>([deposit]);
  for (const log of logsFromDeposit) if (log.topics[2]) senders.add(log.topics[2]);
  const logsToRefundTo = await evmLogs(
    readers,
    chainId,
    { address: token, topics: [ERC20_TRANSFER_TOPIC, [...senders].sort(), padAddressTopic(row.refundTo)] },
    fromBlock,
    maxChunks,
  );
  const found = findEvmRefund({
    depositAddress: row.depositAddress,
    refundTo: row.refundTo,
    logsFromDeposit,
    logsToRefundTo,
    reference: BigInt(row.amountIn),
  });
  if (!found) return { status: 'none' };
  const block = (await readers.evm(chainId, 'eth_getBlockByNumber', [`0x${found.blockNumber.toString(16)}`, false])) as {
    timestamp: string;
  } | null;
  const at = block ? Number(BigInt(block.timestamp)) * 1000 : Date.now();
  return {
    status: 'found',
    finding: { hash: found.hash, amount: found.amount, from: found.from, source: found.source, at },
  };
}

async function checkTron(readers: SourceChainReaders, row: RefundRowInput, token: string): Promise<RefundCheck> {
  const q = (address: string, direction: 'only_from' | 'only_to') =>
    `/v1/accounts/${encodeURIComponent(address)}/transactions/trc20?limit=200&${direction}=true` +
    `&contract_address=${encodeURIComponent(token)}&min_timestamp=${row.createdAt - CLOCK_MARGIN_MS}`;
  const out = (await readers.tron(q(row.depositAddress, 'only_from'))) as { data?: TronTransfer[] };
  const into = (await readers.tron(q(row.refundTo, 'only_to'))) as { data?: TronTransfer[] };
  const finding = findTronRefund({
    depositAddress: row.depositAddress,
    refundTo: row.refundTo,
    token,
    outOfDeposit: out.data ?? [],
    intoRefundTo: into.data ?? [],
    notBeforeMs: row.createdAt,
    reference: BigInt(row.amountIn),
  });
  return finding ? { status: 'found', finding } : { status: 'none' };
}

/**
 * Look for this row's refund on its source chain. `maxEvmChunks` bounds one call's
 * EVM work (each chunk is one `eth_getLogs` of up to 2,000 blocks); the scan resumes
 * where it stopped on the next call, so a poll never blocks on a long history.
 */
export async function detectSourceRefund(
  row: RefundRowInput,
  readers: SourceChainReaders = liveSourceReaders(),
  maxEvmChunks = 20,
): Promise<RefundCheck> {
  const asset = resolveSourceAsset(row.chain, row.originSymbol);
  if (!asset) return { status: 'unsupported', why: `no verified asset for ${row.originSymbol} on ${row.chain}` };
  if (!/^\d+$/.test(row.amountIn)) return { status: 'unsupported', why: 'amount sent is not on record' };
  if (asset.family === 'svm') return checkSolana(readers, row, asset.token);
  if (asset.family === 'tvm') {
    if (!asset.token) return { status: 'unsupported', why: 'native TRX refunds are not read' };
    return checkTron(readers, row, asset.token);
  }
  if (!asset.token) {
    return { status: 'unsupported', why: `native ${row.originSymbol} moves without a log; no keyless reader was verified` };
  }
  return checkEvm(readers, row, asset.chainId, asset.token, maxEvmChunks);
}

/**
 * "Did anything land at the deposit address", on any EVM chain, from the same chunked
 * scan. `untilMs` stops the scan at a point in time (the reconcile script reads each
 * address's own window rather than every block since).
 */
export async function evmLanded(
  row: Pick<RefundRowInput, 'depositAddress' | 'chain' | 'originSymbol' | 'createdAt'>,
  readers: SourceChainReaders = liveSourceReaders(),
  maxChunks = 20,
  untilMs?: number,
): Promise<{ landed: boolean; txHash?: string; scannedBlocks?: string }> {
  const asset = resolveSourceAsset(row.chain, row.originSymbol);
  if (!asset || asset.family !== 'evm' || !asset.token) return { landed: false };
  const fromBlock = await evmBlockAt(readers, asset.chainId, row.createdAt - CLOCK_MARGIN_MS);
  const untilBlock = untilMs !== undefined ? await evmBlockAt(readers, asset.chainId, untilMs) : undefined;
  const logs = await evmLogs(
    readers,
    asset.chainId,
    { address: asset.token, topics: [ERC20_TRANSFER_TOPIC, null, padAddressTopic(row.depositAddress)] },
    fromBlock,
    maxChunks,
    untilBlock,
  );
  const state = [...evmScanState.entries()].find(([k]) => k.includes(`null,"${padAddressTopic(row.depositAddress)}"`))?.[1];
  const scannedBlocks = state ? `${fromBlock}-${state.scannedTo}` : undefined;
  const hash = logs[0]?.transactionHash;
  return hash
    ? { landed: true, txHash: hash, ...(scannedBlocks ? { scannedBlocks } : {}) }
    : { landed: false, ...(scannedBlocks ? { scannedBlocks } : {}) };
}
