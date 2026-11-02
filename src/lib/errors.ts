/**
 * Turns anything a failed call can produce into a message worth showing.
 *
 * postgrest-js returns errors as plain parsed JSON (`{ code, message, details, hint }`), not `Error`
 * instances, so `err instanceof Error ? err.message : fallback` silently drops the real reason (that is
 * how "Could not create club" hid a server misconfiguration). Known PostgREST/Postgres codes get a plain
 * explanation; anything else keeps its own message.
 */
export function describeError(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (typeof err === 'string') return err || fallback;
  if (!err || typeof err !== 'object') return fallback;

  const { code, message } = err as { code?: unknown; message?: unknown };
  const text = typeof message === 'string' ? message.trim() : '';

  switch (code) {
    // JWT rejected by PostgREST: a server-side secret/audience mismatch, not something the user can fix.
    case 'PGRST300':
    case 'PGRST301':
    case 'PGRST302':
    case 'PGRST303':
      return 'The database service rejected your session. This is a server configuration problem: an admin can see the cause at /api/health.';
    // Schema cache missing a table/function: usually right after a deploy, before PostgREST reloads.
    case 'PGRST202':
    case 'PGRST205':
    case '42883':
      return 'The server is still updating. Please try again in a minute.';
    case '42501':
      return "You don't have permission to do that.";
    // PostgREST can't reach or query its database.
    case 'PGRST000':
    case 'PGRST001':
    case 'PGRST002':
      return 'The database service is unavailable right now. If this persists, an admin can see the cause at /api/health.';
  }

  if (/failed to fetch|networkerror|load failed|fetcherror/i.test(text)) {
    return "Can't reach the server. Check your connection and try again.";
  }
  return text || fallback;
}
