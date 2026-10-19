// Bump it whenever a cached file changes, so every device fetches the new set -
// and with it the ?v= on every script and stylesheet in index.html.
const CACHE_NAME = 'zine-v1';
const VERSION = '?v=' + CACHE_NAME.split('-v')[1];
const urlsToCache = [
  './index.html',
  './error.html',
  './zine.js' + VERSION,
  './styles.css' + VERSION,
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  // The Northern identity scripts the page loads to know who is signed in.
  '../../reg/sjcl.js' + VERSION,
  '../../reg/cookies.js' + VERSION,
  '../../reg/oo.js' + VERSION,
  '../../reg/idcard.js' + VERSION,
  '../../reg/session.js' + VERSION
];
// Each issue's objects list: edited in place on the server.
const OBJECTS_LIST = /\/objects\/[\w-]+\.json$/;

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
        if (cacheName.startsWith('zine-') && cacheName !== CACHE_NAME) return caches.delete(cacheName);
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
  // Only GETs: never the pub/sub endpoints (SSE stream and PUT messages).
  if (event.request.method !== 'GET' || event.request.url.includes('/sub/')) return;

  // The objects lists: network first, the cached copy only for when there is no network.
  if (OBJECTS_LIST.test(event.request.url.split(/[?#]/)[0])) {
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
