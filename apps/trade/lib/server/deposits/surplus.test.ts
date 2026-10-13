import { describe, expect, it } from 'vitest';
import { isSurplusReturn } from './watcher.js';

describe('isSurplusReturn', () => {
  it('is true when the extra beyond the quote comes back (0.0189 SOL sent, 0.0088 returned)', () => {
    expect(isSurplusReturn(8_771_942n, 18_869_924n)).toBe(true);
  });
  it('is false for a whole deposit coming back less the fee (0.00929 SOL sent, 0.00919 returned)', () => {
    expect(isSurplusReturn(9_194_707n, 9_290_155n)).toBe(false);
  });
  it('is false when what was deposited is not known', () => {
    expect(isSurplusReturn(8_771_942n, undefined)).toBe(false);
  });
});
