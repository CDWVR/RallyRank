// @vitest-environment node
// Static hosting and /rest proxy behaviour; needs no database.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';

const pool = {} as Pool;
const JWT_SECRET = 'test-only-jwt-secret-0123456789abcdef0123';

describe('static hosting', () => {
  let distDir: string;
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-dist-'));
    fs.mkdirSync(path.join(distDir, 'assets'));
    fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><div id="root"></div>');
    fs.writeFileSync(path.join(distDir, 'assets', 'index-abc123.js'), 'console.log(1)');
    app = createApp({ pool, jwtSecret: JWT_SECRET, postgrestUrl: 'http://127.0.0.1:9', distDir });
  });
  afterAll(() => fs.rmSync(distDir, { recursive: true, force: true }));

  it('serves fingerprinted assets as immutable', async () => {
    const res = await app.request('/assets/index-abc123.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('immutable');
  });

  it('serves index.html for client-side routes', async () => {
    for (const route of ['/', '/app/ladder', '/ladder/abc123', '/join/ABCD1234']) {
      const res = await app.request(route);
      expect(res.status, route).toBe(200);
      expect(await res.text()).toContain('id="root"');
    }
  });

  it('404s a missing file instead of returning index.html', async () => {
    // An old build's chunk returned as HTML would be executed as a script and blank the page.
    for (const missing of ['/assets/index-old999.js', '/app/manifest.webmanifest', '/favicon-nope.svg']) {
      const res = await app.request(missing);
      expect(res.status, missing).toBe(404);
      expect(res.headers.get('content-type') ?? '').not.toContain('text/html');
    }
  });
});

describe('/rest proxy', () => {
  it('answers 502 with a readable message when PostgREST is unreachable', async () => {
    // Port 9 (discard) is closed, so the connection is refused immediately.
    const app = createApp({ pool, jwtSecret: JWT_SECRET, postgrestUrl: 'http://127.0.0.1:9' });
    const res = await app.request('/rest/clubs?select=id');
    expect(res.status).toBe(502);
    expect((await res.json()).message).toMatch(/unavailable/i);
  });

  it('warns that a failed write may already have been saved', async () => {
    const app = createApp({ pool, jwtSecret: JWT_SECRET, postgrestUrl: 'http://127.0.0.1:9' });
    const res = await app.request('/rest/rpc/log_match', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(502);
    expect((await res.json()).message).toMatch(/may or may not have been saved/i);
  });
});
