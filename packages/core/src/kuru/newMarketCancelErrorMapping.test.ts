import { describe, expect, it } from 'vitest';
import { decodeKuruError, userMessageFor } from './errors.js';
import { CANCEL_MISSING_ORDER_SELECTOR } from './__fixtures__/newMarkets.js';

/**
 * Item 5: the cancel-error mislabeling `reports/MARKETS-VERIFIED.md` found (§2, and
 * §5 "What the matrix proves"):
 *
 * > Cancelling an order that does not exist reverts `OnlyOwnerAllowedError`, not
 * > `OrderAlreadyFilledOrCancelled`. This is true on all six books tested. `errors.ts`
 * > maps that selector to "That action is reserved for the market owner.", which is
 * > the wrong message for a cancel of a missing or foreign order. Noted, not changed.
 *
 * Measured live: cancelling `s_orderIdCounter() + 1` (an id certain never to have
 * been issued) on MON/USDC, WETH/USDC, cbBTC/USDC, XAUt0/USDC, emo/MON, and the empty
 * MON/USDC book `0xcb4659fb…` — six different `OrderBook`s — reverted
 * `0xa0cdd781` every time.
 */
describe('a cancel of a nonexistent order reverts OnlyOwnerAllowedError, real evidence', () => {
  it('is 0xa0cdd781, not OrderAlreadyFilledOrCancelled (0x829f7240)', () => {
    expect(CANCEL_MISSING_ORDER_SELECTOR).toBe('0xa0cdd781');
    expect(decodeKuruError(CANCEL_MISSING_ORDER_SELECTOR)?.name).toBe('OnlyOwnerAllowedError');
    expect(decodeKuruError(CANCEL_MISSING_ORDER_SELECTOR)?.name).not.toBe(
      'OrderAlreadyFilledOrCancelled',
    );
  });

  it('today’s message talks about ownership, which is accurate for the selector in general', () => {
    // OnlyOwnerAllowedError really does fire on every owner-gated OrderBook function,
    // not only batchCancelOrders — so this message is not simply "wrong"; it is the
    // right message for the selector and the wrong message for THIS call site.
    expect(userMessageFor(CANCEL_MISSING_ORDER_SELECTOR)).toBe(
      'That action is reserved for the market owner.',
    );
  });
});

/**
 * The gap: `errors.ts` is keyed by selector alone (`decodeKuruError`,
 * `userMessageFor`), with no way to know the revert came from a cancel rather than
 * from, say, an admin `batchUpdate`. Distinguishing "not the owner of this order" /
 * "this order does not exist" from a genuine owner-only admin action needs the call's
 * *purpose* (`orders.ts`'s `ForwardablePurpose`, e.g. `'batchCancelOrders'`) plumbed
 * through to the point where the message is chosen — a decode-time or
 * revert-site change, not a one-line fix to a selector table. No such plumbing
 * exists anywhere in `apps/trade` today (checked: no reference to
 * `OnlyOwnerAllowedError` or `0xa0cdd781` outside this package).
 *
 * `it.fails` on purpose: this documents the WRONG behaviour we have today. If
 * someone adds the context-passing and gives a cancel-specific message that does not
 * say "owner", this assertion starts passing, `it.fails` then FAILS, and that failure
 * is the signal to turn this back into a plain `it` and delete this comment.
 */
describe('the cancel-specific message this selector needs (currently unimplemented — gap, not silently accepted)', () => {
  it.fails(
    'a cancel-of-missing-order message should not tell the user they need to be the owner',
    () => {
      // What userMessageFor(selector) gives a cancel flow today. It reads as "you are
      // not authorized to do this administratively", when the real situation is "this
      // order was never yours to cancel — it does not exist, or was never yours".
      const message = userMessageFor(CANCEL_MISSING_ORDER_SELECTOR);
      expect(message).not.toMatch(/owner/i);
    },
  );
});
