/**
 * Where a user's money can come from (design §5.3).
 *
 * The four tiles are the design's four. What is *not* here is an asset id, a fee or
 * an ETA: those are read live — asset ids from the solver network's own token list,
 * fee and ETA from the quote it returns for the amount the user actually typed. A
 * tile that carried "~1 min" before anything was quoted would be a number nobody
 * measured.
 *
 * `refund` is the load-bearing field. 1Click rejects a `refundTo` that is not on the
 * **origin** chain — an EVM address for a Tron deposit comes back
 * `"refundTo is not valid"`, measured 2026-09-02 — so each source knows what shape
 * of address it needs before a quote can be asked for at all.
 */

export type SourceKey = 'usdt-tron' | 'usdc-base' | 'sol-solana' | 'ausd-base';

/** What a `refundTo` must look like for this origin chain. */
export type RefundKind =
  /** Base58, 34 characters, leading `T`. */
  | 'tron'
  /** A 20-byte address. The user's own account works: same key, different chain. */
  | 'evm'
  /** Base58 ed25519 public key. */
  | 'solana';

export interface FundSource {
  readonly key: SourceKey;
  /** Symbol on the origin chain. */
  readonly symbol: string;
  /** Chain in the user's words. No chain ids in the consumer app (design §6). */
  readonly chain: string;
  /** Coin chip colour (design §3). */
  readonly color: string;
  readonly refund: RefundKind;
  /**
   * `intents` routes through the 1Click solver network and lands USDC on Monad.
   * `oft` is AUSD's own LayerZero bridge, which is a different mechanism entirely.
   */
  readonly route: 'intents' | 'oft';
  /** Symbol as it arrives on Monad. */
  readonly arrivesAs: string;
}

export const FUND_SOURCES: readonly FundSource[] = [
  {
    key: 'usdt-tron',
    symbol: 'USDT',
    chain: 'Tron',
    color: '#26A17B',
    refund: 'tron',
    route: 'intents',
    arrivesAs: 'USDC',
  },
  {
    key: 'usdc-base',
    symbol: 'USDC',
    chain: 'Base',
    color: '#2775CA',
    refund: 'evm',
    route: 'intents',
    arrivesAs: 'USDC',
  },
  {
    key: 'sol-solana',
    symbol: 'SOL',
    chain: 'Solana',
    color: '#9945FF',
    refund: 'solana',
    route: 'intents',
    arrivesAs: 'USDC',
  },
  {
    key: 'ausd-base',
    symbol: 'AUSD',
    chain: 'Base',
    color: '#111827',
    refund: 'evm',
    route: 'oft',
    arrivesAs: 'AUSD',
  },
];

export function sourceFor(key: string): FundSource | undefined {
  return FUND_SOURCES.find((s) => s.key === key);
}

export function sourceLabel(source: FundSource): string {
  return `${source.symbol} on ${source.chain}`;
}

/**
 * Address shape checks, so an obviously wrong address is caught before a round trip.
 *
 * These are shape tests, not validity tests: they do not verify a Base58 checksum
 * and they are not the authority. 1Click is, and its refusal is surfaced as its own
 * failure state.
 */
export function looksLikeRefundAddress(kind: RefundKind, value: string): boolean {
  const v = value.trim();
  if (kind === 'tron') return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(v);
  if (kind === 'evm') return /^0x[0-9a-fA-F]{40}$/.test(v);
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);
}

/** What the user is asked for, when the app cannot supply it itself. */
export function refundPrompt(kind: RefundKind): string {
  if (kind === 'tron') return 'Your Tron address';
  if (kind === 'solana') return 'Your Solana address';
  return 'Your address on Base';
}
