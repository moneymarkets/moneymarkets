'use client';

import type { Address } from 'viem';
import { Button, Notice } from '@tradepro/ui';
import { WALLETCONNECT_ABSENT_NOTE } from '../lib/wallet/walletconnect';
import type { SourceWallet } from '../lib/wallet/useSourceWallet';

/**
 * The two addresses, side by side, with no way to confuse them.
 *
 * **Sending from** is a wallet the user already had — MetaMask, Rabby, Phantom. It signs
 * on the source chain and it is where the money leaves.
 *
 * **Arriving in** is this app's account, the passkey one. It never signs on a source
 * chain, it holds nothing there, and it is fixed: the server sets the recipient and every
 * rail asserts it before it returns anything (R4). Nothing on this card can change it,
 * which is why it is shown as a fact rather than as a field.
 *
 * Showing them together is the point. A user handing a bridge an address wants to see
 * both ends of the trip on one line before they approve anything, and the failure this
 * prevents — signing from the account you meant to deliver to — is silent otherwise.
 */

/** Enough of each end to recognise, never the middle nobody reads. */
function short(address: string): string {
  return address.length <= 14 ? address : `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function SourceWalletCard({
  wallet,
  recipient,
  chainName,
  vm,
  chainIds,
}: {
  wallet: SourceWallet;
  recipient: Address;
  /** The chain the money is coming from, in the user's words. */
  chainName: string;
  vm: 'evm' | 'svm' | 'tvm' | 'btc';
  /** Chains a WalletConnect session should ask for. Ignored without a project id. */
  chainIds: readonly number[];
}) {
  const connected = wallet.state.status === 'evm' || wallet.state.status === 'solana';
  const connecting = wallet.state.status === 'connecting';

  return (
    <div style={{ marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
      <p className="small" style={{ margin: 0, fontWeight: 600 }}>
        Where it comes from, and where it lands
      </p>

      <div className="between" style={{ marginTop: 8, gap: 12 }}>
        <div>
          <div className="tiny muted">Sending from, on {chainName}</div>
          <div className="small num">
            {connected && wallet.address ? short(wallet.address) : 'Not connected'}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="tiny muted">Arriving in your account</div>
          <div className="small num">{short(recipient)}</div>
        </div>
      </div>

      <p className="tiny muted" style={{ marginTop: 6 }}>
        These are two different accounts on purpose. The one on the right is the account
        you signed in with; it holds nothing on {chainName} and never signs there. Nothing
        here can send your money anywhere but that account.
      </p>

      {connected ? (
        <div style={{ marginTop: 10 }}>
          <Button size="sm" variant="ghost" onClick={() => wallet.disconnect()}>
            Use a different wallet
          </Button>
        </div>
      ) : vm === 'svm' ? (
        <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {wallet.solanaChoices.length === 0 ? (
            <p className="tiny muted" style={{ margin: 0 }}>
              No Solana wallet was found in this browser. You can still paste the address
              you will send from.
            </p>
          ) : (
            wallet.solanaChoices.map((c) => (
              <Button
                key={c.id}
                size="sm"
                variant="soft"
                disabled={connecting}
                disabledLabel="Check your wallet"
                onClick={() => void wallet.connectSolana(c)}
              >
                {c.name}
              </Button>
            ))
          )}
        </div>
      ) : (
        <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {wallet.evmChoices.map((c) => (
            <Button
              key={c.id}
              size="sm"
              variant="soft"
              disabled={connecting}
              disabledLabel="Check your wallet"
              onClick={() => void wallet.connectEvm(c)}
            >
              {c.name}
            </Button>
          ))}
          {wallet.walletConnectOffered ? (
            <Button
              size="sm"
              variant="soft"
              disabled={connecting}
              disabledLabel="Check your wallet"
              onClick={() => void wallet.connectViaWalletConnect(chainIds)}
            >
              WalletConnect
            </Button>
          ) : null}
          {wallet.evmChoices.length === 0 ? (
            <p className="tiny muted" style={{ margin: 0 }}>
              No wallet was found in this browser.
            </p>
          ) : null}
        </div>
      )}

      {!connected && !wallet.walletConnectOffered && vm === 'evm' ? (
        <p className="tiny muted" style={{ marginTop: 8 }}>
          {WALLETCONNECT_ABSENT_NOTE}
        </p>
      ) : null}

      {wallet.error ? (
        <div style={{ marginTop: 10 }}>
          <Notice tone="warn">{wallet.error}</Notice>
        </div>
      ) : null}
    </div>
  );
}
