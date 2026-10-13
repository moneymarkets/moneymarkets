import type { Address, Hex } from 'viem';
import type { ModeGate } from '../chain/mode.js';
import type { SponsoredCall } from './account.js';
import type { GasChargeRefusalData } from './gasFee.js';

/**
 * The one interface every order path calls.
 *
 * Screens, the market kit and the gate script all go through `submit()`. That means
 * there is exactly one place where "has the gas layer actually been proven on chain?"
 * is answered, and no screen can accidentally claim to work end to end before it has.
 *
 * `GAS_LAYER_PROVEN` flips in the commit that lands a passing M0 gate — a real
 * sponsored order on mainnet from a 0-MON delegated EOA — and not before. Until then
 * `submit()` returns `SUBMIT_GAS_LAYER_UNPROVEN` after doing every check it can, so
 * the whole path stays exercised and reviewable.
 */

/**
 * The M0 gate passed on Monad mainnet on 2026-09-02.
 *
 *   userOp 1 (type 0x4, carries the EIP-7702 authorization)
 *     tx    0x49e0785741cd9e309eec35e9c70310c5947fa82f21f23defaa457a494b69fe93
 *     block 101310782
 *     permit -> MarginAccount.deposit(4.99 AUSD) -> addBuyOrder(200 MON @ 0.024933)
 *     OrderCreated.owner == 0x43a275C3Eb0BE7313f847FFA4fb6Bd366606A961
 *
 *   userOp 2
 *     tx    0x9631da7551d97ad59189f2bffc37dd1912ce9fe2a5763bbfbef04c2b221ca74b
 *     block 101310801
 *     OrdersCanceled([13130679])
 *
 * The account held **0 MON before and 0 MON after**, and is now delegated to
 * `Simple7702Account`. Gas came entirely from its EntryPoint deposit, which fell from
 * 0.3 to 0.1567900016 MON. No paymaster was involved.
 */
export const GAS_LAYER_PROVEN = true;

export type SubmitStatus =
  /** Everything validated; the gas layer has not yet been proven on chain. */
  | 'SUBMIT_GAS_LAYER_UNPROVEN'
  /** Validated and costed, but not sent: this process is not armed for live funds. */
  | 'DRYRUN'
  /** Rejected before reaching a bundler. */
  | 'REJECTED'
  /** Accepted by the bundler. */
  | 'SUBMITTED'
  /** Mined and successful. */
  | 'CONFIRMED'
  /** Mined and reverted. */
  | 'REVERTED';

export interface SubmitResult {
  readonly status: SubmitStatus;
  /** Present once a bundler accepted the operation. */
  readonly userOpHash?: Hex;
  /** Present once the operation is mined. */
  readonly txHash?: Hex;
  /** The sender, which under 7702 is the user's own EOA. */
  readonly sender?: Address;
  /** User-facing copy: the one-line plain-language lead. Never a hex string. */
  readonly message?: string;
  /**
   * The upstream's own words, verbatim and source-named, rendered under the lead —
   * e.g. `Pimlico said: “AA21 didn't pay prefund”`. Never a substitute sentence:
   * the error-handling rule (2026-09-08) is that an upstream reason is never masked.
   */
  readonly detail?: string;
  /** Machine-readable reason for a rejection. */
  readonly reason?: string;
  /**
   * The relayer's own `-32000` refusal data, when a rejection was one of the gas-
   * charge reasons (`FREE_ACTIONS_USED`, `GAS_FEE_REQUIRED`, `GAS_FEE_QUOTE_EXPIRED`,
   * `GAS_FEE_UNPRICED`, `FEE_LEG_MISMATCH` — see `gasFee.ts`'s
   * `isGasChargeRefusalData`). Carried through so a caller can rebuild the batch once
   * on `FEE_LEG_MISMATCH` (using `expectedFee`) or `GAS_FEE_QUOTE_EXPIRED` (with a
   * fresh quote) rather than treating either as terminal. `undefined` for every other
   * rejection, including the unrelated sponsorship-allowance refusal.
   */
  readonly refusalData?: GasChargeRefusalData;
  /**
   * The mined receipt's logs, when there was a receipt.
   *
   * Carried so the caller can pull the ids out of `OrderCreated` and remember the
   * order it just placed — there is no on-chain call that enumerates a user's orders,
   * so the receipt is the one moment those ids exist. `orderIdsCreatedFor()` reads
   * them. Kept as raw logs rather than decoded ids because `submit()` knows nothing
   * about which market or owner the caller cares about.
   */
  readonly logs?: readonly unknown[];
}

export interface SubmitRequest {
  readonly sender: Address;
  readonly calls: readonly SponsoredCall[];
  /** What the user was doing, for logs and for the ticket state machine. */
  readonly purpose: 'order' | 'cancel' | 'deposit' | 'withdraw' | 'swap';
}

/**
 * The transport a caller supplies. Kept abstract so `core` never imports a bundler
 * client and browsers never see the Pimlico key — the app posts to our own backend,
 * which holds the key and applies the sponsorship policy.
 */
/**
 * What the transport is doing right now.
 *
 * Reported so the ticket can advance when a stage genuinely finishes rather than
 * parking on one label while several things happen behind it. Measured 2026-09-10:
 * preparing and estimating is over a second of the roughly three a submission takes,
 * and it used to be invisible — the pill sat on "Sending" for the whole of it.
 */
export type SubmitStage = 'preparing' | 'estimating' | 'signing' | 'submitting' | 'mining';

export interface SubmitTransport {
  send(request: SubmitRequest, onStage?: (stage: SubmitStage) => void): Promise<SubmitResult>;
}

export class GasLayerUnprovenError extends Error {
  constructor() {
    super(
      'The EIP-7702 gas layer has not been proven on chain yet. The M0 gate — a ' +
        'sponsored order from a 0-MON delegated EOA on mainnet — has to pass before ' +
        'GAS_LAYER_PROVEN can be set.',
    );
    this.name = 'GasLayerUnprovenError';
  }
}

export interface SubmitOptions {
  /** Injected in tests; defaults to the process environment. */
  readonly gate?: ModeGate;
}

/**
 * Submit a batch of calls as a user operation.
 *
 * Two outcomes:
 *
 *  1. the gas layer is not proven on chain -> `SUBMIT_GAS_LAYER_UNPROVEN`
 *  2. otherwise -> handed to the transport, which asks a **server** to send
 *
 * ## The gate is not evaluated here, on purpose
 *
 * This function used to call `mainnetAllowed()` and answer `DRYRUN` when it was
 * false. That is correct on a server and catastrophic in a browser: `MODE` and
 * `I_UNDERSTAND_THIS_USES_REAL_FUNDS` are not `NEXT_PUBLIC_` variables, so client
 * code cannot read them, `mainnetAllowed()` is permanently false there, and an armed
 * deployment silently answered "simulated mode" and sent nothing. The bug was
 * invisible because every unit test ran in Node, where the variables exist.
 *
 * So the arming decision now lives in exactly one place: the server route the
 * transport talks to. It refuses when disarmed, and the refusal comes back as a
 * result the screen can render. A caller with no transport cannot send at all, which
 * is the only "nothing will happen" this function still decides by itself.
 *
 * It returns rather than throws: a screen should render its whole state machine and
 * stop at the honest step, not crash.
 */
export async function submit(
  request: SubmitRequest,
  transport?: SubmitTransport,
  _options: SubmitOptions = {},
  onStage?: (stage: SubmitStage) => void,
): Promise<SubmitResult> {
  if (!GAS_LAYER_PROVEN) {
    return {
      status: 'SUBMIT_GAS_LAYER_UNPROVEN',
      sender: request.sender,
      reason: 'SUBMIT_GAS_LAYER_UNPROVEN',
      message:
        'Trading is not live yet. Everything up to sending has been checked; the ' +
        'gasless path is still being proven on chain.',
    };
  }

  // No transport means nothing can send, whatever the environment says. This is the
  // only stopping decision left in this function.
  if (!transport) {
    return {
      status: 'DRYRUN',
      sender: request.sender,
      reason: 'NO_TRANSPORT',
      message: 'Checked and costed. Nothing was sent — this build has no way to submit.',
    };
  }

  // The server decides whether it is armed, and says so in its own words.
  return transport.send(request, onStage);
}

/** True when a result means "we stopped on purpose", not "something broke". */
export function isUnproven(result: SubmitResult): boolean {
  return result.status === 'SUBMIT_GAS_LAYER_UNPROVEN';
}

/** True when nothing was sent, for either reason. Screens branch on this. */
export function didNotSend(result: SubmitResult): boolean {
  return result.status === 'SUBMIT_GAS_LAYER_UNPROVEN' || result.status === 'DRYRUN';
}
