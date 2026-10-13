'use client';

import { useCallback, useEffect, useState } from 'react';
import { buildFeeLeg, type GasChargeRefusalData } from '@tradepro/core';
import type { Address, Hex } from 'viem';
import { apiUrl } from '../basePath';
import { prewarmOperation, readGasQuoteFeePair } from '../fund/bundlerTransport';
import { run, type OnProgress, type Progress, type RunOptions } from '../ticket';

/**
 * The one place this app talks to the relayer's free-tier-then-charged-gas policy
 * (`GET /v1/gas/allowance`, `POST /v1/gas/quote`, and the `-32000` refusals
 * `/v1/bundler` sends once a batch is signed). Every screen that can be charged —
 * the order ticket, Swap, Move-in — goes through `planFeeLeg`/`runWithGasCharge`
 * here rather than hand-rolling its own fee-quoting or fee-leg-appending logic.
 *
 * Send, Withdraw and cancel never call any of this: the relayer's own `exemptionOf`
 * (`packages/core/src/gas/policy.ts`) classifies a batch made only of a withdraw
 * and/or a pinned-token transfer as `'own-funds'`, and Move-out is exactly that
 * shape (`moveOut.ts`'s own doc comment). A batch that can never be charged does not
 * need a quote to say so.
 *
 * ## What "charging" actually means
 *
 * `/v1/gas/allowance`'s `charging` field is a **deployment** flag — is this relayer
 * configured with a fee address at all — not a per-account one. Showing the
 * exhausted-tier banner on `charging` alone would show it to every signed-in user
 * the instant a fee address is configured, whether or not they have used a single
 * free action today. The per-account fact is `freeActions.remaining`, so every
 * decision in this module and in the screens that use it is `charging &&
 * freeActions.remaining <= 0` together, never `charging` by itself.
 *
 * ## Anti-fabrication
 *
 * A quote that could not be read is `undefined`, never a guessed "sponsored" or a
 * stale figure from the last successful read. Every caller is expected to hide the
 * fee line, not show a fallback one, when this module answers `undefined` (see the
 * task's own "no allowance data yet" rule).
 */

const RELAYER_QUOTE_CALL_LIMIT = 16;

/* ------------------------------------------------------------------------------- */
/* Allowance                                                                        */
/* ------------------------------------------------------------------------------- */

export interface FreeActionsInfo {
  readonly limit: number;
  readonly used: number;
  readonly remaining: number;
  /** Epoch ms, or `null` when nothing is counted yet. */
  readonly resetsAt: number | null;
  /** Epoch ms, or `null` when nothing is counted yet. */
  readonly allFreeAt: number | null;
}

export interface GasAllowance {
  readonly address: Address;
  readonly freeActions: FreeActionsInfo;
  /** Deployment-level: is this relayer configured to charge at all. See the module
   *  doc above — never read alone to decide what to show a given account. */
  readonly charging: boolean;
  readonly fee: {
    readonly tokens: readonly string[];
    readonly decimals: number;
    readonly minimum: bigint;
    readonly step: bigint;
  };
}

/** The one, per-account fact the banner and the fee lines actually branch on. */
export function isGasChargeActive(allowance: GasAllowance | undefined): boolean {
  return !!allowance && allowance.charging && allowance.freeActions.remaining <= 0;
}

interface AllowanceWire {
  readonly address: string;
  readonly freeActions: {
    readonly limit: number;
    readonly used: number;
    readonly remaining: number;
    readonly resetsAt: number | null;
    readonly allFreeAt: number | null;
  };
  readonly charging: boolean;
  readonly fee: {
    readonly tokens: readonly string[];
    readonly decimals: number;
    readonly minimum: string;
    readonly step: string;
  };
}

/**
 * `GET /api/gas/allowance` (our own proxy to `/v1/gas/allowance`). `undefined` on
 * any failure — a network error, a non-2xx status, an unreadable body — never a
 * fabricated "not charging" default. Callers render the free-actions ring, the
 * "Free actions today" card and the exhausted-tier banner only once this has
 * resolved to a real value.
 */
export async function fetchGasAllowance(address: Address): Promise<GasAllowance | undefined> {
  try {
    const res = await fetch(apiUrl(`/api/gas/allowance?address=${address}`), { cache: 'no-store' });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { allowance: AllowanceWire | null };
    if (!body.allowance) return undefined;
    const a = body.allowance;
    return {
      address: a.address as Address,
      freeActions: { ...a.freeActions },
      charging: a.charging,
      fee: {
        tokens: a.fee.tokens,
        decimals: a.fee.decimals,
        minimum: BigInt(a.fee.minimum),
        step: BigInt(a.fee.step),
      },
    };
  } catch {
    return undefined;
  }
}

const ALLOWANCE_POLL_MS = 15_000;

export interface UseGasAllowanceResult {
  /** `undefined` while loading, or when the last read failed — never a fabricated
   *  "not charging" default (see the module doc above). */
  readonly allowance: GasAllowance | undefined;
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  /** Forces an immediate read — call after any action completes, so the exhausted-
   *  tier banner (dismissed for the session) can reappear against the account's
   *  freshly-used count rather than the figure from fifteen seconds ago. */
  readonly refresh: () => void;
}

/**
 * The free-actions ledger, polled the same way `useAccountBalances` polls chain
 * state: while the tab is visible, paused otherwise. Shared by the Wallet home ring
 * and card, the app-wide exhausted-tier banner, and Move's fee line — one read, not
 * a disagreeing one per screen.
 */
export function useGasAllowance(address: Address | undefined): UseGasAllowanceResult {
  const [allowance, setAllowance] = useState<GasAllowance | undefined>(undefined);
  const [status, setStatus] = useState<UseGasAllowanceResult['status']>(address ? 'loading' : 'idle');
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!address) {
      setAllowance(undefined);
      setStatus('idle');
      return;
    }
    let cancelled = false;
    let timer: number | undefined;

    async function load() {
      const next = await fetchGasAllowance(address as Address);
      if (cancelled) return;
      if (next) {
        setAllowance(next);
        setStatus('ready');
      } else {
        // A failed read leaves the last-known allowance in place rather than
        // clobbering it with `undefined` — a transient hiccup should not blank a
        // ring that was showing a real number a moment ago. The very first read
        // has nothing to fall back to, and reports `error` honestly.
        setStatus((s) => (s === 'ready' ? 'ready' : 'error'));
      }
    }

    function scheduleNext() {
      if (cancelled) return;
      timer = window.setTimeout(() => {
        if (document.visibilityState === 'visible') void load().then(scheduleNext);
        else scheduleNext();
      }, ALLOWANCE_POLL_MS);
    }

    void load().then(scheduleNext);

    function onVisible() {
      if (document.visibilityState === 'visible') void load();
    }
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [address, nonce]);

  return { allowance, status, refresh };
}

/* ------------------------------------------------------------------------------- */
/* Quote                                                                            */
/* ------------------------------------------------------------------------------- */

export type GasQuotePurpose = 'order' | 'cancel' | 'deposit' | 'withdraw' | 'swap';

export interface GasQuoteCall {
  readonly to: Address;
  readonly data: Hex;
  /** Native value, for a call that carries it (the WMON wrap, a plain native send, or
   *  a native margin deposit — D200). Quoted as sent. */
  readonly value?: bigint;
}

export interface GasFeePricingWire {
  readonly baseFeePerGas: bigint;
  readonly monUsdMid: bigint;
  readonly quotedAt: number;
  readonly expiresAt: number;
}

export interface GasFeeQuote {
  readonly token: Address;
  readonly symbol: string;
  readonly decimals: number;
  readonly recipient: Address;
  readonly minimum: bigint;
  readonly step: bigint;
  readonly marginPct: number;
  readonly pricing: GasFeePricingWire;
  /** Present only when the batch simulated to the unit — see `unsimulated` below. */
  readonly amount?: bigint;
  readonly calls?: readonly GasQuoteCall[];
  readonly gas?: {
    readonly callGasLimit: bigint;
    readonly verificationGasLimit: bigint;
    readonly preVerificationGas: bigint;
  };
  readonly maxFeePerGas?: bigint;
  readonly maxPriorityFeePerGas?: bigint;
  /** The relayer's own reason it could not simulate the batch to the unit. */
  readonly unsimulated?: string;
}

/** B2a: the own-MON lane's real, read figures — never estimated client-side. */
export interface OwnMonQuote {
  /** What the EntryPoint will draw from the wallet for this operation, wei. */
  readonly gasWei: bigint;
  readonly balanceWei: bigint;
  /** Monad's delegated-account reserve the balance must keep (10 MON). */
  readonly reserveWei: bigint;
  readonly depositWei: bigint;
}

export type GasQuoteResult =
  | {
      readonly charge: 'sponsored';
      readonly reason: 'own-funds' | 'free-action' | 'cancel' | 'swap-into-mon';
    }
  | { readonly charge: 'own-mon'; readonly reason: 'own-mon'; readonly ownMon: OwnMonQuote }
  | {
      readonly charge: 'refused';
      readonly reason: 'no-trading-balance' | 'unpriced' | 'not-charging';
      readonly message: string;
      /** The relayer's own live choices (B2c/D182-R2): 'swap-into-mon' only while
       *  the pool that would sponsor that swap has room. */
      readonly choices?: readonly GasRefusalChoice[];
    }
  | {
      readonly charge: 'fee';
      readonly reason: 'free-actions-used' | 'sponsorship-budget-used';
      readonly fee: GasFeeQuote;
      readonly sponsorshipResetsAt?: number;
    };

interface QuoteWire {
  readonly charge: 'sponsored' | 'own-mon' | 'refused' | 'fee';
  readonly reason: string;
  readonly message?: string;
  readonly choices?: readonly string[];
  readonly sponsorshipResetsAt?: number;
  readonly ownMon?: {
    readonly gasWei: string;
    readonly balanceWei: string;
    readonly reserveWei: string;
    readonly depositWei: string;
  };
  readonly fee?: {
    readonly token: string;
    readonly symbol: string;
    readonly decimals: number;
    readonly recipient: string;
    readonly minimum: string;
    readonly step: string;
    readonly marginPct: number;
    readonly pricing: { baseFeePerGas: string; monUsdMid: string; quotedAt: number; expiresAt: number };
    readonly amount?: string;
    readonly calls?: readonly { to: string; data: string }[];
    readonly gas?: { callGasLimit: string; verificationGasLimit: string; preVerificationGas: string };
    readonly maxFeePerGas?: string;
    readonly maxPriorityFeePerGas?: string;
    readonly unsimulated?: string;
  };
}

function toHexQuantity(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function parseQuoteWire(body: QuoteWire): GasQuoteResult | undefined {
  if (body.charge === 'sponsored') {
    if (
      body.reason !== 'own-funds' &&
      body.reason !== 'free-action' &&
      body.reason !== 'cancel' &&
      body.reason !== 'swap-into-mon'
    ) {
      return undefined;
    }
    return { charge: 'sponsored', reason: body.reason };
  }
  if (body.charge === 'own-mon') {
    if (body.reason !== 'own-mon' || !body.ownMon) return undefined;
    try {
      return {
        charge: 'own-mon',
        reason: 'own-mon',
        ownMon: {
          gasWei: BigInt(body.ownMon.gasWei),
          balanceWei: BigInt(body.ownMon.balanceWei),
          reserveWei: BigInt(body.ownMon.reserveWei),
          depositWei: BigInt(body.ownMon.depositWei),
        },
      };
    } catch {
      return undefined;
    }
  }
  if (body.charge === 'refused') {
    if (body.reason !== 'no-trading-balance' && body.reason !== 'unpriced' && body.reason !== 'not-charging') {
      return undefined;
    }
    const choices = body.choices?.filter(
      (c): c is GasRefusalChoice => c === 'swap-into-mon' || c === 'add-money',
    );
    return {
      charge: 'refused',
      reason: body.reason,
      message: body.message ?? 'Nothing was sent.',
      ...(choices ? { choices } : {}),
    };
  }
  if (body.charge === 'fee' && body.fee) {
    if (body.reason !== 'free-actions-used' && body.reason !== 'sponsorship-budget-used') return undefined;
    const f = body.fee;
    return {
      charge: 'fee',
      reason: body.reason,
      ...(body.sponsorshipResetsAt !== undefined ? { sponsorshipResetsAt: body.sponsorshipResetsAt } : {}),
      fee: {
        token: f.token as Address,
        symbol: f.symbol,
        decimals: f.decimals,
        recipient: f.recipient as Address,
        minimum: BigInt(f.minimum),
        step: BigInt(f.step),
        marginPct: f.marginPct,
        pricing: {
          baseFeePerGas: BigInt(f.pricing.baseFeePerGas),
          monUsdMid: BigInt(f.pricing.monUsdMid),
          quotedAt: f.pricing.quotedAt,
          expiresAt: f.pricing.expiresAt,
        },
        ...(f.amount !== undefined ? { amount: BigInt(f.amount) } : {}),
        ...(f.calls ? { calls: f.calls.map((c) => ({ to: c.to as Address, data: c.data as Hex })) } : {}),
        ...(f.gas
          ? {
              gas: {
                callGasLimit: BigInt(f.gas.callGasLimit),
                verificationGasLimit: BigInt(f.gas.verificationGasLimit),
                preVerificationGas: BigInt(f.gas.preVerificationGas),
              },
            }
          : {}),
        ...(f.maxFeePerGas !== undefined ? { maxFeePerGas: BigInt(f.maxFeePerGas) } : {}),
        ...(f.maxPriorityFeePerGas !== undefined ? { maxPriorityFeePerGas: BigInt(f.maxPriorityFeePerGas) } : {}),
        ...(f.unsimulated ? { unsimulated: f.unsimulated } : {}),
      },
    };
  }
  return undefined;
}

/**
 * `POST /v1/gas/quote` (via `/api/gas/quote`) for the action's calls alone — never a
 * batch that already carries a fee leg, which the relayer refuses on principle (it
 * builds the fee leg, not the client). `undefined` on any failure: a caller that
 * cannot get a quote does not guess one.
 */
export async function requestGasQuote(input: {
  readonly sender: Address;
  readonly calls: readonly GasQuoteCall[];
  readonly maxFeePerGas?: bigint;
  readonly maxPriorityFeePerGas?: bigint;
}): Promise<GasQuoteResult | undefined> {
  if (input.calls.length === 0 || input.calls.length > RELAYER_QUOTE_CALL_LIMIT) return undefined;
  try {
    const res = await fetch(apiUrl('/api/gas/quote'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sender: input.sender,
        calls: input.calls.map((c) => ({
          to: c.to,
          data: c.data,
          ...(c.value !== undefined && c.value > 0n ? { value: c.value.toString() } : {}),
        })),
        ...(input.maxFeePerGas !== undefined ? { maxFeePerGas: toHexQuantity(input.maxFeePerGas) } : {}),
        ...(input.maxPriorityFeePerGas !== undefined
          ? { maxPriorityFeePerGas: toHexQuantity(input.maxPriorityFeePerGas) }
          : {}),
      }),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as QuoteWire;
    return parseQuoteWire(body);
  } catch {
    return undefined;
  }
}

/**
 * The same quote, priced against the fresh fee pair `run()`'s own transport would
 * sign with (`readGasQuoteFeePair`), so the relayer can answer "to the unit"
 * (`fee.amount`/`fee.calls`/`fee.gas`) whenever it is able to, instead of the
 * unsimulated fallback. Prefer this over `requestGasQuote` directly unless a caller
 * already has its own fee pair in hand.
 */
export async function requestGasQuoteExact(input: {
  readonly sender: Address;
  readonly calls: readonly GasQuoteCall[];
}): Promise<GasQuoteResult | undefined> {
  const feePair = await readGasQuoteFeePair();
  return requestGasQuote({
    sender: input.sender,
    calls: input.calls,
    ...(feePair ? feePair : {}),
  });
}

/* ------------------------------------------------------------------------------- */
/* Fee line copy                                                                    */
/* ------------------------------------------------------------------------------- */

/** "0.006" — three places, the fee step's own granularity (`GAS_FEE_STEP` is
 *  0.001 of a six-decimal dollar), never the token's full six decimals. */
export function formatFeeAmount(amount: bigint, decimals: number): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  const dp = 3;
  const scale = 10n ** BigInt(Math.max(decimals - dp, 0));
  const fracDp = decimals > dp ? frac / scale : frac * 10n ** BigInt(dp - decimals);
  const fracText = fracDp.toString().padStart(dp, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fracText}`;
}

/** "0.07" / "12.40" — MON figures on the own-MON gas line, two places (B2a's own
 *  example), from wei. Whole-MON values drop the fraction ("10", not "10.00"). */
export function formatMonApprox(wei: bigint): string {
  const base = 10n ** 18n;
  const whole = wei / base;
  const cents = ((wei % base) * 100n) / base;
  if (cents === 0n) return whole.toString();
  return `${whole.toString()}.${cents.toString().padStart(2, '0')}`;
}

/**
 * The fee line's exact copy (B5, and B2a for the own-MON lane): `"Paid for you"`
 * while free actions remain (or this deployment is not charging at all); `"Gas:
 * about 0.07 MON from your wallet (balance 12.40 MON, 10 MON must stay)"` when the
 * account's own MON pays; `"Gas: 0.006 USDC from your trading balance"` once a real
 * quote says what the charge is. `undefined` — render nothing — when there is no
 * live quote to show yet and the free tier is exhausted: showing "Paid for you"
 * then would be false, and showing a guessed figure would be fabricated (see the
 * module doc above).
 */
export function feeLineText(input: {
  readonly allowance: GasAllowance | undefined;
  readonly quote?: GasQuoteResult;
}): string | undefined {
  // A live quote wins over the free-tier count (D191 item 2): a MON budget reached while
  // free actions remain charges the action, and "Paid for you" would then be false.
  if (!input.quote) return isGasChargeActive(input.allowance) ? undefined : 'Paid for you';
  if (input.quote.charge === 'sponsored') return 'Paid for you';
  if (input.quote.charge === 'own-mon') {
    const m = input.quote.ownMon;
    return `Gas: about ${formatMonApprox(m.gasWei)} MON from your wallet (balance ${formatMonApprox(m.balanceWei)} MON, ${formatMonApprox(m.reserveWei)} MON must stay)`;
  }
  if (input.quote.charge === 'fee' && input.quote.fee.amount !== undefined) {
    return `Gas: ${formatFeeAmount(input.quote.fee.amount, input.quote.fee.decimals)} ${input.quote.fee.symbol} from your trading balance`;
  }
  return undefined;
}

/**
 * B2c: the two live ways forward a refusal offers. From the wire when the relayer
 * named them (`GasChargeRefusalData.choices`); for a quote-level refusal the same
 * two apply exactly when nothing in the trading balance can pay — the state B2c
 * describes — and never for a pricing or configuration failure.
 */
export type GasRefusalChoice = 'swap-into-mon' | 'add-money';

export function refusalChoices(input: {
  readonly quote?: GasQuoteResult;
  readonly refusalData?: GasChargeRefusalData;
}): readonly GasRefusalChoice[] {
  const fromWire = input.refusalData?.choices;
  if (fromWire && fromWire.length > 0) {
    return fromWire.filter((c): c is GasRefusalChoice => c === 'swap-into-mon' || c === 'add-money');
  }
  // The quote refusal's own choices (D182-R2), when the relayer named them.
  if (input.quote?.charge === 'refused' && input.quote.choices && input.quote.choices.length > 0) {
    return input.quote.choices;
  }
  if (input.quote?.charge === 'refused' && input.quote.reason === 'no-trading-balance') {
    return ['swap-into-mon', 'add-money'];
  }
  return [];
}

/** "about $0.005" — the Home card and the banner's own approximate figure, from the
 *  allowance's own minimum rather than a live per-action quote. */
export function approximateFeeDollars(allowance: GasAllowance): string {
  return `$${formatFeeAmount(allowance.fee.minimum, allowance.fee.decimals)}`;
}

/* ------------------------------------------------------------------------------- */
/* Batch construction: quote, then append a fee leg before signing                 */
/* ------------------------------------------------------------------------------- */

export type FeeLegPlan =
  | { readonly kind: 'sponsored'; readonly quote?: GasQuoteResult }
  | {
      /** B2a: the wallet's own MON pays — nothing appended, nothing charged. */
      readonly kind: 'own-mon';
      readonly quote: Extract<GasQuoteResult, { readonly charge: 'own-mon' }>;
    }
  | {
      readonly kind: 'fee';
      readonly calls: readonly GasQuoteCall[];
      readonly quote: Extract<GasQuoteResult, { readonly charge: 'fee' }>;
    }
  | { readonly kind: 'refused'; readonly message: string; readonly quote?: GasQuoteResult }
  /** The quote could not be read at all — network error, relayer unreachable. */
  | { readonly kind: 'unknown' };

/**
 * Quote the action's calls and decide what, if anything, must be appended before
 * signing. Never fabricates a fee leg: when the relayer's answer says `charge:
 * 'fee'` but could not simulate a concrete amount and calls (`unsimulated`), this
 * refuses rather than guessing — the caller shows the refusal's message and nothing
 * is signed.
 */
export async function planFeeLeg(input: {
  readonly sender: Address;
  readonly calls: readonly GasQuoteCall[];
}): Promise<FeeLegPlan> {
  const quote = await requestGasQuoteExact(input);
  if (!quote) return { kind: 'unknown' };
  if (quote.charge === 'sponsored') return { kind: 'sponsored', quote };
  if (quote.charge === 'own-mon') return { kind: 'own-mon', quote };
  if (quote.charge === 'refused') return { kind: 'refused', message: quote.message, quote };
  // charge === 'fee'
  if (quote.fee.amount === undefined || !quote.fee.calls) {
    return {
      kind: 'refused',
      message: "The network fee couldn't be priced right now. Try again in a moment.",
      quote,
    };
  }
  return { kind: 'fee', calls: quote.fee.calls, quote };
}

/**
 * Rebuild the fee leg from the relayer's `expectedFee` (a `FEE_LEG_MISMATCH` retry)
 * — the exact two calls `buildFeeLeg` would produce for that token and amount, to
 * the same recipient the original quote named. `undefined` when there is nothing to
 * rebuild against (no prior quote's recipient to pay, or an unrecognised token).
 */
function rebuiltFeeLegFrom(
  marginAccount: Address,
  recipient: Address,
  expectedFee: { readonly token: string; readonly amount: string },
): readonly GasQuoteCall[] {
  const [withdraw, transfer] = buildFeeLeg(
    marginAccount,
    expectedFee.token as Address,
    recipient,
    BigInt(expectedFee.amount),
  );
  return [
    { to: withdraw.to, data: withdraw.data },
    { to: transfer.to, data: transfer.data },
  ];
}

export interface RunWithGasChargeInput {
  readonly sender: Address;
  /** The action alone — never a batch that already carries a fee leg. */
  readonly actionCalls: readonly GasQuoteCall[];
  readonly purpose: GasQuotePurpose;
  readonly marginAccount: Address;
  readonly owner?: RunOptions['owner'];
  readonly perfActionId?: string;
  readonly onProgress: OnProgress;
  /**
   * What to keep in the dry-run log instead of the full signed batch — same purpose
   * as `RunOptions.logCalls` (a permit's calldata embeds a bearer signature and is
   * never persisted). The fee leg's own two calls carry no signature and are always
   * safe to log, so this only needs the caller's action-side substitute, if any.
   */
  readonly logCalls?: readonly GasQuoteCall[];
  /** Fired once the fee plan is known, before anything is signed, so a screen can
   *  show the real fee (or the refusal) ahead of the passkey/signing step. */
  readonly onFeePlan?: (plan: FeeLegPlan) => void;
  /** A plan the caller already priced (Swap prices it under its own 15 s step). */
  readonly plan?: FeeLegPlan;
}

/**
 * Quote, maybe append a fee leg, sign and submit — the one path every chargeable
 * screen uses. Handles both retry-once cases generically:
 *
 *   - `FEE_LEG_MISMATCH`: the relayer's fresh gas plan capped the signed limits
 *     below what the fee leg priced for. Rebuilt from the refusal's own
 *     `expectedFee` and resubmitted once.
 *   - `GAS_FEE_QUOTE_EXPIRED`: the quote this batch's fee leg was built from is no
 *     longer the relayer's freshest pricing for this sender. Requoted from scratch
 *     and resubmitted once.
 *
 * Neither loops: a second failure of either kind is returned as a normal REJECTED
 * `Progress`, exactly as `run()` would report any other refusal.
 */
export async function runWithGasCharge(input: RunWithGasChargeInput): Promise<Progress> {
  // R9 (2026-10-07): the estimate runs while the gas is priced, not after it. Used only if
  // the batch sent is exactly the action's calls (a free action); a fee leg means a fresh one.
  if (!input.plan && input.owner) {
    prewarmOperation(input.owner, { sender: input.sender, calls: input.actionCalls });
  }
  const plan = input.plan ?? (await planFeeLeg({ sender: input.sender, calls: input.actionCalls }));
  input.onFeePlan?.(plan);

  if (plan.kind === 'refused') {
    const progress: Progress = { state: 'REJECTED', message: plan.message, refusedAtChecking: true };
    input.onProgress(progress);
    return progress;
  }

  const feeCalls = plan.kind === 'fee' ? plan.calls : [];
  const recipient = plan.kind === 'fee' ? plan.quote.fee.recipient : undefined;

  async function attempt(calls: readonly GasQuoteCall[]): Promise<Progress> {
    return run({
      sender: input.sender,
      calls,
      purpose: input.purpose,
      ...(input.owner ? { owner: input.owner } : {}),
      ...(input.perfActionId ? { perfActionId: input.perfActionId } : {}),
      ...(input.logCalls
        ? { logCalls: [...input.logCalls, ...calls.slice(input.actionCalls.length)] }
        : {}),
      onProgress: input.onProgress,
    });
  }

  const firstCalls = [...input.actionCalls, ...feeCalls];
  const first = await attempt(firstCalls);

  const refusal: GasChargeRefusalData | undefined = first.result?.refusalData;
  if (first.state !== 'REJECTED' || !refusal) return first;

  if (refusal.reason === 'FEE_LEG_MISMATCH' && refusal.expectedFee && recipient) {
    const rebuilt = rebuiltFeeLegFrom(input.marginAccount, recipient, refusal.expectedFee);
    return attempt([...input.actionCalls, ...rebuilt]);
  }

  if (refusal.reason === 'GAS_FEE_QUOTE_EXPIRED') {
    const replanned = await planFeeLeg({ sender: input.sender, calls: input.actionCalls });
    input.onFeePlan?.(replanned);
    if (replanned.kind === 'refused') {
      const progress: Progress = {
        state: 'REJECTED',
        message: replanned.message,
        refusedAtChecking: true,
      };
      input.onProgress(progress);
      return progress;
    }
    const retryCalls = [...input.actionCalls, ...(replanned.kind === 'fee' ? replanned.calls : [])];
    return attempt(retryCalls);
  }

  return first;
}
