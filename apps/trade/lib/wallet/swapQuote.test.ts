import { describe, expect, it } from 'vitest';
import { MAINNET } from '@tradepro/core';
import { encodeEventTopics, pad, parseAbi, type Address, type Hex } from 'viem';
import {
  deliveredAmountFromLogs,
  NATIVE_MON,
  nativeDeliveryPlan,
  prefillPayAmountForMon,
  resolveTokenOut,
  SWAP_INTO_MON_TARGET_WEI,
  WMON,
} from './swapQuote';

const USDC = MAINNET.tokens.USDC.address;
const AUSD = MAINNET.tokens.AUSD.address;

describe('resolveTokenOut — WMON delivery on MON output', () => {
  it('asks Flow for WMON, and says so, when the user wants native MON', () => {
    const resolved = resolveTokenOut(NATIVE_MON);
    expect(resolved.flowTokenOut.toLowerCase()).toBe(WMON.toLowerCase());
    expect(resolved.deliveredAsWmon).toBe(true);
  });

  it('asks Flow for the token as given for anything else, and never claims a WMON delivery', () => {
    const resolved = resolveTokenOut(USDC);
    expect(resolved.flowTokenOut).toBe(USDC);
    expect(resolved.deliveredAsWmon).toBeUndefined();
  });

  it('is case-insensitive about the native sentinel', () => {
    const resolved = resolveTokenOut(NATIVE_MON.toUpperCase() as Address);
    expect(resolved.deliveredAsWmon).toBe(true);
  });
});

describe('deliveredAmountFromLogs — reading what actually arrived, not the quote figure', () => {
  const TRANSFER_ABI = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);
  const RECIPIENT = '0x43a275C3Eb0BE7313f847FFA4fb6Bd366606A961' as Address;
  const ROUTER = '0xb3e6778480b2E488385E8205eA05E20060B813cb' as Address;

  function transferLog(token: Address, from: Address, to: Address, value: bigint) {
    const topics = encodeEventTopics({ abi: TRANSFER_ABI, eventName: 'Transfer', args: { from, to } });
    return { address: token, topics, data: pad(`0x${value.toString(16)}` as Hex) };
  }

  it('reads the real amount a Transfer log to the recipient actually carried', () => {
    const logs = [transferLog(AUSD, ROUTER, RECIPIENT, 996_851n)];
    expect(deliveredAmountFromLogs(logs, AUSD, RECIPIENT)).toBe(996_851n);
  });

  it('ignores transfers of a different token, or to a different recipient', () => {
    const logs = [
      transferLog(USDC, ROUTER, RECIPIENT, 1_000_000n), // wrong token
      transferLog(AUSD, ROUTER, ROUTER, 5_000n), // wrong recipient
    ];
    expect(deliveredAmountFromLogs(logs, AUSD, RECIPIENT)).toBeUndefined();
  });

  it('sums more than one matching transfer rather than taking only the first', () => {
    const logs = [
      transferLog(AUSD, ROUTER, RECIPIENT, 500_000n),
      transferLog(AUSD, ROUTER, RECIPIENT, 496_851n),
    ];
    expect(deliveredAmountFromLogs(logs, AUSD, RECIPIENT)).toBe(996_851n);
  });

  it('is undefined, not zero, when there are no logs at all', () => {
    expect(deliveredAmountFromLogs(undefined, AUSD, RECIPIENT)).toBeUndefined();
    expect(deliveredAmountFromLogs([], AUSD, RECIPIENT)).toBeUndefined();
  });

  it('skips a malformed log rather than throwing', () => {
    const logs = [{ address: AUSD, topics: ['0xnotahash'], data: '0x' }];
    expect(deliveredAmountFromLogs(logs, AUSD, RECIPIENT)).toBeUndefined();
  });
});

describe('nativeDeliveryPlan — B3: native when the wallet ends above the reserve', () => {
  const MON = 10n ** 18n;
  const RESERVE = 10n * MON;

  it('delivers native when balance plus the guaranteed minimum clears the reserve', () => {
    expect(
      nativeDeliveryPlan({ currentNativeWei: 0n, minOutWei: 12n * MON, reserveWei: RESERVE }),
    ).toEqual({ deliverNative: true });
    // Exactly at the reserve is enough — "at least 10 MON" is the chain's own rule.
    expect(
      nativeDeliveryPlan({ currentNativeWei: 4n * MON, minOutWei: 6n * MON, reserveWei: RESERVE })
        .deliverNative,
    ).toBe(true);
  });

  it('falls back to WMON below the reserve, and says so', () => {
    const plan = nativeDeliveryPlan({
      currentNativeWei: 0n,
      minOutWei: 2n * MON,
      reserveWei: RESERVE,
    });
    expect(plan.deliverNative).toBe(false);
    expect(plan.note).toContain('WMON');
    expect(plan.note).toContain('10 MON');
  });
});

describe('prefillPayAmountForMon — B3: prefilled to reach 12 MON, from real prices only', () => {
  const MON = 10n ** 18n;
  // MON at $2.00, USDC at $1.00, both 6-decimal prices; pay token 6 decimals.
  const monUsd = { value: 2_000_000n, decimals: 6 };
  const usdUsd = { value: 1_000_000n, decimals: 6 };

  it('computes the pay amount for the 12 MON deficit at the two real prices', () => {
    // 12 MON deficit at $2 = $24 = 24_000_000 base units of a 6-decimal dollar.
    expect(
      prefillPayAmountForMon({ currentNativeWei: 0n, monUsd, payUsd: usdUsd, payDecimals: 6 }),
    ).toBe(24_000_000n);
    // 5 MON already held: 7 MON deficit = $14.
    expect(
      prefillPayAmountForMon({ currentNativeWei: 5n * MON, monUsd, payUsd: usdUsd, payDecimals: 6 }),
    ).toBe(14_000_000n);
  });

  it('answers undefined with no price to compute from, or nothing to reach', () => {
    expect(
      prefillPayAmountForMon({ currentNativeWei: 0n, monUsd: null, payUsd: usdUsd, payDecimals: 6 }),
    ).toBeUndefined();
    expect(
      prefillPayAmountForMon({ currentNativeWei: 0n, monUsd, payUsd: null, payDecimals: 6 }),
    ).toBeUndefined();
    expect(
      prefillPayAmountForMon({
        currentNativeWei: SWAP_INTO_MON_TARGET_WEI,
        monUsd,
        payUsd: usdUsd,
        payDecimals: 6,
      }),
    ).toBeUndefined();
  });
});
