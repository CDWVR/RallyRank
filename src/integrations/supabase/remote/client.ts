import { PostgrestClient } from '@supabase/postgrest-js';
import type { Database } from '../types';
import { createRemoteAuth, type RemoteAuth } from './auth';

function withBearer(init: RequestInit | undefined, token: string | null): RequestInit {
  const headers = new Headers(init?.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  else headers.delete('Authorization');
  return { ...init, headers };
}

/** fetch for PostgREST: attaches the access token and, if the server says it expired, refreshes once and retries. */
export function createAuthedFetch(remote: Pick<RemoteAuth, 'getAccessToken' | 'refresh'>): typeof fetch {
  return async (input, init) => {
    const token = await remote.getAccessToken();
    const res = await fetch(input, withBearer(init, token));
    if (res.status !== 401 || !token) return res;
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
