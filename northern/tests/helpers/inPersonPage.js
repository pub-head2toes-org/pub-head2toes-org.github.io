'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fakeFetch, fakeIndexedDB, storage, settle } from './palsPage.js';

const FS_DIR = path.join(import.meta.dirname, '..', '..', 'src', 'fs');
export const PWA_DIR = path.join(FS_DIR, 'pwa', 'inPerson');
export const PAGE = '/fs/get/pwa/inPerson/index.html';
export const read = name => fs.readFileSync(path.join(PWA_DIR, name), 'utf8');
/** A script as a page or the worker asks for it: its own, Pals' seal, or the identity ones. */
export const source = file => {
    const clean = file.replace(/^\.\//, '').replace(/\?.*$/, '');
    if (clean.startsWith('../../reg/')) {
        return fs.readFileSync(path.join(FS_DIR, 'reg', clean.slice('../../reg/'.length)), 'utf8');
    }
    if (clean.startsWith('../pals/')) {
        return fs.readFileSync(path.join(FS_DIR, 'pwa', 'pals', clean.slice('../pals/'.length)), 'utf8');
    }
    return read(clean);
};
export { settle };

/** Objects made inside the vm have another Object.prototype; this brings them home. */
export const plain = value => JSON.parse(JSON.stringify(value));

/** model.js, views.js, call.js and Pals' seal.js, which need no DOM, in a context of their own. */
export function loadInPerson(extra = {}) {
    const context = { console, crypto: globalThis.crypto, TextEncoder, TextDecoder, atob, btoa, ...extra };
    context.globalThis = context;
    vm.createContext(context);
    for (const file of ['model.js', 'views.js', 'call.js', '../pals/seal.js']) {
        vm.runInContext(source(file), context, { filename: file });
    }
    const of = name => vm.runInContext(name, context);
    return { Model: of('InPersonModel'), Views: of('InPersonViews'), Call: of('InPersonCall'), Seal: of('PalsSeal') };
}

/** Timers that run only when the test says time has passed. */
export function fakeTimers() {
    let next = 1;
    let now = 0;
    const pending = new Map();
    return {
        setTimeout(fn, ms) { const id = next++; pending.set(id, { fn, at: now + (ms || 0) }); return id; },
        clearTimeout(id) { pending.delete(id); },
        /** Moves the clock on, running what falls due. */
        pass(ms) {
            now += ms;
            for (const [id, t] of [...pending]) {
                if (t.at <= now && pending.has(id)) {
                    pending.delete(id);
                    t.fn();
                }
            }
        },
        pending: () => pending.size
    };
}

/**
 * Northern's /sub/ as the pages see it: an EventSource per listener, and a
 * PUT that every listener on the path hears - the sender too - with the
 * first message `{"status":"OK"}`, as Render.renderSub writes it.
 */
export function fakeHub() {
    const hub = { listeners: {}, puts: [], opened: [] };
    hub.EventSource = function EventSource(url) {
        this.url = url;
        this.closed = false;
        this.onmessage = null;
        (hub.listeners[url] = hub.listeners[url] || []).push(this);
        hub.opened.push(url);
        setImmediate(() => this.onmessage && !this.closed && this.onmessage({ data: '{"status":"OK"}' }));
        this.close = () => {
            this.closed = true;
            hub.listeners[url] = hub.listeners[url].filter(s => s !== this);
        };
    };
    hub.put = function (url, body) {
        hub.puts.push({ url, body: JSON.parse(body) });
        (hub.listeners[url] || []).forEach(s => setImmediate(() => s.onmessage && !s.closed && s.onmessage({ data: body })));
        return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({ clients: 1 }) });
    };
    return hub;
}

/**
 * RTCPeerConnection, as far as call.js uses it, for two pages in one test:
 * an offer names the connection that made it, so the one that answers finds
 * it; once the caller has the answer the two are connected, each gets the
 * other's stream, and the caller's data channel reaches the callee.
 */
export function fakeWebRTC() {
    const all = [];
    const net = { all };
    net.RTCPeerConnection = function RTCPeerConnection(config) {
        const pc = this;
        pc.id = all.length + 1;
        all.push(pc);
        pc.config = config;
        pc.tracks = [];
        pc.added = [];
        pc.localDescription = null;
        pc.remoteDescription = null;
        pc.connectionState = 'new';
        pc.closed = false;
        pc.senders = [];
        // A sender keeps what was set on it, as RTCRtpSender.setParameters does.
        pc.addTrack = (track, stream) => {
            pc.tracks.push(track);
            pc.stream = stream;
            const sender = {
                track, params: { encodings: [{}] }, set: [],
                getParameters() { return JSON.parse(JSON.stringify(this.params)); },
                setParameters(params) { this.params = params; this.set.push(params); return Promise.resolve(); }
            };
            pc.senders.push(sender);
            return sender;
        };
        pc.createDataChannel = function (label) {
            pc.channel = { label, readyState: 'open', sent: [], onmessage: null, send(data) { this.sent.push(data); if (pc.other && pc.other.channel && pc.other.channel.onmessage) pc.other.channel.onmessage({ data }); } };
            return pc.channel;
        };
        pc.createOffer = () => Promise.resolve({ type: 'offer', sdp: 'v=0 offer from pc' + pc.id });
        pc.createAnswer = () => Promise.resolve({ type: 'answer', sdp: 'v=0 answer from pc' + pc.id });
        pc.setLocalDescription = function (d) {
            pc.localDescription = d;
            setImmediate(() => {
                const candidate = { candidate: `candidate:${pc.id} 1 udp 2122260223 192.0.2.${pc.id} 5000${pc.id} typ host`, sdpMid: '0', sdpMLineIndex: 0 };
                if (pc.onicecandidate) pc.onicecandidate({ candidate: { ...candidate, toJSON: () => candidate } });
                if (pc.onicecandidate) pc.onicecandidate({ candidate: null });
            });
            return Promise.resolve();
        };
        pc.setRemoteDescription = function (d) {
            pc.remoteDescription = d;
            const from = all.find(p => d.sdp.endsWith(' pc' + p.id));
            pc.other = from;
            if (d.type === 'answer' && from) {
                from.other = pc;
                setImmediate(() => net.connect(pc, from));
            }
            return Promise.resolve();
        };
        pc.addIceCandidate = c => { pc.added.push(c); return Promise.resolve(); };
        pc.close = () => { pc.closed = true; pc.connectionState = 'closed'; };
    };
    /** Both ends reach each other: the media flows, and the caller's data channel opens on the callee. */
    net.connect = function (a, b) {
        for (const [pc, other] of [[a, b], [b, a]]) {
            if (pc.closed) continue;
            pc.connectionState = 'connected';
            if (pc.onconnectionstatechange) pc.onconnectionstatechange();
            if (pc.ontrack) pc.ontrack({ streams: [other.stream], track: other.tracks[0] });
        }
        const caller = a.channel ? a : b;
        const callee = caller === a ? b : a;
        if (!callee.closed && callee.ondatachannel) {
            callee.channel = { readyState: 'open', sent: [], onmessage: null, send(data) { this.sent.push(data); if (caller.channel.onmessage) caller.channel.onmessage({ data }); } };
            callee.ondatachannel({ channel: callee.channel });
        }
    };
    /** The network between them fails. */
    net.fail = function (pc) {
        pc.connectionState = 'failed';
        pc.onconnectionstatechange();
    };
    return net;
}

/** A camera and microphone. */
export function fakeMedia(name) {
    const tracks = ['audio', 'video'].map(kind => ({ kind, stopped: false, stop() { this.stopped = true; } }));
    return { name, tracks, getTracks: () => tracks };
}

const idsOf = html => new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));

function stubElements(ids) {
    const elements = {};
    return id => {
        if (ids && !ids.has(id)) {
            return null;
        }
        if (!elements[id]) {
            const form = { onsubmit: null };
            elements[id] = {
                id, value: '', innerHTML: '', textContent: '', hidden: false, disabled: false, open: false, checked: false,
                srcObject: null, played: 0, listeners: {}, style: {},
                addEventListener(event, fn) { this.listeners[event] = fn; },
                querySelector: () => form,
                showModal() { this.open = true; },
                close() { this.open = false; },
                play() { this.played += 1; return Promise.resolve(); },
                focus() {}
            };
        }
        return elements[id];
    };
}

function stubWorker({ subscription = null } = {}) {
    const worker = { listeners: {}, registered: [], subscribed: [], current: subscription };
    const pushManager = {
        getSubscription: () => Promise.resolve(worker.current),
        subscribe: options => {
            worker.subscribed.push(options);
            const endpoint = 'https://fcm.googleapis.com/fcm/send/new-device';
            worker.current = {
                endpoint,
                options: { applicationServerKey: options.applicationServerKey.buffer },
                toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh: 'BPdevice', auth: 'secret' } }),
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
    return worker;
}

function run(sandbox, files) {
    sandbox.window = sandbox;
    const context = vm.createContext(sandbox);
    for (const name of ['../../reg/cookies.js', '../../reg/idcard.js', '../../reg/keystore.js', '../../reg/session.js', ...files]) {
        vm.runInContext(source(name), context, { filename: name });
    }
    return context;
}

/**
 * The real page - the identity scripts, Pals' seal, version.js, model.js,
 * store.js, views.js, call.js and inperson.js - with a DOM stub, an
 * in-memory IndexedDB, fake fetch routes, the /sub/ hub, fake WebRTC and fake
 * timers. Unless `idb` says otherwise, the device has been set up.
 */
export function mountInPerson({ who, routes = {}, idb = {}, hub = fakeHub(), net = fakeWebRTC(), timers = fakeTimers(),
                                camera = true, subscription, setup = true } = {}) {
    const element = stubElements(idsOf(read('index.html')));
    const seed = { ...idb };
    if (setup && who) {
        seed.setup = { [who.pub]: { path: '/inperson/x/y', endpoint: 'https://fcm.googleapis.com/fcm/send/device' }, ...(idb.setup || {}) };
    }
    const indexedDB = fakeIndexedDB(seed);
    const worker = stubWorker({ subscription: subscription === undefined ? { endpoint: 'https://fcm.googleapis.com/fcm/send/device' } : subscription });
    const base = fakeFetch(routes);
    const fetch = (url, options = {}) => {
        if (String(url).startsWith('/sub/') && options.method === 'PUT') {
            base.calls.push({ url, method: 'PUT', body: options.body, headers: options.headers || {} });
            return hub.put(url, options.body);
        }
        return base(url, options);
    };
    fetch.calls = base.calls;
    const media = [];
    const mediaDevices = {
        getUserMedia: constraints => {
            if (!camera) {
                return Promise.reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));
            }
            const stream = fakeMedia(who && who.name);
            media.push({ constraints, stream });
            return Promise.resolve(stream);
        }
    };
    const document = {
        cookie: who ? `ssid=${who.pub}.${Date.now()}.sig` : '', hidden: false, listeners: {}, getElementById: element,
        addEventListener(event, fn) { this.listeners[event] = fn; }
    };
    const location = {
        origin: 'https://inperson.example', pathname: PAGE, search: '', hash: '', replaced: null,
        replace(url) { this.replaced = url; }
    };
    const sandbox = {
        console: { log() {}, warn() {} },
        document,
        localStorage: storage(who ? { pub: who.pub, pub_name: who.name } : {}),
        location,
        navigator: { serviceWorker: worker.serviceWorker, mediaDevices },
        crypto: globalThis.crypto,
        indexedDB, fetch, Date, JSON, Promise, encodeURIComponent, Uint8Array, TextEncoder, TextDecoder, atob, btoa,
        EventSource: hub.EventSource, RTCPeerConnection: net.RTCPeerConnection,
        setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout
    };
    run(sandbox, ['../pals/seal.js', 'version.js', 'model.js', 'store.js', 'views.js', 'call.js', 'inperson.js']);
    return {
        element, fetch, worker, indexedDB, hub, net, timers, media, location, document, settle,
        click: id => element(id).listeners.click({}),
        pick: pub => element('contacts').listeners.click({
            target: { closest: () => ({ getAttribute: name => name === 'data-pub' ? pub : null }) }
        }),
        /** The service worker took something in, and tells the page. */
        push: () => worker.listeners.message({ data: { type: 'inperson:push' } }),
        inbox: () => [...(indexedDB.stores.inbox || new Map()).values()],
        stored: (store, key) => indexedDB.stores[store] && indexedDB.stores[store].get(key)
    };
}

/** welcome.html's script in the same kind of sandbox. */
export function mountWelcome({ who, routes = {}, idb = {}, permission = 'granted', push = true, net = fakeWebRTC(), rtc = true } = {}) {
    const element = stubElements(idsOf(read('welcome.html')));
    const indexedDB = fakeIndexedDB(idb);
    const worker = stubWorker();
    const fetch = fakeFetch(routes);
    const timers = fakeTimers();
    const sandbox = {
        console: { log() {}, warn() {} },
        document: { cookie: who ? `ssid=${who.pub}.${Date.now()}.sig` : '', getElementById: element },
        localStorage: storage(who ? { pub: who.pub, pub_name: who.name } : {}),
        location: { pathname: '/fs/get/pwa/inPerson/welcome.html', search: '', hash: '', replaced: null, replace(url) { this.replaced = url; } },
        navigator: push ? { serviceWorker: worker.serviceWorker } : {},
        crypto: globalThis.crypto,
        indexedDB, fetch, atob, btoa, Date, JSON, Promise, Uint8Array, TextEncoder, TextDecoder,
        setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout
    };
    if (rtc) {
        sandbox.RTCPeerConnection = net.RTCPeerConnection;
    }
    if (push) {
        sandbox.PushManager = function PushManager() {};
        sandbox.Notification = { requestPermission: () => Promise.resolve(permission) };
    }
    run(sandbox, ['model.js', 'store.js', 'welcome.js']);
    return {
        element, fetch, worker, indexedDB, timers, net, settle,
        location: sandbox.location,
        click: id => element(id).listeners.click({}),
        stored: (store, key) => indexedDB.stores[store] && indexedDB.stores[store].get(key)
    };
}
