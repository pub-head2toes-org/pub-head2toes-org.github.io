'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fakeIndexedDB, storage, settle } from './palsPage.js';

const FS_DIR = path.join(import.meta.dirname, '..', '..', 'src', 'fs');
export const PWA_DIR = path.join(FS_DIR, 'pwa', 'rama');
export const read = name => fs.readFileSync(path.join(PWA_DIR, name), 'utf8');
const readReg = name => fs.readFileSync(path.join(FS_DIR, 'reg', name), 'utf8');

export const PAGE = '/fs/get/pwa/rama/index.html';
export { fakeIndexedDB, settle };

/**
 * A clock the test moves: Date and the timers both run on it, so a reminder
 * an hour off is an `advance(3600000)` away, and a peel 650 ms.
 */
export function fakeClock(start) {
    const clock = { now: start, timers: [], seq: 0 };
    class FakeDate extends Date {
        constructor(...args) {
            if (args.length) {
                super(...args);
            } else {
                super(clock.now);
            }
        }
        static now() { return clock.now; }
    }
    clock.Date = FakeDate;
    const add = (fn, ms, every) => {
        const timer = { id: ++clock.seq, at: clock.now + Math.max(0, Number(ms) || 0), fn, every };
        clock.timers.push(timer);
        return timer.id;
    };
    const clear = id => { clock.timers = clock.timers.filter(t => t.id !== id); };
    clock.setTimeout = (fn, ms) => add(fn, ms, 0);
    clock.setInterval = (fn, ms) => add(fn, ms, Math.max(1, ms));
    clock.clearTimeout = clear;
    clock.clearInterval = clear;
    /** Moves time on, running every timer that comes due on the way, in order. */
    clock.advance = function (ms) {
        const until = clock.now + ms;
        for (;;) {
            const due = clock.timers.filter(t => t.at <= until).sort((a, b) => a.at - b.at || a.id - b.id)[0];
            if (!due) break;
            clock.now = Math.max(clock.now, due.at);
            if (due.every) {
                due.at += due.every;
            } else {
                clear(due.id);
            }
            due.fn();
        }
        clock.now = until;
    };
    return clock;
}

/** The ids a page's HTML has: getElementById answers null for any other, as a browser does. */
const idsOf = html => new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));

/** Elements by id that remember what was written to them, their classes, attributes and listeners. */
function stubElements(ids, html) {
    const elements = {};
    return function element(id) {
        if (!ids.has(id)) {
            return null;
        }
        if (!elements[id]) {
            const tag = new RegExp(`<[^>]*\\bid="${id}"[^>]*>`).exec(html)[0];
            const classes = new Set(((/\bclass="([^"]*)"/.exec(tag) || [])[1] || '').split(/\s+/).filter(Boolean));
            const el = {
                id, value: '', innerHTML: '', textContent: '', hidden: /\shidden[\s>]/.test(tag), inert: /\sinert[\s>]/.test(tag),
                disabled: /\sdisabled[\s>]/.test(tag), open: false, focused: 0, attributes: {}, listeners: {},
                classList: {
                    add: (...names) => names.forEach(n => classes.add(n)),
                    remove: (...names) => names.forEach(n => classes.delete(n)),
                    toggle: (name, on) => { (on === undefined ? !classes.has(name) : on) ? classes.add(name) : classes.delete(name); },
                    contains: name => classes.has(name)
                },
                addEventListener(event, fn) { (this.listeners[event] = this.listeners[event] || []).push(fn); },
                fire(event, data = {}) { (this.listeners[event] || []).forEach(fn => fn(data)); },
                setAttribute(name, value) { this.attributes[name] = String(value); },
                getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; },
                removeAttribute(name) { delete this.attributes[name]; if (name === 'src') this.src = ''; },
                showModal() { this.open = true; },
                close() { if (this.open) { this.open = false; this.fire('close'); } },
                focus() { this.focused += 1; }
            };
            elements[id] = el;
        }
        return elements[id];
    };
}

/**
 * The microphone and MediaRecorder: `allow: false` is a user who said no.
 * What a recording holds is `bytes` per chunk, one chunk per stop.
 */
function stubMicrophone({ allow = true, supported = ['audio/webm;codecs=opus'], bytes = 'sound' } = {}) {
    const mic = { asked: 0, stopped: 0, recorders: [] };
    mic.mediaDevices = {
        getUserMedia: () => {
            mic.asked += 1;
            if (!allow) {
                const e = new Error('Permission denied');
                e.name = 'NotAllowedError';
                return Promise.reject(e);
            }
            return Promise.resolve({ getTracks: () => [{ stop: () => { mic.stopped += 1; } }] });
        }
    };
    mic.MediaRecorder = class {
        constructor(stream, options) {
            this.mimeType = options && options.mimeType || '';
            this.state = 'inactive';
            mic.recorders.push(this);
        }
        static isTypeSupported(type) { return supported.includes(type); }
        start() { this.state = 'recording'; }
        stop() {
            this.state = 'inactive';
            if (bytes) this.ondataavailable({ data: new Blob([bytes], { type: this.mimeType }) });
            this.onstop();
        }
    };
    return mic;
}

/** The service worker as the page sees it, and the notifications it shows. */
function stubWorker({ registered = true, periodic = true } = {}) {
    const worker = { listeners: {}, registered: [], notified: [], periodic: [] };
    const registration = {
        showNotification: (title, options) => { worker.notified.push({ title, ...options }); return Promise.resolve(); }
    };
    if (periodic) {
        registration.periodicSync = { register: (tag, options) => { worker.periodic.push({ tag, ...options }); return Promise.resolve(); } };
    }
    worker.serviceWorker = {
        register: (url, options) => { worker.registered.push({ url, ...options }); return Promise.resolve(registration); },
        ready: Promise.resolve(registration),
        getRegistration: () => Promise.resolve(registered ? registration : undefined),
        addEventListener: (event, fn) => { worker.listeners[event] = fn; }
    };
    return worker;
}

/**
 * Runs the real page - the Northern identity scripts, then Rama's - in a
 * sandbox with a DOM stub, IndexedDB in memory, a fake microphone and a
 * clock the test moves. It proves the wiring: what each click does, what is
 * stored, what each list shows. Layout, the peel itself and real audio are a
 * browser's to show.
 */
export function mountRama({ localStorage = {}, cookie = '', idb, indexedDB: reuse, hash = '', now = Date.UTC(2026, 9, 6, 9, 0),
    permission = 'granted', answer = 'granted', microphone, recorder = true, worker: workerOptions } = {}) {
    const html = read('index.html');
    const element = stubElements(idsOf(html), html);
    const indexedDB = reuse || fakeIndexedDB(idb || {});
    const clock = fakeClock(now);
    const mic = stubMicrophone(microphone);
    const worker = stubWorker(workerOptions);
    const urls = { made: new Map(), revoked: [] };
    const URL = {
        createObjectURL(blob) { const url = 'blob:' + (urls.made.size + 1); urls.made.set(url, blob); return url; },
        revokeObjectURL(url) { urls.revoked.push(url); }
    };
    const asked = [];
    const Notification = function Notification(title, options) { worker.notified.push({ title, page: true, ...options }); };
    Notification.permission = permission;
    Notification.requestPermission = () => { asked.push(1); Notification.permission = answer; return Promise.resolve(answer); };

    // The <audio>: plays, pauses and is told where to be.
    const audio = element('note_audio');
    Object.assign(audio, {
        paused: true, currentTime: 0, duration: Infinity, src: '',
        play() { this.paused = false; this.fire('play'); return Promise.resolve(); },
        pause() { if (!this.paused) { this.paused = true; this.fire('pause'); } }
    });

    const document = {
        cookie, hidden: false, listeners: {}, getElementById: element,
        addEventListener(event, fn) { this.listeners[event] = fn; }
    };
    const location = {
        origin: 'https://northern.example', pathname: PAGE, search: '', hash, replaced: null,
        replace(url) { this.replaced = url; }
    };
    const sandbox = {
        console: { log() {}, warn() {} },
        document, location, indexedDB, URL, Blob, Notification, Promise, JSON, Math, encodeURIComponent,
        localStorage: storage(localStorage),
        navigator: { serviceWorker: worker.serviceWorker, ...(recorder ? { mediaDevices: mic.mediaDevices } : {}) },
        Date: clock.Date,
        setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
        setInterval: clock.setInterval, clearInterval: clock.clearInterval
    };
    if (recorder) {
        sandbox.MediaRecorder = mic.MediaRecorder;
    }
    sandbox.window = sandbox;
    const context = vm.createContext(sandbox);
    for (const name of ['cookies.js', 'idcard.js', 'session.js']) {
        vm.runInContext(readReg(name), context, { filename: name });
    }
    for (const name of ['version.js', 'model.js', 'store.js', 'remind.js', 'views.js', 'rama.js']) {
        vm.runInContext(read(name), context, { filename: name });
    }

    const rowsOf = id => [...element(id).innerHTML.matchAll(/<button[^>]*data-id="([^"]+)"[^>]*>(.*?)<\/button>/g)]
        .map(m => ({ id: m[1], text: m[2].replace(/<\/span>/g, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() }));
    const target = (attribute, value) => ({ closest: () => ({ getAttribute: name => name === attribute ? value : null }) });

    return {
        element, indexedDB, clock, mic, worker, urls, asked, document, location, audio, settle, Notification,
        global: name => vm.runInContext(name, context),
        html: id => element(id).innerHTML,
        rows: rowsOf,
        has: (id, name) => element(id).classList.contains(name),
        click: id => element(id).fire('click', { target: null }),
        /** A click on the row of a list that is for this note. */
        pick: (list, id) => element(list).fire('click', { target: target('data-id', id) }),
        /** A click on a suggested type. */
        choose: type => element('note_types').fire('click', { target: target('data-type', type) }),
        type: (id, value) => { element(id).value = value; element(id).fire('input'); },
        key: (id, key) => { const event = { key, prevented: false, preventDefault() { this.prevented = true; } }; element(id).fire('keydown', event); return event; },
        submit: () => element('note_form').fire('submit', { preventDefault() {} }),
        advance: ms => clock.advance(ms),
        /** The user comes back to the page: another tab, or the app brought forward. */
        show: () => { document.hidden = false; document.listeners.visibilitychange(); },
        stored: (store, key) => indexedDB.stores[store] && indexedDB.stores[store].get(key),
        all: store => [...(indexedDB.stores[store] || new Map()).values()],
        /** What the service worker says to an open page when a notification was clicked. */
        message: data => worker.listeners.message({ data })
    };
}
