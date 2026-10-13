import { lookup } from 'node:dns/promises';
import type { IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import type { MAINNET } from '@tradepro/core';
import type { Address } from 'viem';
import { addresses } from '../chain';
import { logoByAddressFromMarkets } from './kuruMarketMeta';
import { tokenDb } from './tokenDb';
import {
  dexscreenerIconSource,
  geckoterminalIconSource,
  IconStore,
  publicOnlyLookup,
  kuruIconSource,
  kyberIconSource,
  sharpResize,
  tokenIcon,
  tokenIconDir,
} from './tokenIcons';
import { readContractMetaLive, registryEntry, tokenRegistry } from './tokenRegistryLive';

let store: IconStore | undefined;

async function kuruLogo(address: string): Promise<string | undefined> {
  const snapshot = await tokenRegistry();
  const fromRegistry = registryEntry(snapshot, address as Address)?.logoUrl;
  if (fromRegistry) return fromRegistry;
  const restApi = (addresses() as typeof MAINNET).kuru.restApi;
  return restApi ? logoByAddressFromMarkets(restApi).get(address.toLowerCase()) : undefined;
}

/**
 * The token's symbol, and whether it is a token at all: the registry, then the stored
 * contract read, then a fresh `decimals/symbol/name` multicall. `undefined` means the
 * address is not an ERC-20 (or the read failed), and no vendor is asked about it.
 */
export async function knownTokenSymbol(address: Address): Promise<string | undefined> {
  const snapshot = await tokenRegistry();
  const listed = registryEntry(snapshot, address);
  if (listed) return listed.symbol;
  const stored = tokenDb().getMeta([address]).get(address.toLowerCase());
  if (stored) return stored.symbol;
  const read = (await readContractMetaLive([address])).get(address.toLowerCase());
  return read ? read.symbol : undefined;
}

/** Refuses any host that resolves to an address off the public internet, on every request and every redirect hop. */
const pinnedLookup = publicOnlyLookup(async (hostname) => lookup(hostname, { all: true }));

/**
 * An http response as a web `Response`. Throws on a status `Response` cannot carry (below
 * 200 or above 599): the caller rejects instead of hanging (security review, R9).
 */
export function webResponseFrom(res: IncomingMessage): Response {
  const status = res.statusCode ?? 0;
  if (status < 200 || status > 599) throw new Error(`the icon host answered status ${status}`);
  const responseHeaders = new Headers();
  for (const [key, value] of Object.entries(res.headers)) {
    if (value === undefined) continue;
    for (const one of Array.isArray(value) ? value : [value]) responseHeaders.append(key, one);
  }
  const noBody = status === 204 || status === 304 || (status >= 300 && status < 400);
  if (noBody) res.resume();
  return new Response(noBody ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), {
    status,
    headers: responseHeaders,
  });
}

/**
 * The pinned fetch, built from its parts so a test can drive it over plain http against a
 * local server (`allowHttp`); production uses `publicOnlyFetch` below, https only.
 */
export function makePinnedFetch(options: {
  readonly lookup: unknown;
  readonly request?: typeof httpsRequest;
  readonly allowHttp?: boolean;
}) {
  const send = options.request ?? httpsRequest;
  return (input: string, init?: RequestInit): Promise<Response> =>
    new Promise<Response>((resolve, reject) => {
      const url = new URL(input);
      if (url.protocol !== 'https:' && !(options.allowHttp && url.protocol === 'http:')) {
        reject(new Error('only https is fetched'));
        return;
      }
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => {
        headers[key] = value;
      });
      const req = send(
        url,
        { method: 'GET', headers, agent: false, lookup: options.lookup as never, ...(init?.signal ? { signal: init.signal } : {}) },
        (res) => {
          // Nothing here may throw: a throw in this listener would leave the promise
          // unsettled and the token's icon waiting forever (security review, R9).
          try {
            resolve(webResponseFrom(res));
          } catch (error) {
            res.destroy();
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        },
      );
      req.on('error', reject);
      req.end();
    });
}

/**
 * An https GET whose connection goes to the address `publicOnlyLookup` checked, and to no
 * other (R9, 2026-10-07). No redirects are followed here; `fetchValidImage` follows them
 * by hand, checking each hop.
 */
const publicOnlyFetch = makePinnedFetch({ lookup: pinnedLookup });

export function tokenIconLive(address: Address, symbol: string): Promise<Uint8Array | null> {
  store ??= new IconStore(tokenIconDir());
  return tokenIcon(address, {
    store,
    sources: [kuruIconSource(kuruLogo), kyberIconSource, dexscreenerIconSource, geckoterminalIconSource],
    fetcher: publicOnlyFetch,
    resize: sharpResize,
    symbolOf: async () => symbol,
  });
}
