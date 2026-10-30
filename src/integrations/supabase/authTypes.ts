/** Auth shapes shared by the remote (Railway) and local backends: the subset of Supabase's the app reads. */

export interface AuthUser {
  id: string;
  email: string;
  user_metadata: Record<string, unknown>;
  created_at: string;
}

export interface AuthSession {
  access_token: string;
  token_type: 'bearer';
  /** Unix seconds. */
  expires_at: number;
  user: AuthUser;
}

export type AuthChangeEvent = 'INITIAL_SESSION' | 'SIGNED_IN' | 'SIGNED_OUT' | 'TOKEN_REFRESHED';

export interface AuthError {
  name: 'AuthApiError';
  message: string;
  status: number;
}

export type AuthListener = (event: AuthChangeEvent, session: AuthSession | null) => void;

type SessionResult = { data: { user: AuthUser | null; session: AuthSession | null }; error: AuthError | null };

export interface AuthApi {
  getSession(): Promise<{ data: { session: AuthSession | null }; error: AuthError | null }>;
  getUser(): Promise<{ data: { user: AuthUser | null }; error: AuthError | null }>;
  onAuthStateChange(callback: AuthListener): { data: { subscription: { unsubscribe(): void } } };
  signUp(args: { email: string; password: string; options?: { data?: Record<string, unknown> } }): Promise<SessionResult>;
  signInWithPassword(args: { email: string; password: string }): Promise<SessionResult>;
  signOut(): Promise<{ error: AuthError | null }>;
}
