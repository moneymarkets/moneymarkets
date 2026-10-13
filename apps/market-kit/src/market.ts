import { getAddress, parseAbi, zeroAddress, type Address, type PublicClient, type Hex } from 'viem';
import {
  decodeKuruError,
  decodeMarketParams,
  decodeVaultParams,
  isNativeAsset,
  kuruAmmVaultDeployedAbi,
  marginAccountAbi,
  orderBookAbi,
  type MarketParams,
  type VaultParams,
} from '@tradepro/core';

/**
 * Every read the kit makes against the chain. Ground truth is the chain (rule A2.7):
 * nothing here consults the REST registry, and market params are decoded by `core`'s
 * tested decoder rather than destructured inline.
 */

/**
 * Multicall3, at its canonical cross-chain address.
 *
 * Read on Monad mainnet 2026-09-02: `eth_getCode` returns 3808 bytes there and a
 * batched `aggregate3` of four `s_orders` reads against MON/AUSD succeeded. viem's
 * chain definition does not carry it, and `packages/core/src/chain/chains.ts` is not
 * this phase's file to edit, so the kit passes the address explicitly.
 */
export const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';

const erc20Abi = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);

export { erc20Abi };

export interface TokenView {
  readonly address: Address;
  readonly symbol: string;
  readonly decimals: number;
  readonly native: boolean;
}

export interface MarketView {
  readonly address: Address;
  readonly symbol: string;
  readonly params: MarketParams;
  readonly base: TokenView;
  readonly quote: TokenView;
  readonly bestBidWire: bigint;
  readonly bestAskWire: bigint;
  readonly vault: VaultParams;
  readonly blockNumber: bigint;
}

export async function readToken(
  client: PublicClient,
  address: Address,
  decimalsHint: number,
): Promise<TokenView> {
  if (isNativeAsset(address)) {
    return { address, symbol: 'MON', decimals: 18, native: true };
  }
  let symbol = `${address.slice(0, 6)}…`;
  try {
    symbol = (await client.readContract({ address, abi: erc20Abi, functionName: 'symbol' })) as
      string | string;
  } catch {
    // Some tokens return bytes32 symbols. The address is enough to identify it.
  }
  return { address, symbol, decimals: decimalsHint, native: false };
}

export async function readMarket(client: PublicClient, market: Address): Promise<MarketView> {
  const address = getAddress(market);
  const [paramsTuple, bestBidAsk, vaultTuple, blockNumber] = await Promise.all([
    client.readContract({ address, abi: orderBookAbi, functionName: 'getMarketParams' }),
    client.readContract({ address, abi: orderBookAbi, functionName: 'bestBidAsk' }),
    client.readContract({ address, abi: orderBookAbi, functionName: 'getVaultParams' }),
    client.getBlockNumber(),
  ]);
  const params = decodeMarketParams(paramsTuple as never);
  const vault = decodeVaultParams(vaultTuple as never);
  const [base, quote] = await Promise.all([
    readToken(client, params.baseAsset, params.baseDecimals),
    readToken(client, params.quoteAsset, params.quoteDecimals),
  ]);
  const [bidWire, askWire] = bestBidAsk as readonly [bigint, bigint];
  return {
    address,
    symbol: `${base.symbol}/${quote.symbol}`,
    params,
    base,
    quote,
    bestBidWire: bidWire,
    bestAskWire: askWire,
    vault,
    blockNumber,
  };
}

/* ─────────────────────────────── margin balances ──────────────────────────── */

export async function readMarginBalance(
  client: PublicClient,
  marginAccount: Address,
  user: Address,
  token: Address,
): Promise<bigint> {
  return (await client.readContract({
    address: marginAccount,
    abi: marginAccountAbi,
    functionName: 'getBalance',
    args: [user, token],
  })) as bigint;
}

/* ───────────────────────────────── the vault ──────────────────────────────── */

export interface VaultView {
  readonly address: Address;
  readonly name: string;
  readonly shareDecimals: number;
  readonly token1: Address;
  readonly token2: Address;
  readonly totalSupply: bigint;
  /** `totalAssets()` is the vault's MarginAccount balance in each token. */
  readonly reserve1: bigint;
  readonly reserve2: bigint;
  readonly spreadConstant: bigint;
  readonly shares: bigint;
  /**
   * `previewDeposit` is a view that can revert on a degenerate vault (see
   * `commands/vault.ts`). Undefined means "it reverted", which is itself the finding.
   */
  readonly previewRevertReason?: string;
}

export async function readVault(
  client: PublicClient,
  vault: Address,
  holder: Address,
): Promise<VaultView> {
  const call = <T>(functionName: string, args: readonly unknown[] = []): Promise<T> =>
    client.readContract({
      address: vault,
      abi: kuruAmmVaultDeployedAbi,
      functionName: functionName as never,
      args: args as never,
    }) as Promise<T>;

  const [name, shareDecimals, token1, token2, totalSupply, assets, spreadConstant, shares] =
    await Promise.all([
      call<string>('name'),
      call<number>('decimals'),
      call<Address>('token1'),
      call<Address>('token2'),
      call<bigint>('totalSupply'),
      call<readonly [bigint, bigint]>('totalAssets'),
      call<bigint>('SPREAD_CONSTANT'),
      call<bigint>('balanceOf', [holder]),
    ]);

  return {
    address: vault,
    name,
    shareDecimals: Number(shareDecimals),
    token1,
    token2,
    totalSupply,
    reserve1: assets[0],
    reserve2: assets[1],
    spreadConstant,
    shares,
  };
}

/** `previewDeposit(base, quote)`, or the reason it refused. */
export async function previewVaultDeposit(
  client: PublicClient,
  vault: Address,
  baseAmount: bigint,
  quoteAmount: bigint,
): Promise<{ shares: bigint } | { revert: string }> {
  try {
    const shares = (await client.readContract({
      address: vault,
      abi: kuruAmmVaultDeployedAbi,
      functionName: 'previewDeposit',
      args: [baseAmount, quoteAmount],
    })) as bigint;
    return { shares };
  } catch (error) {
    return { revert: describeError(error) };
  }
}

/**
 * Selectors the venue can revert with that `core/kuru/errors.ts` does not carry,
 * because they are not Kuru's own: solady's maths library and the vault's errors.
 *
 * All four were read out of the deployed bytecode's PUSH4 constants and confirmed by
 * a live `eth_call` — `0xad251c27` is what the MON/AUSD vault actually returns for
 * both `previewDeposit` and `deposit` today (2026-09-02).
 */
export const EXTRA_REVERT_SELECTORS: Record<string, string> = {
  '0xad251c27': 'MulDivFailed() — solady FixedPointMathLib, a divide by zero',
  '0xa725e26b': 'InsufficientQuoteUsed() — KuruAMMVault, below minQuoteConsumed',
  '0xb9873846': 'InsufficientQuoteToken() — KuruAMMVault, quote ceiling too low',
  '0xcd41a9e3': 'NativeAssetMismatch() — msg.value does not match the native leg',
  '0x98de0cd0': 'AskPriceZero() — KuruAMMVault, first deposit priced at zero',
  '0xe9ab1f0b': 'InvalidVaultSize() — KuruAMMVault, resulting order size is zero',
  '0xd226f9d4': 'InsufficientLiquidityMinted() — KuruAMMVault, deposit mints no shares',
};

/**
 * A revert reason a person can act on.
 *
 * viem's own message for a custom error it cannot name is "Execution reverted for an
 * unknown reason", which hides the one thing that identifies it. The four-byte
 * selector is dug out of the error chain and named where we know the name.
 */
export function describeError(error: unknown): string {
  const selector = revertSelectorOf(error);
  const named = selector
    ? (decodeKuruError(selector)?.name ?? EXTRA_REVERT_SELECTORS[selector])
    : undefined;
  const base =
    error instanceof Error
      ? ((error as { shortMessage?: string }).shortMessage ?? error.message).split('\n')[0]
      : String(error);
  if (selector && named) return `${named}  [${selector}]`;
  if (selector) return `${base}  [unrecognised selector ${selector}]`;
  return base ?? 'reverted';
}

/** Walk a viem error chain for the raw revert data and return its selector. */
export function revertSelectorOf(error: unknown): Hex | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    const data = (current as { data?: unknown }).data;
    if (typeof data === 'string' && /^0x[0-9a-fA-F]{8}/.test(data)) {
      return data.slice(0, 10).toLowerCase() as Hex;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/* ─────────────────────────────── resting orders ───────────────────────────── */

export interface RestingOrder {
  readonly orderId: bigint;
  readonly owner: Address;
  readonly size: bigint;
  readonly price: bigint;
  readonly flippedId: bigint;
  readonly flippedPrice: bigint;
  readonly isBuy: boolean;
  readonly isFlip: boolean;
}

export interface OrderScanResult {
  readonly orders: readonly RestingOrder[];
  readonly counter: bigint;
  readonly fromId: bigint;
  readonly toId: bigint;
}

/**
 * Find an owner's resting orders by walking `s_orders` backwards from
 * `s_orderIdCounter()`.
 *
 * This is a *bounded scan*, and the bound is reported, because the honest
 * alternatives are both unavailable: the public Monad RPC refuses `eth_getLogs` over
 * more than 100 blocks (`{"code":-32614}`), and the Envio indexer that spec §9 makes
 * load-bearing is Phase 3 work. So `kit status` answers "of the last N order ids,
 * these are yours", and says what N was.
 */
export async function scanRestingOrders(
  client: PublicClient,
  market: Address,
  owner: Address,
  window: number,
  chunkSize = 200,
): Promise<OrderScanResult> {
  const counter = BigInt(
    (await client.readContract({
      address: market,
      abi: orderBookAbi,
      functionName: 's_orderIdCounter',
    })) as number | bigint,
  );

  const toId = counter > 0n ? counter - 1n : 0n;
  const fromId = toId > BigInt(window) ? toId - BigInt(window) + 1n : 1n;
  const wanted = owner.toLowerCase();
  const orders: RestingOrder[] = [];

  for (let start = toId; start >= fromId; start -= BigInt(chunkSize)) {
    const ids: bigint[] = [];
    for (let id = start; id > start - BigInt(chunkSize) && id >= fromId; id -= 1n) ids.push(id);
    if (ids.length === 0) break;
    const results = await client.multicall({
      multicallAddress: MULTICALL3,
      allowFailure: true,
      contracts: ids.map((id) => ({
        address: market,
        abi: orderBookAbi,
        functionName: 's_orders',
        args: [id],
      })),
    });
    results.forEach((result, i) => {
      if (result.status !== 'success') return;
      const tuple = result.result as unknown as readonly [
        Address,
        bigint,
        number,
        number,
        number,
        number,
        number,
        boolean,
      ];
      const [ownerAddress, size, , , flippedId, price, flippedPrice, isBuy] = tuple;
      if (ownerAddress === zeroAddress) return;
      if (ownerAddress.toLowerCase() !== wanted) return;
      if (size === 0n) return;
      orders.push({
        orderId: ids[i]!,
        owner: ownerAddress,
        size,
        price: BigInt(price),
        flippedId: BigInt(flippedId),
        flippedPrice: BigInt(flippedPrice),
        isBuy,
        isFlip: BigInt(flippedPrice) > 0n,
      });
    });
    if (start - BigInt(chunkSize) < fromId) break;
  }

  return { orders, counter, fromId, toId };
}

export function isHex(value: string): value is Hex {
  return /^0x[0-9a-fA-F]*$/.test(value);
}
