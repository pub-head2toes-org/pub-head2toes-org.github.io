'use strict';

/**
 * Undo/redo history for one text buffer.
 *
 * Nothing here touches the DOM: a state is a plain
 * `{value, selectionStart, selectionEnd}`, which is all a textarea is worth
 * remembering. `textedit.js` is what puts it on a page.
 *
 * The list always holds the *current* state at `index`, so a change is
 * recorded after it happens and undo simply steps back one entry:
 *
 *     record("a")  record("ab")   undo      redo
 *     [ "", "a" ]  [ "", "ab" ]   index--   index++
 *                    ^ merged
 *
 * Typing a run of characters would otherwise leave one entry per keystroke, so
 * a record that carries the same label as the last one, within `coalesceMs` of
 * it, replaces that entry instead of following it. Distinct labels never merge:
 * a run of deletes is its own step, and so is every programmatic write.
 */
const TextHistory = {};

TextHistory.LIMIT = 50;
TextHistory.COALESCE_MS = 500;

/** The clock, as a hook, so tests can run a typing pause without waiting. */
TextHistory.now = function () {
    return Date.now();
};

TextHistory.snapshot = function (state, label) {
    const value = state && state.value != null ? String(state.value) : '';
    const start = state && typeof state.selectionStart === 'number' ? state.selectionStart : value.length;
    const end = state && typeof state.selectionEnd === 'number' ? state.selectionEnd : start;
    return {
        value: value,
        selectionStart: start,
        selectionEnd: end,
        label: label || 'edit',
        at: TextHistory.now()
    };
};

TextHistory.create = function (initial, options) {
    const opts = options || {};
    const limit = opts.limit || TextHistory.LIMIT;
    const coalesceMs = typeof opts.coalesceMs === 'number' ? opts.coalesceMs : TextHistory.COALESCE_MS;

    const entries = [TextHistory.snapshot(initial, 'initial')];
    let index = 0;

    const api = {};

    /**
     * Takes the state a buffer is in now. `coalesce` asks for it to be folded
     * into the entry before it when that entry is a recent one of the same
     * kind - one undo should take back a typed word, not a letter.
     */
    api.record = function (state, label, coalesce) {
        const entry = TextHistory.snapshot(state, label);
        const last = entries[index];

        if (last && last.value === entry.value) {
            return api;                      // a write that changed nothing
        }

        const atTip = index === entries.length - 1;
        if (coalesce && atTip && last && last.label === entry.label
                && (entry.at - last.at) <= coalesceMs) {
            entries[index] = entry;
            return api;
        }

        entries.length = index + 1;          // anything redone away is gone
        entries.push(entry);
        index = entries.length - 1;

        if (entries.length > limit) {
            entries.shift();
            index = index - 1;
        }
        return api;
    };

    /** The previous state, or null when there is nothing left to take back. */
    api.undo = function () {
        if (index === 0) {
            return null;
        }
        index = index - 1;
        return entries[index];
    };

    api.redo = function () {
        if (index >= entries.length - 1) {
            return null;
        }
        index = index + 1;
        return entries[index];
    };

    api.current = function () {
        return entries[index];
    };

    api.canUndo = function () {
        return index > 0;
    };

    api.canRedo = function () {
        return index < entries.length - 1;
    };

    /** How many steps are held, for a status line or a test. */
    api.size = function () {
        return entries.length;
    };

    api.position = function () {
        return index;
    };

    return api;
};
