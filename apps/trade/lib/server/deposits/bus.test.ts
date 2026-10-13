import { describe, expect, it } from 'vitest';
import { onDepositTransition, publishDepositTransition, type DepositTransition } from './bus.js';

/**
 * D105 item 6's second half: "with no live deposit in flight, drive the watcher
 * against a simulated transition sequence to prove the UI updates within one second
 * per step."
 *
 * What this proves, precisely: the path from "the backend decided something changed"
 * to "every subscriber has been called" adds no measurable delay of its own — it is a
 * synchronous `EventEmitter.emit`, not a queue, a debounce, or a poll. That is the
 * mechanism `/api/fund/stream` sits on top of, so it is what makes a sub-one-second
 * UI update possible at all.
 *
 * What this does **not** prove, and does not claim to: the 3-second watcher tick
 * (`watcher.ts`, `TICK_MS`) is a poll interval, not part of this mechanism, and
 * network latency to a real browser cannot be measured from a Node-side unit test —
 * that half is EXISTS, not EXERCISED, until watched in a real browser (the
 * screenshots in the report are that verification).
 */

const SIMULATED_SEQUENCE = [
  { status: 'PENDING_DEPOSIT', terminal: false },
  { status: 'KNOWN_DEPOSIT_TX', terminal: false },
  { status: 'PROCESSING', terminal: false },
  { status: 'REFUNDED', terminal: true },
] as const;

describe('the bus adds no delay of its own between publish and delivery', () => {
  it('delivers every step of a simulated transition sequence in well under one second', () => {
    const address = `sim-${Math.random().toString(36).slice(2)}`;
    const received: DepositTransition[] = [];
    const elapsedPerStep: number[] = [];

    const unsubscribe = onDepositTransition(address, (t) => received.push(t));

    for (const step of SIMULATED_SEQUENCE) {
      const before = performance.now();
      publishDepositTransition({
        depositAddress: address,
        type: 'ONECLICK_STATUS',
        status: step.status,
        terminal: step.terminal,
        at: Date.now(),
      });
      elapsedPerStep.push(performance.now() - before);
    }

    unsubscribe();

    expect(received.map((t) => t.status)).toEqual(SIMULATED_SEQUENCE.map((s) => s.status));
    for (const ms of elapsedPerStep) {
      // 1 second is the requirement; this is checking for zero built-in delay, not
      // grading against the requirement with room to spare — an emit taking anywhere
      // near 1000ms would mean something is queuing rather than dispatching.
      expect(ms).toBeLessThan(50);
    }
  });

  it("a subscriber on one address never receives another address's transitions", () => {
    const addressA = 'sim-a';
    const addressB = 'sim-b';
    const receivedA: DepositTransition[] = [];
    const unsubscribe = onDepositTransition(addressA, (t) => receivedA.push(t));

    publishDepositTransition({
      depositAddress: addressB,
      type: 'ONECLICK_STATUS',
      status: 'SUCCESS',
      terminal: true,
      at: Date.now(),
    });
    publishDepositTransition({
      depositAddress: addressA,
      type: 'ONECLICK_STATUS',
      status: 'SUCCESS',
      terminal: true,
      at: Date.now(),
    });

    unsubscribe();
    expect(receivedA).toHaveLength(1);
    expect(receivedA[0]?.depositAddress).toBe(addressA);
  });

  it('the "*" subscription used by the Recent list receives every address', () => {
    const received: string[] = [];
    const unsubscribe = onDepositTransition('*', (t) => received.push(t.depositAddress));

    publishDepositTransition({
      depositAddress: 'sim-x',
      type: 'ONECLICK_STATUS',
      status: 'PROCESSING',
      terminal: false,
      at: Date.now(),
    });
    publishDepositTransition({
      depositAddress: 'sim-y',
      type: 'ONECLICK_STATUS',
      status: 'PROCESSING',
      terminal: false,
      at: Date.now(),
    });

    unsubscribe();
    expect(received).toEqual(['sim-x', 'sim-y']);
  });
});
