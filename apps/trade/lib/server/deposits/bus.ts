import { EventEmitter } from 'node:events';

/**
 * In-process pub/sub from the watcher to `/api/fund/stream`'s SSE handlers.
 *
 * One process, one bus: this app runs as a single `next start` server (confirmed —
 * not serverless, not multi-instance), so there is exactly one watcher and every SSE
 * connection is a listener on the same emitter. No Redis, no message queue — that
 * infrastructure would be solving a scaling problem this deployment does not have.
 */

export interface DepositTransition {
  readonly depositAddress: string;
  /** `RAIL_STATUS` is the rail-agnostic one; `ONECLICK_STATUS` predates rails. */
  readonly type: 'SOURCE_LANDED' | 'ONECLICK_STATUS' | 'RAIL_STATUS' | 'DESTINATION_DETECTED' | 'REFUND_DETECTED' | 'STUCK';
  readonly status: string;
  readonly terminal: boolean;
  readonly at: number;
}

const emitter = new EventEmitter();
// Many concurrent /fund tabs each open a listener; 0 would print an EventEmitter
// warning well before that is a real problem.
emitter.setMaxListeners(200);

export function publishDepositTransition(transition: DepositTransition): void {
  emitter.emit(transition.depositAddress, transition);
  emitter.emit('*', transition);
}

/** Subscribe to one address, or every address with `'*'` (the Recent list). */
export function onDepositTransition(
  depositAddress: string,
  handler: (t: DepositTransition) => void,
): () => void {
  emitter.on(depositAddress, handler);
  return () => emitter.off(depositAddress, handler);
}
