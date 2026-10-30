import { createHash, randomBytes } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';

export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
// Two tabs refreshing at once both present the same token; within this window the second one is not treated as theft.
export const REFRESH_REUSE_GRACE_SECONDS = 10;

const AUDIENCE = 'authenticated';

export interface AccessClaims {
  sub: string;
  email: string;
}

/** HS256 JWT in the shape PostgREST expects: `role` picks the DB role, `sub` feeds auth.uid(). */
export async function signAccessToken(claims: AccessClaims, secret: string, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const exp = iat + ACCESS_TOKEN_TTL_SECONDS;
  const token = await new SignJWT({ email: claims.email, role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.sub)
    .setAudience(AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(new TextEncoder().encode(secret));
  return { token, expiresAt: exp };
}

/** Returns the user id, or null for any invalid, expired or foreign token. */
export async function verifyAccessToken(token: string, secret: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      algorithms: ['HS256'],
      audience: AUDIENCE,
    });
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

export function newRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Only this hash is stored, so a database leak doesn't hand out live sessions. */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
