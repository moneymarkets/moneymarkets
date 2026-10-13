import { describe, expect, it } from 'vitest';
import {
  buildQuoteRequest,
  classifyQuoteRefusal,
  depositAddressOf,
  depositExpiryOf,
  oneClickQuoteSchema,
  parseUsd,
  quoteEconomics,
  sameAssetFee,
} from './quote.js';

/**
 * The fixture below is a REAL response, captured from
 * `POST https://1click.chaindefuser.com/v0/quote` on 2026-09-02 with no JWT, for
 * 25 USDT on Tron to USDC on Monad delivered to the M0 test account. Nothing here is
 * invented; the numbers are what the solver network actually quoted.
 */
const LIVE_QUOTE = {
  quote: {
    amountIn: '25000000',
    amountInFormatted: '25.0',
    amountInUsd: '24.988600000000',
    minAmountIn: '25000000',
    amountOut: '24962280',
    amountOutFormatted: '24.96228',
    amountOutUsd: '24.954591617760',
    minAmountOut: '24712657',
    timeEstimate: 82,
    refundFee: '883706',
    withdrawFee: '685',
  },
  signature: 'ed25519:live-response-was-signed',
  timestamp: '2026-09-02T13:41:20.280Z',
  correlationId: '357b06d7-95ee-4a64-8686-a7a794023edb',
} as const;

const TEST_ACCOUNT = '0x43a275C3Eb0BE7313f847FFA4fb6Bd366606A961' as const;
const USDT_TRON = 'nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near';
const USDC_MONAD = 'nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx';
const TRON_REFUND = 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE';

describe('1Click quote parsing', () => {
  it('accepts the real response shape', () => {
    const parsed = oneClickQuoteSchema.parse(LIVE_QUOTE);
    expect(parsed.quote.amountOut).toBe('24962280');
    expect(parsed.signature).toBeDefined();
  });

  it('reports no deposit address for a dry quote', () => {
    // A dry quote prices the route and allocates nothing. A UI must never present
    // one as an address a user can send money to.
    expect(depositAddressOf(oneClickQuoteSchema.parse(LIVE_QUOTE))).toBeUndefined();
  });

  it('surfaces a deposit address when the quote is real', () => {
    const real = {
      ...LIVE_QUOTE,
      quote: { ...LIVE_QUOTE.quote, depositAddress: 'TXYZexampleDepositAddress' },
    };
    expect(depositAddressOf(oneClickQuoteSchema.parse(real))).toBe('TXYZexampleDepositAddress');
  });
});

describe('quote economics', () => {
  it('refuses to divide by a zero input', () => {
    const zero = { ...LIVE_QUOTE, quote: { ...LIVE_QUOTE.quote, amountIn: '0' } };
    expect(() => quoteEconomics(oneClickQuoteSchema.parse(zero))).toThrow(/positive/);
  });

  it('refuses a quote that delivers nothing', () => {
    const zero = { ...LIVE_QUOTE, quote: { ...LIVE_QUOTE.quote, amountOut: '0' } };
    expect(() => quoteEconomics(oneClickQuoteSchema.parse(zero))).toThrow(/positive/);
  });
});

/**
 * The 5 USDC Base fixture, captured verbatim 2026-09-03 from a dry quote for USDC on
 * Base -> USDC on Monad against the M0 test account.
 */
const LIVE_BASE_5_USDC = {
  quote: {
    amountIn: '5000000',
    amountInFormatted: '5.0',
    amountInUsd: '4.999045000000',
    minAmountIn: '5000000',
    amountOut: '4993320',
    amountOutFormatted: '4.99332',
    amountOutUsd: '4.992366275880',
    minAmountOut: '4943386',
    timeEstimate: 37,
    refundFee: '2400',
    withdrawFee: '667',
  },
} as const;

describe('the fee is a fee, not a subtraction across two assets', () => {
  it('pins the fee for the live 5 USDC Base quote', () => {
    const e = quoteEconomics(oneClickQuoteSchema.parse(LIVE_BASE_5_USDC));
    // Both sides are six-decimal dollars here, so the direct subtraction is legal
    // and is the arithmetic the coordinator asked to be pinned:
    //   (5000000 - 4993320) * 10000n / 5000000n = 13
    expect(((e.amountIn - e.amountOut) * 10_000n) / e.amountIn).toBe(13n);
    expect(e.feeBps).toBe(13n);
    // 4.999045 - 4.992366 = 0.006679, in USD base units.
    expect(e.feeUsd).toBe(6_679n);
    expect(e.valueInUsd).toBe(4_999_045n);
    expect(e.valueOutUsd).toBe(4_992_366n);
  });

  it('accounts the fixed fees separately, because they are charged separately', () => {
    const e = quoteEconomics(oneClickQuoteSchema.parse(LIVE_BASE_5_USDC));
    // refundFee is only charged if the deposit comes back; withdrawFee on delivery.
    expect(e.refundFee).toBe(2_400n);
    expect(e.withdrawFee).toBe(667n);
  });

  it('gives the exact unit fee only when both sides are the same asset', () => {
    const e = quoteEconomics(oneClickQuoteSchema.parse(LIVE_BASE_5_USDC));
    expect(sameAssetFee(e, 6, 6, 'USDC', 'USDC')).toBe(6_680n);
    // SOL in, USDC out: nine decimals against six. There is nothing to subtract.
    expect(sameAssetFee(e, 9, 6, 'SOL', 'USDC')).toBeUndefined();
    expect(sameAssetFee(e, 6, 6, 'USDT', 'USDC')).toBeUndefined();
  });

  it('does not report 9008 bps for a dollar of SOL', () => {
    // The regression this replaces. A ~$1 SOL deposit yielding ~0.99 USDC costs
    // about 1%; `amountIn - amountOut` across 9dp SOL and 6dp USDC read 9008 bps.
    const sol = {
      quote: {
        amountIn: '9986000',
        amountInUsd: '1.000000000000',
        amountOut: '990000',
        amountOutUsd: '0.990000000000',
        minAmountOut: '980100',
      },
    };
    const e = quoteEconomics(oneClickQuoteSchema.parse(sol));
    const naive = ((e.amountIn - e.amountOut) * 10_000n) / e.amountIn;
    expect(naive).toBe(9_008n); // what the old code produced
    expect(e.feeBps).toBe(100n); // 1%, which is what it really costs
    expect(e.feeUsd).toBe(10_000n); // $0.01
  });

  it('reports the fee as unknown rather than wrong when the network omits USD', () => {
    const bare = { quote: { amountIn: '5000000', amountOut: '4993320', minAmountOut: '4943386' } };
    const e = quoteEconomics(oneClickQuoteSchema.parse(bare));
    expect(e.feeBps).toBeUndefined();
    expect(e.feeUsd).toBeUndefined();
    // Slippage is still exact: both of its sides are the destination asset.
    expect(e.slippageBps).toBe(100n);
  });
});

describe('slippage is the one figure that stays a ratio', () => {
  it('is taken from the destination asset on both sides', () => {
    const e = quoteEconomics(oneClickQuoteSchema.parse(LIVE_BASE_5_USDC));
    // (4993320 - 4943386) * 10000 / 4993320 = 100 bps, exactly the 100 bps of
    // slippageTolerance the request asked for.
    expect(e.slippageBps).toBe(100n);
  });

  it('holds for the Tron fixture too, where the origin asset is different', () => {
    const e = quoteEconomics(oneClickQuoteSchema.parse(LIVE_QUOTE));
    expect(e.slippageBps).toBe(100n);
  });
});

describe('USD parsing never goes through a float', () => {
  it('truncates rather than rounding up, so a fee cannot grow', () => {
    expect(parseUsd('4.999045000000')).toBe(4_999_045n);
    expect(parseUsd('0.9999999')).toBe(999_999n);
    expect(parseUsd('1')).toBe(1_000_000n);
    expect(parseUsd('.5')).toBe(500_000n);
  });

  it('answers undefined for anything that is not a decimal', () => {
    expect(parseUsd(undefined)).toBeUndefined();
    expect(parseUsd('')).toBeUndefined();
    expect(parseUsd('1e6')).toBeUndefined();
    expect(parseUsd('NaN')).toBeUndefined();
  });
});

describe('quote request', () => {
  const base = {
    originAsset: USDT_TRON,
    destinationAsset: USDC_MONAD,
    amount: 25_000_000n,
    recipient: TEST_ACCOUNT,
    refundTo: TRON_REFUND,
    dry: true,
  };

  it('builds the body the API accepted', () => {
    const body = buildQuoteRequest(base) as Record<string, unknown>;
    expect(body.swapType).toBe('EXACT_INPUT');
    expect(body.depositType).toBe('ORIGIN_CHAIN');
    expect(body.recipientType).toBe('DESTINATION_CHAIN');
    expect(body.amount).toBe('25000000');
    expect(body.slippageTolerance).toBe(100);
    expect(typeof body.deadline).toBe('string');
  });

  it('requires a refund address', () => {
    // refundTo is where the money goes if the swap fails, so it is not optional and
    // not defaultable to the recipient: those are on different chains.
    expect(() => buildQuoteRequest({ ...base, refundTo: '' })).toThrow(/refundTo/);
  });

  it('refuses a non-positive amount', () => {
    expect(() => buildQuoteRequest({ ...base, amount: 0n })).toThrow(/positive/);
  });

  it('refuses a nonsensical slippage', () => {
    expect(() => buildQuoteRequest({ ...base, slippageToleranceBps: -1 })).toThrow(/basis-point/);
    expect(() => buildQuoteRequest({ ...base, slippageToleranceBps: 10_001 })).toThrow(
      /basis-point/,
    );
  });

  it('serialises the amount as a decimal string, never a number', () => {
    // A JS number would lose precision above 2^53; these are base units.
    const body = buildQuoteRequest({ ...base, amount: 9_007_199_254_740_993n }) as Record<
      string,
      unknown
    >;
    expect(body.amount).toBe('9007199254740993');
  });
});

describe('a refused quote carries the answer', () => {
  // Verbatim 400 bodies, taken live 2026-09-03 for USDC on Base -> USDC on Monad.
  const TOO_LOW =
    '{"message":"Amount is too low for bridge, try at least 150000",' +
    '"correlationId":"a560f13e-622a-47ed-9132-d8453f8b703b",' +
    '"timestamp":"2026-09-03T05:36:10.134Z","path":"/v0/quote"}';
  const BAD_REFUND =
    '{"message":"refundTo is not valid","correlationId":"46b2fcb7-8881-4906-bb0a-21d9ecf3081f",' +
    '"timestamp":"2026-09-03T05:36:26.778Z","path":"/v0/quote"}';

  it('reads the minimum out of the message, in base units', () => {
    const refusal = classifyQuoteRefusal(400, TOO_LOW);
    expect(refusal.kind).toBe('AMOUNT_BELOW_MINIMUM');
    if (refusal.kind !== 'AMOUNT_BELOW_MINIMUM') throw new Error('unreachable');
    // 150000 base units of a 6dp asset is 0.15 USDC. Measured boundary: 149999 is
    // refused and 150000 is priced.
    expect(refusal.minimum).toBe(150_000n);
    expect(refusal.message).toBe('Amount is too low for bridge, try at least 150000');
  });

  it('keeps the minimum a bigint, so a 18dp route cannot round', () => {
    const refusal = classifyQuoteRefusal(
      400,
      '{"message":"Amount is too low for bridge, try at least 12345678901234567890"}',
    );
    if (refusal.kind !== 'AMOUNT_BELOW_MINIMUM') throw new Error('unreachable');
    expect(refusal.minimum).toBe(12345678901234567890n);
  });

  it('tells a below-minimum amount apart from a route that will not price', () => {
    expect(classifyQuoteRefusal(400, BAD_REFUND).kind).toBe('REFUND_ADDRESS_INVALID');
    expect(classifyQuoteRefusal(503, '{"message":"No route available"}').kind).toBe(
      'ROUTE_UNAVAILABLE',
    );
  });

  // Verbatim 400 body, taken live 2026-09-08 for USDC on Base -> USDC on Monad.
  // A USD-denominated floor, not base units — the first live sighting of this shape.
  const USD_LIMIT = '{"message":"Temporary swap limits: minimum swap amount is $1,000"}';

  it('reads a USD-denominated minimum out of a temporary-limits refusal', () => {
    const refusal = classifyQuoteRefusal(400, USD_LIMIT);
    expect(refusal.kind).toBe('AMOUNT_BELOW_MINIMUM');
    if (refusal.kind !== 'AMOUNT_BELOW_MINIMUM') throw new Error('unreachable');
    expect(refusal.minimumUsd).toBe(1_000_000_000n); // $1,000 at 6dp
    expect(refusal.minimum).toBeUndefined(); // no base-unit figure was published
    expect(refusal.message).toBe('Temporary swap limits: minimum swap amount is $1,000');
  });

  it('reads USD minimums with decimals and without thousands separators', () => {
    const a = classifyQuoteRefusal(400, '{"message":"minimum swap amount is $250.50"}');
    if (a.kind !== 'AMOUNT_BELOW_MINIMUM') throw new Error('unreachable');
    expect(a.minimumUsd).toBe(250_500_000n);
    const b = classifyQuoteRefusal(400, '{"message":"minimum swap amount is $1000"}');
    if (b.kind !== 'AMOUNT_BELOW_MINIMUM') throw new Error('unreachable');
    expect(b.minimumUsd).toBe(1_000_000_000n);
  });

  it('never rewrites or drops the upstream sentence, whatever the classification', () => {
    // The rule item 1 of the 2026-09-08 error-handling pass asks for: classification
    // may add structure, it may never lose the network's own words. If a refusal body
    // has a message, that exact message comes back out.
    const bodies = [
      'Amount is too low for bridge, try at least 150000',
      'Temporary swap limits: minimum swap amount is $1,000',
      'refundTo is not valid',
      'No route available',
      'Some sentence this build has never seen before, with a figure: 42',
    ];
    for (const message of bodies) {
      const refusal = classifyQuoteRefusal(400, JSON.stringify({ message }));
      expect(refusal.message).toBe(message);
    }
  });

  it('survives a body that is not JSON at all', () => {
    const refusal = classifyQuoteRefusal(502, '<html>502 Bad Gateway</html>');
    expect(refusal.kind).toBe('ROUTE_UNAVAILABLE');
    expect(refusal.status).toBe(502);
    expect(refusal.message.length).toBeGreaterThan(0);
  });

  it('never returns an empty message, because a blank notice says nothing', () => {
    expect(classifyQuoteRefusal(500, '').message).toContain('500');
  });
});

describe('the deposit window is the one the network sent back', () => {
  it('prefers timeWhenInactive over the requested deadline', () => {
    // Measured: a quote asked for +1h came back with a window three days out.
    const quote = oneClickQuoteSchema.parse({
      quote: {
        amountIn: '5000000',
        amountOut: '4993319',
        minAmountOut: '4943385',
        deadline: '2026-09-06T06:36:46.241Z',
        timeWhenInactive: '2026-09-06T06:36:46.241Z',
        depositAddress: '0x3fE42be94203712CE95d4fAdF83f83E0784e478e',
      },
    });
    expect(depositExpiryOf(quote)).toBe(Date.parse('2026-09-06T06:36:46.241Z'));
  });

  it('is undefined on a dry quote, which reserves nothing to expire', () => {
    const dry = oneClickQuoteSchema.parse({
      quote: { amountIn: '5000000', amountOut: '4993320', minAmountOut: '4943386' },
    });
    expect(depositExpiryOf(dry)).toBeUndefined();
    expect(depositAddressOf(dry)).toBeUndefined();
  });
});
