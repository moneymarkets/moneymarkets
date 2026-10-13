import { createPublicClient, http, type Address, type PublicClient, type Transport } from 'viem';
import {
  createAcrossRail,
  createCctpRail,
  createDebridgeRail,
  createMayanRail,
  createNearRail,
  createOftRail,
  createRelayRail,
  createUnavailableRail,
  simulatePlan,
  UNAVAILABLE_RAILS,
  OFT_ABI,
  type EthCall,
  type PlanSimulation,
  type Rail,
  type SourceTxPlan,
} from '@tradepro/core';

/**
 * Every rail, built once, server-side.
 *
 * ## Why this is not in the route handler
 *
 * Two handlers need the same list — `/api/fund/route` asks all of them for a price and
 * `/api/fund/execute` needs the one the user chose — and two copies of a rail list is two
 * places for a rail to be missing from. It was already true that the execute handler knew
 * about fewer rails than the routing handler, which is a quote the user can see and
 * cannot act on.
 *
 * Every credential read here is server-only (R6). Nothing in this file is importable from
 * a client component.
 */

/** Source-chain RPCs. Each answered `eth_chainId` with the id it is filed under, 2026-09-11. */
const RPC: Readonly<Record<number, string>> = {
  1: 'https://ethereum-rpc.publicnode.com',
  10: 'https://mainnet.optimism.io',
  56: 'https://bsc-dataseed.bnbchain.org',
  137: 'https://polygon-bor-rpc.publicnode.com',
  143: 'https://rpc.monad.xyz',
  8453: 'https://mainnet.base.org',
  42161: 'https://arb1.arbitrum.io/rpc',
  43114: 'https://api.avax.network/ext/bc/C/rpc',
  59144: 'https://rpc.linea.build',
};

/** Exported so a route that needs a source-chain read (e.g. verifying a burn receipt
 * before recording it) can reuse this table instead of keeping a second copy of it. */
export function clientFor(chainId: number): PublicClient<Transport> | undefined {
  const url = RPC[chainId];
  if (!url) return undefined;
  return createPublicClient({ transport: http(url) }) as PublicClient<Transport>;
}

/**
 * `eth_call` that resolves on a revert instead of throwing.
 *
 * The distinction is load-bearing: a revert is the chain refusing, which the user needs
 * to read; a thrown transport error is this app failing to ask, which must never be
 * presented as the chain's answer. viem throws for both, so both are caught and told
 * apart by whether a revert reason came back.
 */
export const ethCall: EthCall = async (tx) => {
  const client = clientFor(tx.chainId);
  if (!client) throw new Error(`no RPC configured for chain ${tx.chainId}`);
  try {
    await client.call({
      account: tx.from as Address,
      to: tx.to as Address,
      data: tx.data as `0x${string}`,
      ...(BigInt(tx.value || '0') > 0n ? { value: BigInt(tx.value) } : {}),
    });
    return { ok: true };
  } catch (error) {
    const e = error as {
      shortMessage?: string;
      details?: string;
      cause?: { reason?: string; data?: { errorName?: string; args?: unknown[] } | string };
      metaMessages?: string[];
    };
    const decoded = e.cause?.data;
    const errorName =
      decoded && typeof decoded === 'object' && decoded.errorName
        ? `${decoded.errorName}(${(decoded.args ?? []).join(', ')})`
        : undefined;

    /**
     * The most specific thing the node actually said, not the first thing viem offers.
     *
     * `shortMessage` is a category — "Transaction creation failed." — and on its own it
     * tells a user nothing. The real sentence is usually in `details`: Base answered
     * `EVM error: OutOfFunds` for an account with no ETH to cover an OFT message fee,
     * and that is a fact somebody can act on. So a decoded custom error wins, then a
     * revert reason, then the node's own detail line, and the generic category is only
     * used when nothing better exists.
     *
     * None of these are rewritten. `OutOfFunds` reaches the screen as `OutOfFunds`.
     */
    const generic = /transaction creation failed|unknown reason/i;
    const specific = errorName ?? e.cause?.reason ?? e.details;
    const reason =
      specific ?? (e.shortMessage && !generic.test(e.shortMessage) ? e.shortMessage : undefined);

    // No reason at all means the call did not reach a revert — a transport problem, not
    // a refusal. Rethrowing lets `simulatePlan` record it as `unknown`.
    if (!reason) throw error;
    return {
      ok: false,
      reason,
      ...(typeof decoded === 'string' ? { data: decoded } : {}),
    };
  }
};

/**
 * Mayan's own signable transaction, from Mayan's own SDK.
 *
 * `getSwapFromEvmTxPayload` returns `{ to, data, value }` for a Swift or MCTP order —
 * verified against 15.2.2 for Base USDC to Monad: 932 bytes of calldata to their
 * forwarder `0x337685fdaB40D39bd02028545a4FfA7D287cC3E2`.
 *
 * The import is dynamic so the SDK — which carries ethers and a Solana client — is
 * loaded only when a Mayan plan is actually built, rather than on every cold start of
 * a route that will usually pick a deposit-address rail.
 */
async function mayanPayload(args: {
  quote: unknown;
  swapper: string;
  destination: string;
  chainId: number;
}): Promise<{ to: string; data: string; value: string }> {
  const { getSwapFromEvmTxPayload } = await import('@mayanfinance/swap-sdk');
  const payload = await getSwapFromEvmTxPayload(
    args.quote as Parameters<typeof getSwapFromEvmTxPayload>[0],
    args.swapper,
    args.destination,
    null,
    args.swapper,
    args.chainId,
    null,
    null,
  );
  if (!payload?.to || !payload.data) {
    throw new Error('Mayan returned no transaction for this order.');
  }
  return {
    to: String(payload.to),
    data: String(payload.data),
    // `value` comes back as a hex quantity or a bigint; the plan carries decimal wei.
    value: BigInt(payload.value ?? 0).toString(),
  };
}

/** `quoteSend` against a real OFT adapter. The OFT rail has no transport of its own. */
async function quoteSend(args: {
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
}): Promise<{ nativeFee: bigint; lzTokenFee: bigint }> {
  const client = clientFor(args.chainId);
  if (!client) throw new Error(`no RPC configured for chain ${args.chainId}`);
  const fee = await client.readContract({
    address: args.adapter as Address,
    abi: OFT_ABI,
    functionName: 'quoteSend',
    args: [args.sendParam, false],
  });
  return { nativeFee: fee.nativeFee, lzTokenFee: fee.lzTokenFee };
}

/**
 * Every rail this app has, in preference order for ties only.
 *
 * The order decides nothing about which one is offered: the router asks all of them and
 * ranks on what actually arrives, with anything the user cannot act on sorted last.
 */
export function allRails(): Rail[] {
  return [
    createRelayRail({
      ...(process.env.RELAY_API_KEY ? { apiKey: process.env.RELAY_API_KEY } : {}),
      ...(process.env.RELAY_APP_FEE_RECIPIENT
        ? { appFeeRecipient: process.env.RELAY_APP_FEE_RECIPIENT }
        : {}),
      ...(process.env.RELAY_APP_FEE_BPS ? { appFeeBps: Number(process.env.RELAY_APP_FEE_BPS) } : {}),
    }),
    createAcrossRail({
      ...(process.env.ACROSS_INTEGRATOR_ID
        ? { integratorId: process.env.ACROSS_INTEGRATOR_ID }
        : {}),
    }),
    createCctpRail({ relayerSubmitsMint: true }),
    createDebridgeRail({
      ...(process.env.DEBRIDGE_REFERRAL_CODE
        ? { referralCode: process.env.DEBRIDGE_REFERRAL_CODE }
        : {}),
    }),
    createMayanRail({
      ...(process.env.MAYAN_REFERRER ? { referrer: process.env.MAYAN_REFERRER } : {}),
      buildPayload: mayanPayload,
    }),
    createOftRail('oft-ausd', { quoteSend }),
    createOftRail('oft-usdt0', { quoteSend }),
    createNearRail({ ...(process.env.ONE_CLICK_JWT ? { jwt: process.env.ONE_CLICK_JWT } : {}) }),
    // Empty today. Kept wired so a rail that genuinely stops carrying Monad can say so
    // in its own words rather than vanishing from the screen.
    ...UNAVAILABLE_RAILS.map(createUnavailableRail),
  ];
}

export function railById(id: string): Rail | undefined {
  return allRails().find((r) => r.id === id);
}

/** Simulate a built plan with the real `eth_call`. */
export function simulate(plan: SourceTxPlan, from: string): Promise<PlanSimulation> {
  return simulatePlan(plan, from, ethCall);
}
