import { decodeErrorResult, parseAbi, type Hex } from 'viem';
import { kuruDetailFor } from '../kuru/errors.js';

/**
 * Decoding a sponsored batch's revert reason, one call deep.
 *
 * Copied verbatim (same ABIs, same algorithm) from `apps/relayer/src/selfBundle.ts`'s
 * `unwrapAccountRevert`/`describeInnerRevert` — the relayer's own, already-verified
 * decoding of a `Simple7702Account.executeBatch` revert — rather than a second,
 * independently-written decoder that could drift from it. It lives here, in `core`,
 * so the browser (`lib/server/simulateSponsoredBatch.ts`'s pre-sign gate) can reuse
 * the identical logic: `apps/relayer` and `apps/trade` are two different apps, not
 * two importers of one shared package, so the only way to reuse rather than
 * reimplement across that boundary is a shared copy in `core`. Nothing here is a new
 * decode — see `apps/relayer/src/selfBundle.ts` for the confirmation against the
 * deployed delegate on 2026-09-24 this ABI is based on.
 */

/**
 * `Simple7702Account.executeBatch` wraps a failing call as `ExecuteError(index, inner)`.
 * A single `execute` returns the target's revert data unwrapped.
 */
const ACCOUNT_ERRORS = parseAbi(['error ExecuteError(uint256 index, bytes innerError)']);
const SOLIDITY_ERRORS = parseAbi(['error Error(string reason)', 'error Panic(uint256 code)']);

export function unwrapAccountRevert(revertData: Hex | undefined): {
  readonly data: Hex | undefined;
  readonly callIndex?: number;
} {
  if (!revertData) return { data: undefined };
  try {
    // viem adds Error(string) and Panic(uint256) to any ABI it decodes errors with, so
    // the name is checked, not assumed.
    const decoded = decodeErrorResult({ abi: ACCOUNT_ERRORS, data: revertData });
    if (decoded.errorName !== 'ExecuteError') return { data: revertData };
    const [index, inner] = decoded.args as readonly [bigint, Hex];
    return { data: inner, callIndex: Number(index) };
  } catch {
    return { data: revertData };
  }
}

/**
 * The chain's reason in one line. The browser shows this verbatim as its detail (the
 * 2026-09-08 rule), and matches the raw selector in it to recognise Kuru's pause, so
 * the selector is kept even when the name is known.
 */
export function describeInnerRevert(revertData: Hex | undefined): string {
  const { data, callIndex } = unwrapAccountRevert(revertData);
  const where = callIndex === undefined ? '' : ` (call ${callIndex + 1} of the batch)`;
  const lead = `This would fail on chain, so nothing was sent${where}.`;
  if (!data || data === '0x') return `${lead} The chain gave no reason.`;
  try {
    const decoded = decodeErrorResult({ abi: SOLIDITY_ERRORS, data });
    if (decoded.errorName === 'Error')
      return `${lead} The chain answered: “${String(decoded.args[0])}”`;
    return `${lead} The chain answered: Panic(${String(decoded.args[0])})`;
  } catch {
    /* not a Solidity string or panic: read it as Kuru's */
  }
  const kuru = kuruDetailFor(data);
  if (!kuru) return `${lead} The chain answered with ${data}.`;
  const selector = data.slice(0, 10);
  return kuru.includes(selector) ? `${lead} ${kuru}` : `${lead} ${kuru} (${selector})`;
}
