import { CCTP_DOMAINS, KNOWN_CHAINS, type RecoveryAttempt } from '@tradepro/core';
import type { DepositAttemptRow } from './db';

/**
 * The one documented recovery call per rail for a stuck deposit (owner, 2026-09-30).
 * Only calls the vendor's own documentation describes (read 2026-09-30, D195); none of
 * the three documents a refund request, so none is made. A rail with no call it can
 * make for this row records why, and its user gets the help report.
 *
 *   - NEAR Intents 1Click: `POST https://1click.chaindefuser.com/v0/deposit/submit`
 *     `{ txHash, depositAddress }` ("notifies the 1Click service that a deposit has been
 *     sent to the specified address ... can speed up swap processing"; OpenAPI v0.1.10).
 *   - Relay: `POST https://api.relay.link/transactions/deposit-address/reindex`
 *     `{ chainId, depositAddress }` ("Re-checks the balances of a previously-registered
 *     deposit address and queues a withdrawal for any currency with a non-zero balance.
 *     Useful when funds were sent to a deposit address but the normal indexer flow did
 *     not pick them up.").
 *   - Circle CCTP V2: `POST https://iris-api.circle.com/v2/reattest/{nonce}`, the nonce
 *     read from `GET /v2/messages/{domain}?transactionHash=` ("An expired Fast Transfer
 *     burn is not permanently stuck ... you can call POST /v2/reattest/{nonce} at any
 *     time").
 */

export const ONE_CLICK_DEPOSIT_SUBMIT_URL = 'https://1click.chaindefuser.com/v0/deposit/submit';
export const RELAY_REINDEX_URL = 'https://api.relay.link/transactions/deposit-address/reindex';
export const IRIS_BASE = 'https://iris-api.circle.com';

type Fetch = typeof fetch;

async function answerOf(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  return text.slice(0, 2000);
}

function chainIdOf(displayName: string): number | undefined {
  return Object.values(KNOWN_CHAINS).find((c) => c.displayName === displayName)?.id;
}

export async function recoverStuck(
  row: DepositAttemptRow,
  fetchImpl: Fetch = fetch,
  now: () => number = Date.now,
): Promise<RecoveryAttempt | undefined> {
  if (row.rail === 'near' || row.rail === null) {
    const call = `POST ${ONE_CLICK_DEPOSIT_SUBMIT_URL}`;
    if (!row.sourceTxHash) {
      return { at: now(), call, httpStatus: null, answer: 'not called: no source transaction hash on record to submit' };
    }
    const res = await fetchImpl(ONE_CLICK_DEPOSIT_SUBMIT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ txHash: row.sourceTxHash, depositAddress: row.railRef ?? row.depositAddress }),
    });
    return { at: now(), call, httpStatus: res.status, answer: await answerOf(res) };
  }

  if (row.rail === 'relay') {
    const call = `POST ${RELAY_REINDEX_URL}`;
    const chainId = row.sourceChainId ?? chainIdOf(row.chain);
    if (chainId === undefined) {
      return { at: now(), call, httpStatus: null, answer: `not called: no chain id known for ${row.chain}` };
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (process.env.RELAY_API_KEY) headers['x-api-key'] = process.env.RELAY_API_KEY;
    const res = await fetchImpl(RELAY_REINDEX_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ chainId, depositAddress: row.depositAddress }),
    });
    return { at: now(), call, httpStatus: res.status, answer: await answerOf(res) };
  }

  if (row.rail === 'cctp') {
    const burnTx = row.railRef;
    const domain = row.sourceChainId !== null ? CCTP_DOMAINS[row.sourceChainId] : undefined;
    const call = `POST ${IRIS_BASE}/v2/reattest/{nonce}`;
    if (!burnTx || domain === undefined) {
      return { at: now(), call, httpStatus: null, answer: 'not called: no burn transaction or source domain on record' };
    }
    const messages = await fetchImpl(`${IRIS_BASE}/v2/messages/${domain}?transactionHash=${burnTx}`);
    const body = (await messages.json().catch(() => undefined)) as { messages?: { eventNonce?: string }[] } | undefined;
    const nonce = body?.messages?.[0]?.eventNonce;
    if (!nonce) {
      return {
        at: now(),
        call,
        httpStatus: messages.status,
        answer: `not called: Circle's messages endpoint gave no nonce for ${burnTx}`,
      };
    }
    const res = await fetchImpl(`${IRIS_BASE}/v2/reattest/${nonce}`, { method: 'POST' });
    return { at: now(), call: `POST ${IRIS_BASE}/v2/reattest/${nonce}`, httpStatus: res.status, answer: await answerOf(res) };
  }

  return { at: now(), call: 'none', httpStatus: null, answer: `not called: ${row.rail} documents no recovery call` };
}
