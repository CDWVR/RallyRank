import { PostgrestClient } from '@supabase/postgrest-js';
import type { Database } from '../types';
import { createRemoteAuth, type RemoteAuth } from './auth';

function withBearer(init: RequestInit | undefined, token: string | null): RequestInit {
  const headers = new Headers(init?.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  else headers.delete('Authorization');
  return { ...init, headers };
}

// A 401 that survives a refresh means PostgREST rejects even fresh tokens (a server-side JWT secret or
// audience mismatch). Refreshing again can't help, and doing it on every request turned into a
// refresh -> re-render -> request loop (hundreds of refreshes per second), so allow one per window.
export const REFRESH_ON_401_COOLDOWN_MS = 30_000;

/** fetch for PostgREST: attaches the access token and, if the server says it expired, refreshes once and retries. */
export function createAuthedFetch(
  remote: Pick<RemoteAuth, 'getAccessToken' | 'refresh'>,
  now: () => number = Date.now
): typeof fetch {
  let lastRefreshAt = -Infinity;
  return async (input, init) => {
    const token = await remote.getAccessToken();
    const res = await fetch(input, withBearer(init, token));
    if (res.status !== 401 || !token) return res;
    if (now() - lastRefreshAt < REFRESH_ON_401_COOLDOWN_MS) return res;
    lastRefreshAt = now();
    const fresh = await remote.refresh();
    return fresh ? fetch(input, withBearer(init, fresh.access_token)) : res;
  };
}

/** Supabase-shaped client backed by the Railway server: same-origin /rest (PostgREST) and /api/auth. */
export function createRemoteClient(origin = window.location.origin) {
  const remote = createRemoteAuth(`${origin}/api/auth`);
  const rest = new PostgrestClient<Database>(`${origin}/rest`, { fetch: createAuthedFetch(remote) });
  return {
    auth: remote.auth,
    from: rest.from.bind(rest) as typeof rest.from,
    rpc: rest.rpc.bind(rest) as typeof rest.rpc,
  };
}

export type AppClient = ReturnType<typeof createRemoteClient>;
