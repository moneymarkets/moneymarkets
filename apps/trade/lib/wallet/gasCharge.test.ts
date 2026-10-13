import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildFeeLeg, MAINNET } from '@tradepro/core';
import type * as TicketModule from '../ticket';
import type { Progress } from '../ticket';
import type * as BundlerTransportModule from '../fund/bundlerTransport';
import type { GasAllowance, GasQuoteResult } from './gasCharge';

/**
 * `gasCharge.ts` is the one place this app talks to the relayer's free-tier-then-
 * charged-gas policy. These tests cover what the task asked for directly:
 *
 *   - a fee-leg built from a quote matches that quote exactly (`buildFeeLeg`, the
 *     same function the browser and the relayer both use)
 *   - `FEE_LEG_MISMATCH` rebuilds once from `expectedFee` and does not loop
 *   - `GAS_FEE_QUOTE_EXPIRED` requotes once and does not loop
 *   - the banner's two variants (`isGasChargeActive`)
 *   - the "$0.002" → real-minimum copy correction
 *
 * `run()` (which actually signs and submits) is stubbed, the same way
 * `swap.test.ts` stubs it: what matters here is the ORDER of calls into it and
 * exactly which `calls` array each one carries, not the real bundler transport.
 */

const runSpy = vi.fn(async (_opts: unknown): Promise<Progress> => ({ state: 'CONFIRMED' as const }));
vi.mock('../ticket', async (importOriginal) => {
  const actual = await importOriginal<typeof TicketModule>();
  return { ...actual, run: runSpy };
});

vi.mock('../fund/bundlerTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof BundlerTransportModule>();
  return { ...actual, readGasQuoteFeePair: vi.fn(async () => undefined) };
});

const {
  approximateFeeDollars,
  feeLineText,
  formatFeeAmount,
  formatMonApprox,
  isGasChargeActive,
  planFeeLeg,
  refusalChoices,
  requestGasQuote,
  runWithGasCharge,
} = await import('./gasCharge');

const SENDER = '0x43a275C3Eb0BE7313f847FFA4fb6Bd366606A961' as const;
const MARGIN_ACCOUNT = MAINNET.kuru.marginAccount as `0x${string}`;
const USDC = MAINNET.tokens.USDC.address;
const AUSD = MAINNET.tokens.AUSD.address;
// A real, correctly-checksummed address — stands in for the relayer's fee
// recipient. Its identity does not matter to any test; only that `buildFeeLeg`
// (real code, not a stub) can encode a `transfer` to it without choking on a
// malformed address.
const RECIPIENT = MAINNET.tokens.USDT0.address;

function allowance(overrides: Partial<GasAllowance> = {}): GasAllowance {
  return {
    address: SENDER,
    freeActions: { limit: 20, used: 20, remaining: 0, resetsAt: 1_800_000_000_000, allFreeAt: null },
    charging: true,
    fee: { tokens: ['USDC', 'AUSD'], decimals: 6, minimum: 5_000n, step: 1_000n },
    ...overrides,
  };
}

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 400,
    json: async () => body,
  } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  runSpy.mockClear();
  runSpy.mockReset();
  runSpy.mockImplementation(async () => ({ state: 'CONFIRMED' as const }));
});

describe('isGasChargeActive — the banner/fee-line gate', () => {
  it('is false when this deployment is not charging at all, whatever the free-action count', () => {
    expect(isGasChargeActive(allowance({ charging: false, freeActions: { ...allowance().freeActions, remaining: 0 } }))).toBe(false);
  });

  it('is false while free actions remain, even though the deployment charges', () => {
    expect(isGasChargeActive(allowance({ freeActions: { ...allowance().freeActions, remaining: 3 } }))).toBe(false);
  });

  it('is true only once charging AND the free tier is exhausted together', () => {
    expect(isGasChargeActive(allowance())).toBe(true);
  });

  it('is false for undefined — no allowance read yet is never treated as "charging"', () => {
    expect(isGasChargeActive(undefined)).toBe(false);
  });
});

describe('formatFeeAmount / approximateFeeDollars — the $0.002 -> real-minimum correction', () => {
  it('formats the real GAS_FEE_MINIMUM (0.005) exactly, never the design spec\'s placeholder $0.002', () => {
    expect(formatFeeAmount(5_000n, 6)).toBe('0.005');
    expect(approximateFeeDollars(allowance())).toBe('$0.005');
    expect(approximateFeeDollars(allowance())).not.toContain('0.002');
  });

  it('formats an arbitrary computed fee to three places, matching the task\'s own example', () => {
    expect(formatFeeAmount(6_000n, 6)).toBe('0.006');
  });
});

describe('feeLineText — exact copy per screen', () => {
  it('is "Paid for you" while free actions remain', () => {
    const a = allowance({ freeActions: { ...allowance().freeActions, remaining: 5 } });
    expect(feeLineText({ allowance: a })).toBe('Paid for you');
  });

  it('is "Paid for you" when a quote comes back sponsored even though the tier is exhausted', () => {
    const a = allowance();
    expect(feeLineText({ allowance: a, quote: { charge: 'sponsored', reason: 'free-action' } })).toBe(
      'Paid for you',
    );
  });

  it('is the exact "Gas: <amount> <SYMBOL> from your trading balance" format once priced', () => {
    const a = allowance();
    const quote: GasQuoteResult = {
      charge: 'fee',
      reason: 'free-actions-used',
      fee: {
        token: USDC,
        symbol: 'USDC',
        decimals: 6,
        recipient: RECIPIENT,
        minimum: 5_000n,
        step: 1_000n,
        marginPct: 20,
        pricing: { baseFeePerGas: 100n, monUsdMid: 1n, quotedAt: 0, expiresAt: 0 },
        amount: 6_000n,
        calls: [],
      },
    };
    expect(feeLineText({ allowance: a, quote })).toBe('Gas: 0.006 USDC from your trading balance');
  });

  it('names the charge when a MON budget was reached while free actions remain (D191 item 2): never "Paid for you"', () => {
    // Seen on production 2026-09-29: 12 of 20 left, the hourly budget spent, the relayer
    // charged 0.005 AUSD from the trading balance while the sheet said "Paid for you".
    const a = allowance({ freeActions: { ...allowance().freeActions, remaining: 12 } });
    const quote: GasQuoteResult = {
      charge: 'fee',
      reason: 'sponsorship-budget-used',
      fee: {
        token: USDC,
        symbol: 'AUSD',
        decimals: 6,
        recipient: RECIPIENT,
        minimum: 5_000n,
        step: 1_000n,
        marginPct: 20,
        pricing: { baseFeePerGas: 100n, monUsdMid: 1n, quotedAt: 0, expiresAt: 0 },
        amount: 5_000n,
        calls: [],
      },
    };
    expect(feeLineText({ allowance: a, quote })).toBe('Gas: 0.005 AUSD from your trading balance');
  });

  it('is undefined (hidden, never fabricated) when charging is active and no quote exists yet', () => {
    expect(feeLineText({ allowance: allowance() })).toBeUndefined();
  });

  it('is B2a\'s exact own-MON line, with the real balance and the reserve, once quoted own-mon', () => {
    const quote: GasQuoteResult = {
      charge: 'own-mon',
      reason: 'own-mon',
      ownMon: {
        gasWei: 70_000_000_000_000_000n, // 0.07 MON
        balanceWei: 12_400_000_000_000_000_000n, // 12.40 MON
        reserveWei: 10_000_000_000_000_000_000n, // 10 MON
        depositWei: 0n,
      },
    };
    expect(feeLineText({ allowance: allowance(), quote })).toBe(
      'Gas: about 0.07 MON from your wallet (balance 12.40 MON, 10 MON must stay)',
    );
  });
});

describe('formatMonApprox — two places, whole values bare', () => {
  it('matches B2a\'s own examples', () => {
    expect(formatMonApprox(70_000_000_000_000_000n)).toBe('0.07');
    expect(formatMonApprox(12_400_000_000_000_000_000n)).toBe('12.40');
    expect(formatMonApprox(10_000_000_000_000_000_000n)).toBe('10');
  });
});

describe('refusalChoices — B2c\'s two live ways forward', () => {
  it('reads the wire\'s own choices from a bundler refusal', () => {
    expect(
      refusalChoices({
        refusalData: { reason: 'FREE_ACTIONS_USED', choices: ['swap-into-mon', 'add-money'] },
      }),
    ).toEqual(['swap-into-mon', 'add-money']);
  });

  it('offers both for a no-trading-balance quote refusal — the exact B2c state', () => {
    expect(
      refusalChoices({
        quote: { charge: 'refused', reason: 'no-trading-balance', message: 'x' },
      }),
    ).toEqual(['swap-into-mon', 'add-money']);
  });

  it('offers none for a pricing or configuration failure', () => {
    expect(
      refusalChoices({ quote: { charge: 'refused', reason: 'unpriced', message: 'x' } }),
    ).toEqual([]);
    expect(
      refusalChoices({ quote: { charge: 'refused', reason: 'not-charging', message: 'x' } }),
    ).toEqual([]);
  });
});

describe('requestGasQuote — parses the relayer\'s three response shapes, or answers undefined', () => {
  it('parses a sponsored quote', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ charge: 'sponsored', reason: 'free-action' })));
    const quote = await requestGasQuote({ sender: SENDER, calls: [{ to: USDC, data: '0x' }] });
    expect(quote).toEqual({ charge: 'sponsored', reason: 'free-action' });
  });

  it('parses a refused quote with its message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ charge: 'refused', reason: 'no-trading-balance', message: 'Nothing to pay with.' }),
      ),
    );
    const quote = await requestGasQuote({ sender: SENDER, calls: [{ to: USDC, data: '0x' }] });
    expect(quote).toEqual({ charge: 'refused', reason: 'no-trading-balance', message: 'Nothing to pay with.' });
  });

  it('parses a priced fee quote, amounts as bigint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          charge: 'fee',
          reason: 'free-actions-used',
          fee: {
            token: USDC,
            symbol: 'USDC',
            decimals: 6,
            recipient: RECIPIENT,
            minimum: '5000',
            step: '1000',
            marginPct: 20,
            pricing: { baseFeePerGas: '100', monUsdMid: '1', quotedAt: 1, expiresAt: 2 },
            amount: '6000',
            calls: [{ to: MARGIN_ACCOUNT, data: '0xaa' }, { to: USDC, data: '0xbb' }],
            gas: { callGasLimit: '1', verificationGasLimit: '2', preVerificationGas: '3' },
            maxFeePerGas: '10',
            maxPriorityFeePerGas: '1',
          },
        }),
      ),
    );
    const quote = await requestGasQuote({ sender: SENDER, calls: [{ to: USDC, data: '0x' }] });
    expect(quote?.charge).toBe('fee');
    if (quote?.charge === 'fee') {
      expect(quote.fee.amount).toBe(6_000n);
      expect(quote.fee.calls).toEqual([{ to: MARGIN_ACCOUNT, data: '0xaa' }, { to: USDC, data: '0xbb' }]);
      expect(quote.fee.recipient).toBe(RECIPIENT);
    }
  });

  it('parses an own-mon quote, figures as bigint (B2a)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          charge: 'own-mon',
          reason: 'own-mon',
          ownMon: {
            gasWei: '70000000000000000',
            balanceWei: '12400000000000000000',
            reserveWei: '10000000000000000000',
            depositWei: '0',
          },
        }),
      ),
    );
    const quote = await requestGasQuote({ sender: SENDER, calls: [{ to: USDC, data: '0x' }] });
    expect(quote).toEqual({
      charge: 'own-mon',
      reason: 'own-mon',
      ownMon: {
        gasWei: 70_000_000_000_000_000n,
        balanceWei: 12_400_000_000_000_000_000n,
        reserveWei: 10_000_000_000_000_000_000n,
        depositWei: 0n,
      },
    });
  });

  it('parses the swap-into-mon sponsored reason (B3)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ charge: 'sponsored', reason: 'swap-into-mon' })));
    const quote = await requestGasQuote({ sender: SENDER, calls: [{ to: USDC, data: '0x' }] });
    expect(quote).toEqual({ charge: 'sponsored', reason: 'swap-into-mon' });
  });

  it('answers undefined on a non-2xx response rather than guessing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, false)));
    const quote = await requestGasQuote({ sender: SENDER, calls: [{ to: USDC, data: '0x' }] });
    expect(quote).toBeUndefined();
  });

  it('answers undefined on a network failure rather than guessing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    const quote = await requestGasQuote({ sender: SENDER, calls: [{ to: USDC, data: '0x' }] });
    expect(quote).toBeUndefined();
  });
});

describe('planFeeLeg — never fabricates a fee leg', () => {
  it('refuses honestly when the relayer says "fee" but could not simulate an amount', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          charge: 'fee',
          reason: 'free-actions-used',
          fee: {
            token: USDC,
            symbol: 'USDC',
            decimals: 6,
            recipient: RECIPIENT,
            minimum: '5000',
            step: '1000',
            marginPct: 20,
            pricing: { baseFeePerGas: '100', monUsdMid: '1', quotedAt: 1, expiresAt: 2 },
            unsimulated: 'no fresh plan',
            // amount/calls deliberately absent
          },
        }),
      ),
    );
    const plan = await planFeeLeg({ sender: SENDER, calls: [{ to: USDC, data: '0x' }] });
    expect(plan.kind).toBe('refused');
  });

  it('answers "unknown" (never a fabricated sponsored default) when the quote could not be read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, false)));
    const plan = await planFeeLeg({ sender: SENDER, calls: [{ to: USDC, data: '0x' }] });
    expect(plan.kind).toBe('unknown');
  });
});

describe('runWithGasCharge', () => {
  it('signs the action alone when the quote is sponsored', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ charge: 'sponsored', reason: 'free-action' })));
    await runWithGasCharge({
      sender: SENDER,
      actionCalls: [{ to: USDC, data: '0xaa' }],
      purpose: 'order',
      marginAccount: MARGIN_ACCOUNT,
      onProgress: () => {},
    });
    expect(runSpy).toHaveBeenCalledTimes(1);
    const call = runSpy.mock.calls[0]![0] as { calls: readonly unknown[] };
    expect(call.calls).toEqual([{ to: USDC, data: '0xaa' }]);
  });

  it('signs the action alone on the own-MON lane: nothing appended, nothing charged (B2a)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          charge: 'own-mon',
          reason: 'own-mon',
          ownMon: {
            gasWei: '70000000000000000',
            balanceWei: '12400000000000000000',
            reserveWei: '10000000000000000000',
            depositWei: '0',
          },
        }),
      ),
    );
    const plans: unknown[] = [];
    await runWithGasCharge({
      sender: SENDER,
      actionCalls: [{ to: USDC, data: '0xaa' }],
      purpose: 'order',
      marginAccount: MARGIN_ACCOUNT,
      onProgress: () => {},
      onFeePlan: (p) => plans.push(p.kind),
    });
    expect(plans).toEqual(['own-mon']);
    expect(runSpy).toHaveBeenCalledTimes(1);
    const call = runSpy.mock.calls[0]![0] as { calls: readonly unknown[] };
    expect(call.calls).toEqual([{ to: USDC, data: '0xaa' }]);
  });

  it('appends exactly the fee leg the quote named before signing', async () => {
    const feeCalls = [
      { to: MARGIN_ACCOUNT, data: '0xwithdraw' },
      { to: USDC, data: '0xtransfer' },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          charge: 'fee',
          reason: 'free-actions-used',
          fee: {
            token: USDC,
            symbol: 'USDC',
            decimals: 6,
            recipient: RECIPIENT,
            minimum: '5000',
            step: '1000',
            marginPct: 20,
            pricing: { baseFeePerGas: '100', monUsdMid: '1', quotedAt: 1, expiresAt: 2 },
            amount: '6000',
            calls: feeCalls,
          },
        }),
      ),
    );
    await runWithGasCharge({
      sender: SENDER,
      actionCalls: [{ to: USDC, data: '0xaa' }],
      purpose: 'order',
      marginAccount: MARGIN_ACCOUNT,
      onProgress: () => {},
    });
    expect(runSpy).toHaveBeenCalledTimes(1);
    const call = runSpy.mock.calls[0]![0] as { calls: readonly unknown[] };
    expect(call.calls).toEqual([{ to: USDC, data: '0xaa' }, ...feeCalls]);
  });

  it('never calls run() at all when the quote refuses the action', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ charge: 'refused', reason: 'no-trading-balance', message: 'Add money.' }),
      ),
    );
    const progress = await runWithGasCharge({
      sender: SENDER,
      actionCalls: [{ to: USDC, data: '0xaa' }],
      purpose: 'order',
      marginAccount: MARGIN_ACCOUNT,
      onProgress: () => {},
    });
    expect(runSpy).not.toHaveBeenCalled();
    expect(progress.state).toBe('REJECTED');
    expect(progress.refusedAtChecking).toBe(true);
    expect(progress.message).toBe('Add money.');
  });

  it('FEE_LEG_MISMATCH: rebuilds once with expectedFee, matching buildFeeLeg exactly, and does not loop', async () => {
    let quoteCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        quoteCalls += 1;
        return jsonResponse({
          charge: 'fee',
          reason: 'free-actions-used',
          fee: {
            token: USDC,
            symbol: 'USDC',
            decimals: 6,
            recipient: RECIPIENT,
            minimum: '5000',
            step: '1000',
            marginPct: 20,
            pricing: { baseFeePerGas: '100', monUsdMid: '1', quotedAt: 1, expiresAt: 2 },
            amount: '6000',
            calls: [
              { to: MARGIN_ACCOUNT, data: '0xoriginal-withdraw' },
              { to: USDC, data: '0xoriginal-transfer' },
            ],
          },
        });
      }),
    );

    const expected = [...buildFeeLeg(MARGIN_ACCOUNT, AUSD, RECIPIENT, 7_000n)].map((c) => ({
      to: c.to,
      data: c.data,
    }));

    let attempt = 0;
    runSpy.mockImplementation(async (opts: unknown) => {
      attempt += 1;
      const calls = (opts as { calls: readonly { to: string; data: string }[] }).calls;
      if (attempt === 1) {
        return {
          state: 'REJECTED' as const,
          result: {
            status: 'REJECTED' as const,
            reason: 'FEE_LEG_MISMATCH',
            refusalData: {
              reason: 'FEE_LEG_MISMATCH' as const,
              expectedFee: { token: AUSD, amount: '7000' },
            },
          },
        };
      }
      // Second attempt: exactly the action call plus the rebuilt fee leg —
      // `buildFeeLeg`, not a hand-rolled substitute — and never a third attempt.
      expect(calls).toEqual([{ to: USDC, data: '0xaa' }, ...expected]);
      return { state: 'CONFIRMED' as const };
    });

    const progress = await runWithGasCharge({
      sender: SENDER,
      actionCalls: [{ to: USDC, data: '0xaa' }],
      purpose: 'order',
      marginAccount: MARGIN_ACCOUNT,
      onProgress: () => {},
    });

    expect(runSpy).toHaveBeenCalledTimes(2);
    expect(quoteCalls).toBe(1); // no re-quote for a mismatch retry — it rebuilds from expectedFee
    expect(progress.state).toBe('CONFIRMED');
  });

  it('GAS_FEE_QUOTE_EXPIRED: requotes once and resubmits, and does not loop on a second expiry', async () => {
    let quoteCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        quoteCalls += 1;
        return jsonResponse({
          charge: 'fee',
          reason: 'free-actions-used',
          fee: {
            token: USDC,
            symbol: 'USDC',
            decimals: 6,
            recipient: RECIPIENT,
            minimum: '5000',
            step: '1000',
            marginPct: 20,
            pricing: { baseFeePerGas: '100', monUsdMid: '1', quotedAt: quoteCalls, expiresAt: quoteCalls + 1 },
            amount: '6000',
            calls: [
              { to: MARGIN_ACCOUNT, data: `0xwithdraw-${quoteCalls}` },
              { to: USDC, data: `0xtransfer-${quoteCalls}` },
            ],
          },
        });
      }),
    );

    let attempt = 0;
    runSpy.mockImplementation(async () => {
      attempt += 1;
      if (attempt === 1) {
        return {
          state: 'REJECTED' as const,
          result: {
            status: 'REJECTED' as const,
            reason: 'GAS_FEE_QUOTE_EXPIRED',
            refusalData: { reason: 'GAS_FEE_QUOTE_EXPIRED' as const },
          },
        };
      }
      return { state: 'CONFIRMED' as const };
    });

    const progress = await runWithGasCharge({
      sender: SENDER,
      actionCalls: [{ to: USDC, data: '0xaa' }],
      purpose: 'order',
      marginAccount: MARGIN_ACCOUNT,
      onProgress: () => {},
    });

    expect(runSpy).toHaveBeenCalledTimes(2);
    expect(quoteCalls).toBe(2); // one fresh quote for the retry, no more
    expect(progress.state).toBe('CONFIRMED');

    // The second call's calls array carries the SECOND quote's fee calls, not the
    // first (stale) one's — proves the retry actually rebuilt from a fresh quote.
    const secondCall = runSpy.mock.calls[1]![0] as { calls: readonly { to: string; data: string }[] };
    expect(secondCall.calls[1]!.data).toBe('0xwithdraw-2');
  });

  it('a second FEE_LEG_MISMATCH on the retry itself is returned as a normal rejection, not retried again', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          charge: 'fee',
          reason: 'free-actions-used',
          fee: {
            token: USDC,
            symbol: 'USDC',
            decimals: 6,
            recipient: RECIPIENT,
            minimum: '5000',
            step: '1000',
            marginPct: 20,
            pricing: { baseFeePerGas: '100', monUsdMid: '1', quotedAt: 1, expiresAt: 2 },
            amount: '6000',
            calls: [{ to: MARGIN_ACCOUNT, data: '0xa' }, { to: USDC, data: '0xb' }],
          },
        }),
      ),
    );
    const mismatchResult = {
      state: 'REJECTED' as const,
      result: {
        status: 'REJECTED' as const,
        reason: 'FEE_LEG_MISMATCH',
        refusalData: {
          reason: 'FEE_LEG_MISMATCH' as const,
          expectedFee: { token: AUSD, amount: '7000' },
        },
      },
    };
    runSpy.mockImplementation(async () => mismatchResult);

    const progress = await runWithGasCharge({
      sender: SENDER,
      actionCalls: [{ to: USDC, data: '0xaa' }],
      purpose: 'order',
      marginAccount: MARGIN_ACCOUNT,
      onProgress: () => {},
    });

    expect(runSpy).toHaveBeenCalledTimes(2); // one original + exactly one retry
    expect(progress.state).toBe('REJECTED');
  });
});

describe('Send, Withdraw and cancel never touch gas-charge machinery', () => {
  // A grep-level guard, not a behavioral one: these three screens are exempt at
  // the relayer's own policy level (`exemptionOf`, `isSendOrWithdraw` —
  // `moveOut.test.ts` proves that against the real function), so the fastest way
  // to keep the exemption honest here is to prove neither screen even imports the
  // module that would let it quote or attempt a fee leg.
  const root = join(__dirname, '..', '..');
  const screens = [
    join(root, 'app', 'send', 'SendScreen.tsx'),
    join(root, 'app', 'withdraw', 'WithdrawScreen.tsx'),
  ];

  it.each(screens)('%s does not import lib/wallet/gasCharge', (path) => {
    const source = readFileSync(path, 'utf8');
    expect(source).not.toMatch(/wallet\/gasCharge/);
  });
});
