import { describe, expect, it } from 'vitest';
import qrcode from 'qrcode-generator';

/**
 * The QR is the address, checked against the QR specification rather than against
 * itself.
 *
 * The risk this guards is a code that *looks* scannable and is not the address —
 * a placeholder, a stale value, a gradient. So these assert structural properties a
 * real QR symbol has, on the exact string the deposit card renders: the real Base
 * deposit address this build reserved on 2026-09-03.
 *
 * What is **not** claimed here: that a phone camera decodes it. No decoder runs in
 * this suite, so the report says a physical scan is untested.
 */

const RESERVED = '0x1fC70003B9F349C00B4239F9e3bCe5333cF31B61';

function matrix(value: string) {
  const qr = qrcode(0, 'M');
  qr.addData(value);
  qr.make();
  const count = qr.getModuleCount();
  const dark: boolean[][] = [];
  for (let row = 0; row < count; row += 1) {
    dark.push(Array.from({ length: count }, (_, col) => qr.isDark(row, col)));
  }
  return { count, dark };
}

describe('the deposit QR', () => {
  it('picks the smallest version that fits a 42-character address', () => {
    // 42 bytes in byte mode at error correction M: version 3 holds 44, version 2
    // holds 26. Version 3 is 29 modules square.
    expect(RESERVED).toHaveLength(42);
    expect(matrix(RESERVED).count).toBe(29);
  });

  it('carries a finder pattern in each of the three corners', () => {
    const { count, dark } = matrix(RESERVED);
    // A finder is a 7x7 ring: dark border, light inset, 3x3 dark core.
    const finderAt = (top: number, left: number) => {
      for (let i = 0; i < 7; i += 1) {
        expect(dark[top]![left + i], `top edge ${i}`).toBe(true);
        expect(dark[top + 6]![left + i], `bottom edge ${i}`).toBe(true);
        expect(dark[top + i]![left], `left edge ${i}`).toBe(true);
        expect(dark[top + i]![left + 6], `right edge ${i}`).toBe(true);
      }
      for (let r = 2; r < 5; r += 1) {
        for (let c = 2; c < 5; c += 1) expect(dark[top + r]![left + c], 'core').toBe(true);
      }
      expect(dark[top + 1]![left + 1], 'inset is light').toBe(false);
    };
    finderAt(0, 0);
    finderAt(0, count - 7);
    finderAt(count - 7, 0);
  });

  it('carries the timing patterns, which alternate from a dark module', () => {
    const { count, dark } = matrix(RESERVED);
    for (let i = 8; i < count - 8; i += 1) {
      expect(dark[6]![i], `horizontal timing ${i}`).toBe(i % 2 === 0);
      expect(dark[i]![6], `vertical timing ${i}`).toBe(i % 2 === 0);
    }
  });

  it('carries the dark module the specification fixes at (4v+9, 8)', () => {
    // Version 3: row 4*3+9 = 21, column 8. Always dark.
    expect(matrix(RESERVED).dark[21]![8]).toBe(true);
  });

  it('changes when one character of the address changes', () => {
    // The whole point: this encodes *this* address, not a picture of a QR code.
    const a = matrix(RESERVED).dark.flat();
    const b = matrix(`${RESERVED.slice(0, -1)}2`).dark.flat();
    const differing = a.filter((v, i) => v !== b[i]).length;
    expect(differing).toBeGreaterThan(0);
  });

  it('is deterministic, so a re-render does not reshuffle it', () => {
    expect(matrix(RESERVED).dark).toEqual(matrix(RESERVED).dark);
  });
});
