import type { RailId } from './types.js';

/**
 * What has actually been proven about each rail, as data rather than as prose.
 *
 * ## Why this is a module and not a paragraph in a report
 *
 * The R9 status of a rail was living in three places — a session report, `RAILS-TEST.md`,
 * and whatever the last message said — and they disagreed within a day of each other
 * twice. deBridge and Mayan were both recorded as permanently unavailable and both were
 * carrying Monad the same afternoon; Relay was described as having funded deposits that
 * Relay itself says it never saw.
 *
 * A status that is retyped is a status that goes stale. This is the one place it lives,
 * the live status page renders it, and a report that contradicts it is wrong by
 * construction.
 *
 * ## The three words mean exactly what A8.1 says
 *
 * **EXERCISED** — ran against its real dependency. Evidence is a transaction, a stored
 * row, or a named test that actually executed it.
 * **EXISTS** — written, perhaps unit-tested, never met the real thing. The evidence
 * field must say what it has never run against.
 * **MISSING** — not built, or built and unable to run. The evidence field says what
 * blocks it.
 *
 * `checkedOn` is when a human or a script last confirmed the line, not when it was
 * typed. A line nobody has re-checked since a vendor changed is a line to distrust, and
 * the status page shows the age so that is visible rather than implied.
 */

export type EvidenceState = 'EXERCISED' | 'EXISTS' | 'MISSING';

export interface RailEvidence {
  readonly rail: RailId;
  readonly displayName: string;
  /** False for the deposit-address rails: the default path needs no wallet. */
  readonly needsWallet: boolean;
  readonly state: EvidenceState;
  /** What was observed. For EXISTS, what it has never met. For MISSING, what blocks it. */
  readonly evidence: string;
  /** ISO date the claim was last confirmed against the real thing. */
  readonly checkedOn: string;
}

export const RAIL_EVIDENCE: readonly RailEvidence[] = [
  {
    rail: 'near',
    displayName: 'NEAR Intents',
    needsWallet: false,
    state: 'EXERCISED',
    evidence:
      'Four deposits delivered on production with Monad transaction hashes, one refunded. ' +
      'Quotes $5 today; its $1,000 floor was only ever its own live answer and lifted with ' +
      'no code change here.',
    checkedOn: '2026-09-21',
  },
  {
    rail: 'relay',
    displayName: 'Relay',
    needsWallet: false,
    state: 'EXISTS',
    evidence:
      'Issues deposit addresses on Base, Tron and Solana. No Relay deposit has ever been ' +
      'funded: Relay reports status=unknown, inTxHashes=0 for all six recorded addresses. ' +
      'Never carried money.',
    checkedOn: '2026-09-21',
  },
  {
    rail: 'cctp',
    displayName: 'Circle CCTP',
    needsWallet: true,
    state: 'EXISTS',
    evidence:
      'depositForBurn simulated on seven chains, each reaching the token transfer. The mint ' +
      'leg is built and its encoding proven: receiveMessage on Monad with a real ' +
      'Circle-signed message reverted "Nonce already used", past signature verification. ' +
      'Never signed by a user.',
    checkedOn: '2026-09-21',
  },
  {
    rail: 'across',
    displayName: 'Across',
    needsWallet: true,
    state: 'EXISTS',
    evidence:
      'depositV3 encoded and simulated against the live Base SpokePool: reverted only on ' +
      'ERC20 allowance, so it reached the transfer and the ABI is right. Never signed.',
    checkedOn: '2026-09-21',
  },
  {
    rail: 'debridge',
    displayName: 'deBridge',
    needsWallet: true,
    state: 'EXISTS',
    evidence:
      'Quotes live from a plain server. Its own calldata is passed through unmodified. ' +
      'Charges 0.001 ETH on top of the transfer, named as a fee on the card. Never signed.',
    checkedOn: '2026-09-21',
  },
  {
    rail: 'mayan',
    displayName: 'Mayan',
    needsWallet: true,
    state: 'EXISTS',
    evidence:
      'getSwapFromEvmTxPayload returns 932 bytes of calldata to their forwarder; the plan ' +
      'builds and simulates live. An earlier note claimed its SDK could not return calldata, ' +
      'which was drawn from watching their web app rather than reading their SDK. Never signed.',
    checkedOn: '2026-09-21',
  },
  {
    rail: 'oft-ausd',
    displayName: 'Agora AUSD bridge',
    needsWallet: true,
    state: 'EXISTS',
    evidence:
      'quoteSend returns a real fee from Base and Ethereum; quoteOFT confirms one for one ' +
      'with no dust removal. Never signed.',
    checkedOn: '2026-09-21',
  },
  {
    rail: 'oft-usdt0',
    displayName: 'USDT0 bridge',
    needsWallet: true,
    state: 'EXISTS',
    evidence:
      'quoteSend returns a fee from Ethereum and Arbitrum. From Base it is MISSING: ' +
      'peers(30390) is zero on the Base adapter and peers(30184) is zero on Monad’s, so ' +
      'the lane is unwired at both ends and cannot be made to work from our side.',
    checkedOn: '2026-09-21',
  },
];

/** How stale a line is, in whole days, against the day it is read. */
export function evidenceAgeDays(checkedOn: string, now = new Date()): number {
  const then = Date.parse(`${checkedOn}T00:00:00Z`);
  if (!Number.isFinite(then)) return Number.NaN;
  return Math.floor((now.getTime() - then) / 86_400_000);
}

/**
 * Anything nobody has re-checked in a fortnight.
 *
 * Not a failure — a prompt. Vendors change what they carry without telling anyone, which
 * is exactly how two rails ended up recorded as permanently unavailable while they were
 * quoting.
 */
export function staleEvidence(days = 14, now = new Date()): readonly RailEvidence[] {
  return RAIL_EVIDENCE.filter((e) => evidenceAgeDays(e.checkedOn, now) >= days);
}
