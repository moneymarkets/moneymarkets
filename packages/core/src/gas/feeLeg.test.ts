import { describe, expect, it } from 'vitest';
import { encodeFunctionData, getAddress, parseAbi, type Address, type Hex } from 'viem';
import { MAINNET } from '../chain/addresses.js';
import { MON_USDC_MARKET, MON_USDC_PARAMS } from '../kuru/__fixtures__/logs.js';
import {
  FLOW_QUOTE_AMOUNT_IN,
  FLOW_QUOTE_USER,
  FLOW_USDC_AUSD_RESPONSE,
} from '../kuru/__fixtures__/flow.js';
import { KURU_FLOW_ROUTER, normalizeFlowCalldata } from '../kuru/flow.js';
import {
  buildCancelOrders,
  buildDeposit,
  buildErc20Transfer,
  buildMarketOrder,
  buildWithdraw,
} from '../kuru/orders.js';
import type { SponsoredCall } from './account.js';
import { buildFeeLeg, MAX_GAS_FEE } from './gasFee.js';
import {
  assertSponsorable,
  exemptionOf,
  isSendOrWithdraw,
  marginDepositsTo,
  PolicyViolation,
  splitFeeLeg,
  type PolicyContext,
} from './policy.js';

/**
 * The fee leg: the first transfer this sponsorship policy lets a batch make to the
 * relayer itself.
 *
 * Every call below is built by the builders production uses (the ticket's market order,
 * the withdraw screen's `buildWithdraw`, the send screen's `buildErc20Transfer`, and
 * `buildFeeLeg`, which is those two), and every attack is an edit of that real encoding,
 * never a hand-assembled lookalike. These are the attack cases first; the happy path is
 * one test.
 */

const MARGIN = MAINNET.kuru.marginAccount as Address;
const USDC = MAINNET.tokens.USDC.address as Address;
const AUSD = MAINNET.tokens.AUSD.address as Address;
const USDT0 = MAINNET.tokens.USDT0.address as Address;
/** The relayer's fee address in these tests. A throwaway: it holds nothing. */
const FEE_TO = getAddress('0x000000000000000000000000000000000000fee5');
const SOMEONE = '0x43a275C3Eb0BE7313f847FFA4fb6Bd366606A961' as Address;
const OWNER = '0x43a275C3Eb0BE7313f847FFA4fb6Bd366606A961' as Address;

/** A $1 market buy on MON/USDC, exactly as the ticket builds one. */
const order: SponsoredCall = (() => {
  const built = buildMarketOrder({
    market: MON_USDC_MARKET,
    params: MON_USDC_PARAMS,
    side: 'buy',
    amount: 1_000_000n,
    minAmountOut: 0n,
  });
  return { to: built.to, data: built.data, value: 0n };
})();
const cancel: SponsoredCall = (() => {
  const built = buildCancelOrders(MON_USDC_MARKET, [42n]);
  return { to: built.to, data: built.data, value: 0n };
})();

const FEE = 5_000n;
const leg = (token: Address = USDC, amount: bigint = FEE, to: Address = FEE_TO) =>
  [...buildFeeLeg(MARGIN, token, to, amount)] as SponsoredCall[];

const context = (expected: NonNullable<PolicyContext['gasFee']>['expected']): PolicyContext => ({
  marginAccount: MARGIN,
  permitTokens: [AUSD, USDC],
  gasFee: { recipient: FEE_TO, expected },
});
const charged = (token: Address = USDC, amount: bigint = FEE) => context({ token, amount });

const reasonOf = (fn: () => void): string => {
  try {
    fn();
  } catch (error) {
    if (error instanceof PolicyViolation) return error.reason;
    return `ESCAPED: ${(error as Error).name}`;
  }
  return 'ALLOWED';
};

/** Replace one 32-byte argument word of a call's calldata. */
function withWord(call: SponsoredCall, index: number, word: string): SponsoredCall {
  const start = 10 + index * 64;
  const data = `${call.data.slice(0, start)}${word}${call.data.slice(start + 64)}` as Hex;
  return { ...call, data };
}
const uint = (v: bigint) => v.toString(16).padStart(64, '0');
const addr = (a: Address) => a.toLowerCase().slice(2).padStart(64, '0');

describe('the one batch a fee leg is sponsored in', () => {
  it('an action followed by exactly the fee the relayer computed', () => {
    expect(reasonOf(() => assertSponsorable([order, ...leg()], charged()))).toBe('ALLOWED');
    expect(splitFeeLeg([order, ...leg()], MARGIN, FEE_TO)).toEqual({
      actions: [order],
      feeLeg: { token: USDC, amount: FEE },
    });
  });

  it('paid in AUSD when that is what the relayer computed', () => {
    expect(reasonOf(() => assertSponsorable([order, ...leg(AUSD)], charged(AUSD)))).toBe(
      'ALLOWED',
    );
  });
});

describe('a mismatched fee refuses the whole batch, not just the fee', () => {
  it('one base unit more than computed', () => {
    expect(reasonOf(() => assertSponsorable([order, ...leg(USDC, FEE + 1n)], charged()))).toBe(
      'FEE_LEG_MISMATCH',
    );
  });

  it('one base unit less than computed', () => {
    expect(reasonOf(() => assertSponsorable([order, ...leg(USDC, FEE - 1n)], charged()))).toBe(
      'FEE_LEG_MISMATCH',
    );
  });

  it('the right amount in the other token', () => {
    expect(reasonOf(() => assertSponsorable([order, ...leg(AUSD)], charged(USDC)))).toBe(
      'FEE_LEG_MISMATCH',
    );
  });

  it('withdraws more than it pays, leaving the difference in the wallet', () => {
    const [withdraw, transfer] = leg();
    const bigger = withWord(withdraw!, 0, uint(FEE * 1000n));
    expect(reasonOf(() => assertSponsorable([order, bigger, transfer!], charged()))).toBe(
      'FEE_LEG_MISMATCH',
    );
  });

  it('withdraws one token and pays in the other', () => {
    const [withdraw] = leg(AUSD);
    const [, transfer] = leg(USDC);
    expect(reasonOf(() => assertSponsorable([order, withdraw!, transfer!], charged()))).toBe(
      'FEE_LEG_MISMATCH',
    );
  });

  it('the refusal is the whole batch: the action is not sponsored without its fee either', () => {
    // A charged batch that drops its fee leg is refused, rather than sponsored for free.
    expect(reasonOf(() => assertSponsorable([order], charged()))).toBe('FEE_LEG_MISMATCH');
  });
});

describe('the fee goes to the pinned address and nowhere else', () => {
  it('a fee leg paying any other address is not a fee, so the charged batch has none', () => {
    expect(reasonOf(() => assertSponsorable([order, ...leg(USDC, FEE, SOMEONE)], charged()))).toBe(
      'FEE_LEG_MISMATCH',
    );
  });

  it('the recipient comes from the context the relayer builds, never from the batch', () => {
    // The same batch, checked against a context naming SOMEONE as recipient, is the only
    // way SOMEONE is a fee recipient, and the relayer never builds that context.
    expect(
      reasonOf(() =>
        assertSponsorable([order, ...leg(USDC, FEE, SOMEONE)], {
          ...charged(),
          gasFee: { recipient: SOMEONE, expected: { token: USDC, amount: FEE } },
        }),
      ),
    ).toBe('ALLOWED');
  });

  it('a recipient word with dirt above the address is refused, not read past', () => {
    const [withdraw, transfer] = leg();
    const dirty = withWord(transfer!, 0, `ff${addr(FEE_TO).slice(2)}`);
    expect(reasonOf(() => assertSponsorable([order, withdraw!, dirty], charged()))).toBe(
      'FEE_LEG_MISMATCH',
    );
  });

  it('a margin deposit crediting the fee address is refused: it pays the relayer by another road', () => {
    const credit = { to: MARGIN, data: buildDeposit(MARGIN, FEE_TO, USDC, 1_000_000n).data };
    expect(reasonOf(() => assertSponsorable([order, credit], context('none')))).toBe(
      'FEE_LEG_MISMATCH',
    );
    expect(reasonOf(() => assertSponsorable([order, credit, ...leg()], charged()))).toBe(
      'FEE_LEG_MISMATCH',
    );
  });
});

describe('a payment to the relayer with no computed fee behind it is refused', () => {
  it('a plain send to the fee address, standing alone', () => {
    const send = buildErc20Transfer(USDC, FEE_TO, FEE);
    expect(reasonOf(() => assertSponsorable([{ to: send.to, data: send.data }], context('none')))).toBe(
      'FEE_LEG_MISMATCH',
    );
  });

  it('the fee leg standing alone, even against a computed fee: it pays for nothing', () => {
    expect(reasonOf(() => assertSponsorable(leg(), context('none')))).toBe('FEE_LEG_MISMATCH');
    expect(reasonOf(() => assertSponsorable(leg(), charged()))).toBe('FEE_LEG_MISMATCH');
  });

  it('a well-formed fee leg on a batch the relayer is not charging', () => {
    expect(reasonOf(() => assertSponsorable([order, ...leg()], context('none')))).toBe(
      'FEE_LEG_MISMATCH',
    );
  });

  it('a send to the fee address riding along with an order', () => {
    const send = buildErc20Transfer(USDC, FEE_TO, 1_000_000n);
    expect(
      reasonOf(() => assertSponsorable([order, { to: send.to, data: send.data }], context('none'))),
    ).toBe('FEE_LEG_MISMATCH');
  });
});

describe('the fee leg has one shape', () => {
  it('last, not first', () => {
    expect(reasonOf(() => assertSponsorable([...leg(), order], charged()))).toBe(
      'FEE_LEG_MISMATCH',
    );
  });

  it('once, not twice', () => {
    expect(reasonOf(() => assertSponsorable([order, ...leg(), order, ...leg()], charged()))).toBe(
      'FEE_LEG_MISMATCH',
    );
  });

  it('from the trading balance: a transfer from the wallet with no withdraw in front is refused', () => {
    const [, transfer] = leg();
    expect(reasonOf(() => assertSponsorable([order, cancel, transfer!], charged()))).toBe(
      'FEE_LEG_MISMATCH',
    );
  });

  it('in USDC or AUSD only', () => {
    const withdraw = buildWithdraw(MARGIN, USDT0, FEE);
    const transfer = buildErc20Transfer(USDT0, FEE_TO, FEE);
    const batch = [order, { to: withdraw.to, data: withdraw.data }, { to: transfer.to, data: transfer.data }];
    expect(reasonOf(() => assertSponsorable(batch, context('unpriced')))).toBe('FEE_LEG_MISMATCH');
  });

  it('never zero, never over the ceiling, even when the relayer is not yet pricing it', () => {
    expect(reasonOf(() => assertSponsorable([order, ...leg(USDC, MAX_GAS_FEE)], context('unpriced')))).toBe(
      'ALLOWED',
    );
    expect(
      reasonOf(() => assertSponsorable([order, ...leg(USDC, MAX_GAS_FEE + 1n)], context('unpriced'))),
    ).toBe('FEE_LEG_MISMATCH');
    const [withdraw, transfer] = leg();
    const zero = [order, withWord(withdraw!, 0, uint(0n)), withWord(transfer!, 1, uint(0n))];
    expect(reasonOf(() => assertSponsorable(zero, context('unpriced')))).toBe('FEE_LEG_MISMATCH');
  });

  it('the ceiling holds against an exact expectation too: the relayer cannot authorise more', () => {
    expect(
      reasonOf(() =>
        assertSponsorable([order, ...leg(USDC, MAX_GAS_FEE + 1n)], charged(USDC, MAX_GAS_FEE + 1n)),
      ),
    ).toBe('FEE_LEG_MISMATCH');
  });

  it('nothing trailing the transfer’s two words', () => {
    const [withdraw, transfer] = leg();
    const padded = { ...transfer!, data: `${transfer!.data}${uint(1n)}` as Hex };
    expect(reasonOf(() => assertSponsorable([order, withdraw!, padded], charged()))).toBe(
      'FEE_LEG_MISMATCH',
    );
  });

  it('an estimate of a charged batch still needs its fee leg, of any bounded amount', () => {
    expect(reasonOf(() => assertSponsorable([order], context('unpriced')))).toBe('FEE_LEG_MISMATCH');
    expect(reasonOf(() => assertSponsorable([order, ...leg(USDC, 1n)], context('unpriced')))).toBe(
      'ALLOWED',
    );
  });

  it('the rest of the batch is still the ordinary policy: a fee does not buy a forbidden call', () => {
    const bad = { to: SOMEONE, data: order.data };
    expect(reasonOf(() => assertSponsorable([bad, ...leg()], charged()))).toBe('TARGET_NOT_ALLOWED');
  });
});

describe('what is a send or a withdraw of the user’s own funds', () => {
  const withdraw = (() => {
    const w = buildWithdraw(MARGIN, USDC, 1_000_000n);
    return { to: w.to, data: w.data };
  })();
  const send = (() => {
    const t = buildErc20Transfer(USDC, SOMEONE, 1_000_000n);
    return { to: t.to, data: t.data };
  })();
  const deposit = { to: MARGIN, data: buildDeposit(MARGIN, OWNER, USDC, 1_000_000n).data };

  it('the withdraw screen’s batch and the send screen’s batch', () => {
    expect(isSendOrWithdraw([withdraw], MARGIN)).toBe(true);
    expect(isSendOrWithdraw([send], MARGIN)).toBe(true);
    expect(isSendOrWithdraw([withdraw, send], MARGIN)).toBe(true);
  });

  it('nothing else: an order, a cancel, a deposit, or any of them riding with a withdraw', () => {
    expect(isSendOrWithdraw([order], MARGIN)).toBe(false);
    expect(isSendOrWithdraw([cancel], MARGIN)).toBe(false);
    expect(isSendOrWithdraw([deposit], MARGIN)).toBe(false);
    expect(isSendOrWithdraw([withdraw, order], MARGIN)).toBe(false);
    expect(isSendOrWithdraw([send, cancel], MARGIN)).toBe(false);
    expect(isSendOrWithdraw([], MARGIN)).toBe(false);
  });

  it('a transfer on any token is a send (any-token wallet, D1; pinned three before 2026-09-25)', () => {
    const other = { to: SOMEONE, data: send.data };
    expect(isSendOrWithdraw([other], MARGIN)).toBe(true);
  });
});

describe('D168: the fee address receives the exact verified fee leg of a charging batch, and nothing else', () => {
  /** The unedited recorded Flow route; its word 6 is the quote's referrerAddress (30 bps). */
  const REAL_SWAP = normalizeFlowCalldata(FLOW_USDC_AUSD_RESPONSE.transaction.calldata);
  const NOW = 1_788_000_000_000;
  const permitAbi = parseAbi([
    'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
  ]);
  const permit = (spender: Address, value: bigint): SponsoredCall => ({
    to: USDC,
    data: encodeFunctionData({
      abi: permitAbi,
      functionName: 'permit',
      args: [OWNER, spender, value, BigInt(Math.floor(NOW / 1000) + 300), 27, `0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`],
    }),
  });
  const at = (expected: NonNullable<PolicyContext['gasFee']>['expected']): PolicyContext => ({
    ...context(expected),
    now: () => NOW,
  });

  it('the real Flow route pays a referral fee to whoever it names; naming the fee address is refused', () => {
    const swap = (data: Hex): SponsoredCall[] => [
      permit(KURU_FLOW_ROUTER, FLOW_QUOTE_AMOUNT_IN),
      { to: KURU_FLOW_ROUTER, data },
    ];
    // The recorded route, unedited, is sponsorable: the referrer is the user.
    expect(reasonOf(() => assertSponsorable(swap(REAL_SWAP), at('none')))).toBe('ALLOWED');
    expect(REAL_SWAP.toLowerCase()).toContain(addr(FLOW_QUOTE_USER).slice(24));
    // The same bytes with the referrer set to the relayer's fee address.
    const toRelayer = REAL_SWAP.toLowerCase().replace(
      addr(FLOW_QUOTE_USER).slice(24),
      addr(FEE_TO).slice(24),
    ) as Hex;
    expect(toRelayer).not.toBe(REAL_SWAP.toLowerCase());
    for (const expected of ['none', 'unpriced'] as const) {
      expect(reasonOf(() => assertSponsorable(swap(toRelayer), at(expected)))).toBe('FEE_LEG_MISMATCH');
    }
    // Riding in front of a correct fee leg on a charging batch does not launder it either.
    expect(
      reasonOf(() => assertSponsorable([...swap(toRelayer), ...leg()], at({ token: USDC, amount: FEE }))),
    ).toBe('FEE_LEG_MISMATCH');
  });

  it('every other shape a payment to the fee address could take is refused', () => {
    const send = buildErc20Transfer(USDC, FEE_TO, FEE);
    const toRelayer = { to: send.to, data: send.data };
    const credit = { to: MARGIN, data: buildDeposit(MARGIN, FEE_TO, USDC, FEE).data };
    const [withdraw, transfer] = leg();
    const shapes: Array<[string, SponsoredCall[], NonNullable<PolicyContext['gasFee']>['expected']]> = [
      ['a standalone transfer', [toRelayer], 'none'],
      ['a transfer riding with an order', [order, toRelayer], 'none'],
      ['the same on a charging batch', [order, toRelayer], { token: USDC, amount: FEE }],
      ['a fee leg on a batch that is not charged', [order, ...leg()], 'none'],
      ['the fee leg alone', leg(), { token: USDC, amount: FEE }],
      ['a second payment beside the fee leg', [order, toRelayer, ...leg()], { token: USDC, amount: FEE }],
      ['the fee leg first', [...leg(), order], { token: USDC, amount: FEE }],
      ['one unit more than computed', [order, ...leg(USDC, FEE + 1n)], { token: USDC, amount: FEE }],
      ['the right amount in USDT0', [order, ...leg(USDT0)], 'unpriced'],
      ['a transfer from the wallet, no withdraw', [order, cancel, transfer!], { token: USDC, amount: FEE }],
      ['a margin deposit crediting it', [order, credit], 'none'],
      ['a permit naming it as spender', [permit(FEE_TO, FEE), order], 'none'],
      ['a call to it', [order, { to: FEE_TO, data: order.data }], 'none'],
      ['control: the exact verified fee leg of a charging batch', [order, withdraw!, transfer!], { token: USDC, amount: FEE }],
    ];
    for (const [name, calls, expected] of shapes.slice(0, -1)) {
      expect(reasonOf(() => assertSponsorable(calls, at(expected))), name).toBe('FEE_LEG_MISMATCH');
    }
    // The last row is the one allowed shape, as the control.
    const [name, calls, expected] = shapes[shapes.length - 1]!;
    expect(reasonOf(() => assertSponsorable(calls, at(expected))), name).toBe('ALLOWED');
  });
});

describe('review 2: every relayer address is forbidden, not only the one fees go to today', () => {
  const HOT = getAddress('0x000000000000000000000000000000000000beef');
  const REAL_SWAP = normalizeFlowCalldata(FLOW_USDC_AUSD_RESPONSE.transaction.calldata);
  const NOW = 1_788_000_000_000;
  const permit = encodeFunctionData({
    abi: parseAbi([
      'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
    ]),
    functionName: 'permit',
    args: [OWNER, KURU_FLOW_ROUTER, FLOW_QUOTE_AMOUNT_IN, BigInt(Math.floor(NOW / 1000) + 300), 27, `0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`],
  });
  const swapReferring = (who: Address): SponsoredCall[] => [
    { to: USDC, data: permit },
    {
      to: KURU_FLOW_ROUTER,
      data: REAL_SWAP.toLowerCase().replace(addr(FLOW_QUOTE_USER).slice(24), addr(who).slice(24)) as Hex,
    },
  ];
  // After D169's checklist: fees to FEE_TO, the relayer still signing as HOT.
  const moved = (expected: NonNullable<PolicyContext['gasFee']>['expected']): PolicyContext => ({
    ...context(expected),
    now: () => NOW,
    relayerAddresses: [HOT, FEE_TO],
  });

  it('the hot key, once it is no longer the fee address, is refused wherever it appears', () => {
    const send = buildErc20Transfer(USDC, HOT, FEE);
    const credit = { to: MARGIN, data: buildDeposit(MARGIN, HOT, USDC, FEE).data };
    for (const calls of [
      [{ to: send.to, data: send.data }],
      [order, credit],
      swapReferring(HOT),
      [order, { to: HOT, data: order.data }],
      [{ to: send.to, data: send.data }, order, ...leg()], // riding in a charging batch
    ]) {
      expect(reasonOf(() => assertSponsorable(calls, moved('none')))).toBe('FEE_LEG_MISMATCH');
    }
    expect(reasonOf(() => assertSponsorable([{ to: send.to, data: send.data }, order, ...leg()], moved({ token: USDC, amount: FEE })))).toBe('FEE_LEG_MISMATCH');
  });

  it('the fee leg to the fee address, and the real swap referring its user, still pass', () => {
    expect(reasonOf(() => assertSponsorable([order, ...leg()], moved({ token: USDC, amount: FEE })))).toBe('ALLOWED');
    expect(reasonOf(() => assertSponsorable(swapReferring(FLOW_QUOTE_USER), moved('none')))).toBe('ALLOWED');
  });

  it('with no fee context at all, both relayer addresses are still refused everywhere', () => {
    const bare = { marginAccount: MARGIN, permitTokens: [AUSD, USDC], relayerAddresses: [HOT, FEE_TO], now: () => NOW };
    expect(reasonOf(() => assertSponsorable(swapReferring(HOT), bare))).toBe('FEE_LEG_MISMATCH');
    expect(reasonOf(() => assertSponsorable([order, ...leg()], bare))).toBe('FEE_LEG_MISMATCH');
    expect(reasonOf(() => assertSponsorable([order], bare))).toBe('ALLOWED');
  });

  it('while fees still go to the hot key (D169 today), its fee leg passes and every other mention does not', () => {
    const today = (expected: NonNullable<PolicyContext['gasFee']>['expected']): PolicyContext => ({
      marginAccount: MARGIN,
      permitTokens: [AUSD, USDC],
      gasFee: { recipient: HOT, expected },
      relayerAddresses: [HOT],
      now: () => NOW,
    });
    expect(reasonOf(() => assertSponsorable([order, ...leg(USDC, FEE, HOT)], today({ token: USDC, amount: FEE })))).toBe('ALLOWED');
    expect(reasonOf(() => assertSponsorable(swapReferring(HOT), today('none')))).toBe('FEE_LEG_MISMATCH');
  });
});

describe('F3: a cancel is exempt from counting and charging, like a send or a withdraw', () => {
  const withdraw = (() => {
    const w = buildWithdraw(MARGIN, USDC, 1_000_000n);
    return { to: w.to, data: w.data };
  })();
  it('cancels, alone or with the user’s own funds moving out', () => {
    expect(exemptionOf([cancel], MARGIN)).toBe('cancel');
    expect(exemptionOf([cancel, cancel], MARGIN)).toBe('cancel');
    expect(exemptionOf([cancel, withdraw], MARGIN)).toBe('cancel');
    expect(exemptionOf([withdraw], MARGIN)).toBe('own-funds');
  });
  it('never with an order, a deposit, or anything else', () => {
    const deposit = { to: MARGIN, data: buildDeposit(MARGIN, OWNER, USDC, 1_000_000n).data };
    expect(exemptionOf([cancel, order], MARGIN)).toBeUndefined();
    expect(exemptionOf([cancel, deposit], MARGIN)).toBeUndefined();
    // The cancel selector on the MarginAccount is not a cancel. (On a token address it
    // is not a transfer either, and stays unclassified — no branch claims it.)
    expect(exemptionOf([{ to: MARGIN, data: cancel.data }], MARGIN)).toBeUndefined();
    expect(exemptionOf([{ to: USDC, data: cancel.data }], MARGIN)).toBeUndefined();
    expect(isSendOrWithdraw([cancel], MARGIN)).toBe(false);
  });
});

describe('what a batch deposits for its own sender first counts toward paying its fee', () => {
  it('sums the batch’s deposits crediting the sender, per token, and nothing else', () => {
    const toMe = (token: Address, amount: bigint) => ({
      to: MARGIN,
      data: buildDeposit(MARGIN, OWNER, token, amount).data,
    });
    const toSomeoneElse = { to: MARGIN, data: buildDeposit(MARGIN, FEE_TO, USDC, 9_000_000n).data };
    const notTheMargin = { to: SOMEONE, data: buildDeposit(MARGIN, OWNER, USDC, 9_000_000n).data };
    const credited = marginDepositsTo(
      [toMe(USDC, 1_000_000n), toMe(USDC, 250_000n), toMe(AUSD, 3_000n), toSomeoneElse, notTheMargin, order],
      MARGIN,
      OWNER,
    );
    expect(credited.get(USDC.toLowerCase())).toBe(1_250_000n);
    expect(credited.get(AUSD.toLowerCase())).toBe(3_000n);
    expect(credited.size).toBe(2);
  });
});

describe('with no fee context, nothing about a fee is recognised (the relayer always passes one)', () => {
  it('a transfer to what would be the fee address is judged as an ordinary send', () => {
    const send = buildErc20Transfer(USDC, FEE_TO, FEE);
    expect(
      reasonOf(() =>
        assertSponsorable([{ to: send.to, data: send.data }], { marginAccount: MARGIN, permitTokens: [AUSD, USDC] }),
      ),
    ).toBe('ALLOWED');
  });
});
