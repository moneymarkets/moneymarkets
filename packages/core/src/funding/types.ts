import type { Address } from 'viem';

/**
 * The one interface every funding rail implements.
 *
 * The router and the UI know nothing about a rail beyond this file. That is the point:
 * adding a seventh rail should touch a route table and one new module, and nothing
 * else. It also means every rail is held to the same rules, which are stated here
 * rather than repeated in six places.
 *
 * ## Rules that hold for every rail, without exception
 *
 * - **The recipient is always the signed-in account.** Asserted before a quote is
 *   returned and again before anything is executed. A rail that cannot honour that
 *   does not get to be a rail.
 * - **A refusal is the vendor's own sentence.** `Decline.reason` is passed through
 *   verbatim, with the vendor named. No rail translates, softens or summarises — a
 *   user who is told "minimum swap amount is $1,000" can act on it; a user told
 *   "this route is unavailable" cannot.
 * - **No rail encodes a minimum, a fee or an ETA.** Those are answers, and they come
 *   back live. A number written into this codebase is a number that will be wrong.
 * - **`raw` carries the vendor's response untouched**, so a stored row can always be
 *   read back as what the vendor actually said rather than as our reading of it.
 */

/** Rails that exist. A rail that fails verification stays in this union and declines. */
export type RailId =
  | 'relay'
  | 'cctp'
  | 'oft-ausd'
  | 'oft-usdt0'
  | 'across'
  | 'near'
  | 'debridge'
  | 'mayan';

/**
 * Decimals of each token this app can receive on Monad.
 *
 * Read from the tokens themselves: USDC and USDT0 both answered `decimals() = 6` on
 * chain 143, AUSD is 6, MON is the native 18.
 *
 * It exists because the funding card was formatting the **destination** amount with the
 * **source** asset's decimals. Base USDC is 6 and so is Monad USDC, so it looked right
 * everywhere it was tested — and a BSC USDC deposit, where the source is 18, would have
 * rendered "you receive" as `0.000000`. Two different tokens' decimals are not
 * interchangeable just because they usually match.
 */
export const MONAD_TOKEN_DECIMALS: Readonly<Record<MonadToken, number>> = {
  USDC: 6,
  USDT0: 6,
  AUSD: 6,
  MON: 18,
};

/** What a rail can deliver on Monad. Verified per rail; see reports/RAILS-VERIFY.md. */
export type MonadToken = 'USDC' | 'AUSD' | 'USDT0' | 'MON';

export interface SourceChain {
  /** Numeric for EVM; Relay's own ids for the non-EVM chains it lists. */
  readonly id: number;
  /** Lower-case key used in URLs and route tables: `base`, `solana`, `tron`. */
  readonly key: string;
  readonly displayName: string;
  readonly vm: 'evm' | 'svm' | 'tvm' | 'btc';
}

export interface SourceAsset {
  readonly symbol: string;
  /** Contract address on the source chain, or the chain's native sentinel. */
  readonly address: string;
  readonly decimals: number;
}

export interface FundingRequest {
  readonly sourceChain: SourceChain;
  readonly sourceAsset: SourceAsset;
  /** Base units of the source asset. bigint, like every other amount in this repo. */
  readonly amount: bigint;
  /** Always the signed-in account. Every rail asserts this. */
  readonly recipient: Address;
  /**
   * The address the money will leave from, when it is not an EVM address.
   *
   * Relay validates `user` against the **origin** chain: an EVM address on a Solana
   * origin is rejected outright ("Invalid address 0x714f… for chain 792703809"). For a
   * deposit-address flow the user has not told us their source address, so this is
   * only set where a caller knows it. It never changes where the money lands —
   * `recipient` does that, and every rail asserts it.
   */
  readonly senderAddress?: string;
  /** True when the caller would rather land in the MarginAccount than the wallet. */
  readonly wantsMargin: boolean;
}

export interface QuoteFee {
  /** The vendor's own label, not ours. "relayerService", "capitalFee", "nativeFee". */
  readonly label: string;
  readonly amount: bigint;
  readonly token: string;
  /** The vendor's own USD figure where it gave one. Never computed by us. */
  readonly usd?: string;
}

export interface Quote {
  readonly rail: RailId;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly outToken: MonadToken;
  readonly fees: readonly QuoteFee[];
  readonly etaSeconds: number;
  /** Unix ms. Nothing is cached past this. */
  readonly expiresAt: number;
  /**
   * Where the money arrives.
   *
   * `'margin'` only where the vendor itself confirmed it will make the deposit call.
   * Verified for Relay on 2026-09-11; every other rail lands in the wallet and the
   * Move card finishes the job, gaslessly.
   */
  readonly landsIn: 'wallet' | 'margin';
  /**
   * Whether this quote can actually be acted on today.
   *
   * A quote the user cannot execute is not a better offer than one they can, however
   * good the number is. Across prices Base USDC better than Relay and cannot send
   * without a connected wallet, so ranking on `amountOut` alone put an unusable rail at
   * the top of the card and hid the one that works.
   */
  readonly executable: boolean;
  /**
   * Whether acting on this quote requires the user to sign on the source chain.
   *
   * **This is the first sort key, ahead of price.** A deposit-address rail asks the user
   * to send from wherever their money already is — no wallet, no extension, no
   * signature, nothing to install. A wallet-signed rail asks them to connect a wallet
   * they may not have and approve two transactions they must pay gas for.
   *
   * Those are not two prices for the same thing, and treating them as comparable put a
   * rail needing a browser extension at the top of a screen whose whole premise is that
   * the user has an account and nothing else. CCTP prices Base USDC better than every
   * deposit-address rail and still must not lead: the cheaper number costs a wallet.
   *
   * The wallet-signed rails are real and stay available — behind a section the user
   * opens deliberately, each labelled with the chain it wants a signature on.
   */
  readonly needsWallet: boolean;
  /** The vendor's response, stored verbatim. */
  readonly raw: unknown;
}

export interface Decline {
  readonly rail: RailId;
  /** The vendor's message, verbatim. */
  readonly reason: string;
  readonly raw: unknown;
}

export function isQuote(v: Quote | Decline): v is Quote {
  return (v as Quote).amountOut !== undefined;
}

/** A rail the user funds by sending to an address, rather than by signing. */
export interface DepositInstruction {
  readonly kind: 'deposit-address';
  readonly rail: RailId;
  readonly address: string;
  readonly chain: SourceChain;
  readonly asset: SourceAsset;
  readonly amount: bigint;
  /** Unix ms after which the address should not be used. */
  readonly expiresAt: number;
  /**
   * Set when the vendor will not refund automatically and needs somewhere to send a
   * failed deposit. Observed true for Relay on Tron; the UI must ask before showing
   * the address.
   */
  readonly refundAddressRequired: boolean;
  readonly raw: unknown;
}

/** One transaction the user's own wallet must sign on the source chain. */
export interface SourceTx {
  readonly chainId: number;
  readonly to: string;
  readonly data: string;
  readonly value: string;
  /** Shown before signing so an approval is never a surprise. */
  readonly label: string;
}

export interface SourceTxPlan {
  readonly kind: 'wallet-signed';
  readonly rail: RailId;
  readonly chain: SourceChain;
  /** Approvals first, then the transfer. Order is the order to sign in. */
  readonly txs: readonly SourceTx[];
  readonly raw: unknown;
}

export type ExecutionPlan = DepositInstruction | SourceTxPlan;

/** What the watcher stores to find this transfer again at the vendor. */
export interface RailRef {
  readonly rail: RailId;
  /** requestId, attestation key, OFT guid — whatever the vendor keys on. */
  readonly ref: string;
  readonly sourceChainId?: number;
  readonly sourceTxHash?: string;
}

export type RailState =
  | 'awaiting-source'
  | 'source-seen'
  | 'in-flight'
  | 'delivered'
  | 'refunded'
  | 'failed';

export interface RailStatus {
  readonly state: RailState;
  /** The vendor's own words for the current state, when it gave any. */
  readonly message?: string;
  readonly sourceTxHash?: string;
  readonly destinationTxHash?: string;
  readonly amountOut?: bigint;
  /** Always stored, so a row can be read back as what the vendor said. */
  readonly raw: unknown;
}

export interface Rail {
  readonly id: RailId;
  /** The vendor's name as the user should see it. Shown wherever its price is. */
  readonly displayName: string;
  /** One line explaining what this rail does, for the route card. */
  readonly explainer: string;
  /** Synchronous route-table check. No network. */
  supports(req: FundingRequest): boolean;
  quote(req: FundingRequest, signal: AbortSignal): Promise<Quote | Decline>;
  /** Exactly one of these two is defined per rail. */
  depositAddress?(quote: Quote, refundAddress?: string): Promise<DepositInstruction>;
  buildSourceTx?(quote: Quote): Promise<SourceTxPlan>;
  status(ref: RailRef): Promise<RailStatus>;
}

/**
 * The assertion every rail runs before quoting and before executing (R4).
 *
 * Cheap, and the one thing that must never be skipped: a funding rail that can be
 * talked into delivering somewhere other than the signed-in account is the whole
 * product failing at once.
 */
export function assertRecipient(req: { recipient: Address }, signedIn: Address): void {
  if (req.recipient.toLowerCase() !== signedIn.toLowerCase()) {
    throw new Error(
      `funding recipient ${req.recipient} is not the signed-in account ${signedIn}`,
    );
  }
}
