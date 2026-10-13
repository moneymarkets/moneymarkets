'use client';

import { useCallback, useEffect, useState } from 'react';
import { InstallBanner } from '@tradepro/ui';

/**
 * "Add to home screen".
 *
 * The worker that makes an install worth having is registered separately, in the
 * root layout, so that a signed-out visitor gets one too. This is only the offer.
 *
 * Chromium fires `beforeinstallprompt` when the app qualifies — manifest, icons,
 * service worker, https — and hands over a prompt that can be shown once. Safari
 * fires nothing and has no API: iOS installs happen through the share sheet. So the
 * banner has two shapes, and the one that says "tap Share, then Add to Home Screen"
 * is only shown to a browser that really works that way. Neither is shown to a
 * window that is already installed, which is what the `standalone` check is for.
 */

const DISMISSED_KEY = 'tradepro.installBannerDismissed';

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function InstallPrompt({ onMessage }: { onMessage: (message: string) => void }) {
  const [prompt, setPrompt] = useState<InstallPromptEvent | undefined>();
  const [dismissed, setDismissed] = useState(true);
  const [installed, setInstalled] = useState(true);
  const [iosShare, setIosShare] = useState(false);

  useEffect(() => {
    try {
      setDismissed(window.localStorage.getItem(DISMISSED_KEY) === 'true');
    } catch {
      setDismissed(true);
    }

    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      // iOS reports its own flag rather than the media query.
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    setInstalled(standalone);

    const ua = navigator.userAgent;
    // Safari on iOS or iPadOS: no install API, so the instruction is the offer.
    setIosShare(/iPad|iPhone|iPod/.test(ua) && /Safari/.test(ua) && !/CriOS|FxiOS/.test(ua));

    const onBeforeInstall = (event: Event) => {
      event.preventDefault();
      setPrompt(event as InstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      onMessage('Added to your home screen');
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, [onMessage]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      window.localStorage.setItem(DISMISSED_KEY, 'true');
    } catch {
      // Storage blocked; the banner returns next visit.
    }
  }, []);

  const add = useCallback(() => {
    if (prompt) {
      void prompt.prompt().then(() => setPrompt(undefined));
      return;
    }
    // No install API here. Say exactly which control does it rather than "use your
    // browser's menu" (design §6: state the fact and the fix).
    onMessage(
      iosShare ? 'Tap Share, then Add to Home Screen' : 'Use your browser’s Install app menu',
    );
    dismiss();
  }, [prompt, iosShare, onMessage, dismiss]);

  if (installed || dismissed) return null;
  return <InstallBanner onAdd={add} onDismiss={dismiss} />;
}
