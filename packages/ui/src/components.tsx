'use client';

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { swipeDismisses, TOAST_MS } from './toast';

/**
 * The component set for `design/05-design-system.md` §3.
 *
 * Every component renders the prototype's class names verbatim, so the CSS in
 * `tokens.css` is the single source of appearance and these files stay thin. Where
 * the spec names a state machine or an invariant, the prop names come from the spec
 * (rule A1: spec governs logic, design governs looks).
 */

type Div = { className?: string; style?: CSSProperties; children?: ReactNode };

function cx(...parts: (string | false | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/* ---------- cards ---------- */

export interface HeroProps extends Div {
  /** 13px label above the figure. */
  label?: ReactNode;
}

/** One per screen (design §3). The AUSD figure is the hero of the page. */
export function Hero({ label, className, style, children }: HeroProps) {
  return (
    <section className={cx('hero', className)} style={style}>
      {label ? <p className="small">{label}</p> : null}
      {children}
    </section>
  );
}

export interface CardProps extends Div {
  title?: ReactNode;
  action?: ReactNode;
}

export function Card({ title, action, className, style, children }: CardProps) {
  return (
    <section className={cx('card', className)} style={style}>
      {title || action ? (
        <div className="between">
          {title ? <h3>{title}</h3> : <span />}
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export interface RowProps {
  leading?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  value?: ReactNode;
  subValue?: ReactNode;
  trailing?: ReactNode;
  /** When set, the whole row is the tap target (design §3). */
  onClick?: () => void;
}

export function Row({ leading, title, subtitle, value, subValue, trailing, onClick }: RowProps) {
  const body = (
    <>
      {leading}
      <span className="grow">
        <span className="t" style={{ display: 'block' }}>
          {title}
        </span>
        {subtitle ? (
          <span className="s" style={{ display: 'block' }}>
            {subtitle}
          </span>
        ) : null}
      </span>
      {value !== undefined ? (
        <span className="num" style={{ textAlign: 'right' }}>
          <span className="t" style={{ display: 'block' }}>
            {value}
          </span>
          {subValue !== undefined ? (
            <span className="s" style={{ display: 'block' }}>
              {subValue}
            </span>
          ) : null}
        </span>
      ) : null}
      {trailing}
    </>
  );

  if (onClick) {
    return (
      <button type="button" className="row" onClick={onClick} style={{ width: '100%' }}>
        {body}
      </button>
    );
  }
  return <div className="row">{body}</div>;
}

/* ---------- controls ---------- */

export type ButtonVariant = 'primary' | 'ghost' | 'soft' | 'line' | 'up' | 'down' | 'sell';

export interface ButtonProps {
  variant?: ButtonVariant;
  size?: 'default' | 'sm' | 'lg';
  block?: boolean;
  disabled?: boolean;
  /**
   * Why the button is disabled. Design §3 requires the reason to be in the label,
   * not a tooltip — "Add money to trade", not a greyed "Buy".
   */
  disabledLabel?: string;
  /**
   * The button's own async action is running (design §2.4: "buttons show a
   * spinner while their existing async action runs"). Renders a small spinner
   * ahead of the label; the caller still controls `disabled` separately so a busy
   * button and a disabled-with-reason button never fight over which text to show.
   */
  busy?: boolean;
  onClick?: () => void;
  type?: 'button' | 'submit';
  children: ReactNode;
}

export function Button({
  variant = 'ghost',
  size = 'default',
  block,
  disabled,
  disabledLabel,
  busy,
  onClick,
  type = 'button',
  children,
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        'btn',
        variant,
        size === 'sm' && 'sm',
        size === 'lg' && 'lg',
        block && 'block',
        busy && 'busy',
      )}
      disabled={disabled}
      onClick={onClick}
    >
      {busy && !disabled ? <span className="spin" aria-hidden="true" /> : null}
      {disabled && disabledLabel ? disabledLabel : children}
    </button>
  );
}

export type ChipTone =
  | 'neutral'
  | 'up'
  | 'down'
  | 'warn'
  | 'acc'
  | 'trading'
  | 'wallet'
  | 'ok'
  | 'bad'
  | 'mute';

/**
 * Status only. A chip that decorates is a chip that lies (design §3).
 *
 * `dot` prepends a small filled circle (a second, non-colour signal alongside the
 * tone, design §7); `pulse` blinks it for a "checking" state (market state
 * unresolved, a deposit still in flight) — the design system's one sanctioned
 * animate-on-its-own chip, because it means "still working", not decoration.
 */
export function Chip({
  tone = 'neutral',
  dot,
  pulse,
  children,
}: {
  tone?: ChipTone;
  dot?: boolean;
  pulse?: boolean;
  children: ReactNode;
}) {
  return (
    <span className={cx('chip', tone !== 'neutral' && tone, dot && 'dot', pulse && 'dot pulse')}>
      {children}
    </span>
  );
}

export interface SegmentedProps<T extends string> {
  options: readonly { value: T; label: ReactNode; color?: string }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: SegmentedProps<T>) {
  const index = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  return (
    <div className="seg" role="group" aria-label={label} data-i={index} data-count={options.length}>
      <span className="thumb" aria-hidden="true" />
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          style={option.value === value && option.color ? { color: option.color } : undefined}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A settings switch, real `<button aria-pressed>` rather than a checkbox styled to
 * look like one (design §7: `aria-pressed` on toggles). The label sits inside the
 * button so the whole row is the 44px tap target, not just the knob.
 */
export function Toggle({
  checked,
  onChange,
  label,
  ariaLabel,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Visible label, inside the button. Pass `null` when a `Row` (or similar)
   *  already shows the label text and this switch would otherwise say it twice —
   *  give `ariaLabel` instead, so the control still has an accessible name. */
  label: ReactNode;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="toggle"
      aria-pressed={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      {label}
      <i aria-hidden="true" />
    </button>
  );
}

export interface FieldProps {
  label: ReactNode;
  id: string;
  value: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
  readOnly?: boolean;
  inputMode?: 'decimal' | 'numeric' | 'text';
  numeric?: boolean;
}

export function Field({
  label,
  id,
  value,
  onChange,
  disabled,
  readOnly,
  inputMode = 'text',
  numeric,
}: FieldProps) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className={numeric ? 'num' : undefined}
        value={value}
        inputMode={inputMode}
        disabled={disabled}
        readOnly={readOnly}
        onChange={(e) => onChange?.(e.target.value)}
      />
    </div>
  );
}

export interface SelectProps {
  label: ReactNode;
  id: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** `disabled` on one option keeps it visible but not selectable — a market that is
   *  shown, not traded, uses this rather than being left out of the list. */
  options: readonly { value: string; label: string; disabled?: boolean }[];
}

/** Same `.field` contract as `Field`; a select rather than an input. */
export function Select({ label, id, value, onChange, disabled, options }: SelectProps) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export type NoticeTone = 'warn' | 'err' | 'ok';

/** States the fact and the fix. Never apologises, never shows hex (design §6). */
export function Notice({ tone = 'warn', children }: { tone?: NoticeTone; children: ReactNode }) {
  return (
    <div
      className={cx('notice', tone !== 'warn' && tone)}
      role={tone === 'err' ? 'alert' : undefined}
    >
      <span>{children}</span>
    </div>
  );
}

/* ---------- money ---------- */

export interface AmountProps {
  /** Already formatted, e.g. "21,689.66". Formatting is `formatAusd` in core. */
  formatted: string;
  currency?: string;
  bump?: boolean;
}

export function Amount({ formatted, currency = 'AUSD', bump }: AmountProps) {
  const [whole = '0', cents = '00'] = formatted.split('.');
  return (
    <div className={cx('amount', 'num', bump && 'bump')}>
      <span className="cur">{currency}</span>
      {whole}
      <span className="cents">.{cents}</span>
    </div>
  );
}

export function Coin({ symbol, color }: { symbol: string; color: string }) {
  return (
    <span className="coin" style={{ background: color }} aria-hidden="true">
      {symbol.slice(0, 4)}
    </span>
  );
}

export type TokenIconSize = 'default' | 'sm' | 'xs';

/**
 * Token icon (design system §3 / redesign `.tok`): a rounded-square glyph with the
 * two-letter fallback every token needs, since not every token has a logo (rule C:
 * "token icons with the two-letter fallback" must survive the reskin). With `src`
 * (the app's own `/api/token-icon/<address>` route) it draws that image inside the
 * glyph, and falls back to the letters if the image fails to load.
 */
export function TokenIcon({
  symbol,
  color,
  size = 'default',
  src,
  onImageError,
}: {
  symbol: string;
  /** Background for the glyph. */
  color: string;
  size?: TokenIconSize;
  /** Same-origin image URL. Omitted, or failing, shows the letters. */
  src?: string;
  onImageError?: () => void;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (src && failedSrc !== src) {
    return (
      <span
        className={cx('tok', size === 'sm' && 'sm', size === 'xs' && 'xs')}
        style={{ background: color, overflow: 'hidden' }}
        aria-hidden="true"
      >
        <img
          src={src}
          alt=""
          loading="lazy"
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          onError={() => {
            setFailedSrc(src);
            onImageError?.();
          }}
        />
      </span>
    );
  }
  return (
    <span
      className={cx('tok', size === 'sm' && 'sm', size === 'xs' && 'xs')}
      style={{ background: color }}
      aria-hidden="true"
    >
      {symbol.slice(0, 2).toUpperCase()}
    </span>
  );
}

export interface PairIconSide {
  symbol: string;
  color: string;
  src?: string;
  onImageError?: () => void;
}

function sideImage(side: PairIconSide): { src?: string; onImageError?: () => void } {
  return {
    ...(side.src ? { src: side.src } : {}),
    ...(side.onImageError ? { onImageError: side.onImageError } : {}),
  };
}

/** Pair icon (redesign `.pair-ic`): the base token's icon over the quote token's,
 *  for a market row or the Trade market picker. */
export function PairIcon({
  base,
  quote,
}: {
  base: PairIconSide;
  quote: PairIconSide;
}) {
  return (
    <span className="pair-ic" aria-hidden="true">
      <TokenIcon symbol={base.symbol} color={base.color} {...sideImage(base)} />
      <TokenIcon symbol={quote.symbol} color={quote.color} {...sideImage(quote)} />
    </span>
  );
}

/* ---------- the result of a completed action ---------- */

export interface ActionResultProps {
  /**
   * What happened, in the past tense, as one sentence: "Bought 3.87 MON for 0.10 USDC".
   * The caller writes it because only the caller knows the verbs and the amounts.
   */
  readonly headline: string;
  /** Where the money now is, e.g. "0.77 MON in your trading balance". Optional. */
  readonly resultingBalance?: string;
  /** The transaction. Both are required together or not at all. */
  readonly txHash?: string;
  readonly explorerUrl?: string;
  /** Label and handler for the one primary way out. */
  readonly actionLabel?: string;
  readonly onAction?: () => void;
  /** Copies `txHash`. Supplied by the app, which owns clipboard access and its toast. */
  readonly onCopyHash?: () => void;
}

/**
 * The single result state for every action that changes something.
 *
 * The design system's ticket state machine ends at CONFIRMED and never said what the
 * user then sees, so every screen grew its own ending — a toast here, a notice there,
 * a hash on one card and nothing on the next. This is that ending, once.
 *
 * The transaction hash is a first-class part of it and not an afterthought: under
 * EIP-7702 the bundler sends the transaction, so a user's own address never lists it
 * and the hash is the only handle they have on their own money.
 */
export function ActionResult({
  headline,
  resultingBalance,
  txHash,
  explorerUrl,
  actionLabel,
  onAction,
  onCopyHash,
}: ActionResultProps) {
  return (
    <div className="notice ok" role="status">
      <span>
        <span className="t" style={{ display: 'block', fontWeight: 600 }}>
          {headline}
        </span>
        {resultingBalance ? (
          <span className="small" style={{ display: 'block', marginTop: 4 }}>
            {resultingBalance}
          </span>
        ) : null}
        {txHash && explorerUrl ? (
          <span className="tiny" style={{ display: 'block', marginTop: 8 }}>
            <a href={explorerUrl} target="_blank" rel="noreferrer">
              View on the explorer
            </a>
            <span className="num muted" style={{ display: 'block', marginTop: 2 }}>
              {txHash}
            </span>
            {onCopyHash ? (
              <span style={{ display: 'block', marginTop: 6 }}>
                <Button variant="ghost" size="sm" onClick={onCopyHash}>
                  Copy hash
                </Button>
              </span>
            ) : null}
          </span>
        ) : null}
        {actionLabel && onAction ? (
          <span style={{ display: 'block', marginTop: 10 }}>
            <Button variant="soft" size="sm" onClick={onAction}>
              {actionLabel}
            </Button>
          </span>
        ) : null}
      </span>
    </div>
  );
}

/* ---------- order book ---------- */

export interface BookLevel {
  price: string;
  size: string;
  /** 0..1 of the deepest level on either side. */
  depth: number;
}

export interface OrderBookProps {
  bids: readonly BookLevel[];
  asks: readonly BookLevel[];
  mid?: string;
  spread?: string;
  /** Set when invariant I1 or I6 failed. Desaturates and disables the ticket. */
  dim?: boolean;
}

export function OrderBook({ bids, asks, mid, spread, dim }: OrderBookProps) {
  return (
    <>
      {mid ? <div className="mid num">{mid}</div> : null}
      <div className="spread num">{spread ?? '—'}</div>
      <div className={cx('book', dim && 'dim')} style={{ marginTop: 8 }}>
        <div className="side">
          {bids.map((level) => (
            <div className="lvl bid" key={`bid-${level.price}`}>
              <span className="bar" style={{ width: `${level.depth * 100}%` }} />
              <span className="px num">{level.price}</span>
              <span className="num muted">{level.size}</span>
            </div>
          ))}
        </div>
        <div className="side">
          {asks.map((level) => (
            <div className="lvl ask" key={`ask-${level.price}`}>
              <span className="bar" style={{ width: `${level.depth * 100}%` }} />
              <span className="px num">{level.price}</span>
              <span className="num muted">{level.size}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

/* ---------- ticket state ---------- */

/**
 * The five states of spec §6.2, in the design system's words — with one correction.
 *
 * The second was **"Face ID"** and no user was ever asked for one. The account key is
 * derived from the passkey once at sign-in and kept as a local account, so signing an
 * operation is an in-memory signature: measured at 5 ms on 2026-09-10, no prompt. A
 * label naming a biometric that never appears is the kind of small lie that makes
 * people stop believing the rest of the pill, so it says what the time is really
 * spent on. Deviation from design §6.2 logged as D141.
 */
export const TICKET_STATES = ['Checking', 'Preparing', 'Sending', 'Mined', 'Confirmed'] as const;
export type TicketStateLabel = (typeof TICKET_STATES)[number];

export function TicketState({
  index,
  error,
  note,
  settled,
  partial,
}: {
  index: number;
  error?: string;
  /** One word for a stage that has run long enough to need explaining. */
  note?: string;
  /**
   * The action has finished, successfully or not.
   *
   * Without this the last segment stayed `.active` forever: `segmentFor('CONFIRMED')`
   * is 4, segment 4 was drawn as the one in progress, and its sweep animation ran on
   * a loop under a toast reading "Bought 0.427917 MON". A completed action that is
   * still visibly working is the app disagreeing with itself.
   *
   * Settled and successful fills every segment. Settled and failed fills the ones that
   * genuinely completed and marks the one that failed — it is not painted `--accent`,
   * because a stage that failed did not succeed.
   */
  settled?: boolean;
  /** Steps finished inside the active stage, and how many it has. Fills that share of it. */
  partial?: { readonly done: number; readonly of: number };
}) {
  const failed = settled === true && error !== undefined;
  const share =
    partial && partial.of > 0 ? Math.min(100, Math.max(0, Math.round((partial.done / partial.of) * 100))) : undefined;
  return (
    <>
      <div
        className="state"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={4}
        aria-valuenow={index}
      >
        {TICKET_STATES.map((label, i) => (
          <span
            key={label}
            className={cx(
              'st',
              (i < index || (settled === true && !failed && i <= index)) && 'done',
              failed && i === index && 'failed',
              settled !== true && i === index && 'active',
            )}
          >
            {share !== undefined && settled !== true && i === index ? (
              <span className="fill" style={{ width: `${share}%` }} />
            ) : null}
          </span>
        ))}
      </div>
      <div className="statelbl">
        {TICKET_STATES.map((label, i) => (
          <span key={label} className={i === index ? 'on' : undefined}>
            {label}
          </span>
        ))}
      </div>
      {note && !error ? (
        <p className="tiny muted" style={{ marginTop: 6, textAlign: 'center' }}>
          {note}
        </p>
      ) : null}
      {error ? (
        <div style={{ marginTop: 10 }}>
          <Notice tone="err">{error}</Notice>
        </div>
      ) : null}
    </>
  );
}

/* ---------- steps ---------- */

export interface StepItem {
  label: ReactNode;
  detail?: ReactNode;
}

export function StepList({ steps, current }: { steps: readonly StepItem[]; current: number }) {
  return (
    <ol className="steps" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {steps.map((step, i) => (
        <li
          key={typeof step.label === 'string' ? step.label : i}
          className={cx('step', i < current && 'done', i === current && 'active')}
          aria-current={i === current ? 'step' : undefined}
        >
          <span className="dot">{i < current ? <CheckIcon /> : null}</span>
          <span>
            <span className="lbl" style={{ display: 'block' }}>
              {step.label}
            </span>
            {step.detail ? (
              <span className="sub" style={{ display: 'block' }}>
                {step.detail}
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

/* ---------- overlays ---------- */

/**
 * One toast contract (spec F1): shown, then gone after `TOAST_MS` on its own, or
 * sooner on a tap or a horizontal swipe. The timer lives here, not in each caller, so
 * no screen can keep a toast up longer or forget to take it down. `action` is a
 * separate, visible control for anything a toast used to do on tap (Chrome's "View"
 * navigation): tapping the toast itself only dismisses it.
 */
export function Toast({
  message,
  show,
  onDismiss,
  action,
}: {
  message: ReactNode;
  show: boolean;
  onDismiss?: () => void;
  action?: { readonly label: string; readonly onClick: () => void };
}) {
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const pointerStart = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!show) return;
    const id = window.setTimeout(() => dismissRef.current?.(), TOAST_MS);
    return () => window.clearTimeout(id);
  }, [show]);

  return (
    <div
      className={cx('toast', show && 'show')}
      role="status"
      aria-live="polite"
      onClick={() => dismissRef.current?.()}
      onPointerDown={(e) => {
        pointerStart.current = { x: e.clientX, y: e.clientY };
      }}
      onPointerUp={(e) => {
        const start = pointerStart.current;
        pointerStart.current = null;
        if (start && swipeDismisses(e.clientX - start.x, e.clientY - start.y)) dismissRef.current?.();
      }}
    >
      <CheckIcon />
      {message}
      {action ? (
        <span
          onClick={(e) => {
            e.stopPropagation();
            action.onClick();
          }}
        >
          <Button variant="ghost" size="sm">
            {action.label}
          </Button>
        </span>
      ) : null}
    </div>
  );
}

/**
 * The one modal in the app: a bottom sheet on a phone, a centred dialog on desktop.
 *
 * CSS decides which, so there is one component and no width measurement in JS. What
 * this file adds beyond the markup is the behaviour a dialog owes its user, all of
 * which was missing when the sheet was only ever used for confirmations:
 *
 *   - **Escape closes it**, because that is the key people press.
 *   - **Focus is trapped inside it and restored on close.** Without this, tabbing walks
 *     out of the dialog into the page behind it, which for a screen-reader user means
 *     the modal is not a modal at all.
 *   - **Swipe down dismisses it on a phone**, tracked with pointer events so it works
 *     for touch and stylus alike. The panel follows the finger and springs back if the
 *     gesture is too small to count, so a mis-swipe is visibly a mis-swipe.
 *   - **Safe-area padding** so the panel clears the tab bar and the iOS home indicator.
 *
 * `labelledBy` points at the id of the heading inside, so the dialog announces itself
 * by its own title rather than as an unnamed region.
 */
export function Sheet({
  open,
  onClose,
  children,
  labelledBy,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  labelledBy?: string;
}) {
  const panel = useRef<HTMLDivElement | null>(null);
  const restoreFocusTo = useRef<Element | null>(null);
  const [drag, setDrag] = useState(0);
  const dragFrom = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!open) {
      setDrag(0);
      return;
    }
    restoreFocusTo.current = document.activeElement;
    // Focus the panel itself rather than its first control: a dialog that opens with
    // a button already focused invites pressing it by reflex.
    panel.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !panel.current) return;
      const focusable = panel.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        // Nothing focusable inside: keep focus on the panel rather than letting Tab
        // escape to the page behind, which is what "modal" is supposed to prevent.
        event.preventDefault();
        panel.current.focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      (restoreFocusTo.current as HTMLElement | null)?.focus?.();
    };
  }, [open, onClose]);

  return (
    <div
      className={cx('sheet', open && 'show')}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        className="panel"
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        {...(labelledBy ? { 'aria-labelledby': labelledBy } : {})}
        style={drag > 0 ? { transform: `translateY(${drag}px)`, transition: 'none' } : undefined}
        onPointerDown={(e) => {
          // Only from the grabber area at the top, so a swipe over the content
          // scrolls the content instead of fighting it.
          if (e.currentTarget.scrollTop > 0) return;
          dragFrom.current = e.clientY;
        }}
        onPointerMove={(e) => {
          if (dragFrom.current === undefined) return;
          const delta = e.clientY - dragFrom.current;
          if (delta > 0) setDrag(delta);
        }}
        onPointerUp={() => {
          if (dragFrom.current === undefined) return;
          dragFrom.current = undefined;
          // Far enough to read as intent. Anything less springs back.
          if (drag > 90) onClose();
          setDrag(0);
        }}
        onPointerCancel={() => {
          dragFrom.current = undefined;
          setDrag(0);
        }}
      >
        <div className="grabber" aria-hidden="true" />
        {children}
      </div>
    </div>
  );
}

export function InstallBanner({ onAdd, onDismiss }: { onAdd: () => void; onDismiss?: () => void }) {
  return (
    <div className="install">
      <span className="ic">
        <MarkIcon />
      </span>
      <span className="grow">
        <span className="t small" style={{ display: 'block' }}>
          Add MoneyMarkets to your home screen
        </span>
        <span className="tiny muted" style={{ display: 'block' }}>
          Opens full-screen. Same account, same passkey.
        </span>
      </span>
      <Button variant="soft" size="sm" onClick={onAdd}>
        Add
      </Button>
      {onDismiss ? (
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Not now
        </Button>
      ) : null}
    </div>
  );
}

/* ---------- passkey ---------- */

export type PasskeyState = 'idle' | 'pulsing' | 'done';

export function Passkey({ state }: { state: PasskeyState }) {
  return (
    <div className={cx('passkey', state === 'pulsing' && 'pulsing', state === 'done' && 'done')}>
      <span className="ring" />
      <span className="ring" />
      <span className="ring" />
      <span className="face">
        <FaceIcon />
      </span>
    </div>
  );
}

/* ---------- icons ---------- */

/** The app mark: three ascending bars, the same shape `scripts/icons.mjs` draws. */
export function MarkIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <rect x="3" y="14" width="4.4" height="7" rx="2.2" />
      <rect x="9.8" y="9.5" width="4.4" height="11.5" rx="2.2" />
      <rect x="16.6" y="5" width="4.4" height="16" rx="2.2" />
    </svg>
  );
}

export function CheckIcon() {
  return (
    <svg className="i" viewBox="0 0 24 24" style={{ width: 16, height: 16, strokeWidth: 2.6 }}>
      <path d="M5 12l4 4 10-10" />
    </svg>
  );
}

export function FaceIcon() {
  return (
    <svg className="i" viewBox="0 0 24 24" style={{ width: 38, height: 38 }}>
      <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
      <path d="M9 10h.01M15 10h.01M9 15a4 4 0 0 0 6 0" />
    </svg>
  );
}
