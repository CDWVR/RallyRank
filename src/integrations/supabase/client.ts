import { createLocalClient } from './local/client';
import { createRemoteClient, type AppClient } from './remote/client';

/**
 * `VITE_BACKEND=local` keeps all data in this browser (offline demo / GitHub Pages).
 * Otherwise the app talks to its own server: PostgREST at /rest and auth at /api/auth.
 */
export const isLocalSupabase = import.meta.env.VITE_BACKEND === 'local';

export const supabase: AppClient = isLocalSupabase
  ? (createLocalClient() as unknown as AppClient)
  : createRemoteClient();
