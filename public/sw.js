/* RallyRank service worker: lets the installed app reopen offline without ever serving stale or wrong content. */
// Bump when this file's caching rules change; activate() deletes every other cache.
const CACHE = 'rallyrank-v2';
// Resolved against the worker's own URL, so this also works under a subpath (GitHub Pages).
const SCOPE = new URL('./', self.location).pathname;
const SHELL = new URL('./index.html', self.location).href;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.add(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Cross-origin (fonts, analytics) and the API/auth endpoints always go straight to the network.
  if (url.origin !== self.location.origin) return;
  const path = url.pathname.slice(SCOPE.length - 1);
  if (path.startsWith('/api/') || path.startsWith('/rest/')) return;

  if (request.mode === 'navigate') {
    // Network first, so a deploy is picked up on the next load; the cached shell is only the offline fallback.
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(SHELL, copy));
          }
          return res;
        })
        .catch(() => caches.match(SHELL).then((cached) => cached || Response.error()))
    );
    return;
  }

  // Fingerprinted build output never changes, so it is safe to serve from cache.
  if (path.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((cache) => cache.put(request, copy));
            }
            return res;
          })
      )
    );
  }
  // Everything else (manifest, icons, sw.js) uses the browser's normal HTTP caching.
});
