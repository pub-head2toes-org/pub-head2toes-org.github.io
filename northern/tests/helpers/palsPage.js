'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const FS_DIR = path.join(import.meta.dirname, '..', '..', 'src', 'fs');
const PWA = path.join(FS_DIR, 'pwa', 'pals');
export const PWA_DIR = PWA;
export const read = name => fs.readFileSync(path.join(PWA, name), 'utf8');
const readReg = name => fs.readFileSync(path.join(FS_DIR, 'reg', name), 'utf8');

export const PAGE = '/fs/get/pwa/pals/index.html';

/**
 * The page's own scripts, run the way the browser runs them.
 *
 * `model.js` and `views.js` need no DOM, which is deliberate: everything with
 * logic worth testing lives in them, and `pals.js` is left holding the wiring.
 * They are plain browser scripts that hang one global each, so they are
 * evaluated in a context rather than imported - as the other PWA helpers do.
 */
export function loadPals() {
    const context = { console, crypto: globalThis.crypto, TextEncoder, TextDecoder, atob, btoa };
    context.globalThis = context;
    vm.createContext(context);
    for (const file of ['model.js', 'views.js', 'seal.js']) {
        vm.runInContext(read(file), context, { filename: file });
    }
    vm.runInContext(readReg('keystore.js'), context, { filename: 'keystore.js' });
    const of = name => vm.runInContext(name, context);
    return { Model: of('PalsModel'), Views: of('PalsViews'), Seal: of('PalsSeal'), Keys: of('NorthernKeys') };
}

/** A Northern identity's private key as reg/keystore.js keeps it: non-extractable, ECDH only. */
export function agreementKey(who) {
    const { Keys } = loadPals();
    return globalThis.crypto.subtle.importKey('jwk', plain(Keys.jwk(who.pub, who.priv)),
        { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
}

/** Objects made inside the vm have another Object.prototype; this brings them home. */
export const plain = value => JSON.parse(JSON.stringify(value));

/** Local storage as the identity scripts use it (properties) and as Pals does (getItem). */
export function storage(initial = {}) {
    const store = { ...initial };
    Object.defineProperties(store, {
        getItem: { value: key => Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null },
        setItem: { value: (key, value) => { store[key] = String(value); } }
    });
    return store;
}

/**
 * A fetch that answers from a table of { 'METHOD url': answer }, and keeps
 * what it was asked. An answer is the body, sent with 200 - or a function of
 * the call that returns [status, body], for anything else.
 */
export function fakeFetch(routes = {}) {
    const calls = [];
    const fetch = (url, options = {}) => {
        const method = options.method || 'GET';
        const call = { url, method, body: options.body, headers: options.headers || {} };
        calls.push(call);
        const key = `${method} ${url}`;
        if (!Object.prototype.hasOwnProperty.call(routes, key)) {
            return Promise.reject(new Error('unreachable: ' + key));
        }
        let status;
        let body;
        try {
            [status, body] = typeof routes[key] === 'function' ? routes[key](call) : [200, routes[key]];
        } catch (e) {
            return Promise.reject(e);
        }
        const text = typeof body === 'string' ? body : JSON.stringify(body);
        return Promise.resolve({ status, ok: status >= 200 && status < 300,
            text: () => Promise.resolve(text), json: () => Promise.resolve(JSON.parse(text)) });
    };
    fetch.calls = calls;
    return fetch;
}

/**
 * IndexedDB, as much of it as store.js uses, in memory: open with an upgrade,
 * one store per transaction, get/put/add/delete/getAll/getAllKeys. Requests
 * succeed on a later tick and the transaction completes after them, as in a
 * browser. `stores` is the data, to look at or to seed: { name: Map }.
 */
export function fakeIndexedDB(seed = {}) {
    const stores = {};
    const counters = {};
    const versions = {};
    const seeded = new Set();
    const later = fn => setImmediate(fn);
    const request = (work) => {
        const req = { result: undefined, error: null, onsuccess: null, onerror: null };
        later(() => {
            try {
                req.result = work();
                if (req.onsuccess) req.onsuccess({ target: req });
            } catch (e) {
                req.error = e;
                if (req.onerror) req.onerror({ target: req });
            }
        });
        return req;
    };
    const database = {
        objectStoreNames: { contains: name => Object.prototype.hasOwnProperty.call(stores, name) },
        createObjectStore(name, options = {}) {
            stores[name] = new Map();
            counters[name] = options.autoIncrement ? 0 : null;
        },
        transaction(name, mode) {
            if (!stores[name]) throw new Error('NotFoundError: ' + name);
            const map = stores[name];
            const tx = { oncomplete: null, onerror: null, onabort: null, error: null };
            let pending = 0;
            const settle = () => { if (--pending === 0) later(() => tx.oncomplete && tx.oncomplete()); };
            const op = work => { pending += 1; const req = request(work); const ok = req; later(() => later(settle)); return ok; };
            const writable = () => { if (mode !== 'readwrite') throw new Error('ReadOnlyError'); };
            tx.objectStore = () => ({
                get: key => op(() => map.has(key) ? structuredClone(map.get(key)) : undefined),
                put: (value, key) => op(() => { writable(); map.set(key, structuredClone(value)); return key; }),
                add: (value, key) => op(() => {
                    writable();
                    const k = key === undefined ? ++counters[name] : key;
                    if (map.has(k)) throw new Error('ConstraintError');
                    map.set(k, structuredClone(value));
                    return k;
                }),
                delete: key => op(() => { writable(); map.delete(key); }),
                getAll: () => op(() => [...map.keys()].sort((a, b) => a < b ? -1 : 1).map(k => structuredClone(map.get(k)))),
                getAllKeys: () => op(() => [...map.keys()].sort((a, b) => a < b ? -1 : 1))
            });
            return tx;
        }
    };
    const api = {
        stores,
        open(name, wanted) {
            const req = { result: database, onsuccess: null, onerror: null, onupgradeneeded: null };
            later(() => {
                if (wanted > (versions[name] || 0)) {
                    versions[name] = wanted;
                    if (req.onupgradeneeded) req.onupgradeneeded({ target: req });
                    for (const [store, records] of Object.entries(seed)) {
                        if (!stores[store] || seeded.has(store)) continue;
                        seeded.add(store);
                        for (const [key, value] of Object.entries(records)) {
                            stores[store].set(store === 'inbox' ? Number(key) : key, value);
                            if (store === 'inbox') counters.inbox = Math.max(counters.inbox, Number(key));
                        }
                    }
                }
                if (req.onsuccess) req.onsuccess({ target: req });
            });
            return req;
        }
    };
    return api;
}

/** The ids a page's HTML has: getElementById answers null for any other, as a browser does. */
const idsOf = html => new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));

/** An element of the DOM stub: remembers what was written to it and which listeners it has. */
function stubElements(ids) {
    const elements = {};
    const element = id => {
        if (ids && !ids.has(id)) {
            return null;
        }
        if (!elements[id]) {
            const form = { onsubmit: null };
            elements[id] = {
                id, value: '', innerHTML: '', textContent: '', hidden: false, disabled: false, open: false,
                scrollTop: 0, scrollHeight: 0, listeners: {}, onclick: null,
                addEventListener(event, fn) { this.listeners[event] = fn; },
                querySelector: () => form,
                showModal() { this.open = true; },
                close() { this.open = false; },
                focus() {}, select() {}
            };
        }
        return elements[id];
    };
    return element;
}

/**
 * Lets fetches, IndexedDB and promise chains run to the end. WebCrypto works
 * on Node's thread pool, not on the event loop, so turns of the loop alone are
 * not enough when the machine is busy: real time passes between them too.
 */
export const settle = async () => {
    for (let i = 0; i < 60; i++) {
        await new Promise(resolve => setImmediate(resolve));
        if (i % 6 === 5) await new Promise(resolve => setTimeout(resolve, 4));
    }
};

/** The navigator.serviceWorker of a browser that can push, as far as the pages use it. */
function stubWorker({ subscription = null, serverKey = null } = {}) {
    const worker = { listeners: {}, registered: [], subscribed: [], unsubscribed: 0, current: subscription };
    const pushManager = {
        getSubscription: () => Promise.resolve(worker.current),
        subscribe: options => {
            worker.subscribed.push(options);
            worker.current = {
                endpoint: 'https://fcm.googleapis.com/fcm/send/new-device',
                options: { applicationServerKey: options.applicationServerKey.buffer },
                toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/new-device', expirationTime: null, keys: { p256dh: 'BPdevice', auth: 'secret' } }),
                unsubscribe: () => Promise.resolve(true)
            };
            return Promise.resolve(worker.current);
        }
    };
    worker.serviceWorker = {
        register: url => { worker.registered.push(url); return Promise.resolve({ pushManager }); },
        ready: Promise.resolve({ pushManager }),
        addEventListener: (event, fn) => { worker.listeners[event] = fn; }
    };
    worker.subscriptionWith = (endpoint, keyBytes) => ({
        endpoint,
        options: { applicationServerKey: keyBytes ? Uint8Array.from(keyBytes).buffer : null },
        toJSON: () => ({ endpoint, keys: { p256dh: 'BPold', auth: 'old' } }),
        unsubscribe: () => { worker.unsubscribed += 1; return Promise.resolve(true); }
    });
    return worker;
}

/** Runs the identity scripts, then the given Pals scripts, in a sandbox. */
function run(sandbox, files) {
    sandbox.window = sandbox;
    const context = vm.createContext(sandbox);
    for (const name of ['cookies.js', 'idcard.js', 'keystore.js', 'session.js']) {
        vm.runInContext(readReg(name), context, { filename: name });
    }
    for (const name of files) {
        vm.runInContext(read(name), context, { filename: name });
    }
    return context;
}

function location(pathname, replaced) {
    return {
        origin: 'https://pals.example', pathname, search: '', hash: '', replaced: null,
        replace(url) { this.replaced = url; if (replaced) replaced(url); }
    };
}

/**
 * Runs the real page scripts - the Northern identity ones, then version.js,
 * model.js, store.js, views.js and pals.js - with just enough of a browser around them.
 *
 * The DOM is a table of elements by id that remember what was written to them
 * and which listeners were attached; a list's content stays the HTML text the
 * views produced. That proves the wiring: what each click does to the state,
 * what ends up in which panel, what is stored and what is sent. It is not a
 * browser - layout, focus and the real <dialog> belong in one.
 *
 * `idb` seeds IndexedDB: { state: {<pub>: …}, setup: {<pub>: …}, inbox: {1: …} }.
 * Unless it says otherwise, the user has been through welcome.html.
 */
export function mountPals({ localStorage = {}, cookie = '', routes = {}, confirm = true, idb, indexedDB: reuse, subscription } = {}) {
    const element = stubElements(idsOf(read('index.html')));
    const pub = localStorage.pub;
    const setup = pub ? { [pub]: { path: '/pals/x/y', endpoint: 'https://fcm.googleapis.com/fcm/send/device' } } : {};
    const indexedDB = reuse || fakeIndexedDB(idb ? { setup, ...idb } : { setup });
    const worker = stubWorker({
        subscription: subscription === undefined ? { endpoint: 'https://fcm.googleapis.com/fcm/send/device' } : subscription
    });
    const fetch = fakeFetch(routes);
    const store = storage(localStorage);
    const confirms = [];

    const document = {
        cookie, hidden: false, listeners: {}, getElementById: element, querySelectorAll: () => [], execCommand() {},
        addEventListener(event, fn) { this.listeners[event] = fn; }
    };
    const sandbox = {
        console: { log() {}, warn() {} },
        document,
        localStorage: store,
        location: location(PAGE),
        confirm: text => { confirms.push(text); return confirm; },
        navigator: { serviceWorker: worker.serviceWorker },
        crypto: globalThis.crypto,
        indexedDB, fetch, Date, JSON, Promise, encodeURIComponent, Uint8Array, TextEncoder, TextDecoder, atob, btoa
    };
    run(sandbox, ['version.js', 'model.js', 'store.js', 'seal.js', 'views.js', 'pals.js']);

    const stored = () => {
        const state = indexedDB.stores.state && indexedDB.stores.state.get(pub);
        return state ? JSON.parse(JSON.stringify(state)) : undefined;
    };

    return {
        element, fetch, store, stored, confirms, worker, indexedDB, settle, document,
        location: sandbox.location,
        html: id => element(id).innerHTML,
        /** The text of every row in a list, markup and the bubble of dots stripped. */
        rows: id => [...element(id).innerHTML.matchAll(/<button[^>]*class="row"[^>]*>(.*?)<\/button>/g)]
            .map(m => m[1].replace(/<time>.*?<\/time>/, '').replace(/<span class="more"[^>]*>.*?<\/span>/, '').replace(/<\/span>/g, '\n').replace(/<[^>]+>/g, '').trim()),
        click: id => element(id).listeners.click({}),
        /** A click on the row of a list that carries this attribute value. */
        pick: (id, attribute, value) => element(id).listeners.click({
            target: { closest: () => ({ getAttribute: name => name === attribute ? value : null }) }
        }),
        /** Presses the Add button of an overlay. */
        submit: name => element('dlg_' + name).querySelector('form').onsubmit({ preventDefault() {} }),
        /** The user comes back to the page: another tab, or the app brought forward. */
        show: () => { document.hidden = false; document.listeners.visibilitychange(); },
        /** What the service worker says to an open page when a push came. */
        push: () => worker.listeners.message({ data: { type: 'pals:push' } })
    };
}

/**
 * welcome.html's script in the same kind of sandbox. `permission` is what
 * Notification.requestPermission answers; `push: false` is a browser without
 * the Push API, as Safari is outside a Home Screen app.
 */
export function mountWelcome({ localStorage = {}, cookie = '', routes = {}, permission = 'granted', push = true, subscription = null, idb = {} } = {}) {
    const element = stubElements(idsOf(read('welcome.html')));
    const indexedDB = fakeIndexedDB(idb);
    const worker = stubWorker({ subscription });
    const fetch = fakeFetch(routes);
    const asked = [];
    const sandbox = {
        console: { log() {}, warn() {} },
        document: { cookie, getElementById: element },
        localStorage: storage(localStorage),
        location: location('/fs/get/pwa/pals/welcome.html'),
        navigator: push ? { serviceWorker: worker.serviceWorker } : {},
        crypto: globalThis.crypto,
        indexedDB, fetch, atob, btoa, Date, JSON, Promise, Uint8Array, TextEncoder, TextDecoder
    };
    if (push) {
        sandbox.PushManager = function PushManager() {};
        sandbox.Notification = { requestPermission: () => { asked.push(1); return Promise.resolve(permission); } };
    }
    run(sandbox, ['model.js', 'store.js', 'welcome.js']);
    return {
        element, fetch, worker, indexedDB, asked, settle,
        location: sandbox.location,
        setup: pub => indexedDB.stores.setup && indexedDB.stores.setup.get(pub),
        go: () => element('go').listeners.click({})
    };
}
