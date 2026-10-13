import { encodeFunctionData, erc20Abi, parseAbi, type Address } from 'viem';
import {
  assertRecipient,
  type Decline,
  type FundingRequest,
  type MonadToken,
  type Quote,
  type QuoteFee,
  type Rail,
  type RailId,
  type RailRef,
  type RailStatus,
  type SourceTx,
  type SourceTxPlan,
} from './types.js';

/**
 * LayerZero OFT — AUSD and USDT0 over their own bridges.
 *
 * The only rails here that are not a marketplace. There is no solver, no relayer
 * competing to fill, and no price: the token is burned or locked on one side and the same
 * quantity is issued on the other. `quoteOFT` confirmed it — `oftReceipt (5000000,
 * 5000000)`, one to one, no protocol fee and no dust removal, because local decimals and
 * shared decimals are both 6 on every route below. What the user pays instead is a
 * **native-token message fee** on the source chain, which LayerZero quotes per send.
 *
 * ## Everything here was read from the chain on 2026-09-11
 *
 * ```
 * LayerZero EndpointV2 on Monad   0x6F475642a6e85809B1c36Fa62763669b1b48DD5B   eid() 30390
 * The near-universal endpoint     0x1a44076050125825900e736c501f859c50fE728c   NO CODE on Monad
 * ```
 *
 * That second line is the trap. `0x1a4407…` is the LayerZero EndpointV2 address on almost
 * every chain, and on Monad it is an empty account. Anything that hardcodes it for Monad
 * fails without a useful error.
 *
 * Live `quoteSend` at 5.000000, recipient 0x714f…86E6, `extraOptions: '0x'`:
 *
 * ```
 * AUSD  Base     -> Monad   nativeFee 100598487792126 wei   lzTokenFee 0
 * AUSD  Ethereum -> Monad   nativeFee 200263570855039 wei   lzTokenFee 0
 * USDT0 Arbitrum -> Monad   nativeFee 100314933811264 wei   lzTokenFee 0
 * USDT0 Ethereum -> Monad   nativeFee 199953520176901 wei   lzTokenFee 0
 * USDT0 Base     -> Monad   REVERTS: NoPeer(30390)
 * ```
 *
 * ## USDT0 from Base does not exist, and is not a bug on our side
 *
 * `peers(30390)` is the zero word on the Base USD₮0 adapter, and `peers(30184)` is the
 * zero word on the Monad one. The lane is unwired at both ends, so `_lzReceive` on Monad
 * would reject the message even if Base sent it. It is absent from the route table below
 * for that reason, and `supports()` declines it rather than quoting something that
 * reverts.
 *
 * ## The adapter is never the token
 *
 * An earlier note in this repository said the AUSD adapter *was* the token, and used that
 * to explain why no approval is needed. The conclusion was right and the reason was
 * wrong: `0x9CaB7Ede…689b` and `0x00000000eFE3…012a` are different contracts, and the
 * adapter is a verified `AgoraMintBurnOFTAdapter` that holds burn rights over AUSD. What
 * actually decides an approval is `approvalRequired()`, read per route — and it is
 * **true** for USDT0 from Ethereum, where the adapter is a lockbox over real USDT. A rule
 * generalised from the wrong reason would have skipped that approval and produced a
 * transaction that reverts.
 */

/** Read from `EndpointV2.eid()` on Monad, 2026-09-11. Not taken from documentation. */
export const MONAD_LZ_EID = 30390;

/** `0x1a4407…` has no code on Monad. This is the one that does. */
export const MONAD_LZ_ENDPOINT = '0x6F475642a6e85809B1c36Fa62763669b1b48DD5B' as const;

export interface OftRoute {
  readonly rail: Extract<RailId, 'oft-ausd' | 'oft-usdt0'>;
  readonly sourceChainId: number;
  /** The token the user holds on the source chain. */
  readonly sourceToken: string;
  readonly sourceSymbol: string;
  readonly decimals: number;
  /** The OFT adapter to call. Never the token, on any of these routes. */
  readonly adapter: string;
  /**
   * `approvalRequired()`, read from the adapter. `true` only where the adapter is a
   * lockbox that must pull the token, rather than one with burn rights over it.
   */
  readonly approvalRequired: boolean;
  /**
   * USDT's `approve` reverts on a non-zero-to-non-zero change. Where this is set the
   * plan resets the allowance to zero first, which is one extra signature and the only
   * way that token can be re-approved.
   */
  readonly resetAllowanceFirst?: boolean;
  readonly delivers: MonadToken;
}

/**
 * Only lanes confirmed wired at **both** ends, with a `quoteSend` that returned a fee.
 *
 * `outboundNonce`/`inboundNonce` on the endpoints show these are in live use, not merely
 * configured: AUSD Base→Monad 72/72, USDT0 Arbitrum→Monad 2001/2001, USDT0
 * Ethereum→Monad 1964/1964.
 */
export const OFT_ROUTES: readonly OftRoute[] = [
  {
    rail: 'oft-ausd',
    sourceChainId: 8453,
    sourceToken: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a',
    sourceSymbol: 'AUSD',
    decimals: 6,
    adapter: '0x9CaB7Ede13dc56652E44D2404E969C212f22689b',
    approvalRequired: false,
    delivers: 'AUSD',
  },
  {
    rail: 'oft-ausd',
    sourceChainId: 1,
    sourceToken: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a',
    sourceSymbol: 'AUSD',
    decimals: 6,
    adapter: '0x9CaB7Ede13dc56652E44D2404E969C212f22689b',
    approvalRequired: false,
    delivers: 'AUSD',
  },
  {
    rail: 'oft-usdt0',
    sourceChainId: 42161,
    sourceToken: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    sourceSymbol: 'USDT',
    decimals: 6,
    adapter: '0x14E4A1B13bf7F943c8ff7C51fb60FA964A298D92',
    approvalRequired: false,
    delivers: 'USDT0',
  },
  {
    rail: 'oft-usdt0',
    sourceChainId: 1,
    sourceToken: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    sourceSymbol: 'USDT',
    decimals: 6,
    adapter: '0x6C96dE32CEa08842dcc4058c14d3aaAD7Fa41dee',
    // A lockbox over real USDT: it must pull the token, so it must be approved.
    approvalRequired: true,
    // And USDT is the token whose `approve` reverts non-zero to non-zero.
    resetAllowanceFirst: true,
    delivers: 'USDT0',
  },
];

/**
 * The OFT surface, matching the verified source of `AgoraMintBurnOFTAdapter`,
 * `OAdapterUpgradeable` and `OUpgradeable` byte for byte.
 *
 * Struct order is `dstEid, to, amountLD, minAmountLD, extraOptions, composeMsg, oftCmd` —
 * confirmed from all three verified implementations and again by decoding a live
 * production send (Arbitrum `0xc9b1ecf7…de134`, whose `value` equals the quoted
 * `nativeFee` exactly).
 */
export const OFT_ABI = parseAbi([
  'struct SendParam { uint32 dstEid; bytes32 to; uint256 amountLD; uint256 minAmountLD; bytes extraOptions; bytes composeMsg; bytes oftCmd; }',
  'struct MessagingFee { uint256 nativeFee; uint256 lzTokenFee; }',
  'function quoteSend(SendParam sendParam, bool payInLzToken) view returns (MessagingFee)',
  'function send(SendParam sendParam, MessagingFee fee, address refundAddress) payable returns (bytes32, bytes32)',
  'function approvalRequired() view returns (bool)',
]);

/** An address as the 32-byte word every LayerZero field takes. */
export function toBytes32Address(address: string): `0x${string}` {
  return `0x${'0'.repeat(24)}${address.replace(/^0x/, '')}`.toLowerCase() as `0x${string}`;
}

export interface OftConfig {
  /**
   * Reads `quoteSend` on the source chain. Injected rather than imported so this module
   * stays transport-free and a test can drive it without a network.
   */
  readonly quoteSend: (args: {
    chainId: number;
    adapter: string;
    sendParam: {
      dstEid: number;
      to: `0x${string}`;
      amountLD: bigint;
      minAmountLD: bigint;
      extraOptions: `0x${string}`;
      composeMsg: `0x${string}`;
      oftCmd: `0x${string}`;
    };
  }) => Promise<{ nativeFee: bigint; lzTokenFee: bigint }>;
}

interface StashedRequest {
  readonly chain: FundingRequest['sourceChain'];
  readonly route: OftRoute;
  readonly recipient: Address;
  readonly amountIn: string;
  readonly nativeFee: string;
  readonly depositor: string | null;
}

/** The native token the message fee is paid in. Only used to label it. */
function nativeSymbol(chainId: number): string {
  if (chainId === 56) return 'BNB';
  if (chainId === 137) return 'POL';
  if (chainId === 43114) return 'AVAX';
  return 'ETH';
}

export function createOftRail(
  rail: Extract<RailId, 'oft-ausd' | 'oft-usdt0'>,
  config: OftConfig,
): Rail {
  const isAusd = rail === 'oft-ausd';
  const routesFor = (chainId: number, symbol: string) =>
    OFT_ROUTES.find(
      (r) =>
        r.rail === rail &&
        r.sourceChainId === chainId &&
        r.sourceSymbol.toUpperCase() === symbol.toUpperCase(),
    );

  return {
    id: rail,
    displayName: isAusd ? 'Agora AUSD bridge' : 'USDT0 bridge',
    explainer: isAusd
      ? 'AUSD moves over its own bridge and arrives as AUSD, one for one.'
      : 'USDT moves over the USDT0 bridge and arrives as USDT0, one for one.',

    supports(req) {
      return req.amount > 0n && routesFor(req.sourceChain.id, req.sourceAsset.symbol) !== undefined;
    },

    async quote(req: FundingRequest): Promise<Quote | Decline> {
      assertRecipient(req, req.recipient);

      const route = routesFor(req.sourceChain.id, req.sourceAsset.symbol);
      if (!route) {
        return {
          rail,
          reason: `This bridge has no lane from ${req.sourceChain.displayName} to Monad.`,
          raw: { checked: 'peers(30390)' },
        };
      }

      /**
       * `minAmountLD === amountLD`, and that is safe here rather than optimistic.
       *
       * `quoteOFT` returned `oftReceipt (5000000, 5000000)` with no fee details and no
       * dust removal on every one of these routes, because local decimals and shared
       * decimals are both 6. Where they differ an OFT silently truncates, and asking for
       * the full amount out would revert every send — so this equality is a property of
       * these four lanes, checked, not a general assumption about OFTs.
       */
      const sendParam = {
        dstEid: MONAD_LZ_EID,
        to: toBytes32Address(req.recipient),
        amountLD: req.amount,
        minAmountLD: req.amount,
        extraOptions: '0x' as `0x${string}`,
        composeMsg: '0x' as `0x${string}`,
        oftCmd: '0x' as `0x${string}`,
      };

      let fee: { nativeFee: bigint; lzTokenFee: bigint };
      try {
        fee = await config.quoteSend({
          chainId: route.sourceChainId,
          adapter: route.adapter,
          sendParam,
        });
      } catch (error) {
        // The chain's own revert, decoded where it decodes. `NoPeer(30390)` is what an
        // unwired lane says, and saying so is more useful than "unavailable".
        return {
          rail,
          reason: error instanceof Error ? (error.message.split('\n')[0] ?? 'quoteSend reverted') : String(error),
          raw: { sendParam, adapter: route.adapter },
        };
      }

      const fees: QuoteFee[] = [
        {
          // LayerZero's own term. It is not taken out of the amount — it is paid in the
          // source chain's gas token, on top, which is why it is labelled that way.
          label: 'LayerZero message fee, paid in the chain’s own token',
          amount: fee.nativeFee,
          token: nativeSymbol(route.sourceChainId),
        },
      ];
      if (fee.lzTokenFee > 0n) {
        fees.push({ label: 'LayerZero token fee', amount: fee.lzTokenFee, token: 'ZRO' });
      }

      return {
        rail,
        amountIn: req.amount,
        // One for one. Not a rounding, not an estimate — `quoteOFT` said so.
        amountOut: req.amount,
        outToken: route.delivers,
        fees,
        // LayerZero states no ETA per lane and this rail will not invent one.
        etaSeconds: 0,
        expiresAt: Date.now() + 60_000,
        landsIn: 'wallet',
        // The OFT send is the user's own transaction, and it carries a native fee.
        needsWallet: true,
        executable: typeof req.senderAddress === 'string' && req.senderAddress.length > 0,
        raw: {
          nativeFee: fee.nativeFee.toString(),
          lzTokenFee: fee.lzTokenFee.toString(),
          adapter: route.adapter,
          dstEid: MONAD_LZ_EID,
          __request: {
            chain: req.sourceChain,
            route,
            recipient: req.recipient,
            amountIn: req.amount.toString(),
            nativeFee: fee.nativeFee.toString(),
            depositor: req.senderAddress ?? null,
          } satisfies StashedRequest,
        },
      };
    },

    /**
     * The send, with only the approvals the adapter actually asked for.
     *
     * `refundAddress` is the **sender**, not the recipient: LayerZero returns unused
     * message fee in the source chain's gas token, and the account on Monad cannot
     * receive ETH on Base. Sending a refund somewhere it cannot arrive is how change
     * gets lost.
     */
    async buildSourceTx(quote: Quote): Promise<SourceTxPlan> {
      const raw = quote.raw as { __request?: StashedRequest };
      const req = raw.__request;
      if (!req) throw new Error('quote is missing the request it was made from');
      if (!req.depositor) {
        throw new Error(
          'This bridge needs the address that will send, and this quote was priced ' +
            'without one. Connect the wallet holding the money and get a fresh price.',
        );
      }

      const amount = BigInt(req.amountIn);
      const nativeFee = BigInt(req.nativeFee);
      const txs: SourceTx[] = [];

      if (req.route.approvalRequired) {
        if (req.route.resetAllowanceFirst) {
          // USDT reverts on a non-zero-to-non-zero `approve`. This is the only way to
          // change an allowance that already stands, and it is a real extra signature
          // rather than a defensive flourish.
          txs.push({
            chainId: req.route.sourceChainId,
            to: req.route.sourceToken,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: 'approve',
              args: [req.route.adapter as Address, 0n],
            }),
            value: '0',
            label: `Clear any old ${req.route.sourceSymbol} allowance`,
          });
        }
        txs.push({
          chainId: req.route.sourceChainId,
          to: req.route.sourceToken,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: 'approve',
            args: [req.route.adapter as Address, amount],
          }),
          value: '0',
          label: `Allow the bridge to move ${req.route.sourceSymbol}`,
        });
      }

      txs.push({
        chainId: req.route.sourceChainId,
        to: req.route.adapter,
        data: encodeFunctionData({
          abi: OFT_ABI,
          functionName: 'send',
          args: [
            {
              dstEid: MONAD_LZ_EID,
              to: toBytes32Address(req.recipient),
              amountLD: amount,
              minAmountLD: amount,
              extraOptions: '0x',
              composeMsg: '0x',
              oftCmd: '0x',
            },
            { nativeFee, lzTokenFee: 0n },
            req.depositor as Address,
          ],
        }),
        // The message fee, in the source chain's own token. Exactly what was quoted:
        // under-paying reverts, over-paying is refunded to `refundAddress`.
        value: nativeFee.toString(),
        label: `Send ${req.route.sourceSymbol} to Monad`,
      });

      return { kind: 'wallet-signed', rail, chain: req.chain, txs, raw };
    },

    /**
     * LayerZero's own scan is the source of truth for a message in flight.
     *
     * **Status: MISSING.** No send has been made through this rail, so nothing has ever
     * been polled here. The endpoint below is LayerZero's public message API and this
     * has not met it; it is written so the shape is not invented on the day it is first
     * needed, and it says so rather than reporting a state it did not read.
     */
    async status(ref: RailRef): Promise<RailStatus> {
      const res = await fetch(
        `https://scan.layerzero-api.com/v1/messages/tx/${encodeURIComponent(ref.ref)}`,
      );
      const json = (await res.json()) as {
        data?: { status?: { name?: string }; destination?: { tx?: { txHash?: string } } }[];
      };
      if (!res.ok) {
        return { state: 'awaiting-source', message: `LayerZero answered ${res.status}`, raw: json };
      }
      const message = json.data?.[0];
      const name = message?.status?.name ?? '';
      const state =
        name === 'DELIVERED'
          ? 'delivered'
          : name === 'FAILED'
            ? 'failed'
            : name === 'INFLIGHT' || name === 'CONFIRMING'
              ? 'in-flight'
              : 'awaiting-source';
      return {
        state,
        ...(name ? { message: name } : {}),
        ...(message?.destination?.tx?.txHash
          ? { destinationTxHash: message.destination.tx.txHash }
          : {}),
        raw: json,
      };
    },
  };
}
