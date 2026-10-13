import { NextResponse } from 'next/server';
import {
  buildDeposit,
  LIVE_MARKET_ALLOWLIST,
  PROTOCOL_PAUSED_SELECTOR,
} from '@tradepro/core';
import type { Address } from 'viem';
import { addresses, chainMode, liveEnabled, readClient } from '../../../lib/server/chain';
import { readDisabledMarkets, readVenueState } from '../../../lib/server/venueState';

/**
 * What state is this deployment actually in?
 *
 * The footer shows this on every screen, because "is it armed" was previously only
 * answerable by reading a log, and the one time it mattered the browser was running a
 * bundle built before the fix and nobody could tell by looking.
 *
 * Three things, all read fresh:
 *
 *   `live`     the **server-side** mode gate — the only gate there is now
 *   `buildId`  which bundle the server is serving
 *   `paused`   whether Kuru's MarginAccount is refusing deposits and orders
 *
 * `paused` is a real `eth_call`, not a cached flag. On 2026-09-03 every deposit and
 * order reverted `0x44279255 ProtocolPaused` and the app had no way to say so — it
 * blamed itself and said "simulated mode". A venue that is down is the venue's fact
 * and the screen should name it.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  const chain = addresses();
  const marginAccount = chain.kuru.marginAccount as Address | undefined;

  // Two probes, because they can differ: the OrderBook calls into MarginAccount, so a
  // MarginAccount pause blocks orders too — but a book could be halted on its own, and
  // "everything is paused" and "deposits are paused" are different things to tell
  // somebody holding money.
  let marginPaused: boolean | null = null;
  let ordersPaused: boolean | null = null;

  if (marginAccount) {
    const probe = buildDeposit(
      marginAccount,
      PROBE_ACCOUNT,
      chain.tokens.AUSD.address as Address,
      1n,
    );
    marginPaused = await revertsWithPause(probe.to, probe.data);
  }

  // Every allowlisted market, read on its own. This used to probe
  // `LIVE_MARKET_ALLOWLIST[0]` alone and report its answer as the venue's — it said
  // "clear" on 2026-09-09 while AUSD/USDC and WBTC/AUSD were both paused. One market's
  // health was never four markets' health, and after the allowlist widening it is not
  // even close.
  const markets = await Promise.all(
    LIVE_MARKET_ALLOWLIST.map(async (address) => {
      const venue = await readVenueState(address);
      return {
        market: address,
        state: venue?.state ?? 'unknown',
        ...(venue?.reason ? { reason: venue.reason } : {}),
        // Kuru's own fees, read from this book rather than stated in our copy.
        ...(venue?.takerFeeBps === undefined ? {} : { takerFeeBps: venue.takerFeeBps }),
        ...(venue?.makerFeeBps === undefined ? {} : { makerFeeBps: venue.makerFeeBps }),
        // Kuru's own answer to the probe, so the screen can show what was said rather
        // than only our classification of it (item 1c).
        ...(venue?.probeSelector === undefined ? {} : { probeSelector: venue.probeSelector }),
        ...(venue?.probeError === undefined ? {} : { probeError: venue.probeError }),
        ...(venue?.probeCall === undefined ? {} : { probeCall: venue.probeCall }),
      };
    }),
  );

  // MON/AUSD and AUSD/USDC: shown, never traded, so they are not in
  // `LIVE_MARKET_ALLOWLIST` and never appear in `markets` above. The picker and the
  // Home markets list still need to say something honest about them — Kuru still
  // lists both, so neither is "not listed" — and that answer can only be read
  // server-side, the same as everything else on this route.
  const disabledMarkets = await readDisabledMarkets();

  // `ordersPaused` is kept for the footer's existing shape, and now means what it
  // says across the whole allowlist rather than for one market: true only when every
  // market refuses, null while nothing could be established.
  const known = markets.filter((m) => m.state !== 'unknown');
  ordersPaused =
    known.length === 0 ? null : known.every((m) => m.state === 'paused') ? true : false;

  const kuru =
    marginPaused === null && ordersPaused === null
      ? 'unknown'
      : marginPaused && ordersPaused
        ? 'all-paused'
        : marginPaused
          ? 'margin-paused'
          : ordersPaused
            ? 'orders-paused'
            : 'clear';

  return NextResponse.json(
    {
      live: liveEnabled(),
      buildId: process.env.NEXT_PUBLIC_BUILD_ID ?? 'unknown',
      /** Per-market state. `kuru`/`ordersPaused` summarise these; this is the detail. */
      markets,
      /** MON/AUSD and AUSD/USDC — shown, not traded. See `getDisabledMarkets` in `@tradepro/core`. */
      disabledMarkets,
      chain: chainMode(),
      chainId: chain.chainId,
      // `paused` is kept for callers that only care whether money can move at all.
      paused: marginPaused,
      marginPaused,
      ordersPaused,
      kuru,
      readAt: Date.now(),
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}

/** Dig the 4-byte revert selector out of whatever viem threw. */
function findRevertSelector(error: unknown): string | undefined {
  let node: unknown = error;
  for (let depth = 0; depth < 8 && node; depth += 1) {
    const data = (node as { data?: unknown }).data;
    if (typeof data === 'string' && data.startsWith('0x')) return data.slice(0, 10);
    node = (node as { cause?: unknown }).cause;
  }
  // Last resort: the message usually carries it verbatim.
  const text = error instanceof Error ? `${error.message}` : String(error);
  return /0x[0-9a-fA-F]{8}/.exec(text)?.[0];
}

const PROBE_ACCOUNT = '0x0000000000000000000000000000000000000001' as Address;

/**
 * Does this call revert with Kuru's pause?
 *
 * `null` means the question could not be answered — an RPC failure is not evidence
 * that the venue is healthy, and must not be rendered as "clear".
 *
 * A revert for any other reason means the contract is answering, which is what "not
 * paused" means here: the probe account holds nothing, so a balance or size revert is
 * the expected healthy reply.
 */
async function revertsWithPause(to: Address, data: `0x${string}`): Promise<boolean | null> {
  try {
    await readClient().call({ to, data, account: PROBE_ACCOUNT });
    return false;
  } catch (error) {
    const selector = findRevertSelector(error);
    if (selector === undefined) return null;
    return selector === PROTOCOL_PAUSED_SELECTOR;
  }
}
