'use client';

import { useEffect, useState } from 'react';
import { Button, Card, Chip, Notice, Passkey, Row, type PasskeyState } from '@tradepro/ui';
import {
  createAccount,
  CREDENTIAL_STORAGE_KEY,
  KURU_FORWARDER_DOMAIN,
  signIn,
  type MeraAccount,
} from '@tradepro/core';

/**
 * `/dev/mera` — the Phase 0 demo the owner tests on real devices (task 0.7, 0.16).
 *
 * It does three things and reports what happened: create a passkey account, sign in
 * again to the same address, and sign an EIP-712 message with no further prompt.
 * That last one is the evidence for open item 14 — if a signature appears without a
 * biometric, Mera's signing session covers typed data.
 *
 * Devices to record in `docs/devices.md`: iPhone (iCloud Keychain), Android (Google
 * Password Manager), desktop Chrome with Google PM, desktop Safari. A local Chrome
 * profile passkey fails with `PRF_UNAVAILABLE`; that is the expected result, not a
 * bug, and the copy below says so.
 */

import { messageForSignInError, resolveRpId } from '../../../lib/session';

export default function MeraDemoPage() {
  // Resolved after mount: the server has no host, and the answer here is the one the
  // browser will actually use.
  const [rpId, setRpId] = useState('localhost');
  const [account, setAccount] = useState<MeraAccount | undefined>();
  const [state, setState] = useState<PasskeyState>('idle');
  const [error, setError] = useState<string | undefined>();
  const [signature, setSignature] = useState<string | undefined>();
  const [savedCredential, setSavedCredential] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setSavedCredential(window.localStorage.getItem(CREDENTIAL_STORAGE_KEY));
    setRpId(resolveRpId(process.env.NEXT_PUBLIC_RP_ID, location.hostname));
  }, []);

  async function run(action: 'create' | 'signIn') {
    setBusy(true);
    setState('pulsing');
    setError(undefined);
    setSignature(undefined);
    try {
      const result =
        action === 'create'
          ? await createAccount({ rp: { id: rpId, name: 'MoneyMarkets' } })
          : await signIn({
              rpId,
              ...(savedCredential ? { credentialId: savedCredential } : {}),
            });
      window.localStorage.setItem(CREDENTIAL_STORAGE_KEY, result.credentialId);
      setSavedCredential(result.credentialId);
      setAccount(result);
      setState('done');
    } catch (caught) {
      setState('idle');
      setError(messageForSignInError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function signTypedData() {
    if (!account) return;
    setBusy(true);
    setError(undefined);
    try {
      // The same shape a real ForwardRequest signature takes. If this returns without
      // a second biometric prompt, sessions cover EIP-712.
      const result = await account.account.signTypedData({
        domain: KURU_FORWARDER_DOMAIN,
        types: {
          Probe: [
            { name: 'from', type: 'address' },
            { name: 'nonce', type: 'uint256' },
          ],
        },
        primaryType: 'Probe',
        message: { from: account.address, nonce: 0n },
      });
      setSignature(result);
    } catch (caught) {
      setError(messageForSignInError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <div className="between" style={{ paddingTop: 16 }}>
        <h1>Passkey account</h1>
        <Chip tone="acc">rpId {rpId}</Chip>
      </div>
      <p>
        Create an account with the same Face ID you use to unlock your phone. Nothing is deployed
        and there is no seed phrase to write down.
      </p>

      <Card>
        <Passkey state={state} />
        <div className="grid2" style={{ marginTop: 10 }}>
          <Button variant="primary" onClick={() => void run('create')} disabled={busy}>
            Create account
          </Button>
          <Button variant="ghost" onClick={() => void run('signIn')} disabled={busy}>
            I already have an account
          </Button>
        </div>
        {error ? (
          <div style={{ marginTop: 12 }}>
            <Notice tone="err">{error}</Notice>
          </div>
        ) : null}
      </Card>

      {account ? (
        <Card title="Your account">
          <div className="list" style={{ marginTop: 6 }}>
            <Row title="Address" subtitle={account.address} />
            <Row title="Credential" subtitle={account.credentialId} />
            <Row
              title="Signing without a prompt"
              subtitle={
                signature
                  ? 'A typed-data signature was produced.'
                  : 'Sign a typed message and watch whether a biometric is requested.'
              }
              trailing={
                <Button size="sm" onClick={() => void signTypedData()} disabled={busy}>
                  Sign
                </Button>
              }
            />
          </div>
          {signature ? (
            <div style={{ marginTop: 12 }}>
              <Notice tone="ok">
                Typed data signed. If no biometric prompt appeared, open item 14 is answered on this
                device.
              </Notice>
              <p className="tiny muted" style={{ marginTop: 8, wordBreak: 'break-all' }}>
                {signature.slice(0, 20)}…{signature.slice(-8)}
              </p>
            </div>
          ) : null}
        </Card>
      ) : null}

      <Card title="What to record">
        <p className="small" style={{ marginTop: 6 }}>
          For each device: the passkey provider, whether the account was created, whether signing in
          returned the same address, and whether signing typed data asked for a biometric. Those
          four answers go in `docs/devices.md`.
        </p>
      </Card>
    </main>
  );
}
