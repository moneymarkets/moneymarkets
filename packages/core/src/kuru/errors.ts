import type { Hex } from 'viem';

/**
 * Typed on-chain errors and the copy the user sees (spec §4.7, design §6).
 *
 * Selectors below were derived from the ABIs in `../abi/` and cross-checked against
 * the PUSH4 constants in the deployed OrderBook, MarginAccount and Router bytecode on
 * Monad mainnet, 2026-09-02. Nothing here is a guess.
 *
 * Copy rules: state the fact and the fix. No apologies, no hex, no jargon.
 */

export type ErrorAction =
  /** Show the message, let the user retry. */
  | 'retry'
  /** Auto-correct the ticket and re-prompt. */
  | 'adjust'
  /** Refresh silently; nothing to tell the user. */
  | 'refresh'
  /** Terminal for this market. */
  | 'blocked';

export interface KuruError {
  readonly selector: Hex;
  readonly name: string;
  readonly contract: 'OrderBook' | 'MarginAccount' | 'Router' | 'shared';
  /** User-facing copy. Empty string means "say nothing, just act". */
  readonly message: string;
  readonly action: ErrorAction;
}

const ERRORS: readonly KuruError[] = [
  // ── OrderBook ────────────────────────────────────────────────────────────────
  {
    selector: '0x8199f5f3',
    name: 'SlippageExceeded',
    contract: 'OrderBook',
    message: 'Price moved before your order was filled. Review the price and try again.',
    action: 'retry',
  },
  {
    selector: '0x0a5c4f1f',
    name: 'SizeError',
    contract: 'OrderBook',
    message: 'Amount adjusted to this market’s rules.',
    action: 'adjust',
  },
  {
    selector: '0x272d3bf7',
    name: 'TickSizeError',
    contract: 'OrderBook',
    message: 'Price adjusted to this market’s rules.',
    action: 'adjust',
  },
  {
    selector: '0x91f53656',
    name: 'PriceError',
    contract: 'OrderBook',
    message: 'That price is outside what this market accepts.',
    action: 'adjust',
  },
  {
    selector: '0x06e6da4d',
    name: 'PostOnlyError',
    contract: 'OrderBook',
    message: 'That price would have filled immediately. Move it away from the spread.',
    action: 'adjust',
  },
  {
    selector: '0x004b65ba',
    name: 'MarketStateError',
    contract: 'OrderBook',
    message: 'This market is paused.',
    action: 'blocked',
  },
  {
    selector: '0x829f7240',
    name: 'OrderAlreadyFilledOrCancelled',
    contract: 'OrderBook',
    message: '',
    action: 'refresh',
  },
  {
    selector: '0xbb55fd27',
    name: 'InsufficientLiquidity',
    contract: 'OrderBook',
    message: 'Not enough liquidity for this size.',
    action: 'retry',
  },
  {
    selector: '0xff633a38',
    name: 'LengthMismatch',
    contract: 'shared',
    message: 'Something went wrong building that order. Try again.',
    action: 'retry',
  },
  {
    selector: '0x22edae45',
    name: 'ProvisionError',
    contract: 'OrderBook',
    message: 'The liquidity ladder was rejected by the market.',
    action: 'retry',
  },
  {
    selector: '0xbb2b4138',
    name: 'WrongOrderTypeCancel',
    contract: 'OrderBook',
    message: 'That order needs a different cancel. Refreshing your orders.',
    action: 'refresh',
  },
  {
    selector: '0x0b252431',
    name: 'TooMuchSizeFilled',
    contract: 'OrderBook',
    message: 'Price moved before your order was filled. Review the price and try again.',
    action: 'retry',
  },
  {
    selector: '0x3cd146b1',
    name: 'InvalidSpread',
    contract: 'OrderBook',
    message: 'That spread is not allowed on this market.',
    action: 'adjust',
  },
  {
    selector: '0xa9269545',
    name: 'MarketFeeError',
    contract: 'OrderBook',
    message: 'This market rejected the fee settings.',
    action: 'blocked',
  },
  {
    selector: '0xfd993161',
    name: 'NativeAssetInsufficient',
    contract: 'OrderBook',
    message: 'Not enough MON was sent with that order.',
    action: 'retry',
  },
  {
    selector: '0xead59376',
    name: 'NativeAssetNotRequired',
    contract: 'OrderBook',
    message: 'That order does not take MON.',
    action: 'retry',
  },
  {
    selector: '0x70d7ec56',
    name: 'NativeAssetTransferFail',
    contract: 'OrderBook',
    message: 'The MON transfer did not go through. Nothing was spent.',
    action: 'retry',
  },
  {
    selector: '0xb1460438',
    name: 'OnlyVaultAllowed',
    contract: 'OrderBook',
    message: 'That action is reserved for this market’s vault.',
    action: 'blocked',
  },
  {
    selector: '0xa0cdd781',
    name: 'OnlyOwnerAllowedError',
    contract: 'OrderBook',
    message: 'That action is reserved for the market owner.',
    action: 'blocked',
  },

  // ── MarginAccount ────────────────────────────────────────────────────────────
  {
    selector: '0xf4d678b8',
    name: 'InsufficientBalance',
    contract: 'MarginAccount',
    message: 'Not enough in your trading balance. Add money and try again.',
    action: 'retry',
  },
  {
    selector: '0x44279255',
    name: 'ProtocolPaused',
    contract: 'MarginAccount',
    message: 'Trading is paused right now.',
    action: 'blocked',
  },
  {
    selector: '0xe8430787',
    name: 'OnlyVerifiedMarketsAllowed',
    contract: 'MarginAccount',
    message: 'That market is not recognised.',
    action: 'blocked',
  },
  {
    selector: '0xe84c4d58',
    name: 'OnlyRouterAllowed',
    contract: 'MarginAccount',
    message: 'That action has to go through the router.',
    action: 'blocked',
  },
  {
    selector: '0xcd41a9e3',
    name: 'NativeAssetMismatch',
    contract: 'MarginAccount',
    message: 'The MON amount did not match the deposit.',
    action: 'retry',
  },

  // ── Router ───────────────────────────────────────────────────────────────────
  {
    selector: '0x9db8d5b1',
    name: 'InvalidMarket',
    contract: 'Router',
    message: 'That market is not recognised.',
    action: 'blocked',
  },
  {
    selector: '0x130e7978',
    name: 'BaseAndQuoteAssetSame',
    contract: 'Router',
    message: 'A market needs two different assets.',
    action: 'blocked',
  },
  {
    selector: '0xa7bee359',
    name: 'InvalidPricePrecision',
    contract: 'Router',
    message: 'That price precision is not allowed.',
    action: 'adjust',
  },
  {
    selector: '0xa80624d6',
    name: 'InvalidSizePrecision',
    contract: 'Router',
    message: 'That size precision is not allowed.',
    action: 'adjust',
  },
  {
    selector: '0x747a60fb',
    name: 'InvalidTickSize',
    contract: 'Router',
    message: 'That tick size is not allowed.',
    action: 'adjust',
  },
  {
    selector: '0xe233e012',
    name: 'Uint96Overflow',
    contract: 'Router',
    message: 'That amount is too large for this market.',
    action: 'adjust',
  },

  // ── Shared (Solady / OZ) ─────────────────────────────────────────────────────
  {
    selector: '0x82b42900',
    name: 'Unauthorized',
    contract: 'shared',
    message: 'That action is not available to your account.',
    action: 'blocked',
  },
  {
    selector: '0x7939f424',
    name: 'TransferFromFailed',
    contract: 'shared',
    message: 'The token transfer did not go through. Check your balance and approval.',
    action: 'retry',
  },
  {
    selector: '0x90b8ec18',
    name: 'TransferFailed',
    contract: 'shared',
    message: 'The token transfer did not go through.',
    action: 'retry',
  },
];

const BY_SELECTOR = new Map<string, KuruError>(ERRORS.map((e) => [e.selector.toLowerCase(), e]));

export const KURU_ERRORS = ERRORS;

/**
 * Decode revert data into a typed error. Returns `undefined` for revert data this
 * table does not know, which the caller must surface as an unknown failure rather
 * than as a guess.
 */
export function decodeKuruError(revertData: Hex | undefined): KuruError | undefined {
  if (!revertData || revertData.length < 10) return undefined;
  return BY_SELECTOR.get(revertData.slice(0, 10).toLowerCase());
}

/**
 * The single string to put in front of the user. Never a hex selector (design §6):
 * an unknown revert gets a plain sentence, and the selector goes to the logs.
 */
export function userMessageFor(revertData: Hex | undefined): string {
  const known = decodeKuruError(revertData);
  if (known) return known.message;
  return 'That did not go through. Nothing was spent. Try again in a moment.';
}

/**
 * The verbatim line that goes UNDER the plain copy: the venue's own answer, named.
 *
 * Error-handling rule (owner instruction, 2026-09-08): an upstream reason is never
 * masked — the plain sentence leads, and the source's own words follow beneath it.
 * For a revert this table knows, that is the decoded error name; for one it does
 * not, it is the raw selector — showing it is what lets a user report something an
 * operator can actually look up, and it is confined to this secondary line, never
 * the lead. This deliberately supersedes the older blanket "no hex anywhere" reading
 * of design §6 for this one line; the conflict and the instruction are logged in
 * DECISIONS.md.
 */
export function kuruDetailFor(revertData: Hex | undefined): string | undefined {
  if (!revertData || revertData.length < 10) return undefined;
  const known = decodeKuruError(revertData);
  if (known) return `Kuru answered: ${known.name}`;
  return `Kuru answered with revert data this build does not recognise: ${revertData.slice(0, 10)}`;
}

/**
 * `ProtocolPaused` on MarginAccount.
 *
 * Named because screens branch on it: when Kuru pauses, every deposit and every order
 * reverts with this and the honest thing to show is "the venue has paused", not a
 * failure of ours and never the raw selector.
 */
export const PROTOCOL_PAUSED_SELECTOR = '0x44279255' as const;
