import { afterEach, describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import {
  AUSD_USDC_MARKET,
  FLOW_QUOTE_AMOUNT_IN,
  FLOW_USDC_AUSD_RESPONSE,
  KURU_FLOW_ROUTER,
  MAINNET,
  normalizeFlowCalldata,
  selectorOf,
  type MarketParams,
  swapStepIndex,
} from '@tradepro/core';
import type { Address } from 'viem';
import {
  BOOK_CONVERSION_MIN_USDC,
  checkVenueClear,
  policyFor,
  preflight,
  PreflightError,
  prepareFlowConvert,
  prepareTopUp,
  sponsorWouldAccept,
  movableHoldings,
  tokenToMove,
  type ConversionQuoteWire,
  type FlowConversionQuoteWire,
  type PermitPreflight,
  type TokenPreflight,
} from './pathB.js';

/**
 * The batch, assembled from values read live from Monad mainnet on 2026-09-03.
 *
 * The **signer** is a key generated in this test, not the owner's passkey account:
 * a passkey-derived key lives behind an authenticator and cannot be reproduced here.
 * Everything else — the permit domains, the nonces, the margin account, the market
 * params, the book's own quote — is what the chain returned, so what is under test is
 * the assembly and the ordering rather than a fixture someone invented.
 */

const MARGIN = MAINNET.kuru.marginAccount as Address;
const AUSD = MAINNET.tokens.AUSD.address;
const USDC = MAINNET.tokens.USDC.address;

/** `getMarketParams()` on AUSD/USDC, read at block 101543370. */
const AUSD_USDC_PARAMS: MarketParams = {
  pricePrecision: 100_000_000n,
  sizePrecision: 1_000_000n,
  baseAsset: AUSD,
  baseDecimals: 6,
  quoteAsset: USDC,
  quoteDecimals: 6,
  tickSize: 100n,
  minSize: 10_000_000n,
  maxSize: 10_000_000_000_000n,
  takerFeeBps: 0n,
  makerFeeBps: 0n,
};

/** A zero-sender quote of the real book at block 101543370 for 1.0134 USDC. */
const LIVE_CONVERSION: ConversionQuoteWire = {
  market: AUSD_USDC_MARKET,
  side: 'buy',
  amountIn: 1_013_400n,
  expectedOut: 1_013_273n,
  minAmountOut: 1_012_259n,
  slippageBps: 10n,
  adjusted: false,
  blockNumber: 101_543_370n,
  params: AUSD_USDC_PARAMS,
  outDecimals: 6,
};

/** The real recorded Kuru Flow quote (core fixtures), USDC -> AUSD. */
const LIVE_FLOW_QUOTE: FlowConversionQuoteWire = {
  router: KURU_FLOW_ROUTER,
  to: FLOW_USDC_AUSD_RESPONSE.transaction.to as Address,
  data: normalizeFlowCalldata(FLOW_USDC_AUSD_RESPONSE.transaction.calldata),
  value: BigInt(FLOW_USDC_AUSD_RESPONSE.transaction.value),
  amountIn: FLOW_QUOTE_AMOUNT_IN,
  output: BigInt(FLOW_USDC_AUSD_RESPONSE.output),
  minOut: BigInt(FLOW_USDC_AUSD_RESPONSE.minOut),
};

const ausdToken: TokenPreflight = {
  address: AUSD,
  symbol: 'AUSD',
  decimals: 6,
  permit: true,
  // Proved against AUSD's own DOMAIN_SEPARATOR() on chain 143.
  domain: {
    name: 'Agora Dollar',
    version: '1',
    chainId: 143,
    verifyingContract: AUSD,
  },
  nonce: 1n,
  balance: 1_013_400n,
};

const usdcToken: TokenPreflight = {
  address: USDC,
  symbol: 'USDC',
  decimals: 6,
  permit: true,
  domain: { name: 'USDC', version: '2', chainId: 143, verifyingContract: USDC },
  nonce: 0n,
  balance: 1_013_400n,
};

function preflightWith(...tokens: TokenPreflight[]): PermitPreflight {
  return { chainId: 143, marginAccount: MARGIN, tokens };
}

/** A `MeraAccount`-shaped stand-in whose signing is real ECDSA over the real domain. */
function signerAccount() {
  const account = privateKeyToAccount(generatePrivateKey());
  return {
    address: account.address,
    credentialId: 'test',
    account,
  } as unknown as Parameters<typeof prepareTopUp>[0]['account'];
}

const DEPOSIT_SELECTOR = '0x8340f549';
const PERMIT_SELECTOR = '0xd505accf';
const MARKET_BUY_SELECTOR = '0x7c51d6cf';

describe('the token the top-up offers', () => {
  it('picks the one the wallet actually holds', () => {
    const pre = preflightWith({ ...ausdToken, balance: 0n }, usdcToken);
    expect(tokenToMove(pre)?.symbol).toBe('USDC');
  });

  it('offers USDC first when the wallet holds both', () => {
    // Reversed deliberately. The old default was AUSD, on the reasoning that a balance
    // already in the account currency needs no conversion and so costs no spread —
    // which is true. But funding lands USDC, so USDC is what somebody who has just
    // funded is looking for, and defaulting to AUSD made a fresh deposit look absent.
    //
    // The spread argument no longer decides it, because both holdings are now listed
    // and selectable: whichever is offered first, neither is hidden.
    expect(tokenToMove(preflightWith(ausdToken, usdcToken))?.symbol).toBe('USDC');
  });

  it('lists every movable holding, so none is invisible', () => {
    const both = movableHoldings(preflightWith(ausdToken, usdcToken)).map((t) => t.symbol);
    expect(both).toEqual(['USDC', 'AUSD']);
    // A zero balance is not a holding, and a token with no permit has no gasless path.
    expect(movableHoldings(preflightWith({ ...ausdToken, balance: 0n }, usdcToken))).toHaveLength(
      1,
    );
    expect(
      movableHoldings(preflightWith({ ...ausdToken, permit: false }, usdcToken)).map(
        (t) => t.symbol,
      ),
    ).toEqual(['USDC']);
  });

  it('never offers a token that cannot be moved by signature', () => {
    const pre = preflightWith({ ...ausdToken, permit: false }, { ...usdcToken, balance: 0n });
    expect(tokenToMove(pre)?.symbol).toBe('USDC');
  });
});

describe('a balance already in AUSD skips the book', () => {
  it('builds two calls, not three', async () => {
    const prepared = await prepareTopUp({
      account: signerAccount(),
      preflight: preflightWith(ausdToken),
      token: ausdToken,
      amount: 1_013_400n,
      onProgress: () => {},
    });
    expect(prepared.calls).toHaveLength(2);
    expect(selectorOf(prepared.calls[0]!.data)).toBe(PERMIT_SELECTOR);
    expect(selectorOf(prepared.calls[1]!.data)).toBe(DEPOSIT_SELECTOR);
    expect(prepared.conversion).toBeUndefined();
  });
});

describe('a USDC balance ends the batch in AUSD', () => {
  it('is permit, then deposit, then a market buy — in that order', async () => {
    const prepared = await prepareTopUp({
      account: signerAccount(),
      preflight: preflightWith(usdcToken),
      token: usdcToken,
      amount: 1_013_400n,
      conversion: LIVE_CONVERSION,
      onProgress: () => {},
    });

    expect(prepared.calls).toHaveLength(3);
    expect(prepared.calls[0]!.to.toLowerCase()).toBe(USDC.toLowerCase());
    expect(selectorOf(prepared.calls[0]!.data)).toBe(PERMIT_SELECTOR);
    expect(prepared.calls[1]!.to.toLowerCase()).toBe(MARGIN.toLowerCase());
    expect(selectorOf(prepared.calls[1]!.data)).toBe(DEPOSIT_SELECTOR);
    expect(prepared.calls[2]!.to.toLowerCase()).toBe(AUSD_USDC_MARKET.toLowerCase());
    expect(selectorOf(prepared.calls[2]!.data)).toBe(MARKET_BUY_SELECTOR);
  });

  it('is a BUY, because AUSD is the base and USDC the quote', async () => {
    // The mistake this guards against spends the user's USDC to receive USDC back.
    const prepared = await prepareTopUp({
      account: signerAccount(),
      preflight: preflightWith(usdcToken),
      token: usdcToken,
      amount: 1_013_400n,
      conversion: LIVE_CONVERSION,
      onProgress: () => {},
    });
    expect(prepared.conversion?.purpose).toBe('placeAndExecuteMarketBuy');
    expect(prepared.conversion?.route.side).toBe('buy');
    expect(prepared.conversion?.route.tokenOut.toLowerCase()).toBe(AUSD.toLowerCase());
  });

  it('carries the live floor, never zero', async () => {
    const prepared = await prepareTopUp({
      account: signerAccount(),
      preflight: preflightWith(usdcToken),
      token: usdcToken,
      amount: 1_013_400n,
      conversion: LIVE_CONVERSION,
      onProgress: () => {},
    });
    expect(prepared.conversion?.minAmountOut).toBe(1_012_259n);
    expect(prepared.conversion?.expectedOut).toBe(1_013_273n);
    // 10 bps under the book's own quote: 1013273 * 9990 / 10000.
    expect(prepared.conversion!.minAmountOut).toBeLessThan(prepared.conversion!.expectedOut);
    expect(prepared.conversion!.minAmountOut).toBeGreaterThan(0n);
  });

  it('keeps the permit out of the dry-run log', async () => {
    // A permit's calldata embeds a bearer authorisation for its amount and nonce.
    const prepared = await prepareTopUp({
      account: signerAccount(),
      preflight: preflightWith(usdcToken),
      token: usdcToken,
      amount: 1_013_400n,
      conversion: LIVE_CONVERSION,
      onProgress: () => {},
    });
    expect(prepared.logCalls).toHaveLength(2);
    for (const call of prepared.logCalls) {
      expect(selectorOf(call.data)).not.toBe(PERMIT_SELECTOR);
    }
  });
});

describe('BOOK_CONVERSION_MIN_USDC', () => {
  it('is the AUSD/USDC book’s own live minSize (10 AUSD, 6 decimals)', () => {
    expect(BOOK_CONVERSION_MIN_USDC).toBe(AUSD_USDC_PARAMS.minSize);
  });
});

describe('an amount under the book minimum converts via Kuru Flow instead', () => {
  it('is permit(router), then the swap — exactly two calls, output to the caller’s own wallet', async () => {
    const prepared = await prepareFlowConvert({
      account: signerAccount(),
      preflight: preflightWith(usdcToken),
      usdc: usdcToken,
      amount: FLOW_QUOTE_AMOUNT_IN,
      quote: LIVE_FLOW_QUOTE,
    });

    expect(prepared.calls).toHaveLength(2);
    expect(prepared.calls[0]!.to.toLowerCase()).toBe(USDC.toLowerCase());
    expect(selectorOf(prepared.calls[0]!.data)).toBe(PERMIT_SELECTOR);
    expect(prepared.calls[1]!.to.toLowerCase()).toBe(KURU_FLOW_ROUTER.toLowerCase());
    expect(prepared.calls[1]!.data).toBe(LIVE_FLOW_QUOTE.data);
  });

  it('permits the Flow router, not the margin account', async () => {
    const prepared = await prepareFlowConvert({
      account: signerAccount(),
      preflight: preflightWith(usdcToken),
      usdc: usdcToken,
      amount: FLOW_QUOTE_AMOUNT_IN,
      quote: LIVE_FLOW_QUOTE,
    });
    // decodePermit-shaped check without importing the policy internals: the spender
    // word sits right after the selector and the owner word.
    expect(prepared.calls[0]!.data.slice(2 + 8 + 64, 2 + 8 + 128).toLowerCase()).toContain(
      KURU_FLOW_ROUTER.slice(2).toLowerCase(),
    );
  });

  it('keeps the permit out of the dry-run log, same as the book route', async () => {
    const prepared = await prepareFlowConvert({
      account: signerAccount(),
      preflight: preflightWith(usdcToken),
      usdc: usdcToken,
      amount: FLOW_QUOTE_AMOUNT_IN,
      quote: LIVE_FLOW_QUOTE,
    });
    expect(prepared.logCalls).toHaveLength(1);
    expect(selectorOf(prepared.logCalls[0]!.data)).not.toBe(PERMIT_SELECTOR);
  });

  it('refuses an amount larger than the wallet balance that was read', async () => {
    await expect(
      prepareFlowConvert({
        account: signerAccount(),
        preflight: preflightWith(usdcToken),
        usdc: usdcToken,
        amount: usdcToken.balance + 1n,
        quote: LIVE_FLOW_QUOTE,
      }),
    ).rejects.toThrow(/larger than the wallet balance/);
  });

  it('refuses a zero or negative amount', async () => {
    await expect(
      prepareFlowConvert({
        account: signerAccount(),
        preflight: preflightWith(usdcToken),
        usdc: usdcToken,
        amount: 0n,
        quote: LIVE_FLOW_QUOTE,
      }),
    ).rejects.toThrow(/must be positive/);
  });
});

describe('the batch will not be signed if a sponsor would refuse it', () => {
  it('is sponsorable only with the AUSD/USDC book named, since 2026-09-23', async () => {
    const prepared = await prepareTopUp({
      account: signerAccount(),
      preflight: preflightWith(usdcToken),
      token: usdcToken,
      amount: 1_013_400n,
      conversion: LIVE_CONVERSION,
      onProgress: () => {},
    });
    const pre = preflightWith(usdcToken);
    const calls = prepared.calls.map((c) => ({ to: c.to, data: c.data, value: 0n }));

    // From 2026-09-09 to 2026-09-23 AUSD/USDC was in LIVE_MARKET_ALLOWLIST and naming it
    // here was redundant. On 2026-09-23 it became shown-but-not-traded and left the
    // allowlist, so naming it is load-bearing again: without it the sponsor refuses the
    // conversion leg, with it the sponsor accepts. `/v1/bundler` names it the same way.
    const core = await import('@tradepro/core');
    expect(() => core.assertSponsorable(calls, policyFor(pre, USDC))).toThrow(
      expect.objectContaining({ reason: 'TARGET_NOT_ALLOWED' }),
    );
    expect(sponsorWouldAccept(pre, USDC, prepared.calls)).toBe(true);
  });

  it('names only the permit token and only the one market', () => {
    const policy = policyFor(preflightWith(usdcToken), USDC, AUSD_USDC_MARKET);
    expect(policy.permitTokens).toEqual([USDC]);
    expect(policy.markets).toEqual([AUSD_USDC_MARKET]);
    expect(policy.marginAccount).toBe(MARGIN);
  });
});

describe('nothing is signed for an amount the wallet does not have', () => {
  it('refuses more than the balance that was read', async () => {
    await expect(
      prepareTopUp({
        account: signerAccount(),
        preflight: preflightWith(ausdToken),
        token: ausdToken,
        amount: 1_013_401n,
        onProgress: () => {},
      }),
    ).rejects.toThrow(/larger than the wallet balance/);
  });

  it('refuses a token with no provable permit domain', async () => {
    await expect(
      prepareTopUp({
        account: signerAccount(),
        preflight: preflightWith({ ...ausdToken, permit: false }),
        token: { ...ausdToken, permit: false },
        amount: 1_000n,
        onProgress: () => {},
      }),
    ).rejects.toThrow(/cannot be moved by signature/);
  });
});

describe('checkVenueClear — the fresh read before a signature is ever requested', () => {
  // This is the fix for the actual bug reported: a page open for up to ten minutes
  // (useLiveStatus's poll interval) could show an enabled "Move" button on a stale
  // read, and a click then asked for a passkey signature on a batch that was already
  // going to fail. This function is what runs first, on every tap, before any of that.

  const jsonResponse = (body: unknown, ok = true): typeof fetch =>
    (async () =>
      ({ ok, json: async () => body }) as unknown as Response) as unknown as typeof fetch;

  it('is clear only on an explicit paused: false', async () => {
    const result = await checkVenueClear(jsonResponse({ paused: false }));
    expect(result).toEqual({ clear: true });
  });

  it('blocks on an explicit paused: true, with the Kuru-specific message', async () => {
    const result = await checkVenueClear(jsonResponse({ paused: true }));
    expect(result.clear).toBe(false);
    expect(!result.clear && result.message).toContain('Kuru has paused deposits');
  });

  it('blocks on paused: null — "unknown" is not "clear"', async () => {
    const result = await checkVenueClear(jsonResponse({ paused: null }));
    expect(result.clear).toBe(false);
    expect(!result.clear && result.message).toContain('Could not confirm');
  });

  it('blocks on a non-OK response, without claiming Kuru is paused', async () => {
    const result = await checkVenueClear(jsonResponse({ paused: false }, false));
    expect(result.clear).toBe(false);
    expect(!result.clear && result.message).toContain('Could not confirm');
  });

  it('blocks when the fetch itself throws — a network failure is not evidence of clear', async () => {
    const throwing: typeof fetch = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const result = await checkVenueClear(throwing);
    expect(result.clear).toBe(false);
    expect(!result.clear && result.message).toContain('Could not confirm');
  });
});

describe('settlement gates the last two steps', () => {
  it('a delivered swap alone never claims the money reached Kuru', () => {
    // The regression: SUCCESS used to light both remaining steps while the USDC sat
    // in the wallet and the user had moved nothing.
    expect(swapStepIndex('SUCCESS')).toBe(2);
  });

  it('a mined move ticks step 3; only a risen margin balance ticks step 4', () => {
    expect(swapStepIndex('SUCCESS', { moveConfirmed: true, marginIncreased: false })).toBe(3);
    expect(swapStepIndex('SUCCESS', { moveConfirmed: true, marginIncreased: true })).toBe(4);
  });
});

describe('preflight() carries the real reason for a 502, not a bare "unavailable" (B3/C3)', () => {
  const OWNER = '0x714f169Fe2D3990961B534D573f9646c037586E6' as Address;

  function stubFetchOnce(status: number, body: unknown): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status })),
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('attaches the server’s own upstream reason to a transport failure', async () => {
    stubFetchOnce(502, {
      error: 'PERMIT_READ_FAILED',
      upstream: { message: 'timeout', source: 'Monad RPC' },
    });
    const error = await preflight(OWNER).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PreflightError);
    expect((error as PreflightError).kind).toBe('RPC_UNAVAILABLE');
    expect((error as PreflightError).upstream).toBe('Monad RPC said: “timeout”');
  });

  it('still reports RPC_UNAVAILABLE with no detail when the server sent none', async () => {
    stubFetchOnce(502, { error: 'PERMIT_READ_FAILED' });
    const error = await preflight(OWNER).catch((e: unknown) => e);
    expect((error as PreflightError).kind).toBe('RPC_UNAVAILABLE');
    expect((error as PreflightError).upstream).toBeUndefined();
  });

  it('does not attach a detail to the genuinely-unsupported and no-margin-account cases', async () => {
    stubFetchOnce(501, { error: 'PERMIT_UNSUPPORTED', tokens: [] });
    const unsupported = await preflight(OWNER).catch((e: unknown) => e);
    expect((unsupported as PreflightError).kind).toBe('PERMIT_UNSUPPORTED');
    expect((unsupported as PreflightError).upstream).toBeUndefined();
  });
});
