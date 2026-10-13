import { describe, expect, it } from 'vitest';
import { route } from './router.js';
import { ACROSS_ROUTES } from './across.js';
import {
  assertRecipient,
  isQuote,
  type Decline,
  type FundingRequest,
  type Quote,
  type Rail,
  type RailId,
} from './types.js';
import type { Address } from 'viem';

/**
 * The router, and the rules every rail is held to.
 *
 * The fixtures are shaped from the **real** responses captured on 2026-09-11 and
 * recorded in `reports/RAILS-VERIFY.md` — the Relay fee labels, the Across fee fields
 * and the NEAR refusal sentence are the vendors' own, not invented.
 */

const ACCOUNT = '0x714f169Fe2D3990961B534D573f9646c037586E6' as Address;

const BASE_REQ: FundingRequest = {
  sourceChain: { id: 8453, key: 'base', displayName: 'Base', vm: 'evm' },
  sourceAsset: {
    symbol: 'USDC',
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    decimals: 6,
  },
  amount: 5_000_000n,
  recipient: ACCOUNT,
  wantsMargin: false,
};

/** A deposit-address rail: the user sends from where their money is, no wallet. */
function quoteRail(id: RailId, amountOut: bigint, etaSeconds: number, needsWallet = false): Rail {
  return {
    id,
    displayName: id,
    explainer: '',
    supports: () => true,
    quote: async (): Promise<Quote> => ({
      rail: id,
      amountIn: BASE_REQ.amount,
      amountOut,
      outToken: 'USDC',
      fees: [],
      etaSeconds,
      expiresAt: Date.now() + 60_000,
      landsIn: 'wallet',
      needsWallet,
      executable: true,
      raw: {},
    }),
    status: async () => ({ state: 'in-flight', raw: {} }),
  };
}

function decliningRail(id: RailId, reason: string): Rail {
  return {
    id,
    displayName: id,
    explainer: '',
    supports: () => true,
    quote: async (): Promise<Decline> => ({ rail: id, reason, raw: { message: reason } }),
    status: async () => ({ state: 'failed', raw: {} }),
  };
}

function throwingRail(id: RailId): Rail {
  return {
    id,
    displayName: id,
    explainer: '',
    supports: () => true,
    quote: async () => {
      throw new Error('vendor exploded');
    },
    status: async () => ({ state: 'failed', raw: {} }),
  };
}

function hangingRail(id: RailId): Rail {
  return {
    id,
    displayName: id,
    explainer: '',
    supports: () => true,
    quote: (_req, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    status: async () => ({ state: 'failed', raw: {} }),
  };
}

describe('a rail needing a wallet never leads, whatever it prices (item 1.1)', () => {
  it('ranks a deposit-address rail above a better-priced wallet-signed one', () => {
    // The real case: CCTP prices Base USDC at 4.999350 and Relay at 4.979143. CCTP is
    // 0.4% better and costs a browser extension, gas on Base and two signatures. On a
    // screen whose premise is an account and nothing else, that is not the better offer.
    return route(
      [quoteRail('cctp', 4_999_350n, 0, true), quoteRail('relay', 4_979_143n, 1, false)],
      BASE_REQ,
    ).then((result) => {
      expect(result.best?.rail).toBe('relay');
      expect(result.best?.needsWallet).toBe(false);
      expect(result.alternatives.map((q) => q.rail)).toEqual(['cctp']);
    });
  });

  it('puts every wallet-signed rail below every deposit-address one', async () => {
    const result = await route(
      [
        quoteRail('cctp', 9_999_999n, 0, true),
        quoteRail('across', 9_999_998n, 1, true),
        quoteRail('debridge', 9_999_997n, 1, true),
        quoteRail('relay', 1n, 9, false),
        quoteRail('near', 2n, 9, false),
      ],
      BASE_REQ,
    );
    const ranked = [result.best!, ...result.alternatives];
    const firstWallet = ranked.findIndex((q) => q.needsWallet);
    const lastNoWallet = ranked.map((q) => q.needsWallet).lastIndexOf(false);
    expect(lastNoWallet).toBeLessThan(firstWallet);
  });

  it('picks the better of the two deposit-address rails for Best', async () => {
    // Item 1.1: Best is always the better of Relay and NEAR.
    const result = await route(
      [quoteRail('relay', 4_979_143n, 1, false), quoteRail('near', 4_985_791n, 37, false)],
      BASE_REQ,
    );
    expect(result.best?.rail).toBe('near');
  });

  it('leads with a wallet-signed rail only when no deposit-address rail quoted', async () => {
    // Item 1.3: if both decline, the wallet-signed rails are what is left. They are
    // still shown - the card just must not have prompted for a wallet to get here.
    const result = await route(
      [
        decliningRail('relay', 'Relay is not carrying this route right now'),
        decliningRail('near', 'Temporary swap limits: minimum swap amount is $1,000'),
        quoteRail('cctp', 4_999_350n, 0, true),
      ],
      BASE_REQ,
    );
    expect(result.best?.rail).toBe('cctp');
    expect(result.best?.needsWallet).toBe(true);
    expect(result.declines.map((d) => d.rail)).toEqual(['relay', 'near']);
  });
});

describe('a quote the user cannot act on never leads', () => {
  function unexecutable(id: RailId, amountOut: bigint): Rail {
    const rail = quoteRail(id, amountOut, 1);
    return {
      ...rail,
      quote: async () => ({
        ...((await rail.quote(BASE_REQ, new AbortController().signal)) as Quote),
        executable: false,
      }),
    };
  }

  it('ranks an executable rail above a better-priced one that cannot send', async () => {
    // The real case, 2026-09-11: Across prices Base USDC above Relay and cannot send.
    const result = await route(
      [unexecutable('across', 24_996_807n), quoteRail('relay', 24_977_284n, 1)],
      BASE_REQ,
    );
    expect(result.best?.rail).toBe('relay');
    expect(result.alternatives.map((q) => q.rail)).toEqual(['across']);
  });

  it('still ranks by amount out among rails that can all send', async () => {
    const result = await route(
      [quoteRail('relay', 1n, 1), quoteRail('across', 2n, 1)],
      BASE_REQ,
    );
    expect(result.best?.rail).toBe('across');
  });
});

describe('the router ranks live quotes rather than trusting preference', () => {
  it('picks the largest amount out, not the first rail listed', async () => {
    const result = await route(
      [quoteRail('relay', 4_970_000n, 1), quoteRail('across', 4_998_820n, 4)],
      BASE_REQ,
    );
    // Across is second in preference and wins on the number the user receives.
    expect(result.best?.rail).toBe('across');
    expect(result.alternatives.map((q) => q.rail)).toEqual(['relay']);
  });

  it('breaks a tie on ETA', async () => {
    const result = await route(
      [quoteRail('across', 4_990_000n, 4), quoteRail('relay', 4_990_000n, 1)],
      BASE_REQ,
    );
    expect(result.best?.rail).toBe('relay');
  });

  it('falls through to the next rail when the primary declines', async () => {
    const result = await route(
      [
        decliningRail('near', 'Temporary swap limits: minimum swap amount is $1,000'),
        quoteRail('across', 4_998_820n, 4),
      ],
      BASE_REQ,
    );
    expect(result.best?.rail).toBe('across');
    expect(result.declines).toHaveLength(1);
  });

  it('keeps a decline verbatim, with no softening', async () => {
    // The exact sentence NEAR Intents returned on 2026-09-09.
    const sentence = 'Temporary swap limits: minimum swap amount is $1,000';
    const result = await route([decliningRail('near', sentence)], BASE_REQ);
    expect(result.declines[0]?.reason).toBe(sentence);
    expect(result.best).toBeUndefined();
  });

  it('a rail that throws is reported as silent, not as a refusal', async () => {
    const result = await route([throwingRail('relay'), quoteRail('across', 1n, 1)], BASE_REQ);
    expect(result.best?.rail).toBe('across');
    expect(result.declines).toEqual([]);
    expect(result.silent.map((s) => s.rail)).toEqual(['relay']);
  });

  it('a slow rail is abandoned without holding up the others', async () => {
    const started = Date.now();
    const result = await route([hangingRail('relay'), quoteRail('across', 1n, 1)], BASE_REQ, 50);
    expect(result.best?.rail).toBe('across');
    expect(result.silent.map((s) => s.rail)).toEqual(['relay']);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('asks only the rails whose route table claims the request', async () => {
    const narrow: Rail = { ...quoteRail('cctp', 1n, 1), supports: () => false };
    const result = await route([narrow, quoteRail('across', 2n, 1)], BASE_REQ);
    expect(result.best?.rail).toBe('across');
    expect(result.alternatives).toEqual([]);
  });

  it('returns nothing rather than a guess when every rail refuses', async () => {
    const result = await route(
      [decliningRail('near', 'a'), decliningRail('relay', 'b')],
      BASE_REQ,
    );
    expect(result.best).toBeUndefined();
    expect(result.declines.map((d) => d.reason)).toEqual(['a', 'b']);
  });
});

describe('the recipient assertion (R4)', () => {
  it('throws when a quote would deliver anywhere but the signed-in account', () => {
    const other = '0x0000000000000000000000000000000000000009' as Address;
    expect(() => assertRecipient({ recipient: other }, ACCOUNT)).toThrow(/not the signed-in/);
  });

  it('accepts the signed-in account regardless of case', () => {
    expect(() =>
      assertRecipient({ recipient: ACCOUNT.toLowerCase() as Address }, ACCOUNT),
    ).not.toThrow();
  });
});

describe('the Across route table matches what Across listed', () => {
  // Recorded from GET /available-routes?destinationChainId=143 on 2026-09-11.
  it('carries 26 verified routes', () => {
    expect(ACROSS_ROUTES.length).toBe(26);
  });

  it('is the only table claiming USDT0 delivery, and only for USDT inputs', () => {
    for (const r of ACROSS_ROUTES.filter((x) => x.outToken === 'USDT0')) {
      expect(r.inSymbol.toUpperCase()).toContain('USDT');
    }
  });

  it('includes Tron, which the plan had assigned only to Relay and NEAR', () => {
    expect(ACROSS_ROUTES.some((r) => r.chainId === 728126428)).toBe(true);
  });

  it('never claims a Monad-native asset as an input', () => {
    for (const r of ACROSS_ROUTES) expect(r.chainId).not.toBe(143);
  });
});

describe('quote and decline are distinguishable without inspecting the vendor', () => {
  it('isQuote separates them', async () => {
    const q = await quoteRail('relay', 1n, 1).quote(BASE_REQ, new AbortController().signal);
    const d = await decliningRail('near', 'no').quote(BASE_REQ, new AbortController().signal);
    expect(isQuote(q)).toBe(true);
    expect(isQuote(d)).toBe(false);
  });
});
