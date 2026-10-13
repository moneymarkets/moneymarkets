import { getAddress, isAddress, type Address } from 'viem';

/** An icon changes rarely; the server refreshes its copy daily, the browser may keep it a day. */
export const ICON_CACHE_CONTROL = 'public, max-age=86400, stale-while-revalidate=604800';
/** No icon: the browser asks again in an hour, the server re-resolves at most daily. */
export const MISS_CACHE_CONTROL = 'public, max-age=3600';

export interface TokenIconRouteDeps {
  /** The token's symbol, or undefined when the address is not an ERC-20. */
  readonly symbolOf: (address: Address) => Promise<string | undefined>;
  readonly icon: (address: Address, symbol: string) => Promise<Uint8Array | null>;
}

/** `/api/token-icon/[address]`: a validated address in, our own 64 px WEBP or a 404 out. */
export async function handleTokenIcon(raw: string, deps: TokenIconRouteDeps): Promise<Response> {
  if (!isAddress(raw, { strict: false })) {
    return Response.json({ error: 'NOT_AN_ADDRESS' }, { status: 400 });
  }
  const address = getAddress(raw);
  let bytes: Uint8Array | null = null;
  try {
    // Only a real token is looked up: an address that is not an ERC-20 never reaches a vendor.
    const symbol = await deps.symbolOf(address);
    if (symbol !== undefined) bytes = await deps.icon(address, symbol);
  } catch (error) {
    console.warn(JSON.stringify({ level: 'warn', msg: 'token icon failed', token: address, error: String(error).slice(0, 200) }));
    return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
  }
  if (!bytes) return new Response(null, { status: 404, headers: { 'cache-control': MISS_CACHE_CONTROL } });
  return new Response(bytes as BodyInit, {
    status: 200,
    headers: {
      'content-type': 'image/webp',
      'content-length': String(bytes.length),
      'cache-control': ICON_CACHE_CONTROL,
      'x-content-type-options': 'nosniff',
    },
  });
}
