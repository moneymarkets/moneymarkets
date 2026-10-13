import { describe, expect, it } from 'vitest';
import { isNative, isWmon, maxNativeSpend, NATIVE_MON, WMON } from './swapPlan';

const MON = (whole: string): bigint => {
  const [w = '0', f = ''] = whole.split('.');
  return BigInt(w) * 10n ** 18n + BigInt(f.padEnd(18, '0').slice(0, 18));
};
const RESERVE = MON('10');

describe('maxNativeSpend (item 1: the 10 MON reserve on a delegated wallet)', () => {
  it('Max on 86.954577 MON leaves exactly the reserve behind, with no gas to subtract', () => {
    expect(maxNativeSpend(MON('86.954577'), RESERVE)).toBe(MON('76.954577'));
  });

  it('10.5 MON, with gas subtracted, spends 0.5 MON minus that gas', () => {
    const gas = MON('0.001');
    expect(maxNativeSpend(MON('10.5'), RESERVE + gas)).toBe(MON('0.5') - gas);
  });

  it('a balance already under 10 MON has nothing spendable', () => {
    expect(maxNativeSpend(MON('9.999999'), RESERVE)).toBe(0n);
  });

  it('a balance exactly at the reserve has nothing spendable', () => {
    expect(maxNativeSpend(RESERVE, RESERVE)).toBe(0n);
  });

  it('gas that would eat into the reserve itself clamps to zero, never negative', () => {
    expect(maxNativeSpend(MON('10.0005'), RESERVE + MON('0.001'))).toBe(0n);
  });

  it('a zero balance has nothing spendable', () => {
    expect(maxNativeSpend(0n, RESERVE)).toBe(0n);
  });
});

describe('isNative / isWmon', () => {
  it('only the native MON address is native', () => {
    expect(isNative(NATIVE_MON)).toBe(true);
    expect(isNative(WMON)).toBe(false);
  });

  it('only the WMON address is WMON, case-insensitively', () => {
    expect(isWmon(WMON)).toBe(true);
    expect(isWmon(WMON.toUpperCase() as typeof WMON)).toBe(true);
    expect(isWmon(NATIVE_MON)).toBe(false);
  });
});
