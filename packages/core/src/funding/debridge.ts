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
 * deBridge DLN — `https://deswap.debridge.finance`.
 *
 * ## This rail was recorded as permanently unavailable, and that was wrong
 *
 * On 2026-09-11 an earlier pass read `/v1.0/supported-chains-info`, counted 17 chains,
 * did not find Monad, and wrote deBridge into the screen as a standing refusal with the
 * date attached. Re-checked the same day against the same endpoint:
 *
 * ```
 * GET https://dln.debridge.finance/v1.0/supported-chains-info   HTTP 200, 17 chains
 *   {"chainId":100000030,"originalChainId":143,"chainName":"Monad"}
 * ```
 *
 * Still seventeen. Different seventeen. **Monad is in the list**, and the reason the
 * first search missed it is the thing that matters here: deBridge addresses Monad as
 * `100000030`, not as `143`. `143` appears only as `originalChainId`. A search for the
 * chain id every other vendor uses finds nothing and concludes the chain is absent.
 *
 * That is why this file states its evidence rather than its conclusion. The conclusion
 * was wrong for a day, and the raw response is what made that visible (R11: live
 * observation wins).
 *
 * ## What it answered, from a plain server with no browser
 *
 * ```
 * Base     USDC   5.000000 -> 4.988053   HTTP 200
 * Base     USDC  20.000000 -> 19.968060  HTTP 200
 * Base     USDC 100.000000 -> 99.840275  HTTP 200
 * Arbitrum USDC  20.000000 -> 19.968059  HTTP 200
 * tx.to 0xeF4fB24aD0916217251F553c0596F8Edc630EB66   tx.value 1000000000000000
 * ```
 *
 * ## The fee that is not in the fee list
 *
 * `tx.value` is **0.001 native token** — 0.001 ETH on Base, and it is charged on top of
 * the USDC. It does not appear in `costsDetails`, and deBridge's own interface did not
 * show it before a wallet was connected. On a $5 deposit it is very likely the largest
 * cost of the transfer. It is surfaced here as a named fee for exactly that reason: a
 * rail that quietly charges more than the number on the card is worse than one that
 * charges more and says so.
 *
 * This rail does not price that fee in dollars. It does not know the price of ETH, and a
 * converted figure it made up would be worse than the exact quantity in the token it is
 * actually charged in.
 */

const CREATE_TX = 'https://deswap.debridge.finance/v1.0/dln/order/create-tx';
const ORDERS = 'https://dln-api.debridge.finance/api/Orders';

/** deBridge's own id for Monad. Read from `/supported-chains-info`, 2026-09-11. */
export const DEBRIDGE_MONAD_CHAIN_ID = 100_000_030;
const MONAD_USDC = '0x754704bc059f8c67012fed69bc8a327a5aafb603';

/** Source chains deBridge listed, keyed by the id everyone else uses. */
const SUPPORTED_SOURCES = new Set([1, 10, 56, 137, 8453, 42161, 43114, 59144, 792703809]);

interface DebridgeToken {
  chainId?: number;
  address?: string;
  symbol?: string;
  decimals?: number;
  amount?: string;
  approximateUsdValue?: number;
}

interface DebridgeCost {
  chain?: string;
  type?: string;
  amountIn?: string;
  amountOut?: string;
  payload?: { feeAmount?: string; feeBps?: string; feeApproximateUsdValue?: string };
}

interface DebridgeCreateTx {
  estimation?: {
    srcChainTokenIn?: DebridgeToken;
    dstChainTokenOut?: DebridgeToken;
    costsDetails?: DebridgeCost[];
    recommendedSlippage?: number;
  };
  tx?: { to?: string; data?: string; value?: string };
  order?: { approximateFulfillmentDelay?: number };
  orderId?: string;
  fixFee?: string;
  errorId?: string;
  errorMessage?: string;
  message?: string;
}

export interface DebridgeConfig {
  /** deBridge's referral code. Server-side only, and optional. */
  readonly referralCode?: string;
}

interface StashedRequest {
  readonly chain: FundingRequest['sourceChain'];
  readonly asset: FundingRequest['sourceAsset'];
  readonly amountIn: string;
}

export function createDebridgeRail(config: DebridgeConfig = {}): Rail {
  return {
    id: 'debridge',
    displayName: 'deBridge',
    explainer: 'A taker fills your order on Monad, usually within a second or two.',

    supports(req) {
      return (
        req.amount > 0n &&
        SUPPORTED_SOURCES.has(req.sourceChain.id) &&
        ['USDC', 'USDT'].includes(req.sourceAsset.symbol.toUpperCase())
      );
    },

    async quote(req: FundingRequest, signal: AbortSignal): Promise<Quote | Decline> {
      assertRecipient(req, req.recipient);

      /**
       * `prependOperatingExpenses=false` on purpose.
       *
       * With it `true` — which is what deBridge's own interface sends — the input is
       * inflated so the *output* comes out round: ask for $5 and you are quoted paying
       * 5.007954 to receive 4.996001. That is a fine thing for their UI to do and a
       * wrong thing for this one, where every rail is compared on "you send exactly
       * this, you receive that". With it `false` the input is exactly what the user
       * typed and the expense comes out of the output, which is the same comparison
       * every other rail here is quoted on.
       */
      const params = new URLSearchParams({
        srcChainId: String(req.sourceChain.id),
        srcChainTokenIn: req.sourceAsset.address,
        srcChainTokenInAmount: req.amount.toString(),
        dstChainId: String(DEBRIDGE_MONAD_CHAIN_ID),
        dstChainTokenOut: MONAD_USDC,
        dstChainTokenOutAmount: 'auto',
        prependOperatingExpenses: 'false',
        dstChainTokenOutRecipient: req.recipient,
        dstChainOrderAuthorityAddress: req.recipient,
        // Who may cancel the order on the source side. The sender where we know them,
        // and never this app: a cancel authority we held would be a way for us to claw
        // back a user's own order.
        srcChainOrderAuthorityAddress: req.senderAddress ?? req.recipient,
        ...(config.referralCode ? { referralCode: config.referralCode } : {}),
      });

      const res = await fetch(`${CREATE_TX}?${params.toString()}`, { signal });
      const json = (await res.json()) as DebridgeCreateTx;

      const out = json.estimation?.dstChainTokenOut?.amount;
      if (!res.ok || !out) {
        // deBridge's own sentence (R5).
        return {
          rail: 'debridge',
          reason: json.errorMessage ?? json.message ?? `deBridge answered ${res.status}`,
          raw: json,
        };
      }

      const fees: QuoteFee[] = [];
      for (const cost of json.estimation?.costsDetails ?? []) {
        const amount = cost.payload?.feeAmount;
        if (!amount || BigInt(amount) === 0n) continue;
        fees.push({
          // deBridge's own type names: DlnProtocolFee, TakerMargin,
          // EstimatedOperatingExpenses. Shown as it labels them.
          label: cost.type ?? 'fee',
          amount: BigInt(amount),
          token: req.sourceAsset.symbol,
          ...(cost.payload?.feeApproximateUsdValue
            ? { usd: cost.payload.feeApproximateUsdValue }
            : {}),
        });
      }
      // The one that is not in `costsDetails`, and on a small deposit is the biggest.
      const fixFee = json.fixFee ?? json.tx?.value;
      if (fixFee && BigInt(fixFee) > 0n) {
        fees.push({
          label: 'deBridge fixed fee, paid in the chain’s own token',
          amount: BigInt(fixFee),
          token: nativeSymbol(req.sourceChain.id),
        });
      }

      return {
        rail: 'debridge',
        amountIn: req.amount,
        amountOut: BigInt(out),
        outToken: 'USDC',
        fees,
        etaSeconds: json.order?.approximateFulfillmentDelay ?? 0,
        expiresAt: Date.now() + 60_000,
        landsIn: 'wallet',
        // The order is placed by the user's own transaction on the source chain.
        needsWallet: true,
        executable: typeof req.senderAddress === 'string' && req.senderAddress.length > 0,
        raw: {
          ...json,
          __request: {
            chain: req.sourceChain,
            asset: req.sourceAsset,
            amountIn: req.amount.toString(),
          } satisfies StashedRequest,
        },
      };
    },

    /**
     * Approve, then place the order with deBridge's own calldata.
     *
     * The transaction is **not built here**. deBridge returns `tx.to`, `tx.data` and
     * `tx.value` already encoded, and re-deriving that from an ABI would mean guessing
     * at an order struct they have already filled in correctly — exactly the kind of
     * plausible-looking reconstruction A2.5 forbids. What this does is put an approval
     * in front of it and label both, so nothing is signed unexplained.
     *
     * `tx.value` carries the fixed fee. It is passed through unchanged: a value this
     * app trimmed would be an order deBridge rejects.
     */
    async buildSourceTx(quote: Quote): Promise<SourceTxPlan> {
      const raw = quote.raw as DebridgeCreateTx & { __request?: StashedRequest };
      const req = raw.__request;
      if (!req) throw new Error('quote is missing the request it was made from');
      const to = raw.tx?.to;
      const data = raw.tx?.data;
      if (!to || !data) {
        throw new Error('deBridge returned no transaction for this order.');
      }

      const approve: SourceTx = {
        chainId: req.chain.id,
        to: req.asset.address,
        data: erc20ApproveData(to, BigInt(req.amountIn)),
        value: '0',
        label: `Allow deBridge to move ${req.asset.symbol}`,
      };
      const place: SourceTx = {
        chainId: req.chain.id,
        to,
        data,
        value: raw.tx?.value ?? '0',
        label: `Place your order with deBridge`,
      };
      return { kind: 'wallet-signed', rail: 'debridge', chain: req.chain, txs: [approve, place], raw };
    },

    /**
     * `GET /api/Orders/{orderId}`.
     *
     * Verified 2026-09-11: an order that has been quoted but not placed answers
     * HTTP 422 `{"message":"Order not found","errorCode":422}`. A quoted order genuinely
     * does not exist yet — the id is deterministic and issued before anything is signed
     * — so that maps to `awaiting-source` and not to a failure.
     */
    async status(ref: RailRef): Promise<RailStatus> {
      const res = await fetch(`${ORDERS}/${encodeURIComponent(ref.ref)}`);
      const json = (await res.json()) as {
        state?: string;
        status?: string;
        message?: string;
        fulfilledDstEventMetadata?: { transactionHash?: { stringValue?: string } };
      };
      if (!res.ok) {
        return {
          state: 'awaiting-source',
          message: json.message ?? `deBridge answered ${res.status}`,
          raw: json,
        };
      }
      const s = (json.state ?? json.status ?? '').toLowerCase();
      const state =
        s === 'fulfilled' || s === 'claimedunlock' || s === 'sentunlock'
          ? 'delivered'
          : s === 'ordercancelled' || s === 'sentordercancel' || s === 'claimedordercancel'
            ? 'refunded'
            : s === 'created'
              ? 'in-flight'
              : 'awaiting-source';
      const hash = json.fulfilledDstEventMetadata?.transactionHash?.stringValue;
      return {
        state,
        ...(json.state ? { message: json.state } : {}),
        ...(hash ? { destinationTxHash: hash } : {}),
        raw: json,
      };
    },
  };
}

/** The token gas is paid in, per chain. Only used to label deBridge's fixed fee. */
function nativeSymbol(chainId: number): string {
  if (chainId === 56) return 'BNB';
  if (chainId === 137) return 'POL';
  if (chainId === 43114) return 'AVAX';
  if (chainId === 792703809) return 'SOL';
  return 'ETH';
}

/** `approve(spender, amount)`, hand-encoded to keep this module free of viem's ABI path. */
function erc20ApproveData(spender: string, amount: bigint): string {
  const pad = (hex: string) => hex.replace(/^0x/, '').padStart(64, '0');
  return `0x095ea7b3${pad(spender)}${pad(amount.toString(16))}`;
}
