'use client';

import Link from 'next/link';
import { useState } from 'react';
import { isAddress, type Address } from 'viem';
import { Button, Card, Field, Row } from '@tradepro/ui';
import { Chrome } from '../../../../components/Chrome';
import { SignedOut } from '../../../../components/SignedOut';
import { useSession } from '../../../../lib/session';
import { useAddressBook } from '../../../../lib/wallet/addressBook';
import { shortAddress } from '../../../../lib/format';
import { WALLET_SETTINGS_HREF } from '../../../../lib/wallet/routeHrefs';

/**
 * `/settings/wallet/address-book` — public addresses and labels, per account, in
 * the browser (spec §4.3, §4.6, §8). Send's "Recent recipients" reads the same
 * store (`lib/wallet/addressBook.ts`); nothing here is a private key or a signing
 * credential.
 */
export default function AddressBookPage() {
  const session = useSession();
  const account = session.account?.address;
  const book = useAddressBook(account);
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | undefined>();

  function add() {
    setError(undefined);
    if (!isAddress(address)) {
      setError('That is not a Monad address. Check for a typo.');
      return;
    }
    if (label.trim().length === 0) {
      setError('Give this address a label, so it is easy to tell apart later.');
      return;
    }
    book.add(address as Address, label.trim());
    setAddress('');
    setLabel('');
  }

  return (
    <Chrome>
      <div className="page">
        <Link href={WALLET_SETTINGS_HREF} className="back">
          ‹ Wallet settings
        </Link>
        <h1>Address book</h1>
        <p className="small">Public addresses and labels only, saved on this device</p>

        {session.status !== 'signed-in' || !account ? (
          <SignedOut />
        ) : (
          <>
            <Card title="Add an address" className="rise" style={{ animationDelay: '60ms' }}>
              <Field label="Label" id="ab-label" value={label} onChange={setLabel} />
              <div style={{ marginTop: 10 }}>
                <Field label="Address on Monad" id="ab-address" value={address} onChange={setAddress} />
              </div>
              {error ? (
                <p className="small" style={{ marginTop: 8, color: 'var(--down)' }}>
                  {error}
                </p>
              ) : null}
              <div style={{ marginTop: 12 }}>
                <Button variant="primary" onClick={add}>
                  Save
                </Button>
              </div>
            </Card>

            <Card
              title="Saved"
              action={<span className="small">{book.entries.length} saved</span>}
              className="rise"
              style={{ animationDelay: '100ms' }}
            >
              {book.entries.length === 0 ? (
                <p className="empty">Nothing saved yet. Addresses you add appear here and in Send.</p>
              ) : (
                <div className="list">
                  {book.entries.map((entry) => (
                    <Row
                      key={entry.address}
                      title={entry.label}
                      subtitle={shortAddress(entry.address)}
                      trailing={
                        <Button variant="ghost" size="sm" onClick={() => book.remove(entry.address)}>
                          Remove
                        </Button>
                      }
                    />
                  ))}
                </div>
              )}
            </Card>
          </>
        )}
      </div>
    </Chrome>
  );
}
