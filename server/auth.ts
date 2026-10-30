import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { DUMMY_HASH, hashPassword, verifyPassword } from './passwords.ts';
import { createRateLimiter } from './rateLimit.ts';
import {
  hashRefreshToken,
  newRefreshToken,
  REFRESH_REUSE_GRACE_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  signAccessToken,
  verifyAccessToken,
} from './tokens.ts';

export const REFRESH_COOKIE = 'rr_refresh';
const COOKIE_PATH = '/api/auth';

const credentials = z.object({
  email: z.email().max(254).transform((e) => e.trim().toLowerCase()),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
});

// Only the profile fields the signup form sends; anything else is dropped rather than stored.
const signupSchema = credentials.extend({
  data: z
    .object({
      first_name: z.string().trim().max(100).optional(),
      last_name: z.string().trim().max(100).optional(),
      phone: z.string().trim().max(40).optional(),
      username: z.string().trim().max(200).optional(),
    })
    .default({}),
});

interface UserRow {
  id: string;
  email: string;
  raw_user_meta_data: Record<string, unknown>;
  created_at: Date;
}

/** Subset of Supabase's User shape that the app reads. */
function toPublicUser(row: UserRow) {
  return {
    id: row.id,
    email: row.email,
    user_metadata: row.raw_user_meta_data,
    created_at: row.created_at.toISOString(),
  };
}

function authError(c: Context, status: 400 | 401 | 409 | 429, message: string) {
  return c.json({ error: { message } }, status);
}

/** Railway's edge appends the client address last; anything before it is client-controlled. */
function clientIp(c: Context): string {
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) return forwarded.split(',').pop()!.trim();
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  return incoming?.socket?.remoteAddress ?? 'unknown';
}

export interface AuthRoutesOptions {
  pool: Pool;
  jwtSecret: string;
  /** Per-IP attempts allowed per window on /login and /signup. */
  rateLimit?: { limit: number; windowMs: number };
}

export function authRoutes({ pool, jwtSecret, rateLimit = { limit: 10, windowMs: 15 * 60_000 } }: AuthRoutesOptions) {
  const allowLogin = createRateLimiter(rateLimit.limit, rateLimit.windowMs);
  const allowSignup = createRateLimiter(rateLimit.limit, rateLimit.windowMs);
  const app = new Hono();

  async function issueSession(c: Context, db: Pool | PoolClient, user: UserRow, familyId: string = randomUUID()) {
    const refreshToken = newRefreshToken();
    await db.query(
      `insert into auth.refresh_tokens (user_id, token_hash, family_id, expires_at)
       values ($1, $2, $3, now() + make_interval(secs => $4))`,
      [user.id, hashRefreshToken(refreshToken), familyId, REFRESH_TOKEN_TTL_SECONDS]
    );
    setCookie(c, REFRESH_COOKIE, refreshToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
      path: COOKIE_PATH,
      maxAge: REFRESH_TOKEN_TTL_SECONDS,
    });
    const { token, expiresAt } = await signAccessToken({ sub: user.id, email: user.email }, jwtSecret);
    const publicUser = toPublicUser(user);
    return { session: { access_token: token, token_type: 'bearer', expires_at: expiresAt, user: publicUser }, user: publicUser };
  }

  app.post('/signup', async (c) => {
    if (!allowSignup(clientIp(c))) return authError(c, 429, 'Too many attempts. Try again later.');
    const parsed = signupSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return authError(c, 400, parsed.error.issues[0].message);
    const { email, password, data } = parsed.data;

    let user: UserRow;
    try {
      const { rows } = await pool.query<UserRow>(
        `insert into auth.users (email, encrypted_password, raw_user_meta_data)
         values ($1, $2, $3)
         returning id, email, raw_user_meta_data, created_at`,
        [email, await hashPassword(password), data]
      );
      user = rows[0];
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        return authError(c, 409, 'An account with this email already exists.');
      }
      throw err;
    }
    return c.json(await issueSession(c, pool, user));
  });

  app.post('/login', async (c) => {
    if (!allowLogin(clientIp(c))) return authError(c, 429, 'Too many attempts. Try again later.');
    const parsed = credentials.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return authError(c, 400, 'Invalid email or password.');
    const { email, password } = parsed.data;

    const { rows } = await pool.query<UserRow & { encrypted_password: string }>(
      `select id, email, raw_user_meta_data, created_at, encrypted_password
       from auth.users where lower(email) = $1`,
      [email]
    );
    const row = rows[0];
    const ok = await verifyPassword(password, row?.encrypted_password ?? DUMMY_HASH);
    if (!row || !ok) return authError(c, 400, 'Invalid email or password.');
    return c.json(await issueSession(c, pool, row));
  });

  app.post('/refresh', async (c) => {
    const presented = getCookie(c, REFRESH_COOKIE);
    if (!presented) return authError(c, 401, 'Not signed in.');

    const db = await pool.connect();
    try {
      await db.query('begin');
      // Row lock serializes concurrent refreshes of the same token.
      const { rows } = await db.query<{
        id: string;
        user_id: string;
        family_id: string;
        expired: boolean;
        revoked: boolean;
        within_grace: boolean;
      }>(
        `select id, user_id, family_id,
                expires_at <= now() as expired,
                revoked_at is not null as revoked,
                revoked_at > now() - make_interval(secs => $2) as within_grace
         from auth.refresh_tokens where token_hash = $1 for update`,
        [hashRefreshToken(presented), REFRESH_REUSE_GRACE_SECONDS]
      );
      const token = rows[0];

      if (!token || token.expired || (token.revoked && !token.within_grace)) {
        if (token?.revoked) {
          // A long-revoked token coming back means it was copied: end every session from that login.
          // Deleted rather than revoked, so the reuse grace window can't revive them.
          await db.query('delete from auth.refresh_tokens where family_id = $1', [token.family_id]);
        }
        await db.query('commit');
        deleteCookie(c, REFRESH_COOKIE, { path: COOKIE_PATH });
        return authError(c, 401, 'Session expired. Please sign in again.');
      }

      if (!token.revoked) {
        await db.query('update auth.refresh_tokens set revoked_at = now() where id = $1', [token.id]);
      }
      const { rows: users } = await db.query<UserRow>(
        'select id, email, raw_user_meta_data, created_at from auth.users where id = $1',
        [token.user_id]
      );
      const body = await issueSession(c, db, users[0], token.family_id);
      await db.query('commit');
      return c.json(body);
    } catch (err) {
      await db.query('rollback');
      throw err;
    } finally {
      db.release();
    }
  });

  app.post('/logout', async (c) => {
    const presented = getCookie(c, REFRESH_COOKIE);
    if (presented) {
      // Deleted rather than revoked, so the reuse grace window can't bring a signed-out session back.
      await pool.query(
        `delete from auth.refresh_tokens
         where family_id = (select family_id from auth.refresh_tokens where token_hash = $1)`,
        [hashRefreshToken(presented)]
      );
    }
    deleteCookie(c, REFRESH_COOKIE, { path: COOKIE_PATH });
    return c.body(null, 204);
  });

  app.get('/user', async (c) => {
    const bearer = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
    const userId = bearer ? await verifyAccessToken(bearer, jwtSecret) : null;
    if (!userId) return authError(c, 401, 'Not signed in.');
    const { rows } = await pool.query<UserRow>(
      'select id, email, raw_user_meta_data, created_at from auth.users where id = $1',
      [userId]
    );
    if (!rows[0]) return authError(c, 401, 'Not signed in.');
    return c.json({ user: toPublicUser(rows[0]) });
  });

  return app;
}
