import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The Content-Security-Policy is rule A4, and it has one deliberate loophole:
 * `'unsafe-eval'` in development, because React uses `eval()` there to rebuild
 * server-side error stacks in the browser. Without it every page logs
 * "eval() is not supported in this environment".
 *
 * Neither React nor Next uses eval in production, so the deployed policy must not
 * carry it. That is what these tests are for: a dev-only relaxation is only safe
 * while something checks that it stays dev-only.
 */

type ConfigModule = {
  default: { headers: () => Promise<Array<{ headers: Array<{ key: string; value: string }> }>> };
};

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

function setNodeEnv(value: string | undefined): void {
  // NODE_ENV is readonly in the Next types but writable at runtime, and the config
  // reads it when `headers()` runs, so this is what exercises the branch.
  (process.env as Record<string, string | undefined>).NODE_ENV = value;
}

async function cspFor(nodeEnv: string): Promise<string> {
  setNodeEnv(nodeEnv);
  // The specifier must be a literal — Vite refuses a computed one — so the module
  // cache is cleared instead to force a fresh evaluation per environment.
  vi.resetModules();
  const mod = (await import('../next.config.mjs')) as unknown as ConfigModule;
  const headers = await mod.default.headers();
  return headers[0]?.headers.find((h) => h.key === 'Content-Security-Policy')?.value ?? '';
}

const scriptSrcOf = (csp: string): string =>
  csp.split('; ').find((d) => d.startsWith('script-src')) ?? '';

afterEach(() => setNodeEnv(ORIGINAL_NODE_ENV));

describe('Content-Security-Policy', () => {
  it('does NOT allow unsafe-eval in production', async () => {
    // The one that matters. If this fails, the deployed app permits eval, and the
    // reason it was added — a console warning in dev — is not worth that.
    expect(scriptSrcOf(await cspFor('production'))).not.toContain('unsafe-eval');
  });

  it('allows unsafe-eval in development, so React can rebuild error stacks', async () => {
    expect(scriptSrcOf(await cspFor('development'))).toContain('unsafe-eval');
  });

  it('keeps scripts to same-origin in both environments', async () => {
    for (const env of ['development', 'production']) {
      const scriptSrc = scriptSrcOf(await cspFor(env));
      expect(scriptSrc).toContain("'self'");
      // No external origin may ever supply a script, in either environment.
      expect(scriptSrc).not.toMatch(/https?:\/\//);
      expect(scriptSrc).not.toContain('*');
    }
  });

  it('names worker-src explicitly for the service worker', async () => {
    // Browsers disagree about whether worker-src falls back to default-src, and the
    // PWA ships a service worker, so it is stated rather than inferred.
    expect(await cspFor('production')).toContain("worker-src 'self'");
  });

  it('keeps the rest of the policy closed in production', async () => {
    const csp = await cspFor('production');
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
  });

  /**
   * Token icons load only from our own `/api/token-icon/<address>`, so no
   * third-party image host is allowed. This is the static floor `next.config.mjs` sets for anything `middleware.ts` does not
   * match (e.g. `/api/`); `middleware.test.ts` checks the per-request policy.
   */
  it('keeps img-src to our own origin: token icons come from /api/token-icon', async () => {
    const csp = await cspFor('production');
    const imgSrc = csp.split('; ').find((d) => d.startsWith('img-src')) ?? '';
    expect(imgSrc.split(' ').filter(Boolean)).toEqual(['img-src', "'self'", 'data:']);
  });
});
