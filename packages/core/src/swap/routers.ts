import { getAddress, type Address, type Hex } from 'viem';
import { flowCalldataWords, KURU_FLOW_ROUTER, KURU_FLOW_SELECTOR } from '../kuru/flow.js';
import { decodeKyberSwap, KYBER_ROUTER, KYBER_SWAP_SELECTOR } from './kyberRouter.js';
import type { SwapVendorId } from './types.js';

/**
 * Every swap router the relayer will sponsor a call to, pinned in code (rule 1.9). No
 * configuration, context or request can add one. Each entry says how to read the
 * token in, token out and amount in back out of its own calldata, so the policy can
 * bind the approval to the swap it pays for.
 *
 * Kuru Flow's route is not ABI-decodable (its source is unverified); its words are read
 * at the positions measured across live quotes (`gas/policy.ts`, FLOW_WORD_*), and the
 * mandatory revoke bounds what a misread could cost. KyberSwap's is decoded against its
 * verified ABI (`kyberRouter.ts`), which also yields the recipient.
 */
export interface PinnedSwapRouter {
  readonly vendor: SwapVendorId;
  readonly address: Address;
  readonly selector: Hex;
}

export const PINNED_SWAP_ROUTERS: readonly PinnedSwapRouter[] = [
  { vendor: 'kuru-flow', address: KURU_FLOW_ROUTER, selector: KURU_FLOW_SELECTOR },
  { vendor: 'kyberswap', address: KYBER_ROUTER, selector: KYBER_SWAP_SELECTOR },
];

if (
  PINNED_SWAP_ROUTERS.length !== 2 ||
  new Set(PINNED_SWAP_ROUTERS.map((r) => r.address.toLowerCase())).size !== 2
) {
  throw new Error('the pinned swap routers must be exactly two distinct addresses');
}

export function pinnedSwapRouter(to: Address): PinnedSwapRouter | undefined {
  const lower = to.toLowerCase();
  return PINNED_SWAP_ROUTERS.find((r) => r.address.toLowerCase() === lower);
}

export function isPinnedSwapRouter(to: Address): boolean {
  return pinnedSwapRouter(to) !== undefined;
}

/** Flow's measured word positions (see `gas/policy.ts` for the four live routes). */
const FLOW_WORD_TOKEN_OUT = 0;
const FLOW_WORD_TOKEN_IN = 2;
const FLOW_WORD_AMOUNT_IN = 3;

export interface PinnedSwapRead {
  readonly router: PinnedSwapRouter;
  readonly tokenIn: Address;
  /** Only set when the word or field is a clean address (high bytes zero). A caller
   *  that decides anything from it fails closed when it is absent. */
  readonly tokenOut?: Address;
  readonly amountIn: bigint;
  /** Kyber only: the decoded receiver (zero means the caller). Flow pays the caller. */
  readonly recipient?: Address;
}

const CLEAN_ADDRESS_WORD = /^0{24}[0-9a-f]{40}$/;

/**
 * Read a pinned router's swap. `undefined` for anything that is not the router's own
 * swap selector with a readable body; the policy refuses on `undefined`.
 */
export function readPinnedSwap(to: Address, data: Hex): PinnedSwapRead | undefined {
  const router = pinnedSwapRouter(to);
  if (!router || data.length < 10 || data.slice(0, 10).toLowerCase() !== router.selector) return undefined;

  if (router.vendor === 'kyberswap') {
    try {
      const decoded = decodeKyberSwap(data);
      return {
        router,
        tokenIn: decoded.tokenIn,
        tokenOut: decoded.tokenOut,
        amountIn: decoded.amountIn,
        recipient: decoded.recipient,
      };
    } catch {
      return undefined;
    }
  }

  const words = flowCalldataWords(data);
  if (words.length <= FLOW_WORD_AMOUNT_IN) return undefined;
  const tokenInWord = words[FLOW_WORD_TOKEN_IN]?.toLowerCase() ?? '';
  const tokenOutWord = words[FLOW_WORD_TOKEN_OUT]?.toLowerCase() ?? '';
  return {
    router,
    // Low 20 bytes, as the Flow checks have always read this word; the amount word
    // must also match the approval exactly, and the revoke bounds any misread.
    tokenIn: getAddress(`0x${tokenInWord.slice(-40).padStart(40, '0')}`),
    ...(CLEAN_ADDRESS_WORD.test(tokenOutWord) ? { tokenOut: getAddress(`0x${tokenOutWord.slice(24)}`) } : {}),
    amountIn: BigInt(`0x${words[FLOW_WORD_AMOUNT_IN] ?? '0'}`),
  };
}
