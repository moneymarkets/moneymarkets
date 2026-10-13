import type { Hex } from 'viem';
import type { RawLevel } from './book.js';

/**
 * Decoder for `OrderBook.getL2Book()`.
 *
 * The ABI declares a single `bytes` return with no structure, so the layout below was
 * read off the live venue rather than guessed (rule A2.5). Measured on Monad mainnet
 * 2026-09-02 against MON/USDC `0x065C9d28…` and MON/AUSD `0x131a2e70…`:
 *
 *   word 0            block number the snapshot was taken at
 *   words 1..n        (price, size) pairs, bids, descending by price
 *   one zero word     terminates the bid section
 *   words n+2..end    (price, size) pairs, asks, ascending by price
 *
 * The blob length is not fixed (260 words for MON/USDC, 256 for MON/AUSD in the same
 * pair of blocks), and exactly one zero word appears in it.
 *
 * Scales, both confirmed against a live `@monadDepth` frame for the same market and
 * block range:
 *
 *   price  `pricePrecision` units — NOT the 1e18 wire scale the websocket uses.
 *          MON/USDC returned 2541800 where the socket said "25496000000000000".
 *   size   `sizePrecision` units — the same units the socket uses and the same units
 *          `addBuyOrder` takes. MON/USDC returned 983650000000000 against the
 *          socket's 981000000000000 two blocks later.
 *
 * That price difference is why `BookSource` has a separate `contract-getL2Book`
 * member: feeding these numbers in as if they were wire prices would misprice the
 * whole screen by 1e10.
 */

export interface DecodedL2Book {
  readonly blockNumber: bigint;
  /** Prices in `pricePrecision` units, sizes in `sizePrecision` units. */
  readonly bids: readonly RawLevel[];
  readonly asks: readonly RawLevel[];
}

const WORD_CHARS = 64;

export class L2BookLayoutError extends Error {
  constructor(message: string) {
    super(`getL2Book returned a blob this decoder does not recognise: ${message}`);
    this.name = 'L2BookLayoutError';
  }
}

export function decodeL2Book(blob: Hex): DecodedL2Book {
  const hex = blob.startsWith('0x') ? blob.slice(2) : blob;
  if (hex.length === 0) throw new L2BookLayoutError('empty');
  if (hex.length % WORD_CHARS !== 0) {
    throw new L2BookLayoutError(`${hex.length / 2} bytes is not a whole number of words`);
  }

  const words: bigint[] = [];
  for (let i = 0; i < hex.length; i += WORD_CHARS) {
    words.push(BigInt(`0x${hex.slice(i, i + WORD_CHARS)}`));
  }

  const blockNumber = words[0];
  if (blockNumber === undefined) throw new L2BookLayoutError('no block number word');

  const separator = words.indexOf(0n, 1);
  if (separator === -1) {
    throw new L2BookLayoutError('no zero word separating bids from asks');
  }

  return {
    blockNumber,
    bids: pairs(words.slice(1, separator), 'bid'),
    asks: pairs(words.slice(separator + 1), 'ask'),
  };
}

function pairs(words: readonly bigint[], side: string): RawLevel[] {
  if (words.length % 2 !== 0) {
    throw new L2BookLayoutError(`${side} section has ${words.length} words, which is not pairs`);
  }
  const out: RawLevel[] = [];
  for (let i = 0; i < words.length; i += 2) {
    const price = words[i];
    const size = words[i + 1];
    if (price === undefined || size === undefined) continue;
    if (price === 0n || size === 0n) continue;
    out.push({ price, size });
  }
  return out;
}
