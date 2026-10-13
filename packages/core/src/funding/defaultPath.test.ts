import { describe, expect, it } from 'vitest';
import { route } from './router.js';
import { staticCoverage } from './coverage.js';
import type { Decline, FundingRequest, Quote, Rail, RailId } from './types.js';
import type { Address } from 'viem';

/**
 * The default path never needs a wallet — asserted over every pair the screen can offer.
 *
 * Item 1.1 is a promise about the whole screen, not about one route: "Best" must be a
 * deposit-address rail for **every** asset and chain the coverage endpoint renders. A
 * test that checks Base USDC proves Base USDC. This enumerates `staticCoverage()`, which
 * is the same list the chips and tiles are built from, so a pair that can appear on the
 * screen and cannot satisfy the rule fails here.
 *
 * The wallet-signed rails are given **better** prices than the deposit-address ones on
 * purpose. If the ordering were keyed on price anywhere, that is what would break it —
 * and it is not hypothetical: CCTP really does price Base USDC about 0.4% above Relay,
 * which is exactly why the rule exists.
 */

const ACCOUNT = '0x714f169Fe2D3990961B534D573f9646c037586E6' as Address;

/** Deposit-address rails: what the user gets with an account and nothing else. */
const NO_WALLET: readonly RailId[] = ['relay', 'near'];
/** Everything that needs a signature on the source chain. */
const WALLET: readonly RailId[] = ['cctp', 'across', 'debridge', 'oft-ausd', 'oft-usdt0', 'mayan'];

function stub(id: RailId, amountOut: bigint, needsWallet: boolean, executable = true): Rail {
  return {
    id,
    displayName: id,
    explainer: '',
    supports: () => true,
    quote: async (req): Promise<Quote> => ({
      rail: id,
      amountIn: req.amount,
      amountOut,
      outToken: 'USDC',
      fees: [],
      etaSeconds: 1,
      expiresAt: Date.now() + 60_000,
      landsIn: 'wallet',
      needsWallet,
      executable,
      raw: {},
    }),
    status: async () => ({ state: 'in-flight', raw: {} }),
  };
}

function declining(id: RailId, reason: string): Rail {
  return {
    id,
    displayName: id,
    explainer: '',
    supports: () => true,
    quote: async (): Promise<Decline> => ({ rail: id, reason, raw: { message: reason } }),
    status: async () => ({ state: 'failed', raw: {} }),
  };
}

const coverage = staticCoverage();

describe('Best is a deposit-address rail for every pair the screen offers (item 1.4)', () => {
  it('the coverage list is not empty, or this suite proves nothing', () => {
    expect(coverage.length).toBeGreaterThan(10);
  });

  for (const entry of coverage) {
    const label = `${entry.asset} on ${entry.chain.displayName}`;

    it(`${label}: Best needs no wallet, even when wallet rails price better`, async () => {
      const req: FundingRequest = {
        sourceChain: entry.chain,
        sourceAsset: {
          symbol: entry.asset,
          address: entry.assetAddress,
          decimals: entry.assetDecimals,
        },
        amount: 5_000_000n,
        recipient: ACCOUNT,
        // A wallet IS connected. That must not change which rail leads.
        senderAddress: ACCOUNT,
        wantsMargin: false,
      };

      // Wallet rails priced strictly above every deposit-address rail.
      const rails = [
        ...WALLET.map((id, i) => stub(id, 9_000_000n - BigInt(i), true)),
        ...NO_WALLET.map((id, i) => stub(id, 1_000_000n - BigInt(i), false)),
      ];

      const result = await route(rails, req);
      expect(result.best).toBeDefined();
      expect(result.best!.needsWallet).toBe(false);
      expect(NO_WALLET).toContain(result.best!.rail);
    });
  }
});

describe('what happens when the deposit-address rails will not carry it (item 1.3)', () => {
  const req: FundingRequest = {
    sourceChain: { id: 8453, key: 'base', displayName: 'Base', vm: 'evm' },
    sourceAsset: { symbol: 'USDC', address: '0x8335', decimals: 6 },
    amount: 5_000_000n,
    recipient: ACCOUNT,
    senderAddress: ACCOUNT,
    wantsMargin: false,
  };

  it('returns both refusals verbatim rather than silently promoting a wallet rail', async () => {
    const result = await route(
      [
        declining('relay', 'Relay is not carrying this route right now'),
        declining('near', 'Temporary swap limits: minimum swap amount is $1,000'),
        stub('cctp', 4_999_350n, true),
      ],
      req,
    );
    // The wallet rail is what is left, and the card is required to say why before
    // offering it — the refusals are the material for that sentence.
    expect(result.declines.map((d) => d.reason)).toEqual([
      'Relay is not carrying this route right now',
      'Temporary swap limits: minimum swap amount is $1,000',
    ]);
    expect(result.best?.needsWallet).toBe(true);
  });

  it('a deposit-address rail that quotes still beats a wallet rail that quotes better', async () => {
    const result = await route(
      [
        declining('relay', 'not right now'),
        stub('near', 1n, false),
        stub('cctp', 9_999_999n, true),
      ],
      req,
    );
    expect(result.best?.rail).toBe('near');
  });
});
