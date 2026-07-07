var cacheName = 'muse-v2026.07.07-3';
var filesToCache = [
  './index.html',
  './index.js',
  './viewSetup.html',
  './viewSetup.js',
  './upload.html',
  './upload.js',
  './details.html',
  './details.js',
  './edit.html',
  './edit.js',
  './additional.html',
  './additional.js',
  './download.html',
  './download.js',
  './muse.js',
  './style.css',
  './manifest.json',
  './sw.js'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(cacheName).then(function (cache) {
      return cache.addAll(filesToCache);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (cacheNames) {
      return Promise.all(
        cacheNames.map(function (thisCacheName) {
          if (thisCacheName !== cacheName) {
            return caches.delete(thisCacheName);
          }
        })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (event) {
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then(function (response) {
      if (response) { return response; }
      return fetch(event.request).then(function (networkResponse) {
        if (networkResponse && networkResponse.status === 200) {
          var responseToCache = networkResponse.clone();
          caches.open(cacheName).then(function (cache) {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      }).catch(function () {
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });
    })
  );
});
