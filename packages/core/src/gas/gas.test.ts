import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { entryPoint08Address } from 'viem/account-abstraction';
import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import {
  delegateOf,
  delegationCodeFor,
  DELEGATION_PREFIX,
  ENTRY_POINT_V07,
  ENTRY_POINT_V08,
  EVALUATED_DELEGATES,
  MONAD_DELEGATED_RESERVE_WEI,
  pimlicoUrl,
  SIMPLE_7702_DELEGATE,
  violatesDelegatedReserve,
} from './delegate.js';
import { assertSponsorable, isSponsorable, PERMIT_SELECTOR, PolicyViolation } from './policy.js';
import { didNotSend, GAS_LAYER_PROVEN, isUnproven, submit, type SubmitRequest } from './submit.js';
import { MAX_ORDER_NOTIONAL_AUSD } from '../chain/caps.js';
import type { ModeGate } from '../chain/mode.js';
import {
  buildCancelOrders,
  buildDeposit,
  buildLimitOrder,
  buildMarketOrder,
} from '../kuru/orders.js';
import { MON_AUSD_MARKET, MON_AUSD_PARAMS } from '../kuru/__fixtures__/books.js';
import { MON_USDC_MARKET, MON_USDC_PARAMS } from '../kuru/__fixtures__/logs.js';

const MARGIN = '0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5' as Address;
const AUSD = '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a' as Address;
const USER = '0x1111111111111111111111111111111111111111' as Address;

const context = { marginAccount: MARGIN };

describe('the delegate constants are the ones verified on chain', () => {
  it('uses EntryPoint v0.8, which Pimlico serves on chain 143', () => {
    expect(ENTRY_POINT_V08).toBe(entryPoint08Address);
    // Both are deployed on Monad; v0.8 is the one Simple7702Account targets.
    expect(ENTRY_POINT_V07).toBe('0x0000000071727De22E5E9d8BAf0edAc6f37da032');
  });

  it('records the delegate viem authorizes', () => {
    expect(SIMPLE_7702_DELEGATE).toBe('0xe6Cae83BdE06E4c305530e199D7217f42808555B');
  });

  it('keeps the delegates that were evaluated and not chosen', () => {
    expect(EVALUATED_DELEGATES.kernel7702).toBe('0xd6CEDDe84be40893d153Be9d467CD6aD37875b28');
    expect(EVALUATED_DELEGATES.calibur).toBe('0x000000009B1D0aF20D8C6d0A44e162d11F9b8f00');
  });

  it('never puts the Pimlico key anywhere a browser could read it', () => {
    // The URL is built server-side only. This test exists so the shape is fixed and
    // an accidental client-side call is obvious in review.
    const url = pimlicoUrl(143, 'KEY');
    expect(url).toBe('https://api.pimlico.io/v2/143/rpc?apikey=KEY');
    expect(url).toContain('/143/');
  });
});

describe('delegation indicators', () => {
  it('builds 0xef0100 || delegate', () => {
    const code = delegationCodeFor(SIMPLE_7702_DELEGATE);
    expect(code).toBe('0xef0100e6Cae83BdE06E4c305530e199D7217f42808555B');
    expect(code.startsWith(DELEGATION_PREFIX)).toBe(true);
    expect((code.length - 2) / 2).toBe(23);
  });

  it('reads the delegate back out', () => {
    const code = delegationCodeFor(SIMPLE_7702_DELEGATE);
    expect(delegateOf(code)?.toLowerCase()).toBe(SIMPLE_7702_DELEGATE.toLowerCase());
  });

  it('returns undefined for an undelegated account', () => {
    expect(delegateOf('0x')).toBeUndefined();
    expect(delegateOf(undefined)).toBeUndefined();
    // A real contract, not a delegation.
    expect(delegateOf('0x6080604052')).toBeUndefined();
  });

  it('rejects a truncated indicator rather than guessing', () => {
    expect(delegateOf('0xef0100abcd')).toBeUndefined();
  });
});

describe('Monad’s 10-MON reserve, stated precisely', () => {
  it('does not bite when nothing is spent, even at zero balance', () => {
    // This is why a sponsored zero-MON account still works.
    expect(violatesDelegatedReserve(0n, 0n)).toBe(false);
    expect(violatesDelegatedReserve(MONAD_DELEGATED_RESERVE_WEI - 1n, 0n)).toBe(false);
  });

  it('bites when a delegated account would be pushed below the reserve', () => {
    expect(violatesDelegatedReserve(11n * 10n ** 18n, 2n * 10n ** 18n)).toBe(true);
  });

  it('does not bite when the balance stays above the reserve', () => {
    expect(violatesDelegatedReserve(20n * 10n ** 18n, 1n * 10n ** 18n)).toBe(false);
  });
});

describe('sponsorship policy', () => {
  // MON/USDC: the market the live allowlist holds from cold start, before any refresh.
  // This process never calls `configureLiveMarkets`, so that is the whole allowlist here.
  const order = buildMarketOrder({
    market: MON_USDC_MARKET,
    params: MON_USDC_PARAMS,
    side: 'buy',
    amount: 3_000_000n,
    minAmountOut: 0n,
  });

  it('sponsors an order on the one allowed market', () => {
    expect(() => assertSponsorable([{ to: order.to, data: order.data }], context)).not.toThrow();
  });

  it('sponsors a deposit to the MarginAccount', () => {
    const deposit = buildDeposit(MARGIN, USER, AUSD, 5_000_000n);
    expect(() =>
      assertSponsorable([{ to: deposit.to, data: deposit.data }], context),
    ).not.toThrow();
  });

  it('sponsors a cancel', () => {
    const cancel = buildCancelOrders(MON_USDC_MARKET, [1n]);
    expect(() => assertSponsorable([{ to: cancel.to, data: cancel.data }], context)).not.toThrow();
  });

  it('refuses MON/AUSD, which is shown but no longer traded', () => {
    // On the allowlist from 2026-09-02 until 2026-09-23. Kuru still lists it, but it has
    // not traded since 2026-09-02 and its book is empty (reports/MARKETS-VERIFIED.md §3).
    const monAusdOrder = buildMarketOrder({
      market: MON_AUSD_MARKET,
      params: MON_AUSD_PARAMS,
      side: 'buy',
      amount: 3_000_000n,
      minAmountOut: 0n,
    });
    expect(() =>
      assertSponsorable([{ to: monAusdOrder.to, data: monAusdOrder.data }], context),
    ).toThrow(PolicyViolation);
    const cancel = buildCancelOrders(MON_AUSD_MARKET, [1n]);
    expect(isSponsorable([{ to: cancel.to, data: cancel.data }], context)).toBe(false);
  });

  it('refuses a market that is not on the allowlist', () => {
    const unlisted = '0xE9E448ab704E0b5F83261342D0DB8aC00651E70F' as Address;
    expect(() => assertSponsorable([{ to: unlisted, data: order.data }], context)).toThrow(
      PolicyViolation,
    );
  });

  it('refuses a selector nobody in this app builds', () => {
    // MarginAccount.creditUser — would credit balance out of nothing.
    expect(() =>
      assertSponsorable([{ to: MARGIN, data: `0x75eab98e${'0'.repeat(128)}` as Hex }], context),
    ).toThrow(/not sponsorable/);
  });

  it('refuses any call carrying native MON', () => {
    expect(() =>
      assertSponsorable([{ to: order.to, data: order.data, value: 1n }], context),
    ).toThrow(/never carry native MON/);
  });

  it('sponsors permit() on an allowlisted token, so approval and deposit are atomic', () => {
    // A real permit naming the MarginAccount. This used to be all-zero calldata, which
    // decodes to a permit for the ZERO address — accepted before the spender was
    // checked, refused now, and it should always have been refused.
    const permitToMargin = encodeFunctionData({
      abi: parseAbi([
        'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
      ]),
      functionName: 'permit',
      args: [
        '0x43a275C3Eb0BE7313f847FFA4fb6Bd366606A961',
        MARGIN,
        1_000_000n,
        BigInt(Math.floor(Date.now() / 1000) + 300),
        27,
        `0x${'11'.repeat(32)}`,
        `0x${'22'.repeat(32)}`,
      ],
    });
    // The name of this test is "approval and deposit are atomic", and the deposit now
    // has to actually be here: a permit with nothing spending it leaves its allowance
    // standing after the batch, which is the shape the pairing rule exists to refuse.
    const depositAfter = buildDeposit(
      MARGIN,
      '0x43a275C3Eb0BE7313f847FFA4fb6Bd366606A961',
      AUSD,
      1_000_000n,
    );
    expect(() =>
      assertSponsorable(
        [
          { to: AUSD, data: permitToMargin },
          { to: MARGIN, data: depositAfter.data },
        ],
        {
          ...context,
          permitTokens: [AUSD],
        },
      ),
    ).not.toThrow();
  });

  it('refuses a permit naming the zero address', () => {
    expect(() =>
      assertSponsorable([{ to: AUSD, data: `${PERMIT_SELECTOR}${'0'.repeat(448)}` as Hex }], {
        ...context,
        permitTokens: [AUSD],
      }),
    ).toThrow(/may only name/);
  });

  it('allows only permit(), transfer() and the approve triple on a permit token', () => {
    // `transfer` became sponsorable on 2026-09-09 (D128), so this no longer refuses it
    // outright — it refuses this one for its recipient, which is the zero address.
    expect(() =>
      assertSponsorable([{ to: AUSD, data: `0xa9059cbb${'0'.repeat(128)}` as Hex }], {
        ...context,
        permitTokens: [AUSD],
      }),
    ).toThrow(/may not be sent to one/);
    // approve(address,uint256) alone — this one names the zero address as spender,
    // which is neither pinned spender, so the triple check refuses it (C1).
    expect(() =>
      assertSponsorable([{ to: AUSD, data: `0x095ea7b3${'0'.repeat(128)}` as Hex }], {
        ...context,
        permitTokens: [AUSD],
      }),
    ).toThrow(/may only name a pinned swap router or the margin account/);
    // Everything that is none of those is still refused on the selector alone.
    expect(() =>
      assertSponsorable([{ to: AUSD, data: `0x23b872dd${'0'.repeat(192)}` as Hex }], {
        ...context,
        permitTokens: [AUSD],
      }),
    ).toThrow(/only permit\(\) may be sponsored/);
  });

  it('refuses permit() on a token that is not allowlisted', () => {
    expect(() =>
      assertSponsorable(
        [{ to: AUSD, data: `${PERMIT_SELECTOR}${'0'.repeat(448)}` as Hex }],
        context,
      ),
    ).toThrow(PolicyViolation);
  });

  it('refuses an empty batch', () => {
    expect(() => assertSponsorable([], context)).toThrow(/nothing to sponsor/);
  });

  it('refuses the whole batch when one call is bad', () => {
    const cancel = buildCancelOrders(MON_USDC_MARKET, [1n]);
    // The good half on its own is sponsorable, so the refusal below is the bad half's.
    expect(isSponsorable([{ to: cancel.to, data: cancel.data }], context)).toBe(true);
    const unlisted = '0xE9E448ab704E0b5F83261342D0DB8aC00651E70F' as Address;
    expect(
      isSponsorable(
        [
          { to: cancel.to, data: cancel.data },
          { to: unlisted, data: order.data },
        ],
        context,
      ),
    ).toBe(false);
  });

  it('applies the notional cap when a notional can be computed', () => {
    const big = buildLimitOrder({
      market: MON_USDC_MARKET,
      params: MON_USDC_PARAMS,
      side: 'buy',
      // MON/USDC's best ask read 2026-09-23 (reports/MARKETS-VERIFIED.md §2): 0.0267.
      priceWire: 26_700_000_000_000_000n,
      sizeBase: 100_000_000_000_000_000_000_000n, // 100,000 MON, about $2,670
    });
    // Allowed market, so the refusal below is the cap's and nothing else's.
    expect(() => assertSponsorable([{ to: big.to, data: big.data }], context)).not.toThrow();
    try {
      assertSponsorable([{ to: big.to, data: big.data }], {
        ...context,
        notionalOf: () => 2_670_000_000n,
      });
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyViolation);
      expect((error as PolicyViolation).reason).toBe('CAP_EXCEEDED');
    }
  });
});

const LIVE: ModeGate = { mode: 'mainnet', runMode: 'live', realFundsAcknowledged: true };
const DRY: ModeGate = { mode: 'mainnet', runMode: 'dryrun', realFundsAcknowledged: true };

describe('the submit() gate', () => {
  const sender = privateKeyToAccount(`0x${'66'.repeat(32)}` as Hex).address;
  const deposit = { to: MARGIN, data: '0x8340f549' as Hex };

  it('is proven: M0 passed on Monad mainnet 2026-09-02', () => {
    // tx 0x49e07857…fe93 placed the order, 0x9631da75…a74b cancelled it, and the
    // account held 0 MON throughout. See submit.ts for the full record.
    expect(GAS_LAYER_PROVEN).toBe(true);
  });

  it('sends nothing when there is no transport', async () => {
    const result = await submit({ sender, calls: [deposit], purpose: 'deposit' });
    expect(result.status).toBe('DRYRUN');
    expect(didNotSend(result)).toBe(true);
    expect(result.reason).toBe('NO_TRANSPORT');
    expect(result.message).not.toMatch(/0x/);
  });

  it('does NOT evaluate the mode gate itself, whatever it is handed', async () => {
    // This is the bug that shipped: submit() used to call mainnetAllowed(), which is
    // correct on a server and permanently false in a browser, because MODE is not a
    // NEXT_PUBLIC_ variable. An armed deployment answered "simulated mode" and sent
    // nothing, and every unit test passed because tests run in Node where the
    // variables exist.
    //
    // The gate now lives only in the server route behind the transport. So a
    // disarmed-looking gate must NOT stop the call reaching the transport: it is not
    // this function's decision any more.
    for (const gate of [
      DRY,
      { mode: 'mainnet' as const, runMode: 'dryrun' as const, realFundsAcknowledged: true },
      { mode: 'testnet' as const, runMode: 'live' as const, realFundsAcknowledged: true },
    ]) {
      const sent: SubmitRequest[] = [];
      const result = await submit(
        { sender, calls: [deposit], purpose: 'deposit' },
        {
          send: async (r: SubmitRequest) => {
            sent.push(r);
            return { status: 'SUBMITTED' as const };
          },
        },
        { gate },
      );
      expect(sent, JSON.stringify(gate)).toHaveLength(1);
      expect(result.status).toBe('SUBMITTED');
    }
  });

  it('reaches the transport only when all three switches are thrown', async () => {
    const sent: SubmitRequest[] = [];
    const result = await submit(
      { sender, calls: [deposit], purpose: 'deposit' },
      {
        send: async (r) => {
          sent.push(r);
          return { status: 'SUBMITTED' as const, sender: r.sender };
        },
      },
      { gate: LIVE },
    );
    expect(sent).toHaveLength(1);
    expect(result.status).toBe('SUBMITTED');
    // Under 7702 the sender is the user's own EOA, which is what M0 proved.
    expect(result.sender).toBe(sender);
  });

  it('returns rather than throws when there is no transport, armed or not', async () => {
    // It used to throw GasLayerUnprovenError here, which a screen then caught and
    // rendered as "Trading is not live yet in this build" — a sentence that was false
    // once the build was armed and had a transport it simply was not given. A missing
    // transport is a build fact, so it is reported, not raised.
    for (const gate of [LIVE, DRY]) {
      const result = await submit({ sender, calls: [deposit], purpose: 'order' }, undefined, {
        gate,
      });
      expect(result.status).toBe('DRYRUN');
      expect(result.reason).toBe('NO_TRANSPORT');
    }
  });

  it('distinguishes "did not send" from "unproven"', () => {
    expect(didNotSend({ status: 'DRYRUN' })).toBe(true);
    expect(didNotSend({ status: 'SUBMIT_GAS_LAYER_UNPROVEN' })).toBe(true);
    expect(didNotSend({ status: 'SUBMITTED' })).toBe(false);
    expect(isUnproven({ status: 'DRYRUN' })).toBe(false);
    expect(isUnproven({ status: 'SUBMIT_GAS_LAYER_UNPROVEN' })).toBe(true);
  });
});

describe('a sponsored send: three tokens, one selector, a bounded amount (D128)', () => {
  const USDC = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603' as Address;
  const AUSD = '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a' as Address;
  const WBTC = '0x0555E30da8f98308EdB960aa94C0Db47230d2B9c' as Address;
  const STRANGER = '0x1111111111111111111111111111111111111111' as Address;

  const word = (v: string) => v.replace(/^0x/, '').padStart(64, '0');
  const transfer = (to: Address, value: bigint): Hex =>
    `0x a9059cbb${word(to)}${word(value.toString(16))}`.replace(/\s/g, '') as Hex;
  const approve = (to: Address, value: bigint): Hex =>
    `0x095ea7b3${word(to)}${word(value.toString(16))}` as Hex;

  it('sponsors a transfer of a pinned token to a plain address', () => {
    expect(() =>
      assertSponsorable([{ to: USDC, data: transfer(STRANGER, 1_000_000n) }], context),
    ).not.toThrow();
    expect(() =>
      assertSponsorable([{ to: AUSD, data: transfer(STRANGER, 1_000_000n) }], context),
    ).not.toThrow();
  });

  it('sponsors a transfer of ANY token (any-token wallet, D1; the pinned three before 2026-09-25)', () => {
    // WBTC is on no list anywhere — exactly the airdropped-token case D1 exists for.
    expect(() =>
      assertSponsorable([{ to: WBTC, data: transfer(STRANGER, 1_000n) }], context),
    ).not.toThrow();
    // The bounds that stay are token-independent: the recipient may not be a contract
    // this app knows, and the amount must be positive.
    expect(() =>
      assertSponsorable([{ to: WBTC, data: transfer(MARGIN, 1_000n) }], context),
    ).toThrow(/may not be sent to one/);
    expect(() =>
      assertSponsorable([{ to: WBTC, data: transfer(STRANGER, 0n) }], context),
    ).toThrow(/positive amount/);
  });

  it('the dollar-par cap binds pinned dollar tokens only; an unpriced token is uncapped (C2)', () => {
    // 1,001 USDC is over the $1,000 cap; the same base units of an unpriced token are
    // not dollars and per the owner's C2 decision carry no cap here.
    expect(() =>
      assertSponsorable([{ to: USDC, data: transfer(STRANGER, 1_001_000_000n) }], context),
    ).toThrow(/exceeds the hard cap/);
    expect(() =>
      assertSponsorable([{ to: WBTC, data: transfer(STRANGER, 1_001_000_000n) }], context),
    ).not.toThrow();
  });

  it('never sponsors a lone approve(): only the exact triple is a shape (C1)', () => {
    expect(() =>
      assertSponsorable([{ to: USDC, data: approve(STRANGER, 1_000_000n) }], {
        ...context,
        permitTokens: [USDC],
      }),
    ).toThrow(/may only name a pinned swap router or the margin account/);
    // The right spender, but no spend and no revoke behind it: still refused.
    expect(() =>
      assertSponsorable([{ to: USDC, data: approve(MARGIN, 1_000_000n) }], context),
    ).toThrow(/approve, the spend, then a zero approve/);
    // A zero approval standing alone closes nothing.
    expect(() =>
      assertSponsorable([{ to: USDC, data: approve(MARGIN, 0n) }], context),
    ).toThrow(/may only close the approval opened two calls before it/);
  });

  it('sponsors approve-deposit-revoke on the margin account, exact and closed (D2)', () => {
    const deposit = buildDeposit(MARGIN, USER, WBTC, 1_000n).data;
    const triple = [
      { to: WBTC, data: approve(MARGIN, 1_000n) },
      { to: MARGIN, data: deposit },
      { to: WBTC, data: approve(MARGIN, 0n) },
    ];
    expect(() => assertSponsorable(triple, context)).not.toThrow();
    // The wrong amount in the middle breaks the pair.
    const wrongAmount = [
      { to: WBTC, data: approve(MARGIN, 2_000n) },
      { to: MARGIN, data: deposit },
      { to: WBTC, data: approve(MARGIN, 0n) },
    ];
    expect(() => assertSponsorable(wrongAmount, context)).toThrow(/not the amount the deposit moves/);
    // A missing revoke leaves an allowance standing: refused.
    expect(() =>
      assertSponsorable([{ to: WBTC, data: approve(MARGIN, 1_000n) }, { to: MARGIN, data: deposit }], context),
    ).toThrow(/approve, the spend, then a zero approve/);
    // A revoke for a different spender does not close this triple.
    const wrongRevoke = [
      { to: WBTC, data: approve(MARGIN, 1_000n) },
      { to: MARGIN, data: deposit },
      { to: WBTC, data: approve(STRANGER, 0n) },
    ];
    expect(() => assertSponsorable(wrongRevoke, context)).toThrow(PolicyViolation);
  });

  it('refuses a recipient that is a contract this app knows', () => {
    // The MarginAccount, a token itself, and a live order book.
    for (const bad of [
      '0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5',
      '0x754704Bc059F8C67012fEd69BC8A327a5aafb603',
      '0x131A2e70A5b31a517A74b8c567149bc294470Da9',
      '0x0000000000000000000000000000000000000000',
    ] as Address[]) {
      expect(() =>
        assertSponsorable([{ to: USDC, data: transfer(bad, 1_000_000n) }], context),
      ).toThrow(PolicyViolation);
    }
  });

  it('applies the same notional cap a trade gets', () => {
    // $1,000 cap: 1,000.000000 passes, 1,000.000001 does not.
    expect(MAX_ORDER_NOTIONAL_AUSD).toBe(1_000_000_000n);
    expect(() =>
      assertSponsorable(
        [{ to: USDC, data: transfer(STRANGER, MAX_ORDER_NOTIONAL_AUSD) }],
        context,
      ),
    ).not.toThrow();
    expect(() =>
      assertSponsorable(
        [{ to: USDC, data: transfer(STRANGER, MAX_ORDER_NOTIONAL_AUSD + 1n) }],
        context,
      ),
    ).toThrow(/exceeds the hard cap/);
  });

  it('refuses a zero-value transfer and malformed calldata', () => {
    expect(() =>
      assertSponsorable([{ to: USDC, data: transfer(STRANGER, 0n) }], context),
    ).toThrow(/positive amount/);
    expect(() =>
      assertSponsorable([{ to: USDC, data: '0xa9059cbb' as Hex }], context),
    ).toThrow(/recipient and an amount/);
  });
});
