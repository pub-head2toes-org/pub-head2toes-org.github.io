'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const PWA = path.join(import.meta.dirname, '..', '..', 'src', 'fs', 'pwa', 'grinder');
const read = name => fs.readFileSync(path.join(PWA, name), 'utf8');

/** The files the page loads, in the order the script tags load them. */
export const FILES = ['font.js', 'text.js', 'world.js', 'foes.js', 'weapons.js', 'input.js',
    'scores.js', 'game.js', 'render.js', 'screens.js', 'grinder.js'];

/**
 * A 2d context that draws nothing and refuses nothing.
 *
 * It remembers the calls, and `written` reads the text back off them: every
 * word in this game is a run of `fillRect`s out of the matrix font, so what a
 * card says can be read from what was drawn without a canvas anywhere near it.
 */
function paintStub() {
    const paint = {
        calls: [],
        fillStyle: '', strokeStyle: '', lineWidth: 0, lineCap: '', lineJoin: '',
        shadowColor: '', shadowBlur: 0, globalAlpha: 1
    };
    for (const name of ['setTransform', 'clearRect', 'fillRect', 'strokeRect', 'beginPath', 'arc',
        'fill', 'stroke', 'moveTo', 'lineTo', 'closePath', 'save', 'restore', 'translate', 'rotate', 'rect']) {
        paint[name] = (...args) => paint.calls.push({ name, args, fillStyle: paint.fillStyle });
    }
    return paint;
}

/** A DOM node, as far as the page needs one - which is a canvas, and no more. */
function node(tag, page) {
    const element = {
        tagName: tag.toUpperCase(),
        id: '',
        style: {},
        listeners: {},
        width: 0,
        height: 0,
        addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
        focus() {},
        getContext: tag === 'canvas' && page.canvas ? () => (element.paint = element.paint || paintStub()) : undefined
    };
    return element;
}

/**
 * Loads the page against a stub DOM and gives back the handles a test drives
 * it with: the frame, the pad, the keyboard, and what was drawn.
 *
 * Nothing is painted. What a test reads is the app's own state and the cards
 * `screens.js` works out, which is what the player is looking at.
 */
export function loadGrinder({ width = 1000, height = 600, scores = null, canvas = true } = {}) {
    const page = { canvas: canvas };
    const field = node('canvas', page);
    field.id = 'field';

    const store = new Map();
    if (scores) store.set('grinder.scores', JSON.stringify(scores));

    let pads = [];
    const frames = [];
    let now = 0;

    const document_ = {
        readyState: 'complete',
        hidden: false,
        listeners: {},
        getElementById: id => (id === 'field' ? field : null),
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
        field,
        paint: () => field.paint,
        frame,
        /** Runs for this long, in frames of this many milliseconds. */
        run(ms, step = 16) {
            for (let passed = 0; passed < ms; passed += step) frame(step);
            return app;
        },
        /** The card that is up, as lines of text. */
        card() {
            const screens = vm.runInContext('screens', context);
            return screens.card(app.screen, app).lines.map(line => line.text);
        },
        /** What the pad is doing, until it is said otherwise. */
        pad(axes = [0, 0, 0, 0], buttons = {}) {
            const pressed = [];
            for (let index = 0; index < 17; index++) pressed.push({ pressed: !!buttons[index], value: buttons[index] ? 1 : 0 });
            pads = [{ connected: true, axes, buttons: pressed }];
        },
        /** A button pressed and let go again, which is what an edge needs. */
        press(button, axes) {
            this.pad(axes || [0, 0, 0, 0], { [button]: true });
            frame();
            this.pad(axes || [0, 0, 0, 0], {});
            frame();
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
