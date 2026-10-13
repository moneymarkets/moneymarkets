import type { Metadata } from 'next';
import { MARKETS, marketFor } from '../../../lib/markets';
import { TradeScreen } from './TradeScreen';
import { Chrome } from '../../../components/Chrome';
import { Card, Empty } from '@tradepro/ui';

/**
 * `/trade/[market]` — book, ticket, open orders (spec 6.1, design 5.4).
 *
 * The market comes from the URL and is checked against the catalogue. Nothing in the
 * screen names a market, so the same code runs on MON/USDC today and on MON/AUSD as
 * soon as that book is seeded.
 */

export function generateStaticParams() {
  return MARKETS.map((market) => ({ market: market.key }));
}

export const metadata: Metadata = { title: 'Trade — MoneyMarkets' };

export default async function TradePage({ params }: { params: Promise<{ market: string }> }) {
  const { market } = await params;
  const config = marketFor(market);

  if (!config) {
    return (
      <Chrome>
        <div className="page">
          <h2 style={{ paddingTop: 6 }}>Market not found</h2>
          <Card title="That market is not in this deployment">
            <Empty>
              Pick one from Home. Markets are configured for this build; nothing is traded against
              an address the app cannot verify on chain.
            </Empty>
          </Card>
        </div>
      </Chrome>
    );
  }

  return (
    <Chrome>
      <TradeScreen market={config} />
    </Chrome>
  );
}
