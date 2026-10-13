'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Chrome } from '../../../components/Chrome';
import { QrScanButton } from '../../../components/QrScanButton';
import { SignedOut } from '../../../components/SignedOut';
import { SendScreen } from '../../send/SendScreen';
import { useSession } from '../../../lib/session';
import { useAddressBook } from '../../../lib/wallet/addressBook';
import { recipientChipsFrom } from '../../../lib/wallet/sendRecipients';
import { WALLET_ADDRESS_BOOK_HREF, WALLET_HOME_HREF } from '../../../lib/wallet/routeHrefs';

/**
 * `/wallet/send` — Send, reached from the Wallet tab (wallet spec §2, §4.3).
 *
 * The existing `/send` screen carries every bit of the signing and submission
 * logic (`app/send/SendScreen.tsx`) and is mounted here unchanged, in its
 * `embedded` mode: this file supplies the `<Chrome>`, the Back link and the
 * heading, and `SendScreen` supplies everything from "From your wallet" down.
 * The two additions this route owns are the recent-recipients row
 * (`lib/wallet/addressBook.ts`, public addresses and labels only, browser-only,
 * per account) and the QR scan button (`components/QrScanButton.tsx`, hidden
 * entirely on a device that cannot scan) — both fill the same controlled
 * `recipient` field `SendScreen` already runs its address, contract and
 * confirmation checks against, so a tapped chip or a scanned code gets exactly
 * the same review step as anything typed by hand.
 */
export default function WalletSendPage() {
  const session = useSession();
  const account = session.account?.address;
  const book = useAddressBook(account);
  const [recipient, setRecipient] = useState('');
  const chips = recipientChipsFrom(book.entries);

  return (
    <Chrome>
      <div className="page">
        <Link href={WALLET_HOME_HREF} className="back">
          ‹ Wallet
        </Link>
        <div className="between" style={{ paddingTop: 6 }}>
          <div>
            <h1>Send</h1>
            <p className="small">From your wallet on Monad, to any address</p>
          </div>
        </div>

        {session.status !== 'signed-in' || !account ? (
          <SignedOut />
        ) : (
          <SendScreen
            embedded
            recipient={recipient}
            onRecipientChange={setRecipient}
            recipientTrailing={<QrScanButton onScanned={(address) => setRecipient(address)} />}
            aboveFields={
              <>
                <p className="small" style={{ marginBottom: 6 }}>
                  Recent recipients
                </p>
                <div className="recips">
                  {chips.map((chip) => (
                    <button
                      key={chip.address}
                      type="button"
                      onClick={() => setRecipient(chip.address)}
                    >
                      <span className="coin" style={{ background: 'var(--surface-2)', color: 'var(--ink-2)' }} aria-hidden="true">
                        {chip.initials}
                      </span>
                      {chip.label}
                    </button>
                  ))}
                  <Link href={WALLET_ADDRESS_BOOK_HREF}>
                    <span className="coin" style={{ background: 'var(--accent)', color: '#fff' }} aria-hidden="true">
                      +
                    </span>
                    New
                  </Link>
                </div>
              </>
            }
          />
        )}
      </div>
    </Chrome>
  );
}
