'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  ActionResult,
  Button,
  Card,
  Chip,
  Field,
  Notice,
  Segmented,
  Select,
  TicketState,
} from '@tradepro/ui';
import {
  CAP_UNIT_DECIMALS,
  MAX_ORDER_NOTIONAL_AUSD,
  minSizeBase,
  quoteAmountInCapUnits,
  quoteValuationFor,
  type Book,
  type MarketParams,
  type Side,
} from '@tradepro/core';
import {
  baseSizeFor,
  displayDp,
  explorerTxUrl,
  formatMoney,
  formatPrice,
  formatSize,
  parseAmount,
  parsePriceWire,
  quoteNotionalFor,
} from '../lib/format';
import {
  isTerminal,
  segmentFor,
  segmentOf,
  validate,
  type PlacedOrder,
  type SimulatedOrder,
  type TicketState as State,
} from '../lib/ticket';
import { apiUrl } from '../lib/basePath';
import { priceDecimals } from './BookCard';
import type { Address, LocalAccount } from 'viem';
import { SponsoredNote } from './SponsoredNote';
import { GasRefusalActions } from './GasRefusalActions';
import type { GasChargeRefusalData } from '@tradepro/core';
import { useStageNote } from '../lib/useStageNote';
import { WIRE_PRICE_SCALE } from '@tradepro/core';
import { beginPerfAction, recordPerfStage } from '../lib/perf/orderPerf';
import {
  feeLineText,
  isGasChargeActive,
  runWithGasCharge,
  useGasAllowance,
  type FeeLegPlan,
} from '../lib/wallet/gasCharge';

/**
 * The market's own order counter, so a dry run's cancel encodes a real number rather
 * than an invented one. A failed read is `null`, and the row it produces says the
 * cancel is unavailable instead of guessing.
 */
async function readOrderReference(
  market: Address,
): Promise<{ reference: string | null; block: string | null }> {
  try {
    const res = await fetch(apiUrl(`/api/orders/next?market=${market}`), { cache: 'no-store' });
    if (!res.ok) return { reference: null, block: null };
    const body = (await res.json()) as { orderIdCounter: string; blockNumber: string };
    return { reference: body.orderIdCounter, block: body.blockNumber };
  } catch {
    return { reference: null, block: null };
  }
}

/**
 * The order ticket (design 5.4, spec 6.2).
 *
 * The button is disabled with the reason in its own label — "Move money to your
 * trading balance first", "Trading paused" — rather than a greyed word and a
 * tooltip (design 3). Which
 * reason applies is decided by the invariants, not by this component.
 */

export interface TicketCardProps {
  market: Address;
  /** The Kuru MarginAccount — an order is a chargeable action once free actions run
   *  out, and this is what the fee leg withdraws from. */
  marginAccount: Address;
  params?: MarketParams;
  book?: Book;
  tradable: boolean;
  /** The market's own live state, read per market. See `useMarketData`'s `VenueReading`. */
  venueState?: 'tradable' | 'paused' | 'empty' | 'one-sided' | 'delisted';
  feedReason?: string;
  base: string;
  quote: string;
  /**
   * Which side the ticket opens on. Defaults to `'buy'`, same as before — the only
   * caller that passes this is the mobile trade bar, which remounts this component
   * (by `key`) with the tapped side so the ticket opens already on Buy or Sell. The
   * side toggle inside the ticket is unchanged either way; this only seeds its
   * initial value.
   */
  initialSide?: Side;
  sender?: Address;
  /**
   * The key that signs the order and, on a first-time account, the EIP-7702
   * authorization. Without it `submit()` has no transport and cannot send — see
   * `run()`'s `owner` doc in `lib/ticket.ts`.
   */
  owner?: LocalAccount;
  /** Quote-asset balance in the margin account: what a buy can spend. */
  available?: bigint;
  /** Base-asset balance in the margin account: what a sell can spend. */
  availableBase?: bigint;
  /**
   * The dollar price of one whole unit of the quote asset (the MON/USDC mid on a
   * MON-quoted market), from `useMarketData`. What the size limit is measured with.
   */
  quoteUsdPrice?: bigint;
  onPlaced: (placed: PlacedOrder) => void;
}

/** Item 3. Max is 100 so one list drives all four buttons. */
const PERCENTS = [25, 50, 75, 100] as const;

export function TicketCard({
  market,
  marginAccount,
  params,
  book,
  tradable,
  venueState,
  feedReason,
  base,
  quote,
  sender,
  owner,
  available,
  availableBase,
  quoteUsdPrice,
  initialSide,
  onPlaced,
}: TicketCardProps) {
  const gas = useGasAllowance(sender);
  // The real gas-charge quote for the order just placed, once known — see
  // `runWithGasCharge`'s `onFeePlan`. Reset on every input change below so a stale
  // figure from a previous amount never lingers on the fee line.
  const [feePlan, setFeePlan] = useState<FeeLegPlan | undefined>(undefined);
  const [side, setSide] = useState<Side>(initialSide ?? 'buy');
  const [type, setType] = useState<'limit' | 'market'>('limit');
  const [priceInput, setPriceInput] = useState('');
  const [amountInput, setAmountInput] = useState('');
  /**
   * B8: the exact amount "Max" or a percentage button just filled, kept separately
   * from what the field displays.
   *
   * The field itself is rounded to the token's display precision — MON and WETH show
   * at most 6 decimal places, cbBTC 8 — so a Max tap on a balance with 18 raw decimals
   * never dumps `3.732318142700000000` into the box. But rounding the *displayed*
   * string and then reparsing it would spend a rounded-down amount, leaving dust
   * behind on every Max tap. So the button stores the untouched bigint here, and
   * `typedAmount` below prefers it over reparsing the (rounded) text. Any manual edit
   * clears it — free typing was never the source of this bug and behaves exactly as
   * before, parsed at the field's own precision.
   */
  const [exactAmount, setExactAmount] = useState<bigint | undefined>(undefined);
  const [state, setState] = useState<State>('IDLE');
  // Which of the five segments is lit. Kept separately from the state name because a
  // rejection at VALIDATING must light "Checking", not the segment REJECTED usually
  // maps to (spec 6.2 allows a rejection from two different places).
  const [segment, setSegment] = useState(0);
  // One word for whatever the current stage is doing; only rendered once that stage
  // has been running for more than two seconds.
  const [stage, setStage] = useState<string | undefined>();
  const stageNote = useStageNote(stage);
  // A run that has finished, whatever the outcome. `RELAYING` is a resting place in
  // this build — `submit()` stops there — so "Working" must not stay on the button.
  const [settled, setSettled] = useState(false);
  const [message, setMessage] = useState<string | undefined>();
  // The last refusal's machine-readable data, for B2c's two live choices.
  const [refusalData, setRefusalData] = useState<GasChargeRefusalData | undefined>();
  // The upstream's own words — "Kuru answered: SizeError" — rendered verbatim under
  // the plain message, never in place of it (error-handling rule, 2026-09-08).
  const [detail, setDetail] = useState<string | undefined>();
  // The transaction this order landed in. A gasless user cannot find it from their own
  // address on the explorer — the bundler sent it, not them — so the row carries it.
  const [txHash, setTxHash] = useState<string | undefined>();
  const [tone, setTone] = useState<'err' | 'warn' | 'ok'>('err');

  const dp = params ? priceDecimals(params) : 6;

  // Seed the price field from the side of the book the user would rest on.
  useEffect(() => {
    if (priceInput !== '' || !book) return;
    const seed = side === 'buy' ? book.bestBid : book.bestAsk;
    if (seed > 0n) setPriceInput(formatPrice(seed, dp));
  }, [book, side, priceInput, dp]);

  const priceWire = useMemo(() => {
    if (type === 'market') {
      if (!book) return 0n;
      return side === 'buy' ? book.bestAsk : book.bestBid;
    }
    return parsePriceWire(priceInput) ?? 0n;
  }, [type, priceInput, book, side]);

  /**
   * The amount field's unit follows the side (item 2).
   *
   * **Buy takes the quote asset, sell takes the base asset**, because that is what
   * each side actually spends. The field was fixed to the quote asset on both sides,
   * so selling MON asked for an amount "in USDC" while Available underneath it counted
   * MON — two units in one row, describing one number. Whichever the user typed, one
   * of the two labels was lying.
   *
   * Only the direction of the conversion changes. `quoteAmount` and `sizeBase` are
   * still both computed and still both handed to `validate()`, so nothing downstream
   * has to know which one the user typed.
   */
  const spendsBase = side === 'sell';
  /** What this side spends, in the unit the amount field is asking for (items 2, 3). */
  const spendable = spendsBase ? availableBase : available;
  const amountDecimals = params ? (spendsBase ? params.baseDecimals : params.quoteDecimals) : 0;
  const amountUnit = spendsBase ? base : quote;

  const typedAmount = useMemo(
    () => exactAmount ?? (params ? (parseAmount(amountInput, amountDecimals) ?? 0n) : 0n),
    [exactAmount, amountInput, params, amountDecimals],
  );

  const quoteAmount = useMemo(() => {
    if (!params) return 0n;
    if (!spendsBase) return typedAmount;
    if (priceWire <= 0n) return 0n;
    return quoteNotionalFor(typedAmount, priceWire, params.quoteDecimals, params.baseDecimals);
  }, [params, spendsBase, typedAmount, priceWire]);

  const sizeBase = useMemo(() => {
    if (!params) return 0n;
    if (spendsBase) return typedAmount;
    if (priceWire <= 0n) return 0n;
    return baseSizeFor(typedAmount, priceWire, params.quoteDecimals, params.baseDecimals);
  }, [params, spendsBase, typedAmount, priceWire]);

  // Read before any input, straight from the market's own params and the live book
  // — never asserted, never left to a generic "increase the amount" (item 4b).
  // `minSize`/`maxSize` are `sizePrecision`-scaled, not base-asset decimals; reading
  // them directly here is exactly the bug `minSizeBase` exists to not repeat.
  const referencePrice = useMemo(() => {
    if (!book) return undefined;
    if (book.bestBid > 0n && book.bestAsk > 0n) return (book.bestBid + book.bestAsk) / 2n;
    if (book.bestBid > 0n) return book.bestBid;
    if (book.bestAsk > 0n) return book.bestAsk;
    return undefined; // no resting liquidity on either side — no price to convert with
  }, [book]);

  const minBase = params ? minSizeBase(params) : undefined;
  const minNotional =
    params && minBase !== undefined && referencePrice !== undefined
      ? quoteNotionalFor(minBase, referencePrice, params.quoteDecimals, params.baseDecimals)
      : undefined;

  /**
   * The same minimum in dollars, the unit the size limit is written in. On a
   * dollar-quoted market it is `minNotional` itself; on emo/MON it is the MON figure at
   * the live MON/USDC mid. Undefined when it cannot be valued, and then nothing below
   * claims a dollar figure or declares limit orders impossible.
   */
  const minDollars = useMemo(() => {
    if (!params || minNotional === undefined) return undefined;
    const valuation = quoteValuationFor(params);
    return valuation ? quoteAmountInCapUnits(minNotional, valuation, quoteUsdPrice) : undefined;
  }, [params, minNotional, quoteUsdPrice]);

  /**
   * cbBTC/USDC and XAUt0/USDC: no legal limit order exists.
   *
   * A resting order needs at least `minNotional`; this build sponsors nothing above
   * `MAX_ORDER_NOTIONAL_AUSD`. On these two books the minimum is worth more than the
   * cap — $10.81 and $8.67 against a $6 cap — so every limit order is refused
   * whichever way it is sized: too small and it is below the resting minimum, big
   * enough for the minimum and it is above the size limit. Two messages that each
   * name the other as the fix is worse than no message, so Limit is not offered here
   * at all — market orders have no such floor and fill any amount (D125).
   */
  const limitImpossible = minDollars !== undefined && minDollars > MAX_ORDER_NOTIONAL_AUSD;

  /**
   * The minimum is a **resting-order** rule and the sentence says so.
   *
   * Measured live on chain 143 at block 103,110,791
   * (`scripts/probe-market-order-minsize.ts`): `minSize` is checked only on the paths
   * that put an order on the book. A market buy of 0.10 USDC on MON/USDC — 3.837 MON
   * against a 200 MON resting minimum — fills, and `SizeError` came back from none of
   * the market-order calls. So this sentence is scoped to Limit and names the way out
   * rather than presenting the minimum as the market's floor for everything.
   */
  const minimumSentence = useMemo(() => {
    if (!params || minBase === undefined) return undefined;
    if (limitImpossible) {
      return (
        `This market's minimum resting order is worth more than this build allows per ` +
        `order, so limit orders are not available here. Market orders fill any amount now.`
      );
    }
    const minText = `${formatSize(minBase, params.baseDecimals, 0)} ${base}`;
    const notionalText =
      minDollars !== undefined ? ` ≈ $${formatMoney(minDollars, CAP_UNIT_DECIMALS, 2)}` : '';
    return (
      `Limit orders rest on the book and need ${minText}${notionalText}; ` +
      'market orders fill any amount now.'
    );
  }, [params, minBase, minDollars, base, limitImpossible]);

  // Below the resting minimum. Never blocks a market order — it only decides which
  // type is offered first, and what the Limit sentence explains.
  const belowRestingMinimum =
    minNotional !== undefined && available !== undefined && available < minNotional;

  // A limit order really cannot rest below the minimum, so that one stays blocked —
  // and only when the user has actually chosen Limit. `limitImpossible` blocks it
  // unconditionally: it is not about this account's balance, it is that no amount
  // ever clears both the minimum and the cap on this market.
  const limitBlockedByMinimum = type === 'limit' && (belowRestingMinimum || limitImpossible);

  // Default to Market when the account cannot afford a resting order, once — the
  // venue fills any size as a taker, so offering Limit first would be offering the
  // one type that cannot work. `typePinned` keeps a later balance tick from pulling
  // the choice back out from under someone who has since picked Limit themselves.
  const [typePinned, setTypePinned] = useState(false);
  useEffect(() => {
    if (typePinned || minNotional === undefined || available === undefined) return;
    if (available < minNotional) setType('market');
  }, [typePinned, minNotional, available]);

  // Where Limit is impossible on the market itself, not just for this balance, no
  // pin overrides it — there is no amount that would make it work.
  useEffect(() => {
    if (type === 'limit' && limitImpossible) setType('market');
  }, [type, limitImpossible]);

  // Defaults the amount to the minimum only where the minimum applies — a market
  // order gets the whole available balance's worth of nothing forced on it.
  useEffect(() => {
    if (amountInput !== '' || !params || minNotional === undefined || available === undefined) {
      return;
    }
    if (type === 'limit' && available >= minNotional) {
      setAmountInput(formatMoney(minNotional, params.quoteDecimals, params.quoteDecimals));
    }
  }, [amountInput, params, minNotional, available, type]);

  const validation = useMemo(() => {
    if (!params || !sender) return undefined;
    return validate(
      { market, params, side, type, priceWire, quoteAmount, sizeBase },
      available ?? 0n,
      availableBase,
      quoteUsdPrice,
    );
  }, [
    market,
    params,
    sender,
    side,
    type,
    priceWire,
    quoteAmount,
    sizeBase,
    available,
    availableBase,
    quoteUsdPrice,
  ]);

  const busy = !settled && (state === 'VALIDATING' || state === 'SIGNING' || state === 'RELAYING');
  const showStates = state !== 'IDLE';

  const disabledLabel = !sender
    ? 'Sign in to trade'
    : !params
      ? 'Loading this market'
      : venueState === 'delisted'
        ? 'Kuru no longer lists this market'
      : venueState === 'paused'
        ? 'This market is paused'
        : venueState === 'empty'
          ? 'No orders on this book'
          : !tradable
            ? (book?.invalidReason ?? 'Prices are not usable right now')
            : limitBlockedByMinimum && minimumSentence
              ? minimumSentence
              : available !== undefined && side === 'buy' && quoteAmount > available
                ? 'Move money to your trading balance first'
                : side === 'sell' && availableBase === undefined
                  ? `Your ${base} balance has not loaded yet`
                  : side === 'sell' && availableBase !== undefined && sizeBase > availableBase
                    ? `Not enough ${base} to sell`
                    : busy
                      ? 'Working'
                      : undefined;

  const disabled = disabledLabel !== undefined;

  // The fee line (design §6, corrected copy): "Paid for you" while free actions
  // remain or this deployment isn't charging; the real computed figure once a quote
  // for the order just placed resolves; a placeholder — never a fabricated
  // dollar figure — while charging is active but no quote has been fetched yet.
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

  async function place() {
    if (!params || !sender) return;
    // `/dev/perf`'s `tap` stage: the moment the button was pressed, before anything
    // else runs. Started here rather than inside `validate()`/`run()` so a rejection
    // at VALIDATING still leaves a (short) ring-buffer entry to look at.
    const perfId = beginPerfAction();
    setMessage(undefined);
    setDetail(undefined);
    setSettled(false);
    setFeePlan(undefined);
    setSegment(segmentFor('VALIDATING'));
    setState('VALIDATING');

    const checked = validate(
      { market, params, side, type, priceWire, quoteAmount, sizeBase },
      available ?? 0n,
      availableBase,
      quoteUsdPrice,
    );
    if (!checked.ok || !checked.call) {
      setTone('err');
      setMessage(checked.message ?? 'That order does not fit this market’s rules.');
      setSegment(segmentFor('VALIDATING'));
      setState('REJECTED');
      setSettled(true);
      setStage(undefined);
      return;
    }

    // `/dev/perf`'s `validated` stage: `validate()` (above) returned ok.
    recordPerfStage(perfId, 'validated');

    if (checked.adjustedPriceWire !== undefined && checked.adjustedPriceWire !== priceWire) {
      setPriceInput(formatPrice(checked.adjustedPriceWire, dp));
    }

    setState('READY');
    const call = checked.call;
    // Read as the submission starts, so a simulated order can carry a real reference from
    // the venue rather than a number this app made up. Started here and awaited where it
    // is used, after the submission, so it is no longer on the order's critical path (R9).
    const referenceRead = readOrderReference(market);

    const progress = await runWithGasCharge({
      sender,
      actionCalls: [call],
      purpose: 'order',
      marginAccount,
      ...(owner ? { owner } : {}),
      perfActionId: perfId,
      onFeePlan: setFeePlan,
      onProgress: (p) => {
        setState(p.state);
        setSegment(segmentOf(p));
        setStage(p.stageNote);
        if (p.message) setMessage(p.message);
        if (p.detail) setDetail(p.detail);
        if (p.result?.txHash) setTxHash(p.result.txHash);
        setRefusalData(p.result?.refusalData);
      },
    });

    setSettled(true);
    const reference = await referenceRead;

    setTone(progress.state === 'CONFIRMED' ? 'ok' : progress.state === 'RELAYING' ? 'warn' : 'err');
    if (progress.message) setMessage(progress.message);
    if (progress.detail) setDetail(progress.detail);
    if (progress.result?.txHash) setTxHash(progress.result.txHash);

    const simulated: SimulatedOrder | undefined =
      progress.state === 'RELAYING'
        ? {
            simulated: true,
            market,
            isBuy: side === 'buy',
            priceWire: (checked.adjustedPriceWire ?? priceWire).toString(),
            sizeBase: (checked.adjustedSizeBase ?? sizeBase).toString(),
            to: call.to,
            data: call.data,
            reference: reference.reference,
            block: reference.block,
            at: Date.now(),
          }
        : undefined;

    /**
     * What the open-orders list can show immediately.
     *
     * Scaled the way `s_orders` reports an order — `sizePrecision` and
     * `pricePrecision`, not the 1e18 wire scale — because the card that renders it
     * converts from those. Handing it wire values would draw a row off by 1e10.
     */
    const placedPrice = checked.adjustedPriceWire ?? priceWire;
    const placedSize = checked.adjustedSizeBase ?? sizeBase;
    const optimistic =
      params && placedSize > 0n && placedPrice > 0n
        ? {
            size: ((placedSize * params.sizePrecision) / 10n ** BigInt(params.baseDecimals)).toString(),
            price: ((placedPrice * params.pricePrecision) / WIRE_PRICE_SCALE).toString(),
            isBuy: side === 'buy',
          }
        : undefined;

    onPlaced({
      progress,
      side,
      perfActionId: perfId,
      ...(optimistic ? { optimistic } : {}),
      ...(simulated ? { simulated } : {}),
    });
  }

  return (
    <Card>
      <Segmented
        label="Side"
        value={side}
        onChange={(value) => {
          setSide(value);
          // The amount field's unit changes with the side, so the number in it would
          // silently come to mean something else. Clearing is the honest move.
          setAmountInput('');
          setExactAmount(undefined);
          setPriceInput('');
          setState('IDLE');
          setSettled(false);
          setSegment(0);
          setMessage(undefined);
          setDetail(undefined);
          setTxHash(undefined);
          setFeePlan(undefined);
        }}
        options={[
          { value: 'buy', label: `Buy ${base}`, color: 'var(--up)' },
          { value: 'sell', label: `Sell ${base}`, color: 'var(--down)' },
        ]}
      />

      <div className="grid2" style={{ marginTop: 12 }}>
        <Select
          id="ticket-type"
          label="Type"
          value={type}
          onChange={(value) => {
            // An explicit choice wins over the default-to-Market rule from here on.
            setTypePinned(true);
            setType(value === 'market' ? 'market' : 'limit');
          }}
          options={[
            {
              value: 'limit',
              label: limitImpossible ? 'Limit — not available on this market' : 'Limit',
              disabled: limitImpossible,
            },
            { value: 'market', label: 'Market' },
          ]}
        />
        <Field
          id="ticket-price"
          label={type === 'market' ? 'Best price (auto)' : `Price (${quote})`}
          value={
            type === 'market'
              ? priceWire > 0n
                ? formatPrice(priceWire, dp)
                : 'No price on this book'
              : priceInput
          }
          onChange={setPriceInput}
          disabled={type === 'market'}
          inputMode="decimal"
          numeric
        />
      </div>

      {/* ITEM 8. Which of these two words to pick was never explained anywhere, and
          they behave very differently on a thin book. One line each, on the one that
          is selected, at the moment the choice is being made. */}
      <p className="tiny muted" style={{ marginTop: 8 }}>
        {type === 'market'
          ? 'A market order trades now, at whatever price the book currently offers. It always fills, and on a thin book the price you get can be worse than the one shown.'
          : 'A limit order sets your price and waits on the book until someone takes it. It never fills worse than your price, and it may never fill at all.'}
      </p>

      <div style={{ marginTop: 10 }}>
        <Field
          id="ticket-amount"
          label={`Amount (${amountUnit})`}
          value={amountInput}
          onChange={(value) => {
            setAmountInput(value);
            // A hand-typed amount is exact at whatever precision was typed — only a
            // Max/percentage fill needs the separate exact value above.
            setExactAmount(undefined);
          }}
          inputMode="decimal"
          numeric
        />
      </div>

      {/* Shown before any input, straight from the market's own minimum and the live
          book — an order below it is never just "increase the amount" (item 4b). */}
      {minimumSentence ? (
        <p className={limitBlockedByMinimum ? 'tiny' : 'tiny muted'} style={{ marginTop: 6 }}>
          {minimumSentence}
        </p>
      ) : null}

      {/* Percentage of what this side actually spends, then free text as before. */}
      <div className="pcts" style={{ marginTop: 8 }}>
        {PERCENTS.map((pct) => (
          <button
            key={pct}
            type="button"
            disabled={spendable === undefined || spendable === 0n}
            onClick={() => {
              if (spendable === undefined || !params) return;
              const part = pct === 100 ? spendable : (spendable * BigInt(pct)) / 100n;
              // The field shows a display-capped string (B8); the order still spends
              // the exact `part` computed above, kept in `exactAmount`.
              setExactAmount(part);
              setAmountInput(formatMoney(part, amountDecimals, displayDp(amountUnit, amountDecimals)));
            }}
          >
            {pct === 100 ? 'Max' : `${pct}%`}
          </button>
        ))}
      </div>

      <div className="between tiny muted" style={{ marginTop: 8 }}>
        {/* The other side of the trade, live. Whichever unit was typed, this is the
            one that was not — so the pair always reads as an exchange. */}
        <span>
          {params && typedAmount > 0n && priceWire > 0n ? (
            <>
              ≈{' '}
              <span className="num">
                {spendsBase
                  ? formatMoney(quoteAmount, params.quoteDecimals, 6)
                  : formatSize(sizeBase, params.baseDecimals, 6)}
              </span>{' '}
              {spendsBase ? quote : base}
            </>
          ) : priceWire <= 0n ? (
            'No price on this book to convert with'
          ) : (
            `Enter an amount in ${amountUnit}`
          )}
        </span>
        <span>
          Available{' '}
          <span className="num">
            {!params
              ? '—'
              : side === 'buy'
                ? available === undefined
                  ? '—'
                  : `${formatMoney(available, params.quoteDecimals)} ${quote}`
                : availableBase === undefined
                  ? '—'
                  : `${formatSize(availableBase, params.baseDecimals, 2)} ${base}`}
          </span>
        </span>
      </div>

      <div className="between tiny" style={{ marginTop: 6 }}>
        <span className="muted">Network fee</span>
        <span style={feeUp ? { color: 'var(--up)' } : undefined}>{feeText}</span>
      </div>
      {chargeActive ? null : <SponsoredNote />}

      {validation && !validation.ok && amountInput !== '' ? (
        <div style={{ marginTop: 10 }}>
          <Notice tone="warn">
            {/* A generic "increase the amount" names no number. The market's own
                minimum, already computed above, replaces it whenever that is the
                actual reason (item 4b). */}
            {minimumSentence && /minimum order size/i.test(validation.message ?? '')
              ? minimumSentence
              : validation.message}
          </Notice>
        </div>
      ) : null}

      <div style={{ marginTop: 12 }}>
        <Button
          variant={side === 'buy' ? 'up' : 'down'}
          block
          disabled={disabled}
          {...(disabledLabel ? { disabledLabel } : {})}
          onClick={() => void place()}
        >
          {side === 'buy' ? `Buy ${base}` : `Sell ${base}`}
        </Button>
      </div>

      {!tradable && feedReason ? (
        <p className="tiny muted" style={{ marginTop: 8 }}>
          {feedReason}
        </p>
      ) : null}

      {showStates ? (
        <div style={{ marginTop: 12 }}>
          <TicketState
            index={segment}
            settled={settled}
            {...(stageNote ? { note: stageNote } : {})}
          />
          {settled && state === 'RELAYING' ? (
            <div style={{ marginTop: 10 }}>
              <Chip tone="warn">Simulated</Chip>
            </div>
          ) : null}
          {/* ITEM 4: one confirmation component for every completed action. A
              CONFIRMED order gets it; anything else keeps the notice, because a
              refusal is not a result. */}
          {state === 'CONFIRMED' && message ? (
            <div style={{ marginTop: 10 }}>
              <ActionResult
                headline={message}
                {...(txHash ? { txHash, explorerUrl: explorerTxUrl(txHash) } : {})}
              />
            </div>
          ) : message ? (
            <div style={{ marginTop: 10 }}>
              <Notice tone={tone}>
                <span>
                  {message}
                  {detail ? (
                    <span className="tiny muted" style={{ display: 'block', marginTop: 6 }}>
                      {detail}
                    </span>
                  ) : null}
                  {/* The one handle a gasless user has on their own trade. The
                      bundler sent the transaction, so this never appears under
                      "Transactions" on their address. */}
                  {txHash ? (
                    <span className="tiny" style={{ display: 'block', marginTop: 6 }}>
                      <a href={explorerTxUrl(txHash)} target="_blank" rel="noreferrer">
                        View this trade on the explorer
                      </a>
                      <span className="muted" style={{ display: 'block', marginTop: 2 }}>
                        {txHash}
                      </span>
                    </span>
                  ) : null}
                </span>
              </Notice>
              {/* B2c: the refusal's own two live ways forward, never a dead end. */}
              {state === 'REJECTED' ? (
                <GasRefusalActions
                  {...(refusalData ? { refusalData } : {})}
                  {...(feePlan?.kind === 'refused' && feePlan.quote ? { quote: feePlan.quote } : {})}
                />
              ) : null}
            </div>
          ) : null}
          {settled || isTerminal(state) ? (
            <div style={{ marginTop: 10 }}>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setState('IDLE');
                  setSettled(false);
                  setSegment(0);
                  setMessage(undefined);
                  setDetail(undefined);
                  setTxHash(undefined);
                }}
              >
                Start another order
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
