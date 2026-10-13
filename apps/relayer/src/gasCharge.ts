import {
  decodeEventLog,
  encodeEventTopics,
  getAddress,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { entryPoint08Abi } from 'viem/account-abstraction';
import { z } from 'zod';
import type { FeePaidWatch } from './prefund.js';
import {
  ENTRY_POINT_V08,
  PUBLIC_RPC_GET_LOGS_MAX_RANGE,
  FREE_ACTIONS_PER_DAY,
  freeActionHeadroom,
  GAS_FEE_TOKENS,
  GAS_VALUATION,
  gasFeeTokenFor,
  marginDepositsTo,
  MAX_GAS_FEE,
  operationGasFee,
  readQuoteUsdPrice,
  SPONSORED_TRANSFER_FORBIDDEN_RECIPIENTS,
  type FreeActionHeadroom,
  type GasEnvelope,
  type GasFeePricing,
  type QuotePriceReader,
  type QuoteValuation,
  type SponsoredCall,
} from '@tradepro/core';
import type { RelayerDb } from './db.js';

/**
 * The relayer's half of "free actions, then gas at cost" (2026-09-24): what it reads, and
 * what it remembers between pricing a fee and verifying one.
 *
 * The arithmetic is `@tradepro/core`'s (`gasFee.ts`), shared with the browser. Which
 * batches may carry a fee leg is the policy's (`splitFeeLeg`, `assertSponsorable`). This
 * file holds the two things only the relayer has: the chain reads the fee is priced from,
 * and the pricing it handed out, so that the fee it verifies at send is recomputed from
 * the very numbers the client was given rather than from a base fee and a mid that moved in
 * between.
 */

/**
 * How long a pricing stays good. The client prices, builds, signs and sends inside this.
 * Two minutes is generous for a tap-to-send path measured in seconds, and short enough that
 * a price moved in between costs at most a rounding step. Past it the send is refused with
 * GAS_FEE_QUOTE_EXPIRED and the client asks again.
 */
export const FEE_PRICING_TTL_MS = 120_000;

/**
 * Bound on remembered pricings. One is added per distinct (base fee, mid) the relayer reads
 * while quoting, and each lives two minutes, so this is far above what 400 ms blocks can
 * produce in that time; it only stops a flood of quotes from growing memory.
 */
const MAX_PRICINGS = 1_000;

export interface RecordedPricing extends GasFeePricing {
  readonly quotedAt: number;
  readonly expiresAt: number;
}

/**
 * Every pricing this relayer has read and handed out in the last `FEE_PRICING_TTL_MS`, in
 * memory, newest last.
 *
 * Deliberately not one slot per sender. `/v1/gas/quote` is unauthenticated, so a slot per
 * sender let anyone quote a victim's address and replace the pricing the victim's own
 * signed fee was computed from, refusing every paid action the victim sent. A pricing
 * carries nothing about who asked: it is two numbers the relayer read from the chain. So a
 * send is accepted when its fee is the relayer's computation at any pricing it read in the
 * last two minutes. What a client gains by choosing among them is the difference between
 * two readings of the same book minutes apart, at a 0.001 step, against a 0.005 minimum.
 *
 * In memory rather than in SQLite on purpose: a restart forgets every pricing, and each paid
 * send is refused until its client asks again, which fails toward charging correctly
 * rather than toward a stale number.
 */
export class FeePricingBook {
  #entries: RecordedPricing[] = [];

  record(pricing: GasFeePricing, now: number): RecordedPricing {
    this.#prune(now);
    const entry: RecordedPricing = {
      ...pricing,
      quotedAt: now,
      expiresAt: now + FEE_PRICING_TTL_MS,
    };
    // The same two numbers again: renew them rather than keep a second copy.
    this.#entries = this.#entries.filter(
      (e) => e.baseFeePerGas !== pricing.baseFeePerGas || e.monUsdMid !== pricing.monUsdMid,
    );
    this.#entries.push(entry);
    if (this.#entries.length > MAX_PRICINGS) this.#entries.shift();
    return entry;
  }

  /** Every pricing still good at `now`, newest first. */
  recent(now: number): readonly RecordedPricing[] {
    this.#prune(now);
    return [...this.#entries].reverse();
  }

  #prune(now: number): void {
    this.#entries = this.#entries.filter((e) => now < e.expiresAt);
  }
}

const marginGetBalanceAbi = [
  {
    type: 'function',
    name: 'getBalance',
    stateMutability: 'view',
    inputs: [
      { name: '_user', type: 'address' },
      { name: '_token', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const;

/**
 * USDC and AUSD in `sender`'s trading balance, read from the MarginAccount's own
 * `getBalance(user, token)` (the ABI entry in `abi/marginAccount.ts`, and the same read
 * `/api/account/balances` makes). `undefined` when either read fails: a balance that could
 * not be read is not zero, and the caller must not refuse or charge on it.
 */
export async function readMarginDollars(
  client: PublicClient,
  marginAccount: Address,
  sender: Address,
): Promise<{ USDC: bigint; AUSD: bigint } | undefined> {
  const [usdc, ausd] = GAS_FEE_TOKENS;
  try {
    const [usdcBalance, ausdBalance] = await Promise.all(
      [usdc!, ausd!].map(
        (token) =>
          client.readContract({
            address: marginAccount,
            abi: marginGetBalanceAbi,
            functionName: 'getBalance',
            args: [sender, token.asset],
          }) as Promise<bigint>,
      ),
    );
    if (typeof usdcBalance !== 'bigint' || typeof ausdBalance !== 'bigint') return undefined;
    return { USDC: usdcBalance, AUSD: ausdBalance };
  } catch {
    return undefined;
  }
}

/**
 * The trading balance a batch can pay its fee from: what is in margin now, plus what the
 * batch's own deposits credit to the sender (`marginDepositsTo`). The same figure on the
 * quote, on the refusal and on the send, so the three never disagree about the token.
 */
export function withBatchDeposits(
  balances: { readonly USDC: bigint; readonly AUSD: bigint },
  actions: readonly SponsoredCall[],
  marginAccount: Address,
  sender: Address,
): { USDC: bigint; AUSD: bigint } {
  const credited = marginDepositsTo(actions, marginAccount, sender);
  const [usdc, ausd] = GAS_FEE_TOKENS;
  return {
    USDC: balances.USDC + (credited.get(usdc!.asset.toLowerCase()) ?? 0n),
    AUSD: balances.AUSD + (credited.get(ausd!.asset.toLowerCase()) ?? 0n),
  };
}

const blockSchema = z.looseObject({ baseFeePerGas: z.string().regex(/^0x[0-9a-fA-F]+$/) });

/** The latest block's base fee, or undefined when it cannot be read. No fallback figure. */
export async function readBaseFee(client: PublicClient): Promise<bigint | undefined> {
  try {
    const raw = await client.request({
      method: 'eth_getBlockByNumber',
      params: ['latest', false],
    } as never);
    return BigInt(blockSchema.parse(raw).baseFeePerGas);
  } catch {
    return undefined;
  }
}

/**
 * The two live numbers a fee is priced from: the latest block's base fee and the MON/USDC
 * mid (`readQuoteUsdPrice`, the same read the order cap values MON with). `undefined` when
 * either cannot be read; there is no fallback figure.
 */
export async function readFeePricing(
  client: PublicClient,
  priceReader: QuotePriceReader,
): Promise<GasFeePricing | undefined> {
  const [block, mid] = await Promise.all([
    readBaseFee(client),
    readQuoteUsdPrice(priceReader, GAS_VALUATION),
  ]);
  if (block === undefined || mid === undefined) return undefined;
  return { baseFeePerGas: block, monUsdMid: mid };
}

export type FeeVerdict =
  /** The fee leg is the relayer's figure at one of its pricings, in the token that pays it. */
  | { readonly kind: 'match'; readonly token: QuoteValuation; readonly amount: bigint }
  /** It is not. `expected` is the figure at the newest pricing, for the refusal to name. */
  | { readonly kind: 'mismatch'; readonly expected: { readonly token: QuoteValuation; readonly amount: bigint } }
  /** At the newest pricing the trading balance cannot cover the fee in either token. */
  | { readonly kind: 'cannot-pay' }
  /** No pricing gives a fee this relayer may charge (no mid, or above `MAX_GAS_FEE`). */
  | { readonly kind: 'unpriced' };

/**
 * Judge a charged send's fee leg: recompute the fee for the operation exactly as signed at
 * every pricing still good, newest first, and accept the leg only if it is one of those
 * figures, in the token `gasFeeTokenFor` picks for that figure from the live balances.
 *
 * The leg's amount is compared, never used: the only amounts that can pass are ones this
 * function computed. The caller still runs `assertSponsorable` with the matched figure.
 */
export function judgeFeeLeg(
  op: GasEnvelope,
  pricings: readonly GasFeePricing[],
  balances: { readonly USDC: bigint; readonly AUSD: bigint },
  leg: { readonly token: Address; readonly amount: bigint },
): FeeVerdict {
  let newest: { token: QuoteValuation; amount: bigint } | undefined;
  let newestCannotPay = false;
  for (const [index, pricing] of pricings.entries()) {
    const fee = operationGasFee(op, pricing);
    if (fee === undefined || fee > MAX_GAS_FEE) continue;
    const token = gasFeeTokenFor(balances, fee);
    if (index === 0) {
      if (token) newest = { token, amount: fee };
      else newestCannotPay = true;
    }
    if (token && token.asset.toLowerCase() === leg.token.toLowerCase() && fee === leg.amount) {
      return { kind: 'match', token, amount: fee };
    }
  }
  if (newestCannotPay) return { kind: 'cannot-pay' };
  if (!newest) return { kind: 'unpriced' };
  return { kind: 'mismatch', expected: newest };
}

const USER_OPERATION_EVENT_TOPIC = encodeEventTopics({
  abi: entryPoint08Abi,
  eventName: 'UserOperationEvent',
})[0]!;

/**
 * The durable backstop's view of the chain (D172): the latest block, and one `eth_getLogs`
 * for an operation's `UserOperationEvent` in the window it should land in.
 *
 * The window is `PUBLIC_RPC_GET_LOGS_MAX_RANGE` (100) blocks, about 40 seconds on Monad,
 * starting just before the top-up: the relayer submits the operation straight after
 * funding it, so one that has not landed by then is not going to land where it was sent.
 * One read, never paged, so the check stays cheap under the relayer key's lock. A read that
 * fails is `unavailable`, which the gate treats as not landed.
 */
export function liveFeePaidWatch(client: PublicClient): FeePaidWatch {
  const latestBlock = async (): Promise<bigint | undefined> => {
    try {
      const raw = await client.request({ method: 'eth_blockNumber' } as never);
      return typeof raw === 'string' && /^0x[0-9a-fA-F]+$/.test(raw) ? BigInt(raw) : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    latestBlock,
    async findEvent(userOpHash, fromBlock) {
      const latest = await latestBlock();
      if (latest === undefined) return { status: 'unavailable' };
      const windowEnd = fromBlock + PUBLIC_RPC_GET_LOGS_MAX_RANGE - 1n;
      const toBlock = latest < windowEnd ? latest : windowEnd;
      if (toBlock < fromBlock) return { status: 'pending' };
      try {
        const raw = await client.request({
          method: 'eth_getLogs',
          params: [
            {
              address: ENTRY_POINT_V08,
              topics: [USER_OPERATION_EVENT_TOPIC, userOpHash],
              fromBlock: toHex(fromBlock),
              toBlock: toHex(toBlock),
            },
          ],
        } as never);
        const logs = z
          .array(
            z.looseObject({
              address: z.string(),
              topics: z.array(z.string()),
              data: z.string(),
              // A mined log carries both. Without them the burn cannot be placed or traced to
              // a bundle, so the operation is not taken as landed (fail-safe: nothing paid).
              blockNumber: z.string().regex(/^0x[0-9a-fA-F]+$/).optional(),
              transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
            }),
          )
          .parse(raw);
        for (const log of logs) {
          if (log.address.toLowerCase() !== ENTRY_POINT_V08.toLowerCase()) continue;
          const decoded = decodeEventLog({
            abi: entryPoint08Abi,
            data: log.data as Hex,
            topics: log.topics as [Hex, ...Hex[]],
          });
          if (decoded.eventName !== 'UserOperationEvent') continue;
          const args = decoded.args as { userOpHash: Hex; success: boolean; actualGasCost: bigint };
          if (args.userOpHash.toLowerCase() !== userOpHash.toLowerCase()) continue;
          if (!log.blockNumber || !log.transactionHash) return { status: 'unavailable' };
          // The gas it burned, for the rule that a later paid top-up only replaces burned gas
          // (D172, scenario H). Same event, same read: nothing else is asked of the chain.
          return {
            status: 'landed',
            success: args.success,
            actualGasCost: args.actualGasCost,
            block: BigInt(log.blockNumber),
            txHash: log.transactionHash as Hex,
          };
        }
        return { status: latest > windowEnd ? 'missed' : 'pending' };
      } catch {
        return { status: 'unavailable' };
      }
    },
  };
}

/** An account's free actions, from the ledger alone. No chain read. */
export function freeActionsOf(db: RelayerDb, sender: Address, now: number): FreeActionHeadroom {
  return freeActionHeadroom(db.freeActionUsage(sender, now), FREE_ACTIONS_PER_DAY);
}

/** The wire form of `FreeActionHeadroom`: numbers stay numbers, times are epoch ms. */
export function freeActionsBody(h: FreeActionHeadroom) {
  return {
    limit: h.limit,
    used: h.used,
    remaining: h.remaining,
    resetsAt: h.resetsAt ?? null,
    allFreeAt: h.allFreeAt ?? null,
  };
}

/**
 * Where fees are paid, checked once at boot. A recipient that is a contract this app
 * knows (a token, the MarginAccount, an order book, the EntryPoint) would be a fee that
 * lands nowhere anyone can reach, so it refuses to start rather than charge into one.
 */
export function assertFeeRecipient(recipient: string): Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(recipient) || /^0x0{40}$/.test(recipient)) {
    throw new Error('the relayer fee address is not a usable address');
  }
  if (SPONSORED_TRANSFER_FORBIDDEN_RECIPIENTS.includes(recipient.toLowerCase())) {
    throw new Error('the relayer fee address is a contract this app knows; fees would be lost');
  }
  return getAddress(recipient);
}

const hexOrDecimal = z
  .string()
  .regex(/^(0x[0-9a-fA-F]{1,64}|[0-9]{1,78})$/)
  .transform((v) => BigInt(v));

/** `POST /v1/gas/quote`. The action only: a batch that already carries a fee leg is refused. */
export const gasQuoteBodySchema = z.object({
  sender: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  calls: z
    .array(
      z.object({
        to: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
        data: z.string().regex(/^0x([0-9a-fA-F]{2})*$/),
        // Native value, decimal wei. Quoted exactly as it will be sent, so the policy
        // judges the WMON wrap (the only call it lets carry value) as it really is.
        value: z
          .string()
          .regex(/^\d{1,78}$/)
          // Security review F3: 78 digits admits numbers above uint256.
          .refine((v) => BigInt(v) < 2n ** 256n, 'value above uint256')
          .optional(),
      }),
    )
    .min(1)
    .max(16),
  /**
   * The fee pair the client will sign. Required (independent review, 2026-09-24): without
   * it the quote cannot price the exact fee, nor tell whether the account's own budget
   * stops this action (F4), so a quote said "free" that the send then charged, and a client
   * could loop between the two.
   */
  maxFeePerGas: hexOrDecimal,
  maxPriorityFeePerGas: hexOrDecimal,
});
