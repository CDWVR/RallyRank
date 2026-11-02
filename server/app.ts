import fs from 'node:fs';
import path from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import type { Pool } from 'pg';
import { authRoutes, type AuthRoutesOptions } from './auth.ts';

// Hop-by-hop and encoding headers must not be copied across the proxy: fetch() already decoded the body.
const STRIPPED_RESPONSE_HEADERS = ['content-encoding', 'content-length', 'transfer-encoding', 'connection'];
const STRIPPED_REQUEST_HEADERS = ['host', 'cookie', 'accept-encoding', 'connection', 'content-length'];

export interface AppOptions {
  pool: Pool;
  jwtSecret: string;
  postgrestUrl: string;
  /** Built SPA; omitted in tests. */
  distDir?: string;
  rateLimit?: AuthRoutesOptions['rateLimit'];
}

export function createApp({ pool, jwtSecret, postgrestUrl, distDir, rateLimit }: AppOptions) {
  const app = new Hono();

  app.onError((err, c) => {
    console.error(`${c.req.method} ${c.req.path} failed:`, err);
    return c.json({ error: { message: 'Internal server error' } }, 500);
  });

  app.route('/api/auth', authRoutes({ pool, jwtSecret, rateLimit }));
  app.all('/api/*', (c) => c.json({ error: { message: 'Not found' } }, 404));

  // PostgREST is only reachable on Railway's private network; the browser talks to it through here.
  const upstream = postgrestUrl.replace(/\/$/, '');
  app.all('/rest/*', async (c) => {
    const url = new URL(c.req.url);
    const headers = new Headers(c.req.raw.headers);
    for (const h of STRIPPED_REQUEST_HEADERS) headers.delete(h);
    const hasBody = !['GET', 'HEAD'].includes(c.req.method);

    let res: Response;
    try {
      res = await fetch(`${upstream}${url.pathname.slice('/rest'.length) || '/'}${url.search}`, {
        method: c.req.method,
        headers,
        body: hasBody ? c.req.raw.body : undefined,
        // Required by Node's fetch to stream a request body.
        ...(hasBody ? { duplex: 'half' } : {}),
        signal: AbortSignal.timeout(30_000),
      } as RequestInit);
    } catch (err) {
      // PostgREST down, unreachable or too slow: say so instead of a generic 500, so logs point at the right service.
      console.error(`PostgREST at ${upstream} unreachable for ${c.req.method} ${url.pathname}:`, err);
      // A timeout or reset can land after PostgREST committed, so a retried write could apply twice (e.g. log_match).
      const message = hasBody
        ? "The database service didn't respond, so this change may or may not have been saved. Refresh and check before trying again."
        : 'The database service is unavailable. Please try again shortly.';
      return c.json({ message }, 502);
    }

    const out = new Headers(res.headers);
    for (const h of STRIPPED_RESPONSE_HEADERS) out.delete(h);
    return new Response(res.body, { status: res.status, headers: out });
  });

  if (distDir) {
    const root = path.relative(process.cwd(), distDir) || '.';
    // Vite fingerprints everything under assets/; other files (index.html, sw.js) must revalidate.
    // Set on the finished response: serveStatic has already built it by the time its onFound hook runs.
    app.use('*', async (c, next) => {
      await next();
      if (c.res.status === 200 && c.res.headers.has('last-modified')) {
        c.res.headers.set('Cache-Control', c.req.path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
      }
    });
    app.use('*', serveStatic({ root }));
    // SPA fallback: client-side routes like /app/ladder get index.html. A missing file (an old build's
    // chunk, a mistyped icon path) gets a real 404: as HTML it would be run as a script and blank the page.
    const indexHtml = path.join(distDir, 'index.html');
    app.get('*', (c) => {
      if (c.req.path.startsWith('/assets/') || /\.[a-z0-9]+$/i.test(c.req.path)) return c.text('Not found', 404);
      c.header('Cache-Control', 'no-cache');
      return c.html(fs.readFileSync(indexHtml, 'utf8'));
    });
  }

  return app;
}
