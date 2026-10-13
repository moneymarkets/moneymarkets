import {
  addressesFor,
  fetchMarketRegistry,
  isForwardableSelector,
  selectorOf,
  verifyMarket,
  type ChainMode,
} from '@tradepro/core';
import type { Address, Hex, PublicClient } from 'viem';

/**
 * What the relayer will forward, and where.
 *
 * Rule A4: the target allowlist is built from the **live** registry plus the
 * MarginAccount, and every entry is confirmed on chain before it is trusted. A
 * config literal would go stale the first time Kuru deploys a market, and the SDK
 * has already shipped wrong hardcoded addresses once.
 *
 * The selector allowlist is the exact set `@tradepro/core` can build. Since all
 * calldata is constructed in one module, "on the list" and "something this app can
 * legitimately ask for" are the same set by construction.
 */

export interface AllowlistEntry {
  readonly address: Address;
  readonly kind: 'orderbook' | 'marginAccount';
  readonly symbol: string;
  readonly trustsForwarder: boolean;
}

export interface AllowlistSnapshot {
  readonly builtAt: number;
  readonly entries: readonly AllowlistEntry[];
  readonly marginAccountTrustsForwarder: boolean;
  readonly orderBooksChecked: number;
  readonly orderBooksTrusting: number;
}

export class TargetAllowlist {
  #snapshot: AllowlistSnapshot | undefined;
  #byAddress = new Map<string, AllowlistEntry>();

  constructor(
    private readonly client: PublicClient,
    private readonly mode: ChainMode,
    private readonly options: {
      readonly maxMarkets?: number;
      readonly fetchImpl?: typeof fetch;
    } = {},
  ) {}

  get snapshot(): AllowlistSnapshot | undefined {
    return this.#snapshot;
  }

  has(address: Address): boolean {
    return this.#byAddress.has(address.toLowerCase());
  }

  get(address: Address): AllowlistEntry | undefined {
    return this.#byAddress.get(address.toLowerCase());
  }

  /**
   * Rebuild from the live registry. Markets whose `getMarketParams()` does not decode
   * are dropped: the registry mixes Kuru OrderBooks with AMM pools and other venues,
   * and only the chain can tell them apart.
   */
  async refresh(): Promise<AllowlistSnapshot> {
    const addresses = addressesFor(this.mode);
    const forwarder = addresses.kuru.forwarder;
    const marginAccount = addresses.kuru.marginAccount;

    const entries: AllowlistEntry[] = [];
    let marginAccountTrustsForwarder = false;

    if (marginAccount) {
      const verified = await verifyMarginAccount(this.client, marginAccount, forwarder);
      marginAccountTrustsForwarder = verified;
      entries.push({
        address: marginAccount,
        kind: 'marginAccount',
        symbol: 'MarginAccount',
        trustsForwarder: verified,
      });
    }

    let checked = 0;
    let trusting = 0;
    const restApi = addresses.kuru.restApi;
    if (restApi) {
      const registry = await fetchMarketRegistry(restApi, this.options.fetchImpl);
      const limit = this.options.maxMarkets ?? registry.length;
      for (const market of registry.slice(0, limit)) {
        const verified = await verifyMarket(this.client, market.market, forwarder);
        if (!verified) continue;
        checked += 1;
        if (verified.trustsForwarder) trusting += 1;
        entries.push({
          address: verified.market,
          kind: 'orderbook',
          symbol: market.symbol,
          trustsForwarder: verified.trustsForwarder,
        });
      }
    }

    this.#byAddress = new Map(entries.map((e) => [e.address.toLowerCase(), e]));
    this.#snapshot = {
      builtAt: Date.now(),
      entries,
      marginAccountTrustsForwarder,
      orderBooksChecked: checked,
      orderBooksTrusting: trusting,
    };
    return this.#snapshot;
  }

  /** Seed the allowlist directly. For tests and for the M0 gate script. */
  seed(entries: readonly AllowlistEntry[]): void {
    this.#byAddress = new Map(entries.map((e) => [e.address.toLowerCase(), e]));
    this.#snapshot = {
      builtAt: Date.now(),
      entries: [...entries],
      marginAccountTrustsForwarder: entries.some(
        (e) => e.kind === 'marginAccount' && e.trustsForwarder,
      ),
      orderBooksChecked: entries.filter((e) => e.kind === 'orderbook').length,
      orderBooksTrusting: entries.filter((e) => e.kind === 'orderbook' && e.trustsForwarder).length,
    };
  }
}

async function verifyMarginAccount(
  client: PublicClient,
  marginAccount: Address,
  forwarder: Address | undefined,
): Promise<boolean> {
  if (!forwarder) return false;
  try {
    const result = await client.readContract({
      address: marginAccount,
      abi: [
        {
          type: 'function',
          name: 'isTrustedForwarder',
          stateMutability: 'view',
          inputs: [{ name: 'forwarder', type: 'address' }],
          outputs: [{ name: '', type: 'bool' }],
        },
      ] as const,
      functionName: 'isTrustedForwarder',
      args: [forwarder],
    });
    return result;
  } catch {
    return false;
  }
}

/** Re-exported so the validator and the tests use one definition of the selector set. */
export { isForwardableSelector, selectorOf };
export type { Hex };
