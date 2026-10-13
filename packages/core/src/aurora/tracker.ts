/**
 * The deposit tracker's state machine — one definition per step, one evidence source
 * per step, one transition rule set. Every screen that draws the five-step card and
 * every screen that draws a one-line outcome reads this module rather than deriving
 * its own idea of what step a deposit is on.
 *
 * ## Why this exists
 *
 * Before this, "delivered" meant exactly one thing: the vendor's own status reached
 * `SUCCESS`. A deposit that had genuinely arrived on Monad — provable by
 * `eth_getTransactionReceipt` on the vendor's own reported hash, or by the recipient's
 * balance actually rising with a matching `Transfer` log — stayed on "Bridging to
 * Monad" for as long as the vendor's status endpoint lagged, because nothing else was
 * ever allowed to light step 4. That is the bug this module closes: **chain evidence
 * outranks vendor status**, in both directions — it can prove a step done the vendor
 * has not yet confirmed, and it is never contradicted by a vendor claim that is not
 * backed by anything this app checked itself (`vendor SUCCESS with no hash yet` stays
 * on step 3 until a receipt exists — see the tests).
 *
 * ## The five steps
 *
 *   1. Waiting for your transfer   — done once the row exists.
 *   2. Seen on <source chain>      — done once a transfer to the deposit address is
 *                                    observed on the source chain, by our own watcher
 *                                    or by the vendor's own report, whichever first.
 *   3. Bridging to Monad           — active once 2 is done and 4 is not; done once 4
 *                                    is.
 *   4. In your wallet              — done once a destination transaction on Monad is
 *                                    confirmed by this app's own chain read.
 *   5. In your trading balance     — done once the move is confirmed or the margin
 *                                    balance has actually risen, whichever first.
 *
 * ## Monotonic, always
 *
 * A step never un-ticks. Evidence for a later step marks every earlier step done, with
 * `inferredFromStep` recorded so the tooltip can say so. `previousMaxStep` is an
 * explicit defence beyond that: even if a caller's input regressed for any reason (a
 * stale re-render, a late duplicate event), the steps already shown done stay done.
 */

export type TrackerStepId = 1 | 2 | 3 | 4 | 5;

export interface EvidenceRef {
  /** Where this evidence came from — 'our-watcher-solana', 'vendor:relay', 'eth_getTransactionReceipt', 'balance-poll', 'move-tx', 'margin-read', etc. */
  readonly source: string;
  readonly hash?: string;
  readonly explorerUrl?: string;
  readonly block?: string;
  readonly amount?: string;
  readonly at: number;
  /** The raw payload that produced this evidence, verbatim, for the tap-to-expand detail. */
  readonly raw?: unknown;
}

export type StepStatus = 'done' | 'active' | 'pending';

export interface StepState {
  readonly id: TrackerStepId;
  readonly label: string;
  readonly detail: string;
  readonly status: StepStatus;
  readonly evidence?: EvidenceRef;
  /** Set when this step's evidence is standing in for a step that has none of its own. */
  readonly inferredFromStep?: TrackerStepId;
  readonly slow?: { readonly sinceMinutes: number; readonly message: string };
}

export interface TerminalInfo {
  readonly kind: 'REFUNDED' | 'EXPIRED' | 'FAILED';
  readonly atStep: TrackerStepId;
  /**
   * The one line the stopped step shows in place of its in-progress label, so a
   * returned deposit never reads "Bridging to Monad": "Returned to your Solana address".
   */
  readonly headline: string;
  /** The vendor's own words, verbatim. Never a sentence this app invented. */
  readonly reason: string;
  /** True when `reason` is the vendor's own word; false when the vendor has given none yet. */
  readonly reasonFromVendor: boolean;
  readonly refundTxHash?: string;
  readonly refundExplorerUrl?: string;
  /** What came back, in origin-token base units, and what proved it. */
  readonly returned?: {
    readonly amount: string;
    readonly symbol: string;
    readonly decimals: number;
    readonly chainName: string;
    /** 'chain' when this app saw the refund transaction itself; 'vendor' when only the vendor reported it. */
    readonly seenBy: 'chain' | 'vendor';
  };
  /** Stated, never guessed: where the money went, in one sentence. */
  readonly whereItWent: string;
}

export interface TrackerState {
  readonly steps: readonly StepState[];
  readonly terminal?: TerminalInfo;
  /** Highest step reached — the terminal step if one exists, else the highest done step. */
  readonly currentStep: TrackerStepId;
}

export interface EvidenceInput {
  readonly hash?: string;
  readonly block?: string;
  readonly amount?: string;
  readonly source: string;
  readonly at: number;
  readonly raw?: unknown;
}

export interface SettlementInput {
  readonly moveConfirmed: boolean;
  readonly marginIncreased: boolean;
  readonly moveTxHash?: string;
  readonly baselineBlock?: string;
  readonly currentBlock?: string;
  readonly at?: number;
}

export interface TrackerInput {
  readonly chainName: string;
  readonly outToken: string;
  readonly landsIn: 'wallet' | 'margin';
  readonly createdAt: number;
  readonly now: number;

  /** The vendor's quoted delivery time at issuance. Undefined means no slow-state claim is made. */
  readonly etaSeconds?: number;
  readonly expiresAt?: number;

  readonly sourceEvidence?: EvidenceInput;

  /** The vendor's own current word — 'PENDING_DEPOSIT', 'PROCESSING', 'SUCCESS', etc. */
  readonly vendorStatus: string;
  readonly vendorTerminalStatus?: string | null;
  readonly vendorRaw?: unknown;
  readonly vendorRawAt?: number;

  readonly refundReason?: string | null;
  readonly refundTxHash?: string | null;
  readonly refundExplorerUrl?: string | null;
  readonly refundTo?: string;
  /** The vendor's own reported refund amount, origin-token base units. */
  readonly refundAmount?: string | null;
  /**
   * A transfer back to the depositor's source address, seen by this app's own read of
   * the source chain. Ends the tracker as returned whatever the vendor still says.
   */
  readonly refundEvidence?: EvidenceInput;
  /** The origin token, for naming the returned amount. */
  readonly originSymbol?: string;
  readonly originDecimals?: number;
  /**
   * When anything about this deposit last changed: a status, a piece of evidence. The
   * slow-state threshold (three times the quoted eta) is measured from here, so a
   * deposit that is still moving is never called slow.
   */
  readonly lastChangeAt?: number;

  readonly destinationEvidence?: EvidenceInput;

  readonly settlement?: SettlementInput;

  /** The highest step a previous read of this same deposit already showed done. */
  readonly previousMaxStep?: TrackerStepId;
}

const LABELS: Record<TrackerStepId, { label: (chainName: string, outToken: string) => string; detail: string }> = {
  1: { label: () => 'Waiting for your transfer', detail: 'We watch the address for you' },
  2: { label: (chainName) => `Seen on ${chainName}`, detail: 'Your transfer confirmed there' },
  3: { label: () => 'Bridging to Monad', detail: 'The bridge is delivering' },
  4: { label: () => 'In your wallet', detail: 'Arrived on Monad' },
  5: { label: () => 'In your trading balance', detail: 'Ready to trade' },
};

const SLOW_MULTIPLE = 3;

function slowMessage(activeSinceMs: number, now: number): { sinceMinutes: number; message: string } {
  const sinceMinutes = Math.max(1, Math.round((now - activeSinceMs) / 60_000));
  return {
    sinceMinutes,
    message: `Taking longer than usual, ${sinceMinutes} minute${sinceMinutes === 1 ? '' : 's'} so far`,
  };
}

/**
 * Whether an in-flight deposit has gone three times its quoted eta with nothing
 * changing. Exported so the watcher uses the same rule to decide when to re-check both
 * chains and the vendor as the screen uses to say so.
 */
export function isSlow(input: {
  readonly etaSeconds: number | null | undefined;
  readonly lastChangeAt: number;
  readonly now: number;
}): boolean {
  if (input.etaSeconds === undefined || input.etaSeconds === null || input.etaSeconds <= 0) return false;
  return input.now - input.lastChangeAt > input.etaSeconds * SLOW_MULTIPLE * 1000;
}

export function deriveTrackerState(input: TrackerInput): TrackerState {
  const { chainName, outToken, landsIn } = input;

  // Step 1 is trivially done — the card only ever renders for a row that was issued
  // and recorded.
  const step1Evidence: EvidenceRef = { source: 'deposits-row', at: input.createdAt };

  // Money that came back from the deposit address was, by definition, at the deposit
  // address: a refund seen on the source chain is step 2's evidence too.
  const step2Raw = Boolean(input.sourceEvidence || input.refundEvidence);
  const destinationDone = Boolean(input.destinationEvidence);

  // Chain beats vendor: once destination evidence exists, nothing the vendor says can
  // hold steps 1-3 back, and a source-hop this app never watched directly (Relay,
  // CCTP) is inferred from the same proof that the money arrived at all.
  const step2Done = step2Raw || destinationDone;
  const step2Evidence: EvidenceRef | undefined = input.sourceEvidence
    ? {
        source: input.sourceEvidence.source,
        ...(input.sourceEvidence.hash ? { hash: input.sourceEvidence.hash } : {}),
        at: input.sourceEvidence.at,
        ...(input.sourceEvidence.raw !== undefined ? { raw: input.sourceEvidence.raw } : {}),
      }
    : input.refundEvidence
      ? { source: input.refundEvidence.source, at: input.refundEvidence.at }
    : destinationDone && input.destinationEvidence
      ? {
          source: input.destinationEvidence.source,
          at: input.destinationEvidence.at,
          ...(input.destinationEvidence.hash ? { hash: input.destinationEvidence.hash } : {}),
        }
      : undefined;

  const step3Done = destinationDone;
  const vendorRawEvidence: EvidenceRef | undefined =
    input.vendorRaw !== undefined && input.vendorRawAt !== undefined
      ? { source: `vendor:${input.vendorStatus}`, at: input.vendorRawAt, raw: input.vendorRaw }
      : undefined;

  // Landing straight in the margin account has no separate "in your wallet" hop — the
  // same evidence satisfies steps 4 and 5 together, step 5 inferred from step 4.
  //
  // For a wallet-landing rail, step 5 additionally requires step 4's own evidence
  // (security review finding M1): `settlement` is a plain balance comparison with no
  // idea which deposit raised it, so without this gate a margin balance that rose for
  // any reason — a different deposit, a fill, an unrelated move — could tick "in your
  // trading balance" on a deposit still sitting mid-bridge, before its own money had
  // gone anywhere.
  const settlement = input.settlement;
  const step5RawDone =
    landsIn === 'margin'
      ? destinationDone
      : destinationDone && Boolean(settlement?.moveConfirmed || settlement?.marginIncreased);
  const step4RawDone = landsIn === 'margin' ? step5RawDone : destinationDone;

  const step4Evidence: EvidenceRef | undefined =
    landsIn === 'margin'
      ? settlementEvidence(settlement, true)
      : input.destinationEvidence
        ? {
            source: input.destinationEvidence.source,
            ...(input.destinationEvidence.hash ? { hash: input.destinationEvidence.hash } : {}),
            ...(input.destinationEvidence.block ? { block: input.destinationEvidence.block } : {}),
            ...(input.destinationEvidence.amount ? { amount: input.destinationEvidence.amount } : {}),
            at: input.destinationEvidence.at,
          }
        : undefined;

  const step5Evidence: EvidenceRef | undefined =
    landsIn === 'margin' ? step4Evidence : settlementEvidence(settlement, false);

  // Never claim completion without evidence: a vendor SUCCESS with no hash we can
  // confirm ourselves does not move the tracker past "bridging".
  const rawDone: Record<TrackerStepId, boolean> = {
    1: true,
    2: step2Done,
    3: step3Done,
    4: step4RawDone,
    5: step5RawDone,
  };

  // The monotonic guard: whatever was shown done before stays done.
  const previousMaxStep = input.previousMaxStep ?? 0;
  const done: Record<TrackerStepId, boolean> = {
    1: rawDone[1] || previousMaxStep >= 1,
    2: rawDone[2] || previousMaxStep >= 2,
    3: rawDone[3] || previousMaxStep >= 3,
    4: rawDone[4] || previousMaxStep >= 4,
    5: rawDone[5] || previousMaxStep >= 5,
  };

  // Terminal failure only applies where chain evidence has not already proven the
  // deposit arrived — chain evidence overrides a lagging or wrong vendor terminal word
  // entirely, including a stale REFUNDED/FAILED that a later delivery superseded.
  const terminal = destinationDone ? undefined : deriveTerminal(input, step2Raw);

  const steps: StepState[] = ([1, 2, 3, 4, 5] as const).map((id) => {
    const meta = LABELS[id];
    const isDone = done[id];
    let status: StepStatus = isDone ? 'done' : 'pending';
    let evidence: EvidenceRef | undefined;
    let inferredFromStep: TrackerStepId | undefined;
    let slow: StepState['slow'];

    if (id === 1) {
      evidence = step1Evidence;
    } else if (id === 2) {
      evidence = step2Evidence;
      if (isDone && !step2Raw && destinationDone) inferredFromStep = 4;
    } else if (id === 3) {
      if (isDone) {
        evidence = step4Evidence ?? vendorRawEvidence;
        if (destinationDone) inferredFromStep = 4;
      } else if (step2Done && !terminal) {
        status = 'active';
        evidence = vendorRawEvidence;
        if (input.sourceEvidence) {
          const activeSince = input.sourceEvidence.at;
          const lastChangeAt = Math.max(activeSince, input.lastChangeAt ?? activeSince);
          if (isSlow({ etaSeconds: input.etaSeconds, lastChangeAt, now: input.now })) {
            slow = slowMessage(activeSince, input.now);
          }
        }
      }
    } else if (id === 4) {
      evidence = step4Evidence;
    } else if (id === 5) {
      evidence = step5Evidence;
      if (isDone && landsIn === 'margin') inferredFromStep = 4;
    }

    return {
      id,
      label: meta.label(chainName, outToken),
      detail: meta.detail,
      status,
      ...(evidence ? { evidence } : {}),
      ...(inferredFromStep ? { inferredFromStep } : {}),
      ...(slow ? { slow } : {}),
    };
  });

  const highestDone = ([5, 4, 3, 2, 1] as const).find((id) => done[id]) ?? 1;
  const currentStep = terminal ? terminal.atStep : highestDone;

  return { steps, ...(terminal ? { terminal } : {}), currentStep };
}

function settlementEvidence(settlement: SettlementInput | undefined, direct: boolean): EvidenceRef | undefined {
  if (!settlement) return undefined;
  if (settlement.marginIncreased) {
    return {
      source: direct ? 'margin-direct' : 'margin-read',
      at: settlement.at ?? Date.now(),
      ...(settlement.baselineBlock ? { block: `${settlement.baselineBlock} -> ${settlement.currentBlock ?? '?'}` } : {}),
    };
  }
  if (settlement.moveConfirmed) {
    return {
      source: 'move-tx',
      at: settlement.at ?? Date.now(),
      ...(settlement.moveTxHash ? { hash: settlement.moveTxHash } : {}),
    };
  }
  return undefined;
}

/**
 * Which outcome, if any, ends this deposit.
 *
 * Terminal states win over in-progress ones, and evidence from either chain wins over a
 * lagging vendor word:
 *
 *   - a refund seen on the source chain ends it as returned, even while the vendor
 *     still says PROCESSING;
 *   - a vendor REFUNDED ends it as returned before the refund transaction is seen, and
 *     says the transaction has not been seen yet;
 *   - a vendor FAILED with a refund seen on chain is a return, not a failure: the
 *     money came back, and that is the fact the user needs;
 *   - an address whose window closed (the quote's own deadline, or the vendor's
 *     EXPIRED) with nothing ever sent ends as expired.
 *
 * Delivery seen on Monad is handled by the caller before this runs, and outranks all of
 * the above.
 */
function deriveTerminal(input: TrackerInput, step2Done: boolean): TerminalInfo | undefined {
  const { vendorTerminalStatus } = input;
  const refundEvidence = input.refundEvidence;
  const vendorRefundHash = input.refundTxHash ? input.refundTxHash : undefined;
  const vendorReason = input.refundReason ? input.refundReason : undefined;

  if (refundEvidence || vendorTerminalStatus === 'REFUNDED') {
    const refundTxHash = refundEvidence?.hash ?? vendorRefundHash;
    const chainAmount = refundEvidence?.amount;
    const vendorAmount = input.refundAmount && input.refundAmount !== '0' ? input.refundAmount : undefined;
    const amount = chainAmount ?? vendorAmount;
    const returned =
      amount && input.originSymbol && input.originDecimals !== undefined
        ? {
            amount,
            symbol: input.originSymbol,
            decimals: input.originDecimals,
            chainName: input.chainName,
            seenBy: chainAmount ? ('chain' as const) : ('vendor' as const),
          }
        : undefined;
    return {
      kind: 'REFUNDED',
      atStep: step2Done ? 3 : 2,
      headline: `Returned to your ${input.chainName} address`,
      reason: vendorReason ?? 'No reason given yet.',
      reasonFromVendor: vendorReason !== undefined,
      ...(refundTxHash ? { refundTxHash } : {}),
      ...(refundTxHash && input.refundExplorerUrl ? { refundExplorerUrl: input.refundExplorerUrl } : {}),
      ...(returned ? { returned } : {}),
      whereItWent: refundTxHash
        ? `Returned to ${input.refundTo ?? 'the address it came from'}.`
        : `The vendor reports this returned. The refund transaction has not been seen on ${input.chainName} yet.`,
    };
  }

  if (vendorTerminalStatus === 'FAILED') {
    return {
      kind: 'FAILED',
      atStep: step2Done ? 3 : 2,
      headline: 'Did not complete',
      reason: vendorReason ?? 'No reason given yet.',
      reasonFromVendor: vendorReason !== undefined,
      whereItWent: 'The vendor reports this failed. No funds were reported moved.',
    };
  }

  const windowClosed =
    input.vendorStatus === 'EXPIRED' || (input.expiresAt !== undefined && input.now >= input.expiresAt);
  if (!step2Done && !vendorTerminalStatus && windowClosed) {
    return {
      kind: 'EXPIRED',
      atStep: 1,
      headline: 'Expired, nothing was sent',
      reason: 'The deposit window closed with nothing sent.',
      reasonFromVendor: false,
      whereItWent: 'Nothing was sent, so nothing moved.',
    };
  }

  return undefined;
}

/**
 * The fields of a `deposit_attempts` row the tracker reads. Every screen and the
 * reconcile script build their input through `trackerInputFromRow`, so they cannot
 * assemble two different ideas of the same deposit.
 */
export interface TrackerRow {
  readonly chain: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly lastStatus: string;
  readonly terminalStatus: string | null;
  readonly sourceLandedAt: number | null;
  readonly sourceTxHash: string | null;
  readonly sourceEvidenceSource: string | null;
  readonly sourceTxAt: number | null;
  readonly vendorRawJson?: string | null;
  readonly vendorRawAt?: number | null;
  readonly etaSeconds: number | null;
  readonly outToken?: string | null;
  readonly landsIn: string | null;
  readonly destinationTxHash: string | null;
  readonly destinationTxBlock: string | null;
  readonly destinationEvidenceSource: string | null;
  readonly destinationDetectedAt: number | null;
  readonly amountOut?: string | null;
  readonly refundTxHash: string | null;
  readonly refundExplorerUrl: string | null;
  readonly refundReason: string | null;
  readonly refundAmount?: string | null;
  readonly refundTo: string;
  readonly originSymbol?: string;
  readonly originDecimals?: number;
  readonly refundEvidenceHash?: string | null;
  readonly refundEvidenceSource?: string | null;
  readonly refundEvidenceAmount?: string | null;
  readonly refundEvidenceAt?: number | null;
  readonly detectedAt?: number | null;
  readonly lastChangeAt?: number | null;
}

export function trackerInputFromRow(
  row: TrackerRow,
  options: {
    readonly now: number;
    readonly chainName?: string;
    readonly outToken?: string;
    readonly landsIn?: 'wallet' | 'margin';
    readonly etaSeconds?: number;
    readonly settlement?: SettlementInput;
    /** Builds a refund link on a verified explorer; a vendor-supplied URL is never used. */
    readonly explorerUrl?: (chain: string, hash: string) => string | undefined;
  },
): TrackerInput {
  const chainName = row.chain || options.chainName || 'the source chain';
  const refundHash = row.refundEvidenceHash || row.refundTxHash || undefined;
  const refundExplorerUrl = refundHash ? options.explorerUrl?.(row.chain, refundHash) : undefined;
  const etaSeconds = row.etaSeconds ?? options.etaSeconds;
  const lastChangeAt = Math.max(
    row.createdAt,
    row.lastChangeAt ?? 0,
    row.sourceTxAt ?? 0,
    row.sourceLandedAt ?? 0,
    row.detectedAt ?? 0,
  );
  let vendorRaw: unknown;
  if (row.vendorRawJson) {
    try {
      vendorRaw = JSON.parse(row.vendorRawJson);
    } catch {
      vendorRaw = undefined;
    }
  }
  return {
    chainName,
    outToken: row.outToken ?? options.outToken ?? 'USDC',
    landsIn: row.landsIn === 'margin' ? 'margin' : (options.landsIn ?? 'wallet'),
    createdAt: row.createdAt,
    now: options.now,
    ...(etaSeconds !== undefined ? { etaSeconds } : {}),
    expiresAt: row.expiresAt,
    lastChangeAt,
    ...(row.sourceTxHash || row.sourceLandedAt
      ? {
          sourceEvidence: {
            source: row.sourceEvidenceSource ?? 'our-watcher',
            ...(row.sourceTxHash ? { hash: row.sourceTxHash } : {}),
            at: row.sourceTxAt ?? row.sourceLandedAt ?? row.createdAt,
          },
        }
      : {}),
    vendorStatus: row.lastStatus,
    vendorTerminalStatus: row.terminalStatus,
    ...(vendorRaw !== undefined ? { vendorRaw, vendorRawAt: row.vendorRawAt ?? row.createdAt } : {}),
    refundReason: row.refundReason,
    refundTxHash: row.refundTxHash || null,
    refundExplorerUrl: refundExplorerUrl ?? null,
    refundTo: row.refundTo,
    refundAmount: row.refundAmount ?? null,
    ...(row.originSymbol !== undefined ? { originSymbol: row.originSymbol } : {}),
    ...(row.originDecimals !== undefined ? { originDecimals: row.originDecimals } : {}),
    ...(row.refundEvidenceHash
      ? {
          refundEvidence: {
            hash: row.refundEvidenceHash,
            source: row.refundEvidenceSource ?? 'our-watcher',
            at: row.refundEvidenceAt ?? row.createdAt,
            ...(row.refundEvidenceAmount ? { amount: row.refundEvidenceAmount } : {}),
          },
        }
      : {}),
    ...(row.destinationTxHash
      ? {
          destinationEvidence: {
            hash: row.destinationTxHash,
            ...(row.destinationTxBlock ? { block: row.destinationTxBlock } : {}),
            ...(row.amountOut ? { amount: row.amountOut } : {}),
            source: row.destinationEvidenceSource ?? 'our-watcher',
            at: row.destinationDetectedAt ?? row.createdAt,
          },
        }
      : {}),
    ...(options.settlement ? { settlement: options.settlement } : {}),
  };
}

/** The Move button belongs on exactly one condition: step 4 has its own evidence and step 5 does not yet. */
export function canOfferMove(state: TrackerState, landsIn: 'wallet' | 'margin'): boolean {
  if (landsIn === 'margin') return false;
  const step4 = state.steps.find((s) => s.id === 4);
  const step5 = state.steps.find((s) => s.id === 5);
  return Boolean(step4?.status === 'done' && step5?.status !== 'done');
}
