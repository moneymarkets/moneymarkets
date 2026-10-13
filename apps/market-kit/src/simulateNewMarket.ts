import { getAddress, toHex, type Address } from 'viem';
import type { KitConfig } from './config.js';
import type { HypotheticalMarket } from './hypothetical.js';
import type { Ladder } from './ladder.js';
import type { PlannedCall } from './plan.js';
import { marginAccountBalanceSlot, simulateBundle } from './send.js';

/**
 * Simulate the market into existence, then provision the ladder on it.
 *
 * `eth_call` to a CREATE2 address with no code returns empty **success**, so a plain
 * simulation of a not-yet-deployed market prints "ok" for a ladder the venue has never
 * seen — which is worse than printing nothing. `eth_simulateV1` does the honest thing:
 * `Router.deployProxy` runs first in a simulated block against live chain state, and
 * the ladder is provisioned on the OrderBook that deploy actually created. Every check
 * the venue performs runs for real — the `_type`/native-side agreement, the precision
 * and tick rules, `minSize` and `maxSize`, price ordering, and the provisioning guard.
 *
 * The approvals and deposits are deliberately **not** in the bundle. Including them
 * would mean overriding two ERC-20 balance slots whose storage layouts nobody here has
 * read, and rule A2.5 does not allow guessing one. The MarginAccount's `balances` slot
 * has been read and confirmed on chain, so the ladder's collateral is placed there
 * directly — the same override `simulateProvisionFunded` uses on a live market.
 *
 * Nothing is sent. `eth_simulateV1` cannot send.
 */
export interface NewMarketSimulation {
  readonly text: string;
  /** False if either step reverted — the caller's signal to exit nonzero (High #22). */
  readonly ok: boolean;
}

export async function renderNewMarketSimulation(
  config: KitConfig,
  view: HypotheticalMarket,
  ladder: Ladder,
  provision: PlannedCall,
  marginAccount: Address,
): Promise<NewMarketSimulation> {
  const stateDiff: Record<`0x${string}`, `0x${string}`> = {};
  const funding = [
    { token: view.quote.address, amount: ladder.totalQuote, symbol: view.quote.symbol },
    { token: view.base.address, amount: ladder.totalBase, symbol: view.base.symbol },
  ];
  for (const { token, amount } of funding) {
    if (amount > 0n) {
      stateDiff[marginAccountBalanceSlot(config.from, token)] = toHex(amount, { size: 32 });
    }
  }

  const results = await simulateBundle(
    config.client,
    config.from,
    [
      {
        label: view.deployCall.label,
        to: view.deployCall.to,
        data: view.deployCall.data,
        value: 0n,
      },
      { label: provision.label, to: provision.to, data: provision.data, value: provision.value },
    ],
    // 1000 MON of headroom so `validation: true` — which Monad's RPC insists on — has
    // gas to charge for. It is an override, not a balance: nothing is funded.
    [
      { address: config.from, balance: 10n ** 21n },
      { address: marginAccount, stateDiff },
    ],
  );

  const deployed = results[0];
  const provisioned = results[1];
  const created =
    deployed?.ok && deployed.returnData.length >= 42
      ? getAddress(`0x${deployed.returnData.slice(-40)}`)
      : undefined;

  const addressLine = created
    ? created === view.address
      ? `        created ${created} — the address computeAddress() predicted`
      : `        created ${created} — WHICH IS NOT the predicted ${view.address}`
    : '        no market address returned';

  const text = [
    `  [1] ${deployed?.ok ? 'ok      ' : 'REVERTED'} ${view.deployCall.label}` +
      (deployed?.reason ? `\n        ${deployed.reason}` : ''),
    addressLine,
    `  [2] ${provisioned?.ok ? 'ACCEPTED' : `REJECTED — ${provisioned?.reason ?? 'unknown'}`}` +
      `  ${provision.label}`,
    '',
    '  One eth_simulateV1 block against live chain state. deployProxy runs first and the',
    '  ladder is provisioned on the OrderBook that deploy created, so PriceError,',
    '  TickSizeError, SizeError, PostOnlyError and ProvisionError would all have surfaced',
    '  here. The operator was given no tokens: only the MarginAccount balances the ladder',
    '  needs were written into the slot this repo has read and confirmed —',
    '  ' +
      funding
        .filter((f) => f.amount > 0n)
        .map((f) => `${f.amount} ${f.symbol}`)
        .join(' and ') +
      ', in base units.',
    '  Nothing was sent: eth_simulateV1 cannot send.',
  ].join('\n');

  return { text, ok: Boolean(deployed?.ok) && Boolean(provisioned?.ok) };
}
