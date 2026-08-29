'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const PWA = path.join(import.meta.dirname, '..', '..', 'src', 'fs', 'pwa', 'chestnut');
const read = name => fs.readFileSync(path.join(PWA, name), 'utf8');

const ROOM = { width: 1000, height: 600 };       // the main row the board is sized against

/** A DOM node, as far as chestnut.js needs one. */
function node(tag) {
    const element = {
        tagName: tag.toUpperCase(),
        children: [],
        style: {},
        attributes: {},
        listeners: {},
        classes: new Set(),
        textContent: '',
        value: '',
        hidden: false,
        disabled: false,
        selectionStart: 0,
        files: [],
        get firstChild() { return this.children[0] || null; },
        get options() { return this.children; },
        get selectedIndex() { return this.children.findIndex(child => child.value === this.value); },
        get className() { return [...this.classes].join(' '); },
        set className(value) { this.classes = new Set(String(value).split(/\s+/).filter(Boolean)); },
        get innerHTML() { return ''; },
        set innerHTML(value) { if (!value) this.children = []; },
        classList: {
            add(...names) { names.forEach(name => element.classes.add(name)); },
            remove(...names) { names.forEach(name => element.classes.delete(name)); },
            contains(name) { return element.classes.has(name); },
            toggle(name, on) {
                const wanted = on === undefined ? !element.classes.has(name) : !!on;
                if (wanted) element.classes.add(name); else element.classes.delete(name);
                return wanted;
            }
        },
        appendChild(child) { this.children.push(child); return child; },
        removeChild(child) { this.children = this.children.filter(one => one !== child); return child; },
        setAttribute(name, value) { this.attributes[name] = String(value); },
        getAttribute(name) { return this.attributes[name] === undefined ? null : this.attributes[name]; },
        setSelectionRange(start) { this.selectionStart = start; },
        addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
        dispatch(type, event = {}) {
            (this.listeners[type] || []).forEach(fn => fn({ preventDefault() {}, target: element, ...event }));
        },
        click() { this.dispatch('click', {}); },
        getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; },
        /** Only a canvas has one, and chestnut.js tests for exactly that. */
        getContext: tag === 'canvas' ? () => paintStub() : undefined
    };
    return element;
}

/** A 2d context that records nothing and refuses nothing. */
function paintStub() {
    const paint = {
        calls: [],
        fillStyle: '', strokeStyle: '', lineWidth: 0, lineCap: '', font: '',
        textAlign: '', textBaseline: ''
    };
    for (const name of ['setTransform', 'clearRect', 'fillRect', 'beginPath', 'arc', 'fill', 'stroke',
        'moveTo', 'lineTo', 'closePath', 'fillText']) {
        paint[name] = (...args) => paint.calls.push({ name, args });
    }
    return paint;
}

/**
 * Loads the page against a stub DOM.
 *
 * The board's geometry is the app's own: a click at a square is aimed with
 * `board.centre`, so a test says 'E2' and the hit testing that runs is the hit
 * testing the page runs. Nothing is drawn - the canvas takes the calls and
 * throws them away - and everything that can be read back is read off the
 * state, the SVG and the text area, which is what a player sees.
 */
export function loadChestnut({ pgn = null, room = ROOM } = {}) {
    const space = { ...room };
    const elements = {};
    const ids = ['main', 'message', 'actions', 'board', 'squares', 'pieces', 'palette', 'palette_pieces',
        'variation', 'movetext', 'editbar', 'speed', 'level', 'turn', 'notation',
        'first', 'back', 'play', 'step', 'last', 'analyze', 'flip', 'setup', 'edit', 'puzzle',
        'new_game', 'load', 'save', 'file', 'setup_done', 'setup_clear', 'setup_standard',
        'up', 'down', 'add', 'del', 'note', 'main_line', 'reveal'];
    ids.forEach(id => {
        elements[id] = node(id === 'squares' ? 'canvas' : 'div');
        elements[id].id = id;
    });
    elements.speed.value = '1000';
    elements.level.value = '1';
    elements.turn.value = 'white';
    elements.movetext.tagName = 'TEXTAREA';

    elements.main.getBoundingClientRect = () => ({ left: 0, top: 0, ...space });
    // The palette is a column beside the move list; it has a width when it is
    // shown and none when it is not, which is what the board is sized around.
    elements.palette.getBoundingClientRect = () => ({
        left: 0, top: 0, width: elements.palette.hidden ? 0 : 136, height: 0
    });
    elements.board.getBoundingClientRect = () => ({
        left: 0, top: 0, width: parseFloat(elements.board.style.width) || 0,
        height: parseFloat(elements.board.style.height) || 0
    });

    const store = new Map();
    if (pgn) store.set('chestnut.pgn', pgn);

    const timers = new Map();
    let nextTimer = 1;
    const saved = [];
    const asked = [];                    // what window.prompt was asked, in order
    let answer = () => null;             // what the test answers it with

    const document_ = {
        readyState: 'complete',
        documentElement: node('html'),
        body: node('body'),
        listeners: {},
        getElementById: id => elements[id] || null,
        createElement: tag => node(tag),
        createElementNS: (namespace, tag) => node(tag),
        addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
        dispatch(type, event = {}) {
            (this.listeners[type] || []).forEach(fn => fn({ preventDefault() {}, target: node('div'), ...event }));
        }
    };

    const window_ = {
        devicePixelRatio: 2,
        listeners: {},
        addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
        dispatch(type, event = {}) {
            (this.listeners[type] || []).forEach(fn => fn({ preventDefault() {}, ...event }));
        },
        location: { href: './index.html', replace(url) { this.href = url; } },
        prompt(question, value) { asked.push(question); return answer(question, value); },
        localStorage: {
            getItem: key => (store.has(key) ? store.get(key) : null),
            setItem: (key, value) => store.set(key, String(value)),
            removeItem: key => store.delete(key)
        },
        setInterval(fn) { const id = nextTimer++; timers.set(id, fn); return id; },
        clearInterval(id) { timers.delete(id); },
        setTimeout(fn) { fn(); return 0; }        // the engine is called on one, so it runs at once
    };

    const sandbox = {
        document: document_,
        navigator: {},
        console: { log() {}, warn() {} },
        Math, Number, String, Object, Array, Set, Map, JSON, Boolean, isNaN, parseInt, parseFloat, Infinity,
        // The row carries 10px of padding, as the stylesheet gives it: the board
        // is sized to the content box, and a stub without padding would not
        // notice a board sized to the border box instead.
        getComputedStyle: () => ({
            paddingTop: '10px', paddingBottom: '10px', paddingLeft: '10px', paddingRight: '10px',
            getPropertyValue: name => '#' + name.replace(/\W/g, '').slice(0, 6)
        }),
        Blob: class { constructor(parts, options) { this.text = parts.join(''); this.options = options; } },
        URL: { createObjectURL(blob) { saved.push(blob); return 'blob:game'; }, revokeObjectURL() {} },
        FileReader: class {
            readAsText(file) { this.result = file.text; this.onload(); }
        },
        module: { exports: {} }
    };
    sandbox.exports = sandbox.module.exports;
    Object.assign(sandbox, {
        setInterval: window_.setInterval, clearInterval: window_.clearInterval, setTimeout: window_.setTimeout
    });
    const context = vm.createContext(sandbox);
    Object.assign(window_, { document: document_ });
    sandbox.window = window_;

    vm.runInContext(read('js-chess-engine.js'), context, { filename: 'js-chess-engine.js' });
    vm.runInContext('var jsChessEngine = module.exports;', context);
    for (const file of ['chess.js', 'board.js', 'pgn.js', 'game.js', 'chestnut.js']) {
        vm.runInContext(read(file), context, { filename: file });
    }

    const app = vm.runInContext('app', context);
    const board = vm.runInContext('board', context);
    const game = vm.runInContext('game', context);
    const chess = vm.runInContext('chess', context);

    const pointAt = square => {
        const middle = board.centre(square, app.side, app.flipped);
        return { clientX: middle.x, clientY: middle.y };
    };

    return {
        app, board, game, chess,
        window: window_, document: document_,
        element: id => elements[id],
        saved,
        asked,

        /** What the message bar says. */
        message: () => elements.message.textContent,
        /** The move list, line by line. */
        list: () => (elements.movetext.value ? elements.movetext.value.split('\n') : []),
        /** The lines on offer in the select. */
        variations: () => elements.variation.children.map(option => option.textContent),
        /** The pieces the SVG is showing, keyed by square. */
        drawn: () => Object.fromEntries(elements.pieces.children
            .map(glyph => [glyph.attributes['data-square'], glyph.textContent])),
        /** Where a piece is drawn on screen, to see the board turn round. */
        drawnAt: square => elements.pieces.children
            .filter(glyph => glyph.attributes['data-square'] === square)
            .map(glyph => ({ x: Number(glyph.attributes.x), y: Number(glyph.attributes.y) }))[0] || null,

        click: id => elements[id].dispatch('click', {}),
        press: square => elements.board.dispatch('pointerdown', pointAt(square)),
        /** Take a piece and put it down: what a move on the board is. */
        move(from, to) { this.press(from); this.press(to); },
        /** Put the caret on a line of the move list, the way a tap does. */
        pick(row) {
            const rows = elements.movetext.value.split('\n');
            let offset = 0;
            for (let index = 0; index < row; index++) offset += rows[index].length + 1;
            elements.movetext.selectionStart = offset;
            elements.movetext.dispatch('click', {});
        },
        choose(id, value) { elements[id].value = String(value); elements[id].dispatch('change', {}); },
        type: key => document_.dispatch('keydown', { key, target: node('div') }),
        /** What the next prompt is answered with. */
        answers(fn) { answer = typeof fn === 'function' ? fn : () => fn; },
        /** One beat of the play-through. */
        tick(times = 1) { for (let step = 0; step < times; step++) timers.forEach(fn => fn()); },
        playing: () => timers.size > 0,
        /** Hand the file input a file, as a browser does after a pick. */
        upload(text, name = 'game.pgn') {
            elements.file.files = [{ name, text }];
            elements.file.dispatch('change', {});
        },
        stored: () => store.get('chestnut.pgn') || null,
        /** The row the board is sized against, as a header that wraps changes it. */
        room: () => ({ ...space }),
        resizeTo(width, height) {
            space.width = width;
            space.height = height;
            window_.dispatch('resize', {});
        },
        /** The board as the stylesheet ends up with it, in pixels. */
        boardBox: () => ({
            width: parseFloat(elements.board.style.width),
            height: parseFloat(elements.board.style.height)
        })
    };
}
