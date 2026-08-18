'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const PWA = path.join(import.meta.dirname, '..', '..', 'src', 'fs', 'pwa', 'bandage');
const read = name => fs.readFileSync(path.join(PWA, name), 'utf8');

const BOARD_WIDTH = 1000;
const BOARD_HEIGHT = 300;

/** A DOM node, as far as bandage.js needs one. */
function node(tag) {
    const element = {
        tagName: tag.toUpperCase(),
        children: [],
        style: {},
        // A real dataset stringifies whatever it is given; bandage.js reads the
        // value back with Number(), and the stub must not paper over that.
        dataset: new Proxy({}, { set(target, key, value) { target[key] = String(value); return true; } }),
        attributes: {},
        textContent: '',
        classes: new Set(),
        listeners: {},
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
        setAttribute(name, value) { this.attributes[name] = String(value); },
        getAttribute(name) { return this.attributes[name]; },
        addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
        dispatch(type, event = {}) {
            (this.listeners[type] || []).forEach(fn => fn({ preventDefault() {}, ...event }));
        },
        /** Only the selectors bandage.js actually uses. */
        querySelector(selector) {
            const midi = /\[data-midi="(\d+)"\]/.exec(selector);
            if (midi) {
                return this.children.find(child => child.dataset.midi === midi[1]) || null;
            }
            return this.querySelectorAll(selector)[0] || null;
        },
        querySelectorAll(selector) {
            const wanted = selector.split('.').filter(Boolean);
            return this.children.filter(child => wanted.every(name => child.classes.has(name)));
        },
        closest(selector) {
            const name = selector.replace('.', '');
            return this.classes.has(name) ? this : null;
        }
    };
    return element;
}

/**
 * Loads keys.js and the real bandage.js against a stub DOM and a synth that
 * records what it was asked to play. Hit testing is real: a point on the board
 * finds the key the geometry puts there, black keys first, as a screen would.
 */
export function loadBandage({ audio = true } = {}) {
    const elements = {};
    ['keyboard', 'voice_select', 'range_label', 'readout', 'sustain', 'volume',
        'octave_down', 'octave_up'].forEach(id => {
        elements[id] = node('div');
        elements[id].id = id;
    });
    elements.volume.value = '60';

    const played = [];
    const document_ = {
        readyState: 'complete',
        hidden: false,
        listeners: {},
        getElementById: id => elements[id] || null,
        createElement: node,
        addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
        dispatch(type, event = {}) {
            (this.listeners[type] || []).forEach(fn => fn({ preventDefault() {}, ...event }));
        },
        /** The key under a point, black keys winning as their z-index says. */
        elementFromPoint(x, y) {
            const board = elements.keyboard;
            const hit = key => {
                const left = parseFloat(key.style.left) / 100 * BOARD_WIDTH;
                const width = parseFloat(key.style.width) / 100 * BOARD_WIDTH;
                const height = key.classes.has('black') ? BOARD_HEIGHT * 0.62 : BOARD_HEIGHT;
                return x >= left && x < left + width && y >= 0 && y < height;
            };
            return board.children.filter(key => key.classes.has('black')).find(hit)
                || board.children.filter(key => !key.classes.has('black')).find(hit)
                || null;
        }
    };

    const window_ = {
        listeners: {},
        addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
        dispatch(type, event = {}) {
            (this.listeners[type] || []).forEach(fn => fn({ preventDefault() {}, ...event }));
        },
        location: { href: '', replace(url) { this.href = url; } }
    };

    class FakeSynth {
        constructor(options) { this.options = options; this.programs = {}; this.volume = null; }
        get actx() { return { state: 'running', resume() {} }; }
        setMasterVol(v) { this.volume = v; }
        setProgram(ch, program) { this.programs[ch] = program; }
        noteOn(ch, note, velocity) { played.push({ on: note, velocity }); }
        noteOff(ch, note) { played.push({ off: note }); }
        allSoundOff() { played.push({ allOff: true }); }
    }

    const sandbox = {
        document: document_,
        console: { log() {}, warn() {} },
        navigator: {},
        Map, Set, Number, Array, Math, String, Object, isFinite
    };
    if (audio) {
        sandbox.WebAudioTinySynth = FakeSynth;
        sandbox.AudioContext = function () {};
    }
    const context = vm.createContext(sandbox);
    Object.assign(window_, sandbox);
    sandbox.window = window_;

    vm.runInContext(read('keys.js'), context, { filename: 'keys.js' });
    vm.runInContext(read('bandage.js'), context, { filename: 'bandage.js' });

    const app = vm.runInContext('app', context);
    const board = elements.keyboard;

    /** The centre of a key, in board coordinates. */
    const pointOf = (midi, fromTop = 0.3) => {
        const key = board.querySelector(`[data-midi="${midi}"]`);
        const left = parseFloat(key.style.left) / 100 * BOARD_WIDTH;
        const width = parseFloat(key.style.width) / 100 * BOARD_WIDTH;
        return { clientX: left + width / 2, clientY: BOARD_HEIGHT * fromTop };
    };

    return {
        app, window: window_, document: document_, element: id => elements[id],
        board, played, pointOf,
        keys: () => board.children,
        /** The notes ringing right now, low to high. */
        sounding: () => [...app.sounding.keys()].sort((a, b) => a - b),
        down: () => board.children.filter(key => key.classes.has('down'))
            .map(key => Number(key.dataset.midi)).sort((a, b) => a - b),
        press(midi, pointerId = 1) {
            board.dispatch('pointerdown', { pointerId, ...pointOf(midi) });
        },
        slideTo(midi, pointerId = 1) {
            board.dispatch('pointermove', { pointerId, ...pointOf(midi) });
        },
        lift(pointerId = 1) {
            window_.dispatch('pointerup', { pointerId });
        },
        typeDown(key) { window_.dispatch('keydown', { key }); },
        typeUp(key) { window_.dispatch('keyup', { key }); },
        click(id) { elements[id].dispatch('click', {}); }
    };
}
