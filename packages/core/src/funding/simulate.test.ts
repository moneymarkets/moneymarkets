import { describe, expect, it, vi } from 'vitest';
import { simulatePlan, type EthCall } from './simulate.js';
import type { SourceTxPlan } from './types.js';

/**
 * The simulation gate.
 *
 * The rule under test is the one that is easy to get wrong in both directions: a step
 * that cannot be checked must not be reported as passing, and must not block either.
 * Reporting it as a pass claims a check that never ran; reporting it as a failure blocks
 * a plan that is perfectly good and tells the user their money cannot move when it can.
 */

const APPROVE = `0x095ea7b3${'0'.repeat(128)}`;
const DEPOSIT = `0x7b939232${'0'.repeat(64)}`;
const FROM = '0x714f169Fe2D3990961B534D573f9646c037586E6';

function plan(...txs: { data: string; label: string }[]): SourceTxPlan {
  return {
    kind: 'wallet-signed',
    rail: 'across',
    chain: { id: 8453, key: 'base', displayName: 'Base', vm: 'evm' },
    txs: txs.map((t) => ({ chainId: 8453, to: '0xabc', data: t.data, value: '0', label: t.label })),
    raw: {},
  };
}

const ok: EthCall = async () => ({ ok: true });

describe('a plan is only offered when the chain has not already refused it', () => {
  it('passes a single step the chain accepts', async () => {
    const result = await simulatePlan(plan({ data: DEPOSIT, label: 'Send' }), FROM, ok);
    expect(result.executable).toBe(true);
    expect(result.steps[0]?.verdict).toBe('ok');
  });

  it('blocks on a real revert and keeps the chain’s own words', async () => {
    // The actual string the Base SpokePool produced on 2026-09-11.
    const reverting: EthCall = async () => ({
      ok: false,
      reason: 'ERC20: transfer amount exceeds allowance',
    });
    const result = await simulatePlan(plan({ data: DEPOSIT, label: 'Send' }), FROM, reverting);
    expect(result.executable).toBe(false);
    expect(result.blockedBy?.reason).toBe('ERC20: transfer amount exceeds allowance');
  });

  it('reports a decoded custom error verbatim', async () => {
    // What the Base USD₮0 adapter answered for an unwired Monad lane.
    const noPeer: EthCall = async () => ({ ok: false, reason: 'NoPeer(30390)' });
    const result = await simulatePlan(plan({ data: DEPOSIT, label: 'Send' }), FROM, noPeer);
    expect(result.blockedBy?.reason).toBe('NoPeer(30390)');
  });
});

describe('the step behind an approval is unchecked, not passed and not failed', () => {
  it('does not simulate the transfer that follows an approval', async () => {
    const call = vi.fn<EthCall>(async () => ({ ok: true }));
    const result = await simulatePlan(
      plan({ data: APPROVE, label: 'Approve' }, { data: DEPOSIT, label: 'Send' }),
      FROM,
      call,
    );
    // One call, for the approval. The deposit would revert on allowance every time.
    expect(call).toHaveBeenCalledTimes(1);
    expect(result.steps[1]?.verdict).toBe('unknown');
  });

  it('does not block on it', async () => {
    const result = await simulatePlan(
      plan({ data: APPROVE, label: 'Approve' }, { data: DEPOSIT, label: 'Send' }),
      FROM,
      ok,
    );
    expect(result.executable).toBe(true);
    expect(result.blockedBy).toBeUndefined();
  });

  it('says why it was not checked, rather than leaving a blank', async () => {
    const result = await simulatePlan(
      plan({ data: APPROVE, label: 'Approve' }, { data: DEPOSIT, label: 'Send' }),
      FROM,
      ok,
    );
    expect(result.steps[1]?.reason).toMatch(/approval that has not been signed/);
  });

  it('still blocks when the approval itself is refused', async () => {
    const reverting: EthCall = async () => ({ ok: false, reason: 'ERC20: approve to zero address' });
    const result = await simulatePlan(
      plan({ data: APPROVE, label: 'Approve' }, { data: DEPOSIT, label: 'Send' }),
      FROM,
      reverting,
    );
    expect(result.executable).toBe(false);
    expect(result.blockedBy?.label).toBe('Approve');
  });

  it('handles the three-step USDT plan: reset, approve, send', async () => {
    const call = vi.fn<EthCall>(async () => ({ ok: true }));
    const result = await simulatePlan(
      plan(
        { data: APPROVE, label: 'Clear' },
        { data: APPROVE, label: 'Approve' },
        { data: DEPOSIT, label: 'Send' },
      ),
      FROM,
      call,
    );
    // Both approvals are checkable against present state; only the send is not.
    expect(call).toHaveBeenCalledTimes(2);
    expect(result.steps.map((s) => s.verdict)).toEqual(['ok', 'ok', 'unknown']);
    expect(result.executable).toBe(true);
  });
});

describe('an unreachable node is not a refusal', () => {
  it('reports unknown and does not block when the call throws', async () => {
    const throwing: EthCall = async () => {
      throw new Error('fetch failed');
    };
    const result = await simulatePlan(plan({ data: DEPOSIT, label: 'Send' }), FROM, throwing);
    expect(result.steps[0]?.verdict).toBe('unknown');
    expect(result.executable).toBe(true);
  });
});
