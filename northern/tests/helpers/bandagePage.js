'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const PWA = path.join(import.meta.dirname, '..', '..', 'src', 'fs', 'pwa', 'bandage');
const read = name => fs.readFileSync(path.join(PWA, name), 'utf8');

const BOARD_WIDTH = 1000;
const BOARD_HEIGHT = 300;

/** A DOM node, as far as bandage.js and recorder.js need one. */
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
        click() { this.dispatch('click', { target: this }); },
        /** Only the selectors bandage.js and recorder.js actually use. */
        querySelector(selector) {
            const midi = /\[data-midi="(\d+)"\]/.exec(selector);
            if (midi) {
                return this.children.find(child => child.dataset.midi === midi[1]) || null;
            }
            if (!selector.includes('.')) {
                return this.children.find(child => child.tagName === selector.toUpperCase()) || null;
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
 * `tinysynth` itself, built over a fake Web Audio, used for the one thing this
 * app asks of it that cannot be stubbed honestly: reading a MIDI file. It is
 * made only when a test loads one, because building it fills half a second of
 * reverb and noise buffers.
 */
function midiReader() {
    const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {},
        exponentialRampToValueAtTime() {}, setTargetAtTime() {}, cancelScheduledValues() {} });
    const makeNode = () => {
        const it = { gain: param(), frequency: param(), detune: param(), playbackRate: param(),
            pan: param(), Q: param(), threshold: param(), knee: param(), ratio: param(),
            attack: param(), release: param(), buffer: null, type: 'sine',
            connect: () => it, disconnect() {}, start() {}, stop() {}, setPeriodicWave() {} };
        return it;
    };
    class FakeAudioContext {
        constructor() {
            this.sampleRate = 8000;               // enough to build buffers from, quickly
            this.currentTime = 0;
            this.state = 'running';
            this.destination = makeNode();
        }
        resume() {}
        createGain() { return makeNode(); }
        createDynamicsCompressor() { return makeNode(); }
        createConvolver() { return makeNode(); }
        createOscillator() { return makeNode(); }
        createBufferSource() { return makeNode(); }
        createBiquadFilter() { return makeNode(); }
        createStereoPanner() { return makeNode(); }
        createPeriodicWave() { return {}; }
        createBuffer(channels, length) {
            return { length, numberOfChannels: channels, getChannelData: () => new Float32Array(length) };
        }
    }

    const sandbox = {
        console: { log() {}, warn() {} }, Math, Date, Array, Object, Number, String,
        Uint8Array, Float32Array, Promise, isFinite,
        setInterval: () => 0, clearInterval: () => {},
        performance: { now: () => 0 },
        AudioContext: FakeAudioContext
    };
    sandbox.window = sandbox;
    const context = vm.createContext(sandbox);
    vm.runInContext(read('webaudio-tinysynth.js'), context, { filename: 'webaudio-tinysynth.js' });
    const Synth = vm.runInContext('WebAudioTinySynth', context);
    return new Synth({ quality: 0, useReverb: 0, voices: 4 });
}

/**
 * Loads the app against a stub DOM and a synth that records what it was asked
 * to play. Hit testing is real: a point on the board finds the key the geometry
 * puts there, black keys first, as a screen would. The audio clock is fake and
 * only moves when a test says so, so a loop can be run for eight bars in no
 * time at all.
 */
export function loadBandage({ audio = true } = {}) {
    const elements = {};
    const ids = ['keyboard', 'voice_select', 'range_label', 'readout', 'sustain', 'volume',
        'octave_down', 'octave_up', 'tempo', 'tempo_label',
        'transport', 'editor', 'editor_title', 'edit_grid',
        'edit_left', 'edit_right', 'edit_insert', 'edit_delete', 'edit_tie',
        'edit_undo', 'edit_redo', 'edit_close',
        'loop_save', 'loop_load', 'loop_file', 'loop_table', 'loop_all',
        'song_bar', 'song_play', 'song_time', 'song_seek'];
    ids.forEach(id => {
        elements[id] = node('div');
        elements[id].id = id;
    });
    elements.volume.value = '60';
    elements.tempo.value = '120';
    elements.song_seek.value = '0';
    const tbody = node('tbody');
    elements.edit_grid.appendChild(tbody);

    const clock = { time: 0 };
    const timers = new Map();
    let nextTimer = 1;

    const played = [];
    const saved = [];
    let reader = null;

    const document_ = {
        readyState: 'complete',
        hidden: false,
        listeners: {},
        getElementById: id => elements[id] || null,
        /**
         * A real document finds anything with an id, including what the page
         * has just built - which is how the loop table's buttons are reached.
         */
        createElement(tag) {
            const made = node(tag);
            let id = '';
            Object.defineProperty(made, 'id', {
                get: () => id,
                set: (value) => { id = String(value); elements[id] = made; }
            });
            return made;
        },
        addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
        dispatch(type, event = {}) {
            (this.listeners[type] || []).forEach(fn => fn({ preventDefault() {}, ...event }));
        },
        /**
         * The key under a point, black keys winning as their z-index says. The
         * box comes off the key's own style, so the hit testing follows
         * `keys.layout` rather than repeating its numbers.
         */
        elementFromPoint(x, y) {
            const board = elements.keyboard;
            const hit = key => {
                const left = parseFloat(key.style.left) / 100 * BOARD_WIDTH;
                const width = parseFloat(key.style.width) / 100 * BOARD_WIDTH;
                const height = parseFloat(key.style.height) / 100 * BOARD_HEIGHT;
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
        constructor(options) {
            this.options = options; this.programs = {}; this.volume = null;
            this.chvol = {}; this.log = []; this.playing = 0;
            this.playTick = 0; this.maxTick = 0;
        }
        get actx() { return { get state() { return 'running'; }, get currentTime() { return clock.time; }, resume() {} }; }
        setMasterVol(v) { this.volume = v; }
        setProgram(ch, program) { this.programs[ch] = program; }
        noteOn(ch, note, velocity, at) { played.push({ on: note, velocity, ch, at }); }
        noteOff(ch, note, at) { played.push({ off: note, ch, at }); }
        allSoundOff(ch) { played.push({ allOff: true, ch }); }
        resetAllControllers(ch) { played.push({ reset: true, ch }); }
        setChVol(ch, v) { this.chvol[ch] = v; }
        /** The library does the parsing; nothing here pretends to. */
        loadMIDI(data) {
            reader = reader || midiReader();
            reader.loadMIDI(data);
            this.song = reader.song;
            this.maxTick = this.song.ev.length
                ? this.song.ev[this.song.ev.length - 1].t : 0;
            this.playing = 0;
            this.playTick = 0;
        }

        /* The library's own song player, as much of it as the app can see: it
           plays by itself once started, so the fake one moves with the clock. */
        get tick2Time() { return 4 * 60 / (this.song.tempo || 120) / this.song.timebase; }
        playMIDI() {
            if (!this.song) return;
            if (this.playTick >= this.maxTick) this.playTick = 0;
            this.playing = 1;
            this.startedAt = clock.time;
            this.startedTick = this.playTick;
            this.log.push('play');
        }
        stopMIDI() {
            this.playing = 0;
            for (let ch = 0; ch < 16; ch++) played.push({ allOff: true, ch });
            this.log.push('stop');
        }
        locateMIDI(tick) {
            const was = this.playing;
            this.stopMIDI();
            this.playTick = Math.max(0, Math.min(this.maxTick, tick));
            this.log.push(`locate ${this.playTick}`);
            if (was) this.playMIDI();
        }
        getPlayStatus() {
            if (this.playing) {
                const gone = (clock.time - this.startedAt) / this.tick2Time;
                this.playTick = this.startedTick + gone;
                if (this.playTick >= this.maxTick) {
                    this.playTick = this.maxTick;
                    this.playing = 0;               // it ran to the end
                }
            }
            return { play: this.playing, maxTick: this.maxTick, curTick: this.playTick };
        }
    }

    const sandbox = {
        document: document_,
        console: { log() {}, warn() {} },
        navigator: {},
        Map, Set, WeakMap, Number, Array, Math, String, Object, isFinite, Boolean, Uint8Array,
        setInterval(fn) { const id = nextTimer++; timers.set(id, fn); return id; },
        clearInterval(id) { timers.delete(id); },
        setTimeout(fn) { return 0; },
        Blob: class { constructor(parts, options) { this.parts = parts; this.options = options; } },
        URL: { createObjectURL(blob) { saved.push(blob); return 'blob:loops'; }, revokeObjectURL() {} },
        FileReader: class {
            readAsArrayBuffer(bytes) { this.result = bytes; this.onload(); }
        }
    };
    if (audio) {
        sandbox.WebAudioTinySynth = FakeSynth;
        sandbox.AudioContext = function () {};
    }
    const context = vm.createContext(sandbox);
    Object.assign(window_, sandbox);
    sandbox.window = window_;

    vm.runInContext(read('keys.js'), context, { filename: 'keys.js' });
    vm.runInContext(read('loops.js'), context, { filename: 'loops.js' });
    vm.runInContext(read('smf.js'), context, { filename: 'smf.js' });
    vm.runInContext(read('bandage.js'), context, { filename: 'bandage.js' });
    vm.runInContext(read('recorder.js'), context, { filename: 'recorder.js' });

    const app = vm.runInContext('app', context);
    const synth = app.synth;
    const noteName = vm.runInContext('keys', context).name;
    const rec = vm.runInContext('typeof rec === "object" ? rec : null', context);
    const board = elements.keyboard;

    /** The centre of a key, in board coordinates. */
    const pointOf = (midi, fromTop = 0.3) => {
        const key = board.querySelector(`[data-midi="${midi}"]`);
        const left = parseFloat(key.style.left) / 100 * BOARD_WIDTH;
        const width = parseFloat(key.style.width) / 100 * BOARD_WIDTH;
        return { clientX: left + width / 2, clientY: BOARD_HEIGHT * fromTop };
    };

    /** Runs the audio clock on, waking the scheduler the way a browser would. */
    const advance = (seconds, slice = 0.025) => {
        const until = clock.time + seconds;
        while (clock.time < until) {
            clock.time = Math.min(until, clock.time + slice);
            [...timers.values()].forEach(fn => fn());
        }
    };

    return {
        app, rec, window: window_, document: document_, element: id => elements[id],
        board, played, saved, pointOf, clock, advance,
        keys: () => board.children,
        loops: () => vm.runInContext('loops', context),
        smf: () => vm.runInContext('smf', context),
        /** The notes ringing right now, low to high. */
        sounding: () => [...app.sounding.keys()].sort((a, b) => a - b),
        down: () => board.children.filter(key => key.classes.has('down'))
            .map(key => Number(key.dataset.midi)).sort((a, b) => a - b),
        press(midi, pointerId = 1) {
            board.dispatch('pointerdown', { pointerId, ...pointOf(midi) });
        },
        /** Holds a key down for `seconds` of the audio clock, then lets it go. */
        hold(midi, seconds, pointerId = 1) {
            board.dispatch('pointerdown', { pointerId, ...pointOf(midi) });
            advance(seconds);
            window_.dispatch('pointerup', { pointerId });
        },
        slideTo(midi, pointerId = 1) {
            board.dispatch('pointermove', { pointerId, ...pointOf(midi) });
        },
        lift(pointerId = 1) {
            window_.dispatch('pointerup', { pointerId });
        },
        typeDown(key) { window_.dispatch('keydown', { key }); },
        typeUp(key) { window_.dispatch('keyup', { key }); },
        click(id) { elements[id].dispatch('click', {}); },

        /* ---- the loops ---- */

        /** One loop's steps as note names, rests as dots: ['C4 E4', '.', 'G4'] */
        strip(index) {
            return Array.from(rec.loops[index].steps, step => {
                const notes = Array.from(step).filter(note => note !== null);
                // `~C4` is C4 tied over from the step before; `C4` is C4 struck
                return notes.length
                    ? notes.map(note => (note < 0 ? '~' : '') + noteName(Math.abs(note))).join(' ')
                    : '.';
            });
        },
        /** What the editor is showing, row by row. */
        grid() {
            return Array.from(tbody.children,
                row => Array.from(row.children, cell => cell.textContent));
        },
        cursorAt() {
            const at = [];
            tbody.children[0].children.forEach((cell, column) => {
                if (cell.classes.has('at')) at.push(column);
            });
            return at[0];
        },
        clickCell(step, row) {
            const cell = tbody.children[row].children
                .find(one => Number(one.dataset.step) === step);
            tbody.dispatch('click', { target: cell });
        },
        /** The song bar, as a player sees it. */
        song() {
            return {
                shown: !elements.song_bar.hidden,
                time: elements.song_time.textContent,
                playing: elements.song_play.getAttribute('aria-pressed') === 'true',
                at: Number(elements.song_seek.value)
            };
        },
        /** What the library's player was asked to do: ['play', 'locate 240', 'stop'] */
        songLog() { return synth ? synth.log : []; },
        /** The notes the loops sounded, by channel, since the last look. */
        loopNotes(channel) {
            return played.filter(call => call.on !== undefined && call.ch === channel)
                .map(call => call.on);
        }
    };
}
