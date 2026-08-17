'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { loadTextedit } from './helpers/keyboardPage.js';

const JS_DIR = path.join(import.meta.dirname, '..', 'src', 'fs', 'js');
const sources = ['cli_v2.js', 'keyboard.js', 'keyboard-helper.js']
    .map(name => ({ name, text: fs.readFileSync(path.join(JS_DIR, name), 'utf8') }));

describe('textedit.setText', () => {
    it('writes the buffer and records what it wrote', () => {
        const page = loadTextedit();
        const text2 = page.element('text2');

        page.textedit.setText(text2, 'a record', { label: 'get' });

        assert.strictEqual(text2.value, 'a record');
        assert.strictEqual(page.textedit.historyOf(text2).canUndo(), true);
    });

    it('places the cursor before it takes the state, so undo brings it back', () => {
        const page = loadTextedit();
        const text = page.element('text');
        page.textedit.setText(text, 'hello', { caret: 5 });
        page.pause();

        page.textedit.setText(text, 'hello there', { caret: 11 });
        page.textedit.undo(text);

        assert.strictEqual(text.value, 'hello');
        assert.strictEqual(text.selectionStart, 5);
        assert.strictEqual(text.selectionEnd, 5);
    });

    // Keyboard.init writes the boot command before onBodyLoad watches anything
    it('records a write to a buffer nobody watched yet', () => {
        const page = loadTextedit({ watch: false });
        const clip = page.element('clip');
        clip.value = '';

        page.textedit.setText(clip, 'get /a/b', { label: 'boot' });
        page.textedit.undo(clip);

        assert.strictEqual(clip.value, '');
    });

    // The bug this whole thing exists for
    it('makes a fetch that replaces the whole buffer undoable', () => {
        const page = loadTextedit();
        const text2 = page.element('text2');
        page.textedit.setText(text2, 'edits I have not saved', { label: 'type' });
        page.pause();

        page.textedit.setText(text2, '{"the": "record get fetched"}', { label: 'get' });
        assert.strictEqual(text2.value, '{"the": "record get fetched"}');

        page.textedit.undo(text2);
        assert.strictEqual(text2.value, 'edits I have not saved');
    });
});

describe('textedit undo and redo', () => {
    it('takes back typing a word at a time', () => {
        const page = loadTextedit();
        page.type('text', 'hello');
        page.pause();
        page.type('text', ' world');

        page.textedit.undo(page.element('text'));

        assert.strictEqual(page.element('text').value, 'hello');
    });

    it('puts it back again', () => {
        const page = loadTextedit();
        page.type('text', 'hello');
        page.pause();
        page.type('text', '!');

        const text = page.element('text');
        page.textedit.undo(text);
        page.textedit.redo(text);

        assert.strictEqual(text.value, 'hello!');
    });

    it('takes back a run of backspaces in one step', () => {
        const page = loadTextedit();
        page.type('text', 'hello');
        page.pause();
        page.backspace('text', 3);

        assert.strictEqual(page.element('text').value, 'he');
        page.textedit.undo(page.element('text'));
        assert.strictEqual(page.element('text').value, 'hello');
    });

    it('keeps a history per buffer', () => {
        const page = loadTextedit();
        page.type('clip', 'search');
        page.type('text', 'anote');

        page.textedit.undo(page.element('clip'));

        assert.strictEqual(page.element('clip').value, '');
        assert.strictEqual(page.element('text').value, 'anote', 'the other buffer is untouched');
    });

    // A space is a natural place to stop, the way an editor breaks a typing run
    it('steps back a word at a time through a typed command', () => {
        const page = loadTextedit();
        page.type('clip', 'put /a/b');

        const clip = page.element('clip');
        page.textedit.undo(clip);
        assert.strictEqual(clip.value, 'put', 'the path goes, the command stays');
        page.textedit.undo(clip);
        assert.strictEqual(clip.value, '');
    });

    it('leaves the cursor where the text it restored ended', () => {
        const page = loadTextedit();
        page.type('text', 'abc');
        page.pause();
        page.type('text', 'def');

        page.textedit.undo(page.element('text'));

        assert.strictEqual(page.element('text').value, 'abc');
        assert.strictEqual(page.element('text').selectionEnd, 3);
    });

    it('does nothing at the start of the history', () => {
        const page = loadTextedit();

        assert.strictEqual(page.textedit.undo(page.element('text')), null);
        assert.strictEqual(page.element('text').value, '');
    });
});

describe('textedit key bindings', () => {
    it('undoes on Ctrl+Z, and takes the key so the dead native stack cannot fire', () => {
        const page = loadTextedit();
        page.type('text', 'hello');

        const prevented = page.keydown('text', 'z');

        assert.strictEqual(prevented, true);
        assert.strictEqual(page.element('text').value, '');
    });

    it('redoes on Ctrl+Shift+Z and on Ctrl+Y', () => {
        const page = loadTextedit();
        page.type('text', 'hello');

        page.keydown('text', 'z');
        page.keydown('text', 'z', { shiftKey: true });
        assert.strictEqual(page.element('text').value, 'hello');

        page.keydown('text', 'z');
        page.keydown('text', 'y');
        assert.strictEqual(page.element('text').value, 'hello');
    });

    it('answers to Cmd+Z as well, for a Mac', () => {
        const page = loadTextedit();
        page.type('text', 'hello');

        page.keydown('text', 'z', { ctrlKey: false, metaKey: true });

        assert.strictEqual(page.element('text').value, '');
    });

    it('leaves a plain z alone', () => {
        const page = loadTextedit();
        page.type('text', 'hello');

        const prevented = page.keydown('text', 'z', { ctrlKey: false });

        assert.strictEqual(prevented, false);
        assert.strictEqual(page.element('text').value, 'hello');
    });
});

describe('textedit on-screen keys', () => {
    // Pressing a key moves focus to the button, so the buffer has to be remembered
    it('act on the buffer that last had focus, not on the button', () => {
        const page = loadTextedit();
        page.element('text2').focus();
        page.textedit.setText(page.element('text2'), 'a record', { label: 'get' });
        page.document.activeElement = { id: 'a-keyboard-button' };

        page.textedit.undo();

        assert.strictEqual(page.element('text2').value, '');
    });

    it('follow the focus from one buffer to another', () => {
        const page = loadTextedit();
        page.element('text').focus();
        page.textedit.setText(page.element('text'), 'in text', { label: 'key' });
        page.element('clip').focus();
        page.textedit.setText(page.element('clip'), 'in clip', { label: 'key' });

        page.textedit.undo();

        assert.strictEqual(page.element('clip').value, '');
        assert.strictEqual(page.element('text').value, 'in text');
    });
});

describe('textedit and the on-screen keyboard events', () => {
    // Those events are scripted, and the code behind them writes through setText
    it('does not record a scripted input event, which would double up', () => {
        const page = loadTextedit();
        const text = page.element('text');
        page.textedit.setText(text, 'ab', { label: 'key', caret: 2 });

        page.scriptedInput('text', { inputType: 'appendText', data: 'b' });

        assert.strictEqual(page.textedit.historyOf(text).size(), 2, 'the seed and the one write');
    });

    it('records a paste as a step of its own', () => {
        const page = loadTextedit();
        page.type('text', 'note:');
        page.paste('text', ' a whole pasted paragraph');

        page.textedit.undo(page.element('text'));

        assert.strictEqual(page.element('text').value, 'note:');
    });
});

// Step 1: the choke point. Anything that writes .value directly wipes the
// browser's undo stack, which is what broke undo on this page to begin with.
describe('the keyboard page writes text only through textedit', () => {
    for (const source of sources) {
        it(`${source.name} assigns no textarea value of its own`, () => {
            const offenders = source.text.split('\n')
                .map((line, number) => ({ line: line.trim(), number: number + 1 }))
                .filter(entry => /\.value\s*=[^=]/.test(entry.line))
                .filter(entry => !/this\.properties\.value/.test(entry.line));

            assert.deepStrictEqual(offenders, [],
                `these lines write a buffer directly: ${offenders.map(o => o.number).join(', ')}`);
        });
    }

    it('the page loads history.js and textedit.js before them', () => {
        const html = fs.readFileSync(
            path.join(JS_DIR, '..', 'keyboard.html'), 'utf8');

        const order = ['js/history.js', 'js/textedit.js', 'js/cli_v2.js', 'js/keyboard.js', 'js/keyboard-helper.js']
            .map(src => html.indexOf(src));

        assert.ok(order.every(at => at !== -1), 'every script is on the page');
        assert.deepStrictEqual(order, [...order].sort((a, b) => a - b));
    });

    it('watches all three buffers when the page loads', () => {
        const helper = sources.find(s => s.name === 'keyboard-helper.js').text;

        assert.match(helper, /textedit\.watchAll\(\["clip", "text", "text2"\]\)/);
    });

    it('offers undo and redo on the on-screen keyboard, for a device with no Ctrl', () => {
        const keyboard = sources.find(s => s.name === 'keyboard.js').text;

        assert.match(keyboard, /"tab","undo","redo"/);
        assert.match(keyboard, /case "undo":[\s\S]*textedit\.undo\(\)/);
        assert.match(keyboard, /case "redo":[\s\S]*textedit\.redo\(\)/);
    });
});

// The path that actually runs on the page: a key press is a scripted event,
// keyboard-helper writes the buffer, and textedit has to have caught it.
describe('the on-screen keyboard, end to end', () => {
    const keyboardPage = () => loadTextedit({ helper: true });

    it('types into the buffer and leaves it undoable', () => {
        const page = keyboardPage();

        page.scriptedInput('text', { inputType: 'appendText', data: 'a' });
        page.scriptedInput('text', { inputType: 'appendText', data: 'b' });

        assert.strictEqual(page.element('text').value, 'ab');
        page.textedit.undo(page.element('text'));
        assert.strictEqual(page.element('text').value, 'a');
        page.textedit.undo(page.element('text'));
        assert.strictEqual(page.element('text').value, '');
    });

    it('inserts at the cursor, and undo puts the cursor back with the text', () => {
        const page = keyboardPage();
        const text = page.element('text');
        page.textedit.setText(text, 'ac', { label: 'get', caret: 1 });
        page.pause();

        page.scriptedInput('text', { inputType: 'appendText', data: 'b' });

        assert.strictEqual(text.value, 'abc');
        assert.strictEqual(text.selectionEnd, 2);
        page.textedit.undo(text);
        assert.strictEqual(text.value, 'ac');
        assert.strictEqual(text.selectionEnd, 1);
    });

    it('keeps the helper cursor in step after an undo, so the next key lands right', () => {
        const page = keyboardPage();
        const text = page.element('text');
        page.scriptedInput('text', { inputType: 'appendText', data: 'hello' });
        page.pause();
        page.scriptedInput('text', { inputType: 'appendText', data: '!' });

        page.textedit.undo(text);

        assert.strictEqual(text.value, 'hello');
        assert.strictEqual(page.global('pos'), 5, 'not the 6 it was before the undo');
    });

    it('makes the block key undoable in the buffer it writes to', () => {
        const page = keyboardPage();
        const text = page.element('text');
        page.textedit.setText(text, 'one two three', { label: 'get' });
        text.selectionStart = 4;
        text.selectionEnd = 7;
        page.textedit.setText(page.element('text2'), 'was here', { label: 'get' });
        page.pause();

        page.scriptedInput('text', { inputType: 'block' });

        assert.strictEqual(page.element('text2').value, 'two');
        page.textedit.undo(page.element('text2'));
        assert.strictEqual(page.element('text2').value, 'was here');
    });
});
