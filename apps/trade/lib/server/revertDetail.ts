import { decodeKuruError } from '@tradepro/core';
import type { Hex } from 'viem';

/**
 * What an upstream call actually said, extracted for the wire — so a route handler's
 * catch block never answers with a bare error code while the reason dies in a log
 * (error-handling rule, 2026-09-08).
 */

/**
 * A failed Kuru read, as `{ source, message }` for the response's `upstream` field.
 * A revert whose selector this repo's table knows becomes its decoded name
 * ("SizeError"); anything else is the error's own first line, verbatim.
 */
export function kuruUpstreamFrom(error: unknown): { source: string; message: string } {
  const raw = describe(error);
  const selector = /0x[0-9a-fA-F]{8}/.exec(raw)?.[0];
  const known = selector ? decodeKuruError(selector as Hex) : undefined;
  if (known) return { source: 'Kuru', message: known.name };
  return { source: 'Kuru', message: raw };
}

/** A failed call to any named upstream, first line verbatim. */
export function upstreamFrom(source: string, error: unknown): { source: string; message: string } {
  return { source, message: describe(error) };
}

function describe(error: unknown): string {
  const raw =
    error instanceof Error
      ? ((error as { shortMessage?: string }).shortMessage ?? error.message)
      : String(error);
  return raw.split('\n')[0]?.trim().slice(0, 300) || 'no reason given';
}
