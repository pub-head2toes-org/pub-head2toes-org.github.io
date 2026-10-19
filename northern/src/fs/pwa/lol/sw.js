// Bump it whenever a cached file changes, so every device fetches the new set -
// and with it the ?v= on every script and stylesheet in index.html.
const CACHE_NAME = 'lol-v5';
const VERSION = '?v=' + CACHE_NAME.split('-v')[1];
const OBJECTS_LIST = './objects/objects.json';
const urlsToCache = [
  './index.html',
  './error.html',
  './lol.js' + VERSION,
  './bots.js' + VERSION,
  './styles.css' + VERSION,
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './objects/tree.png',
  './objects/blossom.png',
  './objects/rock.png',
  './objects/tower.png',
  './objects/building.png',
  './objects/hotel-sign.png'
];

self.addEventListener('install', (event) => {
  // Past the browser's HTTP cache, which may hold another version's files.
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(urlsToCache.map((url) => new Request(url, { cache: 'reload' }))))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => Promise.all(
      cacheNames.map((cacheName) => {
        if (cacheName !== CACHE_NAME) return caches.delete(cacheName);
      })
    ))
  );
  self.clients.claim();
});

function cacheCopy(request, response) {
  if (!response || response.status !== 200 || response.type !== 'basic') return;
  const responseToCache = response.clone();
  caches.open(CACHE_NAME).then((cache) => cache.put(request, responseToCache));
}

self.addEventListener('fetch', (event) => {
  // Never cache the pub/sub endpoints (SSE stream and PUT messages).
  if (event.request.url.includes('/sub/')) return;

  // The objects list is edited in place on the server: network first, the
  // cached copy only for when there is no network.
  if (event.request.url.split(/[?#]/)[0] === new URL(OBJECTS_LIST, self.location.href).href) {
    event.respondWith(
      fetch(event.request).then((response) => {
        cacheCopy(event.request, response);
        return response;
      }).catch(() => caches.match(event.request, { ignoreSearch: true }))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((response) => {
      if (response) return response;
      return fetch(event.request).then((response) => {
        cacheCopy(event.request, response);
        return response;
      });
    })
  );
});
