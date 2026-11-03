import { PostgrestClient } from '@supabase/postgrest-js';
import type { Database } from '../types';
import { createRemoteAuth, type RemoteAuth } from './auth';

function withBearer(init: RequestInit | undefined, token: string | null): RequestInit {
  const headers = new Headers(init?.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  else headers.delete('Authorization');
  return { ...init, headers };
}

// A 401 that survives a successful refresh means PostgREST rejects even fresh tokens (a server-side JWT
// secret or audience mismatch). Refreshing again can't help, and doing it on every request turned into a
// refresh -> re-render -> request loop (hundreds of refreshes per second), so after that we stop
// refreshing on 401 for a while.
export const REFRESH_ON_401_COOLDOWN_MS = 30_000;

/** fetch for PostgREST: attaches the access token and, if the server says it expired, refreshes once and retries. */
export function createAuthedFetch(
  remote: Pick<RemoteAuth, 'getAccessToken' | 'refresh'>,
  now: () => number = Date.now
): typeof fetch {
  let cooldownUntil = -Infinity;
  // Requests that hit 401 together share one refresh instead of failing or refreshing again.
  let inflight: Promise<string | null> | null = null;

  return async (input, init) => {
    const token = await remote.getAccessToken();
    const res = await fetch(input, withBearer(init, token));
    if (res.status !== 401 || !token) return res;

    // Another request may already have refreshed (or be refreshing): reuse its token.
    const current = inflight ? await inflight : await remote.getAccessToken();
    if (current && current !== token) return fetch(input, withBearer(init, current));
    if (now() < cooldownUntil) return res;

    inflight ??= remote
      .refresh()
      .then((s) => s?.access_token ?? null)
      .finally(() => {
        inflight = null;
      });
    const fresh = await inflight;
    // No new token: signed out, or a network error kept the old session. Not proof of misconfiguration,
    // so no cooldown; the next request may well succeed once the network is back.
    if (!fresh || fresh === token) return res;

    const retry = await fetch(input, withBearer(init, fresh));
    if (retry.status === 401) cooldownUntil = now() + REFRESH_ON_401_COOLDOWN_MS;
    return retry;
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
