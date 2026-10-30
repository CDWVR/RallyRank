import type { AuthApi, AuthChangeEvent, AuthError, AuthListener, AuthSession, AuthUser } from '../authTypes';
import { ensureDemoClub } from './seed';
import {
  loadDb,
  loadSession,
  mutateDb,
  nowIso,
  saveSession,
  uid,
  type LocalSessionBlob,
} from './store';

const listeners = new Set<AuthListener>();

function authError(message: string): AuthError {
  return { name: 'AuthApiError', message, status: 400 };
}

function toUser(blob: { id: string; email: string }): AuthUser {
  return { id: blob.id, email: blob.email, user_metadata: {}, created_at: nowIso() };
}

function toSession(blob: LocalSessionBlob): AuthSession {
  return {
    access_token: blob.access_token,
    token_type: 'bearer',
    expires_at: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365,
    user: toUser({ id: blob.user_id, email: blob.email }),
  };
}

function emit(event: AuthChangeEvent, session: AuthSession | null) {
  listeners.forEach((fn) => fn(event, session));
}

function currentSession(): AuthSession | null {
  const blob = loadSession();
  return blob ? toSession(blob) : null;
}

export function getLocalAuthUid(): string | null {
  return loadSession()?.user_id ?? null;
}

export const localAuth: AuthApi = {
  async getSession() {
    return { data: { session: currentSession() }, error: null };
  },

  async getUser() {
    const session = currentSession();
    return { data: { user: session?.user ?? null }, error: null };
  },

  onAuthStateChange(callback: AuthListener) {
    listeners.add(callback);
    queueMicrotask(() => callback('INITIAL_SESSION', currentSession()));
    return {
      data: {
        subscription: {
          unsubscribe: () => {
            listeners.delete(callback);
          },
        },
      },
    };
  },

  async signUp(args: {
    email: string;
    password: string;
    options?: { data?: Record<string, unknown> };
  }) {
    const email = args.email.trim().toLowerCase();
    const password = args.password;
    if (!email || !password) {
      return { data: { user: null, session: null }, error: authError('Email and password required') };
    }

    const db = loadDb();
    if (db.auth_users.some((u) => u.email === email)) {
      return { data: { user: null, session: null }, error: authError('User already registered') };
    }

    const id = uid();
    const t = nowIso();
    const meta = args.options?.data || {};

    mutateDb((d) => {
      d.auth_users.push({ id, email, password, created_at: t });
      d.profiles.push({
        id,
        username: (meta.username as string) || email.split('@')[0],
        first_name: (meta.first_name as string) || null,
        last_name: (meta.last_name as string) || null,
        phone: (meta.phone as string) || null,
        avatar_url: null,
        created_at: t,
        updated_at: t,
      });
      ensureDemoClub(d, id);
    });

    const blob: LocalSessionBlob = {
      access_token: uid(),
      user_id: id,
      email,
    };
    saveSession(blob);
    const session = toSession(blob);
    emit('SIGNED_IN', session);
    return { data: { user: session.user, session }, error: null };
  },

  async signInWithPassword(args: { email: string; password: string }) {
    const email = args.email.trim().toLowerCase();
    const db = loadDb();
    const user = db.auth_users.find((u) => u.email === email && u.password === args.password);
    if (!user) {
      return { data: { user: null, session: null }, error: authError('Invalid login credentials') };
    }

    mutateDb((d) => ensureDemoClub(d, user.id));

    const blob: LocalSessionBlob = {
      access_token: uid(),
      user_id: user.id,
      email: user.email,
    };
    saveSession(blob);
    const session = toSession(blob);
    emit('SIGNED_IN', session);
    return { data: { user: session.user, session }, error: null };
  },

  async signOut() {
    saveSession(null);
    emit('SIGNED_OUT', null);
    return { error: null };
  },
};
