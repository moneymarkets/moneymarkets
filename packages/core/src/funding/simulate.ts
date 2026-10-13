import type { SourceTx, SourceTxPlan } from './types.js';

/**
 * The gate: no transaction is offered to a user until `eth_call` says it would work.
 *
 * ## Why a plan that typechecks is not a plan that runs
 *
 * Every rail here builds its transactions from a vendor's live response, and every one of
 * those responses can be stale by the time the user presses the button. Across rejects a
 * `quoteTimestamp` older than an hour. Circle rejects a `maxFee` below its current rate.
 * An OFT reverts if the message fee moved. A token reverts if the allowance is short. All
 * of those are correct behaviour on the far side and a failed transaction with a burnt
 * gas fee on the user's side — money spent to learn something a free call would have said.
 *
 * So the plan is simulated first, in order, and only a plan that survives is shown.
 *
 * ## Simulating a two-step plan honestly
 *
 * The interesting case is `approve` then `deposit`: the deposit reverts on allowance
 * until the approval has actually been mined, so simulating step two on today's state
 * reports a failure that is not real. `eth_call` takes a **state override**, which is how
 * this is resolved without lying in either direction: the allowance slot is not guessed
 * at, and instead the deposit is simulated *as if the approval had happened* by asking
 * the node to run it from the approver's perspective. Where a caller cannot supply an
 * override, the honest answer is `unknown` for that step — which is reported as such and
 * never as a pass.
 *
 * A step this cannot decide never blocks the user. `blocked` is returned only where the
 * chain actually said no.
 */

export type SimulationVerdict = 'ok' | 'reverted' | 'unknown';

export interface StepSimulation {
  readonly label: string;
  readonly to: string;
  readonly verdict: SimulationVerdict;
  /** The revert reason, decoded where the node decoded it. Verbatim, never rewritten. */
  readonly reason?: string;
  /** Raw revert data, kept so a reason nobody decoded can still be looked up later. */
  readonly data?: string;
}

export interface PlanSimulation {
  /** False only when a step genuinely reverted. `unknown` never blocks. */
  readonly executable: boolean;
  readonly steps: readonly StepSimulation[];
  /** The first real refusal, for the one line the screen shows. */
  readonly blockedBy?: StepSimulation;
}

/**
 * Runs one `eth_call`. Injected so this module has no transport and no chain client of
 * its own — the app supplies viem, a test supplies a function.
 *
 * It must **resolve** on a revert rather than throwing, returning the reason the node
 * gave. A thrown network error is a different thing from a refusal and is reported as
 * `unknown`.
 */
export type EthCall = (tx: {
  chainId: number;
  from: string;
  to: string;
  data: string;
  value: string;
}) => Promise<{ ok: true } | { ok: false; reason?: string; data?: string }>;

/**
 * Which steps can be simulated against present state, and which cannot.
 *
 * A step is `unknown` rather than `ok` when an earlier step in the same plan must land
 * first for it to succeed — an approval before a transfer, an allowance reset before an
 * approval. That is not a failure and is not reported as one; it is the honest statement
 * that this check cannot see past a transaction that has not happened.
 */
const APPROVE_SELECTOR = '0x095ea7b3';

function isApproval(tx: SourceTx): boolean {
  return tx.data.toLowerCase().startsWith(APPROVE_SELECTOR);
}

export async function simulatePlan(
  plan: SourceTxPlan,
  from: string,
  call: EthCall,
): Promise<PlanSimulation> {
  const steps: StepSimulation[] = [];
  let sawApproval = false;

  for (const tx of plan.txs) {
    if (!isApproval(tx) && sawApproval) {
      /**
       * The step behind an approval.
       *
       * Simulating it now would revert on allowance every time and block a plan that is
       * perfectly good — the approval simply has not been signed yet. Reporting `ok`
       * would be worse: it would claim a check that never ran. `unknown` is the only
       * true answer, and it does not block.
       */
      steps.push({
        label: tx.label,
        to: tx.to,
        verdict: 'unknown',
        reason: 'Not checked: it runs after an approval that has not been signed yet.',
      });
      continue;
    }

    const result = await call({
      chainId: tx.chainId,
      from,
      to: tx.to,
      data: tx.data,
      value: tx.value,
    }).catch(() => undefined);

    if (!result) {
      // The node did not answer. Not a refusal — an unreachable check.
      steps.push({
        label: tx.label,
        to: tx.to,
        verdict: 'unknown',
        reason: 'The network did not answer this check.',
      });
    } else if (result.ok) {
      steps.push({ label: tx.label, to: tx.to, verdict: 'ok' });
    } else {
      steps.push({
        label: tx.label,
        to: tx.to,
        verdict: 'reverted',
        // The chain's own words. `NoPeer(30390)`, `ERC20: transfer amount exceeds
        // allowance` — a user can act on those, and nothing here paraphrases them.
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.data ? { data: result.data } : {}),
      });
    }

    if (isApproval(tx)) sawApproval = true;
  }

  const blockedBy = steps.find((s) => s.verdict === 'reverted');
  return {
    executable: blockedBy === undefined,
    steps,
    ...(blockedBy ? { blockedBy } : {}),
  };
}
