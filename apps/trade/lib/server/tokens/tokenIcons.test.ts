import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import {
  dexscreenerIconSource,
  geckoterminalIconSource,
  ICON_ERROR_RETRY_MS,
  ICON_MAX_BYTES,
  ICON_TTL_MS,
  IconStore,
  fetchValidImage,
  isFetchableImageUrl,
  isPublicAddress,
  publicOnlyLookup,
  kuruIconSource,
  kyberIconSource,
  resolveTokenIcon,
  sharpResize,
  sniffImage,
  tokenIcon,
  validateImage,
  type Fetcher,
  type IconSource,
} from './tokenIcons';
import { handleTokenIcon } from './tokenIconRoute';
import { tokenIconSrc, tokenIconView } from '../../tokenIcon';

/**
 * Every vendor answer and every image here was recorded live on 2026-10-07 from the
 * real endpoints (R3): Kuru logos via our production `/api/tokens/registry`, KyberSwap
 * `token-api.kyberswap.com/api/v1/public/tokens?chainIds=143&symbol=…`, DexScreener
 * `api.dexscreener.com/tokens/v1/monad/<address>`, GeckoTerminal
 * `api.geckoterminal.com/api/v2/networks/monad/tokens/<address>`, and the image bytes
 * each one pointed at.
 */
const FX = join(import.meta.dirname, '__fixtures__', 'icons');
const bytes = (f: string) => new Uint8Array(readFileSync(join(FX, f)));
const json = (f: string) => JSON.parse(readFileSync(join(FX, f), 'utf8')) as unknown;

const EMO = '0x81a224f8a62f52bde942dbf23a56df77a10b7777';
const USDC = '0x754704bc059f8c67012fed69bc8a327a5aafb603';
const JAMES = '0x43cf5407bda1400498b8064d50a7e17528d87777';
const NOWHERE = '0x1111111111111111111111111111111111111111';

const registry = json('registry.json') as { tokens: { address: string; logoUrl?: string }[] };
const kuruLookup = async (address: string) => registry.tokens.find((t) => t.address.toLowerCase() === address)?.logoUrl;

const dexJames = json('dexscreener-james.json') as { info: { imageUrl: string } }[];
const geckoJames = json('gecko-james.json') as { data: { attributes: { image_url: string } } };
const kyberUsdc = json('kyber-usdc.json') as { data: { tokens: { address: string; logoURL?: string }[] } };
const KYBER_USDC_LOGO = kyberUsdc.data.tokens.find((t) => t.address === USDC)!.logoURL!;
const EMO_LOGO = registry.tokens.find((t) => t.address.toLowerCase() === EMO)!.logoUrl!;
const USDC_KURU_SVG = registry.tokens.find((t) => t.address.toLowerCase() === USDC)!.logoUrl!;

type Recorded = { status: number; type?: string; body: Uint8Array | unknown };
const jsonRes = (body: unknown, status = 200): Recorded => ({ status, type: 'application/json', body });
const imgRes = (file: string, type: string): Recorded => ({ status: 200, type, body: bytes(file) });

/** Answers only the URLs it was given; anything else is a failure, and every call is counted. */
function recordedFetcher(routes: Record<string, Recorded>) {
  const calls: string[] = [];
  const fetcher: Fetcher = async (url) => {
    calls.push(url);
    const hit = routes[url];
    if (!hit) return new Response('not recorded', { status: 599 });
    const body = hit.body instanceof Uint8Array ? hit.body : JSON.stringify(hit.body);
    return new Response(body as BodyInit, { status: hit.status, headers: hit.type ? { 'content-type': hit.type } : {} });
  };
  return { fetcher, calls };
}

const kyberUrl = (symbol: string) => `https://token-api.kyberswap.com/api/v1/public/tokens?chainIds=143&symbol=${symbol}&pageSize=100`;
const dexUrl = (a: string) => `https://api.dexscreener.com/tokens/v1/monad/${a}`;
const geckoUrl = (a: string) => `https://api.geckoterminal.com/api/v2/networks/monad/tokens/${a}`;

const ALL_SOURCES: readonly IconSource[] = [kuruIconSource(kuruLookup), kyberIconSource, dexscreenerIconSource, geckoterminalIconSource];

async function isIcon64(out: Uint8Array) {
  const meta = await sharp(out).metadata();
  return meta.format === 'webp' && meta.width === 64 && meta.height === 64;
}

describe('image validator', () => {
  it('accepts the real PNG, JPEG and WEBP logos', () => {
    expect(validateImage('image/png', bytes('kuru-emo.png'))).toEqual({ ok: true, format: 'png' });
    expect(validateImage('image/jpeg', bytes('kyber-143.jpg'))).toEqual({ ok: true, format: 'jpeg' });
    expect(validateImage('image/webp', bytes('dexscreener-james.webp'))).toEqual({ ok: true, format: 'webp' });
  });

  it('rejects SVG, even a real logo with an image/* type', () => {
    expect(validateImage('image/svg+xml', bytes('kuru-usdc.svg'))).toEqual({ ok: false, reason: 'svg' });
    expect(sniffImage(bytes('kuru-usdc.svg'))).toBeNull();
  });

  it('rejects a non-image content type even when the bytes are an image', () => {
    expect(validateImage('text/html; charset=utf-8', bytes('kuru-emo.png'))).toEqual({ ok: false, reason: 'not-image-type' });
    expect(validateImage(null, bytes('kuru-emo.png'))).toEqual({ ok: false, reason: 'not-image-type' });
  });

  it('rejects wrong magic bytes under an image type', () => {
    expect(validateImage('image/png', bytes('kuru-usdc.svg'))).toEqual({ ok: false, reason: 'bad-magic' });
    expect(validateImage('image/png', new TextEncoder().encode('{"error":"not found"}'))).toEqual({ ok: false, reason: 'bad-magic' });
  });

  it('rejects anything over 512 KB and anything empty', () => {
    const png = bytes('kuru-emo.png');
    const big = new Uint8Array(ICON_MAX_BYTES + 1);
    for (let at = 0; at < big.length; at += png.length) big.set(png.subarray(0, Math.min(png.length, big.length - at)), at);
    expect(validateImage('image/png', big)).toEqual({ ok: false, reason: 'too-large' });
    expect(validateImage('image/png', new Uint8Array(0))).toEqual({ ok: false, reason: 'empty' });
  });

  it('fetches only https URLs on a DNS name', () => {
    expect(isFetchableImageUrl(EMO_LOGO)).toBe(true);
    expect(isFetchableImageUrl('http://dsvxs4ecepqgj.cloudfront.net/x.png')).toBe(false);
    expect(isFetchableImageUrl('https://127.0.0.1/x.png')).toBe(false);
    expect(isFetchableImageUrl('https://[::1]/x.png')).toBe(false);
    expect(isFetchableImageUrl('https://localhost/x.png')).toBe(false);
    expect(isFetchableImageUrl('data:image/png;base64,AAAA')).toBe(false);
  });

  it('refuses resolved addresses off the public internet', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.9', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1']) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    for (const ip of ['13.32.0.1', '104.16.0.1', '2606:4700::1']) expect(isPublicAddress(ip), ip).toBe(true);
  });

  it('the connection goes to the exact address that was checked, and an inward answer is refused (R9)', async () => {
    const ask = (answers: { address: string; family: number }[]) =>
      new Promise<{ error: Error | null; address: unknown }>((resolve) =>
        publicOnlyLookup(async () => answers)('icons.example.org', {}, (error, address) => resolve({ error, address })),
      );
    expect(await ask([{ address: '104.16.0.1', family: 4 }])).toEqual({ error: null, address: '104.16.0.1' });
    const asArray = await new Promise<unknown>((resolve) =>
      publicOnlyLookup(async () => [{ address: '104.16.0.1', family: 4 }])('icons.example.org', { all: true }, (_e, a) => resolve(a)),
    );
    expect(asArray).toEqual([{ address: '104.16.0.1', family: 4 }]);
    expect((await ask([{ address: '127.0.0.1', family: 4 }])).error).toBeInstanceOf(Error);
    // One inward address among public ones is refused outright, not skipped.
    expect((await ask([{ address: '104.16.0.1', family: 4 }, { address: '10.0.0.5', family: 4 }])).error).toBeInstanceOf(Error);
    expect((await ask([])).error).toBeInstanceOf(Error);
    const failed = await new Promise<Error | null>((resolve) =>
      publicOnlyLookup(async () => {
        throw new Error('ENOTFOUND');
      })('nowhere.example', {}, (error) => resolve(error)),
    );
    expect(failed?.message).toBe('ENOTFOUND');
  });

  it('works through a real socket, in the shape Node asks for, and refuses there too (security review, R9)', async () => {
    const { createServer, request } = await import('node:http');
    const server = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    const get = (lookup: unknown) =>
      new Promise<string>((resolve) => {
        // A fresh socket each time (no keep-alive reuse), so every request really looks up.
        const req = request({ host: 'icons.test', port, path: '/', agent: false, lookup: lookup as never }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve(body));
        });
        req.on('error', (e) => resolve(`error: ${e.message}`));
        req.end();
      });
    const toLocal = async () => [{ address: '127.0.0.1', family: 4 }];
    try {
      // Treated as public only for this test, to reach a server on this machine.
      expect(await get(publicOnlyLookup(toLocal, () => true))).toBe('ok');
      // The real rule refuses it at connect time, with our own sentence.
      expect(await get(publicOnlyLookup(toLocal))).toBe('error: the icon host does not resolve to a public address');
    } finally {
      server.close();
    }
  });

  it('checks every redirect hop before requesting it: a hop to an inward address is never fetched', async () => {
    const calls: string[] = [];
    const fetcher: Fetcher = async (input) => {
      calls.push(input);
      if (input === EMO_LOGO) return new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data' } });
      return new Response(bytes('kuru-emo.png'), { status: 200, headers: { 'content-type': 'image/png' } });
    };
    expect(await fetchValidImage(EMO_LOGO, fetcher)).toBeNull();
    expect(calls).toEqual([EMO_LOGO]);
  });

  it('follows a redirect to another https host and validates what it finds there', async () => {
    const next = 'https://cdn.example.org/emo.png';
    const fetcher: Fetcher = async (input) =>
      input === EMO_LOGO
        ? new Response(null, { status: 301, headers: { location: next } })
        : new Response(bytes('kuru-emo.png'), { status: 200, headers: { 'content-type': 'image/png' } });
    expect(await fetchValidImage(EMO_LOGO, fetcher)).not.toBeNull();
  });
});

describe('icon sources, in order', () => {
  it('a listed token shows its Kuru logo', async () => {
    const { fetcher, calls } = recordedFetcher({ [EMO_LOGO]: imgRes('kuru-emo.png', 'image/png') });
    const result = await resolveTokenIcon(EMO, ALL_SOURCES, { fetcher, symbol: 'emo' }, sharpResize);
    expect(result.kind).toBe('icon');
    if (result.kind !== 'icon') return;
    expect(result.source).toBe('kuru');
    expect(await isIcon64(result.bytes)).toBe(true);
    expect(calls).toEqual([EMO_LOGO]);
  });

  it("Kuru's SVG is refused and KyberSwap's PNG for the same token wins", async () => {
    const { fetcher, calls } = recordedFetcher({
      [USDC_KURU_SVG]: imgRes('kuru-usdc.svg', 'image/svg+xml'),
      [kyberUrl('USDC')]: jsonRes(kyberUsdc),
      [KYBER_USDC_LOGO]: imgRes('kyber-usdc.png', 'image/png'),
    });
    const result = await resolveTokenIcon(USDC, ALL_SOURCES, { fetcher, symbol: 'USDC' }, sharpResize);
    expect(result.kind === 'icon' && result.source).toBe('kyberswap');
    expect(calls).toEqual([USDC_KURU_SVG, kyberUrl('USDC'), KYBER_USDC_LOGO]);
  });

  it('a meme found only on DexScreener shows its image', async () => {
    const { fetcher, calls } = recordedFetcher({
      [kyberUrl('JAMES')]: jsonRes(json('kyber-james.json')),
      [dexUrl(JAMES)]: jsonRes(dexJames),
      [dexJames[0]!.info.imageUrl]: imgRes('dexscreener-james.webp', 'image/webp'),
    });
    const result = await resolveTokenIcon(JAMES, ALL_SOURCES, { fetcher, symbol: 'JAMES' }, sharpResize);
    expect(result.kind === 'icon' && result.source).toBe('dexscreener');
    if (result.kind === 'icon') expect(await isIcon64(result.bytes)).toBe(true);
    expect(calls).not.toContain(geckoUrl(JAMES));
  });

  it('a failing image URL falls through cleanly to the next source', async () => {
    const { fetcher } = recordedFetcher({
      [kyberUrl('JAMES')]: jsonRes(json('kyber-james.json')),
      [dexUrl(JAMES)]: jsonRes(dexJames),
      [dexJames[0]!.info.imageUrl]: { status: 404, type: 'text/html', body: new TextEncoder().encode('<html>gone</html>') },
      [geckoUrl(JAMES)]: jsonRes(geckoJames),
      [geckoJames.data.attributes.image_url]: imgRes('gecko-james.img', 'image/webp'),
    });
    const result = await resolveTokenIcon(JAMES, ALL_SOURCES, { fetcher, symbol: 'JAMES' }, sharpResize);
    expect(result.kind === 'icon' && result.source).toBe('geckoterminal');
  });

  it('a token with no image anywhere is a clean miss', async () => {
    const { fetcher } = recordedFetcher({
      [kyberUrl('NOTAREALTOKENX')]: jsonRes(json('kyber-none.json')),
      [dexUrl(NOWHERE)]: jsonRes(json('dexscreener-none.json')),
      [geckoUrl(NOWHERE)]: jsonRes(json('gecko-none.json'), 404),
    });
    const result = await resolveTokenIcon(NOWHERE, ALL_SOURCES, { fetcher, symbol: 'NOTAREALTOKENX' }, sharpResize);
    expect(result).toEqual({ kind: 'miss', anySourceErrored: false });
  });

  it('a rate-limited or unreachable source is an error, not an answer', async () => {
    const { fetcher } = recordedFetcher({
      [dexUrl(NOWHERE)]: jsonRes(json('dexscreener-none.json')),
      [geckoUrl(NOWHERE)]: jsonRes({ status: { error_code: 429 } }, 429),
    });
    const result = await resolveTokenIcon(NOWHERE, ALL_SOURCES, { fetcher }, sharpResize);
    expect(result).toEqual({ kind: 'miss', anySourceErrored: true });
  });
});

describe('disk cache', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'token-icons-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves a cached icon for a day without asking any source again', async () => {
    const { fetcher, calls } = recordedFetcher({ [EMO_LOGO]: imgRes('kuru-emo.png', 'image/png') });
    let now = 1_000_000;
    const deps = { store: new IconStore(dir), sources: ALL_SOURCES, fetcher, resize: sharpResize, symbolOf: async () => 'emo', now: () => now };
    const first = await tokenIcon(EMO, deps);
    expect(first && (await isIcon64(first))).toBe(true);
    now += ICON_TTL_MS - 1;
    const second = await tokenIcon(EMO, deps);
    expect(second).toEqual(first);
    expect(calls).toHaveLength(1);
  });

  it('remembers a miss and retries the sources at most once a day', async () => {
    const { fetcher, calls } = recordedFetcher({
      [dexUrl(NOWHERE)]: jsonRes(json('dexscreener-none.json')),
      [geckoUrl(NOWHERE)]: jsonRes(json('gecko-none.json'), 404),
    });
    const real = Date.now();
    let now = real;
    const deps = { store: new IconStore(dir), sources: ALL_SOURCES, fetcher, resize: sharpResize, symbolOf: async () => undefined, now: () => now };
    expect(await tokenIcon(NOWHERE, deps)).toBeNull();
    const afterFirst = calls.length;
    now = real + ICON_TTL_MS - 1;
    expect(await tokenIcon(NOWHERE, deps)).toBeNull();
    expect(calls.length).toBe(afterFirst);
    now = real + ICON_TTL_MS + 1;
    expect(await tokenIcon(NOWHERE, deps)).toBeNull();
    expect(calls.length).toBe(afterFirst * 2);
  });

  it('a miss caused by a failing source is retried after an hour, not a day', () => {
    const store = new IconStore(dir);
    store.writeMiss(NOWHERE, 0, ICON_ERROR_RETRY_MS);
    expect(store.missIsFresh(NOWHERE, ICON_ERROR_RETRY_MS - 1)).toBe(true);
    expect(store.missIsFresh(NOWHERE, ICON_ERROR_RETRY_MS + 1)).toBe(false);
  });
});

describe('/api/token-icon/[address]', () => {
  const png = bytes('kuru-emo.png');

  it('refuses a malformed address without looking anything up', async () => {
    const icon = vi.fn();
    const res = await handleTokenIcon('0x3842…7777', { symbolOf: vi.fn(), icon });
    expect(res.status).toBe(400);
    expect(icon).not.toHaveBeenCalled();
  });

  it('never asks a vendor about an address that is not a token', async () => {
    const icon = vi.fn();
    const res = await handleTokenIcon(NOWHERE, { symbolOf: async () => undefined, icon });
    expect(res.status).toBe(404);
    expect(icon).not.toHaveBeenCalled();
  });

  it('serves the icon from our origin with long cache headers', async () => {
    const res = await handleTokenIcon(EMO, { symbolOf: async () => 'emo', icon: async () => png });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(res.headers.get('cache-control')).toContain('max-age=86400');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(png);
  });

  it('answers 404 when no source has an icon, so the page shows the mark', async () => {
    const res = await handleTokenIcon(NOWHERE, { symbolOf: async () => 'X', icon: async () => null });
    expect(res.status).toBe(404);
  });
});

describe('what the icon component draws', () => {
  it('our own route for a token address, never a third-party URL', () => {
    expect(tokenIconView({ address: '0x3842751A46d23b41a47E702473DFf316e6237777', symbol: '143', failed: false })).toEqual({
      kind: 'img',
      src: tokenIconSrc('0x3842751a46d23b41a47e702473dff316e6237777'),
    });
    expect(tokenIconSrc(EMO)).toMatch(/\/api\/token-icon\/0x81a224f8a62f52bde942dbf23a56df77a10b7777$/);
  });

  it('the two-letter mark once the image has failed, or with no address', () => {
    expect(tokenIconView({ address: JAMES, symbol: 'JAMES', failed: true })).toEqual({ kind: 'mark', text: 'JA' });
    expect(tokenIconView({ address: undefined, symbol: 'USDT0', failed: false })).toEqual({ kind: 'mark', text: 'US' });
    expect(tokenIconView({ address: null, symbol: '0x3842…7777', failed: false })).toEqual({ kind: 'mark', text: '0x' });
  });
});
