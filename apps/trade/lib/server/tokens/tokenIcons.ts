import { mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BlockList, isIP } from 'node:net';
import { z } from 'zod';

/**
 * Token icons, resolved and served by this app's own server so the browser only ever
 * loads `/api/token-icon/<address>` from our origin (CSP `img-src 'self'`).
 *
 * Sources, in order, no keys; the first one whose URL yields a valid raster image wins:
 *   1. Kuru: the registry's `logoUrl` (Kuru market metadata joined by address).
 *   2. KyberSwap token API: `GET https://token-api.kyberswap.com/api/v1/public/tokens`
 *      with `chainIds=143` and `symbol=<exact>`, matched by address, `logoURL`
 *      (KyberNetwork/kyberswap-skills `references/api-reference.md`, linked from
 *      docs.kyberswap.com "Skills for local agents"). The API has no address filter,
 *      so the symbol is required; a token without one skips this source.
 *   3. DexScreener: `GET https://api.dexscreener.com/tokens/v1/monad/<address>`, the
 *      pair whose `baseToken.address` is this token, `info.imageUrl`
 *      (docs.dexscreener.com/api/reference).
 *   4. GeckoTerminal: `GET https://api.geckoterminal.com/api/v2/networks/monad/tokens/<address>`,
 *      `data.attributes.image_url` (api.geckoterminal.com/docs, swagger v2).
 *
 * The winner is fetched server-side, checked (content-type image/* AND PNG/JPEG/GIF/WEBP
 * magic bytes, under 512 KB; SVG is refused, never sanitised), resized to 64 px and
 * written to disk. A token no source can answer is remembered as a miss and retried at
 * most once a day; a miss caused by a source failing (timeout, 429, 5xx) is retried
 * after an hour instead, since that is not an answer.
 */

export const ICON_PX = 64;
export const ICON_MAX_BYTES = 512 * 1024;
export const ICON_TTL_MS = 24 * 60 * 60 * 1000;
export const ICON_ERROR_RETRY_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;
const MONAD_CHAIN_ID = 143;

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export type ImageFormat = 'png' | 'jpeg' | 'gif' | 'webp';

/** Magic-byte sniff. Only the four raster formats; anything else (SVG, HTML, AVIF) is null. */
export function sniffImage(bytes: Uint8Array): ImageFormat | null {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    return 'png';
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) {
    return 'gif';
  }
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    return 'webp';
  }
  return null;
}

export type ImageCheck = { ok: true; format: ImageFormat } | { ok: false; reason: 'not-image-type' | 'svg' | 'too-large' | 'empty' | 'bad-magic' };

export function validateImage(contentType: string | null, bytes: Uint8Array): ImageCheck {
  const type = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (!type.startsWith('image/')) return { ok: false, reason: 'not-image-type' };
  if (type.includes('svg')) return { ok: false, reason: 'svg' };
  if (bytes.length === 0) return { ok: false, reason: 'empty' };
  if (bytes.length > ICON_MAX_BYTES) return { ok: false, reason: 'too-large' };
  const format = sniffImage(bytes);
  if (!format) return { ok: false, reason: 'bad-magic' };
  return { ok: true, format };
}

/** https only, a DNS name (no IP literal, no localhost): a vendor's URL must not point us inward. */
export function isFetchableImageUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(host) !== 0) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
  return host.includes('.');
}

/** Every range that is not the public internet: a resolved address in one is refused. */
const NOT_PUBLIC = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3],
] as const) NOT_PUBLIC.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) NOT_PUBLIC.addSubnet(net, bits, 'ipv6');

/** True only for an address on the public internet. */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 0) return false;
  // An IPv4-mapped IPv6 address is judged as the IPv4 address it carries.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  if (mapped) return isPublicAddress(mapped);
  return !NOT_PUBLIC.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

/** A resolver in `dns.lookup`'s `{ all: true }` shape; injected so the rule can be tested. */
export type ResolveAll = (hostname: string) => Promise<ReadonlyArray<{ address: string; family: number }>>;

/**
 * A `lookup` for `net.connect` that refuses any host with an address off the public
 * internet and hands the socket exactly the address it checked (R9, 2026-10-07). Checking
 * the name before `fetch` and letting `fetch` resolve it again left a second answer, a
 * DNS rebind, free to point the connection inward; here there is only one answer, and
 * it is the one connected to.
 */
export function publicOnlyLookup(resolveAll: ResolveAll, isPublic: (ip: string) => boolean = isPublicAddress) {
  return (
    hostname: string,
    options: unknown,
    callback: (error: Error | null, address: string | Array<{ address: string; family: number }>, family?: number) => void,
  ): void => {
    // Node 20+ asks `net.connect`'s lookup for every address (`all: true`) and expects an
    // array back; older callers want one address and its family (security review, R9).
    const all = typeof options === 'object' && options !== null && (options as { all?: unknown }).all === true;
    resolveAll(hostname).then(
      (resolved) => {
        if (resolved.length === 0 || resolved.some((r) => !isPublic(r.address))) {
          callback(new Error('the icon host does not resolve to a public address'), all ? [] : '', 0);
          return;
        }
        if (all) {
          callback(null, resolved.map((r) => ({ address: r.address, family: r.family })));
          return;
        }
        const first = resolved[0]!;
        callback(null, first.address, first.family);
      },
      (error: unknown) => callback(error instanceof Error ? error : new Error(String(error)), all ? [] : '', 0),
    );
  };
}

/** At most this many redirects, each one checked like the first URL. */
export const MAX_ICON_REDIRECTS = 3;

/** Reads a body, giving up as soon as it passes `limit` bytes. */
async function readCapped(res: Response, limit: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Fetches a candidate image and returns its bytes only if it passes `validateImage`. */
export async function fetchValidImage(url: string, fetcher: Fetcher): Promise<Uint8Array | null> {
  try {
    // Redirects are followed by hand so every hop is checked before it is requested,
    // not only the last one.
    let at = url;
    let res: Response | undefined;
    for (let hop = 0; hop <= MAX_ICON_REDIRECTS; hop += 1) {
      if (!isFetchableImageUrl(at)) return null;
      res = await fetcher(at, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { accept: 'image/webp,image/png,image/jpeg,image/gif' },
        redirect: 'manual',
      });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!location) break;
      await res.body?.cancel().catch(() => undefined);
      at = new URL(location, at).toString();
      res = undefined;
    }
    if (!res || res.status !== 200) return null;
    // One byte over the cap is enough to know it is too large.
    const bytes = await readCapped(res, ICON_MAX_BYTES + 1);
    if (!bytes) return null;
    return validateImage(res.headers.get('content-type'), bytes).ok ? bytes : null;
  } catch {
    return null;
  }
}

/** What a source said: a URL, a definite "nothing", or that it could not answer. */
export type SourceAnswer = { kind: 'url'; url: string } | { kind: 'none' } | { kind: 'error' };

export interface IconSourceContext {
  readonly fetcher: Fetcher;
  /** The token's on-chain symbol when known; KyberSwap's API can only search by it. */
  readonly symbol?: string;
}

export interface IconSource {
  readonly name: 'kuru' | 'kyberswap' | 'dexscreener' | 'geckoterminal';
  find(address: string, ctx: IconSourceContext): Promise<SourceAnswer>;
}

async function getJson(url: string, fetcher: Fetcher, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown } | null> {
  try {
    const res = await fetcher(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: 'application/json', ...headers } });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } catch {
    return null;
  }
}

/** Kuru's market list, through the registry this app already builds. */
export function kuruIconSource(lookup: (address: string) => Promise<string | undefined>): IconSource {
  return {
    name: 'kuru',
    async find(address) {
      try {
        const url = await lookup(address.toLowerCase());
        return url ? { kind: 'url', url } : { kind: 'none' };
      } catch {
        return { kind: 'error' };
      }
    },
  };
}

const kyberSchema = z.object({
  code: z.number(),
  data: z.object({
    tokens: z
      .array(z.object({ address: z.string(), logoURL: z.string().nullable().optional() }))
      .nullable(),
  }),
});

export const kyberIconSource: IconSource = {
  name: 'kyberswap',
  async find(address, { fetcher, symbol }) {
    if (!symbol) return { kind: 'none' };
    const url = `https://token-api.kyberswap.com/api/v1/public/tokens?chainIds=${MONAD_CHAIN_ID}&symbol=${encodeURIComponent(symbol)}&pageSize=100`;
    const res = await getJson(url, fetcher);
    if (!res || res.status !== 200) return { kind: 'error' };
    const parsed = kyberSchema.safeParse(res.body);
    if (!parsed.success || parsed.data.code !== 0) return { kind: 'error' };
    const hit = (parsed.data.data.tokens ?? []).find((t) => t.address.toLowerCase() === address.toLowerCase());
    return hit?.logoURL ? { kind: 'url', url: hit.logoURL } : { kind: 'none' };
  },
};

const dexPairsSchema = z.array(
  z.object({
    baseToken: z.object({ address: z.string() }),
    info: z.object({ imageUrl: z.string().nullable().optional() }).nullable().optional(),
  }),
);

export const dexscreenerIconSource: IconSource = {
  name: 'dexscreener',
  async find(address, { fetcher }) {
    const res = await getJson(`https://api.dexscreener.com/tokens/v1/monad/${address.toLowerCase()}`, fetcher);
    if (!res || res.status !== 200) return { kind: 'error' };
    const parsed = dexPairsSchema.safeParse(res.body);
    if (!parsed.success) return { kind: 'error' };
    // `info` describes the pair's base token, so only a pair based on this token counts.
    const hit = parsed.data.find((p) => p.baseToken.address.toLowerCase() === address.toLowerCase() && p.info?.imageUrl);
    return hit?.info?.imageUrl ? { kind: 'url', url: hit.info.imageUrl } : { kind: 'none' };
  },
};

const geckoSchema = z.object({
  data: z.object({ attributes: z.object({ image_url: z.string().nullable().optional() }) }),
});

export const geckoterminalIconSource: IconSource = {
  name: 'geckoterminal',
  async find(address, { fetcher }) {
    const res = await getJson(`https://api.geckoterminal.com/api/v2/networks/monad/tokens/${address.toLowerCase()}`, fetcher, {
      accept: 'application/json;version=20230203',
    });
    if (!res) return { kind: 'error' };
    if (res.status === 404) return { kind: 'none' };
    if (res.status !== 200) return { kind: 'error' };
    const parsed = geckoSchema.safeParse(res.body);
    if (!parsed.success) return { kind: 'error' };
    const url = parsed.data.data.attributes.image_url;
    return url ? { kind: 'url', url } : { kind: 'none' };
  },
};

export type Resize = (bytes: Uint8Array) => Promise<Uint8Array>;

/** 64 px square WEBP through sharp. A file sharp cannot decode is not an image. */
export const sharpResize: Resize = async (bytes) => {
  const { default: sharp } = await import('sharp');
  const out = await sharp(bytes, { animated: false, limitInputPixels: 4096 * 4096 })
    .resize(ICON_PX, ICON_PX, { fit: 'cover' })
    .webp({ quality: 90 })
    .toBuffer();
  return new Uint8Array(out);
};

export type Resolution = { kind: 'icon'; source: IconSource['name']; bytes: Uint8Array } | { kind: 'miss'; anySourceErrored: boolean };

/** Walks the sources in order; the first URL that yields a valid, resizable image wins. */
export async function resolveTokenIcon(
  address: string,
  sources: readonly IconSource[],
  ctx: IconSourceContext,
  resize: Resize,
): Promise<Resolution> {
  let anySourceErrored = false;
  for (const source of sources) {
    const answer = await source.find(address, ctx);
    if (answer.kind === 'error') {
      anySourceErrored = true;
      continue;
    }
    if (answer.kind === 'none') continue;
    const bytes = await fetchValidImage(answer.url, ctx.fetcher);
    if (!bytes) continue;
    try {
      return { kind: 'icon', source: source.name, bytes: await resize(bytes) };
    } catch {
      continue;
    }
  }
  return { kind: 'miss', anySourceErrored };
}

/** The on-disk cache: `<address>.webp` for an icon, `<address>.miss` (JSON) for a miss. */
export class IconStore {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  #path(address: string, ext: 'webp' | 'miss'): string {
    return join(this.#dir, `${address.toLowerCase()}.${ext}`);
  }

  readIcon(address: string, now: number): { bytes: Uint8Array; fresh: boolean } | undefined {
    try {
      const p = this.#path(address, 'webp');
      const age = now - statSync(p).mtimeMs;
      return { bytes: new Uint8Array(readFileSync(p)), fresh: age < ICON_TTL_MS };
    } catch {
      return undefined;
    }
  }

  /** True while a recorded miss has not yet reached its retry time. */
  missIsFresh(address: string, now: number): boolean {
    try {
      const raw = JSON.parse(readFileSync(this.#path(address, 'miss'), 'utf8')) as { at?: unknown; retryAfterMs?: unknown };
      if (typeof raw.at !== 'number' || typeof raw.retryAfterMs !== 'number') return false;
      return now - raw.at < raw.retryAfterMs;
    } catch {
      return false;
    }
  }

  writeIcon(address: string, bytes: Uint8Array): void {
    mkdirSync(this.#dir, { recursive: true });
    writeFileSync(this.#path(address, 'webp'), bytes);
  }

  writeMiss(address: string, now: number, retryAfterMs: number): void {
    mkdirSync(this.#dir, { recursive: true });
    writeFileSync(this.#path(address, 'miss'), JSON.stringify({ at: now, retryAfterMs }));
  }

  /** Keep a stale icon, but push its next refresh a day out. */
  touchIcon(address: string, now: number): void {
    try {
      const t = new Date(now);
      utimesSync(this.#path(address, 'webp'), t, t);
    } catch {
      /* the file is gone; the next request resolves again */
    }
  }
}

export interface TokenIconDeps {
  readonly store: IconStore;
  readonly sources: readonly IconSource[];
  readonly fetcher: Fetcher;
  readonly resize: Resize;
  readonly symbolOf: (address: string) => Promise<string | undefined>;
  readonly now?: () => number;
}

const inflight = new Map<string, Promise<Uint8Array | null>>();

/** The 64 px icon bytes for a token, or null when no source has one. Cached on disk. */
export function tokenIcon(address: string, deps: TokenIconDeps): Promise<Uint8Array | null> {
  const key = address.toLowerCase();
  const running = inflight.get(key);
  if (running) return running;
  const job = loadTokenIcon(key, deps).finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

async function loadTokenIcon(address: string, deps: TokenIconDeps): Promise<Uint8Array | null> {
  const now = (deps.now ?? Date.now)();
  const cached = deps.store.readIcon(address, now);
  if (cached?.fresh) return cached.bytes;
  if (!cached && deps.store.missIsFresh(address, now)) return null;

  let symbol: string | undefined;
  try {
    symbol = await deps.symbolOf(address);
  } catch {
    symbol = undefined;
  }
  const result = await resolveTokenIcon(address, deps.sources, { fetcher: deps.fetcher, ...(symbol ? { symbol } : {}) }, deps.resize);
  try {
    if (result.kind === 'icon') {
      deps.store.writeIcon(address, result.bytes);
      return result.bytes;
    }
    if (cached) {
      deps.store.touchIcon(address, now);
      return cached.bytes;
    }
    deps.store.writeMiss(address, now, result.anySourceErrored ? ICON_ERROR_RETRY_MS : ICON_TTL_MS);
  } catch (error) {
    console.warn(JSON.stringify({ level: 'warn', msg: 'token icon cache write failed', token: address, error: String(error).slice(0, 200) }));
    if (result.kind === 'icon') return result.bytes;
    if (cached) return cached.bytes;
  }
  return null;
}

/** `TOKEN_ICON_DIR`, else `token-icons/` beside the deposit database. */
export function tokenIconDir(): string {
  return process.env.TOKEN_ICON_DIR ?? join(dirname(process.env.DEPOSIT_DB_PATH ?? './data/deposits.sqlite'), 'token-icons');
}
