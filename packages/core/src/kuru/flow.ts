import { z } from 'zod';
import { getAddress, isAddress, type Address, type Hex } from 'viem';

/**
 * Kuru Flow — the aggregator swap route, and the app's routing-fee revenue line.
 *
 * Verified live on 2026-09-02:
 *   POST https://ws.kuru.io/api/generate-token  {"user_address": "0x…"}
 *     -> {"token":"<jwt>","expires_at":<unix>,"rate_limit":{"rps":1,"burst":1}}
 *   POST https://ws.kuru.io/api/quote           (Authorization: Bearer <jwt>)
 *     -> {"type":"calculate_swap_result","status":"success","output":"26108",
 *         "minOut":"26076","transaction":{"calldata":"ce1e7030…","value":"…","to":"0x…"}}
 *
 * Two things that bite:
 *  - `transaction.calldata` has **no `0x` prefix**. Passing it straight to a wallet
 *    produces an empty call.
 *  - the JWT's rate limit is 1 request per second, burst 1. Quote on user intent,
 *    never in a render loop.
 *
 * ## These swaps are user-gas-paid, and the type says so
 *
 * **This route cannot be relayed and is not sponsored.** The router the quote points
 * at (`0xb3e6778480b2E488385E8205eA05E20060B813cb`, read from a live quote) answers
 * neither `isTrustedForwarder(address)` nor `TRUSTED_FORWARDER()` — both revert — so
 * it is not ERC-2771 aware, and it is not on the sponsorship allowlist either, so a
 * 7702 user operation carrying it would be refused by
 * `gas/policy.ts` with `TARGET_NOT_ALLOWED`. In-app orders on Kuru's own books are
 * gasless; a Flow swap is not.
 *
 * That distinction is carried in the type as {@link FlowQuote.gasPayer}, a literal
 * `'user'`, and {@link FlowQuote.sponsored}, a literal `false` — not as a comment.
 * A screen that renders "Paid for you" over one of these quotes will not typecheck
 * against `gasPayer: 'sponsored'`, because that variant does not exist. The AUSD/USDC
 * hop therefore goes through `kuru/convert.ts` on the AUSD_USDC book, which is
 * 2771-aware and one tick wide. See DECISIONS.md open item 9.
 *
 * ## What the API does and does not tell you about the route
 *
 * Measured across five live legs on 2026-09-02, a quote response carries
 * `{type, status, output, minOut, transaction:{calldata, value, to}}` and sometimes a
 * `gasPrices` ladder of MON gwei strings. There is **no fee field and no structured
 * route field** — no hop list, no venue names, no per-leg amounts. So
 * {@link FlowRouteEvidence} records what can actually be observed (the router, the
 * selector, the calldata size, and which 32-byte words are address-shaped) and marks
 * itself `decoded: false`. Anything more would be a guessed ABI, which rule A2.5
 * forbids. The referrer fee is recovered by differencing two live quotes, not read
 * from a field; see {@link FLOW_REFERRER_FEE_EVIDENCE}.
 *
 * One venue *is* nameable without a decode. The tail of every calldata is a
 * length-prefixed packed blob, and a 20-byte order-book address sits inside it: on the
 * USDC->AUSD quote it is `0x699AbC15…`, the AUSD/USDC book that `kuru/convert.ts`
 * calls directly. {@link flowCalldataMentions} is a substring search for exactly that
 * question and claims nothing about the framing bytes around it.
 */

export const KURU_FLOW_API = 'https://ws.kuru.io/api';

/**
 * The Kuru Flow router, read from the `transaction.to` of every live quote taken on
 * 2026-09-02 across AUSD->MON, MON->AUSD, USDC->AUSD and AUSD->USDT0.
 */
export const KURU_FLOW_ROUTER: Address = getAddress('0xb3e6778480b2E488385E8205eA05E20060B813cb');

/**
 * The only selector any Flow quote has returned. Its name, argument list and embedded
 * route encoding are undocumented and were not read from verified source.
 *
 * UNVERIFIED: the Kuru Flow router function at selector 0xce1e7030. No ABI is
 * attached anywhere in this repo and nothing decodes these bytes. The checks in
 * {@link assertFlowQuoteMatchesRequest} are what is possible without one.
 */
export const KURU_FLOW_SELECTOR: Hex = '0xce1e7030';

/**
 * What differencing two live quotes showed about `referrerFeeBps`, 2026-09-02.
 *
 * Same route (AUSD -> MON, 1.000000 AUSD in), same minute, one with no referrer and
 * one with `referrerAddress` set and `referrerFeeBps: 30`:
 *
 *   no referrer   output 38648604412558869214 wei MON
 *   30 bps        output 38532658599321192606 wei MON
 *   difference       115945813237676608 wei
 *
 * 30 bps of the gross output is 115945813237676607.642 wei, so the charge is that
 * **rounded up** — `floor + 1` at this size. The fee is therefore taken **out of the
 * output**, and `referrerFeeBps` is real basis points rather than the
 * parts-per-million the order books use for `minFeesPps`.
 * The fee is not reported in any response field; this is a measurement, and it is the
 * only basis on which this module reports a fee.
 */
export const FLOW_REFERRER_FEE_EVIDENCE = {
  route: 'AUSD->MON',
  amountIn: 1_000_000n,
  outputWithoutReferrer: 38_648_604_412_558_869_214n,
  outputWithReferrer: 38_532_658_599_321_192_606n,
  referrerFeeBps: 30,
  observedAt: '2026-09-02',
} as const;

export const flowTokenSchema = z.object({
  token: z.string(),
  expires_at: z.number(),
  rate_limit: z.object({ rps: z.number(), burst: z.number() }).optional(),
});

export const flowQuoteSchema = z.object({
  type: z.string(),
  status: z.string(),
  output: z.string(),
  minOut: z.string(),
  transaction: z.object({
    calldata: z.string(),
    value: z.string(),
    to: z.string(),
  }),
  gasPrices: z.unknown().optional(),
});

export interface FlowToken {
  readonly token: string;
  readonly expiresAt: number;
  readonly requestsPerSecond: number;
}

/**
 * Who pays the gas for a leg.
 *
 * `'sponsored'` exists so the union is meaningful, but no Flow quote ever carries it:
 * {@link FlowQuote} pins the field to the `'user'` member.
 */
export type FlowGasPayer = 'user' | 'sponsored';

/**
 * The routing fee attached to a quote.
 *
 * `bps` is what was **asked for** in the request, echoed back here because the API
 * returns no fee field of its own. `evidence` says how far that has been checked: it
 * reaches `'in-calldata'` only once {@link assertFlowQuoteMatchesRequest} has found
 * both the referrer address and the fee value in the calldata the API returned.
 */
export interface FlowFee {
  readonly referrerAddress?: Address;
  readonly bps?: number;
  /**
   * `'none'`        — no referrer was requested, so Flow charges no routing fee.
   * `'requested'`   — a fee was requested; the calldata has not been checked yet.
   * `'in-calldata'` — the referrer and the fee both appear in the returned calldata.
   */
  readonly evidence: 'none' | 'requested' | 'in-calldata';
}

/**
 * Everything that can honestly be said about a Flow route without an ABI.
 *
 * `decoded` is permanently `false`. `addressShapedWords` lists the 32-byte words whose
 * top twelve bytes are zero — which catches token and recipient addresses, and also
 * catches any small integer in the call, because at this level the two are
 * indistinguishable. It is evidence, not a decode.
 */
export interface FlowRouteEvidence {
  readonly router: Address;
  readonly selector: Hex;
  readonly calldataBytes: number;
  readonly wordCount: number;
  readonly addressShapedWords: readonly Address[];
  readonly decoded: false;
}

export interface FlowQuote {
  /** Output in the destination token's base units, net of the referrer fee. */
  readonly output: bigint;
  readonly minOut: bigint;
  readonly to: Address;
  /** `0x`-prefixed, because the API's is not. */
  readonly calldata: Hex;
  readonly value: bigint;
  /**
   * Always false today. The router is not 2771-aware, so this swap needs a user who
   * can pay their own gas (or an EIP-7702 path). Kept as a field so the flag is
   * checked rather than remembered.
   */
  readonly relayable: false;
  /**
   * **The user pays gas for this leg.** In-app orders on Kuru's own books are
   * sponsored; Flow swaps are not, and the difference is in the type so a screen
   * cannot silently promise "Paid for you" over one of these.
   */
  readonly gasPayer: 'user';
  /** Same fact, stated so a boolean check reads naturally. */
  readonly sponsored: false;
  readonly fee: FlowFee;
  readonly route: FlowRouteEvidence;
}

export interface FlowQuoteRequest {
  readonly userAddress: Address;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  /** Base units of `tokenIn`. */
  readonly amount: bigint;
  readonly autoSlippage?: boolean;
  readonly slippageTolerance?: number;
  readonly referrerAddress?: Address;
  readonly referrerFeeBps?: number;
}

export class KuruFlowClient {
  #token: FlowToken | undefined;

  constructor(
    private readonly options: {
      readonly baseUrl?: string;
      readonly referrerAddress?: Address;
      readonly referrerFeeBps?: number;
      readonly fetchImpl?: typeof fetch;
    } = {},
  ) {}

  get #base(): string {
    return (this.options.baseUrl ?? KURU_FLOW_API).replace(/\/$/, '');
  }

  get #fetch(): typeof fetch {
    return this.options.fetchImpl ?? fetch;
  }

  async token(userAddress: Address): Promise<FlowToken> {
    const cached = this.#token;
    // Refresh a minute early rather than race the expiry.
    if (cached && cached.expiresAt * 1000 - 60_000 > Date.now()) return cached;

    const res = await this.#fetch(`${this.#base}/generate-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_address: userAddress }),
    });
    if (!res.ok) throw new Error(`Kuru Flow token request returned ${res.status}`);
    const parsed = flowTokenSchema.parse(await res.json());
    const token: FlowToken = {
      token: parsed.token,
      expiresAt: parsed.expires_at,
      requestsPerSecond: parsed.rate_limit?.rps ?? 1,
    };
    this.#token = token;
    return token;
  }

  async quote(request: FlowQuoteRequest): Promise<FlowQuote> {
    const { token } = await this.token(request.userAddress);
    const referrerAddress = request.referrerAddress ?? this.options.referrerAddress;
    const referrerFeeBps = request.referrerFeeBps ?? this.options.referrerFeeBps;

    const body: Record<string, unknown> = {
      userAddress: request.userAddress,
      tokenIn: request.tokenIn,
      tokenOut: request.tokenOut,
      amount: request.amount.toString(),
    };
    if (request.slippageTolerance !== undefined) {
      body.slippageTolerance = request.slippageTolerance;
    } else {
      body.autoSlippage = request.autoSlippage ?? true;
    }
    if (referrerAddress) body.referrerAddress = referrerAddress;
    if (referrerFeeBps !== undefined) body.referrerFeeBps = referrerFeeBps;

    const res = await this.#fetch(`${this.#base}/quote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Kuru Flow quote returned ${res.status}`);

    const context: FlowQuoteContext = {
      ...(referrerAddress !== undefined ? { referrerAddress } : {}),
      ...(referrerFeeBps !== undefined ? { referrerFeeBps } : {}),
    };
    const quote = parseFlowQuote(await res.json(), context);
    // Refuse a quote whose JSON and whose bytes disagree, and record that the fee the
    // caller asked for is really in the call. This is the only claim available without
    // the router's ABI, and it is the one that catches a swap of the wrong amount.
    return assertFlowQuoteMatchesRequest(quote, {
      tokenIn: request.tokenIn,
      tokenOut: request.tokenOut,
      amount: request.amount,
      ...context,
    });
  }
}

export interface FlowQuoteContext {
  readonly referrerAddress?: Address;
  readonly referrerFeeBps?: number;
}

export function parseFlowQuote(payload: unknown, context: FlowQuoteContext = {}): FlowQuote {
  const q = flowQuoteSchema.parse(payload);
  if (q.status !== 'success') throw new Error(`Kuru Flow quote status ${q.status}`);
  const calldata = normalizeFlowCalldata(q.transaction.calldata);
  return {
    output: BigInt(q.output),
    minOut: BigInt(q.minOut),
    to: getAddress(q.transaction.to),
    calldata,
    value: BigInt(q.transaction.value),
    relayable: false,
    gasPayer: 'user',
    sponsored: false,
    fee: context.referrerAddress
      ? {
          referrerAddress: getAddress(context.referrerAddress),
          ...(context.referrerFeeBps !== undefined ? { bps: context.referrerFeeBps } : {}),
          evidence: 'requested',
        }
      : { evidence: 'none' },
    route: flowRouteEvidence(getAddress(q.transaction.to), calldata),
  };
}

/** The API returns bare hex. Anything sent to a wallet must be `0x`-prefixed. */
export function normalizeFlowCalldata(calldata: string): Hex {
  const trimmed = calldata.trim();
  const body = trimmed.startsWith('0x') ? trimmed.slice(2) : trimmed;
  if (body.length === 0 || body.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(body)) {
    throw new Error('Kuru Flow returned calldata that is not whole hex bytes');
  }
  return `0x${body}`;
}

/** The 32-byte words after the selector, lowercased and un-prefixed. */
export function flowCalldataWords(calldata: Hex): readonly string[] {
  const body = calldata.slice(2).toLowerCase();
  const words: string[] = [];
  for (let i = 8; i + 64 <= body.length; i += 64) words.push(body.slice(i, i + 64));
  return words;
}

export function flowRouteEvidence(router: Address, calldata: Hex): FlowRouteEvidence {
  const words = flowCalldataWords(calldata);
  const addressShapedWords = words
    .filter((w) => w.startsWith('0'.repeat(24)) && !/^0+$/.test(w))
    .map((w) => getAddress(`0x${w.slice(24)}`));
  return {
    router,
    selector: calldata.slice(0, 10).toLowerCase() as Hex,
    calldataBytes: (calldata.length - 2) / 2,
    wordCount: words.length,
    addressShapedWords: [...new Set(addressShapedWords)],
    decoded: false,
  };
}

/**
 * Does this calldata contain `address` anywhere, word-aligned or not?
 *
 * A route venue is packed into the calldata's trailing blob at a byte offset that is
 * not a multiple of 32, so a word scan misses it. This is a substring search and
 * nothing more: it answers "is this address in these bytes", not "what role does it
 * play". Use it to confirm a route touches a venue you expect, never to infer one.
 */
export function flowCalldataMentions(calldata: Hex, address: Address): boolean {
  return calldata.slice(2).toLowerCase().includes(address.slice(2).toLowerCase());
}

/** Wrapped MON, chain 143. See `chain/addresses.ts` for how this was verified. */
const WMON: Address = getAddress('0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A');

/**
 * Does this Flow route touch WMON at all?
 *
 * Traced live 2026-09-08 (`debug_traceCall`, `callTracer`, real chain state): a
 * USDC->AUSD quote under about 2 USDC routes through ERC-20-only venues and carries
 * zero native value anywhere in its call tree. At 5 USDC — past what the direct
 * AUSD/USDC book can fill while it is paused — the same request instead routes
 * through WMON, and the trace shows large native-MON transfers between the router and
 * intermediate pool contracts (wrapping and unwrapping) before the final ERC-20
 * transfer to the caller. None of those transfers land on the caller's own address in
 * that trace, but the account executing this under EIP-7702 is exactly the kind Monad
 * enforces a 10-MON-reserve rule against, and this router publishes no ABI and no
 * source (rule A2.5) — there is no way to verify from outside that every code path
 * through an unwrap leaves the sender's own balance untouched. Refusing the route
 * itself, rather than trusting the trace, is the position this app takes on it.
 *
 * A substring search, not a decode, same caveat as `flowCalldataMentions`: it can
 * miss a route that reaches WMON some other way, and it does not prove a route
 * without this address is safe — only that this one specific, observed risk is
 * absent.
 */
export function flowTouchesWmon(calldata: Hex): boolean {
  return flowCalldataMentions(calldata, WMON);
}

export class FlowQuoteMismatchError extends Error {
  constructor(
    readonly missing: readonly string[],
    message: string,
  ) {
    super(message);
    this.name = 'FlowQuoteMismatchError';
  }
}

/** Left-pad a value to a 32-byte word, lowercased, for a substring search. */
function word(value: bigint | Address): string {
  return typeof value === 'bigint'
    ? value.toString(16).padStart(64, '0')
    : value.slice(2).toLowerCase().padStart(64, '0');
}

/**
 * The only claim this package can honestly make about an undecodable call: the values
 * the quote reported are the values in the bytes it returned.
 *
 * `tokenIn`, `tokenOut`, `amount`, `minOut`, the referrer address and the referrer fee
 * are each searched for as a 32-byte left-padded word. That does not prove the route
 * is what the API says it is — nothing available here could, because there is no ABI
 * and no route field — but it catches a quote whose JSON and whose calldata disagree,
 * which is the failure that silently swaps the wrong amount, pays the wrong floor, or
 * routes the fee to someone else.
 *
 * Confirmed against a live USDC->AUSD quote on 2026-09-02: the calldata's words carried
 * tokenOut, minOut (0x0f346a = 996458), tokenIn, amount (0x0f4240 = 1000000), the
 * referrer address and 0x1e = 30 for the fee.
 *
 * The native asset is `address(0)`, whose word is all zeros and is present in almost
 * any calldata; it is skipped rather than asserted, because an assertion that can
 * never fail is worse than none. For the same reason this is evidence and not proof:
 * a *small* value can appear in the bytes by coincidence — this calldata carries a
 * literal word of 1 — so the check catches a wrong realistic amount, which is the
 * failure that costs money, and cannot catch every wrong value.
 */
export function assertFlowQuoteMatchesRequest(
  quote: FlowQuote,
  request: {
    readonly tokenIn: Address;
    readonly tokenOut: Address;
    readonly amount: bigint;
    readonly referrerAddress?: Address;
    readonly referrerFeeBps?: number;
  },
): FlowQuote {
  const body = quote.calldata.slice(2).toLowerCase();
  const checks: [string, string][] = [];
  const isNative = (a: Address): boolean => /^0x0{40}$/i.test(a);
  if (!isNative(request.tokenIn)) checks.push(['tokenIn', word(request.tokenIn)]);
  if (!isNative(request.tokenOut)) checks.push(['tokenOut', word(request.tokenOut)]);
  checks.push(['amount', word(request.amount)]);
  checks.push(['minOut', word(quote.minOut)]);

  let feeInCalldata = false;
  if (request.referrerAddress && isAddress(request.referrerAddress)) {
    checks.push(['referrerAddress', word(request.referrerAddress)]);
    if (request.referrerFeeBps !== undefined) {
      checks.push(['referrerFeeBps', word(BigInt(request.referrerFeeBps))]);
    }
    feeInCalldata = true;
  }

  const missing = checks.filter(([, w]) => !body.includes(w)).map(([name]) => name);
  if (missing.length > 0) {
    throw new FlowQuoteMismatchError(
      missing,
      `the Kuru Flow quote's calldata does not contain ${missing.join(', ')} from its own ` +
        'request. Refusing a quote that disagrees with itself.',
    );
  }

  if (!feeInCalldata) return quote;
  return { ...quote, fee: { ...quote.fee, evidence: 'in-calldata' } };
}
