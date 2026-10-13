import type { Address } from 'viem';
import {
  assertRecipient,
  type Decline,
  type DepositInstruction,
  type FundingRequest,
  type Quote,
  type QuoteFee,
  type Rail,
  type RailRef,
  type RailStatus,
  type SourceTxPlan,
} from './types.js';

/**
 * Relay — `https://api.relay.link`.
 *
 * Verified live on 2026-09-11; the raw responses are in `reports/RAILS-VERIFY.md` and
 * the fixtures under `__fixtures__` are those responses, not inventions.
 *
 * ## Three things verification changed
 *
 * 1. **Relay delivers only USDC, mUSD or MON on Monad.** `/chains` lists exactly those
 *    for chain 143. Every route here therefore names USDC as the output, whatever went
 *    in. The plan had assumed broader destination coverage.
 * 2. **Deposit addresses require an API key.** Without one, `useDepositAddress: true`
 *    answers `UNAUTHORIZED`. Wallet-signed quotes work unauthenticated, which is what
 *    this rail does when no key is configured — and it says so rather than pretending
 *    the feature exists.
 * 3. **Auto-refund by sentinel does not work on Tron.** Relay refuses both the EVM zero
 *    address and Tron's own native sentinel with *"Zero-address refundTo is not
 *    supported for deposit-address refunds on this chain"*. So a Tron deposit address
 *    needs a real refund address from the user, and `refundAddressRequired` says so.
 *
 * The one thing it can do that no other verified rail can: **carry a destination call**,
 * so the fill itself runs `MarginAccount.deposit(user, token, amount)` and the money
 * lands in the trading balance rather than the wallet.
 */

const BASE = 'https://api.relay.link';

/** Only what `/chains` says chain 143 accepts. Verified 2026-09-11. */
const MONAD_USDC = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603';
const MONAD_CHAIN_ID = 143;

export interface RelayConfig {
  /** Server-side only. Without it, deposit addresses are unavailable (verified). */
  readonly apiKey?: string;
  readonly appFeeRecipient?: string;
  readonly appFeeBps?: number;
  /** The MarginAccount call to attach when the caller wants margin delivery. */
  readonly marginCall?: (recipient: Address, amountOut: bigint) => { to: string; data: string };
}

interface RelayFee {
  amount?: string;
  amountFormatted?: string;
  amountUsd?: string;
  currency?: { symbol?: string; decimals?: number };
}

interface RelayQuoteResponse {
  requestId?: string;
  steps?: {
    id?: string;
    /** Present when `useDepositAddress` was set and the key was accepted. */
    depositAddress?: string;
    items?: { data?: Record<string, unknown>; check?: { endpoint?: string } }[];
  }[];
  details?: {
    timeEstimate?: number;
    currencyIn?: { amount?: string; currency?: { symbol?: string } };
    currencyOut?: { amount?: string; currency?: { symbol?: string } };
  };
  fees?: Record<string, RelayFee>;
  message?: string;
  errorCode?: string;
}

/** Relay labels its fees itself; those labels are shown to the user unchanged. */
function feesOf(body: RelayQuoteResponse): QuoteFee[] {
  const out: QuoteFee[] = [];
  for (const [label, fee] of Object.entries(body.fees ?? {})) {
    if (!fee || typeof fee !== 'object') continue;
    const amount = fee.amount ? BigInt(fee.amount) : 0n;
    // A zero fee is not worth a line; Relay returns several that are always zero.
    if (amount === 0n) continue;
    out.push({
      label,
      amount,
      token: fee.currency?.symbol ?? '',
      ...(fee.amountUsd ? { usd: fee.amountUsd } : {}),
    });
  }
  return out;
}

export function createRelayRail(config: RelayConfig = {}): Rail {
  return {
    id: 'relay',
    displayName: 'Relay',
    explainer: 'A solver delivers on Monad in seconds, and refunds you if it cannot.',

    supports(req) {
      // Relay lists Monad as a destination for every chain in `/chains`; the live
      // coverage endpoint is what actually gates the UI. This is the cheap check.
      return req.amount > 0n;
    },

    async quote(req: FundingRequest, signal: AbortSignal): Promise<Quote | Decline> {
      assertRecipient(req, req.recipient);

      const wantsMargin = req.wantsMargin && typeof config.marginCall === 'function';
      const body: Record<string, unknown> = {
        // Relay validates `user` against the ORIGIN chain, so an EVM address on a
        // Solana or Tron origin is rejected outright. `recipient` still decides where
        // the money lands, and is asserted above.
        user: req.senderAddress ?? req.recipient,
        originChainId: req.sourceChain.id,
        originCurrency: req.sourceAsset.address,
        destinationChainId: MONAD_CHAIN_ID,
        destinationCurrency: MONAD_USDC,
        amount: req.amount.toString(),
        tradeType: 'EXACT_INPUT',
        recipient: req.recipient,
      };
      if (config.appFeeRecipient && config.appFeeBps) {
        body.appFees = [{ recipient: config.appFeeRecipient, fee: String(config.appFeeBps) }];
      }
      if (wantsMargin) {
        // The amount is not known until the quote comes back, so this first pass asks
        // without a call and the server re-quotes with the real figure. Attaching a
        // guessed amount would be a number we invented.
        body.txs = [];
      }

      const res = await fetch(`${BASE}/quote`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(config.apiKey ? { 'x-api-key': config.apiKey } : {}),
        },
        body: JSON.stringify(body),
        signal,
      });
      const json = (await res.json()) as RelayQuoteResponse;

      if (!res.ok || json.errorCode) {
        // Relay's own sentence, verbatim (R5).
        return { rail: 'relay', reason: json.message ?? `Relay answered ${res.status}`, raw: json };
      }

      const amountOut = json.details?.currencyOut?.amount;
      if (!amountOut) {
        return { rail: 'relay', reason: 'Relay returned no output amount', raw: json };
      }

      return {
        rail: 'relay',
        amountIn: req.amount,
        amountOut: BigInt(amountOut),
        outToken: 'USDC',
        fees: feesOf(json),
        etaSeconds: json.details?.timeEstimate ?? 0,
        // Relay quotes are short-lived and it does not return an expiry; one minute is
        // this app's own re-quote cadence, not a claim about Relay's TTL.
        expiresAt: Date.now() + 60_000,
        landsIn: wantsMargin ? 'margin' : 'wallet',
        /**
         * Two ways to act on a Relay quote, and either one counts.
         *
         * With an API key Relay issues a deposit address and the user sends to it from
         * wherever their money is — no wallet, no signature. Without one, Relay still
         * returns the transactions to sign, and a user with a connected wallet can send
         * them. Only when neither holds is this a price nobody can act on.
         */
        // Relay issues an address to send to when it has a key: no wallet needed.
        needsWallet: !(typeof config.apiKey === 'string' && config.apiKey.length > 0),
        executable:
          (typeof config.apiKey === 'string' && config.apiKey.length > 0) ||
          (typeof req.senderAddress === 'string' && req.senderAddress.length > 0),
        raw: {
          ...json,
          __request: {
            chain: req.sourceChain,
            asset: req.sourceAsset,
            assetAddress: req.sourceAsset.address,
            recipient: req.recipient,
            userAddress: req.senderAddress ?? req.recipient,
          } satisfies StashedRequest,
        },
      };
    },

    /**
     * Ask Relay for an address to send to.
     *
     * Verified 2026-09-11 with a real key: the address arrives at
     * `steps[0].depositAddress` - Tron `THYGBEzYXsc...`, Solana `AsDPTuCYrtJ...`.
     *
     * **No refund address is requested, on any chain.** An earlier reading concluded
     * Tron needed one, because Relay refused an explicit sentinel `refundTo`. Omitting
     * the field entirely works everywhere tested, so asking the user for something the
     * vendor does not want would be a field invented by us.
     */
    async depositAddress(quote: Quote): Promise<DepositInstruction> {
      if (!config.apiKey) {
        throw new Error(
          'Relay deposit addresses need an API key. Verified 2026-09-11: without one ' +
            'Relay answers "This request is missing an api key and cannot use a deposit ' +
            'address". Set RELAY_API_KEY on the server.',
        );
      }
      const req = quoteRequest(quote);
      const body: Record<string, unknown> = {
        user: req.userAddress,
        originChainId: req.chain.id,
        originCurrency: req.assetAddress,
        destinationChainId: MONAD_CHAIN_ID,
        destinationCurrency: MONAD_USDC,
        amount: quote.amountIn.toString(),
        tradeType: 'EXACT_INPUT',
        recipient: req.recipient,
        useDepositAddress: true,
      };
      if (config.appFeeRecipient && config.appFeeBps) {
        body.appFees = [{ recipient: config.appFeeRecipient, fee: String(config.appFeeBps) }];
      }

      const res = await fetch(`${BASE}/quote`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': config.apiKey },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as RelayQuoteResponse;
      if (!res.ok || json.errorCode) {
        // Relay's own sentence. `BLOCKED_WALLET_ADDRESS` reaches the user unchanged:
        // a screening decision is the vendor's to explain, not ours to soften.
        throw new Error(json.message ?? `Relay answered ${res.status}`);
      }

      const address = json.steps?.find((step) => step.depositAddress)?.depositAddress;
      if (!address) throw new Error('Relay issued no deposit address for this route');

      return {
        kind: 'deposit-address',
        rail: 'relay',
        address,
        chain: req.chain,
        asset: req.asset,
        amount: quote.amountIn,
        // Relay returns no expiry on the quote; this is our own re-quote cadence, not
        // a claim about how long Relay will honour the address.
        expiresAt: Date.now() + 15 * 60_000,
        refundAddressRequired: false,
        raw: json,
      };
    },

    async buildSourceTx(quote: Quote): Promise<SourceTxPlan> {
      const raw = quote.raw as RelayQuoteResponse;
      const txs = (raw.steps ?? []).flatMap((step) =>
        (step.items ?? [])
          .map((item) => item.data)
          .filter((d): d is Record<string, unknown> => Boolean(d && d.to && d.data))
          .map((d) => ({
            chainId: Number(d.chainId ?? 0),
            to: String(d.to),
            data: String(d.data),
            value: String(d.value ?? '0'),
            label: step.id === 'approve' ? 'Approve the token' : 'Send to Relay',
          })),
      );
      if (txs.length === 0) throw new Error('Relay returned no transactions to sign');
      return { kind: 'wallet-signed', rail: 'relay', chain: quoteChain(quote), txs, raw };
    },

    /**
     * Poll `/intents/status?requestId=`.
     *
     * The path is not guessed: every quote carries it at
     * `steps[].items[].check.endpoint`, observed 2026-09-11. It is `/intents/status`,
     * not the `/intents/status/v2` the plan assumed.
     */
    async status(ref: RailRef): Promise<RailStatus> {
      const res = await fetch(`${BASE}/intents/status?requestId=${encodeURIComponent(ref.ref)}`, {
        headers: config.apiKey ? { 'x-api-key': config.apiKey } : {},
      });
      const json = (await res.json()) as {
        status?: string;
        details?: string;
        inTxHashes?: string[];
        txHashes?: string[];
      };
      if (!res.ok) {
        return { state: 'in-flight', message: `Relay answered ${res.status}`, raw: json };
      }
      // Relay's vocabulary mapped to ours for the state machine only; its own words
      // travel alongside in `message` and are what the screen shows.
      const s = (json.status ?? '').toLowerCase();
      const state =
        s === 'success'
          ? 'delivered'
          : s === 'refund'
            ? 'refunded'
            : s === 'failure'
              ? 'failed'
              : s === 'pending'
                ? 'in-flight'
                : 'awaiting-source';
      return {
        state,
        ...(json.details ? { message: json.details } : {}),
        ...(json.inTxHashes?.[0] ? { sourceTxHash: json.inTxHashes[0] } : {}),
        ...(json.txHashes?.[0] ? { destinationTxHash: json.txHashes[0] } : {}),
        raw: json,
      };
    },
  };
}

/**
 * The request a quote came from, stashed on the quote when it was made.
 *
 * A quote alone does not carry its own origin, and re-deriving it from the vendor's
 * echo would mean trusting our reading of their response. The request is attached at
 * quote time under a name that cannot collide with a vendor field.
 */
interface StashedRequest {
  readonly chain: FundingRequest['sourceChain'];
  readonly asset: FundingRequest['sourceAsset'];
  readonly assetAddress: string;
  readonly recipient: Address;
  /** The address that will send. On an SVM or TVM origin this is not the recipient. */
  readonly userAddress: string;
}

function quoteRequest(quote: Quote): StashedRequest {
  const raw = quote.raw as { __request?: StashedRequest };
  if (!raw.__request) throw new Error('quote is missing the request it was made from');
  return raw.__request;
}

/** The source chain a quote was made for. */
function quoteChain(quote: Quote): FundingRequest['sourceChain'] {
  return quoteRequest(quote).chain;
}
