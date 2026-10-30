const POST_AUTH_REDIRECT_KEY = 'rallyrank.postAuthRedirect';

/** Safe in-app path only (blocks open redirects). */
export function sanitizeAppPath(path: string | null | undefined, fallback = '/onboarding'): string {
  if (!path) return fallback;
  const trimmed = path.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return fallback;
  if (trimmed.startsWith('/auth')) return fallback;
  return trimmed;
}

export function savePostAuthRedirect(path: string) {
  const safe = sanitizeAppPath(path, '');
  if (!safe) return;
  try {
    sessionStorage.setItem(POST_AUTH_REDIRECT_KEY, safe);
  } catch {
    /* ignore */
  }
}
