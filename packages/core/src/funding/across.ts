import { encodeFunctionData, erc20Abi, parseAbi, type Address } from 'viem';
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
 * Across — `https://app.across.to/api`.
 *
 * Verified live on 2026-09-11. It turned out to be the **broadest** verified rail into
 * Monad, not the second intent rail the plan expected: `/available-routes` returns
 * **32 routes** from 20 chains, it is the only verified rail that delivers **USDT0**,
 * and it covers **Tron**. The route table follows what it actually listed.
 *
 * Observed for Base USDC to Monad USDC, 5.000000:
 *
 * ```
 * estimatedFillTimeSec 4      relayFeeTotal 1180 (0.0236%)
 * limits.minDeposit    500076 (0.500076 USDC)
 * Monad SpokePool      0xd2ecb3afe598b746F8123CaE365a598DA831A449
 * ```
 *
 * The minimum is **not** encoded here. `isAmountTooLow` comes back on the quote and is
 * surfaced as a decline in Across's own terms, so the figure is always today's.
 */

const BASE = 'https://app.across.to/api';
const MONAD_CHAIN_ID = 143;

/**
 * What Across delivers on Monad, per `/available-routes` on 2026-09-11.
 *
 * Held as data rather than derived at request time because `supports()` is synchronous
 * by contract; the live list drives the UI's coverage endpoint, and a test asserts this
 * table never claims a route the live list does not have.
 */
export const ACROSS_ROUTES: readonly {
  readonly chainId: number;
  readonly inSymbol: string;
  readonly outToken: 'USDC' | 'USDT0';
}[] = [
  { chainId: 1, inSymbol: 'USDC', outToken: 'USDC' },
  { chainId: 1, inSymbol: 'USDT', outToken: 'USDT0' },
  { chainId: 10, inSymbol: 'USDC', outToken: 'USDC' },
  { chainId: 10, inSymbol: 'USDT', outToken: 'USDT0' },
  { chainId: 56, inSymbol: 'USDC-BNB', outToken: 'USDC' },
  { chainId: 56, inSymbol: 'USDT-BNB', outToken: 'USDT0' },
  { chainId: 130, inSymbol: 'USDC', outToken: 'USDC' },
  { chainId: 130, inSymbol: 'USDT', outToken: 'USDT0' },
  { chainId: 137, inSymbol: 'USDC', outToken: 'USDC' },
  { chainId: 137, inSymbol: 'USDT', outToken: 'USDT0' },
  { chainId: 324, inSymbol: 'USDC.e', outToken: 'USDC' },
  { chainId: 324, inSymbol: 'USDT', outToken: 'USDT0' },
  { chainId: 480, inSymbol: 'USDC', outToken: 'USDC' },
  { chainId: 999, inSymbol: 'USDC', outToken: 'USDC' },
  { chainId: 999, inSymbol: 'USDT', outToken: 'USDT0' },
  { chainId: 8453, inSymbol: 'USDC', outToken: 'USDC' },
  { chainId: 8453, inSymbol: 'USDT', outToken: 'USDT0' },
  { chainId: 42161, inSymbol: 'USDC', outToken: 'USDC' },
  { chainId: 42161, inSymbol: 'USDT', outToken: 'USDT0' },
  { chainId: 43114, inSymbol: 'USDC', outToken: 'USDC' },
  { chainId: 43114, inSymbol: 'USDT', outToken: 'USDT0' },
  { chainId: 57073, inSymbol: 'USDC', outToken: 'USDC' },
  { chainId: 57073, inSymbol: 'USDT', outToken: 'USDT0' },
  { chainId: 59144, inSymbol: 'USDC', outToken: 'USDC' },
  { chainId: 59144, inSymbol: 'USDT', outToken: 'USDT0' },
  { chainId: 728126428, inSymbol: 'USDT', outToken: 'USDT0' },
];

const MONAD_TOKEN_ADDRESS = {
  USDC: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603',
  USDT0: '0xe7cd86e13AC4309349F30B3435a9d337750fC82D',
} as const;

interface AcrossFees {
  estimatedFillTimeSec?: number;
  relayFeeTotal?: string;
  capitalFeeTotal?: string;
  relayGasFeeTotal?: string;
  lpFeePct?: string;
  isAmountTooLow?: boolean;
  spokePoolAddress?: string;
  destinationSpokePoolAddress?: string;
  limits?: { minDeposit?: string; maxDeposit?: string };
  outputAmount?: string;
  message?: string;
  /** Unix seconds. Must be inside `depositQuoteTimeBuffer` (3600s) at send time. */
  timestamp?: string;
  exclusiveRelayer?: string;
  /** Seconds of exclusivity, counted from the deposit block. See `depositV3` below. */
  exclusivityDeadline?: number;
  quoteBlock?: string;
}

/**
 * The deposit call, as it is actually deployed.
 *
 * Not transcribed from documentation: `depositV3` was encoded with these exact types and
 * simulated against the live Base SpokePool `0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64`
 * on 2026-09-11 (selector `0x7b939232`). It reverted with
 * `ERC20: transfer amount exceeds allowance` — which is the token complaining, not the
 * SpokePool: the call reached the transfer, so the signature, the argument order and
 * every type are right. A wrong ABI fails earlier and differently.
 */
const SPOKE_POOL_ABI = parseAbi([
  'function depositV3(address depositor,address recipient,address inputToken,address outputToken,uint256 inputAmount,uint256 outputAmount,uint256 destinationChainId,address exclusiveRelayer,uint32 quoteTimestamp,uint32 fillDeadline,uint32 exclusivityDeadline,bytes message) payable',
]);

/**
 * Read live from the Base SpokePool on 2026-09-11:
 *
 * ```
 * getCurrentTime()           1789080945
 * depositQuoteTimeBuffer()   3600      quoteTimestamp must be within this of now
 * fillDeadlineBuffer()       21600     fillDeadline must be within this of now
 * MAX_EXCLUSIVITY_PERIOD_SECONDS 31536000
 * ```
 *
 * `exclusivityDeadline` is an **offset in seconds**, not an absolute time, for any value
 * up to `MAX_EXCLUSIVITY_PERIOD_SECONDS`. The API returns `3`, which is three seconds of
 * exclusivity for the named relayer and not a timestamp in 1970 — passing it through
 * unchanged is correct, and converting it to an absolute time would be the bug.
 */
const FILL_DEADLINE_BUFFER_SECONDS = 21_600;
/** Half the buffer: comfortably inside it, and still hours for a relayer to fill. */
const FILL_DEADLINE_SECONDS = FILL_DEADLINE_BUFFER_SECONDS / 2;

/** The request a quote was made from, stashed so the deposit can be built from it. */
interface StashedRequest {
  readonly chain: FundingRequest['sourceChain'];
  readonly asset: FundingRequest['sourceAsset'];
  readonly recipient: Address;
  readonly outputToken: string;
  readonly amountIn: string;
  /** The address that will sign the deposit. Null where the quote was priced without one. */
  readonly depositor: string | null;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface AcrossConfig {
  /** Server-side only. Across asks integrators to identify themselves. */
  readonly integratorId?: string;
}

export function createAcrossRail(config: AcrossConfig = {}): Rail {
  return {
    id: 'across',
    displayName: 'Across',
    explainer: 'Relayers fill your deposit on Monad, usually in a few seconds.',

    supports(req) {
      return (
        req.amount > 0n &&
        ACROSS_ROUTES.some(
          (r) =>
            r.chainId === req.sourceChain.id &&
            r.inSymbol.toUpperCase() === req.sourceAsset.symbol.toUpperCase(),
        )
      );
    },

    async quote(req: FundingRequest, signal: AbortSignal): Promise<Quote | Decline> {
      assertRecipient(req, req.recipient);

      const route = ACROSS_ROUTES.find(
        (r) =>
          r.chainId === req.sourceChain.id &&
          r.inSymbol.toUpperCase() === req.sourceAsset.symbol.toUpperCase(),
      );
      if (!route) {
        return { rail: 'across', reason: 'Across does not list this route', raw: null };
      }

      const url =
        `${BASE}/suggested-fees?inputToken=${req.sourceAsset.address}` +
        `&outputToken=${MONAD_TOKEN_ADDRESS[route.outToken]}` +
        `&originChainId=${req.sourceChain.id}&destinationChainId=${MONAD_CHAIN_ID}` +
        `&amount=${req.amount.toString()}`;

      const res = await fetch(url, {
        signal,
        headers: config.integratorId ? { 'x-integrator-id': config.integratorId } : {},
      });
      const json = (await res.json()) as AcrossFees;

      if (!res.ok) {
        return {
          rail: 'across',
          reason: json.message ?? `Across answered ${res.status}`,
          raw: json,
        };
      }
      if (json.isAmountTooLow) {
        // Across's own words for its own floor. The figure is never written here.
        const min = json.limits?.minDeposit;
        return {
          rail: 'across',
          reason: min
            ? `Across will not carry this amount. Its current minimum is ${min} base units.`
            : 'Across will not carry this amount right now.',
          raw: json,
        };
      }

      // Across quotes fees, not an output; the output is the input minus the total fee.
      const relayFee = BigInt(json.relayFeeTotal ?? '0');
      const amountOut = req.amount - relayFee;
      const fees: QuoteFee[] = [];
      const push = (label: string, v?: string) => {
        if (v && BigInt(v) > 0n) {
          fees.push({ label, amount: BigInt(v), token: req.sourceAsset.symbol });
        }
      };
      push('capitalFee', json.capitalFeeTotal);
      push('relayGasFee', json.relayGasFeeTotal);

      return {
        rail: 'across',
        amountIn: req.amount,
        amountOut,
        outToken: route.outToken,
        fees,
        etaSeconds: json.estimatedFillTimeSec ?? 0,
        expiresAt: Date.now() + 60_000,
        // Across's destination multicall was not verified, so nothing claims margin
        // delivery here. The Move card finishes it, gaslessly.
        landsIn: 'wallet',
        // Across needs the user's own wallet on the source chain to sign the SpokePool
        // deposit. That wallet now exists, so this rail can be acted on - but only by
        // somebody who has connected one, which is what `senderAddress` stands for
        // here. Without it there is nobody to sign, and a quote nobody can act on must
        // not outrank one they can.
        // A SpokePool deposit is signed by the user's own wallet on the source chain.
        needsWallet: true,
        executable: typeof req.senderAddress === 'string' && req.senderAddress.length > 0,
        raw: {
          ...json,
          __request: {
            chain: req.sourceChain,
            asset: req.sourceAsset,
            recipient: req.recipient,
            outputToken: MONAD_TOKEN_ADDRESS[route.outToken],
            amountIn: req.amount.toString(),
            depositor: req.senderAddress ?? null,
          } satisfies StashedRequest,
        },
      };
    },

    /**
     * Approve, then deposit. Two transactions, in that order, both the user's own.
     *
     * ## Every number here came from the quote, not from this file
     *
     * `outputAmount` is `inputAmount - relayFeeTotal` - Across prices a fee, not an
     * output, and paying a relayer means promising them the difference.
     *
     * `quoteTimestamp` is Across's own `timestamp`, which the SpokePool checks against
     * `depositQuoteTimeBuffer()` (3600s, read from the contract). A stale quote is
     * rejected on chain, which is the right place for that check and the reason this
     * builds from Across's figure rather than silently substituting `now`.
     *
     * `exclusiveRelayer` and `exclusivityDeadline` are passed through untouched. The
     * deadline is an **offset in seconds** for any value up to
     * `MAX_EXCLUSIVITY_PERIOD_SECONDS` (31536000, read from the contract), so the `3`
     * the API returns is three seconds of exclusivity for the named relayer. Treating
     * it as an absolute timestamp would silently disable exclusivity on every deposit.
     *
     * `fillDeadline` is the one value chosen here, at half of the contract's own
     * `fillDeadlineBuffer()` (21600s). Beyond that buffer the SpokePool reverts.
     */
    async buildSourceTx(quote: Quote): Promise<SourceTxPlan> {
      const raw = quote.raw as AcrossFees & { __request?: StashedRequest };
      const req = raw.__request;
      if (!req) throw new Error('quote is missing the request it was made from');

      const spokePool = raw.spokePoolAddress;
      if (!spokePool) {
        throw new Error('Across did not name a SpokePool for this route, so nothing can be built.');
      }
      const quoteTimestamp = Number(raw.timestamp ?? 0);
      if (!Number.isFinite(quoteTimestamp) || quoteTimestamp <= 0) {
        throw new Error('Across returned no quote timestamp, and the SpokePool requires one.');
      }
      const depositor = req.depositor;
      if (!depositor) {
        throw new Error(
          'Across needs the address that will send, and this quote was priced without ' +
            'one. Connect the wallet holding the money and get a fresh price.',
        );
      }

      const now = Math.floor(Date.now() / 1000);
      const inputAmount = BigInt(req.amountIn);

      const approve: SourceTx = {
        chainId: req.chain.id,
        to: req.asset.address,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [spokePool as Address, inputAmount],
        }),
        value: '0',
        // Exactly the amount, never unlimited: an allowance that outlives the deposit
        // is an allowance somebody else can spend later.
        label: `Allow Across to move ${req.asset.symbol}`,
      };

      const deposit: SourceTx = {
        chainId: req.chain.id,
        to: spokePool,
        data: encodeFunctionData({
          abi: SPOKE_POOL_ABI,
          functionName: 'depositV3',
          args: [
            depositor as Address,
            req.recipient,
            req.asset.address as Address,
            req.outputToken as Address,
            inputAmount,
            quote.amountOut,
            BigInt(MONAD_CHAIN_ID),
            (raw.exclusiveRelayer ?? ZERO_ADDRESS) as Address,
            quoteTimestamp,
            now + FILL_DEADLINE_SECONDS,
            raw.exclusivityDeadline ?? 0,
            '0x',
          ],
        }),
        value: '0',
        label: `Send ${req.asset.symbol} to Across`,
      };

      return {
        kind: 'wallet-signed',
        rail: 'across',
        chain: req.chain,
        txs: [approve, deposit],
        raw,
      };
    },

    /**
     * `GET /deposit/status?originChainId=&depositTxHash=`.
     *
     * Verified live on 2026-09-11: an unknown deposit answers HTTP 404 with
     * `{"error":"DepositNotFoundException","message":"Deposit not found given the
     * provided constraints"}`. That is a real answer, and it is also what a deposit
     * looks like in the seconds before Across has indexed it - so it maps to
     * `awaiting-source`, not to a failure. Calling that race a failure is how a user
     * gets told their money is gone thirty seconds before it arrives.
     */
    async status(ref: RailRef): Promise<RailStatus> {
      const params = new URLSearchParams();
      if (ref.sourceChainId) params.set('originChainId', String(ref.sourceChainId));
      params.set('depositTxHash', ref.sourceTxHash ?? ref.ref);

      const res = await fetch(`${BASE}/deposit/status?${params.toString()}`, {
        headers: config.integratorId ? { 'x-integrator-id': config.integratorId } : {},
      });
      const json = (await res.json()) as {
        status?: string;
        error?: string;
        message?: string;
        fillTx?: string;
        depositId?: string;
      };

      if (!res.ok) {
        return {
          state: json.error === 'DepositNotFoundException' ? 'awaiting-source' : 'in-flight',
          message: json.message ?? `Across answered ${res.status}`,
          raw: json,
        };
      }

      // Across's own words drive the screen; this mapping drives the state machine only.
      const s = (json.status ?? '').toLowerCase();
      const state =
        s === 'filled'
          ? 'delivered'
          : s === 'refunded' || s === 'expired'
            ? 'refunded'
            : s === 'pending' || s === 'slowfillrequested'
              ? 'in-flight'
              : 'awaiting-source';
      return {
        state,
        ...(json.status ? { message: json.status } : {}),
        ...(json.fillTx ? { destinationTxHash: json.fillTx } : {}),
        raw: json,
      };
    },
  };
}
