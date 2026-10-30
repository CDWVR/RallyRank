import type { AuthApi, AuthChangeEvent, AuthError, AuthListener, AuthSession } from '../authTypes';

/**
 * Talks to the web server's /api/auth. The access token lives only in memory; the refresh token is an
 * httpOnly cookie the browser sends to /api/auth, so a page load restores the session via /refresh.
 */

// Refresh this long before the access token expires, so requests never race the expiry.
const REFRESH_MARGIN_SECONDS = 60;
const CHANNEL = 'rallyrank.auth';

function authError(message: string, status: number): AuthError {
  return { name: 'AuthApiError', message, status };
}

export function createRemoteAuth(baseUrl = '/api/auth') {
  let session: AuthSession | null = null;
  let restored: Promise<void> | null = null;
  let refreshing: Promise<AuthSession | null> | null = null;
  const listeners = new Set<AuthListener>();
  // Keeps other tabs in step on sign-in/out; unsupported environments just skip it.
  const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL);

  function setSession(next: AuthSession | null, event: AuthChangeEvent, broadcast = true) {
    session = next;
    listeners.forEach((fn) => fn(event, next));
    if (broadcast && (event === 'SIGNED_IN' || event === 'SIGNED_OUT')) channel?.postMessage(event);
  }

  async function call(path: string, body?: unknown): Promise<{ data: { session?: AuthSession } | null; error: AuthError | null }> {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      return { data: null, error: authError('Network error. Check your connection and try again.', 0) };
    }
    if (res.status === 204) return { data: null, error: null };
    const json = await res.json().catch(() => null);
    if (!res.ok) return { data: null, error: authError(json?.error?.message ?? 'Something went wrong.', res.status) };
    return { data: json, error: null };
  }

  /** One refresh at a time per tab; concurrent callers share the result. */
  function refresh(): Promise<AuthSession | null> {
    refreshing ??= call('/refresh')
      .then(({ data, error }) => {
        if (data?.session) {
          setSession(data.session, session ? 'TOKEN_REFRESHED' : 'SIGNED_IN', false);
          return data.session;
        }
        // A network blip keeps the current session; only a definite rejection signs the user out.
        if (error?.status === 0) return session;
        if (session) setSession(null, 'SIGNED_OUT', false);
        return null;
      })
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  }

  function ensureRestored(): Promise<void> {
    restored ??= refresh().then(() => undefined);
    return restored;
  }

  channel?.addEventListener('message', (e: MessageEvent<AuthChangeEvent>) => {
    if (e.data === 'SIGNED_OUT') setSession(null, 'SIGNED_OUT', false);
    if (e.data === 'SIGNED_IN') void refresh();
  });

  /** A token valid for at least the refresh margin, or null when signed out. */
  async function getAccessToken(): Promise<string | null> {
    await ensureRestored();
    if (session && session.expires_at - REFRESH_MARGIN_SECONDS <= Date.now() / 1000) await refresh();
    return session?.access_token ?? null;
  }

  async function signIn(path: string, body: unknown) {
    const { data, error } = await call(path, body);
    if (error || !data?.session) return { data: { user: null, session: null }, error };
    restored = Promise.resolve();
    setSession(data.session, 'SIGNED_IN');
    return { data: { user: data.session.user, session: data.session }, error: null };
  }

  const auth: AuthApi = {
    async getSession() {
      await getAccessToken();
      return { data: { session }, error: null };
    },

    async getUser() {
      await ensureRestored();
      return { data: { user: session?.user ?? null }, error: null };
    },

    onAuthStateChange(callback) {
      listeners.add(callback);
      void ensureRestored().then(() => {
        if (listeners.has(callback)) callback('INITIAL_SESSION', session);
      });
      return { data: { subscription: { unsubscribe: () => void listeners.delete(callback) } } };
    },

    signUp: ({ email, password, options }) => signIn('/signup', { email, password, data: options?.data }),

    signInWithPassword: ({ email, password }) => signIn('/login', { email, password }),

    async signOut() {
      const { error } = await call('/logout');
      setSession(null, 'SIGNED_OUT');
      return { error };
    },
  };

  return { auth, getAccessToken, refresh };
}

export type RemoteAuth = ReturnType<typeof createRemoteAuth>;
