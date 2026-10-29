'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const FS_DIR = path.join(import.meta.dirname, '..', '..', 'src', 'fs');
const REG_DIR = path.join(FS_DIR, 'reg');
const read = name => fs.readFileSync(path.join(REG_DIR, name), 'utf8');

/** The functions a page may expose; each is optional, pages differ. */
const EXPORTS = ['init', 'saveIdCard', 'saveToNamedFile', 'currentIdCard',
    'rememberUserName', 'idcard', 'session', 'getNextURL', 'closeOtherPanels', 'savedByLink', 'shareCard', 'logout', 'regTiming'];

/**
 * The host's WebCrypto, for a page in a vm. Node's importKey turns down a JWK
 * made in another realm, as the page's are, so it gets a copy made here -
 * everything else goes straight through, bound, as in a browser.
 */
const subtle = globalThis.crypto.subtle;
const pageCrypto = {
    getRandomValues: array => globalThis.crypto.getRandomValues(array),
    subtle: new Proxy(subtle, {
        get: (target, name) => name === 'importKey'
            ? (format, key, ...rest) => target.importKey(format, format === 'jwk' ? JSON.parse(JSON.stringify(key)) : key, ...rest)
            : typeof target[name] === 'function' ? target[name].bind(target) : target[name]
    })
};

/** The inline <script> of a page, in order; <script src=...> tags carry no body. */
function inlineScripts(html) {
    const scripts = [];
    const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = re.exec(html)) !== null) {
        scripts.push(match[1]);
    }
    return scripts.join('\n');
}

/**
 * Loads src/fs/reg/Reg.html into a vm with just enough of a browser around it
 * to run: the real sjcl/oo/idcard/cookies/db scripts, a DOM stub covering the
 * elements the page touches, local storage, and a recording fetch.
 *
 * Everything the harness observes - stored values, the POSTed body, the
 * download - is exposed so tests can assert on the page's actual behaviour.
 * A download is what a tap on the page's Download Id Card link would save:
 * see tapDownload().
 *
 * `navigator` stands in for the browser's, e.g. one whose share sheet takes
 * files; by default there is no share sheet at all.
 *
 * With `indexedDB` (a fakeIndexedDB from palsPage.js) the real keystore.js
 * runs too, as it does on Reg.html, and keeps its keys there; pass the same
 * one to a second page for the same browser on a later visit.
 */
export function loadRegPage({ hash = '', localStorage = {}, cookie = '', page: pageFile = 'reg/Reg.html', indexedDB, navigator = {} } = {}) {
    const elements = {};
    const listeners = {};
    const downloads = [];
    const requests = [];
    const windowListeners = {};

    const element = id => {
        if (!elements[id]) {
            elements[id] = {
                id,
                value: '',
                href: '',
                innerHTML: '',
                attributes: {},
                setAttribute(name, value) { this.attributes[name] = String(value); },
                getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; },
                addEventListener: (event, fn) => { listeners[`${id}:${event}`] = fn; }
            };
        }
        return elements[id];
    };

    // document.cookie behaves like the browser's: assigning one cookie keeps the rest.
    const jar = new Map();
    if (cookie) {
        cookie.split(';').forEach(part => {
            const [name, ...rest] = part.trim().split('=');
            jar.set(name, rest.join('='));
        });
    }

    const document = {
        getElementById: element,
        // Only Reg.html's accordion asks, and only for its two panels.
        querySelectorAll: selector => selector === 'details.panel'
            ? ['signin_panel', 'reg_panel'].map(element) : [],
        body: { appendChild() {}, removeChild() {} },
        get cookie() {
            return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
        },
        set cookie(raw) {
            const [pair, ...attrs] = raw.split(';');
            const [name, ...rest] = pair.split('=');
            const expires = attrs.map(a => a.trim()).find(a => a.toLowerCase().startsWith('expires='));
            if (expires && new Date(expires.slice('expires='.length)) <= new Date()) {
                jar.delete(name);
            } else {
                jar.set(name, rest.join('='));
            }
        }
    };

    // Resolves when the page's onload handler has finished, however long its
    // key derivation takes - waiting a fixed number of milliseconds is a flake.
    let reading = null;

    class FileReader {
        readAsText(file) {
            this.result = file.text;
            // The page assigns onload after construction, as the browser API requires.
            reading = new Promise((resolve, reject) => queueMicrotask(() => {
                Promise.resolve(this.onload({})).then(resolve, reject);
            }));
        }
    }

    // Blobs keep their text where a test can read it back; URL.createObjectURL
    // throws when called detached from URL, as Chrome's does.
    class Blob {
        constructor(parts, options = {}) {
            this.text = parts.join('');
            this.type = options.type || '';
        }
    }
    class File extends Blob {
        constructor(parts, name, options) {
            super(parts, options);
            this.name = name;
        }
    }
    const blobs = new Map();
    const URL = {
        createObjectURL(blob) {
            if (this !== URL) {
                throw new TypeError('Illegal invocation');
            }
            const url = `blob:https://reg.test/${blobs.size + 1}`;
            blobs.set(url, blob);
            return url;
        }
    };

    const sandbox = {
        document, FileReader, localStorage, Blob, File, URL, navigator,
        location: { hash, href: '', replace(url) { this.href = url; } },
        addEventListener: (event, fn) => { windowListeners[event] = fn; },
        crypto: pageCrypto, TextEncoder, TextDecoder, atob, btoa,
        queueMicrotask, setTimeout, Headers: globalThis.Headers,
        console: { log() {} },
        ...(indexedDB ? { indexedDB } : {}),
        fetch: async (url, options) => {
            requests.push({ url, method: options && options.method, body: options && options.body,
                keepalive: options && options.keepalive });
            return { status: 200, json: async () => ({ status: 'OK', path: url }) };
        }
    };

    const context = vm.createContext(sandbox);
    // In a browser window IS the global object, and pages rely on that: an
    // onLoad handler's `this` is the window, so `this.keys = {}` makes a global.
    sandbox.window = sandbox;
    const window = sandbox;

    // Each file runs as its own script, exactly as the browser loads them: sjcl.js
    // opens with "use strict", and concatenating would leak that over the others.
    // Top level const/let still cross script boundaries, as they do on a page.
    const scripts = ['sjcl.js', 'cookies.js', 'db.js', 'oo.js', 'idcard.js', ...(indexedDB ? ['keystore.js'] : []), 'session.js'];
    for (const name of scripts) {
        vm.runInContext(read(name), context, { filename: name });
    }
    const html = fs.readFileSync(path.join(FS_DIR, pageFile), 'utf8');
    vm.runInContext(inlineScripts(html), context, { filename: pageFile });

    const page = vm.runInContext(
        `({ ${EXPORTS.map(name => `${name}: typeof ${name} !== 'undefined' ? ${name} : undefined`).join(', ')} })`,
        context);

    // Registration waits a moment after a tap, for the download to get going;
    // a test does not have to.
    if (page.regTiming) {
        page.regTiming.delay = 0;
        page.regTiming.retry = 0;
    }

    return {
        ...page,
        document,
        window,
        localStorage,
        downloads,
        requests,
        element,
        cookie: () => document.cookie,
        /** Reads a global the page set, e.g. the `keys` object Remote.html builds. */
        global: name => vm.runInContext(`typeof ${name} !== 'undefined' ? ${name} : undefined`, context),
        /** True when the page would warn about leaving with an unsaved identity. */
        warnsOnLeave: () => {
            const listener = windowListeners.beforeunload;
            if (!listener) return false;
            let prevented = false;
            listener({ preventDefault: () => { prevented = true; }, returnValue: null });
            return prevented;
        },
        /**
         * Fires the handler the page gave an element for an event, e.g. an
         * input's 'input', with `detail` as the event; returns what it returned.
         */
        fire: (id, event, detail = {}) => listeners[`${id}:${event}`].call(element(id), detail),
        /**
         * A tap on Download Id Card: records the file the link would save -
         * its name, the Blob's type and text - and runs the page's handler.
         */
        tapDownload: () => {
            const link = element('download_card');
            const blob = blobs.get(link.href);
            if (!blob) {
                throw new Error(`Download Id Card points at no Blob: ${link.href}`);
            }
            downloads.push({ name: link.download, href: link.href, type: blob.type, content: blob.text });
            listeners['download_card:click'].call(link, {});
        },
        /**
         * A tap on Load Id Card & Continue, which reaches the file input as a
         * click. Resolves, once anything it started is done, to whether the
         * file picker would open.
         */
        tapLoad: async () => {
            let prevented = false;
            await listeners['fileinput:click'].call(element('fileinput'), { preventDefault: () => { prevented = true; } });
            return { picker: !prevented };
        },
        /** Fires the file input's change handler with an ID Card file. */
        upload: async text => {
            const input = element('fileinput');
            input.files = [{ name: 'card.id.txt', size: text.length, type: 'text/plain', lastModified: 0, text }];
            await listeners['fileinput:change'].call(input);
            await reading;
        }
    };
}
