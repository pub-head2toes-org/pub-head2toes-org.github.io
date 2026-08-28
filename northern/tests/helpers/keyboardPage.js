'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const JS_DIR = path.join(import.meta.dirname, '..', '..', 'src', 'fs', 'js');
const read = name => fs.readFileSync(path.join(JS_DIR, name), 'utf8');

/**
 * A textarea, as far as history.js and textedit.js are concerned: a value, a
 * selection, focus, and listeners. Enough to run the real scripts against.
 */
function textarea(id, document) {
    const listeners = {};
    return {
        id,
        value: '',
        selectionStart: 0,
        selectionEnd: 0,
        addEventListener(event, fn) {
            (listeners[event] = listeners[event] || []).push(fn);
        },
        dispatch(event, payload) {
            (listeners[event] || []).forEach(fn => fn(payload));
        },
        focus() {
            document.activeElement = this;
            this.dispatch('focus', { type: 'focus' });
        },
        listeners
    };
}

/**
 * Loads history.js and textedit.js into a vm with a DOM stub, plus the three
 * buffers keyboard.html has. Time is a hook, so a typing pause costs nothing.
 */
export function loadTextedit({ ids = ['clip', 'text', 'text2'], watch = true, helper = false } = {}) {
    const elements = {};
    const document = {
        activeElement: null,
        getElementById: id => elements[id] || null
    };
    ids.forEach(id => { elements[id] = textarea(id, document); });

    let clock = 1000;

    const sandbox = { document, console: { log() {} } };
    const context = vm.createContext(sandbox);
    sandbox.window = sandbox;

    for (const name of ['history.js', 'textedit.js']) {
        vm.runInContext(read(name), context, { filename: name });
    }

    // The real on-screen keyboard wiring, for the path that runs through it.
    if (helper) {
        vm.runInContext(read('keyboard-helper.js'), context, { filename: 'keyboard-helper.js' });
    }

    const { TextHistory, textedit } = vm.runInContext('({ TextHistory, textedit })', context);
    TextHistory.now = () => clock;

    if (helper) {
        vm.runInContext('onBodyLoad()', context);
    } else if (watch) {
        textedit.watchAll(ids);
    }

    const element = id => elements[id];

    return {
        textedit,
        TextHistory,
        document,
        element,
        /** Reads a global the scripts keep, e.g. keyboard-helper's cursor. */
        global: name => vm.runInContext(`typeof ${name} !== 'undefined' ? ${name} : undefined`, context),
        /** Moves the clock on, so the next edit falls outside the coalescing window. */
        pause: (ms = 1000) => { clock += ms; },
        tick: (ms = 1) => { clock += ms; },
        /** What the user typing does: the value changes, then `input` fires. */
        type(id, characters, { inputType = 'insertText' } = {}) {
            const ta = elements[id];
            for (const character of characters) {
                const at = ta.selectionEnd;
                ta.value = ta.value.slice(0, at) + character + ta.value.slice(at);
                ta.selectionStart = ta.selectionEnd = at + character.length;
                clock += 1;
                ta.dispatch('input', { isTrusted: true, inputType, data: character });
            }
            return ta;
        },
        /** A paste: one event carrying the lot, however long it is. */
        paste(id, characters) {
            const ta = elements[id];
            const at = ta.selectionEnd;
            ta.value = ta.value.slice(0, at) + characters + ta.value.slice(at);
            ta.selectionStart = ta.selectionEnd = at + characters.length;
            clock += 1;
            ta.dispatch('input', { isTrusted: true, inputType: 'insertFromPaste', data: null });
            return ta;
        },
        /** A backspace at the cursor. */
        backspace(id, times = 1) {
            const ta = elements[id];
            for (let i = 0; i < times; i++) {
                const at = ta.selectionEnd;
                if (at === 0) break;
                ta.value = ta.value.slice(0, at - 1) + ta.value.slice(at);
                ta.selectionStart = ta.selectionEnd = at - 1;
                clock += 1;
                ta.dispatch('input', { isTrusted: true, inputType: 'deleteContentBackward', data: null });
            }
            return ta;
        },
        /** What the on-screen keyboard does: a scripted event, never trusted. */
        scriptedInput(id, { inputType = 'appendText', data = '' } = {}) {
            elements[id].dispatch('input', { isTrusted: false, inputType, data });
        },
        /** A key press with modifiers; returns whether the page took it. */
        keydown(id, key, { ctrlKey = true, shiftKey = false, metaKey = false } = {}) {
            let prevented = false;
            elements[id].dispatch('keydown', {
                key, ctrlKey, shiftKey, metaKey,
                preventDefault: () => { prevented = true; }
            });
            return prevented;
        }
    };
}
