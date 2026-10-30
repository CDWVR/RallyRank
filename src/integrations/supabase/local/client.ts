import { localAuth } from './auth';
import { fromTable } from './query';
import { callRpc } from './rpcs';
import type { LocalTableName } from './store';

/** Supabase-shaped client backed by localStorage (local mode). */
export function createLocalClient() {
  return {
    auth: localAuth,
    from(table: LocalTableName) {
      return fromTable(table);
    },
    rpc(fn: string, args?: Record<string, unknown>) {
      return callRpc(fn, args || {});
    },
  };
}

export type LocalClient = ReturnType<typeof createLocalClient>;
