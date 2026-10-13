import { describe, expect, it } from 'vitest';
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  http,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { entryPoint08Abi } from 'viem/account-abstraction';
import {
  buildDeposit,
  chainFor,
  ENTRY_POINT_V08,
  SPONSORSHIP_PAUSED_MESSAGE,
  rpcUserOperationSchema,
  SPONSORSHIP_ALLOWANCE_USED,
  sponsorshipAllowanceMessage,
  submit,
  utcClock,
  verifyUserOperationSignature,
} from '@tradepro/core';
import { bundlerTransport, messageFrom } from './bundlerTransport.js';
import { run, segmentOf, type Progress } from '../ticket.js';

/**
 * A used-up sponsorship allowance, from the relayer's answer to the pill.
 *
 * This drives the real `bundlerTransport` through the real `run()`, over viem's own
 * `http` transport, which is how the relayer's JSON-RPC error reaches production code
 * wrapped in all of viem's layers. Only the two network edges are fake: the public RPC
 * and `/api/submit`. The refusal body is built with the same functions the relayer builds
 * it with, and `apps/relayer/src/prefund.test.ts` pins the relayer's body to exactly this
 * shape.
 */

const CHAIN = chainFor('mainnet');
const MARGIN = '0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5' as Address;
const AUSD = '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a' as Address;
// A throwaway test key. Holds nothing, never touches a network.
const owner = privateKeyToAccount(`0x${'4f'.repeat(32)}` as Hex);
const RESETS_AT = Date.UTC(2025, 8, 3, 4, 0, 0);

function fakePublicClient(): PublicClient {
  return createPublicClient({
    chain: CHAIN,
    transport: custom({
      async request({ method, params }: { method: string; params?: unknown }) {
        const args = (params ?? []) as unknown[];
        switch (method) {
          case 'eth_chainId':
            return `0x${CHAIN.id.toString(16)}`;
          case 'eth_getCode':
            return '0x';
          case 'eth_getTransactionCount':
            return '0x0';
          case 'eth_maxPriorityFeePerGas':
            return '0x3b9aca00';
          case 'eth_getBlockByNumber':
            return {
              number: '0x1',
              hash: `0x${'11'.repeat(32)}`,
              parentHash: `0x${'22'.repeat(32)}`,
              timestamp: '0x1',
              baseFeePerGas: '0x17bfac7c00',
              gasLimit: '0x1c9c380',
              gasUsed: '0x0',
              transactions: [],
            };
          case 'eth_call': {
            const call = args[0] as { data: Hex };
            const decoded = decodeFunctionData({ abi: entryPoint08Abi, data: call.data });
            const key = (decoded.args as readonly [Address, bigint])[1];
            return encodeFunctionResult({
              abi: entryPoint08Abi,
              functionName: 'getNonce',
              result: key << 64n,
            });
          }
          default:
            throw new Error(`the fake public client was not expecting ${method}`);
        }
      },
    }),
  }) as PublicClient;
}

/** What the relayer sends back when an allowance is used up. */
function relayerRefusal(id: unknown) {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: -32000,
      message: sponsorshipAllowanceMessage('account', RESETS_AT, {
        now: RESETS_AT - 3_600_000,
        clock: utcClock,
      }),
      data: { reason: SPONSORSHIP_ALLOWANCE_USED, scope: 'account', resetsAt: RESETS_AT },
    },
  };
}

/** `/api/submit`, answering the way the relayer would. Records every method it saw. */
function fakeSubmitRoute(refuseOn: 'eth_estimateUserOperationGas' | 'eth_sendUserOperation') {
  const seen: Array<{ method: string; params: unknown[] }> = [];
  const transport = http('http://relay.test/api/submit', {
    fetchFn: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        id: unknown;
        method: string;
        params: unknown[];
      };
      seen.push({ method: body.method, params: body.params });
      const answer =
        body.method === refuseOn
          ? relayerRefusal(body.id)
          : body.method === 'eth_estimateUserOperationGas'
            ? {
                jsonrpc: '2.0',
                id: body.id,
                result: {
                  callGasLimit: '0x61a80',
                  verificationGasLimit: '0x186a0',
                  preVerificationGas: '0xea60',
                },
              }
            : { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'unexpected' } };
      return new Response(JSON.stringify(answer), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  return { seen, transport };
}

async function placeThroughTheRealPath(route: ReturnType<typeof fakeSubmitRoute>) {
  const client = fakePublicClient();
  const updates: Progress[] = [];
  const final = await run({
    sender: owner.address,
    calls: [{ to: MARGIN, data: buildDeposit(MARGIN, owner.address, AUSD, 1_000_000n).data }],
    purpose: 'deposit',
    owner,
    onProgress: (p) => updates.push(p),
    // The production `submit`, handed the production transport with its two network
    // edges swapped for the fakes above. Nothing else is replaced.
    submitFn: (request, _transport, options, onStage) =>
      submit(request, bundlerTransport(owner, { client, bundler: route.transport }), options, onStage),
  });
  return { updates, final };
}

describe('a used-up allowance stops at "Checking" and never reaches "Sending"', () => {
  it('is refused on the estimate: terminal at Checking, with the owner’s sentence in local time', async () => {
    const route = fakeSubmitRoute('eth_estimateUserOperationGas');
    const { updates, final } = await placeThroughTheRealPath(route);

    // The pill never lit "Sending", at any point, and never entered RELAYING.
    expect(updates.map((u) => u.stageNote)).not.toContain('Sending');
    expect(updates.some((u) => u.state === 'RELAYING')).toBe(false);
    // Nothing but the estimate ever reached the relayer: no signed send, no receipt poll.
    expect(route.seen.map((s) => s.method)).toEqual(['eth_estimateUserOperationGas']);

    expect(final.state).toBe('REJECTED');
    expect(final.refusedAtChecking).toBe(true);
    expect(segmentOf(final)).toBe(0); // TICKET_STATES[0] is "Checking"
    // B2c (2026-09-25): whatever internal scope bound, the user reads the ONE gas
    // sentence with its two live choices — never the scope-naming wording.
    expect(final.message).toBe(SPONSORSHIP_PAUSED_MESSAGE);
    expect(final.message).not.toMatch(/lifetime/i);
    expect(final.message ?? '').not.toMatch(/\d/);
    expect(final.detail).toBeUndefined();
  });

  it('carried a real signature on that estimate — one the relayer accepts as proof', async () => {
    const route = fakeSubmitRoute('eth_estimateUserOperationGas');
    await placeThroughTheRealPath(route);
    const estimate = route.seen.find((s) => s.method === 'eth_estimateUserOperationGas');
    const op = rpcUserOperationSchema.parse(estimate?.params[0]);
    expect(String(estimate?.params[1]).toLowerCase()).toBe(ENTRY_POINT_V08.toLowerCase());
    const proof = await verifyUserOperationSignature(op, {
      chainId: CHAIN.id,
      entryPoint: ENTRY_POINT_V08,
    });
    expect(proof.ok).toBe(true);
  });

  it('still ends at Checking if the refusal only arrives on the send', async () => {
    // Reachable only if the allowance ran out between this account's estimate and its
    // send, a sub-second window that another tab of the same account would have to hit.
    // "Sending" has lit by then; the terminal state still says where it stopped.
    const route = fakeSubmitRoute('eth_sendUserOperation');
    const { final } = await placeThroughTheRealPath(route);
    expect(final.state).toBe('REJECTED');
    expect(segmentOf(final)).toBe(0);
  });

  it('every other rejection keeps lighting "Sending" as before', () => {
    expect(segmentOf({ state: 'REJECTED' })).toBe(2);
    expect(segmentOf({ state: 'CONFIRMED' })).toBe(4);
  });
});

describe('messageFrom for the allowance refusal (B2c: one sentence, every scope)', () => {
  it('converts an old relayer’s scope-naming sentence, arriving with no data, to the one gas sentence', () => {
    for (const scope of ['account', 'account-hour', 'shared'] as const) {
      const sentence = sponsorshipAllowanceMessage(scope, RESETS_AT, {
        now: RESETS_AT - 600_000,
        clock: utcClock,
      });
      const result = messageFrom(new Error(sentence));
      expect(result).toEqual({
        message: SPONSORSHIP_PAUSED_MESSAGE,
        reason: SPONSORSHIP_ALLOWANCE_USED,
      });
    }
  });

  it('every scope’s data converts to the same sentence — shared and account-hour alike', () => {
    for (const scope of ['account', 'account-hour', 'shared'] as const) {
      const error = Object.assign(new Error('outer'), {
        cause: { data: { reason: SPONSORSHIP_ALLOWANCE_USED, scope, resetsAt: RESETS_AT } },
      });
      const { message, reason } = messageFrom(error);
      expect(message).toBe(SPONSORSHIP_PAUSED_MESSAGE);
      expect(reason).toBe(SPONSORSHIP_ALLOWANCE_USED);
    }
  });
});
