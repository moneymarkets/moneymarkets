'use client';

import { useEffect, useRef, useState } from 'react';
import type { Address } from 'viem';
import { Button, Sheet } from '@tradepro/ui';
import { FailureNotice } from './FailureNotice';
import { failure } from '../lib/failures';
import {
  barcodeDetectorSupported,
  handleScanEvent,
  mapGetUserMediaError,
} from '../lib/wallet/qrScan';

/**
 * Send's QR scan button (wallet spec §4.3).
 *
 * `'BarcodeDetector' in window` decides whether this renders at all — **hidden**,
 * never disabled, exactly as the spec words it: a greyed-out scan button on a
 * browser that can never scan promises a capability that does not exist here.
 * The gate itself (`barcodeDetectorSupported`) and the decode/validate logic
 * (`parseScannedAddress`, reused from `SendScreen.tsx`'s own address check) live
 * in `lib/wallet/qrScan.ts` and are unit tested there; opening a camera and
 * running a native `BarcodeDetector` against a `<video>` element needs a real
 * browser, which this app's DOM-free test environment deliberately does not
 * provide (`apps/trade/vitest.config.ts`), so that plumbing lives here and is
 * exercised by hand.
 *
 * The camera is requested only on tap, never on mount or on the field gaining
 * focus — nothing here asks for a device permission the user did not just ask
 * for.
 */
export function QrScanButton({ onScanned }: { onScanned: (address: Address) => void }) {
  const [open, setOpen] = useState(false);
  const [errorCode, setErrorCode] = useState<
    'CAMERA_PERMISSION_DENIED' | 'CAMERA_UNAVAILABLE' | undefined
  >();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | undefined>(undefined);
  const scanningRef = useRef(false);

  function stop() {
    scanningRef.current = false;
    if (rafRef.current !== undefined) cancelAnimationFrame(rafRef.current);
    rafRef.current = undefined;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }

  // Belt and braces: a tab closed or navigated away from mid-scan still frees
  // the camera, not just an explicit Cancel.
  useEffect(() => stop, []);

  async function start() {
    setErrorCode(undefined);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) {
        stop();
        return;
      }
      video.srcObject = stream;
      await video.play();

      const BarcodeDetectorCtor = (
        window as unknown as {
          BarcodeDetector: new (options: {
            formats: string[];
          }) => { detect: (source: HTMLVideoElement) => Promise<{ rawValue: string }[]> };
        }
      ).BarcodeDetector;
      const detector = new BarcodeDetectorCtor({ formats: ['qr_code'] });
      scanningRef.current = true;

      const tick = async () => {
        if (!scanningRef.current || !videoRef.current) return;
        try {
          const codes = await detector.detect(videoRef.current);
          const raw = codes[0]?.rawValue;
          if (raw !== undefined) {
            const outcome = handleScanEvent({ type: 'detected', raw });
            if (outcome.kind === 'filled') {
              onScanned(outcome.address);
              setOpen(false);
              stop();
              return;
            }
            // Ignored: whatever this QR code says, it is not an address. Keep
            // pointing the camera and keep scanning rather than stopping on it.
          }
        } catch {
          // A single failed detect() call on one frame is not a reason to stop.
        }
        if (scanningRef.current) rafRef.current = requestAnimationFrame(() => void tick());
      };
      rafRef.current = requestAnimationFrame(() => void tick());
    } catch (err) {
      const name = err instanceof DOMException ? err.name : 'Unknown';
      const outcome = handleScanEvent({ type: mapGetUserMediaError(name) });
      if (outcome.kind === 'error') setErrorCode(outcome.code);
    }
  }

  if (!barcodeDetectorSupported()) return null;

  return (
    <>
      <button
        type="button"
        className="chip"
        aria-label="Scan a QR code for the recipient address"
        style={{ minWidth: 44, minHeight: 44, justifyContent: 'center' }}
        onClick={() => {
          setOpen(true);
          void start();
        }}
      >
        <ScanIcon />
      </button>
      <Sheet
        open={open}
        onClose={() => {
          setOpen(false);
          stop();
        }}
        labelledBy="qr-scan-heading"
      >
        <h3 id="qr-scan-heading">Scan a QR code</h3>
        <p className="small" style={{ margin: '4px 0 12px' }}>
          Point the camera at a Monad address QR code.
        </p>
        {errorCode ? (
          <FailureNotice failure={failure(errorCode)} onRetry={() => void start()} />
        ) : (
          <video
            ref={videoRef}
            playsInline
            muted
            aria-label="Camera preview"
            style={{ width: '100%', borderRadius: 12, background: 'var(--surface-2)', display: 'block' }}
          />
        )}
        <div style={{ marginTop: 12 }}>
          <Button
            variant="ghost"
            block
            onClick={() => {
              setOpen(false);
              stop();
            }}
          >
            Cancel
          </Button>
        </div>
      </Sheet>
    </>
  );
}

function ScanIcon() {
  return (
    <svg className="i" viewBox="0 0 24 24" aria-hidden="true" style={{ width: 18, height: 18 }}>
      <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
      <path d="M7 12h10" />
    </svg>
  );
}
