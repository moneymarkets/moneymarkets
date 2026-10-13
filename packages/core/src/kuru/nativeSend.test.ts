import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { buildNativeSend } from './orders.js';

describe('buildNativeSend (D200)', () => {
  const TO = getAddress('0x1111111111111111111111111111111111111111');

  it('builds a plain value transfer: no calldata, the exact value', () => {
    expect(buildNativeSend(TO, 1_000n)).toEqual({
      to: TO,
      data: '0x',
      value: 1_000n,
      purpose: 'nativeSend',
    });
  });

  it('refuses a zero amount', () => {
    expect(() => buildNativeSend(TO, 0n)).toThrow('a send must move a positive amount');
  });

  it('refuses a negative amount', () => {
    expect(() => buildNativeSend(TO, -1n)).toThrow('a send must move a positive amount');
  });
});
