import Link from 'next/link';
import type { Metadata } from 'next';
import { Chrome } from '../../../components/Chrome';
import { FundScreen } from '../../fund/FundScreen';
import { WALLET_HOME_HREF } from '../../../lib/wallet/routeHrefs';

/**
 * `/wallet/receive` — Receive (wallet spec §4.2).
 *
 * "Mounts the existing Add money page as is, under a Back link and the Wallet
 * header." `FundScreen` is already a standalone, exported component — `/fund`'s own
 * route file is nothing but `<Chrome><FundScreen /></Chrome>` — so this mounts the
 * same component under its own Back link and header rather than duplicating any of
 * its logic, or redirecting away from the Wallet tab to a different one. `/fund`
 * itself is untouched: no file under `app/fund` changed in this pass, and it stays
 * in the main navigation exactly as it was (spec §1: "stays exactly as it is and
 * stays in the navigation").
 */
export const metadata: Metadata = { title: 'Receive — MoneyMarkets' };

export default function WalletReceivePage() {
  return (
    <Chrome>
      <div className="page" style={{ paddingBottom: 0 }}>
        <Link href={WALLET_HOME_HREF} className="back">
          ‹ Wallet
        </Link>
        <h1>Wallet</h1>
      </div>
      <FundScreen />
    </Chrome>
  );
}
