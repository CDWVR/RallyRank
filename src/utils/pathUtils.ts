/**
 * Utility functions for handling paths in the application
 */

/**
 * Base path the app is served from, without a trailing slash: '' locally, '/RallyRank' on GitHub Pages.
 * Comes from Vite's `base` (VITE_BASE_URL at build time), so it is right on every page, not just the home page.
 */
export const getBaseUrl = (): string => import.meta.env.BASE_URL.replace(/\/$/, '');

/**
 * Resolve a path relative to the base URL
 * @param path The path to resolve
 * @returns The resolved path
 */
export const resolvePath = (path: string): string => {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${getBaseUrl()}${normalizedPath}`;
};
