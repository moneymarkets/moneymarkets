'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Button,
  Card,
  Chip,
  flyToken,
  confettiBurst,
  Notice,
  Segmented,
  Skeleton,
  TicketState,
  useRowFlash,
  usePrefersReducedMotion,
} from '@tradepro/ui';
import {
  DEFAULT_SLIPPAGE_BPS,
  MAINNET,
  MAX_SPONSORED_PERMIT_VALUE,
  MONAD_DELEGATED_RESERVE_WEI,
  SLIPPAGE_CHOICES_BPS,
  slippageLabel,
} from '@tradepro/core';
import type { Address } from 'viem';
import { Chrome } from '../../../components/Chrome';
import { FailureNotice } from '../../../components/FailureNotice';
import { GasRefusalActions } from '../../../components/GasRefusalActions';
import { SignedOut } from '../../../components/SignedOut';
import { TokenIcon } from '../../../components/TokenIcon';
import { TokenSelectorSheet, type PickedToken } from '../../../components/TokenSelectorSheet';
import { recordActivity } from '../../../lib/activityStore';
import { apiUrl } from '../../../lib/basePath';
import { failure, type Failure } from '../../../lib/failures';
import { displayDp, explorerTxUrl, formatMoney, parseAmount } from '../../../lib/format';
import { preflight, tokenBySymbol } from '../../../lib/fund/pathB';
import { prefetchDelegation, startOrderPrecompute } from '../../../lib/fund/bundlerTransport';
import { beginPerfAction } from '../../../lib/perf/orderPerf';
import { RP_ID, useSession } from '../../../lib/session';
import { isTerminal, segmentOf, type Progress } from '../../../lib/ticket';
import { useAccountBalances, type WalletTokenEntry } from '../../../lib/useAccountBalances';
import { useLazyTokenPrice } from '../../../lib/useLazyTokenPrice';
import { hapticConfirmed, hapticFaceId } from '../../../lib/wallet/haptics';
import { WALLET_HOME_HREF } from '../../../lib/wallet/routeHrefs';
import { ding, swoosh, tick } from '../../../lib/wallet/sound';
import { payWithPermit, swap as runSwap, type SwapQuote } from '../../../lib/wallet/swap';
import { deliveredAmountFromLogs, prefillPayAmountForMon } from '../../../lib/wallet/swapQuote';
import {
  isNative,
  maxNativeSpend,
  NATIVE_MON,
  routeFromWire,
  WMON,
  type SwapKind,
  type SwapRoute,
  type SwapRouteWire,
  type SwapSource,
} from '../../../lib/wallet/swapPlan';
import { fillExact, onEdit } from '../../../lib/wallet/amountField';
import { useWalletPreferences } from '../../../lib/wallet/preferences';
import {
  feeLineText,
  isGasChargeActive,
  useGasAllowance,
  type FeeLegPlan,
} from '../../../lib/wallet/gasCharge';

/**
 * `/wallet/swap` — Swap, rebuilt to `docs/swap-design.html` (v2.1 spec, SECTION 2):
 * token selector FIRST on each side, the amount beneath it, one line naming which
 * balance pays; a searchable selector sheet shared with Send and Move; any token on
 * Monad on either side, listed or not; the quote block with its draining price-hold
 * bar; the confirmation card with both amounts and the measured times; and "Swap
 * again" once done — the countdown stops and never shows "0 s" under a completed
 * swap.
 *
 * Execution: every keyless aggregator quoted at once on the server (KyberSwap, Kuru
 * Flow), ranked by this app's own minimum out, each route simulated from the account;
 * the winner named, every answering vendor listed under "Other routes"; the user's own
 * slippage (0.1, 0.5, 1 or 3%); a quote signed only while under 20 s old, otherwise the
 * button re-quotes before any Face ID prompt (rules 1.1 to 1.8). Nothing re-quotes after
 * the passkey prompt.
 */

const MARGIN_ACCOUNT = MAINNET.kuru.marginAccount as Address;

type SwapPhase = 'idle' | 'signing' | 'settled';

export default function WalletSwapPage() {
  const session = useSession();
  return (
    <Chrome>
      <div className="page">
        <Link href={WALLET_HOME_HREF} className="back">
          ‹ Wallet
        </Link>
        <div className="between">
          <div>
            <h1>Swap</h1>
            <p className="small">Change one token into another at the best price on Monad</p>
          </div>
        </div>
        {session.status !== 'signed-in' || !session.account ? (
          <SignedOut />
        ) : (
          <SwapCard account={session.account} />
        )}
        <Card title="Any token on Monad">
          <p className="small" style={{ marginTop: 6 }}>
            Search by name or symbol, or paste a contract address. Tokens no list knows are
            marked unverified and still swap.
          </p>
        </Card>
      </div>
    </Chrome>
  );
}

/* ------------------------------------------------------------------------------- */

type SimulationWire =
  | { readonly status: 'ok'; readonly delivered: string }
  | { readonly status: 'reverted'; readonly reason: string }
  | { readonly status: 'unchecked' };

interface QuoteWire {
  readonly kind: SwapKind;
  readonly amountIn: string;
  readonly slippageBps: number;
  readonly holdSeconds: number;
  readonly readAt: number;
  readonly routes: readonly (SwapRouteWire & { readonly simulation: SimulationWire })[];
  readonly offered: number | null;
  readonly deliverNative?: boolean;
  readonly feeOnTransfer?: { readonly delivered: string };
  /** Every route reverted: the best one's decoded reason. */
  readonly revert?: string;
  /** Rule 1.4's sentence when no aggregator can route. */
  readonly message?: string;
  /** Rule 1.8: native MON input would take the wallet under its reserve. */
  readonly reserve?: { readonly maxSpend: string };
  /** WMON to MON and MON to WMON: the wrapper, one to one. */
  readonly direct?: { readonly expectedOut: string; readonly minOut: string; readonly simulation: SimulationWire };
}

type QuoteState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly quote: QuoteWire; readonly receivedAt: number }
  | { readonly status: 'error'; readonly failure: Failure };

/** One call to `/api/wallet/swap/quote`, shared by the debounced effect and by the
 *  "Get a new price" button so there is exactly one place that knows the URL. */
async function fetchQuote(input: {
  tokenIn: Address;
  tokenOut: Address;
  amount: bigint;
  address: Address;
  slippageBps: number;
  source: SwapSource;
}): Promise<QuoteState> {
  try {
    const qs = new URLSearchParams({
      tokenIn: input.tokenIn,
      tokenOut: input.tokenOut,
      amount: input.amount.toString(),
      address: input.address,
      slippageBps: String(input.slippageBps),
      source: input.source,
    });
    const res = await fetch(apiUrl(`/api/wallet/swap/quote?${qs.toString()}`), { cache: 'no-store' });
    if (!res.ok) return { status: 'error', failure: failure('SWAP_QUOTE_UNAVAILABLE') };
    const quote = (await res.json()) as QuoteWire;
    return { status: 'ready', quote, receivedAt: Date.now() };
  } catch {
    return { status: 'error', failure: failure('SWAP_QUOTE_UNAVAILABLE') };
  }
}

/** What the quote says will arrive and the minimum the calldata enforces, for the
 *  route on offer (or the wrapper, one to one). */
function offeredFigures(quote: QuoteWire): { output: bigint; minOut: bigint; route?: SwapRoute } | undefined {
  if (quote.direct) return { output: BigInt(quote.direct.expectedOut), minOut: BigInt(quote.direct.minOut) };
  if (quote.offered === null) return undefined;
  const wire = quote.routes[quote.offered];
  if (!wire) return undefined;
  const route = routeFromWire(wire);
  const output = quote.feeOnTransfer ? BigInt(quote.feeOnTransfer.delivered) : route.expectedOut;
  return { output, minOut: route.minOut, route };
}

function toSwapQuote(state: Extract<QuoteState, { status: 'ready' }>): SwapQuote {
  const { quote } = state;
  return {
    kind: quote.kind,
    routes: quote.routes.map(routeFromWire),
    offered: quote.offered,
    ...(quote.deliverNative !== undefined ? { deliverNative: quote.deliverNative } : {}),
    receivedAt: state.receivedAt,
  };
}

/** ≈ $12.34 from a per-whole six-decimal USD price; undefined without a price. */
function usdApprox(
  amount: bigint,
  decimals: number,
  price: { value: bigint; decimals: number } | null | undefined,
): string | undefined {
  if (!price || price.value <= 0n || amount <= 0n) return undefined;
  const usd = (amount * price.value) / 10n ** BigInt(decimals);
  return `≈ $${formatMoney(usd, price.decimals, 2)}`;
}

function pickedFromEntry(t: WalletTokenEntry): PickedToken {
  return {
    address: t.address,
    symbol: t.symbol,
    name: t.name,
    decimals: t.decimals,
    iconUrl: t.iconUrl,
    listed: t.listed,
  };
}

function SwapCard({ account }: { readonly account: NonNullable<ReturnType<typeof useSession>['account']> }) {
  const balances = useAccountBalances(account.address);
  const prefs = useWalletPreferences(account.address);
  const reducedMotion = usePrefersReducedMotion();
  const rowFlash = useRowFlash();

  const payBoxRef = useRef<HTMLDivElement | null>(null);
  const receiveBoxRef = useRef<HTMLDivElement | null>(null);
  const screenRef = useRef<HTMLDivElement | null>(null);

  const tokens = balances.tokens ?? [];
  const entryOf = (address: string | undefined) =>
    tokens.find((t) => t.address.toLowerCase() === (address ?? '').toLowerCase());

  const [payToken, setPayToken] = useState<PickedToken | undefined>(undefined);
  const [receiveToken, setReceiveToken] = useState<PickedToken | undefined>(undefined);
  const [selector, setSelector] = useState<'pay' | 'receive' | undefined>(undefined);
  const [amountInput, setAmountInput] = useState('');
  const [exactAmount, setExactAmount] = useState<bigint | undefined>(undefined);

  const [quoteState, setQuoteState] = useState<QuoteState>({ status: 'idle' });
  const [ttl, setTtl] = useState(0);
  const [slippageBps, setSlippageBps] = useState<number>(DEFAULT_SLIPPAGE_BPS);
  // Rule 1.6: the route the pre-sign simulation settled on, when not the offered one.
  const [fallbackRoute, setFallbackRoute] = useState<SwapRoute | undefined>(undefined);

  const [phase, setPhase] = useState<SwapPhase>('idle');
  const [progress, setProgress] = useState<Progress | undefined>();
  const [simError, setSimError] = useState<string | undefined>();
  const [received, setReceived] = useState<{ amount: bigint; symbol: string; decimals: number } | undefined>();
  const [feePlan, setFeePlan] = useState<FeeLegPlan | undefined>(undefined);
  // Measured on THIS swap's own clock (spec 4.1): tap → mined → confirmed.
  const [took, setTook] = useState<{ mined?: number; confirmed?: number } | undefined>();
  const gas = useGasAllowance(account.address);

  // Speed (spec 4.2): warm the nonce, fees and delegation read at mount, exactly as
  // the trade screen does, so the tap spends none of them.
  useEffect(() => {
    void prefetchDelegation(account.address);
    const stop = startOrderPrecompute(account.account);
    return stop;
  }, [account.address, account.account]);

  // Swap-into-MON mode (B3): `?into=mon` — the banner's link.
  const [intoMon] = useState(
    () =>
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('into') === 'mon',
  );
  const prefilledIntoMon = useRef(false);

  // Defaults once balances land: pay with the largest funded non-native token,
  // receive native MON (the design's own default pair).
  useEffect(() => {
    if (tokens.length === 0) return;
    if (!payToken) {
      const funded = tokens.find(
        (t) =>
          t.address.toLowerCase() !== NATIVE_MON.toLowerCase() &&
          (t.wallet.value > 0n || t.margin.value > 0n),
      );
      const usdc = tokens.find((t) => t.symbol === 'USDC');
      const first = funded ?? usdc ?? tokens[0];
      if (first) setPayToken(pickedFromEntry(first));
    }
    if (!receiveToken) {
      const native = tokens.find((t) => t.address.toLowerCase() === NATIVE_MON.toLowerCase());
      if (native) setReceiveToken(pickedFromEntry(native));
    }
  }, [tokens, payToken, receiveToken]);

  const payEntry = entryOf(payToken?.address);
  const receiveEntry = entryOf(receiveToken?.address);
  const receiveIsNative = (receiveToken?.address ?? '').toLowerCase() === NATIVE_MON.toLowerCase();

  const payDecimals = payToken?.decimals ?? 6;
  const typedAmount = exactAmount ?? parseAmount(amountInput, payDecimals) ?? 0n;

  // Source of funds (spec 2.1's own line): trading balance first when it holds the
  // whole amount, otherwise the wallet — never split across both in one batch.
  const payMargin = payEntry?.margin.value ?? 0n;
  const payWallet = payEntry?.wallet.value ?? 0n;
  const source: SwapSource | undefined = !payToken
    ? undefined
    : payMargin >= typedAmount && typedAmount > 0n
      ? 'trading'
      : payWallet >= typedAmount && typedAmount > 0n
        ? 'wallet'
        : payMargin >= payWallet
          ? 'trading'
          : 'wallet';
  const canAffordFromEitherSide = typedAmount > 0n && (payMargin >= typedAmount || payWallet >= typedAmount);

  // USD approximations under the amounts: the balances body's own price where it has
  // one, otherwise the lazy per-address Flow price — never a fabricated figure.
  const payLazy = useLazyTokenPrice({
    account: account.address,
    address: (payToken?.address ?? NATIVE_MON) as Address,
    enabled: !!payToken && !payEntry?.usd.price,
  });
  const receiveLazy = useLazyTokenPrice({
    account: account.address,
    address: (receiveToken?.address ?? NATIVE_MON) as Address,
    enabled: !!receiveToken && !receiveEntry?.usd.price,
  });
  const payPrice = payEntry?.usd.price ?? payLazy.price;
  const receivePrice = receiveEntry?.usd.price ?? receiveLazy.price;

  // The wallet's current native MON, for B3's delivery decision and prefill.
  const monRow = entryOf(NATIVE_MON);
  const nativeWalletWei = monRow?.wallet.value ?? 0n;

  // B3: the server decides native delivery from the account's real balance and the
  // route's own minimum; the screen only says what it decided.
  const ready = quoteState.status === 'ready' ? quoteState : undefined;
  const figures = ready ? offeredFigures(ready.quote) : undefined;
  const deliverNative = receiveIsNative && ready?.quote.kind === 'aggregated' && ready.quote.deliverNative === true;
  const offeredRoute = fallbackRoute ?? figures?.route;

  // The B3 prefill, once per visit: reach 12 MON, from the two rows' real prices.
  useEffect(() => {
    if (!intoMon || prefilledIntoMon.current || !payToken || !monRow) return;
    const payU = payEntry?.usd.price ?? payLazy.price;
    const amount = prefillPayAmountForMon({
      currentNativeWei: nativeWalletWei,
      monUsd: monRow.usd.price,
      payUsd: payU ?? null,
      payDecimals: payToken.decimals,
    });
    prefilledIntoMon.current = true;
    if (amount !== undefined && amount > 0n) {
      const filled = fillExact(amount, payToken.decimals, payToken.symbol);
      setExactAmount(filled.exact);
      setAmountInput(filled.text);
    }
  }, [intoMon, payToken, payEntry, payLazy.price, monRow, nativeWalletWei]);

  /* ------------------------------- quoting ------------------------------- */

  const quoteRequestId = useRef(0);

  useEffect(() => {
    if (phase !== 'idle') return; // the countdown and quote freeze once signing starts
    if (!payToken || !receiveToken || typedAmount <= 0n) {
      setQuoteState({ status: 'idle' });
      return;
    }
    if (payToken.address.toLowerCase() === receiveToken.address.toLowerCase()) {
      setQuoteState({ status: 'idle' });
      return;
    }
    const requestId = ++quoteRequestId.current;
    setQuoteState({ status: 'loading' });
    setFallbackRoute(undefined);
    const timer = window.setTimeout(() => {
      void fetchQuote({
        tokenIn: payToken.address,
        tokenOut: receiveToken.address,
        amount: typedAmount,
        address: account.address,
        slippageBps,
        source: source ?? 'wallet',
      }).then((next) => {
        if (quoteRequestId.current !== requestId) return;
        setQuoteState(next);
        if (next.status === 'ready') setTtl(next.quote.holdSeconds);
      });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [payToken?.address, receiveToken?.address, typedAmount.toString(), account.address, phase, slippageBps, source]);

  // The countdown: ticks to zero while a live quote waits; frozen while signing and
  // once settled (2.3: never "0 s" under a completed swap).
  useEffect(() => {
    if (quoteState.status !== 'ready' || phase !== 'idle') return;
    const id = window.setInterval(() => setTtl((t) => (t > 0 ? t - 1 : 0)), 1000);
    return () => window.clearInterval(id);
  }, [quoteState.status, phase]);

  function requote() {
    if (!payToken || !receiveToken || typedAmount <= 0n) return;
    const requestId = ++quoteRequestId.current;
    setQuoteState({ status: 'loading' });
    setFallbackRoute(undefined);
    setSimError(undefined);
    void fetchQuote({
      tokenIn: payToken.address,
      tokenOut: receiveToken.address,
      amount: typedAmount,
      address: account.address,
      slippageBps,
      source: source ?? 'wallet',
    }).then((next) => {
      if (quoteRequestId.current !== requestId) return;
      setQuoteState(next);
      if (next.status === 'ready') setTtl(next.quote.holdSeconds);
    });
  }

  /* ------------------------------- flip ------------------------------- */

  function flip() {
    tick(prefs.soundsEnabled);
    if (!payToken || !receiveToken) return;
    const nextPay = receiveToken;
    const nextReceive = payToken;
    setPayToken(nextPay);
    setReceiveToken(nextReceive);
    setAmountInput('');
    setExactAmount(undefined);
    setQuoteState({ status: 'idle' });
  }

  /* ------------------------------- swap ------------------------------- */

  const finished = phase === 'settled' && progress?.state === 'CONFIRMED';

  const disabledReason = (() => {
    if (!payToken || !receiveToken) return 'Loading tokens';
    if (payToken.address.toLowerCase() === receiveToken.address.toLowerCase()) {
      return 'Choose two different tokens';
    }
    if (typedAmount <= 0n) return 'Enter an amount to swap';
    if (!canAffordFromEitherSide) return `Add money to swap ${payToken.symbol}`;
    if (
      offeredRoute?.vendor === 'kuru-flow' &&
      payWithPermit(payToken.address) &&
      typedAmount > MAX_SPONSORED_PERMIT_VALUE
    ) {
      return `Amounts above ${formatMoney(MAX_SPONSORED_PERMIT_VALUE, payDecimals, 2)} ${payToken.symbol} are not sponsored`;
    }
    if (quoteState.status === 'loading' || quoteState.status === 'idle') return 'Getting a price';
    if (quoteState.status === 'error') return 'No price available';
    // Item 1: the reserve is explained by the line under the input, never by
    // replacing the button's own label — a quote the server refused for the
    // reserve carries no route, so this falls through to the line below.
    if (!figures) return 'No route right now';
    if (phase === 'signing') return 'Working';
    return undefined;
  })();

  const disabled = disabledReason !== undefined && !finished;
  // Rule 1.5: a quote 20 s old or more is never signed; the button re-quotes first.
  const needsNewPrice = !finished && quoteState.status === 'ready' && ttl <= 0;

  async function onSwapButton() {
    if (finished) {
      // "Swap again" (2.3): back to a live quote for whatever is on screen.
      setPhase('idle');
      setProgress(undefined);
      setReceived(undefined);
      setTook(undefined);
      setAmountInput('');
      setExactAmount(undefined);
      setQuoteState({ status: 'idle' });
      return;
    }
    if (needsNewPrice) {
      requote();
      return;
    }
    if (disabled || !ready || !figures || !payToken || !receiveToken || !source) return;

    // The quote must still be for exactly what the screen shows.
    if (ready.quote.amountIn !== typedAmount.toString()) {
      setSimError('This price is for a different amount than the one on screen. Get a new price.');
      return;
    }

    const perfId = beginPerfAction();
    const tapAt = performance.now();
    setSimError(undefined);
    setFallbackRoute(undefined);
    setPhase('signing');
    setProgress({ state: 'VALIDATING', checking: { done: 0, of: 5 } });
    setFeePlan(undefined);
    setTook(undefined);

    hapticFaceId(prefs.soundsEnabled);
    let flew = false;
    let chosen: SwapRoute | undefined = figures.route;
    const times: { mined?: number; confirmed?: number } = {};
    const result = await runSwap({
      account,
      marginAccount: MARGIN_ACCOUNT,
      payToken: payToken.address,
      receiveToken: receiveToken.address,
      amountIn: typedAmount,
      source,
      quote: toSwapQuote(ready),
      rpId: RP_ID,
      quoteMaxAgeMs: ready.quote.holdSeconds * 1000,
      perfActionId: perfId,
      onFeePlan: setFeePlan,
      onRouteChosen: (route) => {
        chosen = route;
        setFallbackRoute(route);
      },
      // Step 2: the permit's domain and nonce, read closest to the signature.
      readPermit: async () => {
        const fresh = await preflight(account.address);
        const token = tokenBySymbol(fresh, payToken.symbol);
        return token?.domain && token.nonce !== undefined ? { domain: token.domain, nonce: token.nonce } : undefined;
      },
      onProgress: (p) => {
        setProgress(p);
        if (p.state === 'RELAYING' && !flew) {
          flew = true;
          swoosh(prefs.soundsEnabled, 0.7);
          // The flying token at the Sending step, the prototype's own moment (1.9).
          if (!reducedMotion && payBoxRef.current && receiveBoxRef.current && screenRef.current) {
            flyToken(
              payBoxRef.current,
              receiveBoxRef.current,
              `${amountInput} ${payToken.symbol} to ${receiveToken.symbol}`,
              screenRef.current,
              reducedMotion,
            );
          }
        }
        if (p.state === 'MINED' && times.mined === undefined) {
          times.mined = (performance.now() - tapAt) / 1000;
        }
      },
    });
    if (result.state === 'CONFIRMED') times.confirmed = (performance.now() - tapAt) / 1000;
    setTook(times);
    setPhase('settled');

    if (result.state === 'CONFIRMED') {
      const kind = ready.quote.kind;
      // What arrives: native MON for an unwrap or a native delivery, WMON for a wrap or
      // a WMON fallback, otherwise the token asked for, read from the receipt's own logs.
      const nativeOut = kind === 'unwrap' || (receiveIsNative && deliverNative);
      const deliveredToken = receiveIsNative ? WMON : receiveToken.address;
      const deliveredSymbol = nativeOut ? 'MON' : receiveIsNative ? 'WMON' : receiveToken.symbol;
      const deliveredAmount = nativeOut
        ? kind === 'unwrap'
          ? typedAmount
          : (chosen?.minOut ?? figures.minOut)
        : (deliveredAmountFromLogs(result.result?.logs, deliveredToken, account.address) ?? figures.output);
      setReceived({ amount: deliveredAmount, symbol: deliveredSymbol, decimals: receiveToken.decimals });

      ding(prefs.soundsEnabled);
      hapticConfirmed(prefs.soundsEnabled);
      rowFlash.flash();
      if (!reducedMotion && receiveBoxRef.current && screenRef.current) {
        confettiBurst(receiveBoxRef.current, screenRef.current, reducedMotion);
      }
      const via = kind === 'aggregated' ? (chosen?.displayName ?? 'an aggregator') : 'the WMON contract';
      try {
        recordActivity(account.address, {
          id: result.result?.txHash ?? `swap:${Date.now()}`,
          kind: 'swap',
          summary: `Swapped ${paidText()} ${payToken.symbol} for ${formatMoney(
            deliveredAmount,
            receiveToken.decimals,
            displayDp(deliveredSymbol, receiveToken.decimals),
          )} ${deliveredSymbol}`,
          amount: deliveredAmount.toString(),
          decimals: receiveToken.decimals,
          symbol: deliveredSymbol,
          token: nativeOut ? NATIVE_MON : deliveredToken,
          ...(result.result?.txHash ? { txHash: result.result.txHash } : {}),
          route: `${via}, ${payToken.symbol} to ${deliveredSymbol}`,
          resultingLocation: 'wallet',
          at: Date.now(),
        });
      } catch {
        // The swap is real regardless; local bookkeeping failing is not a reason to say otherwise.
      }
      balances.refresh();
    }
  }

  /** The pay side at display precision: "Swapped 1.00 USDC for …". */
  function paidText(): string {
    if (!payToken) return amountInput;
    const parsed = parseAmount(amountInput, payToken.decimals) ?? exactAmount;
    return parsed === undefined
      ? amountInput
      : formatMoney(parsed, payToken.decimals, displayDp(payToken.symbol, payToken.decimals));
  }

  /* ------------------------------- render ------------------------------- */

  if (balances.status === 'loading') {
    return (
      <Card title="Swap">
        <Skeleton rows={4} />
      </Card>
    );
  }
  if (balances.status === 'error') {
    return <FailureNotice failure={failure('BALANCE_UNREADABLE')} onRetry={balances.refresh} />;
  }
  if (tokens.length === 0) {
    return (
      <Card title="Swap">
        <Notice tone="warn">Nothing to swap yet. Add money to your account first.</Notice>
      </Card>
    );
  }

  const txHash = progress?.result?.txHash;

  const chargeActive = isGasChargeActive(gas.allowance);
  const feeText =
    feePlan?.kind === 'fee' || feePlan?.kind === 'own-mon'
      ? (feeLineText({ allowance: gas.allowance, quote: feePlan.quote }) ??
        'Charged at cost from your trading balance')
      : feePlan?.kind === 'sponsored'
        ? 'Paid for you'
        : !chargeActive
          ? 'Paid for you'
          : 'Charged at cost from your trading balance';
  const feeUp = feeText === 'Paid for you';

  /**
   * Item 1 (10 MON reserve, confirmed against Monad's reserve-balance docs —
   * DECISIONS.md D199): a delegated wallet's native MON may never end a
   * transaction lower than it started if that would put it below 10 MON. Every
   * wallet actually funded here already holds more than 10, so in practice this
   * is "never spend the last 10 MON" — plus this swap's own gas when it will be
   * paid from the same wallet MON (the 'own-mon' lane) rather than a free action
   * or the trading balance. Only native MON paid FROM THE WALLET is affected;
   * trading-balance MON and every other token are not (D199 test matrix).
   */
  const payIsNative = payToken ? isNative(payToken.address) : false;
  const ownMonGasWei = feePlan?.kind === 'own-mon' ? feePlan.quote.ownMon.gasWei : 0n;
  const walletSpendableNative = payIsNative
    ? maxNativeSpend(payWallet, MONAD_DELEGATED_RESERVE_WEI + ownMonGasWei)
    : payWallet;
  // The pool a 100% fill actually draws from (line ~314's own rule: whichever of
  // margin/wallet is bigger) — capped at what the wallet side may truly spend.
  const maxFillableSource = payMargin > walletSpendableNative ? payMargin : walletSpendableNative;
  // Shown under the input only when the wallet is the constrained pool: margin
  // alone cannot cover the typed amount either, so a bigger wallet figure would
  // not help without crossing the reserve.
  const overSpendableNative =
    payIsNative && typedAmount > 0n && typedAmount > walletSpendableNative && typedAmount > payMargin;

  // The delivery line, the prototype's own variants in order.
  const deliverLine = !receiveToken
    ? undefined
    : ready?.quote.kind === 'unwrap'
      ? 'Unwrapped by the WMON contract, one to one, into native MON in your wallet.'
      : ready?.quote.kind === 'wrap'
        ? 'Wrapped by the WMON contract, one to one, into WMON in your wallet.'
    : receiveIsNative
      ? !ready
        ? 'Delivered to your wallet as native MON when the swap ends above the 10 MON reserve.'
        : deliverNative
          ? 'Delivered as native MON. Your wallet will end above the 10 MON reserve, so you can pay your own gas with it.'
          : 'This amount is too small to end above the 10 MON a delegated wallet must keep, so you will receive WMON instead. Swap a larger amount to receive native MON.'
      : !receiveToken.listed
        ? 'Unverified token. No list names it; the symbol and decimals were read from its contract. It swaps like any other.'
        : receivePrice === null
          ? 'Kuru has no price for this token right now. It can still be received; the amount will be whatever the route delivers.'
          : 'Arrives in your wallet.';

  const sourceLine = !payToken
    ? ''
    : source === 'trading'
      ? `From your trading balance: ${formatMoney(payMargin, payDecimals, displayDp(payToken.symbol, payDecimals))} ${payToken.symbol}`
      : `From your wallet: ${formatMoney(payWallet, payDecimals, displayDp(payToken.symbol, payDecimals))} ${payToken.symbol}`;

  const tokenButton = (t: PickedToken | undefined, balance: bigint, balanceLabel: string, onClick: () => void) => (
    <button type="button" className="tokbtn" onClick={onClick} aria-haspopup="dialog">
      {t ? <TokenIcon address={t.address} symbol={t.symbol} size={30} /> : <span className="coin" style={{ width: 30, height: 30 }}>?</span>}
      <span style={{ minWidth: 0, textAlign: 'left' }}>
        <span className="sym" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {t?.symbol ?? '—'}
          {t && !t.listed ? <Chip tone="warn">unverified</Chip> : null}
        </span>
        <span className="nm" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {t?.name ?? ''}
        </span>
      </span>
      <span className="bal num">
        <b>{t ? formatMoney(balance, t.decimals, displayDp(t.symbol, t.decimals)) : ''}</b>
        {balanceLabel}
      </span>
      <span className="chev">▾</span>
    </button>
  );

  return (
    <Card>
      <div ref={screenRef} style={{ position: 'relative' }}>
        {/* FROM: token first, amount beneath (spec 2.1). */}
        <div className="side" ref={payBoxRef}>
          <div className="lab">
            <span>From</span>
            <span>{source === 'trading' ? 'Trading balance is used first' : 'Your wallet is used'}</span>
          </div>
          {tokenButton(
            payToken,
            source === 'trading' ? payMargin : payWallet,
            source === 'trading' ? 'trading balance' : 'wallet',
            () => setSelector('pay'),
          )}
          <div className="amt">
            <input
              id="swap-pay-amount"
              value={amountInput}
              inputMode="decimal"
              placeholder="0"
              disabled={phase === 'signing'}
              aria-label={`Amount in ${payToken?.symbol ?? ''}`}
              onChange={(v) => {
                const edited = onEdit(v.target.value);
                setAmountInput(edited.text);
                setExactAmount(edited.exact);
              }}
            />
            <span className="usd num">
              {usdApprox(typedAmount, payDecimals, payPrice) ?? (payPrice === null ? 'No price' : '')}
            </span>
          </div>
          <div className="pcts" style={{ marginTop: 8 }}>
            {[25, 50, 75, 100].map((pct) => (
              <button
                key={pct}
                type="button"
                disabled={maxFillableSource === 0n || phase === 'signing'}
                onClick={() => {
                  // Item 2: the exact bigint share is what is sent; the field shows it
                  // rounded down, with no separators.
                  const filled = fillExact(maxFillableSource, payDecimals, payToken?.symbol ?? '', pct * 100);
                  setExactAmount(filled.exact);
                  setAmountInput(filled.text);
                  tick(prefs.soundsEnabled);
                }}
              >
                {pct === 100 ? 'Max' : `${pct}%`}
              </button>
            ))}
          </div>
          {payToken ? (
            <p className="tiny muted" style={{ margin: '8px 0 0' }}>
              {sourceLine}
            </p>
          ) : null}
          {overSpendableNative ? (
            <p className="tiny muted" style={{ margin: '4px 0 0' }}>
              Up to {formatMoney(walletSpendableNative, payDecimals, displayDp('MON', payDecimals))} MON. Monad
              keeps 10 MON in smart accounts.{' '}
              <button
                type="button"
                className="link small"
                onClick={() => {
                  const filled = fillExact(maxFillableSource, payDecimals, payToken?.symbol ?? '', 10_000);
                  setExactAmount(filled.exact);
                  setAmountInput(filled.text);
                }}
              >
                Fill
              </button>
            </p>
          ) : null}
        </div>

        <div style={{ display: 'grid', placeItems: 'center', margin: '-8px 0', position: 'relative', zIndex: 2 }}>
          <button
            type="button"
            aria-label="Flip pay and receive tokens"
            onClick={flip}
            disabled={phase === 'signing'}
            style={{
              width: 40,
              height: 40,
              borderRadius: '50%',
              background: 'var(--surface)',
              border: '1px solid var(--line)',
              color: 'var(--ink-2)',
              display: 'grid',
              placeItems: 'center',
              cursor: 'pointer',
              boxShadow: '0 2px 6px rgba(0,0,0,.06)',
            }}
          >
            ⇅
          </button>
        </div>

        {/* TO: token first, the read-only receive amount beneath, then delivery. */}
        <div className="side" ref={receiveBoxRef}>
          <div className="lab">
            <span>To</span>
            <span>Arrives in your wallet</span>
          </div>
          <div className={rowFlash.className}>
            {tokenButton(receiveToken, receiveEntry?.wallet.value ?? 0n, 'wallet', () => setSelector('receive'))}
          </div>
          <div className="amt">
            <input
              id="swap-receive-amount"
              readOnly
              value={
                figures
                  ? formatMoney(
                      figures.output,
                      receiveToken?.decimals ?? 18,
                      displayDp(receiveToken?.symbol ?? '', receiveToken?.decimals ?? 18),
                    )
                  : ''
              }
              placeholder="0"
              aria-label="Amount received"
            />
            <span className="usd num">
              {figures
                ? (usdApprox(figures.output, receiveToken?.decimals ?? 18, receivePrice) ??
                  (receivePrice === null ? 'No price' : ''))
                : ''}
            </span>
          </div>
          {deliverLine ? <div className="deliver">{deliverLine}</div> : null}
        </div>

        {quoteState.status === 'error' ? (
          <div style={{ marginTop: 10 }}>
            <FailureNotice failure={quoteState.failure} onRetry={requote} />
          </div>
        ) : ready ? (
          <div className="stack small" style={{ marginTop: 10 }}>
            {/* Item 1: the reserve is explained once, by the line under the input
                (with its tap-to-fill), not duplicated here as a second notice. A
                reserve-refused quote carries no offer, so this falls through to
                the generic no-route notice below, same as any other no-route quote. */}
            {ready.quote.message ? (
              <Notice tone="warn">{ready.quote.message}</Notice>
            ) : !figures ? (
              <Notice tone="err">{ready.quote.revert ?? 'None of the routes would go through right now.'}</Notice>
            ) : (
              <>
                <div className="between">
                  <span className="muted">Price</span>
                  <span className="num">
                    {`1 ${payToken?.symbol} = ${formatMoney(
                      (figures.output * 10n ** BigInt(payDecimals)) / (typedAmount > 0n ? typedAmount : 1n),
                      receiveToken?.decimals ?? 18,
                      6,
                    )} ${receiveToken?.symbol}`}
                  </span>
                </div>
                <div className="between">
                  <span className="muted">Minimum received</span>
                  <span className="num">
                    {formatMoney(
                      offeredRoute?.minOut ?? figures.minOut,
                      receiveToken?.decimals ?? 18,
                      displayDp(receiveToken?.symbol ?? '', receiveToken?.decimals ?? 18),
                    )}{' '}
                    {deliverNative || !receiveIsNative ? receiveToken?.symbol : 'WMON'} in your wallet
                  </span>
                </div>
                {ready.quote.feeOnTransfer ? (
                  <Notice tone="warn">
                    This token takes a fee on transfer; you receive about{' '}
                    {formatMoney(
                      BigInt(ready.quote.feeOnTransfer.delivered),
                      receiveToken?.decimals ?? 18,
                      displayDp(receiveToken?.symbol ?? '', receiveToken?.decimals ?? 18),
                    )}{' '}
                    {receiveToken?.symbol}.
                  </Notice>
                ) : null}
                {ready.quote.kind === 'aggregated' ? (
                  <div className="between" style={{ alignItems: 'center' }}>
                    <span className="muted">Slippage</span>
                    <span style={{ minWidth: 200 }}>
                      <Segmented
                        label="Slippage"
                        value={String(slippageBps)}
                        onChange={(v) => setSlippageBps(Number(v))}
                        options={SLIPPAGE_CHOICES_BPS.map((bps) => ({ value: String(bps), label: slippageLabel(bps) }))}
                      />
                    </span>
                  </div>
                ) : null}
                <div className="between">
                  <span className="muted">Network fee</span>
                  <span className="num" style={feeUp ? { color: 'var(--up)' } : undefined}>
                    {feeText}
                  </span>
                </div>
                <div className="between">
                  <span className="muted">Route</span>
                  <span className="num">
                    {ready.quote.kind === 'aggregated'
                      ? `via ${offeredRoute?.displayName ?? ''}`
                      : 'The WMON contract, one to one'}
                  </span>
                </div>
                {fallbackRoute ? (
                  <p className="tiny muted" style={{ margin: 0 }}>
                    The best price would not go through right now, so this swap uses {fallbackRoute.displayName}.
                  </p>
                ) : null}
                {ready.quote.kind === 'aggregated' && ready.quote.routes.length > 0 ? (
                  <div className="stack" style={{ gap: 2 }}>
                    <span className="muted">Other routes</span>
                    {ready.quote.routes.map((r) => (
                      <div key={r.vendor} className="between tiny">
                        <span>{r.displayName}</span>
                        <span className="num">
                          {r.simulation.status === 'reverted'
                            ? 'Would not go through'
                            : `at least ${formatMoney(
                                BigInt(r.minOut),
                                receiveToken?.decimals ?? 18,
                                displayDp(receiveToken?.symbol ?? '', receiveToken?.decimals ?? 18),
                              )} ${receiveIsNative ? 'WMON' : receiveToken?.symbol}`}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
                <div className="between">
                  <span className="muted">Price holds</span>
                  <span className="num">
                    {finished ? 'done' : `${ttl} s`}
                    <span className="ttl" aria-hidden="true">
                      <i style={{ width: finished ? '0%' : `${(ttl / Math.max(ready.quote.holdSeconds, 1)) * 100}%` }} />
                    </span>
                  </span>
                </div>
              </>
            )}
          </div>
        ) : null}

        {simError ? (
          <div style={{ marginTop: 10 }}>
            <Notice tone="err">{simError}</Notice>
          </div>
        ) : null}

        <div style={{ marginTop: 12 }}>
          <Button
            variant="primary"
            block
            disabled={disabled && !needsNewPrice && !finished}
            {...(disabledReason && !needsNewPrice && !finished ? { disabledLabel: disabledReason } : {})}
            onClick={() => void onSwapButton()}
          >
            {finished ? 'Swap again' : needsNewPrice ? 'Get a new price' : 'Swap with Face ID'}
          </Button>
        </div>

        <p className="tiny muted" style={{ marginTop: 8 }}>
          {payToken && !payWithPermit(payToken.address)
            ? 'Every swap asks for Face ID. The approval is for exactly this amount and is revoked in the same transaction.'
            : 'Every swap asks for Face ID. The approval is for exactly this amount and expires in five minutes.'}
        </p>

        {progress ? (
          <div style={{ marginTop: 14 }}>
            <TicketState
              index={segmentOf(progress)}
              settled={isTerminal(progress.state)}
              {...(progress.checking ? { partial: progress.checking } : {})}
              {...(progress.stageNote ? { note: progress.stageNote } : {})}
              {...(progress.state === 'REJECTED' || progress.state === 'REVERTED'
                ? { error: [progress.message, progress.detail].filter(Boolean).join(' ') }
                : {})}
            />
            {progress.state === 'REJECTED' ? (
              <GasRefusalActions
                {...(progress.result?.refusalData ? { refusalData: progress.result.refusalData } : {})}
                {...(feePlan?.kind === 'refused' && feePlan.quote ? { quote: feePlan.quote } : {})}
              />
            ) : null}
            {finished && payToken && receiveToken && received ? (
              <div className="done" style={{ marginTop: 10, background: 'var(--up-soft)', borderRadius: 14, padding: 14 }}>
                <div style={{ fontWeight: 600 }}>
                  Swapped {paidText()} {payToken.symbol} for{' '}
                  {formatMoney(received.amount, received.decimals, displayDp(received.symbol, received.decimals))}{' '}
                  {received.symbol}
                </div>
                <div className="between small" style={{ marginTop: 4 }}>
                  <span className="muted">Now in your wallet</span>
                  <span className="num">
                    {formatMoney(received.amount, received.decimals, displayDp(received.symbol, received.decimals))}{' '}
                    {received.symbol}
                  </span>
                </div>
                {took?.mined !== undefined || took?.confirmed !== undefined ? (
                  <div className="between small" style={{ marginTop: 2 }}>
                    <span className="muted">Took</span>
                    <span className="num">
                      {took.mined !== undefined ? `${took.mined.toFixed(1)} s to mined` : ''}
                      {took.mined !== undefined && took.confirmed !== undefined ? ', ' : ''}
                      {took.confirmed !== undefined ? `${took.confirmed.toFixed(1)} s to confirmed` : ''}
                    </span>
                  </div>
                ) : null}
                {txHash ? (
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <a
                      href={explorerTxUrl(txHash)}
                      target="_blank"
                      rel="noreferrer"
                      className="btn ghost sm"
                      style={{ flex: 1, textAlign: 'center' }}
                    >
                      View on the explorer
                    </a>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        void navigator.clipboard?.writeText(txHash);
                        tick(prefs.soundsEnabled);
                      }}
                    >
                      Copy hash
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}
            {progress.state === 'RELAYING' && progress.message && !finished ? (
              <div style={{ marginTop: 10 }}>
                <Notice tone="warn">{progress.message}</Notice>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <TokenSelectorSheet
        open={selector !== undefined}
        onClose={() => setSelector(undefined)}
        title={selector === 'pay' ? 'Choose a token to pay with' : 'Choose a token to receive'}
        account={account.address}
        tokens={tokens}
        location={selector === 'pay' && source === 'trading' ? 'trading' : 'wallet'}
        excludeNative={selector === 'pay'}
        onTokenAdded={() => balances.refresh()}
        onPick={(t) => {
          if (selector === 'pay') {
            if (t.address.toLowerCase() === receiveToken?.address.toLowerCase()) setReceiveToken(payToken);
            setPayToken(t);
            setAmountInput('');
            setExactAmount(undefined);
          } else {
            if (t.address.toLowerCase() === payToken?.address.toLowerCase()) setPayToken(receiveToken);
            setReceiveToken(t);
          }
          setSelector(undefined);
          setQuoteState({ status: 'idle' });
          tick(prefs.soundsEnabled);
        }}
      />
    </Card>
  );
}
