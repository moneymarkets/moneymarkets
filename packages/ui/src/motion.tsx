'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { Amount } from './components';

/**
 * The two entries in the design §2.4 motion table that need JavaScript.
 *
 * Everything else — the sheet, the toast, the segmented thumb, the ticket sweep, the
 * step-dot blink, the book bars re-widening — is a CSS transition in `tokens.css`,
 * which is where motion belongs. What CSS cannot do is interpolate a *number*, so
 * the balance count-up lives here.
 *
 * `prefers-reduced-motion` is honoured by jumping straight to the final value rather
 * than by animating faster. The CSS rule in `tokens.css` collapses durations to
 * ~0 ms; a count-up that still ran 900 ms of frames would be the one thing on the
 * screen still moving.
 */

export function usePrefersReducedMotion(): boolean {
  // Server-render as "no preference", then correct after mount. The server has no
  // media queries and must not guess one.
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(query.matches);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return reduced;
}

export const COUNT_UP_MS = 900;

/**
 * Count from the previous value to the current one over 900 ms, ease-out cubic
 * (design §2.4).
 *
 * The interpolation runs on `number`, deliberately and only here: it produces the
 * frames between two already-formatted figures and never travels back into a
 * calculation (rule A2.6). The final frame is the exact string it was handed, so the
 * number that comes to rest is the one that was read from the chain, not a rounded
 * reconstruction of it.
 */
export function useCountUp(target: string): { text: string; bumping: boolean } {
  const [text, setText] = useState(target);
  const [bumping, setBumping] = useState(false);
  const previous = useRef(target);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    const from = parseFormatted(previous.current);
    const to = parseFormatted(target);
    previous.current = target;

    // First paint, an unparseable figure, or no change at all: show it and stop.
    if (from === undefined || to === undefined || from === to || reduced) {
      setText(target);
      return;
    }

    setBumping(true);
    const decimals = decimalsOf(target);
    const started = performance.now();
    let frame = 0;

    const step = (now: number) => {
      const k = Math.min(1, (now - started) / COUNT_UP_MS);
      const eased = 1 - Math.pow(1 - k, 3);
      if (k >= 1) {
        // Land on the string that was passed in, not on a re-formatted float.
        setText(target);
        setBumping(false);
        return;
      }
      setText(group(from + (to - from) * eased, decimals));
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);

    return () => {
      cancelAnimationFrame(frame);
      setBumping(false);
    };
  }, [target, reduced]);

  return { text, bumping };
}

function parseFormatted(value: string): number | undefined {
  const n = Number(value.replace(/,/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

function decimalsOf(value: string): number {
  const dot = value.indexOf('.');
  return dot === -1 ? 0 : value.length - dot - 1;
}

function group(value: number, decimals: number): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * The hero figure, animated when it changes (design §2.4: 900 ms count-up plus a 3%
 * scale bump).
 *
 * It is a separate component from `Amount` rather than a prop on it, because a
 * count-up is only honest when the previous figure was also real. A screen that has
 * just loaded has nothing to count from and renders `Amount` directly.
 */
export function LiveAmount({
  formatted,
  currency = 'AUSD',
}: {
  formatted: string;
  currency?: string;
}) {
  const { text, bumping } = useCountUp(formatted);
  return <Amount formatted={text} currency={currency} bump={bumping} />;
}

/*
 * ---------- wallet motion primitives (design §7 / wallet spec §7) ----------
 *
 * Ported from the interaction reference's behaviour, not its markup: same
 * triggers, same rough durations, this app's own CSS variables for colour. Every
 * one of these is action-triggered and does nothing on mount or on hover (rule
 * A6) — each waits for an explicit call, the same way `useCountUp` above waits
 * for its value to change rather than animating on render.
 *
 * They render nothing on their own beyond a class name or a detached DOM node;
 * the classes they toggle (`.ripple`, `.disc`, `.row.flash`, `.fly`, `.dot2`) live
 * in `tokens.css`; Swap/Send/Move compose them onto their own markup.
 */

/**
 * Green wash from a corner, for a balance that just changed (design §2.4: ripple
 * on balance change). `play()` restarts the animation even if it is already
 * running, so two deposits landing back to back both get their own ripple.
 */
export function useRipple(): { className: string; play: () => void } {
  const [go, setGo] = useState(false);
  const reduced = usePrefersReducedMotion();

  const play = useCallback(() => {
    if (reduced) return;
    // Drop the class, then re-add it on the next frame — a restart, the same way
    // the reference forces one with `void el.offsetWidth` before re-adding `.go`.
    setGo(false);
    requestAnimationFrame(() => setGo(true));
  }, [reduced]);

  return { className: go ? 'ripple go' : 'ripple', play };
}

/**
 * A row that expands in place with a height ease, via the CSS `grid-template-rows`
 * trick (`.disc` / `.disc.open`) rather than a JS height measurement. Content stays
 * mounted whether open or not, so nothing remounts on expand and a screen reader
 * always has it in the tree.
 */
export function Disclosure({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div className={open ? 'disc open' : 'disc'}>
      <div>{children}</div>
    </div>
  );
}

/**
 * A one-time highlight on a row that just changed (design §2.4: "row slides down
 * ... with a brief flash"; wallet spec §7: "one flash on the affected holding
 * rows"). Call `flash()` from the receipt handler; the class clears itself so the
 * same row can flash again on the next action.
 */
export function useRowFlash(durationMs = 1100): { className: string; flash: () => void } {
  const [on, setOn] = useState(false);
  const reduced = usePrefersReducedMotion();

  const flash = useCallback(() => {
    if (reduced) return;
    setOn(false);
    requestAnimationFrame(() => setOn(true));
  }, [reduced]);

  useEffect(() => {
    if (!on) return;
    const id = window.setTimeout(() => setOn(false), durationMs);
    return () => window.clearTimeout(id);
  }, [on, durationMs]);

  return { className: on ? 'flash' : '', flash };
}

/**
 * Whether this browser can animate an element along a path (`offset-path`). Swap
 * and Send use this to choose between the flying-token arc and its fallback: a
 * browser without support gets the chip appearing at the destination and fading in,
 * never a broken jump partway through a path it cannot follow.
 */
export function supportsOffsetPath(): boolean {
  return (
    typeof CSS !== 'undefined' &&
    typeof CSS.supports === 'function' &&
    CSS.supports('offset-path', "path('M0 0')")
  );
}

/**
 * Fly a small token chip from one element to another along an arc (design: Swap's
 * pay box to its receive box; Send's amount field to the chosen recipient row).
 *
 * `container` must establish the positioning context (`position: relative` or
 * stronger) and contain both `from` and `to` — coordinates are computed relative
 * to it, the same box the reference measures against with
 * `screen.getBoundingClientRect()`.
 *
 * A caller supplies `reducedMotion` (from `usePrefersReducedMotion()`) rather than
 * this function reading it itself, because this is a plain DOM utility called from
 * an event handler, not a component that could use the hook.
 */
export function flyToken(
  from: HTMLElement,
  to: HTMLElement,
  label: string,
  container: HTMLElement,
  reducedMotion = false,
): void {
  if (reducedMotion) return;
  const a = from.getBoundingClientRect();
  const b = to.getBoundingClientRect();
  const c = container.getBoundingClientRect();
  const x1 = a.left - c.left + a.width / 2;
  const y1 = a.top - c.top + a.height / 2;
  const x2 = b.left - c.left + b.width / 2;
  const y2 = b.top - c.top + b.height / 2;

  const el = document.createElement('div');
  el.textContent = label;
  el.style.left = '0';
  el.style.top = '0';

  if (supportsOffsetPath()) {
    el.className = 'fly animated';
    el.style.setProperty(
      'offset-path',
      `path("M${x1} ${y1} Q ${(x1 + x2) / 2 + 80} ${(y1 + y2) / 2 - 60} ${x2} ${y2}")`,
    );
  } else {
    // No path support: appear at the destination and fade, instead of animating
    // along a path this browser cannot draw.
    el.className = 'fly fallback';
    el.style.left = `${x2}px`;
    el.style.top = `${y2}px`;
    el.style.transform = 'translate(-50%, -50%)';
  }
  container.appendChild(el);
  window.setTimeout(() => el.remove(), 950);
}

/**
 * A small burst of dots on the element that just received something (design:
 * Confirmed on Swap and Send). Colours are this app's own tokens (`--accent`,
 * `--up`, `--warn`), not the reference's hardcoded hexes.
 */
export function confettiBurst(
  el: HTMLElement,
  container: HTMLElement,
  reducedMotion = false,
  count = 14,
): void {
  if (reducedMotion) return;
  const b = el.getBoundingClientRect();
  const c = container.getBoundingClientRect();
  const cx = b.left - c.left + b.width / 2;
  const cy = b.top - c.top + b.height / 2;
  const colors = ['var(--accent)', 'var(--up)', 'var(--warn)'];
  for (let i = 0; i < count; i++) {
    const dot = document.createElement('div');
    dot.className = 'dot2';
    dot.style.left = `${cx}px`;
    dot.style.top = `${cy}px`;
    dot.style.background = colors[i % colors.length] ?? 'var(--accent)';
    const angle = (Math.PI * 2 * i) / count;
    const radius = 40 + Math.random() * 40;
    dot.style.setProperty('--dx', `${Math.cos(angle) * radius}px`);
    dot.style.setProperty('--dy', `${Math.sin(angle) * radius}px`);
    container.appendChild(dot);
    window.setTimeout(() => dot.remove(), 750);
  }
}
