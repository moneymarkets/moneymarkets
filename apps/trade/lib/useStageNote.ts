'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * A stage's note, shown only once that stage has run long enough to need one.
 *
 * The rule the owner asked for: if a stage takes more than two seconds, say what is
 * happening in one word underneath it. Under two seconds, say nothing — a label that
 * flickers on and off during a fast action is noise, and the pill already moved.
 *
 * Measured 2026-09-10, the stage that needs this is gas estimation: 864 ms at the
 * bundler plus the reads around it, comfortably over two seconds on a slow connection
 * and invisible before this. The timer restarts whenever the note changes, so a
 * submission that moves through several stages quickly never shows any of them.
 */
export function useStageNote(note: string | undefined, afterMs = 2000): string | undefined {
  const [shown, setShown] = useState<string | undefined>();
  const current = useRef<string | undefined>(undefined);

  useEffect(() => {
    current.current = note;
    if (!note) {
      setShown(undefined);
      return;
    }
    setShown(undefined);
    const id = window.setTimeout(() => {
      // Only if this is still the stage we started waiting on.
      if (current.current === note) setShown(note);
    }, afterMs);
    return () => window.clearTimeout(id);
  }, [note, afterMs]);

  return shown;
}
