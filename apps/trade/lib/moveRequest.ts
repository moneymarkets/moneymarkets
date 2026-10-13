'use client';

/**
 * "Move this one" — from the deposit card to the Move card, without lifting state.
 *
 * The two cards are siblings on `/fund` with a screenful between them. When a deposit
 * lands, the useful next tap is moving exactly what just arrived into the trading
 * balance — which means the Move card needs to select that token and scroll into view.
 *
 * A window event rather than shared state or a query string: it is one hint, it does not
 * need to survive a reload, and threading a setter through the page for it would make
 * both cards harder to read for a nudge that either lands or does not. If nothing is
 * listening the button still scrolls, so the worst case is the user picks the token
 * themselves — which is what they did before this existed.
 */

export const MOVE_REQUEST_EVENT = 'tradepro:move-request';

export interface MoveRequest {
  /** The token that just arrived: 'USDC', 'AUSD', 'USDT0'. */
  readonly symbol: string;
}

export function requestMove(symbol: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<MoveRequest>(MOVE_REQUEST_EVENT, { detail: { symbol } }));
  document.getElementById('move')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export function onMoveRequest(handler: (request: MoveRequest) => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const listener = (event: Event) => handler((event as CustomEvent<MoveRequest>).detail);
  window.addEventListener(MOVE_REQUEST_EVENT, listener);
  return () => window.removeEventListener(MOVE_REQUEST_EVENT, listener);
}
