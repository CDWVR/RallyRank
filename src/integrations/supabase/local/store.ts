import type { Database, Json } from '../types';

type Tables = Database['public']['Tables'];

export type LocalTableName = keyof Tables;

export type AuthUserRow = {
  id: string;
  email: string;
  password: string;
  created_at: string;
};

export type LocalDb = {
  auth_users: AuthUserRow[];
  profiles: Tables['profiles']['Row'][];
  clubs: Tables['clubs']['Row'][];
  memberships: Tables['memberships']['Row'][];
  invites: Tables['invites']['Row'][];
  seasons: Tables['seasons']['Row'][];
  players: Tables['players']['Row'][];
  matches: Tables['matches']['Row'][];
  match_history: Tables['match_history']['Row'][];
  pair_ratings: Tables['pair_ratings']['Row'][];
  pair_match_history: Tables['pair_match_history']['Row'][];
  club_sessions: Tables['club_sessions']['Row'][];
  session_templates: Tables['session_templates']['Row'][];
};

const DB_KEY = 'rallyrank.local.db';
const SESSION_KEY = 'rallyrank.local.session';

export type LocalSessionBlob = {
  access_token: string;
  user_id: string;
  email: string;
};

export function emptyDb(): LocalDb {
  return {
    auth_users: [],
    profiles: [],
    clubs: [],
    memberships: [],
    invites: [],
    seasons: [],
    players: [],
    matches: [],
    match_history: [],
    pair_ratings: [],
    pair_match_history: [],
    club_sessions: [],
    session_templates: [],
  };
}

export function loadDb(): LocalDb {
  try {
    const raw = localStorage.getItem(DB_KEY);
    if (!raw) return emptyDb();
    return { ...emptyDb(), ...(JSON.parse(raw) as Partial<LocalDb>) };
  } catch {
    return emptyDb();
  }
}

export function saveDb(db: LocalDb): void {
  localStorage.setItem(DB_KEY, JSON.stringify(db));
}

export function mutateDb(fn: (db: LocalDb) => void): LocalDb {
  const db = loadDb();
  fn(db);
  saveDb(db);
  return db;
}

export function loadSession(): LocalSessionBlob | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as LocalSessionBlob;
  } catch {
    return null;
  }
}

export function saveSession(session: LocalSessionBlob | null): void {
  if (!session) {
    localStorage.removeItem(SESSION_KEY);
    return;
  }
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function resetLocalData(): void {
  localStorage.removeItem(DB_KEY);
  localStorage.removeItem(SESSION_KEY);
}

/** UUID v4 — works on HTTP LAN hosts where crypto.randomUUID is unavailable. */
export function uid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function asJson(value: unknown): Json {
  return value as Json;
}
