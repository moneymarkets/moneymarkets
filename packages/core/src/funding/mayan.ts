import { encodeFunctionData, erc20Abi, type Address } from 'viem';
import {
  assertRecipient,
  type Decline,
  type FundingRequest,
  type Quote,
  type QuoteFee,
  type Rail,
  type RailRef,
  type RailStatus,
  type SourceTx,
  type SourceTxPlan,
} from './types.js';

/**
 * Mayan — `https://price-api.mayan.finance`.
 *
 * ## This rail was recorded as permanently unavailable, and that was wrong too
 *
 * The earlier pass read `GET /v3/chains`, got seven chains with no Monad among them,
 * quoted from three sources, saw `ROUTE_NOT_FOUND`, and wrote Mayan into the screen as a
 * standing refusal. Re-checked 2026-09-11:
 *
 * ```
 * GET /v3/chains   ->  7 chains: solana ethereum bsc polygon avalanche arbitrum aptos
 * GET /v3/tokens   -> 17 chains, Monad among them:
 *   {"symbol":"USDC","contract":"0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
 *    "chainId":143,"wChainId":48,"decimals":6,"verified":true}
 * ```
 *
 * **`/v3/chains` is stale and `/v3/tokens` is current.** The first endpoint does not
 * list Base either, which Mayan has carried for a long time — so it was never a list of
 * what Mayan supports, and reading it as one produced a confident wrong answer. Mayan's
 * own interface asks `/v3/tokens`; this rail asks what their interface asks.
 *
 * ## What it answered, from a plain server with no browser
 *
 * ```
 * POST /v3/quote  Base USDC 20.000000 -> Monad USDC   HTTP 201
 *   type FAST_MCTP  expectedAmountOut 19.990327  minAmountOut 19.981471
 *   etaSeconds 35   circleMaxFee64 2861  redeemRelayerFee64 813  slippageBps 0
 * ```
 *
 * Note **201**, not 200 — a Mayan quote read with `res.ok` alone is fine, one checked
 * for `=== 200` is not.
 *
 * ## It can send, and an earlier note here said it could not
 *
 * That note claimed Mayan's source transaction "is not returned as calldata the way
 * deBridge's is" and that its SDK "builds the order internally". Both are wrong, and the
 * SDK's own type signature says so:
 *
 * ```
 * getSwapFromEvmTxPayload(quote, swapperAddress, destinationAddress, referrerAddresses,
 *   signerAddress, signerChainId, payload, permit, options?)
 *     -> Promise<TransactionRequest & { _forwarder: EvmForwarderParams }>
 * ```
 *
 * Called for real against @mayanfinance/swap-sdk 15.2.2, Base USDC 5.000000 to Monad:
 *
 * ```
 * to     0x337685fdaB40D39bd02028545a4FfA7D287cC3E2   (Mayan's forwarder)
 * value  0x00
 * data   0xe4269fc4…   932 bytes
 * ```
 *
 * The conclusion was drawn from reading their web app's network traffic — which posts a
 * quote and then signs in the browser — rather than from their SDK's surface. Watching
 * what a UI sends tells you what that UI does, not what the library can do.
 *
 * ## The SDK is injected, never imported here
 *
 * `packages/core` stays free of transports and of a dependency tree carrying ethers and
 * Solana clients. `buildPayload` is supplied by the server that has them, exactly as the
 * OFT rail takes its `quoteSend`. Without it this rail prices and does not send, and
 * says so — which is the honest state for a deployment that has not installed the SDK.
 */

const PRICE_API = 'https://price-api.mayan.finance';
const EXPLORER_API = 'https://explorer-api.mayan.finance';

/** Mayan keys chains by name, not by id. Read from `/v3/tokens`, 2026-09-11. */
const CHAIN_NAMES: Readonly<Record<number, string>> = {
  1: 'ethereum',
  10: 'optimism',
  56: 'bsc',
  137: 'polygon',
  8453: 'base',
  42161: 'arbitrum',
  43114: 'avalanche',
  59144: 'linea',
  792703809: 'solana',
};

const MONAD_USDC = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603';

interface MayanQuote {
  type?: string;
  meta?: { title?: string };
  expectedAmountOutBaseUnits?: string;
  minAmountOutBaseUnits?: string;
  etaSeconds?: number;
  slippageBps?: number;
  circleMaxFee64?: string;
  redeemRelayerFee64?: string;
  refundRelayerFee64?: string;
  swapRelayerFee64?: string;
  bridgeFee?: number;
  gasless?: boolean;
}

interface MayanQuoteResponse {
  quotes?: MayanQuote[];
  code?: string;
  message?: string;
  error?: string;
}

export interface MayanConfig {
  /** Mayan's referrer address. Server-side only, optional. */
  readonly referrer?: string;
  readonly referrerBps?: number;
  /**
   * Builds the signable transaction through Mayan's own SDK.
   *
   * Injected so this module needs neither the SDK nor a transport. When absent the rail
   * quotes and cannot send, which is a true statement about a build without the SDK
   * rather than a claim about Mayan.
   */
  readonly buildPayload?: (args: {
    /** Mayan's own quote object, passed back to its SDK untouched. */
    quote: unknown;
    swapper: string;
    destination: string;
    chainId: number;
  }) => Promise<{ to: string; data: string; value: string }>;
}

interface StashedRequest {
  readonly chain: FundingRequest['sourceChain'];
  readonly asset: FundingRequest['sourceAsset'];
  readonly recipient: string;
  readonly amountIn: string;
  readonly depositor: string | null;
  readonly vendorQuote: unknown;
}

export function createMayanRail(config: MayanConfig = {}): Rail {
  return {
    id: 'mayan',
    displayName: 'Mayan',
    explainer: 'An auction fills your order on Monad, with the price fixed up front.',

    supports(req) {
      return (
        req.amount > 0n &&
        CHAIN_NAMES[req.sourceChain.id] !== undefined &&
        ['USDC', 'USDT', 'SOL', 'ETH'].includes(req.sourceAsset.symbol.toUpperCase())
      );
    },

    async quote(req: FundingRequest, signal: AbortSignal): Promise<Quote | Decline> {
      assertRecipient(req, req.recipient);

      const fromChain = CHAIN_NAMES[req.sourceChain.id];
      if (!fromChain) {
        return { rail: 'mayan', reason: 'Mayan does not list this chain', raw: null };
      }

      // The body Mayan's own interface sends, minus the fields that are theirs alone
      // (their Solana program id, their forwarder, their own referrer).
      const body: Record<string, unknown> = {
        wormhole: true,
        swift: true,
        mctp: true,
        shuttle: false,
        fastMctp: true,
        gasless: true,
        onlyDirect: false,
        fullList: true,
        guaranteedOutput: true,
        monoChain: true,
        mpsDeposit: false,
        amountIn64: req.amount.toString(),
        fromToken: req.sourceAsset.address,
        fromChain,
        toToken: MONAD_USDC,
        toChain: 'monad',
        slippageBps: 'auto',
        sdkVersion: '15_2_1',
        ...(config.referrer ? { referrer: config.referrer } : {}),
        ...(config.referrerBps ? { referrerBps: config.referrerBps } : {}),
      };

      const res = await fetch(`${PRICE_API}/v3/quote`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
      const json = (await res.json()) as MayanQuoteResponse;

      // 201 on success, not 200. `res.ok` covers both; an equality check would not.
      if (!res.ok || !json.quotes || json.quotes.length === 0) {
        return {
          rail: 'mayan',
          reason: json.message ?? json.error ?? json.code ?? `Mayan answered ${res.status}`,
          raw: json,
        };
      }

      // Mayan returns several routes. The best of its own offers is the one to compare,
      // chosen on what actually arrives — the same rule the router applies across rails.
      let best: MayanQuote | undefined;
      for (const q of json.quotes) {
        if (!q.expectedAmountOutBaseUnits) continue;
        if (!best || BigInt(q.expectedAmountOutBaseUnits) > BigInt(best.expectedAmountOutBaseUnits ?? '0')) {
          best = q;
        }
      }
      if (!best?.expectedAmountOutBaseUnits) {
        return { rail: 'mayan', reason: 'Mayan returned no priced route', raw: json };
      }

      const fees: QuoteFee[] = [];
      const push = (label: string, v?: string, token = 'USDC') => {
        if (v && BigInt(v) > 0n) fees.push({ label, amount: BigInt(v), token });
      };
      // Mayan's own field names, kept as its own labels.
      push('circleMaxFee', best.circleMaxFee64);
      push('redeemRelayerFee', best.redeemRelayerFee64);
      push('swapRelayerFee', best.swapRelayerFee64);

      return {
        rail: 'mayan',
        amountIn: req.amount,
        amountOut: BigInt(best.expectedAmountOutBaseUnits),
        outToken: 'USDC',
        fees,
        etaSeconds: best.etaSeconds ?? 0,
        expiresAt: Date.now() + 60_000,
        landsIn: 'wallet',
        /**
         * False, and it is the honest answer.
         *
         * Mayan prices this route and would carry it. What this app cannot yet do is
         * build the order: their source transaction is constructed by their SDK, not
         * returned as calldata, and this repository does not ship a transaction it
         * reconstructed from a shape it inferred. So the number is shown, ranked below
         * every rail that can actually send, and no button is offered.
         */
        // The order is placed by the user's own transaction on the source chain.
        needsWallet: true,
        // Only where a builder was supplied. Without one the price is real and the
        // button is absent, rather than a button that leads nowhere.
        executable:
          typeof config.buildPayload === 'function' &&
          typeof req.senderAddress === 'string' &&
          req.senderAddress.length > 0,
        raw: {
          ...json,
          __request: {
            chain: req.sourceChain,
            asset: req.sourceAsset,
            recipient: req.recipient,
            amountIn: req.amount.toString(),
            depositor: req.senderAddress ?? null,
            // Mayan's own quote object, kept verbatim: its SDK takes back the thing it
            // gave out, and reconstructing one would be inventing a shape.
            vendorQuote: best,
          } satisfies StashedRequest,
        },
      };
    },

    /**
     * Approve Mayan's forwarder, then place the order with the SDK's own calldata.
     *
     * The transaction is **not** built here. Mayan's SDK returns `to`, `data` and
     * `value` already encoded for a Swift or MCTP order, and re-deriving that from an
     * ABI would mean guessing at an order struct they have already filled in correctly.
     * What this adds is the approval in front of it, and a label on each, so nothing is
     * signed unexplained.
     */
    ...(config.buildPayload
      ? {
          async buildSourceTx(quote: Quote): Promise<SourceTxPlan> {
            const raw = quote.raw as { __request?: StashedRequest };
            const req = raw.__request;
            if (!req) throw new Error('quote is missing the request it was made from');
            if (!req.depositor) {
              throw new Error(
                'Mayan needs the address that will send, and this quote was priced ' +
                  'without one. Connect the wallet holding the money and get a fresh price.',
              );
            }

            const payload = await config.buildPayload!({
              quote: req.vendorQuote,
              swapper: req.depositor,
              destination: req.recipient,
              chainId: req.chain.id,
            });

            const amount = BigInt(req.amountIn);
            const approve: SourceTx = {
              chainId: req.chain.id,
              to: req.asset.address,
              data: encodeFunctionData({
                abi: erc20Abi,
                functionName: 'approve',
                args: [payload.to as Address, amount],
              }),
              value: '0',
              // Exactly the amount, never unlimited.
              label: `Allow Mayan to move ${req.asset.symbol}`,
            };
            const order: SourceTx = {
              chainId: req.chain.id,
              to: payload.to,
              data: payload.data,
              value: payload.value,
              label: `Place your order with Mayan`,
            };
            return { kind: 'wallet-signed', rail: 'mayan', chain: req.chain, txs: [approve, order], raw };
          },
        }
      : {}),

    /**
     * `GET /v3/swap/trx/{hash}`.
     *
     * Verified 2026-09-11: an unknown hash answers HTTP 404
     * `{"statusCode":404,...,"message":"Transaction not found"}`. Nothing this app has
     * sent will ever be found there today, because it does not send — this is written so
     * that the day execution lands, the polling does not have to be invented then.
     */
    async status(ref: RailRef): Promise<RailStatus> {
      const res = await fetch(`${EXPLORER_API}/v3/swap/trx/${encodeURIComponent(ref.ref)}`);
      const json = (await res.json()) as {
        status?: string;
        clientStatus?: string;
        message?: string;
        fulfillTxHash?: string;
        destTxHash?: string;
      };
      if (!res.ok) {
        return {
          state: 'awaiting-source',
          message: json.message ?? `Mayan answered ${res.status}`,
          raw: json,
        };
      }
      const s = (json.clientStatus ?? json.status ?? '').toLowerCase();
      const state =
        s === 'completed' || s === 'settled'
          ? 'delivered'
          : s === 'refunded'
            ? 'refunded'
            : s === 'inprogress'
              ? 'in-flight'
              : 'awaiting-source';
      const hash = json.destTxHash ?? json.fulfillTxHash;
      return {
        state,
        ...(json.clientStatus ?? json.status ? { message: json.clientStatus ?? json.status ?? '' } : {}),
        ...(hash ? { destinationTxHash: hash } : {}),
        raw: json,
      };
    },
  };
}
