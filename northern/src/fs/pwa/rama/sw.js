// What a reminder needs: the model to find what is due, and the store it is kept in.
importScripts('./version.js', './model.js', './store.js', './remind.js');

// Named after the app's version, which index.html shows: bump it in version.js.
const CACHE_NAME = 'rama-v' + RAMA_VERSION;
const urlsToCache = [
  './index.html',
  './styles.css',
  './version.js',
  './model.js',
  './store.js',
  './remind.js',
  './views.js',
  './rama.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  // The Northern identity scripts the page loads to know who is signed in.
  '../../reg/sjcl.js',
  '../../reg/cookies.js',
  '../../reg/oo.js',
  '../../reg/idcard.js',
  '../../reg/session.js'
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
      names.map((name) => { if (name.startsWith('rama-') && name !== CACHE_NAME) return caches.delete(name); })
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

// Chrome wakes an installed app now and then (the page registers for it):
// whatever came due while no page was open is shown then. A worker knows no
// user, so it shows the reminders of everybody who records on this device.
self.addEventListener('periodicsync', (event) => {
  if (event.tag !== RamaModel.SYNC_TAG) return;
  event.waitUntil(RamaRemind.fire(
    (title, options) => self.registration.showNotification(title, options), Date.now()));
});

// A reminder clicked: its recording, in the page that is open or a new one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const id = event.notification.data && event.notification.data.id;
  const page = new URL('./index.html', self.location.href).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if (client.url.split(/[?#]/)[0] === page && 'focus' in client) {
          if (id) client.postMessage({ type: 'rama:open', id: id });
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(id ? page + '#note=' + id : page);
    })
  );
});
