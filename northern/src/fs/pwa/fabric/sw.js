// Bump it whenever a cached file changes, so every device fetches the new set -
// and with it the ?v= on every script and stylesheet in index.html.
const CACHE_NAME = 'fabric-draw-v11';
const urlsToCache = [
  './index.html',
  './styles.css',
  './fabric.js',
  './lib/fabric.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

const shell = urlsToCache.map((url) => new URL(url, self.location.href).href);

self.addEventListener('install', (event) => {
  // Past the browser's HTTP cache, which may hold another version's files.
  event.waitUntil(caches.open(CACHE_NAME).then((cache) =>
    cache.addAll(urlsToCache.map((url) => new Request(url, { cache: 'reload' })))));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(
      names.map((name) => { if (name.startsWith('fabric-') && name !== CACHE_NAME) return caches.delete(name); })
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Only the page's own files: everything else is Northern's business.
  if (event.request.method !== 'GET' || shell.indexOf(event.request.url.split(/[?#]/)[0]) === -1) return;

  // The network first: Northern serves its pages no-cache because they are
  // edited in place. The cached copy is for when there is no network.
  event.respondWith(
    fetch(event.request).then((response) => {
      if (response && response.status === 200 && response.type === 'basic') {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
      }
      return response;
    }).catch(() => caches.match(event.request, { ignoreSearch: true }))
  );
});
