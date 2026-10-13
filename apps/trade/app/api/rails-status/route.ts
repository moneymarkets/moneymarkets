import { NextResponse } from 'next/server';
import { route as runRouter, RAIL_EVIDENCE, type FundingRequest } from '@tradepro/core';
import { getAddress, type Address } from 'viem';
import { allRails } from '../../../lib/server/rails';
import { depositDb } from '../../../lib/server/deposits/db';

/**
 * `GET /api/rails-status` — what every rail is doing, right now.
 *
 * The status page renders this. It exists because "which rails work today" was only
 * answerable by reading a report somebody had typed, and those reports went stale within
 * a day twice: deBridge and Mayan were both written down as permanently unable to carry
 * Monad while they were quoting it, and Relay was described as having funded deposits it
 * says it never saw. A page that asks the vendors cannot go stale that way.
 *
 * ## What it will not publish
 *
 * This endpoint is reachable by anyone who can reach the app, so it carries **no user
 * data**. No recipient addresses, no deposit addresses, no transaction hashes belonging
 * to an account — the watcher section is counts only. Environment variables appear as
 * names with a configured yes/no, never values (rule A4).
 *
 * ## The reference quote
 *
 * Every rail is asked for the same thing — 5 USDC on Base to a fixed reference account —
 * so the answers are comparable and the page means the same thing each time. It is a
 * dry read: no address is issued and nothing is registered.
 *
 * `senderAddress` is set, which is what lets the wallet-signed rails answer at all. That
 * makes this a slightly optimistic view of the screen a user with no wallet sees, and the
 * `needsWallet` column is what carries that distinction.
 *
 * ## Cached for a minute
 *
 * A live read costs six vendor calls. Somebody refreshing the page should not turn into
 * a load test, and a minute-old number is still a true statement about today.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** The account every reference quote is priced for. Holds nothing; it is a shape. */
const REFERENCE_ACCOUNT = '0x714f169Fe2D3990961B534D573f9646c037586E6';

const REFERENCE: Omit<FundingRequest, 'recipient' | 'senderAddress'> = {
  sourceChain: { id: 8453, key: 'base', displayName: 'Base', vm: 'evm' },
  sourceAsset: {
    symbol: 'USDC',
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    decimals: 6,
  },
  amount: 5_000_000n,
  wantsMargin: false,
};

/** Server-only names whose presence the page reports. Values are never read here. */
const ENV_KEYS = [
  'RELAY_API_KEY',
  'RELAY_APP_FEE_RECIPIENT',
  'ACROSS_INTEGRATOR_ID',
  'DEBRIDGE_REFERRAL_CODE',
  'MAYAN_REFERRER',
  'ONE_CLICK_JWT',
  'NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID',
  'RELAYER_URL',
] as const;

interface Cached {
  at: number;
  body: unknown;
}
let cache: Cached | undefined;
const CACHE_MS = 60_000;

export async function GET() {
  if (cache && Date.now() - cache.at < CACHE_MS) {
    return NextResponse.json(cache.body, {
      headers: { 'cache-control': 'no-store', 'x-cache': 'hit' },
    });
  }

  const recipient = getAddress(REFERENCE_ACCOUNT) as Address;
  const req: FundingRequest = { ...REFERENCE, recipient, senderAddress: recipient };

  let live: Record<string, unknown>[] = [];
  let routerError: string | undefined;
  try {
    // A generous budget: this is a status page, not a user waiting on a price.
    const result = await runRouter(allRails(), req, 12_000);
    const quotes = [result.best, ...result.alternatives].filter(Boolean);
    live = [
      ...quotes.map((q) => ({
        rail: q!.rail,
        answering: true,
        amountOut: q!.amountOut.toString(),
        outToken: q!.outToken,
        etaSeconds: q!.etaSeconds,
        needsWallet: q!.needsWallet,
        executable: q!.executable,
        fees: q!.fees.map((f) => ({ label: f.label, amount: f.amount.toString(), token: f.token })),
      })),
      ...result.declines.map((d) => ({
        rail: d.rail,
        answering: true,
        declined: true,
        // The vendor's own sentence, unchanged. It is the most useful thing on the page
        // when a rail vanishes.
        reason: d.reason,
      })),
      ...result.silent.map((s) => ({
        rail: s.rail,
        answering: false,
        reason: s.reason,
      })),
    ];
  } catch (error) {
    routerError = error instanceof Error ? error.message.split('\n')[0] : String(error);
  }

  // Counts only. The rows behind these belong to accounts and are not published.
  let watcher: Record<string, number | string> = {};
  try {
    const db = depositDb();
    const active = db.active();
    watcher = {
      watching: active.length,
      byRail: Object.entries(
        active.reduce<Record<string, number>>((acc: Record<string, number>, a) => {
          const rail = a.rail ?? 'unknown';
          acc[rail] = (acc[rail] ?? 0) + 1;
          return acc;
        }, {}),
      )
        .map(([rail, n]) => `${rail}:${n}`)
        .join(' ') || 'none',
    };
  } catch (error) {
    const first = error instanceof Error ? error.message.split('\n')[0] : undefined;
    watcher = { error: first ?? 'unreadable' };
  }

  const body = {
    readAt: Date.now(),
    // The same value the footer shows, so the page and the footer agree.
    buildId: process.env.NEXT_PUBLIC_BUILD_ID ?? 'unknown',
    reference: {
      asset: REFERENCE.sourceAsset.symbol,
      chain: REFERENCE.sourceChain.displayName,
      amount: REFERENCE.amount.toString(),
      decimals: REFERENCE.sourceAsset.decimals,
    },
    live,
    ...(routerError ? { routerError } : {}),
    // The recorded evidence, shipped as data so the page and the reports cannot drift.
    evidence: RAIL_EVIDENCE,
    watcher,
    // Names and a boolean. Never a value, not even redacted (A4).
    env: ENV_KEYS.map((key) => ({ key, configured: Boolean(process.env[key]) })),
  };

  cache = { at: Date.now(), body };
  return NextResponse.json(body, {
    headers: { 'cache-control': 'no-store', 'x-cache': 'miss' },
  });
}
