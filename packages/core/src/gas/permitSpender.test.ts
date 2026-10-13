import { describe, expect, it } from 'vitest';
import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import {
  assertSponsorable,
  exemptionOf,
  MAX_SPONSORED_PERMIT_VALUE,
  MIN_SPONSORED_PERMIT_SECONDS,
  PolicyViolation,
  WMON_DEPOSIT_SELECTOR,
  WMON_WITHDRAW_SELECTOR,
} from './policy.js';
import { KURU_FLOW_ROUTER, KURU_FLOW_SELECTOR, normalizeFlowCalldata } from '../kuru/flow.js';
import { FLOW_QUOTE_AMOUNT_IN, FLOW_USDC_AUSD_RESPONSE } from '../kuru/__fixtures__/flow.js';
import { MAINNET } from '../chain/addresses.js';
import { buildDeposit, buildWithdraw } from '../kuru/orders.js';

/**
 * Who a sponsored permit may name.
 *
 * A sponsored permit is the most dangerous call this app can make: it hands somebody
 * the right to move the user's tokens, inside a batch the user approved as "move my
 * money". Rule A4 pinned the spender to the MarginAccount for exactly that reason, and
 * widening it to the Flow router (D101) is only safe because the router is a **code
 * constant** and the permit must be **paired with the swap it pays for**.
 *
 * These are the attack cases, not the happy path.
 *
 * The swap in every pairing below is the real recorded quote, byte for byte. An earlier
 * version of this file paired against a two-word stub carrying only the amount, and that
 * stub is why the first review passed: the real calldata is fourteen words, two of them
 * token addresses, and against it five of these cases came out ALLOWED. A fixture that
 * is easier to satisfy than production is worse than no fixture.
 *
 * Route length is not fixed — the recorded quote is fourteen words and live quotes taken
 * a day later were nineteen and twenty. What is stable across all four samples is where
 * the head words sit, which is the only thing this policy reads.
 */

const MARGIN = MAINNET.kuru.marginAccount as Address;
const AUSD = MAINNET.tokens.AUSD.address as Address;
const USDC = MAINNET.tokens.USDC.address as Address;
const ATTACKER = '0x00000000000000000000000000000000DeaDBeef' as Address;
const OWNER = '0x43a275C3Eb0BE7313f847FFA4fb6Bd366606A961' as Address;

/** The unedited USDC -> AUSD route: it spends FLOW_QUOTE_AMOUNT_IN of USDC. */
const REAL_SWAP = normalizeFlowCalldata(FLOW_USDC_AUSD_RESPONSE.transaction.calldata);

const permitAbi = parseAbi([
  'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
]);

const NOW = 1_788_000_000_000;
const context = { marginAccount: MARGIN, permitTokens: [AUSD, USDC], now: () => NOW };

function permit(spender: Address, value: bigint, secondsAhead = 300): Hex {
  return encodeFunctionData({
    abi: permitAbi,
    functionName: 'permit',
    args: [
      OWNER,
      spender,
      value,
      BigInt(Math.floor(NOW / 1000) + secondsAhead),
      27,
      `0x${'11'.repeat(32)}`,
      `0x${'22'.repeat(32)}`,
    ],
  });
}

/** The deposit a margin permit exists to pay for. */
const deposit = (token: Address, amount: bigint) => ({
  to: MARGIN,
  data: buildDeposit(MARGIN, OWNER, token, amount).data,
});

/** A permit to the margin account and the deposit that spends it. */
const depositBatch = (token: Address, value: bigint, moves = value) => [
  { to: token, data: permit(MARGIN, value) },
  deposit(token, moves),
];

const swapBatch = (token: Address, value: bigint) => [
  { to: token, data: permit(KURU_FLOW_ROUTER, value) },
  { to: KURU_FLOW_ROUTER, data: REAL_SWAP },
];

const reasonOf = (fn: () => void): string => {
  try {
    fn();
  } catch (error) {
    if (error instanceof PolicyViolation) return error.reason;
    // Anything else escapes the policy as a 500 on an unauthenticated route.
    return `ESCAPED: ${(error as Error).name}`;
  }
  return 'ALLOWED';
};

describe('a permit may only name one of two pinned spenders', () => {
  it('allows the margin account, as it always has', () => {
    expect(reasonOf(() => assertSponsorable(depositBatch(AUSD, 1_000_000n), context))).toBe(
      'ALLOWED',
    );
  });

  it('allows the Flow router for the exact token and amount the swap spends', () => {
    expect(reasonOf(() => assertSponsorable(swapBatch(USDC, FLOW_QUOTE_AMOUNT_IN), context))).toBe(
      'ALLOWED',
    );
  });

  it('refuses any other spender, however plausible the batch looks', () => {
    expect(
      reasonOf(() =>
        assertSponsorable([{ to: AUSD, data: permit(ATTACKER, 1_000_000n) }], context),
      ),
    ).toBe('SPENDER_NOT_ALLOWED');
  });

  it('refuses a spender the caller vouches for through the context', () => {
    // The two spenders are code constants. If the policy read the margin account from
    // its argument, a batch could name anyone by passing a matching context alongside.
    expect(
      reasonOf(() =>
        assertSponsorable([{ to: AUSD, data: permit(ATTACKER, 1_000_000n) }], {
          ...context,
          marginAccount: ATTACKER,
        }),
      ),
    ).toBe('SPENDER_NOT_ALLOWED');
  });
});

describe('a permit to the router must be paid for by the swap it names', () => {
  it('refuses a bare allowance with nothing spending it', () => {
    expect(
      reasonOf(() =>
        assertSponsorable([{ to: USDC, data: permit(KURU_FLOW_ROUTER, 1_000_000n) }], context),
      ),
    ).toBe('SPENDER_NOT_ALLOWED');
  });

  it('refuses an allowance followed by a call somewhere else', () => {
    expect(
      reasonOf(() =>
        assertSponsorable(
          [
            { to: USDC, data: permit(KURU_FLOW_ROUTER, 1_000_000n) },
            { to: ATTACKER, data: REAL_SWAP },
          ],
          context,
        ),
      ),
    ).toBe('SPENDER_NOT_ALLOWED');
  });

  it('refuses an allowance followed by a different call to the router', () => {
    expect(
      reasonOf(() =>
        assertSponsorable(
          [
            { to: USDC, data: permit(KURU_FLOW_ROUTER, 1_000_000n) },
            { to: KURU_FLOW_ROUTER, data: `0xdeadbeef${'00'.repeat(32)}` as Hex },
          ],
          context,
        ),
      ),
    ).toBe('SELECTOR_NOT_ALLOWED');
  });

  it('refuses a permit on a token the swap does not spend', () => {
    // AUSD is the swap's *output*, so it does appear in the calldata. Riding along on
    // that mention would leave a standing AUSD allowance behind a USDC swap.
    expect(reasonOf(() => assertSponsorable(swapBatch(AUSD, FLOW_QUOTE_AMOUNT_IN), context))).toBe(
      'PERMIT_TOKEN_MISMATCH',
    );
  });

  it('refuses an allowance larger than the swap it is paired with', () => {
    expect(reasonOf(() => assertSponsorable(swapBatch(USDC, 2_000_000n), context))).toBe(
      'PERMIT_AMOUNT_INVALID',
    );
  });

  it('refuses an amount that only collides with some other word of the route', () => {
    // The route's own words include two token addresses, the referrer fee, an ABI
    // offset and a couple of small integers. Read as a uint256, USDC's address is about
    // 6.7e47 - an any-word or substring match calls that "the amount the swap spends"
    // and hands the router 6.7e41 USDC of allowance off a genuine, unedited quote.
    for (const collision of [BigInt(USDC), BigInt(AUSD), 320n, 30n, 1n, 0n]) {
      expect(reasonOf(() => assertSponsorable(swapBatch(USDC, collision), context))).toBe(
        'PERMIT_AMOUNT_INVALID',
      );
    }
  });
});

describe('a permit is bounded whoever it names', () => {
  it('refuses an unlimited allowance to the margin account', () => {
    // A4 says "exact amount". Before D101 this was never checked for the margin
    // account, so permit(MAX_UINT256) travelled happily with a one-dollar deposit.
    expect(
      reasonOf(() =>
        assertSponsorable([{ to: AUSD, data: permit(MARGIN, 2n ** 256n - 1n) }], context),
      ),
    ).toBe('PERMIT_AMOUNT_INVALID');
  });

  it('refuses a zero allowance, which is never a thing to sponsor', () => {
    expect(
      reasonOf(() => assertSponsorable([{ to: AUSD, data: permit(MARGIN, 0n) }], context)),
    ).toBe('PERMIT_AMOUNT_INVALID');
  });

  it('allows exactly the cap and refuses one unit over it', () => {
    expect(
      reasonOf(() => assertSponsorable(depositBatch(AUSD, MAX_SPONSORED_PERMIT_VALUE), context)),
    ).toBe('ALLOWED');
    expect(
      reasonOf(() =>
        assertSponsorable(
          [{ to: AUSD, data: permit(MARGIN, MAX_SPONSORED_PERMIT_VALUE + 1n) }],
          context,
        ),
      ),
    ).toBe('PERMIT_AMOUNT_INVALID');
  });
});

describe('a margin permit must be paid for by its deposit', () => {
  it('refuses a permit sitting alone in the batch', () => {
    // "Exact amount" is only meaningful against something that spends it. A permit on
    // its own leaves the whole allowance standing once the batch is done.
    expect(
      reasonOf(() => assertSponsorable([{ to: AUSD, data: permit(MARGIN, 1_000_000n) }], context)),
    ).toBe('SPENDER_NOT_ALLOWED');
  });

  it('refuses a permit larger than the deposit behind it', () => {
    // $6 permitted, $1 deposited, $5 left standing.
    expect(
      reasonOf(() => assertSponsorable(depositBatch(AUSD, 6_000_000n, 1_000_000n), context)),
    ).toBe('PERMIT_AMOUNT_INVALID');
  });

  it('refuses a permit on a token the deposit does not move', () => {
    expect(
      reasonOf(() =>
        assertSponsorable(
          [{ to: AUSD, data: permit(MARGIN, 1_000_000n) }, deposit(USDC, 1_000_000n)],
          context,
        ),
      ),
    ).toBe('PERMIT_TOKEN_MISMATCH');
  });
});

describe('a swap is only sponsorable behind the permit that paid for it', () => {
  it('refuses a bare swap with no permit at all', () => {
    // The router was sponsorable on its selector alone, which made *any* route calldata
    // sponsorable — and a route with no permit in front of it spends whatever standing
    // allowance the user already has.
    expect(
      reasonOf(() => assertSponsorable([{ to: KURU_FLOW_ROUTER, data: REAL_SWAP }], context)),
    ).toBe('TARGET_NOT_ALLOWED');
  });

  it('refuses a swap behind a permit that names someone else', () => {
    expect(
      reasonOf(() =>
        assertSponsorable(
          [
            { to: USDC, data: permit(MARGIN, 1_000_000n) },
            { to: KURU_FLOW_ROUTER, data: REAL_SWAP },
          ],
          context,
        ),
      ),
    ).toBe('SPENDER_NOT_ALLOWED');
  });
});

describe('the permit window', () => {
  it('refuses a deadline beyond ten minutes', () => {
    expect(
      reasonOf(() =>
        assertSponsorable([{ to: AUSD, data: permit(MARGIN, 1_000_000n, 601) }], context),
      ),
    ).toBe('DEADLINE_TOO_FAR');
  });

  it('accepts one inside it', () => {
    expect(
      reasonOf(() =>
        assertSponsorable(
          [{ to: AUSD, data: permit(MARGIN, 1_000_000n, 599) }, deposit(AUSD, 1_000_000n)],
          context,
        ),
      ),
    ).toBe('ALLOWED');
  });

  it('refuses one that has already passed', () => {
    expect(
      reasonOf(() =>
        assertSponsorable([{ to: AUSD, data: permit(MARGIN, 1_000_000n, -1) }], context),
      ),
    ).toBe('DEADLINE_TOO_FAR');
  });

  // A permit that lapses before the bundle runs turns a funded operation into one that
  // reverts inside, and a reverted fee-paid run pays no fee (review 4, scenario G1).
  it(`refuses one with less than ${MIN_SPONSORED_PERMIT_SECONDS} seconds left to run`, () => {
    for (const secondsAhead of [1, 60, MIN_SPONSORED_PERMIT_SECONDS - 1]) {
      expect(
        reasonOf(() =>
          assertSponsorable(
            [{ to: AUSD, data: permit(MARGIN, 1_000_000n, secondsAhead) }, deposit(AUSD, 1_000_000n)],
            context,
          ),
        ),
      ).toBe('DEADLINE_TOO_SOON');
    }
  });

  it(`accepts one with exactly ${MIN_SPONSORED_PERMIT_SECONDS} seconds left`, () => {
    expect(
      reasonOf(() =>
        assertSponsorable(
          [{ to: AUSD, data: permit(MARGIN, 1_000_000n, MIN_SPONSORED_PERMIT_SECONDS) }, deposit(AUSD, 1_000_000n)],
          context,
        ),
      ),
    ).toBe('ALLOWED');
  });

  it('holds the same floor for a permit to the Flow router', () => {
    const swapWith = (secondsAhead: number) => [
      { to: USDC, data: permit(KURU_FLOW_ROUTER, FLOW_QUOTE_AMOUNT_IN, secondsAhead) },
      { to: KURU_FLOW_ROUTER, data: REAL_SWAP },
    ];
    expect(reasonOf(() => assertSponsorable(swapWith(MIN_SPONSORED_PERMIT_SECONDS - 1), context))).toBe(
      'DEADLINE_TOO_SOON',
    );
    expect(reasonOf(() => assertSponsorable(swapWith(MIN_SPONSORED_PERMIT_SECONDS), context))).toBe(
      'ALLOWED',
    );
  });
});

describe('malformed permit calldata is refused, not thrown over', () => {
  it('turns a truncated permit into a policy refusal', () => {
    // This route is unauthenticated. A raw viem error escaping the policy is a 500,
    // which reads to a caller as "the server broke" rather than "your batch was bad".
    expect(
      reasonOf(() => assertSponsorable([{ to: USDC, data: '0xd505accf1234' as Hex }], context)),
    ).toBe('PERMIT_MALFORMED');
  });

  it('turns an over-long permit into a policy refusal', () => {
    expect(
      reasonOf(() =>
        assertSponsorable(
          [{ to: USDC, data: `${permit(MARGIN, 1_000_000n)}${'00'.repeat(32)}` as Hex }],
          context,
        ),
      ),
    ).toBe('PERMIT_MALFORMED');
  });
});

describe('approve() is still never sponsorable', () => {
  it('refuses a lone approve on a permit token: only the closed triple is a shape (C1)', () => {
    const approve = encodeFunctionData({
      abi: parseAbi(['function approve(address spender, uint256 value)']),
      functionName: 'approve',
      args: [KURU_FLOW_ROUTER, 1_000_000n],
    });
    // The spender is the pinned router, but with no swap and no revoke behind it the
    // allowance would outlive the batch — exactly what the old blanket refusal was for,
    // and exactly what the triple requirement still prevents.
    expect(reasonOf(() => assertSponsorable([{ to: USDC, data: approve }], context))).toBe(
      'SPENDER_NOT_ALLOWED',
    );
  });

  it('keeps the swap selector pinned to the one Flow uses', () => {
    expect(KURU_FLOW_SELECTOR).toBe('0xce1e7030');
  });
});

/**
 * The C1 triple (owner's decision, 2026-09-25): approve(pinnedSpender, exactAmount),
 * the one spend, approve(pinnedSpender, 0). Every pairing below uses the real recorded
 * route, byte for byte, for the same reason the permit block above does — a fixture
 * easier to satisfy than production is worse than no fixture. What replaces the permit
 * path's value ceiling on tokens whose units are not dollars is the revoke: whatever
 * the route's words really meant, no allowance survives the batch.
 */
describe('the approve triple: exact, paired, and closed in the same batch (C1/D2)', () => {
  const approveData = (spender: Address, value: bigint): Hex =>
    `0x095ea7b3${spender.slice(2).toLowerCase().padStart(64, '0')}${value.toString(16).padStart(64, '0')}` as Hex;

  const triple = (token: Address, value: bigint) => [
    { to: token, data: approveData(KURU_FLOW_ROUTER, value) },
    { to: KURU_FLOW_ROUTER, data: REAL_SWAP },
    { to: token, data: approveData(KURU_FLOW_ROUTER, 0n) },
  ];

  it('allows the real swap paid by an exact approval and closed by its revoke', () => {
    expect(reasonOf(() => assertSponsorable(triple(USDC, FLOW_QUOTE_AMOUNT_IN), context))).toBe('ALLOWED');
  });

  it('refuses a token the paired swap never spends', () => {
    expect(reasonOf(() => assertSponsorable(triple(AUSD, FLOW_QUOTE_AMOUNT_IN), context))).toBe(
      'PERMIT_TOKEN_MISMATCH',
    );
  });

  it('refuses an amount that is not the amount the swap spends', () => {
    expect(reasonOf(() => assertSponsorable(triple(USDC, FLOW_QUOTE_AMOUNT_IN + 1n), context))).toBe(
      'PERMIT_AMOUNT_INVALID',
    );
  });

  it('refuses the pair without its revoke: no allowance survives the batch', () => {
    const open = triple(USDC, FLOW_QUOTE_AMOUNT_IN).slice(0, 2);
    expect(reasonOf(() => assertSponsorable(open, context))).toBe('SPENDER_NOT_ALLOWED');
  });

  it('refuses a revoke on a different token or spender than the one opened', () => {
    const wrongToken = [...triple(USDC, FLOW_QUOTE_AMOUNT_IN)];
    wrongToken[2] = { to: AUSD, data: approveData(KURU_FLOW_ROUTER, 0n) };
    expect(reasonOf(() => assertSponsorable(wrongToken, context))).toBe('SPENDER_NOT_ALLOWED');
    const wrongSpender = [...triple(USDC, FLOW_QUOTE_AMOUNT_IN)];
    wrongSpender[2] = { to: USDC, data: approveData(MARGIN, 0n) };
    expect(reasonOf(() => assertSponsorable(wrongSpender, context))).toBe('SPENDER_NOT_ALLOWED');
  });

  it('refuses an approval naming any spender but the two pinned contracts', () => {
    const rogue = [
      { to: USDC, data: approveData(ATTACKER, FLOW_QUOTE_AMOUNT_IN) },
      { to: KURU_FLOW_ROUTER, data: REAL_SWAP },
      { to: USDC, data: approveData(ATTACKER, 0n) },
    ];
    expect(reasonOf(() => assertSponsorable(rogue, context))).toBe('SPENDER_NOT_ALLOWED');
  });

  it('caps a dollar token at par and leaves an unpriced token uncapped (C2), on the margin triple', () => {
    const marginTriple = (token: Address, value: bigint) => [
      { to: token, data: approveData(MARGIN, value) },
      deposit(token, value),
      { to: token, data: approveData(MARGIN, 0n) },
    ];
    // 1,001 USDC against the $1,000 cap; exactly $1,000 is at the cap and passes.
    const overCap = MAX_SPONSORED_PERMIT_VALUE + 1_000_000n;
    expect(overCap).toBe(1_001_000_000n);
    expect(reasonOf(() => assertSponsorable(marginTriple(USDC, overCap), context))).toBe('CAP_EXCEEDED');
    expect(
      reasonOf(() => assertSponsorable(marginTriple(USDC, MAX_SPONSORED_PERMIT_VALUE), context)),
    ).toBe('ALLOWED');
    const UNPRICED = '0x00000000000000000000000000000000000000b1' as Address;
    expect(reasonOf(() => assertSponsorable(marginTriple(UNPRICED, overCap), context))).toBe('ALLOWED');
  });
});

describe('the WMON wrap: the one sponsored call that may carry value (D3)', () => {
  const WMON = MAINNET.tokens.WMON.address as Address;
  const NATIVE = '0x0000000000000000000000000000000000000000' as Address;
  const withdrawNative = (amount: bigint) => {
    const built = buildWithdraw(MARGIN, NATIVE, amount);
    return { to: built.to, data: built.data };
  };
  const wrap = (value: bigint) => ({ to: WMON, data: '0xd0e30db0' as Hex, value });

  it('allows wrapping exactly the native MON the withdrawal beside it produced', () => {
    expect(reasonOf(() => assertSponsorable([withdrawNative(5n * 10n ** 17n), wrap(5n * 10n ** 17n)], context))).toBe(
      'ALLOWED',
    );
  });

  it('allows the wrap alone as the whole action: MON to WMON (rule 1.8, owner 2026-09-29)', () => {
    // Changed on purpose: before rule 1.8 a lone wrap was refused. It moves the
    // account's own MON into its own WMON; the 10 MON reserve is Monad's to enforce.
    expect(reasonOf(() => assertSponsorable([wrap(1n)], context))).toBe('ALLOWED');
    expect(exemptionOf([wrap(1n)], MARGIN)).toBeUndefined();
  });

  it('refuses a wrap anywhere but first, a zero wrap, and a wrap followed by anything but its swap', () => {
    const withdrawUsdc0 = buildWithdraw(MARGIN, USDC, 1_000_000n);
    const send = { to: USDC, data: `0xa9059cbb${'1'.padStart(64, '0')}${'1'.padStart(64, '0')}` as Hex };
    expect(reasonOf(() => assertSponsorable([send, wrap(1n)], context))).toBe('VALUE_NOT_ZERO');
    expect(reasonOf(() => assertSponsorable([wrap(1n), send], context))).toBe('VALUE_NOT_ZERO');
    expect(
      reasonOf(() => assertSponsorable([wrap(1n), { to: withdrawUsdc0.to, data: withdrawUsdc0.data }], context)),
    ).toBe('VALUE_NOT_ZERO');
  });

  it('refuses the wrap after the wrong withdrawal, or for the wrong amount', () => {
    const withdrawUsdc = buildWithdraw(MARGIN, USDC, 1_000_000n);
    expect(
      reasonOf(() => assertSponsorable([{ to: withdrawUsdc.to, data: withdrawUsdc.data }, wrap(1_000_000n)], context)),
    ).toBe('VALUE_NOT_ZERO');
    expect(
      reasonOf(() => assertSponsorable([withdrawNative(2n), wrap(1n)], context)),
    ).toBe('VALUE_NOT_ZERO');
  });

  it('still refuses value on anything that is not the wrap, word for word', () => {
    expect(reasonOf(() => assertSponsorable([{ to: USDC, data: '0xd0e30db0' as Hex, value: 1n }], context))).toBe(
      'VALUE_NOT_ZERO',
    );
  });
});

describe("exemptionOf: swapping into the gas token never counts (B3), other swaps do", () => {
  const WMON = MAINNET.tokens.WMON.address as Address;
  const approveData = (spender: Address, value: bigint): Hex =>
    `0x095ea7b3${spender.slice(2).toLowerCase().padStart(64, '0')}${value.toString(16).padStart(64, '0')}` as Hex;
  /** REAL_SWAP with its tokenOut head word rewritten to WMON — layout untouched. */
  const swapToWmon = (`0x${REAL_SWAP.slice(2, 10)}${WMON.slice(2).toLowerCase().padStart(64, '0')}${REAL_SWAP.slice(74)}`) as Hex;

  it('a WMON-out swap group, permit- or approve-paid, is exempt as swap-into-mon', () => {
    expect(
      exemptionOf(
        [
          { to: USDC, data: approveData(KURU_FLOW_ROUTER, FLOW_QUOTE_AMOUNT_IN) },
          { to: KURU_FLOW_ROUTER, data: swapToWmon },
          { to: USDC, data: approveData(KURU_FLOW_ROUTER, 0n) },
        ],
        MARGIN,
      ),
    ).toBe('swap-into-mon');
    expect(
      exemptionOf(
        [
          { to: USDC, data: permit(KURU_FLOW_ROUTER, FLOW_QUOTE_AMOUNT_IN) },
          { to: KURU_FLOW_ROUTER, data: swapToWmon },
        ],
        MARGIN,
      ),
    ).toBe('swap-into-mon');
  });

  it('the same group delivering anything else is a counted, ordinary swap', () => {
    expect(
      exemptionOf(
        [
          { to: USDC, data: approveData(KURU_FLOW_ROUTER, FLOW_QUOTE_AMOUNT_IN) },
          { to: KURU_FLOW_ROUTER, data: REAL_SWAP },
          { to: USDC, data: approveData(KURU_FLOW_ROUTER, 0n) },
        ],
        MARGIN,
      ),
    ).toBeUndefined();
  });

  it('the withdraw-and-wrap pair is own-funds, like the withdrawal it is made of (D3/B1)', () => {
    const built = buildWithdraw(MARGIN, '0x0000000000000000000000000000000000000000' as Address, 7n);
    expect(
      exemptionOf(
        [{ to: built.to, data: built.data }, { to: WMON, data: '0xd0e30db0' as Hex, value: 7n }],
        MARGIN,
      ),
    ).toBe('own-funds');
  });
});

/**
 * The unwrap leg (B3): a swap into MON delivers WMON from the router, and the batch
 * may end with `WMON.withdraw(amount)` so the account holds actual native MON — the
 * only token that can pay gas on the own-MON lane. The wrapper sends native to the
 * caller and nobody else, so the call spends the account's own WMON into its own
 * wallet; what the policy pins is WHERE it may appear: directly after the Flow swap
 * that delivered WMON (the triple's closing revoke may sit between).
 */
describe('the WMON unwrap: native delivery of a swap into MON (B3)', () => {
  const WMON = MAINNET.tokens.WMON.address as Address;
  const approveData = (spender: Address, value: bigint): Hex =>
    `0x095ea7b3${spender.slice(2).toLowerCase().padStart(64, '0')}${value.toString(16).padStart(64, '0')}` as Hex;
  const swapToWmon = (`0x${REAL_SWAP.slice(2, 10)}${WMON.slice(2).toLowerCase().padStart(64, '0')}${REAL_SWAP.slice(74)}`) as Hex;
  const unwrap = (amount: bigint) =>
    ({ to: WMON, data: `0x2e1a7d4d${amount.toString(16).padStart(64, '0')}` as Hex });

  it('allows the unwrap after a WMON-out swap, permit- or triple-paid, and the group stays swap-into-mon', () => {
    const permitPaid = [
      { to: USDC, data: permit(KURU_FLOW_ROUTER, FLOW_QUOTE_AMOUNT_IN) },
      { to: KURU_FLOW_ROUTER, data: swapToWmon },
      unwrap(11n * 10n ** 18n),
    ];
    expect(reasonOf(() => assertSponsorable(permitPaid, context))).toBe('ALLOWED');
    expect(exemptionOf(permitPaid, MARGIN)).toBe('swap-into-mon');

    const triplePaid = [
      { to: USDC, data: approveData(KURU_FLOW_ROUTER, FLOW_QUOTE_AMOUNT_IN) },
      { to: KURU_FLOW_ROUTER, data: swapToWmon },
      { to: USDC, data: approveData(KURU_FLOW_ROUTER, 0n) },
      unwrap(11n * 10n ** 18n),
    ];
    expect(reasonOf(() => assertSponsorable(triplePaid, context))).toBe('ALLOWED');
    expect(exemptionOf(triplePaid, MARGIN)).toBe('swap-into-mon');
  });

  it('allows the unwrap alone as the whole action: WMON to MON (rule 1.8, owner 2026-09-29)', () => {
    // Changed on purpose: before rule 1.8 a lone unwrap was refused.
    expect(reasonOf(() => assertSponsorable([unwrap(1n)], context))).toBe('ALLOWED');
  });

  it('refuses an unwrap after a swap that delivered anything else, or after any other call', () => {
    const send = { to: USDC, data: `0xa9059cbb${'1'.padStart(64, '0')}${'1'.padStart(64, '0')}` as Hex };
    expect(reasonOf(() => assertSponsorable([send, unwrap(1n)], context))).toBe('SELECTOR_NOT_ALLOWED');
    const afterUsdcSwap = [
      { to: USDC, data: permit(KURU_FLOW_ROUTER, FLOW_QUOTE_AMOUNT_IN) },
      { to: KURU_FLOW_ROUTER, data: REAL_SWAP },
      unwrap(1n),
    ];
    expect(reasonOf(() => assertSponsorable(afterUsdcSwap, context))).toBe('SELECTOR_NOT_ALLOWED');
  });

  it('refuses a zero or malformed amount, and the selector on any other token', () => {
    const zero = [
      { to: USDC, data: permit(KURU_FLOW_ROUTER, FLOW_QUOTE_AMOUNT_IN) },
      { to: KURU_FLOW_ROUTER, data: swapToWmon },
      unwrap(0n),
    ];
    expect(reasonOf(() => assertSponsorable(zero, context))).toBe('SELECTOR_NOT_ALLOWED');
    expect(
      reasonOf(() =>
        assertSponsorable([{ to: USDC, data: `0x2e1a7d4d${'1'.padStart(64, '0')}` as Hex }], context),
      ),
    ).toBe('SELECTOR_NOT_ALLOWED');
  });

  it('a lone unwrap is a swap into MON (rule 1.8 with B1); an unwrap before a swap never makes a group exempt', () => {
    // Changed on purpose: WMON to MON is now its own action, and B1 says swapping into
    // MON never counts. Anything more than the lone unwrap still needs the swap first.
    expect(exemptionOf([unwrap(1n)], MARGIN)).toBe('swap-into-mon');
    expect(
      exemptionOf(
        [unwrap(1n), { to: USDC, data: `0xa9059cbb${'1'.padStart(64, '0')}${'1'.padStart(64, '0')}` as Hex }],
        MARGIN,
      ),
    ).toBeUndefined();
  });

  it('pins the verified WMON facts the wrap and unwrap rules rest on (chain-reader, block 107,885,456)', () => {
    // Verified 2026-09-25 against MonadScan's exact-match source (verbatim WETH9,
    // solc 0.5.17), an independent recompile byte-identical over all executable
    // bytes, and live traces: deposit() credits msg.sender with exactly msg.value,
    // withdraw(wad) sends exactly wad of native MON to msg.sender and nobody else
    // (2300-gas stipend; our delegate's receive uses 38), no fee, no hook, no
    // proxy, no other external call in the runtime.
    expect(MAINNET.tokens.WMON.address).toBe('0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A');
    expect(WMON_DEPOSIT_SELECTOR).toBe('0xd0e30db0');
    expect(WMON_WITHDRAW_SELECTOR).toBe('0x2e1a7d4d');
  });
});
