import { describe, expect, it } from 'vitest';
import { acceptedByMarginAccount, moveInSwapFirstNotice, NATIVE_MON } from './kuruAccepted';

/**
 * Item 3 (2026-09-29): MarginAccount accepts native MON, so it must never appear
 * behind the "Kuru does not hold this token" notice. The accepted set is native MON
 * plus whatever the live markets name as a base or quote asset.
 */

const WETH = '0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242';
const USDC = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603';
const RANDOM_AIRDROP = '0x0000000000000000000000000000000000009999';

describe('acceptedByMarginAccount', () => {
  const liveMarketAddresses = new Set([WETH.toLowerCase(), USDC.toLowerCase()]);

  it('accepts native MON even when no live market names it', () => {
    expect(acceptedByMarginAccount(NATIVE_MON, new Set())).toBe(true);
  });

  it('accepts native MON alongside an unrelated live market set', () => {
    expect(acceptedByMarginAccount(NATIVE_MON, liveMarketAddresses)).toBe(true);
  });

  it("accepts a live market's base and quote token", () => {
    expect(acceptedByMarginAccount(WETH, liveMarketAddresses)).toBe(true);
    expect(acceptedByMarginAccount(USDC, liveMarketAddresses)).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(acceptedByMarginAccount(WETH.toUpperCase(), liveMarketAddresses)).toBe(true);
    expect(acceptedByMarginAccount(NATIVE_MON.toUpperCase(), liveMarketAddresses)).toBe(true);
  });

  it('refuses a token in no live market and not native MON', () => {
    expect(acceptedByMarginAccount(RANDOM_AIRDROP, liveMarketAddresses)).toBe(false);
  });
});

describe('moveInSwapFirstNotice', () => {
  const liveMarketAddresses = new Set([WETH.toLowerCase()]);

  it('is false with nothing selected', () => {
    expect(moveInSwapFirstNotice(undefined, liveMarketAddresses)).toBe(false);
  });

  it('is false for the selected token when it is native MON, whatever else is in the wallet', () => {
    expect(moveInSwapFirstNotice({ address: NATIVE_MON }, liveMarketAddresses)).toBe(false);
  });

  it('is false for the selected token when a live market names it', () => {
    expect(moveInSwapFirstNotice({ address: WETH }, liveMarketAddresses)).toBe(false);
  });

  it('is true only for the selected token when it is accepted by no live market and is not native MON', () => {
    expect(moveInSwapFirstNotice({ address: RANDOM_AIRDROP }, liveMarketAddresses)).toBe(true);
  });

  it('depends only on the token passed as `selected`, never on a wider list', () => {
    // The function's only token-shaped input is `selected`; there is no list
    // parameter it could read instead. Swapping which token is "selected" is the
    // only way its answer changes.
    const first = moveInSwapFirstNotice({ address: RANDOM_AIRDROP }, liveMarketAddresses);
    const second = moveInSwapFirstNotice({ address: WETH }, liveMarketAddresses);
    expect(first).not.toBe(second);
  });
});
