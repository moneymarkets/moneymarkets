'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button, Card } from '@tradepro/ui';
import { shouldOfferCrossDevice } from '@tradepro/core';
import { useSession } from '../lib/session';

/**
 * What a screen shows when nobody is unlocked in this tab.
 *
 * Only the passkey credential id survives a reload (rule A4), so after a refresh the
 * app knows someone has an account here but not which address it is. The honest
 * screen says so and offers the one action that fixes it.
 */
export function SignedOut() {
  const session = useSession();
  const [offerPhone, setOfferPhone] = useState(false);

  useEffect(() => {
    setOfferPhone(shouldOfferCrossDevice(navigator.userAgent));
  }, []);

  if (session.status === 'loading') {
    return (
      <Card title="Checking this device">
        <p className="small">One moment.</p>
      </Card>
    );
  }
  return (
    <Card title={session.status === 'returning' ? 'Sign in to continue' : 'Create your account'}>
      <p className="small" style={{ margin: '6px 0 12px' }}>
        {session.status === 'returning'
          ? 'Your passkey unlocks the account. Nothing about it is stored on this device.'
          : 'One Face ID and you have an account. Nothing to write down.'}
      </p>
      <div className="stack">
        <Button
          variant="primary"
          block
          disabled={session.busy}
          disabledLabel="Waiting for your passkey"
          onClick={() =>
            void (session.status === 'returning' ? session.authenticate() : session.create())
          }
        >
          {session.status === 'returning' ? 'Sign in with Face ID' : 'Create account with Face ID'}
        </Button>
        {offerPhone ? (
          <Button
            variant="ghost"
            block
            disabled={session.busy}
            disabledLabel="Waiting for your passkey"
            onClick={() =>
              void (session.status === 'returning'
                ? session.authenticate('phone')
                : session.create('phone'))
            }
          >
            {session.status === 'returning' ? 'Sign in with your phone' : 'Create with your phone'}
          </Button>
        ) : null}
        <Link href="/" style={{ textDecoration: 'none' }}>
          <Button variant="ghost" block>
            Back to the start
          </Button>
        </Link>
      </div>
      {session.error ? (
        <p className="small" style={{ marginTop: 10, color: 'var(--down)' }}>
          {session.error}
        </p>
      ) : null}
    </Card>
  );
}
