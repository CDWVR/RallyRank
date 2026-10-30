import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './types';
import { createLocalClient } from './local/client';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;

const SUPABASE_KEY =
  (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined) ||
  (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined);

function looksConfigured(url?: string, key?: string): boolean {
  if (!url?.trim() || !key?.trim()) return false;
  if (/YOUR_PROJECT|example\.supabase|localhost-placeholder/i.test(url)) return false;
  if (/^sb_publishable_x+$/i.test(key) || key.includes('xxxxxxxx')) return false;
  return true;
}

export const isLocalSupabase = !looksConfigured(SUPABASE_URL, SUPABASE_KEY);

export const supabase = (
  isLocalSupabase
    ? createLocalClient()
    : createClient<Database>(SUPABASE_URL!, SUPABASE_KEY!)
) as SupabaseClient<Database>;
