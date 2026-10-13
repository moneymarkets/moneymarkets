'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Notice, Passkey, Sheet, type PasskeyState } from '@tradepro/ui';
import { shouldOfferCrossDevice } from '@tradepro/core';
import { PRF_UNAVAILABLE_MESSAGE, useSession } from '../lib/session';

/**
 * `/` — onboard and sign in (spec §6.1, design §5.1).
 *
 * Three states, all reachable: **new** (no credential on this device), **returning**
 * (a credential exists, so the primary action is to sign in), and the
 * **PRF_UNAVAILABLE** fallback, which names the providers that work instead of saying
 * something went wrong.
 *
 * On a desktop, "Use your phone instead" is a first-class button rather than advice
 * in an error. Windows Chrome's local passkey store does not evaluate the WebAuthn
 * PRF extension, so the default button on this machine leads to a dead end every
 * time; the phone is the working path and is offered before anything has failed. Once
 * a PRF failure has actually happened it becomes the primary action.
 *
 * ## The multi-account guard
 *
 * A device with a passkey already on it defaults to signing in — that is `returning`
 * above, unchanged. What changed is the way out of it: creating a second, unrelated
 * account is not a recovery path from a stuck sign-in, so it is never the default
 * action, is worded for what it actually does, and asks once before it does it. A
 * mis-tap here does not just retry a sign-in — it produces a real second account with
 * its own empty balance, which is worth one confirmation to avoid.
 */
export default function OnboardPage() {
  const session = useSession();
  const router = useRouter();
  const [done, setDone] = useState<string | undefined>();
  const [previewFallback, setPreviewFallback] = useState(false);
  // Read after mount: the server has no user agent and must not guess one.
  const [offerPhone, setOfferPhone] = useState(false);
  const [confirmNewAccount, setConfirmNewAccount] = useState(false);

  useEffect(() => {
    setOfferPhone(shouldOfferCrossDevice(navigator.userAgent));
  }, []);

  useEffect(() => {
    if (session.status !== 'signed-in') return;
    setDone(session.credentialId ? 'Signed in' : 'Account ready');
    const id = window.setTimeout(() => router.push('/home'), 900);
    return () => window.clearTimeout(id);
  }, [session.status, session.credentialId, router]);

  const passkeyState: PasskeyState = session.busy
    ? 'pulsing'
    : session.status === 'signed-in'
      ? 'done'
      : 'idle';

  const returning = session.status === 'returning';
  const loading = session.status === 'loading';
  const prfFailed = session.failure === 'PRF_UNAVAILABLE';
  const shownError = previewFallback ? PRF_UNAVAILABLE_MESSAGE : session.error;
  // After a PRF failure the phone is the only thing that can work here, so it leads.
  const phoneLeads = offerPhone && (prfFailed || previewFallback);
  const waiting = loading || session.busy;

  const phoneButton = offerPhone ? (
    <Button
      variant={phoneLeads ? 'primary' : 'ghost'}
      block
      disabled={waiting}
      disabledLabel={loading ? 'Checking this device' : 'Waiting for your passkey'}
      onClick={() => void (returning ? session.authenticate('phone') : session.create('phone'))}
    >
      {returning ? 'Sign in with your phone' : 'Create with your phone'}
    </Button>
  ) : null;

  const localButton = (
    <Button
      variant={phoneLeads ? 'ghost' : 'primary'}
      block
      disabled={waiting}
      disabledLabel={loading ? 'Checking this device' : 'Waiting for your passkey'}
      onClick={() => void (returning ? session.authenticate() : session.create())}
    >
      {returning ? 'Sign in with Face ID' : 'Create account with Face ID'}
    </Button>
  );

  return (
    <main className="onboard">
      <div className="wordmark">MoneyMarkets</div>

      <div>
        <h1>
          Your dollars.
          <br />
          Trading on Monad.
          <br />
          No gas, no seed phrase.
        </h1>
        <p style={{ marginTop: 14, maxWidth: '34ch' }}>
          Create an account with the same Face ID you use to unlock your phone. We pay the network
          fees.
        </p>

        <Passkey state={passkeyState} />

        <div style={{ marginTop: 4 }}>
          {done ? (
            <Notice tone="ok">{done}. Nothing to write down — your passkey is the account.</Notice>
          ) : null}
          {shownError && !done ? <Notice tone="err">{shownError}</Notice> : null}
          {session.busy ? (
            <p className="small muted" style={{ marginTop: 8 }} aria-live="polite">
              Waiting for your passkey…
            </p>
          ) : null}
        </div>
      </div>

      <div className="stack">
        {phoneLeads ? phoneButton : localButton}
        {phoneLeads ? localButton : phoneButton}
        {offerPhone ? (
          <p className="tiny muted" style={{ textAlign: 'center' }}>
            Your phone shows a code to scan. The passkey stays on the phone.
          </p>
        ) : null}
        <Button
          variant="ghost"
          block
          disabled={waiting}
          disabledLabel="Waiting for your passkey"
          onClick={() => (returning ? setConfirmNewAccount(true) : void session.authenticate())}
        >
          {returning ? 'Create another account' : 'I already have an account'}
        </Button>
        <button
          type="button"
          className="tiny muted"
          style={{ textAlign: 'center', padding: 6 }}
          aria-pressed={previewFallback}
          onClick={() => setPreviewFallback((v) => !v)}
        >
          Preview: passkey provider without PRF
        </button>
      </div>

      <Sheet open={confirmNewAccount} onClose={() => setConfirmNewAccount(false)}>
        <h3>Create another account?</h3>
        <p className="small" style={{ margin: '6px 0 14px' }}>
          This creates a new, separate account with its own balances. It does not sign you out of
          the account you already have — both stay on this device, and Settings can switch between
          them.
        </p>
        <div className="stack">
          <Button
            variant="primary"
            block
            disabled={waiting}
            disabledLabel="Waiting for your passkey"
            onClick={() => {
              setConfirmNewAccount(false);
              void session.create();
            }}
          >
            Create account with Face ID
          </Button>
          <Button variant="ghost" block onClick={() => setConfirmNewAccount(false)}>
            Cancel
          </Button>
        </div>
      </Sheet>
    </main>
  );
}
