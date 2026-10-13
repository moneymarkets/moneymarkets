import {
  decodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  parseAbi,
  type Address,
  type PublicClient,
} from 'viem';
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
 * Circle CCTP V2 — burn USDC on the source chain, mint it on Monad.
 *
 * The only rail here that moves *the same dollar*. Every other one hands the user's USDC
 * to somebody who already holds USDC on Monad and pays them for the service; Circle
 * destroys the token on one side and issues it on the other, so there is no liquidity
 * provider, no inventory to run out, and no counterparty beyond Circle itself.
 *
 * ## Everything below was read from the chain on 2026-09-11
 *
 * `depositForBurn` was encoded with these exact types and simulated against the live
 * `TokenMessengerV2` on seven chains, each with `destinationDomain = 15`. Every one
 * reverted with `ERC20: transfer amount exceeds allowance` — the token complaining, not
 * the messenger. The call reached the transfer, so the signature, the argument order and
 * every type are right, and Monad is accepted as a destination on all of them.
 *
 * ```
 * MessageTransmitterV2.localDomain(), read per chain (version 1 everywhere):
 *   Ethereum 0    Avalanche 1   OP Mainnet 2   Arbitrum 3
 *   Base     6    Polygon   7   Linea     11   Monad     15
 * ```
 *
 * **Monad is domain 15**, read from `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64` on
 * Monad itself rather than taken from a table.
 *
 * ## The fee is Circle's, per route, per day
 *
 * `GET /v2/burn/USDC/fees/{source}/{destination}` answered, for Base to Monad:
 *
 * ```
 * [{"finalityThreshold":1000,"minimumFee":1.3},{"finalityThreshold":2000,"minimumFee":0}]
 * ```
 *
 * Two speeds. Threshold **1000** is the fast transfer, where Circle fronts the mint
 * before source finality and charges basis points for it — 1.3 bps from Base, 1.0 from
 * Ethereum, 1.4 from Arbitrum on the day this was read. Threshold **2000** waits for
 * finality and is free, which on Ethereum is about thirteen minutes.
 *
 * This rail asks for the **fast** one and passes Circle's own `minimumFee` through as
 * `maxFee`. No rate is written here: the endpoint is called for every quote, so the
 * number is always today's.
 *
 * ## Why the last step is not the user's
 *
 * A CCTP transfer is two transactions on two chains: the user burns, and then somebody
 * must call `receiveMessage` on Monad with Circle's attestation. The user cannot — they
 * have no MON for gas, which is the whole premise of this product. So the relayer does
 * it from the float, under a per-user daily cap, and only after re-fetching the
 * attestation from Circle itself rather than trusting the one the browser sent.
 */

const IRIS = 'https://iris-api.circle.com';

/** Read from `MessageTransmitterV2.localDomain()` on Monad, 2026-09-11. */
export const MONAD_CCTP_DOMAIN = 15;

/**
 * Circle's V2 contracts. The same addresses on every chain checked, and each was
 * confirmed to have code and to report the domain it is filed under here.
 */
export const TOKEN_MESSENGER_V2 = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d' as const;
export const MESSAGE_TRANSMITTER_V2 = '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64' as const;

/**
 * Source chain id to CCTP domain, every entry read from
 * `MessageTransmitterV2.localDomain()` on that chain rather than transcribed.
 *
 * A chain missing from this map is a chain nobody checked, and `supports()` declines it.
 * Guessing a domain would burn USDC toward whatever chain happened to hold that number.
 */
export const CCTP_DOMAINS: Readonly<Record<number, number>> = {
  1: 0,
  43114: 1,
  10: 2,
  42161: 3,
  8453: 6,
  137: 7,
  59144: 11,
  143: 15,
};

/** USDC on each source chain, as the vendors themselves named it. */
const SOURCE_USDC: Readonly<Record<number, string>> = {
  1: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  10: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  137: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  8453: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  42161: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  43114: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
  59144: '0x176211869cA2b568f2A7D4EE941E073a821EE1ff',
};

/**
 * Fast transfer. Circle's own name for the speed, and the threshold its fee endpoint
 * prices — asking for 2000 instead would be free and slow, which is a different product
 * than the one this screen promises.
 */
export const FAST_FINALITY_THRESHOLD = 1000;

/**
 * The burn call, as deployed. Simulated on seven chains; see the note at the top.
 *
 * `destinationCaller` is left as the zero word deliberately: restricting who may call
 * `receiveMessage` on Monad to one address would mean a mint that can never be completed
 * if that address is ever replaced. Circle's attestation already binds the message to its
 * `mintRecipient`, which is the account, and that is the property that matters.
 */
const TOKEN_MESSENGER_ABI = parseAbi([
  'function depositForBurn(uint256 amount,uint32 destinationDomain,bytes32 mintRecipient,address burnToken,bytes32 destinationCaller,uint256 maxFee,uint32 minFinalityThreshold) returns (uint64)',
]);

export const MESSAGE_TRANSMITTER_ABI = parseAbi([
  'function receiveMessage(bytes message,bytes attestation) returns (bool)',
]);

const ZERO_WORD = `0x${'0'.repeat(64)}` as const;

/** An EVM address as the 32-byte word CCTP addresses everything with. */
export function toBytes32(address: string): `0x${string}` {
  return `0x${'0'.repeat(24)}${address.slice(2)}`.toLowerCase() as `0x${string}`;
}

/**
 * `keccak256("MessageSent(bytes)")` — `MessageTransmitterV2`'s one-topic burn event.
 *
 * Verified against Circle's own source (`circlefin/evm-cctp-contracts`,
 * `src/v2/MessageTransmitterV2.sol:173`, commit `a92a2b4e`) and against live logs on
 * Base and Monad, 2026-09-23 — not guessed (A2.5).
 */
export const MESSAGE_SENT_TOPIC =
  '0x8c5261668696ce22758910d05bab8f186d6eb247ceac2af2e82c7dc17669b036' as const;

export interface DecodedBurnMessage {
  readonly destinationDomain: number;
  /** The address the mint is for. Read from the burn body, never the header. */
  readonly mintRecipient: Address;
  readonly amount: bigint;
}

/**
 * Decode a CCTP V2 `MessageSent` log's `message` bytes into the three facts a burn
 * needs verified before this app trusts it: where it is headed, who it mints to, and
 * how much.
 *
 * Byte offsets read from Circle's own source (`src/messages/v2/MessageV2.sol:31-64`,
 * `src/messages/v2/BurnMessageV2.sol:27-55`, same commit as `MESSAGE_SENT_TOPIC`) and
 * cross-checked against a live burn's raw calldata. **The header's own `recipient`
 * field (bytes 76-108) is Circle's `TokenMessengerV2`, not the user** — the user's
 * address is only in the burn body, at `mintRecipient`. Getting that swapped would
 * make every burn "verify" against the wrong address.
 */
export function decodeBurnMessage(message: `0x${string}`): DecodedBurnMessage {
  const hex = message.slice(2);
  const wordAt = (byteOffset: number, byteLength: number): string =>
    hex.slice(byteOffset * 2, (byteOffset + byteLength) * 2);
  const destinationDomain = Number(BigInt(`0x${wordAt(8, 4)}`));
  const mintRecipientWord = wordAt(184, 32);
  const mintRecipient = getAddress(`0x${mintRecipientWord.slice(-40)}`);
  const amount = BigInt(`0x${wordAt(216, 32)}`);
  return { destinationDomain, mintRecipient, amount };
}

/**
 * Read a claimed burn's own transaction receipt on its source chain and decode what
 * it actually emitted, rather than trusting the hash a client posted.
 *
 * Returns `undefined` for anything that is not a genuine, successful CCTP V2 burn
 * through `MESSAGE_TRANSMITTER_V2` on this chain: no receipt, a reverted transaction,
 * or a receipt with no `MessageSent` log from that contract. The caller decides what
 * "undefined" means for its flow; this function only reports what the chain says.
 */
export async function readBurnFromReceipt(
  client: PublicClient,
  txHash: `0x${string}`,
): Promise<DecodedBurnMessage | undefined> {
  const receipt = await client.getTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success') return undefined;
  const log = receipt.logs.find(
    (l) =>
      l.address.toLowerCase() === MESSAGE_TRANSMITTER_V2.toLowerCase() &&
      l.topics[0]?.toLowerCase() === MESSAGE_SENT_TOPIC,
  );
  if (!log) return undefined;
  const [message] = decodeAbiParameters([{ type: 'bytes' }], log.data);
  return decodeBurnMessage(message);
}

interface IrisFee {
  finalityThreshold?: number;
  /** Basis points. Circle's own field name and its own units. */
  minimumFee?: number;
}

export interface CctpConfig {
  /** Where the relayer will submit `receiveMessage`. Shown, never guessed at. */
  readonly relayerSubmitsMint?: boolean;
}

interface StashedRequest {
  readonly chain: FundingRequest['sourceChain'];
  readonly asset: FundingRequest['sourceAsset'];
  readonly recipient: Address;
  readonly sourceDomain: number;
  readonly amountIn: string;
  readonly maxFee: string;
  readonly depositor: string | null;
}

/**
 * Circle's own JSON number, e.g. `1.3`, turned into tenths-of-a-basis-point as a
 * bigint — `13n` — by reading its decimal digits, not by multiplying the float.
 *
 * `Math.round(bps * 10)` was here before (Section 1 Medium — the doc comment below
 * claimed no float touched a monetary value while doing exactly that): `bps * 10` is
 * a float multiplication, and IEEE 754 does not represent every one-decimal-place
 * value exactly, so a bps Circle sends as a clean decimal could round through a
 * `...4999999999999998`-shaped intermediate to the wrong tenth. Reading the digits
 * `Number.prototype.toString()` already produced — the same round-trip-safe string
 * `JSON.parse` build the number from — never multiplies anything.
 */
function tenthsOfABasisPoint(bps: number): bigint {
  const [whole = '0', fraction = ''] = bps.toString().split('.');
  const tenths = BigInt(whole) * 10n + BigInt(fraction[0] ?? '0');
  // Round the tenths digit up on a second decimal place, the same half-up rule
  // `Math.round` applied — by comparing a digit, not a float.
  return fraction[1] !== undefined && Number(fraction[1]) >= 5 ? tenths + 1n : tenths;
}

/**
 * Circle prices in basis points and USDC has six decimals, so the fee is
 * `amount * bps / 10000` — rounded **up**, because `maxFee` is a ceiling the user
 * offers and one unit short is a transfer Circle's fast lane will not pick up.
 *
 * No float touches this, including the bps figure itself: `tenthsOfABasisPoint`
 * reads it as digits (A2.6).
 */
export function maxFeeFor(amount: bigint, bps: number): bigint {
  const scaled = tenthsOfABasisPoint(bps);
  const numerator = amount * scaled;
  const denominator = 100_000n;
  return (numerator + denominator - 1n) / denominator;
}

export function createCctpRail(config: CctpConfig = {}): Rail {
  return {
    id: 'cctp',
    displayName: 'Circle CCTP',
    explainer: 'Your USDC is burned on the source chain and minted on Monad by Circle.',

    supports(req) {
      if (req.amount <= 0n) return false;
      if (req.sourceAsset.symbol.toUpperCase() !== 'USDC') return false;
      const domain = CCTP_DOMAINS[req.sourceChain.id];
      // Monad cannot be its own source, and an unmapped chain is one nobody checked.
      return domain !== undefined && domain !== MONAD_CCTP_DOMAIN;
    },

    async quote(req: FundingRequest, signal: AbortSignal): Promise<Quote | Decline> {
      assertRecipient(req, req.recipient);

      const sourceDomain = CCTP_DOMAINS[req.sourceChain.id];
      if (sourceDomain === undefined) {
        return { rail: 'cctp', reason: 'Circle CCTP does not list this chain', raw: null };
      }

      const url = `${IRIS}/v2/burn/USDC/fees/${sourceDomain}/${MONAD_CCTP_DOMAIN}`;
      const res = await fetch(url, { signal });
      const json = (await res.json()) as IrisFee[] | { error?: string; message?: string };

      if (!res.ok || !Array.isArray(json)) {
        const body = json as { error?: string; message?: string };
        // Circle's own words (R5).
        return {
          rail: 'cctp',
          reason: body.message ?? body.error ?? `Circle answered ${res.status}`,
          raw: json,
        };
      }

      const fast = json.find((f) => f.finalityThreshold === FAST_FINALITY_THRESHOLD);
      if (!fast || typeof fast.minimumFee !== 'number') {
        return {
          rail: 'cctp',
          reason:
            'Circle is not offering a fast transfer to Monad on this route right now, and ' +
            'this app does not fall back to the slow one without saying so.',
          raw: json,
        };
      }

      const maxFee = maxFeeFor(req.amount, fast.minimumFee);
      if (maxFee >= req.amount) {
        // Circle's rate would consume the whole transfer. Its number, its consequence,
        // stated rather than quietly producing a quote for nothing.
        return {
          rail: 'cctp',
          reason: `Circle's fee for this route (${fast.minimumFee} basis points) is not smaller than the amount.`,
          raw: json,
        };
      }

      const fees: QuoteFee[] = [
        // Circle's own label and its own figure. Never rounded for display here.
        { label: `Circle fast transfer, ${fast.minimumFee} bps`, amount: maxFee, token: 'USDC' },
      ];

      return {
        rail: 'cctp',
        amountIn: req.amount,
        amountOut: req.amount - maxFee,
        outToken: 'USDC',
        fees,
        // Circle publishes no per-route ETA and this rail will not invent one. Fast
        // transfer is seconds to a couple of minutes in practice; zero here means "not
        // stated", and the router's tie-break treats it as such.
        etaSeconds: 0,
        expiresAt: Date.now() + 60_000,
        landsIn: 'wallet',
        // The burn is the user's own transaction, so this needs a connected wallet.
        needsWallet: true,
        executable: typeof req.senderAddress === 'string' && req.senderAddress.length > 0,
        raw: {
          fees: json,
          relayerSubmitsMint: config.relayerSubmitsMint === true,
          __request: {
            chain: req.sourceChain,
            asset: req.sourceAsset,
            recipient: req.recipient,
            sourceDomain,
            amountIn: req.amount.toString(),
            maxFee: maxFee.toString(),
            depositor: req.senderAddress ?? null,
          } satisfies StashedRequest,
        },
      };
    },

    /**
     * Approve, then burn.
     *
     * `mintRecipient` is the signed-in account as a 32-byte word — the one field that
     * decides where the minted USDC lands, and it comes from the request the recipient
     * assertion already checked. Nothing between here and Circle can change it: the
     * attestation Circle issues binds to this value, so a message re-pointed after the
     * fact simply fails to verify.
     */
    async buildSourceTx(quote: Quote): Promise<SourceTxPlan> {
      const raw = quote.raw as { __request?: StashedRequest };
      const req = raw.__request;
      if (!req) throw new Error('quote is missing the request it was made from');

      const burnToken = SOURCE_USDC[req.chain.id] ?? req.asset.address;
      if (!req.depositor) {
        throw new Error(
          'Circle CCTP needs the address that will send, and this quote was priced ' +
            'without one. Connect the wallet holding the money and get a fresh price.',
        );
      }

      const amount = BigInt(req.amountIn);
      const approve: SourceTx = {
        chainId: req.chain.id,
        to: burnToken,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [TOKEN_MESSENGER_V2, amount],
        }),
        value: '0',
        label: 'Allow Circle to burn your USDC',
      };

      const burn: SourceTx = {
        chainId: req.chain.id,
        to: TOKEN_MESSENGER_V2,
        data: encodeFunctionData({
          abi: TOKEN_MESSENGER_ABI,
          functionName: 'depositForBurn',
          args: [
            amount,
            MONAD_CCTP_DOMAIN,
            toBytes32(req.recipient),
            burnToken as Address,
            ZERO_WORD,
            BigInt(req.maxFee),
            FAST_FINALITY_THRESHOLD,
          ],
        }),
        value: '0',
        label: 'Burn your USDC for Monad',
      };

      return { kind: 'wallet-signed', rail: 'cctp', chain: req.chain, txs: [approve, burn], raw };
    },

    /**
     * `GET /v2/messages/{sourceDomain}?transactionHash=`.
     *
     * Verified live on 2026-09-11: an unknown hash answers HTTP 404 with
     * `{"error":"Message not found for provided parameters"}`. In the seconds after a
     * burn that is exactly what a real transfer looks like too, so it maps to
     * `source-seen` rather than to a failure — the burn happened, Circle has not indexed
     * it yet, and telling a user their money is gone in that window would be false.
     *
     * `status: 'complete'` on the attestation is what the relayer waits for. Until then
     * there is nothing to submit, and submitting early wastes the float on a revert.
     */
    async status(ref: RailRef): Promise<RailStatus> {
      const domain = ref.sourceChainId ? CCTP_DOMAINS[ref.sourceChainId] : undefined;
      if (domain === undefined) {
        return {
          state: 'in-flight',
          message: 'No source chain was recorded for this transfer, so Circle cannot be asked.',
          raw: { ref },
        };
      }
      const hash = ref.sourceTxHash ?? ref.ref;
      const res = await fetch(`${IRIS}/v2/messages/${domain}?transactionHash=${hash}`);
      const json = (await res.json()) as {
        messages?: {
          status?: string;
          attestation?: string;
          message?: string;
          eventNonce?: string;
          decodedMessage?: { decodedMessageBody?: { amount?: string } };
        }[];
        error?: string;
      };

      if (!res.ok) {
        return {
          state: 'source-seen',
          message: json.error ?? `Circle answered ${res.status}`,
          raw: json,
        };
      }

      const message = json.messages?.[0];
      const amount = message?.decodedMessage?.decodedMessageBody?.amount;
      return {
        // Circle attesting is not Circle delivering. `delivered` is claimed by the
        // relayer once its own `receiveMessage` transaction has a receipt — this rail
        // only ever says the attestation is ready.
        state: message?.status === 'complete' ? 'in-flight' : 'source-seen',
        ...(message?.status ? { message: message.status } : {}),
        ...(ref.sourceTxHash ? { sourceTxHash: ref.sourceTxHash } : {}),
        ...(amount ? { amountOut: BigInt(amount) } : {}),
        raw: json,
      };
    },
  };
}
