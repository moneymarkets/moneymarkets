import type { FreeActionsInfo } from './gasCharge';

/**
 * B4's header counter and banners, as pure view logic so the exact thresholds and
 * copy are testable without rendering (G1: "header pill and banner at 14, 15, 18,
 * 20").
 *
 * The pill shows what is left ("Free actions 13 of 20" = 13 still free), counting
 * the same direction as the banner copy ("Two free actions left today"). It turns
 * red from 15 used — with the 20-action tier, from 5 remaining — so the threshold
 * is written as `limit - 5`, the spec's own figure at the spec's own limit, rather
 * than a hardcoded 15 that would silently misfire if the tier ever changed.
 *
 * The low-actions banner is specified at 18 used ("Two free actions left today").
 * At 19 used the same banner shows "One free action left today" — the spec gives
 * the copy for the moment it first appears, and showing "Two" with one left would
 * be a fake value (R-rule: no fake values anywhere).
 */

export interface FreeActionsPillView {
  readonly text: string;
  /** Red from 15 used (limit 20). */
  readonly alert: boolean;
}

export function freeActionsPill(f: FreeActionsInfo): FreeActionsPillView {
  const remaining = Math.max(f.remaining, 0);
  return {
    text: `Free actions ${remaining} of ${f.limit}`,
    alert: f.used >= Math.max(f.limit - 5, 0),
  };
}

export interface FreeActionsBannerView {
  /** 'low' blinks (the spec's thin blinking banner at 18); 'used-up' does not. */
  readonly level: 'low' | 'used-up';
  readonly message: string;
}

export function freeActionsBanner(f: FreeActionsInfo): FreeActionsBannerView | undefined {
  const remaining = Math.max(f.remaining, 0);
  if (remaining <= 0) {
    return {
      level: 'used-up',
      message: `Your ${f.limit} free actions for today are used. Swapping into MON is still free and gives you MON to pay your own gas. Or pay gas from your trading balance at cost.`,
    };
  }
  if (remaining === 2) {
    return {
      level: 'low',
      message:
        'Two free actions left today. Swap into MON now and every action after that is paid from your own MON.',
    };
  }
  if (remaining === 1) {
    return {
      level: 'low',
      message:
        'One free action left today. Swap into MON now and every action after that is paid from your own MON.',
    };
  }
  return undefined;
}

/** The banner's Swap link: Swap prefilled to reach 12 MON (B3). */
export const SWAP_INTO_MON_HREF = '/wallet/swap?into=mon';
