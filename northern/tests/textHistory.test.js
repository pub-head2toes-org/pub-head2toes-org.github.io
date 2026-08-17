'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const source = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'src', 'fs', 'js', 'history.js'), 'utf8');

/** history.js touches no DOM, so it runs in a bare context. */
function load() {
    const context = vm.createContext({});
    vm.runInContext(source, context, { filename: 'history.js' });
    const TextHistory = vm.runInContext('TextHistory', context);

    let clock = 1000;
    TextHistory.now = () => clock;

    return {
        TextHistory,
        pause: (ms = 1000) => { clock += ms; },
        tick: (ms = 1) => { clock += ms; }
    };
}

const state = (value, caret) => ({
    value,
    selectionStart: caret === undefined ? value.length : caret,
    selectionEnd: caret === undefined ? value.length : caret
});

describe('TextHistory', () => {
    it('starts on the state it was given, with nothing to undo', () => {
        const { TextHistory } = load();
        const history = TextHistory.create(state('hello'));

        assert.strictEqual(history.current().value, 'hello');
        assert.strictEqual(history.canUndo(), false);
        assert.strictEqual(history.canRedo(), false);
        assert.strictEqual(history.undo(), null);
    });

    it('steps back and forward through recorded states', () => {
        const { TextHistory, pause } = load();
        const history = TextHistory.create(state(''));

        history.record(state('one'), 'get');
        pause();
        history.record(state('two'), 'get');

        assert.strictEqual(history.undo().value, 'one');
        assert.strictEqual(history.undo().value, '');
        assert.strictEqual(history.undo(), null, 'and stops at the beginning');
        assert.strictEqual(history.redo().value, 'one');
        assert.strictEqual(history.redo().value, 'two');
        assert.strictEqual(history.redo(), null, 'and stops at the end');
    });

    it('carries the cursor with the text', () => {
        const { TextHistory } = load();
        const history = TextHistory.create(state('abc', 3));

        history.record(state('abcdef', 6), 'type');

        const back = history.undo();
        assert.strictEqual(back.value, 'abc');
        assert.strictEqual(back.selectionStart, 3);
        assert.strictEqual(back.selectionEnd, 3);
    });

    // One Ctrl+Z should take back a word, not a letter
    it('folds a run of typing into one step', () => {
        const { TextHistory, tick } = load();
        const history = TextHistory.create(state(''));

        for (const value of ['h', 'he', 'hel', 'hell', 'hello']) {
            tick(10);
            history.record(state(value), 'type', true);
        }

        assert.strictEqual(history.size(), 2, 'the empty start and the word');
        assert.strictEqual(history.undo().value, '');
    });

    it('breaks the run once typing stops for a while', () => {
        const { TextHistory, tick, pause } = load();
        const history = TextHistory.create(state(''));

        tick(10);
        history.record(state('hello'), 'type', true);
        pause(600);
        history.record(state('hello world'), 'type', true);

        assert.strictEqual(history.undo().value, 'hello');
        assert.strictEqual(history.undo().value, '');
    });

    it('keeps a run of deletes apart from a run of typing', () => {
        const { TextHistory, tick } = load();
        const history = TextHistory.create(state(''));

        tick(10);
        history.record(state('hello'), 'type', true);
        tick(10);
        history.record(state('hell'), 'delete', true);
        tick(10);
        history.record(state('hel'), 'delete', true);

        assert.strictEqual(history.undo().value, 'hello', 'both deletes come back at once');
        assert.strictEqual(history.undo().value, '');
    });

    it('never folds a programmatic write into the typing before it', () => {
        const { TextHistory, tick } = load();
        const history = TextHistory.create(state(''));

        tick(10);
        history.record(state('put /a/b'), 'type', true);
        tick(10);
        history.record(state('put /a/b/1739'), 'ts', false);

        assert.strictEqual(history.undo().value, 'put /a/b');
    });

    it('drops the redo tail once a new change is made', () => {
        const { TextHistory, pause } = load();
        const history = TextHistory.create(state(''));

        history.record(state('one'), 'get');
        pause();
        history.record(state('two'), 'get');
        history.undo();
        pause();

        history.record(state('three'), 'get');

        assert.strictEqual(history.canRedo(), false);
        assert.strictEqual(history.undo().value, 'one');
    });

    it('ignores a write that changed nothing', () => {
        const { TextHistory, pause } = load();
        const history = TextHistory.create(state('same'));

        pause();
        history.record(state('same'), 'get');

        assert.strictEqual(history.size(), 1);
        assert.strictEqual(history.canUndo(), false);
    });

    // These buffers hold whole database records; the list cannot grow forever
    it('forgets the oldest steps once it is full', () => {
        const { TextHistory, pause } = load();
        const history = TextHistory.create(state('0'), { limit: 3 });

        for (const value of ['1', '2', '3', '4']) {
            pause();
            history.record(state(value), 'get');
        }

        assert.strictEqual(history.size(), 3);
        assert.strictEqual(history.current().value, '4');
        assert.strictEqual(history.undo().value, '3');
        assert.strictEqual(history.undo().value, '2');
        assert.strictEqual(history.undo(), null, 'the older ones are gone');
    });

    it('keeps its own limit and window per buffer', () => {
        const { TextHistory, tick } = load();
        const history = TextHistory.create(state(''), { coalesceMs: 0 });

        tick(1);
        history.record(state('a'), 'type', true);
        tick(1);
        history.record(state('ab'), 'type', true);

        assert.strictEqual(history.size(), 3, 'nothing folds when the window is zero');
    });
});
