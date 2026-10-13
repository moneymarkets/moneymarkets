import { describe, expect, it } from 'vitest';
import type { FreeActionsInfo } from './gasCharge';
import { freeActionsBanner, freeActionsPill, SWAP_INTO_MON_HREF } from './freeActionsView';

function at(used: number, limit = 20): FreeActionsInfo {
  return {
    limit,
    used,
    remaining: Math.max(limit - used, 0),
    resetsAt: 1_800_000_000_000,
    allFreeAt: null,
  };
}

// G1: "header pill and banner at 14, 15, 18, 20".
describe('freeActionsPill (B4)', () => {
  it('shows what is left, in the spec\'s own format', () => {
    expect(freeActionsPill(at(7)).text).toBe('Free actions 13 of 20');
    expect(freeActionsPill(at(0)).text).toBe('Free actions 20 of 20');
    expect(freeActionsPill(at(20)).text).toBe('Free actions 0 of 20');
  });

  it('is not red at 14 used, red from 15 used', () => {
    expect(freeActionsPill(at(14)).alert).toBe(false);
    expect(freeActionsPill(at(15)).alert).toBe(true);
    expect(freeActionsPill(at(18)).alert).toBe(true);
    expect(freeActionsPill(at(20)).alert).toBe(true);
  });
});

describe('freeActionsBanner (B4)', () => {
  it('shows nothing at 14, 15 and 17 used', () => {
    expect(freeActionsBanner(at(14))).toBeUndefined();
    expect(freeActionsBanner(at(15))).toBeUndefined();
    expect(freeActionsBanner(at(17))).toBeUndefined();
  });

  it('at 18 used: the exact two-left copy, blinking', () => {
    expect(freeActionsBanner(at(18))).toEqual({
      level: 'low',
      message:
        'Two free actions left today. Swap into MON now and every action after that is paid from your own MON.',
    });
  });

  it('at 19 used: the same banner, honestly saying one — never "Two" with one left', () => {
    const view = freeActionsBanner(at(19));
    expect(view?.level).toBe('low');
    expect(view?.message).toContain('One free action left today.');
    expect(view?.message).not.toContain('Two');
  });

  it('at 20 used: the exact used-up copy', () => {
    expect(freeActionsBanner(at(20))).toEqual({
      level: 'used-up',
      message:
        'Your 20 free actions for today are used. Swapping into MON is still free and gives you MON to pay your own gas. Or pay gas from your trading balance at cost.',
    });
  });

  it('the swap link opens Swap prefilled per B3', () => {
    expect(SWAP_INTO_MON_HREF).toBe('/wallet/swap?into=mon');
  });
});
