// What a push needs: the key the ID Card left on this device, the seal to
// open with it (Pals' own), the model to read the signal, and the store to
// keep what came and to name the caller.
importScripts('./version.js', '../../reg/keystore.js', '../pals/seal.js', './model.js', './store.js');

// Named after the app's version, which index.html shows: bump it in version.js.
const CACHE_NAME = 'inperson-v' + INPERSON_VERSION;
const urlsToCache = [
  './index.html',
  './welcome.html',
  './styles.css',
  './version.js',
  './model.js',
  './store.js',
  './views.js',
  './call.js',
  './inperson.js',
  './welcome.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  // Pals' seal: calls are set up sealed the way Pals seals messages.
  '../pals/seal.js',
  // The Northern identity scripts the pages load to know who is signed in.
  '../../reg/sjcl.js',
  '../../reg/cookies.js',
  '../../reg/oo.js',
  '../../reg/idcard.js',
  '../../reg/keystore.js',
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
      names.map((name) => { if (name !== CACHE_NAME) return caches.delete(name); })
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Only the pages' own files. Everything else is Northern - the directories,
  // the push and TURN APIs, the /sub/ channel - and none of the cache's business.
  if (event.request.method !== 'GET' || shell.indexOf(event.request.url.split(/[?#]/)[0]) === -1) return;

  // The network first; the cached copy is for when there is no network.
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

/** Opens a push here, with the key the ID Card left on this device; null when it does not open. */
function open(outer) {
  if (!outer || outer.v !== PalsSeal.VERSION || !NorthernKeys.available()) return Promise.resolve(null);
  return NorthernKeys.get(outer.to)
    .then((key) => key ? PalsSeal.open(key, outer) : null)
    .catch(() => null);
}

/** Who is calling, in words: the name the page last listed them under, if any. */
function caller(envelope) {
  return InPersonStore.get('contacts', envelope.to)
    .then((contacts) => InPersonModel.nameOf(contacts, envelope.from) || InPersonModel.label('Somebody', envelope.from))
    .catch(() => InPersonModel.label('Somebody', envelope.from));
}

function payloadOf(data) {
  try {
    const outer = data ? JSON.parse(data.text()) : null;
    return outer && typeof outer === 'object' ? outer : null;
  } catch (e) {
    return null;
  }
}

// A push is a ring or a cancel, sealed by the caller. It is opened here and
// kept in the inbox, opened or not, and any open page is told. The
// notification - which every push must show - says who is calling, and a
// cancel replaces it with a missed call. Clicking it opens the call.
self.addEventListener('push', (event) => {
  const payload = payloadOf(event.data);

  event.waitUntil(open(payload)
    .then((envelope) => {
      const item = { payload, at: Date.now() };
      if (envelope) item.envelope = envelope;
      const kept = payload ? InPersonStore.add('inbox', item).catch(() => null) : Promise.resolve();
      const signal = envelope ? InPersonModel.readSignal(envelope.body) : null;
      return Promise.all([kept, signal, signal ? caller(envelope) : '']);
    })
    .then(([, signal, name]) => Promise.all([
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
        windows.forEach((client) => client.postMessage({ type: 'inperson:push' }));
      }),
      signal && signal.t === 'ring'
        ? self.registration.showNotification('InPerson', {
          body: name + ' is calling',
          icon: './icon-192.png',
          tag: 'inperson-' + signal.call,
          requireInteraction: true,
          renotify: true,
          data: { call: signal.call }
        })
        : self.registration.showNotification('InPerson', signal
          ? { body: 'Missed call from ' + name, icon: './icon-192.png', tag: 'inperson-' + signal.call, data: {} }
          : { body: 'A call came in. Open InPerson to see who it was.', icon: './icon-192.png', tag: 'inperson', data: {} })
    ])));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const call = event.notification.data && event.notification.data.call;
  const page = new URL('./index.html', self.location.href).href;
  const url = call ? page + '#call=' + call : page;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if (client.url.split(/[?#]/)[0] === page && 'focus' in client) {
          // The page drains the inbox when told; the ring is in it.
          client.postMessage({ type: 'inperson:push' });
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
