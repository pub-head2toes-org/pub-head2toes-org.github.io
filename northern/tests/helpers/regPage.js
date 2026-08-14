'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const FS_DIR = path.join(import.meta.dirname, '..', '..', 'src', 'fs');
const REG_DIR = path.join(FS_DIR, 'reg');
const read = name => fs.readFileSync(path.join(REG_DIR, name), 'utf8');

/** The functions a page may expose; each is optional, pages differ. */
const EXPORTS = ['init', 'saveIdCard', 'saveToNamedFile', 'currentIdCard',
    'rememberUserName', 'idcard', 'session', 'getNextURL'];

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
 */
export function loadRegPage({ hash = '', localStorage = {}, cookie = '', page: pageFile = 'reg/Reg.html' } = {}) {
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
        createElement: () => ({ href: '', download: '', click() { downloads.push({ name: this.download, href: this.href }); } }),
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

    const sandbox = {
        document, FileReader, localStorage,
        location: { hash, href: '', replace(url) { this.href = url; } },
        addEventListener: (event, fn) => { windowListeners[event] = fn; },
        crypto: globalThis.crypto, TextEncoder, TextDecoder, atob, btoa,
        queueMicrotask, setTimeout, Headers: globalThis.Headers,
        console: { log() {} },
        fetch: async (url, options) => {
            requests.push({ url, method: options && options.method, body: options && options.body });
            return { status: 200 };
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
    for (const name of ['sjcl.js', 'cookies.js', 'db.js', 'oo.js', 'idcard.js', 'session.js']) {
        vm.runInContext(read(name), context, { filename: name });
    }
    const html = fs.readFileSync(path.join(FS_DIR, pageFile), 'utf8');
    vm.runInContext(inlineScripts(html), context, { filename: pageFile });

    const page = vm.runInContext(
        `({ ${EXPORTS.map(name => `${name}: typeof ${name} !== 'undefined' ? ${name} : undefined`).join(', ')} })`,
        context);

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
        /** Fires the file input's change handler with an ID Card file. */
        upload: async text => {
            const input = element('fileinput');
            input.files = [{ name: 'card.id.txt', size: text.length, type: 'text/plain', lastModified: 0, text }];
            await listeners['fileinput:change'].call(input);
            await reading;
        }
    };
}
