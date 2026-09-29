const CACHE_NAME = 'sezam-v1';
const urlsToCache = [
  './index.html',
  './error.html',
  './styles.css',
  './api.js',
  './format.js',
  './router.js',
  './views.js',
  './sezam.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(urlsToCache)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(
      names.map((name) => { if (name !== CACHE_NAME) return caches.delete(name); })
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // The archive itself is never cached here. It already answers with an ETag
  // and a day of max-age, so the browser's own cache revalidates it properly -
  // and a stale copy of a search result is worse than a slow one.
  if (event.request.url.indexOf('/api/sezam') !== -1) return;

  event.respondWith(
    caches.match(event.request).then((hit) => {
      if (hit) return hit;
      return fetch(event.request).then((response) => {
        if (!response || response.status !== 200 || response.type !== 'basic') return response;
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      });
    })
  );
});
