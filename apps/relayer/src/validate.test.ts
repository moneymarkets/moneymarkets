import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import {
  buildCancelOrders,
  buildDeposit,
  buildForwardRequest,
  buildLimitOrder,
  FORWARD_REQUEST_TYPES,
  KURU_FORWARDER_DOMAIN,
  MAX_PERMIT_DEADLINE_SECONDS,
} from '@tradepro/core';
import { TargetAllowlist } from './allowlist.js';
import {
  Rejection,
  validateForwardSignature,
  validateForwardStructure,
  validatePermit,
  type ValidationContext,
} from './validate.js';

const MARGIN = '0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5' as Address;
const MARKET = '0x131a2e70a5b31a517a74b8c567149bc294470da9' as Address;
const UNTRUSTED = '0x0000000000000000000000000000000000000123' as Address;
const AUSD = '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a' as Address;
const OFF_LIST = '0x000000000000000000000000000000000000dEaD' as Address;

const account = privateKeyToAccount(`0x${'33'.repeat(32)}` as Hex);
const NOW_MS = 1_756_800_000_000;
const now = () => NOW_MS;

const params = {
  pricePrecision: 100_000_000n,
  sizePrecision: 10_000_000_000n,
  baseAsset: '0x0000000000000000000000000000000000000000' as Address,
  baseDecimals: 18,
  quoteAsset: AUSD,
  quoteDecimals: 6,
  tickSize: 100n,
  minSize: 2_000_000_000_000n,
  maxSize: 20_000_000_000_000_000_000n,
  takerFeeBps: 0n,
  makerFeeBps: 0n,
};

function makeAllowlist(): TargetAllowlist {
  const list = new TargetAllowlist(undefined as never, 'mainnet');
  list.seed([
    { address: MARGIN, kind: 'marginAccount', symbol: 'MarginAccount', trustsForwarder: true },
    { address: MARKET, kind: 'orderbook', symbol: 'MON/AUSD', trustsForwarder: true },
    { address: UNTRUSTED, kind: 'orderbook', symbol: 'OLD/MARKET', trustsForwarder: false },
  ]);
  return list;
}

const context = (overrides: Partial<ValidationContext> = {}): ValidationContext => ({
  allowlist: makeAllowlist(),
  maxGas: 2_000_000n,
  maxDeadlineSeconds: 300,
  now,
  ...overrides,
});

const order = buildLimitOrder({
  market: MARKET,
  params,
  side: 'buy',
  priceWire: 25_952_000_000_000_000n,
  sizeBase: 1_000_000_000_000_000_000_000n,
});

const goodRequest = buildForwardRequest({
  from: account.address,
  to: MARKET,
  data: order.data,
  nonce: 0n,
  gas: 250_000n,
  now: NOW_MS,
});

function expectRejection(fn: () => void, code: string): void {
  try {
    fn();
    throw new Error(`expected a ${code} rejection, got none`);
  } catch (error) {
    expect(error).toBeInstanceOf(Rejection);
    expect((error as Rejection).code).toBe(code);
  }
}

describe('target allowlist', () => {
  it('accepts an allowlisted market that trusts the forwarder', () => {
    expect(() => validateForwardStructure(goodRequest, context())).not.toThrow();
  });

  it('accepts the MarginAccount for a deposit', () => {
    const deposit = buildDeposit(MARGIN, account.address, AUSD, 1_000_000n);
    const request = buildForwardRequest({
      from: account.address,
      to: MARGIN,
      data: deposit.data,
      nonce: 0n,
      gas: 200_000n,
      now: NOW_MS,
    });
    expect(() => validateForwardStructure(request, context())).not.toThrow();
  });

  it('rejects a target that is not on the list', () => {
    expectRejection(
      () => validateForwardStructure({ ...goodRequest, to: OFF_LIST }, context()),
      'TARGET_NOT_ALLOWED',
    );
  });

  it('rejects an allowlisted target that does NOT trust the forwarder', () => {
    // A forwarded call there executes with the forwarder as msg.sender, which would
    // place an order owned by the relayer using the relayer's balance.
    expectRejection(
      () => validateForwardStructure({ ...goodRequest, to: UNTRUSTED }, context()),
      'TARGET_NOT_ALLOWED',
    );
  });
});

describe('selector allowlist', () => {
  it('accepts a cancel', () => {
    const cancel = buildCancelOrders(MARKET, [1n]);
    expect(() =>
      validateForwardStructure({ ...goodRequest, data: cancel.data }, context()),
    ).not.toThrow();
  });

  it('rejects MarginAccount.creditUser, which would mint balance out of nothing', () => {
    expectRejection(
      () =>
        validateForwardStructure(
          { ...goodRequest, to: MARGIN, data: `0x75eab98e${'0'.repeat(256)}` as Hex },
          context(),
        ),
      'SELECTOR_NOT_ALLOWED',
    );
  });

  it('rejects OrderBook.batchUpdate, the market-making entry point', () => {
    expectRejection(
      () =>
        validateForwardStructure(
          { ...goodRequest, data: `0x5339c59f${'0'.repeat(256)}` as Hex },
          context(),
        ),
      'SELECTOR_NOT_ALLOWED',
    );
  });

  it('rejects calldata with no selector at all', () => {
    expectRejection(
      () => validateForwardStructure({ ...goodRequest, data: '0x' as Hex }, context()),
      'BAD_REQUEST',
    );
  });
});

describe('value, gas and deadline', () => {
  it('rejects any non-zero value', () => {
    expectRejection(
      () => validateForwardStructure({ ...goodRequest, value: 1n }, context()),
      'VALUE_NOT_ZERO',
    );
  });

  it('rejects gas above the cap', () => {
    expectRejection(
      () => validateForwardStructure({ ...goodRequest, gas: 2_000_001n }, context()),
      'GAS_TOO_HIGH',
    );
  });

  it('rejects zero gas', () => {
    expectRejection(
      () => validateForwardStructure({ ...goodRequest, gas: 0n }, context()),
      'GAS_TOO_HIGH',
    );
  });

  it('rejects an expired request', () => {
    expectRejection(
      () =>
        validateForwardStructure(
          { ...goodRequest, deadline: BigInt(Math.floor(NOW_MS / 1000) - 1) },
          context(),
        ),
      'DEADLINE_INVALID',
    );
  });

  it('rejects a deadline more than five minutes out', () => {
    expectRejection(
      () =>
        validateForwardStructure(
          { ...goodRequest, deadline: BigInt(Math.floor(NOW_MS / 1000) + 301) },
          context(),
        ),
      'DEADLINE_TOO_FAR',
    );
  });

  it('accepts a deadline exactly at the limit', () => {
    expect(() =>
      validateForwardStructure(
        { ...goodRequest, deadline: BigInt(Math.floor(NOW_MS / 1000) + 300) },
        context(),
      ),
    ).not.toThrow();
  });
});

describe('signature and nonce', () => {
  const sign = () =>
    account.signTypedData({
      domain: KURU_FORWARDER_DOMAIN,
      types: FORWARD_REQUEST_TYPES,
      primaryType: 'ForwardRequest',
      message: { ...goodRequest },
    });

  it('accepts a signature by the declared sender', async () => {
    await expect(
      validateForwardSignature(goodRequest, await sign(), context()),
    ).resolves.toBeUndefined();
  });

  it('rejects a signature over a different request', async () => {
    const signature = await sign();
    const tampered = { ...goodRequest, to: MARGIN };
    await expect(validateForwardSignature(tampered, signature, context())).rejects.toMatchObject({
      code: 'SIGNATURE_INVALID',
    });
  });

  it('rejects a request claiming someone else as `from`', async () => {
    const signature = await sign();
    const impersonated = { ...goodRequest, from: OFF_LIST };
    await expect(
      validateForwardSignature(impersonated, signature, context()),
    ).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
  });

  it('rejects a nonce the forwarder does not expect, so a signature cannot be replayed', async () => {
    const signature = await sign();
    await expect(
      validateForwardSignature(goodRequest, signature, context({ readNonce: async () => 7n })),
    ).rejects.toMatchObject({ code: 'NONCE_MISMATCH' });
  });

  it('accepts when the nonce matches the forwarder', async () => {
    const signature = await sign();
    await expect(
      validateForwardSignature(goodRequest, signature, context({ readNonce: async () => 0n })),
    ).resolves.toBeUndefined();
  });
});

describe('permits', () => {
  const base = {
    token: AUSD as string,
    owner: account.address as string,
    spender: MARGIN as string,
    value: '1000000',
    deadline: String(Math.floor(NOW_MS / 1000) + 300),
    v: 27,
    r: `0x${'11'.repeat(32)}`,
    s: `0x${'22'.repeat(32)}`,
  };

  it('accepts a permit to the MarginAccount for an exact amount', () => {
    expect(() => validatePermit(base, { marginAccount: MARGIN, now })).not.toThrow();
  });

  it('rejects any other spender', () => {
    expectRejection(
      () => validatePermit({ ...base, spender: OFF_LIST }, { marginAccount: MARGIN, now }),
      'SPENDER_NOT_MARGIN_ACCOUNT',
    );
  });

  it('rejects an infinite approval', () => {
    expectRejection(
      () =>
        validatePermit(
          { ...base, value: (2n ** 256n - 1n).toString() },
          { marginAccount: MARGIN, now },
        ),
      'PERMIT_AMOUNT_INVALID',
    );
  });

  it('rejects a zero amount', () => {
    expectRejection(
      () => validatePermit({ ...base, value: '0' }, { marginAccount: MARGIN, now }),
      'PERMIT_AMOUNT_INVALID',
    );
  });

  it('rejects a deadline beyond ten minutes', () => {
    expectRejection(
      () =>
        validatePermit(
          {
            ...base,
            deadline: String(Math.floor(NOW_MS / 1000) + MAX_PERMIT_DEADLINE_SECONDS + 1),
          },
          { marginAccount: MARGIN, now },
        ),
      'DEADLINE_TOO_FAR',
    );
  });

  it('rejects an expired permit', () => {
    expectRejection(
      () =>
        validatePermit(
          { ...base, deadline: String(Math.floor(NOW_MS / 1000) - 1) },
          { marginAccount: MARGIN, now },
        ),
      'DEADLINE_INVALID',
    );
  });
});
