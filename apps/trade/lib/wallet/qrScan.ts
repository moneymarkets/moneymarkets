import { getAddress, isAddress, type Address } from 'viem';

/**
 * QR scanning for Send's recipient field (wallet spec §4.3): the parsing and
 * gating logic only. Opening the camera and running `BarcodeDetector` needs a
 * live `<video>` element and a `MediaStream`, neither of which exists in this
 * app's DOM-free test environment (`apps/trade/vitest.config.ts` runs no
 * jsdom, deliberately), so that part lives in `components/QrScanButton.tsx` and
 * is exercised by hand. Everything here that can be a pure function is one.
 */

/**
 * `'BarcodeDetector' in window`, exactly as the spec words it (§4.3): present
 * only when the API exists. The button this gates is hidden, not disabled, when
 * this is false — there is nothing to turn on.
 */
export function barcodeDetectorSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'BarcodeDetector' in (window as unknown as Record<string, unknown>)
  );
}

/**
 * A decoded QR payload, reduced to an address or nothing.
 *
 * Reuses `SendScreen.tsx`'s own check — `isAddress` from viem on the trimmed
 * value — rather than inventing a second notion of "a valid address". A scan
 * that accepted something the typed field would reject would be worse than one
 * that asks the user to type it instead.
 *
 * A bare address is the common case. `ethereum:0x…` (EIP-681) is the other one
 * a wallet's own "receive" QR is likely to encode; a trailing `@<chainId>` or
 * `?<query>` (an amount, say) is stripped, since Send only ever wants the
 * address out of it.
 */
export function parseScannedAddress(raw: string): Address | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const withoutScheme = trimmed.replace(/^ethereum:/i, '');
  const withoutQuery = withoutScheme.split('?')[0] ?? withoutScheme;
  const withoutChainId = withoutQuery.split('@')[0] ?? withoutQuery;
  return isAddress(withoutChainId) ? getAddress(withoutChainId) : undefined;
}

/**
 * `getUserMedia`'s own `DOMException.name`, reduced to the two states this
 * screen distinguishes: the user said no, or the camera could not be opened for
 * any other reason (no device, already in use elsewhere, a platform refusal).
 * Unknown names fail toward the more general, still-recoverable state rather
 * than asserting a refusal that was never confirmed.
 */
export function mapGetUserMediaError(name: string): 'permission-denied' | 'camera-unavailable' {
  return name === 'NotAllowedError' || name === 'PermissionDeniedError'
    ? 'permission-denied'
    : 'camera-unavailable';
}

export type ScanEvent =
  | { readonly type: 'permission-denied' }
  | { readonly type: 'camera-unavailable' }
  | { readonly type: 'detected'; readonly raw: string };

export type ScanOutcome =
  | { readonly kind: 'filled'; readonly address: Address }
  /** Something was decoded but it was not an address. Keep scanning rather than
   *  treating a QR code that says something else as a failure. */
  | { readonly kind: 'ignored' }
  | { readonly kind: 'error'; readonly code: 'CAMERA_PERMISSION_DENIED' | 'CAMERA_UNAVAILABLE' };

/** The one place a scan event turns into what the screen does about it. */
export function handleScanEvent(event: ScanEvent): ScanOutcome {
  if (event.type === 'permission-denied') {
    return { kind: 'error', code: 'CAMERA_PERMISSION_DENIED' };
  }
  if (event.type === 'camera-unavailable') {
    return { kind: 'error', code: 'CAMERA_UNAVAILABLE' };
  }
  const address = parseScannedAddress(event.raw);
  return address ? { kind: 'filled', address } : { kind: 'ignored' };
}
