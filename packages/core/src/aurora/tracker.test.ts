import { describe, expect, it } from 'vitest';
import { canOfferMove, deriveTrackerState, type TrackerInput } from './tracker.js';

const NOW = 1_800_000_000_000;

function baseInput(overrides: Partial<TrackerInput> = {}): TrackerInput {
  return {
    chainName: 'Solana',
    outToken: 'USDC',
    landsIn: 'wallet',
    createdAt: NOW - 10 * 60_000,
    now: NOW,
    vendorStatus: 'PENDING_DEPOSIT',
    ...overrides,
  };
}

function status(id: number, steps: ReturnType<typeof deriveTrackerState>['steps']) {
  return steps.find((s) => s.id === id)!.status;
}

describe('destination seen on chain before the vendor reports PROCESSING', () => {
  it('lights steps 1-4 from our own chain read alone, with step 2 inferred', () => {
    const state = deriveTrackerState(
      baseInput({
        vendorStatus: 'PENDING_DEPOSIT',
        destinationEvidence: { source: 'eth_getTransactionReceipt', hash: '0xdest', block: '1000', at: NOW - 1000 },
      }),
    );
    expect(status(1, state.steps)).toBe('done');
    expect(status(2, state.steps)).toBe('done');
    expect(status(3, state.steps)).toBe('done');
    expect(status(4, state.steps)).toBe('done');
    expect(status(5, state.steps)).toBe('pending');
    expect(state.steps.find((s) => s.id === 2)?.inferredFromStep).toBe(4);
    expect(state.steps.find((s) => s.id === 4)?.evidence?.hash).toBe('0xdest');
    expect(state.terminal).toBeUndefined();
  });
});

describe('vendor SUCCESS with no hash yet', () => {
  it('does not advance past bridging without a chain-confirmed hash', () => {
    const state = deriveTrackerState(
      baseInput({
        vendorStatus: 'SUCCESS',
        vendorTerminalStatus: 'SUCCESS',
        sourceEvidence: { source: 'our-watcher-solana', hash: '0xsrc', at: NOW - 60_000 },
      }),
    );
    expect(status(1, state.steps)).toBe('done');
    expect(status(2, state.steps)).toBe('done');
    expect(status(3, state.steps)).toBe('active');
    expect(status(4, state.steps)).toBe('pending');
    expect(status(5, state.steps)).toBe('pending');
    expect(state.terminal).toBeUndefined();
  });
});

describe('refund after step 2', () => {
  it('renders a red terminal at step 3, with the vendor reason and refund hash', () => {
    const state = deriveTrackerState(
      baseInput({
        vendorStatus: 'REFUNDED',
        vendorTerminalStatus: 'REFUNDED',
        sourceEvidence: { source: 'our-watcher-solana', hash: '0xsrc', at: NOW - 120_000 },
        refundReason: 'NO_LIQUIDITY',
        refundTxHash: '0xrefund',
        refundExplorerUrl: 'https://solscan.io/tx/0xrefund',
        refundTo: 'sender-address',
      }),
    );
    expect(status(1, state.steps)).toBe('done');
    expect(status(2, state.steps)).toBe('done');
    expect(state.terminal).toBeDefined();
    expect(state.terminal?.kind).toBe('REFUNDED');
    expect(state.terminal?.atStep).toBe(3);
    expect(state.terminal?.reason).toBe('NO_LIQUIDITY');
    expect(state.terminal?.refundTxHash).toBe('0xrefund');
    expect(state.terminal?.whereItWent).toContain('sender-address');
    expect(state.currentStep).toBe(3);
  });

  it('is never shown once chain evidence proves the money actually arrived', () => {
    // A stale REFUNDED word must not survive a later, genuine delivery.
    const state = deriveTrackerState(
      baseInput({
        vendorStatus: 'REFUNDED',
        vendorTerminalStatus: 'REFUNDED',
        sourceEvidence: { source: 'our-watcher-solana', hash: '0xsrc', at: NOW - 120_000 },
        destinationEvidence: { source: 'balance-poll', hash: '0xdest', at: NOW - 1_000 },
        refundReason: 'NO_LIQUIDITY',
      }),
    );
    expect(state.terminal).toBeUndefined();
    expect(status(4, state.steps)).toBe('done');
  });
});

describe('expiry at step 1', () => {
  it('renders a red terminal at step 1 when nothing was ever sent', () => {
    const state = deriveTrackerState(
      baseInput({
        vendorStatus: 'PENDING_DEPOSIT',
        expiresAt: NOW - 1,
      }),
    );
    expect(state.terminal).toBeDefined();
    expect(state.terminal?.kind).toBe('EXPIRED');
    expect(state.terminal?.atStep).toBe(1);
    expect(state.currentStep).toBe(1);
  });

  it('stops mattering once something has been seen', () => {
    const state = deriveTrackerState(
      baseInput({
        vendorStatus: 'PROCESSING',
        expiresAt: NOW - 1,
        sourceEvidence: { source: 'our-watcher-solana', hash: '0xsrc', at: NOW - 500 },
      }),
    );
    expect(state.terminal).toBeUndefined();
  });
});

describe('Move confirmed with the vendor still reporting PROCESSING', () => {
  it('lights step 5 from the move transaction alone, regardless of vendor status', () => {
    const state = deriveTrackerState(
      baseInput({
        vendorStatus: 'PROCESSING',
        sourceEvidence: { source: 'our-watcher-solana', hash: '0xsrc', at: NOW - 200_000 },
        destinationEvidence: { source: 'balance-poll', hash: '0xdest', at: NOW - 60_000 },
        settlement: { moveConfirmed: true, marginIncreased: false, moveTxHash: '0xmove', at: NOW - 1_000 },
      }),
    );
    expect(status(4, state.steps)).toBe('done');
    expect(status(5, state.steps)).toBe('done');
    expect(state.steps.find((s) => s.id === 5)?.evidence?.hash).toBe('0xmove');
    expect(state.terminal).toBeUndefined();
  });

  it('also lights step 5 from a risen margin balance alone, with no move tx hash', () => {
    const state = deriveTrackerState(
      baseInput({
        vendorStatus: 'PROCESSING',
        sourceEvidence: { source: 'our-watcher-solana', hash: '0xsrc', at: NOW - 200_000 },
        destinationEvidence: { source: 'balance-poll', hash: '0xdest', at: NOW - 60_000 },
        settlement: {
          moveConfirmed: false,
          marginIncreased: true,
          baselineBlock: '100',
          currentBlock: '105',
          at: NOW - 500,
        },
      }),
    );
    expect(status(5, state.steps)).toBe('done');
    expect(state.steps.find((s) => s.id === 5)?.evidence?.block).toBe('100 -> 105');
  });
});

describe('a rail that lands straight in the margin account', () => {
  it('ticks steps 4 and 5 together, step 5 inferred from step 4', () => {
    const state = deriveTrackerState(
      baseInput({
        landsIn: 'margin',
        vendorStatus: 'PROCESSING',
        sourceEvidence: { source: 'our-watcher-solana', hash: '0xsrc', at: NOW - 60_000 },
        destinationEvidence: { source: 'balance-poll', hash: '0xdest', at: NOW - 1_000 },
      }),
    );
    expect(status(4, state.steps)).toBe('done');
    expect(status(5, state.steps)).toBe('done');
    expect(state.steps.find((s) => s.id === 5)?.inferredFromStep).toBe(4);
    expect(canOfferMove(state, 'margin')).toBe(false);
  });
});

describe('slow is stated, not hidden', () => {
  it('adds the waiting message once a step runs past three times the quoted eta', () => {
    const state = deriveTrackerState(
      baseInput({
        vendorStatus: 'PROCESSING',
        etaSeconds: 60,
        sourceEvidence: { source: 'our-watcher-solana', hash: '0xsrc', at: NOW - 4 * 60_000 },
        vendorRaw: { status: 'PROCESSING' },
        vendorRawAt: NOW - 30_000,
      }),
    );
    const step3 = state.steps.find((s) => s.id === 3)!;
    expect(step3.status).toBe('active');
    expect(step3.slow?.message).toContain('Taking longer than usual');
    expect(step3.slow?.message).toContain('minute');
  });

  it('never claims a threshold when no eta is known', () => {
    const state = deriveTrackerState(
      baseInput({
        vendorStatus: 'PROCESSING',
        sourceEvidence: { source: 'our-watcher-solana', hash: '0xsrc', at: NOW - 60 * 60_000 },
      }),
    );
    const step3 = state.steps.find((s) => s.id === 3)!;
    expect(step3.slow).toBeUndefined();
  });
});

describe('no state can regress', () => {
  it('keeps every step already shown done, done, even if the fresh input lost its evidence', () => {
    const first = deriveTrackerState(
      baseInput({
        vendorStatus: 'PROCESSING',
        sourceEvidence: { source: 'our-watcher-solana', hash: '0xsrc', at: NOW - 120_000 },
        destinationEvidence: { source: 'balance-poll', hash: '0xdest', at: NOW - 10_000 },
      }),
    );
    expect(first.currentStep).toBe(4);

    // A pathological re-poll that lost the destination evidence (a bug elsewhere, a
    // stale cache, a race) must not walk the tracker backward.
    const second = deriveTrackerState(
      baseInput({
        vendorStatus: 'PROCESSING',
        sourceEvidence: { source: 'our-watcher-solana', hash: '0xsrc', at: NOW - 120_000 },
        previousMaxStep: first.currentStep,
      }),
    );
    for (const id of [1, 2, 3, 4] as const) {
      expect(status(id, second.steps), `step ${id}`).toBe('done');
    }
  });

  it('never regresses out of a terminal state either', () => {
    const first = deriveTrackerState(
      baseInput({
        vendorStatus: 'REFUNDED',
        vendorTerminalStatus: 'REFUNDED',
        sourceEvidence: { source: 'our-watcher-solana', hash: '0xsrc', at: NOW - 120_000 },
        refundReason: 'NO_LIQUIDITY',
      }),
    );
    expect(first.terminal?.atStep).toBe(3);
    // The correct value a caller passes forward is the highest step genuinely shown
    // DONE — not the terminal's own `atStep`, which is where it stopped, never
    // finished. Security review (this session) flagged that passing `atStep` here
    // would mark the interrupted step "done" while a red terminal notice renders on
    // it at the same time — a real, if currently unreachable, misuse: no caller wires
    // `previousMaxStep` yet, and this asserts the field's actual contract for when one
    // does.
    const highestGenuinelyDone = ([5, 4, 3, 2, 1] as const).find(
      (id) => status(id, first.steps) === 'done',
    );
    expect(highestGenuinelyDone).toBe(2);

    const second = deriveTrackerState(
      baseInput({
        vendorStatus: 'REFUNDED',
        vendorTerminalStatus: 'REFUNDED',
        sourceEvidence: { source: 'our-watcher-solana', hash: '0xsrc', at: NOW - 120_000 },
        refundReason: 'NO_LIQUIDITY',
        previousMaxStep: highestGenuinelyDone,
      }),
    );
    expect(status(1, second.steps)).toBe('done');
    expect(status(2, second.steps)).toBe('done');
    // Step 3 stays the terminal's own stop, not silently promoted to done.
    expect(status(3, second.steps)).not.toBe('done');
    expect(second.terminal?.atStep).toBe(3);
  });

  it('passing a terminal atStep as previousMaxStep would wrongly mark the stopped step done (documents the misuse the fix above avoids)', () => {
    const state = deriveTrackerState(
      baseInput({
        vendorStatus: 'REFUNDED',
        vendorTerminalStatus: 'REFUNDED',
        sourceEvidence: { source: 'our-watcher-solana', hash: '0xsrc', at: NOW - 120_000 },
        refundReason: 'NO_LIQUIDITY',
        previousMaxStep: 3,
      }),
    );
    // This is why: a future caller must pass the highest step shown DONE, never a
    // terminal's own `atStep`.
    expect(status(3, state.steps)).toBe('done');
    expect(state.terminal?.atStep).toBe(3);
  });
});

describe('the Move button appears only on step 4 evidence', () => {
  it('is false with no destination evidence', () => {
    const state = deriveTrackerState(
      baseInput({
        vendorStatus: 'PROCESSING',
        sourceEvidence: { source: 'our-watcher-solana', hash: '0xsrc', at: NOW - 60_000 },
      }),
    );
    expect(canOfferMove(state, 'wallet')).toBe(false);
  });

  it('is true once step 4 has its own evidence and step 5 does not', () => {
    const state = deriveTrackerState(
      baseInput({
        vendorStatus: 'PROCESSING',
        sourceEvidence: { source: 'our-watcher-solana', hash: '0xsrc', at: NOW - 60_000 },
        destinationEvidence: { source: 'balance-poll', hash: '0xdest', at: NOW - 1_000 },
      }),
    );
    expect(canOfferMove(state, 'wallet')).toBe(true);
  });

  it('is false again once step 5 is also done', () => {
    const state = deriveTrackerState(
      baseInput({
        vendorStatus: 'PROCESSING',
        sourceEvidence: { source: 'our-watcher-solana', hash: '0xsrc', at: NOW - 60_000 },
        destinationEvidence: { source: 'balance-poll', hash: '0xdest', at: NOW - 1_000 },
        settlement: { moveConfirmed: true, marginIncreased: true, at: NOW - 500 },
      }),
    );
    expect(canOfferMove(state, 'wallet')).toBe(false);
  });

  it('is always false for a rail that lands directly in margin', () => {
    const state = deriveTrackerState(
      baseInput({
        landsIn: 'margin',
        vendorStatus: 'PROCESSING',
        sourceEvidence: { source: 'our-watcher-solana', hash: '0xsrc', at: NOW - 60_000 },
        destinationEvidence: { source: 'balance-poll', hash: '0xdest', at: NOW - 1_000 },
      }),
    );
    expect(canOfferMove(state, 'margin')).toBe(false);
  });
});

describe('step 1 is always done', () => {
  it('needs no evidence beyond the row existing', () => {
    const state = deriveTrackerState(baseInput());
    expect(status(1, state.steps)).toBe('done');
    expect(state.steps[0]?.evidence?.source).toBe('deposits-row');
  });
});
