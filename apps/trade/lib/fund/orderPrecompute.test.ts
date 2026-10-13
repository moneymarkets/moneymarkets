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
import { chainFor } from '@tradepro/core';
import { bundlerTransport, prewarmOperation, startOrderPrecompute } from './bundlerTransport.js';

/**
 * ITEM 2 and ITEM 5's regression guards.
 *
 * The public-client fake follows the same shape `pathB.test.ts` already uses for the
 * real `bundlerTransport` through a real `run()`-free `send()`: every `eth_call` here
 * is a `EntryPoint.getNonce(sender, key)` read (nothing else in this transport calls
 * `eth_call`), so counting them is counting nonce reads without needing to reach into
 * the module's private cache.
 */

const CHAIN = chainFor('mainnet');
const owner = privateKeyToAccount(`0x${'4f'.repeat(32)}` as Hex);
const HASH = `0x${'ab'.repeat(32)}` as Hex;
const TX_HASH = `0x${'cd'.repeat(32)}` as Hex;

function fakePublicClient(options: { delegated?: boolean } = {}): { client: PublicClient; nonceReads: bigint[] } {
  const nonceReads: bigint[] = [];
  // Advances on every `eth_getBlockByNumber` — `watchBlocks`'s own poll only emits a
  // block that is genuinely newer than the last one it saw, so a fixed number here
  // would fire `onBlock` once and then never again.
  let blockNumber = 1;
  const client = createPublicClient({
    chain: CHAIN,
    transport: custom({
      async request({ method, params }: { method: string; params?: unknown }) {
        const args = (params ?? []) as unknown[];
        switch (method) {
          case 'eth_chainId':
            return `0x${CHAIN.id.toString(16)}`;
          case 'eth_getCode':
            // Never delegated, unless a test needs an account that already is (R9).
            return options.delegated ? `0xef0100${'00'.repeat(20)}` : '0x';
          case 'eth_getTransactionCount':
            return '0x0';
          case 'eth_maxPriorityFeePerGas':
            return '0x3b9aca00';
          case 'eth_getBlockByNumber': {
            blockNumber += 1;
            return {
              number: `0x${blockNumber.toString(16)}`,
              hash: `0x${'11'.repeat(32)}`,
              parentHash: `0x${'22'.repeat(32)}`,
              timestamp: '0x1',
              baseFeePerGas: '0x17bfac7c00',
              gasLimit: '0x1c9c380',
              gasUsed: '0x0',
              transactions: [],
            };
          }
          case 'eth_call': {
            const call = args[0] as { data: Hex };
            const decoded = decodeFunctionData({ abi: entryPoint08Abi, data: call.data });
            const key = (decoded.args as readonly [Address, bigint])[1];
            nonceReads.push(key);
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
  return { client, nonceReads };
}

/**
 * A bundler that always accepts the estimate and the send, and answers the receipt
 * however each test asks. Modelled on `pathB.test.ts`'s `fakeSubmitRoute`.
 */
function fakeBundlerRoute(receiptResult: () => unknown, sendResult: () => Hex = () => HASH) {
  const seen: Array<{ method: string; params: unknown[] }> = [];
  const transport = http('http://relay.test/api/submit', {
    fetchFn: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        id: unknown;
        method: string;
        params: unknown[];
      };
      seen.push({ method: body.method, params: body.params });
      const answer = (() => {
        switch (body.method) {
          case 'eth_estimateUserOperationGas':
            return {
              result: {
                callGasLimit: '0x61a80',
                verificationGasLimit: '0x186a0',
                preVerificationGas: '0xea60',
              },
            };
          case 'eth_sendUserOperation':
            return { result: sendResult() };
          case 'eth_getUserOperationReceipt':
            return { result: receiptResult() };
          default:
            return { error: { code: -32601, message: `unexpected ${body.method}` } };
        }
      })();
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: body.id, ...answer }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });
  return { seen, transport };
}

function successReceipt() {
  return {
    userOpHash: HASH,
    sender: owner.address,
    nonce: '0x0',
    actualGasCost: '0x1',
    actualGasUsed: '0x1',
    success: true,
    logs: [],
    receipt: { transactionHash: TX_HASH, blockNumber: '0x1', status: '0x1' },
  };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('ITEM 2 — the precomputed nonce is used, not re-read, at tap time', () => {
  it('warms one nonce at mount and spends it without another eth_call during send()', async () => {
    const { client, nonceReads } = fakePublicClient();
    const stop = startOrderPrecompute(owner, { client });
    await flush();
    expect(nonceReads).toHaveLength(1); // the mount-time warm-up, and only that

    const route = fakeBundlerRoute(successReceipt);
    const transport = bundlerTransport(owner, {
      client,
      bundler: route.transport,
      wsClient: null, // deterministic: no real WebSocket in a test
    });
    const result = await transport.send({
      sender: owner.address,
      calls: [{ to: owner.address, data: '0x' }],
      purpose: 'order',
    });

    expect(result.status).toBe('CONFIRMED');
    // The nonce `prepareUserOperation` actually carried is the exact value read at
    // mount — proof `send()` used the cache rather than reading its own.
    const estimate = route.seen.find((s) => s.method === 'eth_estimateUserOperationGas');
    const sentNonce = (estimate?.params[0] as { nonce: Hex } | undefined)?.nonce;
    expect(sentNonce).toBeDefined();
    expect(BigInt(sentNonce as Hex) >> 64n).toBe(nonceReads[0]);

    // A fresh nonce was drawn in the background the moment the first was taken —
    // by the time `send()` itself resolves (it waits out a finality block first),
    // that refill has already landed, ready before the next tap needs it (ITEM 2).
    expect(nonceReads).toHaveLength(2);

    stop();
  });

  it('a rejected send never leaves the next attempt reusing the same nonce', async () => {
    const { client } = fakePublicClient();
    const stop = startOrderPrecompute(owner, { client });
    await flush();

    // The relayer refuses the send outright — a real refusal shape (see
    // `sponsorshipRefusal.test.ts`), not a network fault.
    const failingTransport = bundlerTransport(owner, {
      client,
      bundler: http('http://relay.test/api/submit', {
        fetchFn: async (_url, init) => {
          const body = JSON.parse(String(init?.body)) as { id: unknown; method: string };
          if (body.method === 'eth_sendUserOperation') {
            return new Response(
              JSON.stringify({
                jsonrpc: '2.0',
                id: body.id,
                error: { code: -32000, message: 'rejected for this test' },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          }
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: body.id,
              result: {
                callGasLimit: '0x61a80',
                verificationGasLimit: '0x186a0',
                preVerificationGas: '0xea60',
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        },
      }),
      wsClient: null,
    });
    const failed = await failingTransport.send({
      sender: owner.address,
      calls: [{ to: owner.address, data: '0x' }],
      purpose: 'order',
    });
    expect(failed.status).toBe('REJECTED');

    // The next attempt must still succeed — the popped nonce from the failed try is
    // never handed out again, and a fresh one is either already cached or read on
    // demand (ITEM 2, correctness first).
    const route = fakeBundlerRoute(successReceipt);
    const transport = bundlerTransport(owner, { client, bundler: route.transport, wsClient: null });
    const result = await transport.send({
      sender: owner.address,
      calls: [{ to: owner.address, data: '0x' }],
      purpose: 'order',
    });
    expect(result.status).toBe('CONFIRMED');

    stop();
  });

  it('never hands the same cached nonce to two overlapping submissions', async () => {
    const { client, nonceReads } = fakePublicClient();
    const stop = startOrderPrecompute(owner, { client });
    await flush();
    expect(nonceReads).toHaveLength(1);

    const routeA = fakeBundlerRoute(successReceipt);
    const routeB = fakeBundlerRoute(successReceipt);
    const transportA = bundlerTransport(owner, { client, bundler: routeA.transport, wsClient: null });
    const transportB = bundlerTransport(owner, { client, bundler: routeB.transport, wsClient: null });

    // Fired back to back, deliberately not awaited individually — this is exactly
    // the race a fixed, shared nonce would lose.
    const [resultA, resultB] = await Promise.all([
      transportA.send({
        sender: owner.address,
        calls: [{ to: owner.address, data: '0x' }],
        purpose: 'order',
      }),
      transportB.send({
        sender: owner.address,
        calls: [{ to: owner.address, data: '0x' }],
        purpose: 'order',
      }),
    ]);

    expect(resultA.status).toBe('CONFIRMED');
    expect(resultB.status).toBe('CONFIRMED');
    const nonceA = (routeA.seen.find((s) => s.method === 'eth_sendUserOperation')?.params[0] as
      | { nonce: Hex }
      | undefined)?.nonce;
    const nonceB = (routeB.seen.find((s) => s.method === 'eth_sendUserOperation')?.params[0] as
      | { nonce: Hex }
      | undefined)?.nonce;
    expect(nonceA).toBeDefined();
    expect(nonceB).toBeDefined();
    expect(nonceA).not.toBe(nonceB);

    stop();
  });
});

describe('ITEM 5 — the 90-second SUBMITTED timeout survives the block-driven receipt wait', () => {
  it('answers SUBMITTED, not a hang or a crash, when no receipt ever arrives, using the poll fallback', async () => {
    const { client } = fakePublicClient();
    const route = fakeBundlerRoute(() => null); // never mined, per the bundler
    const transport = bundlerTransport(owner, {
      client,
      bundler: route.transport,
      wsClient: null, // forces the documented poll fallback — no real WebSocket here
      receiptTimeoutMs: 30, // short, so the test does not actually wait 90s
    });

    const result = await transport.send({
      sender: owner.address,
      calls: [{ to: owner.address, data: '0x' }],
      purpose: 'order',
    });

    expect(result.status).toBe('SUBMITTED');
    expect(result.userOpHash).toBe(HASH);
    expect(route.seen.some((s) => s.method === 'eth_getUserOperationReceipt')).toBe(true);
  });

  it('still confirms once the receipt appears on a later poll', async () => {
    const { client } = fakePublicClient();
    let calls = 0;
    const route = fakeBundlerRoute(() => {
      calls += 1;
      return calls < 3 ? null : successReceipt();
    });
    const transport = bundlerTransport(owner, {
      client,
      bundler: route.transport,
      wsClient: null,
      receiptTimeoutMs: 5_000,
    });

    const result = await transport.send({
      sender: owner.address,
      calls: [{ to: owner.address, data: '0x' }],
      purpose: 'order',
    });

    expect(result.status).toBe('CONFIRMED');
    expect(calls).toBeGreaterThanOrEqual(3);
  });
});

describe('R9 speed (2026-10-07): the signed fee, and Mined from the chain', () => {
  it('signs 1.2x viem’s fee estimate, not 2x', async () => {
    const { client } = fakePublicClient();
    const route = fakeBundlerRoute(() => successReceipt());
    const transport = bundlerTransport(owner, { client, bundler: route.transport, wsClient: null, receiptTimeoutMs: 5_000 });
    const estimate = await client.estimateFeesPerGas({ chain: client.chain, type: 'eip1559' });
    await transport.send({ sender: owner.address, calls: [{ to: owner.address, data: '0x' }], purpose: 'order' });
    const sent = route.seen.find((s) => s.method === 'eth_sendUserOperation')!.params[0] as {
      maxFeePerGas: Hex;
      maxPriorityFeePerGas: Hex;
    };
    // The fake's base fee is constant, so the estimate at send time equals this one.
    expect(BigInt(sent.maxFeePerGas)).toBe((estimate.maxFeePerGas * 12n) / 10n);
    expect(BigInt(sent.maxPriorityFeePerGas)).toBe((estimate.maxPriorityFeePerGas * 12n) / 10n);
  });

  it('signals Mined the moment the UserOperationEvent arrives, before the bundler has a receipt', async () => {
    const { client } = fakePublicClient();
    let receiptAsks = 0;
    let minedAtAsk: number | undefined;
    const route = fakeBundlerRoute(() => {
      receiptAsks += 1;
      // The bundler lags: no receipt on the first three asks.
      return receiptAsks < 4 ? null : successReceipt();
    });
    let onLogsCb: ((logs: unknown[]) => void) | undefined;
    // A WebSocket client double: the event subscription, and blocks driven by a timer.
    const ws = {
      watchContractEvent: (opts: { args: { userOpHash: Hex }; onLogs: (logs: unknown[]) => void }) => {
        expect(opts.args.userOpHash).toBe(HASH);
        onLogsCb = opts.onLogs;
        return () => {};
      },
      watchBlocks: ({ onBlock }: { onBlock: () => void }) => {
        const t = setInterval(onBlock, 20);
        return () => clearInterval(t);
      },
    } as unknown as PublicClient;
    const transport = bundlerTransport(owner, { client, bundler: route.transport, wsClient: ws, receiptTimeoutMs: 5_000 });
    const stages: string[] = [];
    const pending = transport.send({ sender: owner.address, calls: [{ to: owner.address, data: '0x' }], purpose: 'order' }, (stage) => {
      stages.push(stage);
      if (stage === 'mining') minedAtAsk = receiptAsks;
    });
    // The operation lands: the chain pushes its event before the bundler's receipt exists.
    for (let i = 0; i < 50 && !onLogsCb; i += 1) await flush();
    onLogsCb!([{ args: { userOpHash: HASH } }]);
    const result = await pending;
    expect(result.status).toBe('CONFIRMED');
    expect(stages.filter((s) => s === 'mining')).toHaveLength(1);
    expect(minedAtAsk).toBeLessThan(4);
  });
});

describe('R9 (2026-10-07): Mined from the event, subscribed before the hand-off', () => {
  it('subscribes from the operation’s own hash before sending, and an early event lights Mined right after Sent', async () => {
    const { client } = fakePublicClient();
    const order: string[] = [];
    let subscribedHash: Hex | undefined;
    let onLogsCb: ((logs: unknown[]) => void) | undefined;
    let subscriptions = 0;
    const route = fakeBundlerRoute(
      () => null,
      () => {
        order.push('send');
        // The chain includes it before the bundler's answer reaches the browser.
        onLogsCb?.([{ args: { userOpHash: subscribedHash } }]);
        return subscribedHash!;
      },
    );
    const ws = {
      watchContractEvent: (opts: { args: { userOpHash: Hex }; onLogs: (logs: unknown[]) => void }) => {
        order.push('subscribe');
        subscriptions += 1;
        subscribedHash = opts.args.userOpHash;
        onLogsCb = opts.onLogs;
        return () => {};
      },
      watchBlocks: () => () => {},
    } as unknown as PublicClient;
    const transport = bundlerTransport(owner, { client, bundler: route.transport, wsClient: ws, receiptTimeoutMs: 200 });
    const stages: string[] = [];
    await transport.send({ sender: owner.address, calls: [{ to: owner.address, data: '0x' }], purpose: 'order' }, (stage) =>
      stages.push(stage),
    );
    expect(order.slice(0, 2)).toEqual(['subscribe', 'send']);
    expect(subscriptions).toBe(1);
    expect(stages.indexOf('mining')).toBe(stages.indexOf('submitting') + 1);
  });
});

describe('R9 (2026-10-07): the estimate pre-warmed alongside the gas quote', () => {
  const calls = [{ to: owner.address, data: '0x' as Hex }];
  const ws = { watchContractEvent: () => () => {}, watchBlocks: () => () => {} } as unknown as PublicClient;

  it('is used when the send carries the very same calls, and the estimate is not asked again', async () => {
    const { client } = fakePublicClient({ delegated: true });
    const route = fakeBundlerRoute(() => null);
    const deps = { client, bundler: route.transport, wsClient: ws, receiptTimeoutMs: 200 };
    // One send first, so the account is known to be delegated (a first operation is never pre-warmed).
    await bundlerTransport(owner, deps).send({ sender: owner.address, calls, purpose: 'order' });
    const before = route.seen.filter((c) => c.method === 'eth_estimateUserOperationGas').length;
    prewarmOperation(owner, { sender: owner.address, calls }, deps);
    await bundlerTransport(owner, deps).send({ sender: owner.address, calls, purpose: 'order' });
    expect(route.seen.filter((c) => c.method === 'eth_estimateUserOperationGas').length).toBe(before + 1);
  });

  it('is not used for different calls: those are estimated fresh', async () => {
    const { client } = fakePublicClient({ delegated: true });
    const route = fakeBundlerRoute(() => null);
    const deps = { client, bundler: route.transport, wsClient: ws, receiptTimeoutMs: 200 };
    await bundlerTransport(owner, deps).send({ sender: owner.address, calls, purpose: 'order' });
    const before = route.seen.filter((c) => c.method === 'eth_estimateUserOperationGas').length;
    prewarmOperation(owner, { sender: owner.address, calls }, deps);
    const other = [{ to: owner.address, data: '0x01' as Hex }];
    await bundlerTransport(owner, deps).send({ sender: owner.address, calls: other, purpose: 'order' });
    // The warm-up's own estimate, plus a fresh one for the calls actually sent.
    expect(route.seen.filter((c) => c.method === 'eth_estimateUserOperationGas').length).toBe(before + 2);
  });
});
