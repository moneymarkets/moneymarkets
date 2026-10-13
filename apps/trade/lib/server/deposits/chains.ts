/**
 * "Has anything landed at this address yet?" — read straight from the origin chain,
 * independent of 1Click's own detection. This is what closes the gap D105 reports:
 * 1Click took 2 minutes to notice a deposit that Solana itself showed within seconds.
 *
 * Each check is transaction-history based, not a live balance read, deliberately: a
 * deposit address the solver has already swept still shows a zero balance, and a
 * balance-only check would miss it. `getSignaturesForAddress` / `eth_getLogs` /
 * TronGrid's transfer list all answer "did anything ever arrive here", which survives
 * a sweep that happens between two of our polls.
 *
 * Contract addresses are never hand-typed here — they come from `resolvedSourceMeta`,
 * which reads them from 1Click's own `GET /v0/tokens` (rule A2.5).
 */

/** Solana's public mainnet endpoint, as listed on solana.com/docs/references/clusters. */
export const SOLANA_RPC = 'https://api.mainnet-beta.solana.com';
export const BASE_RPC = process.env.BASE_RPC_URL ?? 'https://mainnet.base.org';
/** TronGrid, TRON's own public API (developers.tron.network, `/v1/accounts/{address}/transactions/trc20`). */
export const TRONGRID_API = 'https://api.trongrid.io';

/** keccak256("Transfer(address,address,uint256)"). Verified against the well-known ERC-20 event. */
export const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export interface SourceLandedResult {
  readonly landed: boolean;
  /** The transaction that delivered funds, when one was found. */
  readonly txHash?: string;
}

export async function solanaLanded(depositAddress: string): Promise<SourceLandedResult> {
  const res = await fetch(SOLANA_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(8_000),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getSignaturesForAddress',
      params: [depositAddress, { limit: 10 }],
    }),
  });
  if (!res.ok) throw new Error(`Solana RPC returned ${res.status}`);
  const body = (await res.json()) as { result?: { signature: string; err: unknown }[]; error?: unknown };
  if (body.error) throw new Error(`Solana RPC error: ${JSON.stringify(body.error)}`);
  // A failed transaction moved nothing. Relay address E1J8wd... (2026-09-11) carries
  // three `InsufficientFundsForRent` failures and never received a lamport; counting
  // them lit "Seen on Solana" for money that never arrived. Oldest successful one wins.
  const sig = [...(body.result ?? [])].reverse().find((s) => s.err === null)?.signature;
  return sig ? { landed: true, txHash: sig } : { landed: false };
}

export function padAddressTopic(address: string): string {
  return `0x${address.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
}

export async function baseLanded(
  depositAddress: string,
  tokenContract: string,
  fromBlock: bigint,
): Promise<SourceLandedResult> {
  const res = await fetch(BASE_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(8_000),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getLogs',
      params: [
        {
          address: tokenContract,
          topics: [ERC20_TRANSFER_TOPIC, null, padAddressTopic(depositAddress)],
          fromBlock: `0x${fromBlock.toString(16)}`,
          toBlock: 'latest',
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Base RPC returned ${res.status}`);
  const body = (await res.json()) as {
    result?: { transactionHash: string }[];
    error?: unknown;
  };
  if (body.error) throw new Error(`Base RPC error: ${JSON.stringify(body.error)}`);
  const hash = body.result?.[0]?.transactionHash;
  return hash ? { landed: true, txHash: hash } : { landed: false };
}

export async function tronLanded(
  depositAddress: string,
  tokenContract: string,
): Promise<SourceLandedResult> {
  const url =
    `${TRONGRID_API}/v1/accounts/${encodeURIComponent(depositAddress)}/transactions/trc20` +
    `?limit=1&contract_address=${encodeURIComponent(tokenContract)}&only_to=true`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`TronGrid returned ${res.status}`);
  const body = (await res.json()) as { data?: { transaction_id: string }[]; success?: boolean };
  const hash = body.data?.[0]?.transaction_id;
  return hash ? { landed: true, txHash: hash } : { landed: false };
}

/** The current Base block, so a fresh watch starts scanning from "now" and not genesis. */
export async function baseBlockNumber(): Promise<bigint> {
  const res = await fetch(BASE_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(8_000),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
  });
  if (!res.ok) throw new Error(`Base RPC returned ${res.status}`);
  const body = (await res.json()) as { result?: string; error?: unknown };
  if (body.error || !body.result) throw new Error(`Base RPC error: ${JSON.stringify(body.error)}`);
  return BigInt(body.result);
}

/**
 * The refund address's current balance on the origin chain — captured once at
 * registration ("before") and read again on demand once a deposit resolves
 * ("after"), for the terminal card D105 asks for. Native balance for Solana, ERC-20
 * `balanceOf` for Base, TRC-20 `balanceOf` (via TronGrid's REST proxy for it) for Tron.
 */
export async function sourceBalance(
  chain: string,
  address: string,
  tokenContract?: string,
): Promise<bigint> {
  if (chain === 'Solana') {
    const res = await fetch(SOLANA_RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(8_000),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [address] }),
    });
    if (!res.ok) throw new Error(`Solana RPC returned ${res.status}`);
    const body = (await res.json()) as { result?: { value: number }; error?: unknown };
    if (body.error || body.result === undefined) {
      throw new Error(`Solana RPC error: ${JSON.stringify(body.error)}`);
    }
    return BigInt(body.result.value);
  }
  if (chain === 'Base') {
    if (!tokenContract) return 0n;
    const res = await fetch(BASE_RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(8_000),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        // balanceOf(address) selector 0x70a08231
        params: [
          { to: tokenContract, data: `0x70a08231${padAddressTopic(address).slice(2)}` },
          'latest',
        ],
      }),
    });
    if (!res.ok) throw new Error(`Base RPC returned ${res.status}`);
    const body = (await res.json()) as { result?: string; error?: unknown };
    if (body.error || !body.result)
      throw new Error(`Base RPC error: ${JSON.stringify(body.error)}`);
    return BigInt(body.result);
  }
  if (chain === 'Tron') {
    if (!tokenContract) return 0n;
    const res = await fetch(`${TRONGRID_API}/v1/accounts/${encodeURIComponent(address)}/`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`TronGrid returned ${res.status}`);
    const body = (await res.json()) as {
      data?: { trc20?: Record<string, string>[] }[];
    };
    const trc20List = body.data?.[0]?.trc20 ?? [];
    const match = trc20List.find(
      (entry) => Object.keys(entry)[0]?.toLowerCase() === tokenContract.toLowerCase(),
    );
    const raw = match ? Object.values(match)[0] : undefined;
    return raw ? BigInt(raw) : 0n;
  }
  return 0n;
}
