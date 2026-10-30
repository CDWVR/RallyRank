import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRemoteAuth } from '../auth';
import { createAuthedFetch } from '../client';

const user = { id: 'u1', email: 'a@example.test', user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };

function session(token: string, expiresInSeconds = 3600) {
  return { access_token: token, token_type: 'bearer', expires_at: Math.floor(Date.now() / 1000) + expiresInSeconds, user };
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const unauthorized = () => json(401, { error: { message: 'Not signed in.' } });

describe('remote auth adapter', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    // Otherwise adapters from earlier tests hear this test's sign-ins across the shared channel.
    vi.stubGlobal('BroadcastChannel', undefined);
  });
  afterEach(() => vi.unstubAllGlobals());

  const calls = () => fetchMock.mock.calls.map(([url]) => String(url));

  it('restores the session from the refresh cookie once, however many callers ask', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { session: session('t1') }));
    const { auth } = createRemoteAuth('/api/auth');

    const [a, b] = await Promise.all([auth.getSession(), auth.getUser()]);
    expect(a.data.session?.access_token).toBe('t1');
    expect(b.data.user?.id).toBe('u1');
    expect(calls()).toEqual(['/api/auth/refresh']);
  });

  it('reports no session when there is no refresh cookie', async () => {
    fetchMock.mockResolvedValueOnce(unauthorized());
    const { auth } = createRemoteAuth('/api/auth');
    const listener = vi.fn();
    auth.onAuthStateChange(listener);

    expect((await auth.getSession()).data.session).toBeNull();
    await vi.waitFor(() => expect(listener).toHaveBeenCalledWith('INITIAL_SESSION', null));
  });

  it('signs in, notifies listeners, and returns the server error message on failure', async () => {
    fetchMock.mockResolvedValueOnce(json(400, { error: { message: 'Invalid email or password.' } }));
    const { auth } = createRemoteAuth('/api/auth');
    const bad = await auth.signInWithPassword({ email: 'a@example.test', password: 'nope' });
    expect(bad.error?.message).toBe('Invalid email or password.');

    // Subscribing restores the session first: no cookie yet.
    fetchMock.mockResolvedValueOnce(unauthorized());
    const listener = vi.fn();
    auth.onAuthStateChange(listener);
    await vi.waitFor(() => expect(listener).toHaveBeenCalledWith('INITIAL_SESSION', null));

    fetchMock.mockResolvedValueOnce(json(200, { session: session('t2') }));
    const ok = await auth.signInWithPassword({ email: 'a@example.test', password: 'right-password' });
    expect(ok.error).toBeNull();
    expect(listener).toHaveBeenCalledWith('SIGNED_IN', expect.objectContaining({ access_token: 't2' }));
  });

  it('refreshes ahead of expiry instead of sending a nearly expired token', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { session: session('old', 30) }))
      .mockResolvedValueOnce(json(200, { session: session('new') }));
    const remote = createRemoteAuth('/api/auth');
    expect(await remote.getAccessToken()).toBe('new');
  });

  it('keeps the session on a network error but drops it when the server rejects the refresh', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { session: session('t1') }));
    const remote = createRemoteAuth('/api/auth');
    await remote.getAccessToken();

    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect((await remote.refresh())?.access_token).toBe('t1');

    fetchMock.mockResolvedValueOnce(unauthorized());
    expect(await remote.refresh()).toBeNull();
    expect((await remote.auth.getSession()).data.session).toBeNull();
  });

  it('signOut clears the session even if the server call fails', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { session: session('t1') }));
    const { auth } = createRemoteAuth('/api/auth');
    await auth.getSession();

    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await auth.signOut();
    expect((await auth.getUser()).data.user).toBeNull();
  });
});

describe('authed fetch for PostgREST', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends the bearer token, and on 401 refreshes once and retries with the new token', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(json(200, []));
    vi.stubGlobal('fetch', fetchMock);
    const refresh = vi.fn().mockResolvedValue(session('fresh'));
    const authed = createAuthedFetch({ getAccessToken: async () => 'stale', refresh });

    const res = await authed('/rest/clubs', { headers: { Accept: 'application/json' } });
    expect(res.status).toBe(200);
    expect(refresh).toHaveBeenCalledTimes(1);
    const sent = fetchMock.mock.calls.map(([, init]) => new Headers(init.headers).get('Authorization'));
    expect(sent).toEqual(['Bearer stale', 'Bearer fresh']);
  });

  it('does not refresh for anonymous requests or when the refresh fails', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => unauthorized());
    vi.stubGlobal('fetch', fetchMock);

    const anon = createAuthedFetch({ getAccessToken: async () => null, refresh: vi.fn() });
    expect((await anon('/rest/clubs')).status).toBe(401);
    expect(new Headers(fetchMock.mock.calls[0][1].headers).has('Authorization')).toBe(false);

    const refresh = vi.fn().mockResolvedValue(null);
    const signedIn = createAuthedFetch({ getAccessToken: async () => 'stale', refresh });
    expect((await signedIn('/rest/clubs')).status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
