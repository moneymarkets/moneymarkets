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
} from './types.js';

/**
 * NEAR Intents / 1Click as a rail — `https://1click.chaindefuser.com`.
 *
 * This is the same solver network the old per-vendor tiles used, expressed through the
 * one Rail interface so the picker asks it alongside Relay and Across instead of the
 * screen owning a second, parallel funding flow.
 *
 * ## What it answered on 2026-09-11, unedited
 *
 * `GET /v0/tokens` — 188 assets, of which exactly three land on Monad: MON, USDC and
 * USDT0. The origin asset ids below are transcribed from that response.
 *
 * `POST /v0/quote`, dry, Base USDC to Monad USDC:
 *
 * ```
 *    $5   400  Temporary swap limits: minimum swap amount is $1,000   (corr 6bc42b9b…)
 *   $20   400  Temporary swap limits: minimum swap amount is $1,000   (corr 96580abb…)
 *  $100   400  Temporary swap limits: minimum swap amount is $1,000   (corr 76e5f43f…)
 * $1000   400  Temporary swap limits: minimum swap amount is $1,000   (corr e65c63ab…)
 * $1500   201  amountOut 1498195197, minAmountOut 1483213245, timeEstimate 1837
 * ```
 *
 * So the network is alive and refusing every ordinary funding amount. That refusal is
 * the rail's whole present value on this screen: it is returned as a `Decline` carrying
 * 1Click's own sentence, which tells a user why the option vanished — and it is the
 * reason the old tiles that only spoke to this network could not fund anything.
 *
 * **No minimum is written here.** The figure above is what 1Click said on one day; the
 * only floor this rail enforces is the vendor's live answer.
 *
 * ## Two constraints this rail must respect
 *
 * 1. `refundTo` must be an address on the **origin** chain. An EVM address on a Tron
 *    origin is rejected outright. For a non-EVM origin the caller must supply
 *    `senderAddress`; without it this rail declines in its own clearly-ours words
 *    rather than sending a request the vendor will reject for a reason that reads as
 *    though the route were closed.
 * 2. `dry: true` allocates no deposit address. Pricing and issuing are two calls, and
 *    `depositAddress()` makes the second one.
 */

const QUOTE_URL = 'https://1click.chaindefuser.com/v0/quote';
const STATUS_URL = 'https://1click.chaindefuser.com/v0/status';

/** The only Monad asset this rail is asked for. Verified in `/v0/tokens`, 2026-09-11. */
const MONAD_USDC_ASSET_ID = 'nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx';

/**
 * Origin asset ids, keyed `${chainId}:${SYMBOL}`.
 *
 * Every line is transcribed from the live `/v0/tokens` response on 2026-09-11. The
 * chain ids are this repo's own (`KNOWN_CHAINS`); 1Click keys on its own short names,
 * so the mapping lives here rather than being guessed at either end.
 */
export const NEAR_ASSET_IDS: Readonly<Record<string, string>> = {
  '1:ETH': 'nep141:eth.omft.near',
  '1:USDC': 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near',
  '1:USDT': 'nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near',
  '10:USDC': 'nep245:v2_1.omni.hot.tg:10_A2ewyUyDp6qsue1jqZsGypkCxRJ',
  '10:USDT': 'nep245:v2_1.omni.hot.tg:10_359RPSJVdTxwTJT9TyGssr2rFoWo',
  '56:USDC': 'nep245:v2_1.omni.hot.tg:56_2w93GqMcEmQFDru84j3HZZWt557r',
  '56:USDT': 'nep245:v2_1.omni.hot.tg:56_2CMMyVTGZkeyNZTSvS5sarzfir6g',
  '137:USDC': 'nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L',
  '137:USDT': 'nep245:v2_1.omni.hot.tg:137_3hpYoaLtt8MP1Z2GH1U473DMRKgr',
  '8453:ETH': 'nep141:base.omft.near',
  '8453:USDC': 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
  '42161:ETH': 'nep141:arb.omft.near',
  '42161:USDC': 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near',
  '42161:USDT': 'nep141:arb-0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9.omft.near',
  '43114:USDC': 'nep245:v2_1.omni.hot.tg:43114_3atVJH3r5c4GqiSYmg9fECvjc47o',
  '43114:USDT': 'nep245:v2_1.omni.hot.tg:43114_372BeH7ENZieCaabwkbWkBiTTgXp',
  '728126428:USDT': 'nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near',
  '792703809:SOL': 'nep141:sol.omft.near',
  '792703809:USDC': 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near',
  '792703809:USDT': 'nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near',
  '8253038:BTC': 'nep141:btc.omft.near',
};

export function nearAssetId(chainId: number, symbol: string): string | undefined {
  return NEAR_ASSET_IDS[`${chainId}:${symbol.toUpperCase()}`];
}

export interface NearConfig {
  /**
   * The free 1Click JWT. Server-side only.
   *
   * Without it the network still quotes and still issues addresses — every response
   * quoted in this file was keyless — but the published fee ceiling is higher. It is
   * passed through when set and never required.
   */
  readonly jwt?: string;
  /** Basis points of slippage on the destination leg. 1Click's own field. */
  readonly slippageBps?: number;
}

interface OneClickQuoteBody {
  quote?: {
    amountIn?: string;
    amountOut?: string;
    minAmountOut?: string;
    amountInUsd?: string;
    amountOutUsd?: string;
    timeEstimate?: number;
    refundFee?: string;
    withdrawFee?: string;
    depositAddress?: string;
    deadline?: string;
    timeWhenInactive?: string;
  };
  signature?: string;
  correlationId?: string;
  message?: string;
}

/** The request a quote was made from, stashed so `depositAddress()` can repeat it. */
interface StashedRequest {
  readonly chain: FundingRequest['sourceChain'];
  readonly asset: FundingRequest['sourceAsset'];
  readonly originAsset: string;
  readonly recipient: Address;
  readonly refundTo: string;
}

function stashed(quote: Quote): StashedRequest {
  const raw = quote.raw as { __request?: StashedRequest };
  if (!raw.__request) throw new Error('quote is missing the request it was made from');
  return raw.__request;
}

export function createNearRail(config: NearConfig = {}): Rail {
  const slippage = config.slippageBps ?? 100;

  const headers = (): Record<string, string> => ({
    'content-type': 'application/json',
    ...(config.jwt ? { authorization: `Bearer ${config.jwt}` } : {}),
  });

  const requestBody = (r: StashedRequest, amount: bigint, dry: boolean) => ({
    dry,
    swapType: 'EXACT_INPUT',
    slippageTolerance: slippage,
    originAsset: r.originAsset,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: MONAD_USDC_ASSET_ID,
    amount: amount.toString(),
    refundTo: r.refundTo,
    refundType: 'ORIGIN_CHAIN',
    recipient: r.recipient,
    recipientType: 'DESTINATION_CHAIN',
    deadline: new Date(Date.now() + 3_600_000).toISOString(),
  });

  return {
    id: 'near',
    displayName: 'NEAR Intents',
    explainer: 'A solver network fills your deposit and delivers USDC on Monad.',

    supports(req) {
      return req.amount > 0n && nearAssetId(req.sourceChain.id, req.sourceAsset.symbol) !== undefined;
    },

    async quote(req: FundingRequest, signal: AbortSignal): Promise<Quote | Decline> {
      assertRecipient(req, req.recipient);

      const originAsset = nearAssetId(req.sourceChain.id, req.sourceAsset.symbol);
      if (!originAsset) {
        return { rail: 'near', reason: 'NEAR Intents does not list this asset', raw: null };
      }

      // Ours, and said as ours. A refund has to land on the origin chain, and on a
      // non-EVM origin this app has no address of the user's there until they give one.
      const refundTo = req.sourceChain.vm === 'evm' ? req.recipient : req.senderAddress;
      if (!refundTo) {
        return {
          rail: 'near',
          reason:
            `A refund from NEAR Intents has to return to ${req.sourceChain.displayName}, ` +
            `so it needs your ${req.sourceChain.displayName} address before it can price this.`,
          raw: { missing: 'senderAddress', chain: req.sourceChain },
        };
      }

      const stash: StashedRequest = {
        chain: req.sourceChain,
        asset: req.sourceAsset,
        originAsset,
        recipient: req.recipient,
        refundTo,
      };

      const res = await fetch(QUOTE_URL, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(requestBody(stash, req.amount, true)),
        signal,
      });
      const json = (await res.json()) as OneClickQuoteBody;

      const q = json.quote;
      const amountOut = q?.amountOut;
      if (!res.ok || !q || !amountOut) {
        // 1Click's own sentence, verbatim (R5). "Temporary swap limits: minimum swap
        // amount is $1,000" is the one a user can act on; nothing here rewrites it.
        return {
          rail: 'near',
          reason: json.message ?? `NEAR Intents answered ${res.status}`,
          raw: json,
        };
      }

      const fees: QuoteFee[] = [];
      // 1Click's own labels. `refundFee` is charged only on a refund, so it is not
      // subtracted from the output — it is shown because the user is entitled to know
      // what a failure would cost, and named exactly as 1Click names it.
      if (q.withdrawFee && BigInt(q.withdrawFee) > 0n) {
        fees.push({ label: 'withdrawFee', amount: BigInt(q.withdrawFee), token: 'USDC' });
      }
      if (q.refundFee && BigInt(q.refundFee) > 0n) {
        fees.push({
          label: 'refundFee',
          amount: BigInt(q.refundFee),
          token: req.sourceAsset.symbol,
        });
      }

      return {
        rail: 'near',
        amountIn: req.amount,
        amountOut: BigInt(amountOut),
        outToken: 'USDC',
        fees,
        etaSeconds: q.timeEstimate ?? 0,
        // 1Click gives a dry quote no deadline of its own; this is our re-quote cadence.
        expiresAt: Date.now() + 60_000,
        landsIn: 'wallet',
        // It issues a deposit address, so a user with no source-chain wallet signature
        // can act on this quote today. That is the whole point of the rail.
        needsWallet: false,
        executable: true,
        raw: { ...json, __request: stash },
      };
    },

    /**
     * The second call: the same request with `dry: false`, which is the only way an
     * address is allocated (verified 2026-09-02 and unchanged 2026-09-11).
     */
    async depositAddress(quote: Quote): Promise<DepositInstruction> {
      const r = stashed(quote);
      const res = await fetch(QUOTE_URL, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(requestBody(r, quote.amountIn, false)),
      });
      const json = (await res.json()) as OneClickQuoteBody;
      if (!res.ok) throw new Error(json.message ?? `NEAR Intents answered ${res.status}`);

      const address = json.quote?.depositAddress;
      if (!address) throw new Error('NEAR Intents issued no deposit address for this route');

      // 1Click states its own expiry. Ours is only the fallback when it gives none.
      const deadline = json.quote?.deadline ?? json.quote?.timeWhenInactive;
      const parsed = deadline ? Date.parse(deadline) : Number.NaN;

      return {
        kind: 'deposit-address',
        rail: 'near',
        address,
        chain: r.chain,
        asset: r.asset,
        amount: quote.amountIn,
        expiresAt: Number.isFinite(parsed) ? parsed : Date.now() + 15 * 60_000,
        // A refund address was required to get this far, and is already on the quote.
        refundAddressRequired: false,
        raw: json,
      };
    },

    /** `GET /v0/status?depositAddress=` — 1Click keys on the address it issued. */
    async status(ref: RailRef): Promise<RailStatus> {
      const res = await fetch(`${STATUS_URL}?depositAddress=${encodeURIComponent(ref.ref)}`, {
        headers: config.jwt ? { authorization: `Bearer ${config.jwt}` } : {},
      });
      const json = (await res.json()) as {
        status?: string;
        swapDetails?: {
          amountOut?: string;
          refundReason?: string;
          originChainTxHashes?: { hash?: string }[];
          destinationChainTxHashes?: { hash?: string }[];
        };
        message?: string;
      };
      if (!res.ok) {
        return {
          state: 'in-flight',
          message: json.message ?? `NEAR Intents answered ${res.status}`,
          raw: json,
        };
      }

      // 1Click's vocabulary mapped to ours for the state machine only; the raw payload
      // above is what a row is read back as.
      const s = json.status ?? '';
      const state =
        s === 'SUCCESS'
          ? 'delivered'
          : s === 'REFUNDED'
            ? 'refunded'
            : s === 'FAILED'
              ? 'failed'
              : s === 'PENDING_DEPOSIT'
                ? 'awaiting-source'
                : s === 'KNOWN_DEPOSIT_TX' || s === 'INCOMPLETE_DEPOSIT'
                  ? 'source-seen'
                  : 'in-flight';

      // A `destinationChainTxHashes` entry on a batch that is not yet SUCCESS is not a
      // delivery, whatever it looks like — the same discipline the 1Click watcher uses.
      const destination =
        s === 'SUCCESS' ? json.swapDetails?.destinationChainTxHashes?.at(-1) : undefined;
      const sourceHash = json.swapDetails?.originChainTxHashes?.[0]?.hash;
      return {
        state,
        ...(json.swapDetails?.refundReason ? { message: json.swapDetails.refundReason } : {}),
        ...(sourceHash ? { sourceTxHash: sourceHash } : {}),
        ...(destination?.hash ? { destinationTxHash: destination.hash } : {}),
        ...(json.swapDetails?.amountOut ? { amountOut: BigInt(json.swapDetails.amountOut) } : {}),
        raw: json,
      };
    },
  };
}
