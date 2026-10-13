import type { Metadata } from 'next';
import { Chrome } from '../../components/Chrome';
import { FundScreen } from './FundScreen';
import './fund.css';

/** `/fund` — Add money (design §5.3). */
export const metadata: Metadata = { title: 'Add money — MoneyMarkets' };

export default function FundPage() {
  return (
    <Chrome>
      <FundScreen />
    </Chrome>
  );
}
