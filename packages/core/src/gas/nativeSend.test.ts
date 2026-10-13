import { describe, expect, it } from 'vitest';
import { getAddress, type Address } from 'viem';
import { assertSponsorable, exemptionOf, PolicyViolation } from './policy.js';
import { buildDeposit, buildWithdraw } from '../kuru/orders.js';
import { MAINNET } from '../chain/addresses.js';
import { KURU_FLOW_ROUTER, normalizeFlowCalldata } from '../kuru/flow.js';
import { FLOW_USDC_AUSD_RESPONSE } from '../kuru/__fixtures__/flow.js';

/**
 * D200: native MON leaving a sponsored batch, in the two new shapes added beside
 * the pre-existing WMON wrap — a plain send, and a direct margin deposit. Kuru's
 * MarginAccount was confirmed on mainnet to accept native MON directly at
 * `deposit(user, 0x0, amount)` with `value == amount` (2,125 prior calls at this
 * exact shape); no WMON wrap is needed for a deposit, unlike the swap path.
 */

const MARGIN = MAINNET.kuru.marginAccount as Address;
const WMON = MAINNET.tokens.WMON.address as Address;
const SENDER = '0x43a275C3Eb0BE7313f847FFA4fb6Bd366606A961' as Address;
const RECIPIENT = getAddress('0x1111111111111111111111111111111111111111');
const NATIVE = '0x0000000000000000000000000000000000000000' as Address;
const MON = 10n ** 18n;

const context = { marginAccount: MARGIN, sender: SENDER };

describe('a plain native-MON send', () => {
  it('is sponsorable: no calldata, a positive value, to an address this policy does not name', () => {
    expect(() =>
      assertSponsorable([{ to: RECIPIENT, data: '0x', value: MON }], context),
    ).not.toThrow();
  });

  it('is exempt, the same reason an ERC-20 transfer is', () => {
    expect(exemptionOf([{ to: RECIPIENT, data: '0x', value: MON }], MARGIN)).toBe('own-funds');
  });

  it.each([
    ['the zero address', NATIVE],
    ['the MarginAccount', MARGIN],
    ['WMON', WMON],
  ] as const)('refuses a send to %s', (_label, to) => {
    expect(() => assertSponsorable([{ to, data: '0x', value: MON }], context)).toThrow(PolicyViolation);
  });

  it('refuses a send that carries calldata alongside its value', () => {
    expect(() =>
      assertSponsorable([{ to: RECIPIENT, data: '0x12345678', value: MON }], context),
    ).toThrow(PolicyViolation);
  });
});

describe('a native-MON margin deposit', () => {
  function depositCall(user: Address, token: Address, amount: bigint, value: bigint) {
    const built = buildDeposit(MARGIN, user, token, amount);
    return { to: built.to, data: built.data, value };
  }

  it('is sponsorable: deposit(sender, 0x0, amount) with value == amount', () => {
    expect(() =>
      assertSponsorable([depositCall(SENDER, NATIVE, MON, MON)], context),
    ).not.toThrow();
  });

  it('is not exempt — depositing is not a withdrawal, same as an ERC-20 deposit', () => {
    expect(exemptionOf([depositCall(SENDER, NATIVE, MON, MON)], MARGIN)).toBeUndefined();
  });

  it('refuses a value that does not match the claimed amount', () => {
    expect(() =>
      assertSponsorable([depositCall(SENDER, NATIVE, MON, MON - 1n)], context),
    ).toThrow(PolicyViolation);
  });

  it('refuses a deposit crediting someone other than the sender', () => {
    expect(() =>
      assertSponsorable([depositCall(RECIPIENT, NATIVE, MON, MON)], context),
    ).toThrow(PolicyViolation);
  });

  it('refuses a deposit naming a non-native token while carrying value', () => {
    expect(() => assertSponsorable([depositCall(SENDER, WMON, MON, MON)], context)).toThrow(
      PolicyViolation,
    );
  });

  it('refuses a user word with dirty high bytes, even though the low 20 bytes are the sender (security review, 2026-10-08)', () => {
    const selector = '8340f549';
    const dirtyUser = `ffffffffffffffffffffffff${SENDER.slice(2).toLowerCase()}`;
    const cleanToken = `${'0'.repeat(24)}${NATIVE.slice(2)}`;
    const amountWord = MON.toString(16).padStart(64, '0');
    const data = `0x${selector}${dirtyUser}${cleanToken}${amountWord}` as const;
    expect(() => assertSponsorable([{ to: MARGIN, data, value: MON }], context)).toThrow(
      PolicyViolation,
    );
  });

  it('refuses a token word with dirty high bytes, even though the low 20 bytes are the zero address', () => {
    const selector = '8340f549';
    const cleanUser = `${'0'.repeat(24)}${SENDER.slice(2).toLowerCase()}`;
    const dirtyToken = `${'f'.repeat(24)}${'0'.repeat(40)}`;
    const amountWord = MON.toString(16).padStart(64, '0');
    const data = `0x${selector}${cleanUser}${dirtyToken}${amountWord}` as const;
    expect(() => assertSponsorable([{ to: MARGIN, data, value: MON }], context)).toThrow(
      PolicyViolation,
    );
  });

  it('a short, garbage value-carrying call to the MarginAccount is a clean refusal, never an uncaught throw (security review, 2026-10-08)', () => {
    expect(() => assertSponsorable([{ to: MARGIN, data: '0x1234', value: MON }], context)).toThrow(
      PolicyViolation,
    );
  });
});

describe('exemptionOf does not crash on a malformed batch it was never meant to see (security review, 2026-10-08)', () => {
  it('a native send to the MarginAccount followed by a WMON wrap does not throw — it is simply not exempt', () => {
    // This exact batch is already refused by `assertSponsorable` (the MarginAccount
    // is a forbidden native-send recipient) before `exemptionOf` is ever meant to run
    // on it, per its own doc comment — but `exemptionOf` itself must still fail
    // closed, not crash, if some caller ever asks it first.
    const wrap = { to: WMON, data: '0xd0e30db0' as const, value: MON };
    expect(() => exemptionOf([{ to: MARGIN, data: '0x', value: MON }, wrap], MARGIN)).not.toThrow();
    expect(exemptionOf([{ to: MARGIN, data: '0x', value: MON }, wrap], MARGIN)).toBeUndefined();
  });

  it('a WMON withdraw with no argument word does not throw (second review pass, 2026-10-08)', () => {
    // `actions[0]` just needs to pass its own check without an early return, so the
    // loop reaches `i === 1`: a real margin withdrawal does that. The crash was in
    // reading `actions[1]`'s own (too-short) data, regardless of `actions[0]`.
    const withdraw = buildWithdraw(MARGIN, WMON, MON);
    const bareWithdraw = { to: WMON, data: '0x2e1a7d4d' as const };
    expect(() => exemptionOf([{ to: withdraw.to, data: withdraw.data }, bareWithdraw], MARGIN)).not.toThrow();
  });
});

describe('assertSponsorable does not crash on a native send ahead of a real swap (second review pass, 2026-10-08)', () => {
  it('a native send immediately before a real Flow swap is a clean refusal, not an uncaught throw', () => {
    // The swap's own "is this paid by the permit or approve ahead of it" check used
    // to call `selectorOf(previous.data)` with no length guard — `previous` here is
    // the native send, whose `data` is `'0x'`, too short to carry a selector.
    const swapCall = {
      to: KURU_FLOW_ROUTER,
      data: normalizeFlowCalldata(FLOW_USDC_AUSD_RESPONSE.transaction.calldata),
    };
    expect(() =>
      assertSponsorable([{ to: RECIPIENT, data: '0x', value: MON }, swapCall], context),
    ).toThrow(PolicyViolation);
  });
});
