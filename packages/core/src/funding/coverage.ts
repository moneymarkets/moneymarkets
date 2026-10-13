import { ACROSS_ROUTES } from './across.js';
import { CCTP_DOMAINS, MONAD_CCTP_DOMAIN } from './cctp.js';
import { nearAssetId } from './near.js';
import { OFT_ROUTES } from './oft.js';
import type { MonadToken, RailId } from './types.js';

/**
 * What the funding screen may offer, derived from what the rails actually carry.
 *
 * The old screen listed five tiles named after vendors' routes, hardcoded. This is the
 * replacement: the asset chips and chain tiles are computed from the rails' own
 * coverage, so a chain no rail can carry today does not render, and a chain a rail
 * gains appears without anyone editing a constant.
 *
 * **Relay's entry is the interesting one.** Relay's `/chains` says Monad accepts
 * deposits from every chain it lists, and its Monad destination currencies are USDC,
 * mUSD and MON only — so Relay contributes wide *source* coverage that always lands as
 * USDC. Across contributes narrower source coverage but is the only verified rail that
 * delivers USDT0.
 *
 * The live union is assembled server-side by `/api/fund/coverage`, which calls each
 * rail's own list endpoint and caches for ten minutes. This module holds the parts that
 * are static per rail — the shape of the answer and Across's transcribed table — so the
 * endpoint can fall back to a rail's known routes when its list fetch fails, and mark
 * that rail unverified for the window rather than dropping it silently.
 */

export interface CoverageChain {
  readonly id: number;
  readonly key: string;
  readonly displayName: string;
  readonly vm: 'evm' | 'svm' | 'tvm' | 'btc';
}

export interface CoverageEntry {
  /** Asset symbol as the user would name it: USDC, USDT, SOL, BTC, ETH. */
  readonly asset: string;
  readonly chain: CoverageChain;
  /** The address to quote with on that chain, or the native sentinel. */
  readonly assetAddress: string;
  readonly assetDecimals: number;
  /** Which rails claim this pair. Order is preference; the quote decides. */
  readonly rails: readonly RailId[];
  /**
   * What arrives on Monad.
   *
   * Relay and CCTP always USDC; Across USDC or USDT0; the OFT rails deliver the token
   * they carry. Where two rails on the same pair deliver different tokens, the first
   * one to claim the pair sets it — the route card names the token per quote anyway,
   * which is the number the user actually reads.
   */
  readonly delivers: MonadToken;
}

/** Chains named by the rails, with display names for the tiles. */
export const KNOWN_CHAINS: Readonly<Record<number, CoverageChain>> = {
  1: { id: 1, key: 'ethereum', displayName: 'Ethereum', vm: 'evm' },
  10: { id: 10, key: 'optimism', displayName: 'Optimism', vm: 'evm' },
  56: { id: 56, key: 'bnb', displayName: 'BNB Chain', vm: 'evm' },
  130: { id: 130, key: 'unichain', displayName: 'Unichain', vm: 'evm' },
  137: { id: 137, key: 'polygon', displayName: 'Polygon', vm: 'evm' },
  324: { id: 324, key: 'zksync', displayName: 'zkSync Era', vm: 'evm' },
  480: { id: 480, key: 'worldchain', displayName: 'World Chain', vm: 'evm' },
  999: { id: 999, key: 'hyperevm', displayName: 'HyperEVM', vm: 'evm' },
  8453: { id: 8453, key: 'base', displayName: 'Base', vm: 'evm' },
  42161: { id: 42161, key: 'arbitrum', displayName: 'Arbitrum', vm: 'evm' },
  43114: { id: 43114, key: 'avalanche', displayName: 'Avalanche', vm: 'evm' },
  57073: { id: 57073, key: 'ink', displayName: 'Ink', vm: 'evm' },
  59144: { id: 59144, key: 'linea', displayName: 'Linea', vm: 'evm' },
  728126428: { id: 728126428, key: 'tron', displayName: 'Tron', vm: 'tvm' },
  792703809: { id: 792703809, key: 'solana', displayName: 'Solana', vm: 'svm' },
  /**
   * Bitcoin is named because Relay's chain list names it, and it deliberately has **no
   * entry in `TOKENS`**, so `staticCoverage()` skips it and it never renders as a chain
   * the user can pick.
   *
   * That absence is the honest state: no Bitcoin route has been quoted, no deposit
   * address issued, and nothing about it verified. Adding an address here would put it
   * on the screen as available on the strength of a vendor's chain list alone, which is
   * the kind of claim R1 exists to stop. It becomes offerable when somebody quotes it
   * live and records the answer, not before.
   */
  8253038: { id: 8253038, key: 'bitcoin', displayName: 'Bitcoin', vm: 'btc' },
};

/**
 * Token addresses per chain, for the assets the rails quote.
 *
 * These are the addresses the vendors themselves asked for in the verified quotes —
 * Base USDC from the Across route list and the Relay quote, Tron USDT from Relay's
 * `/chains`. An address here that no vendor named is a bug.
 */
const TOKENS: Readonly<Record<string, { address: string; decimals: number }>> = {
  '1:USDC': { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
  '1:USDT': { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
  '8453:USDC': { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
  '42161:USDC': { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
  '42161:USDT': { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 },
  '10:USDC': { address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6 },
  '137:USDC': { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 },
  '43114:USDC': { address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', decimals: 6 },
  '59144:USDC': { address: '0x176211869cA2b568f2A7D4EE941E073a821EE1ff', decimals: 6 },
  '728126428:USDT': { address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', decimals: 6 },
  '792703809:SOL': { address: '11111111111111111111111111111111', decimals: 9 },
  '792703809:USDC': { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
  // AUSD's own address, identical on Base and Ethereum. Read from the OFT adapter's
  // `token()` on both chains, 2026-09-11.
  '1:AUSD': { address: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a', decimals: 6 },
  '8453:AUSD': { address: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a', decimals: 6 },
  '10:USDT': { address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', decimals: 6 },
  '137:USDT': { address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6 },
  '56:USDC': { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 },
  '56:USDT': { address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
  '43114:USDT': { address: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', decimals: 6 },
};

/**
 * Coverage that can be stated without a network call.
 *
 * Across's table is transcribed from its own `/available-routes` response; Relay's
 * contribution is added for the chains where we hold a token address, because Relay
 * accepts every chain in its list but we can only quote a pair we can name.
 */
export function staticCoverage(): CoverageEntry[] {
  const out: CoverageEntry[] = [];
  const seen = new Map<string, CoverageEntry>();

  const add = (asset: string, chainId: number, rail: RailId, delivers: MonadToken) => {
    const chain = KNOWN_CHAINS[chainId];
    const token = TOKENS[`${chainId}:${asset}`];
    if (!chain || !token) return;
    const key = `${asset}:${chainId}`;
    const existing = seen.get(key);
    if (existing) {
      if (!existing.rails.includes(rail)) {
        const merged: CoverageEntry = { ...existing, rails: [...existing.rails, rail] };
        seen.set(key, merged);
        out[out.indexOf(existing)] = merged;
      }
      return;
    }
    const entry: CoverageEntry = {
      asset,
      chain,
      assetAddress: token.address,
      assetDecimals: token.decimals,
      rails: [rail],
      delivers,
    };
    seen.set(key, entry);
    out.push(entry);
  };

  for (const r of ACROSS_ROUTES) {
    const asset = r.inSymbol.replace('-BNB', '').replace('.e', '');
    add(asset, r.chainId, 'across', r.outToken);
  }
  // Relay: wide source coverage, always delivering USDC.
  for (const chainId of [1, 8453, 42161, 10, 137, 43114, 59144, 728126428, 792703809]) {
    for (const asset of ['USDC', 'USDT', 'SOL']) {
      if (TOKENS[`${chainId}:${asset}`]) add(asset, chainId, 'relay', 'USDC');
    }
  }
  // NEAR Intents: whichever of those pairs 1Click holds an asset id for. It is asked
  // for every one of them and refuses most amounts today; that refusal is its own to
  // make on the route card, not ours to pre-empt by hiding the rail.
  for (const key of Object.keys(TOKENS)) {
    const [chainPart, asset] = key.split(':');
    const chainId = Number(chainPart);
    if (asset && nearAssetId(chainId, asset)) add(asset, chainId, 'near', 'USDC');
  }

  /**
   * CCTP, on every chain whose domain was read from its own `MessageTransmitterV2`.
   *
   * USDC only, because CCTP moves USDC and nothing else. Monad is excluded as a source
   * for the obvious reason that it is the destination.
   */
  for (const chainId of Object.keys(CCTP_DOMAINS).map(Number)) {
    if (CCTP_DOMAINS[chainId] === MONAD_CCTP_DOMAIN) continue;
    if (TOKENS[`${chainId}:USDC`]) add('USDC', chainId, 'cctp', 'USDC');
  }

  /**
   * deBridge and Mayan: both re-checked on 2026-09-11 and both carry Monad, having been
   * written down that morning as permanently unable to. Their coverage is stated from
   * the chains they listed; a pair either of them refuses declines in its own words on
   * the route card, which is where a refusal belongs.
   */
  for (const chainId of [1, 10, 56, 137, 8453, 42161, 43114, 59144, 792703809]) {
    for (const asset of ['USDC', 'USDT']) {
      if (!TOKENS[`${chainId}:${asset}`]) continue;
      add(asset, chainId, 'debridge', 'USDC');
      add(asset, chainId, 'mayan', 'USDC');
    }
  }

  /**
   * The OFT lanes, and only the ones wired at **both** ends.
   *
   * USDT0 from Base is deliberately absent: `peers(30390)` is zero on the Base adapter
   * and `peers(30184)` is zero on the Monad one, so a message sent that way would be
   * rejected on arrival. `OFT_ROUTES` holds only lanes whose `quoteSend` returned a fee.
   */
  for (const r of OFT_ROUTES) {
    if (!TOKENS[`${r.sourceChainId}:${r.sourceSymbol}`]) continue;
    add(r.sourceSymbol, r.sourceChainId, r.rail, r.delivers);
  }

  return out;
}
