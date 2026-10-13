/**
 * Slippage and minimum out (rule 1.2): the app computes the minimum itself from each
 * vendor's expected output and passes it to every vendor; a vendor default is never
 * used. Kuru Flow and KyberSwap both take `slippageTolerance` in basis points and
 * both were observed deriving their minimum as floor(expected x (10000 - bps) / 10000)
 * (reports/SWAP-VERIFY.md), which is exactly this function, so the minimum in the
 * calldata can be checked against it to the unit.
 */

export const SLIPPAGE_CHOICES_BPS = [10, 50, 100, 300] as const;
export type SlippageBps = (typeof SLIPPAGE_CHOICES_BPS)[number];
export const DEFAULT_SLIPPAGE_BPS: SlippageBps = 50;

export function isSlippageChoice(value: number): value is SlippageBps {
  return (SLIPPAGE_CHOICES_BPS as readonly number[]).includes(value);
}

export function minOutFor(expectedOut: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000) {
    throw new Error(`slippage must be a whole number of basis points below 10000, got ${slippageBps}`);
  }
  if (expectedOut < 0n) throw new Error('expected output cannot be negative');
  return (expectedOut * BigInt(10_000 - slippageBps)) / 10_000n;
}

/**
 * The smallest whole-bps slippage under which a vendor computing
 * floor(expected x (10000 - bps) / 10000) lands at or below `target`. Used when the
 * minimum has to come from a simulated delivery (a fee-on-transfer token) rather than
 * the vendor's own expected output. `undefined` when no slippage within `maxBps` can
 * reach it.
 */
export function bpsReaching(expectedOut: bigint, target: bigint, maxBps: number): number | undefined {
  if (expectedOut <= 0n) return undefined;
  if (target >= expectedOut) return 0;
  // Smallest bps with expected x (10000 - bps) <= target x 10000 (so the floor is <= target).
  const numerator = (expectedOut - target) * 10_000n;
  const bps = Number((numerator + expectedOut - 1n) / expectedOut);
  return bps <= maxBps ? bps : undefined;
}

/** "0.5%" for the quote block. */
export function slippageLabel(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const frac = bps % 100;
  if (frac === 0) return `${whole}%`;
  return `${whole}.${frac.toString().padStart(2, '0').replace(/0$/, '')}%`;
}
