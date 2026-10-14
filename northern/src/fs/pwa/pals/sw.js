// What a push needs: the key the ID Card left on this device, the seal to
// open with it, the model to name a sender, the store to keep what came, and
// the calls' signals to tell a ring from a message.
importScripts('./version.js', '../../reg/keystore.js', './model.js', './store.js', './seal.js', './calls.js');

// Named after the app's version, which index.html shows: bump it in version.js.
const CACHE_NAME = 'pals-v' + PALS_VERSION;
const urlsToCache = [
  './index.html',
  './welcome.html',
  './styles.css',
  './version.js',
  './model.js',
  './store.js',
  './seal.js',
  './views.js',
  './calls.js',
  './call.js',
  './pals.js',
  './welcome.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
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
  // Only the pages' own files. Everything else is Northern - the database and
  // the push API - and is none of the cache's business.
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

/**
 * Opens a message here, on the device, with the key the ID Card left in
 * IndexedDB (reg/keystore.js). Null when there is no key for its receiver on
 * this device, or it does not open - then it waits sealed in the inbox.
 */
function open(outer) {
  if (!outer || outer.v !== PalsSeal.VERSION || !NorthernKeys.available()) return Promise.resolve(null);
  return NorthernKeys.get(outer.to)
    .then((key) => key ? PalsSeal.open(key, outer) : null)
    .catch(() => null);
}

/**
 * Who a message is from: the receiver's own name for them, if any, whether
 * they are a pal, and whether the receiver has video calls switched on.
 */
function sender(envelope) {
  if (!envelope) return Promise.resolve({ name: '', pal: false, calls: false });
  return Promise.all([PalsStore.get('state', envelope.to), PalsStore.get('setup', 'calls ' + envelope.to).catch(() => null)])
    .then(([stored, calls]) => {
      const state = PalsModel.load(stored);
      const name = PalsModel.nameOf(state, envelope.from);
      return { name: name === '?' ? PalsModel.label('A new pal', envelope.from) : name, pal: !!PalsModel.pal(state, envelope.from),
               calls: PalsCalls.enabled(calls) };
    })
    .catch(() => ({ name: '', pal: false, calls: false }));
}

/**
 * What the user is told of a push. A video call's ring says who is calling,
 * and stays until it is dealt with; a ring from somebody who is not a pal,
 * with calls switched off, too old to answer, or cancelled is a missed call.
 * Anything else is a message.
 */
function notice(envelope, from) {
  const signal = envelope && typeof envelope.signal === 'string' ? PalsCalls.readSignal(envelope.signal) : null;
  if (!signal) {
    return { body: from.name ? 'New message from ' + from.name : 'New message', icon: './icon-192.png', tag: 'pals' };
  }
  const tag = 'pals-call-' + signal.call;
  const name = from.name || PalsModel.label('A new pal', envelope.from);
  if (signal.t === 'ring' && from.pal && from.calls && Date.now() - signal.ts < PalsCalls.RING_MS) {
    return { body: name + ' is calling', icon: './icon-192.png', tag, requireInteraction: true, renotify: true, data: { call: signal.call } };
  }
  return { body: 'Missed call from ' + name, icon: './icon-192.png', tag };
}

/** The push payload: `{v, from, to, id, part, parts, sealed}`, as JSON text. */
function payloadOf(data) {
  try {
    const outer = data ? JSON.parse(data.text()) : null;
    return outer && typeof outer === 'object' ? outer : null;
  } catch (e) {
    return null;
  }
}

// A push is one sealed message, or one part of one. It is opened here, with
// the key on this device, and goes into the inbox opened or not, so nothing
// is lost; any open page is told, so it files it at once; and the user is
// notified - Chrome requires that of every push. The notification names the
// sender and never shows the text.
self.addEventListener('push', (event) => {
  // Text: Chrome gives the worker event.data === null for a payload that is
  // not valid UTF-8, which is why the server sends JSON.
  const payload = payloadOf(event.data);

  event.waitUntil(open(payload)
    .then((envelope) => {
      const item = { payload, at: Date.now() };
      if (envelope) item.envelope = envelope;
      const kept = payload ? PalsStore.add('inbox', item).catch(() => null) : Promise.resolve();
      return Promise.all([kept, sender(envelope), envelope]);
    })
    .then(([, from, envelope]) => Promise.all([
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
        windows.forEach((client) => client.postMessage({ type: 'pals:push' }));
      }),
      self.registration.showNotification('Pals', notice(envelope, from))
    ])));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL('./index.html', self.location.href).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if (client.url.split(/[?#]/)[0] === url && 'focus' in client) {
          // A ring waits in the inbox: the page opens it once told.
          client.postMessage({ type: 'pals:push' });
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
