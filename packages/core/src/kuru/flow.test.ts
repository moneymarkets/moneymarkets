import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import {
  assertFlowQuoteMatchesRequest,
  flowCalldataMentions,
  flowCalldataWords,
  flowTouchesWmon,
  FLOW_REFERRER_FEE_EVIDENCE,
  FlowQuoteMismatchError,
  KURU_FLOW_ROUTER,
  KURU_FLOW_SELECTOR,
  KuruFlowClient,
  normalizeFlowCalldata,
  parseFlowQuote,
} from './flow.js';
import {
  FLOW_QUOTE_AMOUNT_IN,
  FLOW_QUOTE_REFERRER_FEE_BPS,
  FLOW_QUOTE_TOKEN_IN,
  FLOW_QUOTE_TOKEN_OUT,
  FLOW_QUOTE_USER,
  FLOW_ROUTE_VENUE,
  FLOW_USDC_AUSD_RESPONSE,
} from './__fixtures__/flow.js';

const REQUEST = {
  tokenIn: FLOW_QUOTE_TOKEN_IN,
  tokenOut: FLOW_QUOTE_TOKEN_OUT,
  amount: FLOW_QUOTE_AMOUNT_IN,
  referrerAddress: FLOW_QUOTE_USER,
  referrerFeeBps: FLOW_QUOTE_REFERRER_FEE_BPS,
};

describe('the API returns calldata a wallet cannot use unchanged', () => {
  it('adds the 0x the API omits', () => {
    expect(normalizeFlowCalldata('ce1e7030aabb')).toBe('0xce1e7030aabb');
    expect(normalizeFlowCalldata('0xce1e7030aabb')).toBe('0xce1e7030aabb');
  });

  it('refuses anything that is not whole hex bytes', () => {
    expect(() => normalizeFlowCalldata('')).toThrow();
    expect(() => normalizeFlowCalldata('abc')).toThrow();
    expect(() => normalizeFlowCalldata('0xzz')).toThrow();
  });
});

describe('a Flow leg is user-gas-paid, and the type says so', () => {
  const quote = parseFlowQuote(FLOW_USDC_AUSD_RESPONSE, {
    referrerAddress: FLOW_QUOTE_USER,
    referrerFeeBps: FLOW_QUOTE_REFERRER_FEE_BPS,
  });

  it('labels the payer in the data, not in a comment', () => {
    expect(quote.gasPayer).toBe('user');
    expect(quote.sponsored).toBe(false);
    expect(quote.relayable).toBe(false);
  });

  it('parses the amounts the API really returned', () => {
    expect(quote.output).toBe(996_851n);
    expect(quote.minOut).toBe(996_452n);
    expect(quote.value).toBe(0n);
    expect(quote.to).toBe(KURU_FLOW_ROUTER);
  });

  it('records the referrer fee that was asked for', () => {
    expect(quote.fee.referrerAddress).toBe(FLOW_QUOTE_USER);
    expect(quote.fee.bps).toBe(30);
    expect(quote.fee.evidence).toBe('requested');
  });

  it('says plainly when no routing fee was requested', () => {
    const plain = parseFlowQuote(FLOW_USDC_AUSD_RESPONSE);
    expect(plain.fee).toEqual({ evidence: 'none' });
    expect(plain.gasPayer).toBe('user');
  });

  it('refuses a quote the API did not mark successful', () => {
    expect(() => parseFlowQuote({ ...FLOW_USDC_AUSD_RESPONSE, status: 'error' })).toThrow(
      /status error/,
    );
  });
});

describe('the route is evidence, never a decode', () => {
  const quote = parseFlowQuote(FLOW_USDC_AUSD_RESPONSE);

  it('never claims to have decoded the router call', () => {
    expect(quote.route.decoded).toBe(false);
    expect(quote.route.selector).toBe(KURU_FLOW_SELECTOR);
    expect(quote.route.router).toBe(KURU_FLOW_ROUTER);
  });

  it('measures the calldata rather than interpreting it', () => {
    const words = flowCalldataWords(quote.calldata);
    expect(quote.route.wordCount).toBe(words.length);
    expect(quote.route.calldataBytes).toBe((quote.calldata.length - 2) / 2);
    // 4 selector bytes + whole words, plus the trailing packed blob's own padding.
    expect(quote.route.calldataBytes).toBe(4 + words.length * 32);
  });

  it('surfaces both tokens as address-shaped words', () => {
    const lower = quote.route.addressShapedWords.map((a) => a.toLowerCase());
    expect(lower).toContain(FLOW_QUOTE_TOKEN_IN.toLowerCase());
    expect(lower).toContain(FLOW_QUOTE_TOKEN_OUT.toLowerCase());
  });

  it('finds the order book named in the trailing blob, which no word scan sees', () => {
    // The venue sits at a byte offset that is not a multiple of 32.
    expect(flowCalldataMentions(quote.calldata, FLOW_ROUTE_VENUE)).toBe(true);
    expect(quote.route.addressShapedWords.map((a) => a.toLowerCase())).not.toContain(
      FLOW_ROUTE_VENUE.toLowerCase(),
    );
  });

  it('does not report an address that is absent', () => {
    expect(flowCalldataMentions(quote.calldata, '0x1111111111111111111111111111111111111111')).toBe(
      false,
    );
  });
});

describe('a quote must agree with its own bytes', () => {
  const quote = parseFlowQuote(FLOW_USDC_AUSD_RESPONSE, {
    referrerAddress: FLOW_QUOTE_USER,
    referrerFeeBps: FLOW_QUOTE_REFERRER_FEE_BPS,
  });

  it('promotes the fee to in-calldata once both parts are found', () => {
    const checked = assertFlowQuoteMatchesRequest(quote, REQUEST);
    expect(checked.fee.evidence).toBe('in-calldata');
    expect(checked.fee.bps).toBe(30);
  });

  it('rejects a quote whose amount is not in its calldata', () => {
    expect(() => assertFlowQuoteMatchesRequest(quote, { ...REQUEST, amount: 999_999n })).toThrow(
      FlowQuoteMismatchError,
    );
  });

  it('rejects a quote whose minOut is not in its calldata', () => {
    expect(() => assertFlowQuoteMatchesRequest({ ...quote, minOut: 996_451n }, REQUEST)).toThrow(
      FlowQuoteMismatchError,
    );
  });

  it('cannot catch a value small enough to appear by coincidence', () => {
    // An honest limit of a substring check: this calldata carries a literal word of
    // value 1, so a minOut of 1 is "found" and passes. The check catches a wrong
    // *realistic* amount, which is the failure that costs money; it is not a proof.
    expect(() => assertFlowQuoteMatchesRequest({ ...quote, minOut: 1n }, REQUEST)).not.toThrow();
  });

  it('rejects a fee routed to a different referrer', () => {
    const other = '0x2222222222222222222222222222222222222222' as Address;
    let missing: readonly string[] = [];
    try {
      assertFlowQuoteMatchesRequest(quote, { ...REQUEST, referrerAddress: other });
    } catch (error) {
      missing = (error as FlowQuoteMismatchError).missing;
    }
    expect(missing).toContain('referrerAddress');
  });

  it('rejects a fee of a different size', () => {
    let missing: readonly string[] = [];
    try {
      assertFlowQuoteMatchesRequest(quote, { ...REQUEST, referrerFeeBps: 31 });
    } catch (error) {
      missing = (error as FlowQuoteMismatchError).missing;
    }
    expect(missing).toContain('referrerFeeBps');
  });

  it('does not assert the native asset, whose word is present in anything', () => {
    // address(0) left-pads to 64 zeros, which appears in almost any calldata; an
    // assertion that cannot fail is worse than none.
    const native = '0x0000000000000000000000000000000000000000' as Address;
    expect(() =>
      assertFlowQuoteMatchesRequest(quote, { ...REQUEST, tokenOut: native }),
    ).not.toThrow();
  });
});

describe('the referrer fee is a measurement, not a field the API returns', () => {
  it('is 30 bps taken out of the output, from two live quotes on the same route', () => {
    const { outputWithoutReferrer, outputWithReferrer, referrerFeeBps } =
      FLOW_REFERRER_FEE_EVIDENCE;
    const charged = outputWithoutReferrer - outputWithReferrer;
    const floor = (outputWithoutReferrer * BigInt(referrerFeeBps)) / 10_000n;
    // 30 bps of the gross output, rounded up: the measured charge is `floor + 1`,
    // which is the ceiling of 115945813237676607.642 wei.
    expect(charged).toBe(floor + 1n);
    expect(charged * 10_000n).toBeGreaterThanOrEqual(
      outputWithoutReferrer * BigInt(referrerFeeBps),
    );
    expect(outputWithReferrer).toBeLessThan(outputWithoutReferrer);
  });

  it('is basis points, not the parts-per-million the order books use', () => {
    const { outputWithoutReferrer, outputWithReferrer } = FLOW_REFERRER_FEE_EVIDENCE;
    const asPps = (outputWithoutReferrer * 30n) / 1_000_000n;
    expect(outputWithoutReferrer - outputWithReferrer).not.toBe(asPps);
  });
});

describe('the client sends the referrer parameters the venue expects', () => {
  it('puts referrerAddress and referrerFeeBps in the quote request body', async () => {
    let body: Record<string, unknown> = {};
    const client = new KuruFlowClient({
      referrerAddress: FLOW_QUOTE_USER,
      referrerFeeBps: FLOW_QUOTE_REFERRER_FEE_BPS,
      fetchImpl: (async (url: string, init: RequestInit) => {
        if (String(url).endsWith('/generate-token')) {
          return new Response(
            JSON.stringify({
              token: 'jwt',
              expires_at: Math.floor(Date.now() / 1000) + 3600,
              rate_limit: { rps: 1, burst: 1 },
            }),
            { status: 200 },
          );
        }
        body = JSON.parse(String(init.body));
        return new Response(JSON.stringify(FLOW_USDC_AUSD_RESPONSE), { status: 200 });
      }) as unknown as typeof fetch,
    });

    const quote = await client.quote({
      userAddress: FLOW_QUOTE_USER,
      tokenIn: FLOW_QUOTE_TOKEN_IN,
      tokenOut: FLOW_QUOTE_TOKEN_OUT,
      amount: FLOW_QUOTE_AMOUNT_IN,
    });

    expect(body.referrerAddress).toBe(FLOW_QUOTE_USER);
    expect(body.referrerFeeBps).toBe(30);
    expect(body.amount).toBe('1000000');
    expect(body.autoSlippage).toBe(true);
    // The client checks the bytes before it hands the quote back.
    expect(quote.fee.evidence).toBe('in-calldata');
    expect(quote.gasPayer).toBe('user');
  });

  it('refuses a quote whose calldata does not carry the amount it was asked for', async () => {
    const client = new KuruFlowClient({
      fetchImpl: (async (url: string) => {
        if (String(url).endsWith('/generate-token')) {
          return new Response(
            JSON.stringify({ token: 'jwt', expires_at: Math.floor(Date.now() / 1000) + 3600 }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify(FLOW_USDC_AUSD_RESPONSE), { status: 200 });
      }) as unknown as typeof fetch,
    });

    await expect(
      client.quote({
        userAddress: FLOW_QUOTE_USER,
        tokenIn: FLOW_QUOTE_TOKEN_IN,
        tokenOut: FLOW_QUOTE_TOKEN_OUT,
        amount: 42n,
      }),
    ).rejects.toThrow(FlowQuoteMismatchError);
  });
});

describe('flowTouchesWmon — the native-MON-reserve red flag', () => {
  it('is false for the recorded route that never leaves ERC-20', () => {
    // FLOW_USDC_AUSD_RESPONSE routes through the AUSD/USDC book directly (see the
    // FLOW_ROUTE_VENUE doc comment) -- no WMON leg.
    expect(flowTouchesWmon(normalizeFlowCalldata(FLOW_USDC_AUSD_RESPONSE.transaction.calldata))).toBe(
      false,
    );
  });

  it('is true for a real route that wraps and unwraps WMON', () => {
    // Recorded live 2026-09-08: a 5 USDC -> AUSD quote, once the direct book could not
    // fill the size, routed through WMON -- confirmed by `debug_traceCall` to carry
    // large internal native-MON transfers between the router and pool contracts. This
    // is that quote's own `transaction.calldata`, byte for byte.
    const calldata = normalizeFlowCalldata(
      'ce1e703000000000000000000000000000000000efe302beaa2b3e6e1b18d08d69a9012a00000000000000000000000000000000000000000000000000000000004c4761000000000000000000000000754704bc059f8c67012fed69bc8a327a5aafb60300000000000000000000000000000000000000000000000000000000004c4b4000000000000000000000000062ee1b8d1efdf8f73c78db87b888406b194e266a00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000010002754704bc059f8c67012fed69bc8a327a5aafb60301ffff03065c9d28e428a0db40191a54d33d5b7c71a9c3940105f5e10000000000000000000000000000000000000000000000000000000002540be400060302903802016fc708188d586ddcf52439676ca21a244753fa19f9ea8e000000000000000000000000000000000000000000000000efe302beaa2b3e6e1b18d08d69a9012a0001f400000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000013bd359c1119da7da1d913d1c4d2b7c461115433a01ffff01d5b70d70cbe6c42bcd1aaa662a21673a83f4615b00',
    );
    expect(flowTouchesWmon(calldata)).toBe(true);
  });

  it('does not report WMON where it is absent', () => {
    expect(flowTouchesWmon('0xce1e7030' as `0x${string}`)).toBe(false);
  });
});
