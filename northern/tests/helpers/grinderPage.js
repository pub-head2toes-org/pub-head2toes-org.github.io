'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const PWA = path.join(import.meta.dirname, '..', '..', 'src', 'fs', 'pwa', 'grinder');
const read = name => fs.readFileSync(path.join(PWA, name), 'utf8');

/** The files the page loads, in the order the script tags load them. */
export const FILES = ['world.js', 'foes.js', 'weapons.js', 'input.js', 'scores.js', 'game.js',
    'render.js', 'grinder.js'];

const SCREEN = { welcome: ['play', 'high'], scores: ['back'], over: ['again', 'home'] };
const IDS = ['field', 'hud', 'score', 'best', 'bombs', 'paused', 'welcome', 'scores', 'over',
    'table', 'final', 'place', 'play', 'high', 'home', 'again', 'back', 'pad'];

/** A 2d context that draws nothing and refuses nothing, but remembers the calls. */
function paintStub() {
    const paint = {
        calls: [],
        fillStyle: '', strokeStyle: '', lineWidth: 0, lineCap: '', lineJoin: '',
        shadowColor: '', shadowBlur: 0, globalAlpha: 1
    };
    for (const name of ['setTransform', 'clearRect', 'fillRect', 'strokeRect', 'beginPath', 'arc',
        'fill', 'stroke', 'moveTo', 'lineTo', 'closePath', 'save', 'restore', 'translate', 'rotate', 'rect']) {
        paint[name] = (...args) => paint.calls.push({ name, args });
    }
    return paint;
}

/** A DOM node, as far as grinder.js needs one. */
function node(tag, page) {
    const element = {
        tagName: tag.toUpperCase(),
        id: '',
        children: [],
        style: {},
        listeners: {},
        hidden: false,
        textContent: '',
        className: '',
        width: 0,
        height: 0,
        appendChild(child) { this.children.push(child); return child; },
        set innerHTML(value) { if (!value) this.children = []; },
        get innerHTML() { return ''; },
        addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
        dispatch(type, event = {}) {
            (this.listeners[type] || []).forEach(fn => fn({ preventDefault() {}, target: element, ...event }));
        },
        click() { this.dispatch('click', {}); },
        focus() { page.activeElement = element; },
        /** Only ever asked for buttons, and only ever of a screen. */
        querySelectorAll() {
            const found = [];
            const walk = one => one.children.forEach(child => {
                if (child.tagName === 'BUTTON') found.push(child);
                walk(child);
            });
            walk(element);
            return found;
        },
        getContext: tag === 'canvas' && page.canvas ? () => (element.paint = element.paint || paintStub()) : undefined
    };
    return element;
}

/**
 * Loads the page against a stub DOM and gives back the handles a test drives
 * it with: the frame, the pad, the keyboard and the elements.
 *
 * Nothing is drawn - the canvas takes the calls and throws them away - and
 * every answer is read off the app's own state or off the elements, which is
 * what a player sees.
 */
export function loadGrinder({ width = 1000, height = 600, scores = null, canvas = true } = {}) {
    const page = { activeElement: null, canvas: canvas };
    const elements = {};
    for (const id of IDS) {
        elements[id] = node(id === 'field' ? 'canvas' : 'div', page);
        elements[id].id = id;
    }
    for (const [screen, ids] of Object.entries(SCREEN)) {
        for (const id of ids) {
            elements[id].tagName = 'BUTTON';
            elements[screen].appendChild(elements[id]);
        }
    }

    const store = new Map();
    if (scores) store.set('grinder.scores', JSON.stringify(scores));

    let pads = [];
    const frames = [];
    let now = 0;

    const document_ = {
        readyState: 'complete',
        hidden: false,
        listeners: {},
        get activeElement() { return page.activeElement; },
        getElementById: id => elements[id] || null,
        createElement: tag => node(tag, page),
        addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
        dispatch(type, event = {}) {
            (this.listeners[type] || []).forEach(fn => fn({ preventDefault() {}, ...event }));
        }
    };

    const window_ = {
        innerWidth: width,
        innerHeight: height,
        devicePixelRatio: 2,
        listeners: {},
        document: document_,
        addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
        dispatch(type, event = {}) {
            (this.listeners[type] || []).forEach(fn => fn({ preventDefault() {}, ...event }));
        },
        location: { href: './index.html', replace(url) { this.href = url; } },
        localStorage: {
            getItem: key => (store.has(key) ? store.get(key) : null),
            setItem: (key, value) => store.set(key, String(value))
        },
        requestAnimationFrame(fn) { frames.push(fn); return frames.length; }
    };

    const sandbox = {
        document: document_,
        navigator: { getGamepads: () => pads },
        console: { log() {}, warn() {} },
        Math, Number, String, Object, Array, Set, Map, JSON, Boolean, Date, isFinite, isNaN,
        parseInt, parseFloat, Infinity, Uint8Array
    };
    const context = vm.createContext(sandbox);
    sandbox.window = window_;
    Object.assign(sandbox, { requestAnimationFrame: window_.requestAnimationFrame });

    for (const file of FILES) vm.runInContext(read(file), context, { filename: file });

    const app = vm.runInContext('app', context);

    /**
     * One frame, `ms` after the last. The loop hands the next frame back
     * through `requestAnimationFrame`, so the pending one is taken off the
     * queue and called - which is exactly what the browser does.
     */
    const frame = (ms = 16) => {
        now += ms;
        const next = frames.shift();
        if (next) next(now);
        return app;
    };

    return {
        app,
        window: window_,
        document: document_,
        element: id => elements[id],
        paint: () => elements.field.paint,
        frame,
        /** Runs for this long, in frames of this many milliseconds. */
        run(ms, step = 16) {
            for (let passed = 0; passed < ms; passed += step) frame(step);
            return app;
        },
        /** What the pad is doing, until it is said otherwise. */
        pad(axes = [0, 0, 0, 0], buttons = {}) {
            const pressed = [];
            for (let index = 0; index < 17; index++) pressed.push({ pressed: !!buttons[index], value: buttons[index] ? 1 : 0 });
            pads = [{ connected: true, axes, buttons: pressed }];
        },
        unplug() { pads = []; },
        key: {
            down: key => window_.dispatch('keydown', { key }),
            up: key => window_.dispatch('keyup', { key })
        },
        stored: () => JSON.parse(store.get('grinder.scores') || '[]'),
        of: name => vm.runInContext(name, context)
    };
}
