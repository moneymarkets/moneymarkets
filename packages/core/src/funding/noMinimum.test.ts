import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createAcrossRail } from './across.js';
import { createCctpRail } from './cctp.js';
import { createDebridgeRail } from './debridge.js';
import { createMayanRail } from './mayan.js';
import { createNearRail } from './near.js';
import { createOftRail } from './oft.js';
import { createRelayRail } from './relay.js';
import type { FundingRequest, Rail } from './types.js';
import type { Address } from 'viem';

/**
 * No rail may hold a minimum. Enforced across every rail at once, not one at a time.
 *
 * ## Why this test exists in this shape
 *
 * The rule is old and the reason is concrete: on 2026-09-09 a floor was read from a
 * single vendor refusal, cached per route, and used to pre-judge what the user could
 * type. It blocked amounts the network would in fact have priced. The instruction that
 * followed was absolute — every amount goes to the vendor, and only the vendor's live
 * answer may refuse it.
 *
 * `near.test.ts` already asserts this for one module. That was enough when there was one
 * rail. There are now eight, the funding path has roughly doubled twice, and the audit
 * has been run by hand more than once. A per-module test does not catch the ninth rail;
 * this one does, because it enumerates the directory rather than a list someone must
 * remember to extend.
 *
 * ## Two checks, because either alone is weak
 *
 * The **behavioural** check is the one that matters: every rail must accept one base
 * unit — the smallest amount expressible — for a route it claims. A rail with a floor
 * fails here no matter how the floor is written.
 *
 * The **source** check catches what behaviour cannot: a floor that is written but not
 * yet reachable, or one applied at execute time rather than quote time. It is deliberately
 * narrow — it looks for a comparison of a request amount against a literal that is not
 * zero — so it does not fire on fee arithmetic or on a vendor's own returned figure.
 */

const ACCOUNT = '0x714f169Fe2D3990961B534D573f9646c037586E6' as Address;

/** One base unit. A sixth of a cent in USDC, and every rail must still ask its vendor. */
const ONE_UNIT = 1n;

function request(
  chainId: number,
  symbol: string,
  address: string,
  overrides: Partial<FundingRequest> = {},
): FundingRequest {
  return {
    sourceChain: { id: chainId, key: 'k', displayName: 'Chain', vm: 'evm' },
    sourceAsset: { symbol, address, decimals: 6 },
    amount: ONE_UNIT,
    recipient: ACCOUNT,
    senderAddress: ACCOUNT,
    wantsMargin: false,
    ...overrides,
  };
}

const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

/** Each rail, with a route it actually claims. A pair no rail carries would prove nothing. */
const RAILS: readonly { name: string; rail: Rail; req: FundingRequest }[] = [
  { name: 'relay', rail: createRelayRail(), req: request(8453, 'USDC', BASE_USDC) },
  { name: 'across', rail: createAcrossRail(), req: request(8453, 'USDC', BASE_USDC) },
  { name: 'cctp', rail: createCctpRail(), req: request(8453, 'USDC', BASE_USDC) },
  { name: 'debridge', rail: createDebridgeRail(), req: request(8453, 'USDC', BASE_USDC) },
  { name: 'mayan', rail: createMayanRail(), req: request(8453, 'USDC', BASE_USDC) },
  { name: 'near', rail: createNearRail(), req: request(8453, 'USDC', BASE_USDC) },
  {
    name: 'oft-ausd',
    rail: createOftRail('oft-ausd', { quoteSend: async () => ({ nativeFee: 1n, lzTokenFee: 0n }) }),
    req: request(8453, 'AUSD', '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a'),
  },
  {
    name: 'oft-usdt0',
    rail: createOftRail('oft-usdt0', { quoteSend: async () => ({ nativeFee: 1n, lzTokenFee: 0n }) }),
    req: request(42161, 'USDT', '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9'),
  },
];

describe('no rail refuses a small amount before its vendor is asked', () => {
  for (const { name, rail, req } of RAILS) {
    it(`${name} accepts one base unit`, () => {
      // If this fails, a floor has been added. The vendor decides what is too small,
      // and it cannot decide if the request never reaches it.
      expect(rail.supports(req)).toBe(true);
    });
  }

  it('covers every rail module in the directory', () => {
    // The guard on the guard: a new rail that nobody adds here would slip past.
    const modules = readdirSync(new URL('.', import.meta.url))
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      // Modules in this directory that are not rails. A rail is a module exporting a
      // `create*Rail` factory; everything here is shared plumbing or recorded data, and
      // none of it can hold a floor because none of it sees a request amount.
      .filter((f) => !['index.ts', 'types.ts', 'router.ts', 'coverage.ts', 'simulate.ts',
                       'unavailable.ts', 'chainParams.ts', 'evidence.ts'].includes(f))
      .map((f) => f.replace('.ts', ''));

    // `oft.ts` exports two rails; everything else is one rail per module.
    const covered = new Set(RAILS.map((r) => (r.name.startsWith('oft') ? 'oft' : r.name)));
    for (const m of modules) {
      expect(covered.has(m), `${m}.ts has no entry in this test`).toBe(true);
    }
  });
});

describe('no rail holds a floor in its source', () => {
  const railFiles = readdirSync(new URL('.', import.meta.url))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

  for (const file of railFiles) {
    it(`${file} compares a request amount only against zero`, () => {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      // Comments quote vendor refusals verbatim — "minimum swap amount is $1,000" is
      // evidence, not a rule — so they are stripped before the scan.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

      // A floor is: the request's own amount compared against a literal that is not 0.
      const floors = [
        ...code.matchAll(/\b(?:req\.amount|amount|amountIn)\s*[<>]=?\s*([0-9_]+)n?\b/g),
      ].filter((m) => Number(m[1]?.replace(/_/g, '')) !== 0);

      expect(floors.map((m) => m[0])).toEqual([]);
    });
  }
});
