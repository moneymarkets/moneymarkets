'use client';

import {
  assertFreshPasskey,
  buildPermitCall,
  buildPermitMessage,
  isSponsorable,
  KURU_FLOW_ROUTER,
  MAX_SPONSORED_PERMIT_VALUE,
  permitTypedData,
  type MeraAccount,
  type PermitDomain,
  type PolicyContext,
} from '@tradepro/core';
import type { Address, Hex } from 'viem';
import { apiUrl } from '../basePath';
import { prewarmOperation } from '../fund/bundlerTransport';
import type { OnProgress, Progress } from '../ticket';
import { planFeeLeg, runWithGasCharge, type FeeLegPlan } from './gasCharge';
import { payWithPermit } from './swapQuote';
import {
  buildSwapBatch,
  isNative,
  routeToWire,
  type SwapCall,
  type SwapKind,
  type SwapRoute,
  type SwapSource,
} from './swapPlan';

export { payWithPermit, SWAP_PERMIT_PAY_TOKENS } from './swapQuote';

/**
 * Swap's execution: five checks under "Checking", then sign and send (rules 1.5, 1.6
 * and item 4). Every check has a 15 s ceiling and its own sentence, so a stuck call
 * says which step stuck instead of leaving the pill on "Checking" forever (the v2.1
 * acceptance run's 120 s hang, DECISIONS.md D186/D187). The bar fills one fifth per
 * finished check.
 *
 *   1. simulate   the ranked routes, best first; the first that passes is used (1.6)
 *   2. permit     the token's permit domain and nonce, only when Kuru Flow is paid by permit
 *   3. Face ID    a fresh passkey assertion, every time (spec section 6)
 *   4. prepare    sign the permit if any, build the exact batch, the relayer's own policy check
 *   5. gas quote  what the network fee costs and who pays it
 *
 * Nothing is re-quoted after the passkey prompt (rule 1.5): a quote that went stale
 * during it is refused, not refreshed.
 */

export const SWAP_STEP_TIMEOUT_MS = 15_000;
export const SWAP_DEADLINE_SECONDS = 300;

export type SwapStep = 'simulate' | 'permit' | 'passkey' | 'prepare' | 'gas';
export const SWAP_CHECK_COUNT = 5;

/** Item 4: one sentence per step, naming it. */
export const SWAP_STEP_TIMEOUT_MESSAGES: Readonly<Record<SwapStep, string>> = {
  simulate: 'Checking this swap on chain took longer than 15 seconds. Nothing was signed. Try again.',
  permit: 'Reading the token permit took longer than 15 seconds. Nothing was signed. Try again.',
  passkey: 'Face ID did not finish within 15 seconds. Nothing was signed.',
  prepare: 'Preparing the swap took longer than 15 seconds. Nothing was signed. Try again.',
  gas: 'Pricing the network fee took longer than 15 seconds. Nothing was signed. Try again.',
};

const STEP_NOTES: Readonly<Record<SwapStep, string>> = {
  simulate: 'Checking on chain',
  permit: 'Reading the permit',
  passkey: 'Face ID',
  prepare: 'Preparing',
  gas: 'Pricing the fee',
};

export class SwapStepTimeout extends Error {
  constructor(readonly step: SwapStep) {
    super(SWAP_STEP_TIMEOUT_MESSAGES[step]);
    this.name = 'SwapStepTimeout';
  }
}

/** Race `work` against the step's ceiling. The signal aborts the step's own fetch. */
export async function withStepTimeout<T>(
  step: SwapStep,
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs = SWAP_STEP_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SwapStepTimeout(step));
    }, timeoutMs);
  });
  try {
    return await Promise.race([work(controller.signal), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The quote route's answer, parsed. */
export interface SwapQuote {
  readonly kind: SwapKind;
  readonly routes: readonly SwapRoute[];
  /** Index into `routes` of the route the quote offered, or null. */
  readonly offered: number | null;
  readonly deliverNative?: boolean;
  /** Epoch ms the browser received it (rule 1.5 ages it from here, never from the server). */
  readonly receivedAt: number;
}

export interface SwapExecuteInput {
  readonly account: MeraAccount;
  readonly marginAccount: Address;
  readonly payToken: Address;
  readonly receiveToken: Address;
  readonly amountIn: bigint;
  readonly source: SwapSource;
  readonly quote: SwapQuote;
  readonly rpId: string;
  readonly quoteMaxAgeMs: number;
  readonly onProgress: OnProgress;
  readonly perfActionId?: string;
  readonly onFeePlan?: (plan: FeeLegPlan) => void;
  /** Rule 1.6: fired when the simulation settles on a route other than the offered one. */
  readonly onRouteChosen?: (route: SwapRoute) => void;
  /** Step 2. Injected so the page can reuse its own permit reader. */
  readonly readPermit?: (signal: AbortSignal) => Promise<{ domain: PermitDomain; nonce: bigint } | undefined>;
  /** Tests inject; production uses the real fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Tests shorten it; production is SWAP_STEP_TIMEOUT_MS. */
  readonly stepTimeoutMs?: number;
}

function refused(onProgress: OnProgress, message: string): Progress {
  const progress: Progress = { state: 'REJECTED', message, refusedAtChecking: true };
  onProgress(progress);
  return progress;
}

export function policyForSwap(marginAccount: Address, tokenIn: Address, sender: Address): PolicyContext {
  return { marginAccount, permitTokens: [tokenIn], sender };
}

/** The relayer's own check on the exact batch, before it ever reaches the network. */
export function sponsorWouldAcceptSwap(
  marginAccount: Address,
  tokenIn: Address,
  sender: Address,
  calls: readonly SwapCall[],
): boolean {
  return isSponsorable(
    calls.map((c) => ({ to: c.to, data: c.data, value: c.value ?? 0n })),
    policyForSwap(marginAccount, tokenIn, sender),
  );
}

interface SimulateAnswer {
  readonly chosen: number | null;
  readonly deliverNative?: boolean;
  readonly revert?: string;
  readonly direct?: boolean;
}

export async function swap(input: SwapExecuteInput): Promise<Progress> {
  const doFetch = input.fetchImpl ?? fetch;
  const { quote, onProgress } = input;
  const stepMs = input.stepTimeoutMs ?? SWAP_STEP_TIMEOUT_MS;
  let done = 0;
  const report = (step: SwapStep) =>
    onProgress({ state: 'VALIDATING', stageNote: STEP_NOTES[step], checking: { done, of: SWAP_CHECK_COUNT } });
  const finished = () => {
    done += 1;
  };

  try {
    // Rule 1.5, checked at the tap: an old quote is never signed.
    if (Date.now() - quote.receivedAt >= input.quoteMaxAgeMs) {
      return refused(onProgress, 'This price is more than 20 seconds old. Get a new price first.');
    }
    if (input.amountIn <= 0n) return refused(onProgress, 'Enter an amount to swap.');

    // 1. Simulate the ranked routes, best first, and take the first that passes.
    report('simulate');
    const ordered =
      quote.kind === 'aggregated' && quote.offered !== null
        ? [...quote.routes.slice(quote.offered), ...quote.routes.slice(0, quote.offered)]
        : [];
    const answer = await withStepTimeout('simulate', async (signal): Promise<SimulateAnswer> => {
      // A check that could not run is not evidence either way: fall back to the route the
      // quote already simulated and offered. Only a timeout stops the swap here.
      const unchecked: SimulateAnswer = {
        chosen: 0,
        ...(quote.deliverNative !== undefined ? { deliverNative: quote.deliverNative } : {}),
      };
      let res: Response;
      try {
        res = await doFetch(apiUrl('/api/wallet/swap/simulate'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal,
        body: JSON.stringify({
          sender: input.account.address,
          tokenIn: input.payToken,
          tokenOut: input.receiveToken,
          amountIn: input.amountIn.toString(),
          source: input.source,
          routes: ordered.map(routeToWire),
        }),
        });
      } catch (error) {
        if (signal.aborted) throw error;
        return unchecked;
      }
      if (!res.ok) return unchecked;
      try {
        return (await res.json()) as SimulateAnswer;
      } catch {
        return unchecked;
      }
    }, stepMs);
    let route: SwapRoute | undefined;
    let deliverNative = false;
    if (quote.kind === 'aggregated') {
      if (answer.chosen === null || answer.chosen === undefined) {
        return refused(onProgress, answer.revert ?? 'None of the routes would go through right now. Nothing was signed.');
      }
      route = ordered[answer.chosen];
      if (!route) return refused(onProgress, 'The swap check chose a route that was not offered. Nothing was signed.');
      deliverNative = answer.deliverNative === true;
      if (answer.chosen !== 0) input.onRouteChosen?.(route);
    } else if (answer.revert) {
      return refused(onProgress, answer.revert);
    }
    finished();

    // 2. The permit's domain and nonce, read closest to the signature. Only Kuru Flow is
    //    paid by permit, and never when the input is native MON (it is wrapped first).
    const usePermit =
      route !== undefined && route.vendor === 'kuru-flow' && !isNative(input.payToken) && payWithPermit(route.tokenIn);
    let permitFields: { domain: PermitDomain; nonce: bigint } | undefined;
    if (usePermit) {
      report('permit');
      if (!input.readPermit) return refused(onProgress, 'Could not read a fresh permit for this token. Try again.');
      permitFields = await withStepTimeout('permit', (signal) => input.readPermit!(signal), stepMs);
      if (!permitFields) return refused(onProgress, 'Could not read a fresh permit for this token. Try again.');
      if (input.amountIn > MAX_SPONSORED_PERMIT_VALUE) {
        return refused(
          onProgress,
          `Swap amounts above ${MAX_SPONSORED_PERMIT_VALUE} base units are not sponsored. Reduce the amount.`,
        );
      }
    }
    finished();

    // 3. A fresh passkey assertion, before anything is signed.
    report('passkey');
    try {
      await withStepTimeout('passkey', () =>
        assertFreshPasskey({
          rpId: input.rpId,
          ...(input.account.credentialId ? { credentialId: input.account.credentialId } : {}),
        }),
        stepMs,
      );
    } catch (error) {
      if (error instanceof SwapStepTimeout) throw error;
      return refused(onProgress, 'Face ID was not confirmed, so nothing was sent.');
    }
    // Rule 1.5: signed only while under the age limit, and never re-quoted after the
    // prompt, so a price that aged out during it is refused rather than refreshed.
    if (Date.now() - quote.receivedAt >= input.quoteMaxAgeMs) {
      return refused(onProgress, 'This price expired while confirming. Get a new price and try again.');
    }
    finished();

    // 4. Prepare: sign the permit if any, build the exact batch, and run the relayer's
    //    own policy on it.
    report('prepare');
    const calls = await withStepTimeout('prepare', async () => {
      let allowance: { kind: 'approve' } | { kind: 'permit'; call: SwapCall } = { kind: 'approve' };
      if (usePermit && permitFields && route) {
        const message = buildPermitMessage({
          owner: input.account.address,
          spender: KURU_FLOW_ROUTER,
          marginAccount: input.marginAccount,
          value: input.amountIn,
          nonce: permitFields.nonce,
          deadlineSeconds: SWAP_DEADLINE_SECONDS,
        });
        const signature: Hex = await input.account.account.signTypedData(permitTypedData(message, permitFields.domain));
        const permitCall = buildPermitCall(route.tokenIn, message, signature);
        allowance = { kind: 'permit', call: { to: permitCall.to, data: permitCall.data } };
      }
      return buildSwapBatch({
        kind: quote.kind,
        marginAccount: input.marginAccount,
        payToken: input.payToken,
        amountIn: input.amountIn,
        source: input.source,
        ...(route ? { route } : {}),
        allowance,
        deliverNative,
      });
    }, stepMs).catch((error: unknown) => {
      if (error instanceof SwapStepTimeout) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`That could not be prepared. Nothing was signed and nothing was sent. ${message}`.trim());
    });
    const spendToken = route?.tokenIn ?? input.payToken;
    if (!sponsorWouldAcceptSwap(input.marginAccount, spendToken, input.account.address, calls)) {
      return refused(onProgress, 'This would not be sponsored. Nothing was sent.');
    }
    // What is kept afterwards drops the permit's bearer signature (rule A4).
    const logCalls = calls.filter((c) => c.data.slice(0, 10).toLowerCase() !== '0xd505accf');
    finished();

    // 5. The gas quote: who pays the network fee. The estimate is pre-warmed alongside it
    //    (R9); it is used only if the batch sent is exactly these calls (a free action).
    report('gas');
    prewarmOperation(input.account.account, { sender: input.account.address, calls });
    const plan = await withStepTimeout('gas', () =>
      planFeeLeg({ sender: input.account.address, calls }),
    stepMs);
    input.onFeePlan?.(plan);
    finished();
    onProgress({ state: 'VALIDATING', stageNote: STEP_NOTES.gas, checking: { done, of: SWAP_CHECK_COUNT } });

    return await runWithGasCharge({
      sender: input.account.address,
      actionCalls: calls,
      logCalls,
      purpose: 'swap',
      marginAccount: input.marginAccount,
      onProgress,
      owner: input.account.account,
      plan,
      ...(input.perfActionId ? { perfActionId: input.perfActionId } : {}),
    });
  } catch (error) {
    if (error instanceof SwapStepTimeout) return refused(onProgress, error.message);
    return refused(onProgress, error instanceof Error ? error.message : String(error));
  }
}
