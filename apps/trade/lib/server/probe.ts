import type { Address } from 'viem';
import {
  buildQuoteRequest,
  classifyQuoteRefusal,
  ONE_CLICK_QUOTE_URL,
  type QuoteRefusal,
} from '@tradepro/core';
import {
  destinationAsset,
  PRICING_REFUND_REFERENCE,
  PRICING_REFUND_REFERENCE_SOLANA,
  type ResolvedSource,
} from './aurora';

/**
 * Route availability is read, not assumed (error-handling rule, 2026-09-08 item 3).
 *
 * Each Intents source is probed with one **dry** quote — pricing only, allocating
 * nothing — so the /fund tiles can say whether the solver network is answering for
 * that route at all: available, or declining it right now with its own sentence
 * verbatim. Probes are cached for 60 seconds per source, so a page load costs at most
 * one quote per route per minute.
 *
 * **It never reports a minimum, and nothing here caches one.** A floor read from one
 * refusal is not a rule: it goes stale, it differs by amount, and using it to
 * pre-judge what the user may type blocked amounts 1Click would have priced. Removed
 * at the owner's instruction, 2026-09-09. Every amount goes to 1Click and only its
 * answer is shown.
 *
 * ## The probe amount
 *
 * One whole token of the origin asset — enough to ask "is this route answering at
 * all". Whatever it answers is about that one-token probe and nothing else, which is
 * exactly why its refusal is never turned into a rule about the user's own amount.
 */

export type RouteProbe =
  | { readonly state: 'available'; readonly at: number }
  | {
      readonly state: 'unavailable';
      readonly message: string;
      readonly status: number;
      readonly at: number;
    }
  /** The probe itself did not get an answer. Says nothing about the route. */
  | { readonly state: 'unprobed'; readonly message: string; readonly at: number };

const PROBE_CACHE_MS = 60_000;
const PROBE_TIMEOUT_MS = 8_000;

const cache = new Map<string, RouteProbe>();

function probeRefundFor(source: ResolvedSource, recipient: Address): string {
  if (source.refund === 'tron') return PRICING_REFUND_REFERENCE;
  if (source.refund === 'solana') return PRICING_REFUND_REFERENCE_SOLANA;
  return recipient;
}

function fromRefusal(refusal: QuoteRefusal, at: number): RouteProbe {
  // REFUND_ADDRESS_INVALID against the probe's own reference address is a probe
  // defect, not a route state — reported as unprobed so the tile claims nothing.
  if (refusal.kind === 'REFUND_ADDRESS_INVALID') {
    return { state: 'unprobed', message: refusal.message, at };
  }
  // A too-low refusal for the PROBE's own one-token amount says nothing about what
  // the user is about to type, so it is reported as the route declining right now,
  // with the network's sentence, and never as a floor to check anyone against.
  return { state: 'unavailable', message: refusal.message, status: refusal.status, at };
}

async function probeOnce(source: ResolvedSource, recipient: Address): Promise<RouteProbe> {
  const at = Date.now();
  if (!source.assetId || source.decimals === undefined) {
    return { state: 'unprobed', message: source.unavailable ?? 'not listed', at };
  }

  const body = buildQuoteRequest({
    originAsset: source.assetId,
    destinationAsset: destinationAsset().assetId,
    amount: 10n ** BigInt(source.decimals),
    recipient,
    refundTo: probeRefundFor(source, recipient),
    deadline: new Date(at + 90_000),
    dry: true,
  });

  let res: Response;
  try {
    res = await fetch(ONE_CLICK_QUOTE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (caught) {
    return {
      state: 'unprobed',
      message: caught instanceof Error ? caught.message : 'network',
      at,
    };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return fromRefusal(classifyQuoteRefusal(res.status, text), at);
  }

  return { state: 'available', at };
}

/** The probe for one source, 60-second cached. */
export async function probeSource(source: ResolvedSource, recipient: Address): Promise<RouteProbe> {
  const cached = cache.get(source.key);
  if (cached && Date.now() - cached.at < PROBE_CACHE_MS) return cached;
  const probe = await probeOnce(source, recipient);
  cache.set(source.key, probe);
  return probe;
}

/** Test seam. */
export function clearProbeCache(): void {
  cache.clear();
}
