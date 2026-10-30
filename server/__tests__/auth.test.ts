// @vitest-environment node
// Integration tests: need the local stack (`docker compose up -d` + `npm run migrate`).
// Run with `npm run test:server` (reads .env); skipped when no database URL is set.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import { REFRESH_COOKIE } from '../auth.ts';
import { signAccessToken } from '../tokens.ts';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const POSTGREST_URL = process.env.POSTGREST_URL ?? 'http://localhost:3001';
// Must match PGRST_JWT_SECRET in docker-compose.yml.
const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-only-jwt-secret-change-me-0123456789abcdef';

describe.skipIf(!DATABASE_URL)('auth API (integration)', () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    // The suite signs up many users from one "IP"; rate limiting has its own test below.
    app = createApp({ pool, jwtSecret: JWT_SECRET, postgrestUrl: POSTGREST_URL, rateLimit: { limit: 1000, windowMs: 60_000 } });
  });
  afterAll(() => pool.end());

  const email = () => `user-${randomUUID()}@example.test`;
  const PASSWORD = 'correct-horse-battery';

  function post(path: string, body?: unknown, cookie?: string) {
    return app.request(`/api/auth${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  function refreshCookie(res: Response): string {
    const header = res.headers.get('set-cookie') ?? '';
    const match = header.match(new RegExp(`${REFRESH_COOKIE}=([^;]*)`));
    if (!match) throw new Error(`no refresh cookie in: ${header}`);
    return `${REFRESH_COOKIE}=${match[1]}`;
  }

  it('signs up, creates the profile via trigger, and returns a session', async () => {
    const addr = email();
    const res = await post('/signup', { email: addr, password: PASSWORD, data: { username: 'Ada L', first_name: 'Ada' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session.access_token).toBeTruthy();
    expect(body.user.email).toBe(addr);

    const setCookie = res.headers.get('set-cookie')!;
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toMatch(/Path=\/api\/auth/);

    const { rows } = await pool.query('select username from public.profiles where id = $1', [body.user.id]);
    expect(rows[0]?.username).toBe('Ada L');
  });

  it('rejects a duplicate email regardless of case', async () => {
    const addr = email();
    expect((await post('/signup', { email: addr, password: PASSWORD })).status).toBe(200);
    const dup = await post('/signup', { email: addr.toUpperCase(), password: PASSWORD });
    expect(dup.status).toBe(409);
  });

  it('rejects short passwords and malformed bodies', async () => {
    expect((await post('/signup', { email: email(), password: 'short' })).status).toBe(400);
    expect((await post('/signup', { nope: true })).status).toBe(400);
    expect((await post('/login', 'not json')).status).toBe(400);
  });

  it('gives the same error for a wrong password and an unknown email', async () => {
    const addr = email();
    await post('/signup', { email: addr, password: PASSWORD });
    const wrongPw = await post('/login', { email: addr, password: 'wrong-password' });
    const noUser = await post('/login', { email: email(), password: PASSWORD });
    expect(wrongPw.status).toBe(400);
    expect(noUser.status).toBe(400);
    expect(await wrongPw.json()).toEqual(await noUser.json());

    expect((await post('/login', { email: addr, password: PASSWORD })).status).toBe(200);
  });

  it('rotates refresh tokens and revokes the whole family when an old one is replayed', async () => {
    const signup = await post('/signup', { email: email(), password: PASSWORD });
    const first = refreshCookie(signup);

    const r1 = await post('/refresh', undefined, first);
    expect(r1.status).toBe(200);
    const second = refreshCookie(r1);
    expect(second).not.toBe(first);

    // Push the first token's revocation outside the grace window, then replay it.
    await pool.query(
      `update auth.refresh_tokens set revoked_at = now() - interval '1 minute' where revoked_at is not null
       and family_id = (select family_id from auth.refresh_tokens where token_hash = encode(sha256($1::bytea), 'hex'))`,
      [first.split('=')[1]]
    );
    expect((await post('/refresh', undefined, first)).status).toBe(401);
    // The legitimate newer token was revoked with the family.
    expect((await post('/refresh', undefined, second)).status).toBe(401);
  });

  it('tolerates two tabs refreshing the same token at once', async () => {
    const cookie = refreshCookie(await post('/signup', { email: email(), password: PASSWORD }));
    const [a, b] = await Promise.all([post('/refresh', undefined, cookie), post('/refresh', undefined, cookie)]);
    expect([a.status, b.status]).toEqual([200, 200]);
  });

  it('logout revokes the session and clears the cookie', async () => {
    const cookie = refreshCookie(await post('/signup', { email: email(), password: PASSWORD }));
    const out = await post('/logout', undefined, cookie);
    expect(out.status).toBe(204);
    expect(out.headers.get('set-cookie')).toMatch(/Max-Age=0/);
    expect((await post('/refresh', undefined, cookie)).status).toBe(401);
  });

  it('GET /user requires a valid access token', async () => {
    const { session } = await (await post('/signup', { email: email(), password: PASSWORD })).json();
    const ok = await app.request('/api/auth/user', { headers: { authorization: `Bearer ${session.access_token}` } });
    expect(ok.status).toBe(200);
    expect((await app.request('/api/auth/user')).status).toBe(401);
    expect((await app.request('/api/auth/user', { headers: { authorization: 'Bearer junk' } })).status).toBe(401);
  });

  it('rate limits login attempts per IP', async () => {
    const limited = createApp({ pool, jwtSecret: JWT_SECRET, postgrestUrl: POSTGREST_URL, rateLimit: { limit: 2, windowMs: 60_000 } });
    const attempt = (ip: string) =>
      limited.request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `9.9.9.9, ${ip}` },
        body: JSON.stringify({ email: 'nobody@example.test', password: PASSWORD }),
      });
    expect((await attempt('1.1.1.1')).status).toBe(400);
    expect((await attempt('1.1.1.1')).status).toBe(400);
    expect((await attempt('1.1.1.1')).status).toBe(429);
    expect((await attempt('2.2.2.2')).status).toBe(400);
  });

  describe('through the /rest proxy to PostgREST', () => {
    const rpc = (fn: string, args: unknown, token?: string) =>
      app.request(`/rest/rpc/${fn}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(args),
      });

    it('lets a signed-in user create a club, and RLS hides it from another user', async () => {
      const owner = (await (await post('/signup', { email: email(), password: PASSWORD })).json()).session.access_token;
      const other = (await (await post('/signup', { email: email(), password: PASSWORD })).json()).session.access_token;

      const created = await rpc('create_club', { p_name: 'RLS Test Club' }, owner);
      expect(created.status).toBe(200);
      const { id: clubId } = await created.json();

      const asOwner = await app.request(`/rest/clubs?id=eq.${clubId}`, { headers: { authorization: `Bearer ${owner}` } });
      expect(await asOwner.json()).toHaveLength(1);

      const asOther = await app.request(`/rest/clubs?id=eq.${clubId}`, { headers: { authorization: `Bearer ${other}` } });
      expect(await asOther.json()).toHaveLength(0);
      const asAnon = await app.request(`/rest/clubs?id=eq.${clubId}`);
      expect(await asAnon.json()).toHaveLength(0);

      // Regression for SEC-001: club_role() was NULL for non-members, so these guards failed open.
      expect((await rpc('rename_club', { p_club_id: clubId, p_name: 'pwned' }, other)).status).toBe(400);
      expect((await rpc('create_invite', { p_club_id: clubId, p_role: 'admin' }, other)).status).toBe(400);
      expect((await rpc('rotate_share_token', { p_club_id: clubId }, other)).status).toBe(400);
      const { rows } = await pool.query('select name from public.clubs where id = $1', [clubId]);
      expect(rows[0].name).toBe('RLS Test Club');
    });

    it('rejects forged and expired JWTs', async () => {
      const sub = randomUUID();
      const forged = (await signAccessToken({ sub, email: 'x@example.test' }, 'some-other-secret-that-is-long-enough-123')).token;
      expect((await rpc('create_club', { p_name: 'x' }, forged)).status).toBe(401);

      const expired = (await signAccessToken({ sub, email: 'x@example.test' }, JWT_SECRET, Date.now() - 2 * 60 * 60_000)).token;
      expect((await rpc('create_club', { p_name: 'x' }, expired)).status).toBe(401);
    });
  });
});
