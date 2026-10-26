const cachePrefix = 'ocms-offline-';
const cacheName = `${cachePrefix}__VERSION__`;
const offlinePaths = ['/offline.html', '/offline.css'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(cacheName)
      .then((cache) =>
        cache.addAll(
          offlinePaths.map(
            (path) =>
              new Request(path, { cache: 'reload', credentials: 'omit' }),
          ),
        ),
      ),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith(cachePrefix) && name !== cacheName)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Never intercept API, auth, media, or Range requests. Only public offline
  // resources are persisted; authenticated responses always need the server.
  if (offlinePaths.includes(url.pathname) && !url.search) {
    event.respondWith(
      caches
        .open(cacheName)
        .then(
          async (cache) => (await cache.match(url.pathname)) || fetch(request),
        ),
    );
  } else if (request.mode === 'navigate' && url.pathname === '/') {
    event.respondWith(
      fetch(request).catch(async () => {
        const cache = await caches.open(cacheName);
        return (await cache.match('/offline.html')) || Response.error();
      }),
    );
  }
});
