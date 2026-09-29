'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const PWA = path.join(import.meta.dirname, '..', '..', 'src', 'fs', 'pwa', 'sezam');
export const read = name => fs.readFileSync(path.join(PWA, name), 'utf8');
export const PWA_DIR = PWA;

/**
 * The page's own scripts, run the way the browser runs them.
 *
 * They cannot simply be imported: the package is `"type": "module"` and these
 * are plain browser scripts that hang one global each, so they are evaluated
 * in a context instead - which is also what the other PWA tests here do.
 *
 * `api.js`, `format.js`, `router.js` and `views.js` need no DOM at all, which
 * is deliberate: everything with logic worth testing lives in them, and
 * `sezam.js` is left holding only the wiring.
 */
export function loadSezam({ fetch } = {}) {
    const context = {
        console,
        URL,
        URLSearchParams,
        setTimeout,
        clearTimeout,
        fetch: fetch || (() => Promise.reject(new Error('no fetch in this test'))),
        window: {},
        module: undefined
    };
    context.globalThis = context;
    vm.createContext(context);
    for (const file of ['api.js', 'format.js', 'router.js', 'views.js']) {
        vm.runInContext(read(file), context, { filename: file });
    }
    // Each script declares its global with const, which lands in the context's
    // shared lexical scope rather than on the context object - so it is read
    // back by evaluating the name, the way the other PWA helpers here do.
    const of = name => vm.runInContext(name, context);
    return { Api: of('Api'), Format: of('Format'), Router: of('Router'), Views: of('Views'), of, context };
}

/** A fetch that answers from a table of { url: [status, body] }. */
export function fakeFetch(routes) {
    const calls = [];
    const fetch = (href, options) => {
        calls.push({ href, options });
        const entry = Object.prototype.hasOwnProperty.call(routes, href) ? routes[href] : null;
        if (!entry) {
            return Promise.resolve(response(404, { error: { code: 'NotFound', message: 'no ' + href } }));
        }
        if (entry instanceof Error) return Promise.reject(entry);
        return Promise.resolve(response(entry[0], entry[1]));
    };
    fetch.calls = calls;
    return fetch;
}

function response(status, body) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(body)
    };
}

/**
 * A DOM shim just big enough to run sezam.js.
 *
 * It is backed by strings, not a tree: innerHTML is kept as text and the few
 * lookups the router makes - getElementById, querySelector('.more-btn') - are
 * answered by reading that text. That is enough to prove the wiring runs, that
 * each route renders what it should and that "load more" appends rather than
 * replaces, which is all of sezam.js there is. It is not a browser and does
 * not pretend to be: anything needing real layout or event bubbling belongs in
 * a browser, not here.
 */
export function mountSezam({ fetch }) {
    const listeners = { window: {} };
    const elements = {};

    function element(id) {
        const self = {
            id,
            innerHTML: '',
            textContent: '',
            value: '',
            disabled: false,
            classes: new Set(),
            attributes: {},
            listeners: {},
            formFields: [],
            parentNode: null,
            classList: {
                add: name => self.classes.add(name),
                remove: name => self.classes.delete(name),
                contains: name => self.classes.has(name)
            },
            addEventListener(type, fn) { (self.listeners[type] = self.listeners[type] || []).push(fn); },
            getAttribute(name) { return name in self.attributes ? self.attributes[name] : null; },
            setAttribute(name, value) { self.attributes[name] = String(value); },
            removeChild() {},
            focus() { self.focused = true; },
            scrollIntoView() { self.scrolled = true; },
            insertAdjacentHTML(_where, html) { self.innerHTML += html; },
            querySelector(selector) { return query(self, selector); },
            get elements() { return self.formFields; },
            dispatch(type, event = {}) {
                (self.listeners[type] || []).forEach(fn => fn(Object.assign({
                    preventDefault() {}, currentTarget: self, target: self
                }, event)));
            }
        };
        return self;
    }

    /**
     * The selectors sezam.js asks for, answered out of the rendered HTML.
     *
     * A list found by id gets an insertAdjacentHTML that splices into the view
     * just before that list's closing tag - so "load more" is checked for
     * where it puts the rows, not only that it fetched them.
     */
    function query(parent, selector) {
        const html = parent.innerHTML;
        // Memoised per render: the page wires a listener onto the node it gets
        // back, so asking twice has to return the same node, not a copy.
        if (!parent.queryCache || parent.queryCache.html !== html) {
            parent.queryCache = { html, found: {} };
        }
        if (Object.prototype.hasOwnProperty.call(parent.queryCache.found, selector)) {
            return parent.queryCache.found[selector];
        }
        const answer = find(parent, selector, html);
        parent.queryCache.found[selector] = answer;
        return answer;
    }

    function find(parent, selector, html) {
        if (selector === '.more-btn') {
            const found = html.match(/class="more-btn" data-next="([^"]*)"/);
            if (!found) return null;
            const button = element('more-btn');
            button.attributes['data-next'] = decodeEntities(found[1]);
            button.parentNode = {
                parentNode: {
                    removeChild() {
                        parent.innerHTML = parent.innerHTML.replace(/<div class="more">[\s\S]*?<\/div>/, '');
                    }
                }
            };
            return button;
        }
        if (selector === '.count') {
            if (!html.includes('class="count"')) return null;
            const counter = element('count');
            Object.defineProperty(counter, 'textContent', {
                get: () => (parent.innerHTML.match(/class="count">([^<]*)/) || [])[1] || '',
                set: value => {
                    parent.innerHTML = parent.innerHTML.replace(/(class="count">)[^<]*/, '$1' + value);
                }
            });
            return counter;
        }
        if (selector.charAt(0) === '#' || selector.charAt(0) === '.') {
            const attribute = selector.charAt(0) === '#' ? 'id' : 'class';
            const name = selector.slice(1);
            const at = html.indexOf(attribute + '="' + name + '"');
            if (at === -1) return null;
            const list = element(name);
            list.insertAdjacentHTML = function (where, added) {
                const open = html.lastIndexOf('<', at);
                const tag = (html.slice(open + 1).match(/^[a-zA-Z]+/) || ['ul'])[0];
                const close = parent.innerHTML.indexOf('</' + tag + '>', at);
                if (close === -1 || where !== 'beforeend') {
                    parent.innerHTML += added;
                    return;
                }
                parent.innerHTML = parent.innerHTML.slice(0, close) + added + parent.innerHTML.slice(close);
            };
            return list;
        }
        return null;
    }

    function decodeEntities(value) {
        return value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    }

    for (const id of ['view', 'crumbs', 'foot_meta', 'search_form', 'search_input']) {
        elements[id] = element(id);
    }

    const location = {
        hash: '',
        replace(to) { setHash(to, true); }
    };

    function setHash(to, replaced) {
        const next = String(to).indexOf('#') === 0 ? to : '#' + to;
        if (location.hash === next) return;
        location.hash = next;
        location.replaced = replaced === true;
        (listeners.window.hashchange || []).forEach(fn => fn({}));
    }

    // Elements the current view rendered are cached only until the next
    // render, so a route never hands the one before it a stale node.
    let rendered = {};
    let lastHtml = null;

    const document = {
        getElementById(id) {
            if (elements[id]) return elements[id];
            const html = elements.view.innerHTML;
            if (html !== lastHtml) {
                rendered = {};
                lastHtml = html;
            }
            if (rendered[id]) return rendered[id];
            if (html.includes('id="' + id + '"')) {
                rendered[id] = element(id);
                return rendered[id];
            }
            return null;
        }
    };

    const context = {
        console,
        URL,
        URLSearchParams,
        setTimeout,
        clearTimeout,
        fetch,
        document,
        location,
        navigator: {},
        window: {
            addEventListener(type, fn) { (listeners.window[type] = listeners.window[type] || []).push(fn); },
            location
        },
        module: undefined
    };
    context.globalThis = context;
    vm.createContext(context);
    for (const file of ['api.js', 'format.js', 'router.js', 'views.js', 'sezam.js']) {
        vm.runInContext(read(file), context, { filename: file });
    }

    const page = {
        context,
        location,
        elements,
        get html() { return elements.view.innerHTML; },
        get crumbs() { return elements.crumbs.innerHTML; },
        get foot() { return elements.foot_meta.textContent; },
        go(hash) {
            setHash(hash);
            return page.settled();
        },
        /** Waits for the view to stop saying it is loading. */
        async settled(timeoutMs = 4000) {
            const deadline = Date.now() + timeoutMs;
            for (;;) {
                await new Promise(resolve => setImmediate(resolve));
                if (!page.html.includes('Reading…') && !page.html.includes('Opening the archive')
                    && page.html !== '') {
                    return page;
                }
                if (Date.now() > deadline) throw new Error('view never settled: ' + page.html.slice(0, 120));
            }
        },
        /** Clicks the "load more" button the current view rendered. */
        async loadMore() {
            const button = elements.view.querySelector('.more-btn');
            if (!button) throw new Error('no more button on this page');
            button.dispatch('click');
            const before = page.html;
            const deadline = Date.now() + 4000;
            while (page.html === before) {
                await new Promise(resolve => setImmediate(resolve));
                if (Date.now() > deadline) throw new Error('load more never finished');
            }
            return page;
        }
    };
    return page;
}

/** A fetch that answers out of a live SezamApi, so the page talks to the real thing. */
export function apiFetch(api, MockRes) {
    return function (href) {
        const url = new URL(href, 'http://sezam.test');
        const query = {};
        url.searchParams.forEach((value, key) => {
            if (key in query) {
                query[key] = [].concat(query[key], value);
            } else {
                query[key] = value;
            }
        });
        const res = new MockRes();
        return api.handle(url.pathname, query, { headers: {} }, res)
            .then(() => res.done)
            .then(() => ({
                ok: res.statusCode >= 200 && res.statusCode < 300,
                status: res.statusCode,
                json: () => Promise.resolve(res.statusCode === 304 ? null : res.json)
            }));
    };
}
