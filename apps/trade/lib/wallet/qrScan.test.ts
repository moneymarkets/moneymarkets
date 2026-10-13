import { afterEach, describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import {
  barcodeDetectorSupported,
  handleScanEvent,
  mapGetUserMediaError,
  parseScannedAddress,
} from './qrScan';

const LOWER = '0x43a275c3eb0be7313f847ffa4fb6bd366606a961';
const CHECKSUMMED = getAddress(LOWER);

describe('barcodeDetectorSupported (wallet spec §4.3: hidden, not disabled)', () => {
  const original = (globalThis as { window?: unknown }).window;

  afterEach(() => {
    if (original === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = original;
  });

  it('is false with no window at all (SSR / this test environment)', () => {
    delete (globalThis as { window?: unknown }).window;
    expect(barcodeDetectorSupported()).toBe(false);
  });

  it('is false when window exists but carries no BarcodeDetector', () => {
    (globalThis as { window?: unknown }).window = {};
    expect(barcodeDetectorSupported()).toBe(false);
  });

  it('is true only when the global carries BarcodeDetector', () => {
    (globalThis as { window?: unknown }).window = { BarcodeDetector: class {} };
    expect(barcodeDetectorSupported()).toBe(true);
  });
});

describe('parseScannedAddress', () => {
  it('accepts a bare address', () => {
    expect(parseScannedAddress(LOWER)).toBe(CHECKSUMMED);
  });

  it('trims surrounding whitespace, e.g. a QR payload with a trailing newline', () => {
    expect(parseScannedAddress(`  ${LOWER}\n`)).toBe(CHECKSUMMED);
  });

  it('strips an ethereum: scheme prefix (EIP-681)', () => {
    expect(parseScannedAddress(`ethereum:${LOWER}`)).toBe(CHECKSUMMED);
  });

  it('strips a trailing chain id (ethereum:addr@chainId)', () => {
    expect(parseScannedAddress(`ethereum:${LOWER}@10143`)).toBe(CHECKSUMMED);
  });

  it('strips query parameters (e.g. an amount)', () => {
    expect(parseScannedAddress(`ethereum:${LOWER}?value=1e18`)).toBe(CHECKSUMMED);
  });

  it('rejects a malformed value rather than guessing', () => {
    expect(parseScannedAddress('not an address')).toBeUndefined();
  });

  it('rejects an empty scan', () => {
    expect(parseScannedAddress('')).toBeUndefined();
    expect(parseScannedAddress('   ')).toBeUndefined();
  });

  it('rejects a QR that encodes something else entirely, e.g. a URL', () => {
    expect(parseScannedAddress('https://example.com')).toBeUndefined();
  });
});

describe('mapGetUserMediaError', () => {
  it('maps a refusal to permission-denied', () => {
    expect(mapGetUserMediaError('NotAllowedError')).toBe('permission-denied');
  });

  it('maps the older Safari name for the same refusal', () => {
    expect(mapGetUserMediaError('PermissionDeniedError')).toBe('permission-denied');
  });

  it('maps no camera hardware to camera-unavailable', () => {
    expect(mapGetUserMediaError('NotFoundError')).toBe('camera-unavailable');
  });

  it('maps a camera already in use to camera-unavailable', () => {
    expect(mapGetUserMediaError('NotReadableError')).toBe('camera-unavailable');
  });

  it('fails toward the more general, still-recoverable state for an unknown name', () => {
    expect(mapGetUserMediaError('SomeFutureError')).toBe('camera-unavailable');
  });
});

describe('handleScanEvent', () => {
  it('fills the recipient on a valid decoded address', () => {
    expect(handleScanEvent({ type: 'detected', raw: LOWER })).toEqual({
      kind: 'filled',
      address: CHECKSUMMED,
    });
  });

  it('ignores a decoded value that is not an address, so scanning continues', () => {
    expect(handleScanEvent({ type: 'detected', raw: 'https://example.com' })).toEqual({
      kind: 'ignored',
    });
  });

  it('turns a permission refusal into the camera-permission-denied error', () => {
    expect(handleScanEvent({ type: 'permission-denied' })).toEqual({
      kind: 'error',
      code: 'CAMERA_PERMISSION_DENIED',
    });
  });

  it('turns a camera failure into the camera-unavailable error', () => {
    expect(handleScanEvent({ type: 'camera-unavailable' })).toEqual({
      kind: 'error',
      code: 'CAMERA_UNAVAILABLE',
    });
  });
});
