'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * Light, dark, or whatever the device says (design §2.1).
 *
 * The tokens live in three layers in `tokens.css`: `:root` is light, a
 * `prefers-color-scheme` block is dark for anyone who has not chosen, and
 * `[data-theme]` is the explicit choice that beats both. So this provider's whole
 * job is to stamp one attribute and remember it.
 *
 * "System" is a real, storable choice and not the absence of one — a user who has
 * picked dark on this app and then switches their phone to light should get light,
 * only if they asked for system. That is why the stored value can be `'system'`
 * rather than the key simply being missing.
 */

export type ThemeChoice = 'system' | 'light' | 'dark';

export const THEME_STORAGE_KEY = 'tradepro.theme';

/**
 * Stamped into `<head>` so the first paint is already the right colour.
 *
 * Without it, a dark-mode user gets one mint-white frame before React hydrates,
 * which on a phone reads as a flash of the wrong app. It is a constant string, not
 * interpolated content, and it touches nothing but the root element's attribute.
 */
export const THEME_BOOTSTRAP = `(function(){try{var c=localStorage.getItem('${THEME_STORAGE_KEY}');if(c==='light'||c==='dark'){document.documentElement.setAttribute('data-theme',c);}}catch(e){}})();`;

interface ThemeValue {
  readonly choice: ThemeChoice;
  /** What is actually on screen once "system" is resolved. */
  readonly resolved: 'light' | 'dark';
  setChoice: (choice: ThemeChoice) => void;
}

const ThemeContext = createContext<ThemeValue | undefined>(undefined);

function systemPrefersDark(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoiceState] = useState<ThemeChoice>('system');
  const [systemDark, setSystemDark] = useState(false);

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    } catch {
      stored = null;
    }
    if (stored === 'light' || stored === 'dark' || stored === 'system') setChoiceState(stored);

    const query = window.matchMedia('(prefers-color-scheme: dark)');
    setSystemDark(query.matches);
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const setChoice = useCallback((next: ThemeChoice) => {
    setChoiceState(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage blocked. The choice holds for this tab and returns to system next visit.
    }
  }, []);

  const resolved: 'light' | 'dark' = choice === 'system' ? (systemDark ? 'dark' : 'light') : choice;

  useEffect(() => {
    const root = document.documentElement;
    if (choice === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', choice);
  }, [choice]);

  /**
   * PWA shell: the two static `<meta name="theme-color">` tags in `layout.tsx`
   * (one per `prefers-color-scheme`) answer the OS setting correctly at first
   * paint, but not an explicit Light/Dark choice made in this app's own Appearance
   * setting — a static `media` attribute cannot react to that. So once resolved,
   * both tags are kept in sync with the colour actually on screen; under
   * "System" that is still exactly what each tag's own media query would already
   * say, so this never disagrees with the first-paint value, it just keeps
   * answering correctly after the user picks an explicit theme.
   */
  useEffect(() => {
    const color = resolved === 'dark' ? '#0B1A14' : '#FFFFFF';
    document
      .querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')
      .forEach((meta) => meta.setAttribute('content', color));
  }, [resolved]);

  const value = useMemo<ThemeValue>(
    () => ({ choice, resolved, setChoice }),
    [choice, resolved, setChoice],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside ThemeProvider');
  return value;
}

export { systemPrefersDark };
