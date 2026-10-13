import { isQuote, type Decline, type FundingRequest, type Quote, type Rail } from './types.js';

/**
 * Ask every rail that can carry this request, and rank what comes back.
 *
 * ## Why every rail is asked, not just the preferred one
 *
 * A route table can say which rails *could* carry a request. It cannot say which one
 * will be cheapest today, or which one is refusing right now — on 2026-09-09 the
 * previously-primary rail refused every amount under $1,000 while three others would
 * have carried $25 without comment. Preference order breaks ties; the live quote
 * decides.
 *
 * ## Failure is a first-class result
 *
 * `allSettled`, not `all`. One rail throwing must not lose the four that answered, and
 * a rail that times out must not hold the user behind the slowest vendor. Declines are
 * kept and returned rather than dropped, because "NEAR Intents said: minimum swap
 * amount is $1,000" is the most useful sentence on the screen when nothing else
 * explains why an option vanished.
 */

/** Per-rail budget. A vendor slower than this is not worth making the user wait for. */
export const RAIL_TIMEOUT_MS = 2_000;

export interface RouteResult {
  readonly best?: Quote;
  readonly alternatives: readonly Quote[];
  readonly declines: readonly Decline[];
  /** Rails that were asked and neither quoted nor declined — timed out or threw. */
  readonly silent: readonly { rail: string; reason: string }[];
}

/**
 * Rank two quotes.
 *
 * **No wallet first, ahead of price.** This product's premise is an account and nothing
 * else: a passkey, no extension, no seed phrase. A deposit-address rail matches that —
 * the user sends from wherever their money already is. A wallet-signed rail asks them to
 * install something, connect it, hold gas on the source chain and approve two
 * transactions. Those are not two prices for one thing, and the cheaper number is not
 * the better offer when it costs a wallet the user may not have.
 *
 * CCTP is the case that makes this concrete: it prices Base USDC above every
 * deposit-address rail and must still never lead. It is not hidden — it sits behind a
 * section the user opens on purpose, which is where a rail with a prerequisite belongs.
 *
 * **Then executable.** A quote nobody can act on is not an offer whatever the number.
 *
 * Then amount out, because that is what the user receives and every fee is already
 * inside it. Then ETA, which breaks the common tie of two rails on one fee schedule.
 */
function better(a: Quote, b: Quote): number {
  if (a.needsWallet !== b.needsWallet) return a.needsWallet ? 1 : -1;
  if (a.executable !== b.executable) return a.executable ? -1 : 1;
  if (a.amountOut !== b.amountOut) return a.amountOut > b.amountOut ? -1 : 1;
  return a.etaSeconds - b.etaSeconds;
}

export async function route(
  rails: readonly Rail[],
  req: FundingRequest,
  timeoutMs = RAIL_TIMEOUT_MS,
): Promise<RouteResult> {
  const candidates = rails.filter((r) => r.supports(req));

  const settled = await Promise.allSettled(
    candidates.map(async (rail) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await rail.quote(req, controller.signal);
      } finally {
        clearTimeout(timer);
      }
    }),
  );

  const quotes: Quote[] = [];
  const declines: Decline[] = [];
  const silent: { rail: string; reason: string }[] = [];

  settled.forEach((outcome, i) => {
    const rail = candidates[i];
    if (!rail) return;
    if (outcome.status === 'rejected') {
      // A thrown rail is not a declining rail. It said nothing, and the report says so
      // rather than inventing a refusal on the vendor's behalf.
      const reason =
        outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      silent.push({ rail: rail.id, reason: reason.split('\n')[0]?.trim() ?? 'no reason given' });
      return;
    }
    if (isQuote(outcome.value)) quotes.push(outcome.value);
    else declines.push(outcome.value);
  });

  quotes.sort(better);
  const [best, ...alternatives] = quotes;

  return {
    ...(best ? { best } : {}),
    alternatives,
    declines,
    silent,
  };
}
