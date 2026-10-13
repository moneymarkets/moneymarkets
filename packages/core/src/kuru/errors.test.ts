import { describe, expect, it } from 'vitest';
import { toFunctionSelector, type Hex } from 'viem';
import { marginAccountAbi } from '../abi/marginAccount.js';
import { orderBookAbi } from '../abi/orderBook.js';
import { routerAbi } from '../abi/router.js';
import { decodeKuruError, KURU_ERRORS, kuruDetailFor, userMessageFor } from './errors.js';

/**
 * The error table is only useful if its selectors are the contracts' selectors. This
 * recomputes them from the ABIs rather than trusting the literals in `errors.ts`.
 */
function selectorsFromAbi(abi: readonly unknown[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of abi as { type: string; name: string; inputs: { type: string }[] }[]) {
    if (entry.type !== 'error') continue;
    const sig = `${entry.name}(${entry.inputs.map((i) => i.type).join(',')})`;
    out.set(entry.name, toFunctionSelector(sig));
  }
  return out;
}

const abiSelectors = new Map<string, Map<string, string>>([
  ['OrderBook', selectorsFromAbi(orderBookAbi)],
  ['MarginAccount', selectorsFromAbi(marginAccountAbi)],
  ['Router', selectorsFromAbi(routerAbi)],
]);

describe('error selectors are the contracts’ own', () => {
  for (const err of KURU_ERRORS) {
    if (err.contract === 'shared') continue;
    it(`${err.contract}.${err.name} selector matches the ABI`, () => {
      const fromAbi = abiSelectors.get(err.contract)?.get(err.name);
      expect(fromAbi, `${err.name} is not in the ${err.contract} ABI`).toBeDefined();
      expect(err.selector.toLowerCase()).toBe(fromAbi?.toLowerCase());
    });
  }

  it('covers Solady SafeTransferLib failures that the ABIs do not declare', () => {
    // Observed live: MarginAccount.deposit reverts 0x7939f424 when the token pull
    // fails. It is not in any Kuru ABI because it comes from the library.
    expect(toFunctionSelector('TransferFromFailed()')).toBe('0x7939f424');
    expect(toFunctionSelector('TransferFailed()')).toBe('0x90b8ec18');
    expect(decodeKuruError('0x7939f424')?.name).toBe('TransferFromFailed');
  });

  it('has no duplicate selectors', () => {
    const seen = new Set<string>();
    for (const e of KURU_ERRORS) {
      expect(seen.has(e.selector), `duplicate selector ${e.selector}`).toBe(false);
      seen.add(e.selector);
    }
  });

  it('lists every OrderBook error that can reach a user action', () => {
    // These are the ones spec §4.7 names. If Kuru adds one, this fails loudly.
    const covered = new Set(KURU_ERRORS.map((e) => e.name));
    for (const name of [
      'PostOnlyError',
      'TickSizeError',
      'SizeError',
      'PriceError',
      'SlippageExceeded',
      'OrderAlreadyFilledOrCancelled',
      'InsufficientLiquidity',
      'MarketStateError',
      'LengthMismatch',
      'ProvisionError',
      'WrongOrderTypeCancel',
      'TooMuchSizeFilled',
    ]) {
      expect(covered.has(name), `${name} has no user copy`).toBe(true);
    }
  });
});

describe('user-facing copy', () => {
  it('maps the errors spec §4.7 calls out', () => {
    expect(decodeKuruError('0x8199f5f3')?.message).toBe(
      'Price moved before your order was filled. Review the price and try again.',
    );
    expect(decodeKuruError('0x004b65ba')?.message).toBe('This market is paused.');
    expect(decodeKuruError('0xbb55fd27')?.message).toBe('Not enough liquidity for this size.');
  });

  it('refreshes silently when an order was already gone', () => {
    const e = decodeKuruError('0x829f7240');
    expect(e?.action).toBe('refresh');
    expect(e?.message).toBe('');
  });

  it('auto-adjusts rather than blaming the user for tick and size', () => {
    expect(decodeKuruError('0x272d3bf7')?.action).toBe('adjust');
    expect(decodeKuruError('0x0a5c4f1f')?.action).toBe('adjust');
  });

  it('never shows a hex string for an unknown revert', () => {
    const msg = userMessageFor('0xdeadbeef');
    expect(msg).not.toMatch(/0x/);
    expect(msg).toBe('That did not go through. Nothing was spent. Try again in a moment.');
  });

  it('handles empty revert data', () => {
    expect(decodeKuruError(undefined)).toBeUndefined();
    expect(decodeKuruError('0x' as Hex)).toBeUndefined();
    expect(userMessageFor(undefined)).not.toMatch(/0x/);
  });

  it('has no apologies and no jargon in any message', () => {
    for (const e of KURU_ERRORS) {
      expect(e.message).not.toMatch(/sorry|oops|error|failed to|0x/i);
      expect(e.message).not.toMatch(/gasless|meta-?transaction|sponsored/i);
    }
  });
});

describe('kuruDetailFor — the venue answer is never masked (error-handling rule, 2026-09-08)', () => {
  it('names the decoded error for a known revert, source first', () => {
    expect(kuruDetailFor('0x0a5c4f1f')).toBe('Kuru answered: SizeError');
    expect(kuruDetailFor('0x44279255')).toBe('Kuru answered: ProtocolPaused');
  });

  it('shows the raw selector verbatim for an unknown revert, on this line only', () => {
    // The lead sentence (userMessageFor) stays plain; the detail line carries the
    // one thing an operator can look up. Dropping it would leave the user with
    // nothing to report.
    expect(kuruDetailFor('0xdeadbeef00' as Hex)).toContain('0xdeadbeef');
  });

  it('says nothing when there is no revert data to show', () => {
    expect(kuruDetailFor(undefined)).toBeUndefined();
    expect(kuruDetailFor('0x' as Hex)).toBeUndefined();
  });

  it('covers every error in the table, so no revert loses its name', () => {
    for (const e of KURU_ERRORS) {
      expect(kuruDetailFor(e.selector)).toBe(`Kuru answered: ${e.name}`);
    }
  });
});
