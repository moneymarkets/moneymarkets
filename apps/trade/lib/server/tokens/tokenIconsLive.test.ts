import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { makePinnedFetch, webResponseFrom } from './tokenIconsLive';
import { publicOnlyLookup } from './tokenIcons';

/** An http response as `https.request` hands it over: a readable stream with a status. */
function incoming(statusCode: number, body = 'x'): IncomingMessage {
  return Object.assign(Readable.from([Buffer.from(body)]), { statusCode, headers: { 'content-type': 'image/png' } }) as unknown as IncomingMessage;
}

describe('webResponseFrom (security review, R9)', () => {
  it('a status a Response cannot carry is refused, so the fetch rejects instead of hanging', () => {
    expect(() => webResponseFrom(incoming(999))).toThrow('the icon host answered status 999');
    expect(() => webResponseFrom(incoming(101))).toThrow('the icon host answered status 101');
  });

  it('an ordinary answer comes through with its status, headers and body', async () => {
    const res = webResponseFrom(incoming(200, 'png'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(await res.text()).toBe('png');
  });

  it('a redirect carries no body, only its headers', () => {
    const res = webResponseFrom(incoming(302));
    expect(res.status).toBe(302);
    expect(res.body).toBeNull();
  });
});

describe('the pinned fetch end to end, through a real socket (security review, R9)', () => {
  it('a 999 from the host rejects promptly instead of hanging; a 200 comes through', async () => {
    const { createServer, request } = await import('node:http');
    const server = createServer((req, res) => {
      res.writeHead(req.url === '/bad' ? 999 : 200, { 'content-type': 'image/png' });
      res.end('png');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    // Treated as public only for this test, to reach a server on this machine.
    const fetchPinned = makePinnedFetch({
      lookup: publicOnlyLookup(async () => [{ address: '127.0.0.1', family: 4 }], () => true),
      request: request as never,
      allowHttp: true,
    });
    try {
      await expect(fetchPinned(`http://icons.test:${port}/bad`)).rejects.toThrow('the icon host answered status 999');
      const ok = await fetchPinned(`http://icons.test:${port}/ok`);
      expect(ok.status).toBe(200);
      expect(await ok.text()).toBe('png');
    } finally {
      server.close();
    }
  });
});
