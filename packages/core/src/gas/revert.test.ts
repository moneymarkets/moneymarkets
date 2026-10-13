import { describe, expect, it } from 'vitest';
import { encodeErrorResult, parseAbi, type Hex } from 'viem';
import { describeInnerRevert, unwrapAccountRevert } from './revert.js';

const ACCOUNT_ERRORS = parseAbi(['error ExecuteError(uint256 index, bytes innerError)']);
const SOLIDITY_ERROR = parseAbi(['error Error(string reason)']);

function encodeSolidityError(reason: string): Hex {
  return encodeErrorResult({ abi: SOLIDITY_ERROR, errorName: 'Error', args: [reason] });
}

function encodeExecuteError(index: bigint, inner: Hex): Hex {
  return encodeErrorResult({ abi: ACCOUNT_ERRORS, errorName: 'ExecuteError', args: [index, inner] });
}

describe('unwrapAccountRevert', () => {
  it('is undefined data for no revert data at all', () => {
    expect(unwrapAccountRevert(undefined)).toEqual({ data: undefined });
  });

  it('unwraps ExecuteError(index, inner) to the inner revert and the failing call index', () => {
    const inner = encodeSolidityError('InsufficientBalance');
    const wrapped = encodeExecuteError(1n, inner);
    const result = unwrapAccountRevert(wrapped);
    expect(result.data).toBe(inner);
    expect(result.callIndex).toBe(1);
  });

  it('passes through revert data that is not ExecuteError-wrapped (a single, unbatched execute)', () => {
    const plain = encodeSolidityError('Paused');
    expect(unwrapAccountRevert(plain)).toEqual({ data: plain });
  });
});

describe('describeInnerRevert', () => {
  it('names the failing call when the batch wraps it in ExecuteError', () => {
    const inner = encodeSolidityError('InsufficientBalance');
    const wrapped = encodeExecuteError(0n, inner);
    const message = describeInnerRevert(wrapped);
    expect(message).toContain('call 1 of the batch');
    expect(message).toContain('InsufficientBalance');
  });

  it('decodes a plain Error(string) revert with no wrapper', () => {
    const message = describeInnerRevert(encodeSolidityError('SizeError'));
    expect(message).toContain('The chain answered: “SizeError”');
    expect(message).not.toContain('batch');
  });

  it('says so honestly when there is no revert data at all', () => {
    expect(describeInnerRevert(undefined)).toBe('This would fail on chain, so nothing was sent. The chain gave no reason.');
  });
});
