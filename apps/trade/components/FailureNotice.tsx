'use client';

import { Button, Notice } from '@tradepro/ui';
import { failureText, type Failure } from '../lib/failures';

/**
 * One failure, rendered the same way everywhere (task 3.6).
 *
 * The affordance is part of the failure, not part of the screen: a `requote`
 * recovery always gets a button, so a non-terminal state such as `QUOTE_EXPIRED`
 * cannot be drawn as a full stop by whichever screen happens to catch it.
 *
 * `detail` is drawn on its own line under the copy rather than folded into it. It
 * carries the thing only this moment knows — the route's minimum, or the upstream
 * network's own sentence about why it refused — and keeping it separate is what lets
 * the catalogue's copy stay under the design section 6 rules that `failures.test.ts`
 * enforces. It is third-party text: React escapes it, and nothing here renders it as
 * markup.
 */
export function FailureNotice({ failure, onRetry }: { failure: Failure; onRetry?: () => void }) {
  return (
    <div style={{ marginTop: 10 }}>
      <Notice tone={failure.tone}>
        <span>
          {failureText(failure)}
          {failure.detail ? (
            <span className="tiny muted" style={{ display: 'block', marginTop: 6 }}>
              {failure.detail}
            </span>
          ) : null}
        </span>
      </Notice>
      {failure.action && onRetry ? (
        <div style={{ marginTop: 10 }}>
          <Button variant="soft" size="sm" onClick={onRetry}>
            {failure.action}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
