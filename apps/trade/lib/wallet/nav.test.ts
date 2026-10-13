import { describe, expect, it } from 'vitest';
import { MOBILE_NAV, RAIL_NAV } from './nav';

describe('app navigation (wallet spec §2)', () => {
  it('the desktop rail shows all seven destinations', () => {
    expect(RAIL_NAV).toHaveLength(7);
  });

  it('the phone tab bar shows six: seven does not fit 390px with readable labels', () => {
    expect(MOBILE_NAV).toHaveLength(6);
  });

  it('Wallet is present on both, second on the rail (right after Home)', () => {
    expect(RAIL_NAV.some((e) => e.href === '/wallet')).toBe(true);
    expect(MOBILE_NAV.some((e) => e.href === '/wallet')).toBe(true);
    expect(RAIL_NAV[0]?.href).toBe('/home');
    expect(RAIL_NAV[1]?.href).toBe('/wallet');
  });

  it('Settings is on the rail but not the tab bar: it moves to the mobile header gear instead', () => {
    expect(RAIL_NAV.some((e) => e.href === '/settings')).toBe(true);
    expect(MOBILE_NAV.some((e) => e.href === '/settings')).toBe(false);
  });

  it('Add money (fund) stays exactly where it was, unchanged', () => {
    expect(RAIL_NAV.some((e) => e.href === '/fund' && e.label === 'Add money')).toBe(true);
    expect(MOBILE_NAV.some((e) => e.href === '/fund' && e.label === 'Add money')).toBe(true);
  });

  it('every mobile entry is also on the rail, in the same relative order', () => {
    const railHrefs = RAIL_NAV.map((e) => e.href);
    const mobileHrefs = MOBILE_NAV.map((e) => e.href);
    const positions = mobileHrefs.map((href) => railHrefs.indexOf(href));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('has no duplicate destinations on either list', () => {
    expect(new Set(RAIL_NAV.map((e) => e.href)).size).toBe(RAIL_NAV.length);
    expect(new Set(MOBILE_NAV.map((e) => e.href)).size).toBe(MOBILE_NAV.length);
  });
});
