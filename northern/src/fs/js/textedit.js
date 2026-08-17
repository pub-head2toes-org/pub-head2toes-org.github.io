'use strict';

/**
 * The one way text is written into a textarea on this page.
 *
 * Assigning `textarea.value` wipes the browser's own undo stack, and this page
 * assigns it for every on-screen key, every `get`, every `search`. So the stack
 * is ours instead: `setText` is the choke point that records what changed, and
 * `undo`/`redo` put it back. Nothing else should touch `.value` - the one
 * exception is `apply` below, which is replaying a state the history holds.
 *
 * Undo/redo is on Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y, and on the two on-screen
 * keys - this page is meant to be usable on a phone, which has no Ctrl.
 *
 * Depends on history.js.
 */
const textedit = (function () {

    const histories = {};
    const watched = [];
    let lastFocused = null;

    function stateOf (ta) {
        return {
            value: ta.value,
            selectionStart: ta.selectionStart,
            selectionEnd: ta.selectionEnd
        };
    }

    /**
     * The history for a buffer, made on demand and seeded with whatever the
     * buffer already holds: `Keyboard.init` writes the boot command before the
     * page is watched, and that write has to stay undoable.
     */
    function historyFor (ta) {
        const id = ta.id || 'anonymous';
        if (!histories[id]) {
            histories[id] = TextHistory.create(stateOf(ta));
        }
        return histories[id];
    }

    /** What kind of step a typed edit is, and whether it joins the one before. */
    function edit (e) {
        const type = e.inputType || '';
        if (type === 'insertFromPaste' || type === 'insertFromDrop') {
            return { label: 'paste', coalesce: false };
        }
        if (type.indexOf('delete') === 0) {
            return { label: 'delete', coalesce: true };
        }
        if (type === 'insertLineBreak' || type === 'insertParagraph') {
            return { label: 'type', coalesce: false };
        }
        if (e.data && /\s/.test(e.data)) {
            return { label: 'type', coalesce: false };   // a word is a natural step
        }
        return { label: 'type', coalesce: true };
    }

    function apply (ta, snapshot) {
        ta.value = snapshot.value;
        ta.selectionStart = snapshot.selectionStart;
        ta.selectionEnd = snapshot.selectionEnd;
        ta.focus();
        // keyboard-helper.js tracks the cursor in a global of its own; leave it
        // pointing into the buffer that is there now, not the one that was.
        if (typeof initFocus === 'function') {
            initFocus(ta);
        }
        return snapshot;
    }

    const api = {};

    /**
     * Writes a buffer and records the result. `caret` places the cursor before
     * the state is taken, so undo brings the cursor back with the text.
     */
    api.setText = function (ta, value, options) {
        const opts = options || {};
        // Ask for the history first: an unwatched buffer is seeded here, and it
        // has to be seeded with the state this write is about to replace.
        const history = historyFor(ta);

        ta.value = value;
        if (typeof opts.caret === 'number') {
            ta.selectionStart = opts.caret;
            ta.selectionEnd = opts.caret;
        }
        history.record(stateOf(ta), opts.label || 'edit', false);
        return ta;
    };

    api.watch = function (ta) {
        if (!ta || watched.indexOf(ta) !== -1) {
            return ta;
        }
        watched.push(ta);
        historyFor(ta);
        if (!lastFocused) {
            lastFocused = ta;
        }

        ta.addEventListener('focus', function () {
            lastFocused = ta;
        });

        // Only what the user typed: the on-screen keyboard dispatches scripted
        // events, and the code behind those writes through setText already.
        ta.addEventListener('input', function (e) {
            if (!e.isTrusted) {
                return;
            }
            const kind = edit(e);
            historyFor(ta).record(stateOf(ta), kind.label, kind.coalesce);
        });

        ta.addEventListener('keydown', function (e) {
            if (!e.ctrlKey && !e.metaKey) {
                return;
            }
            const key = (e.key || '').toLowerCase();
            if (key === 'z') {
                e.preventDefault();          // or the dead native stack fires too
                if (e.shiftKey) {
                    api.redo(ta);
                } else {
                    api.undo(ta);
                }
            } else if (key === 'y') {
                e.preventDefault();
                api.redo(ta);
            }
        });

        return ta;
    };

    api.watchAll = function (ids) {
        ids.forEach(function (id) {
            const ta = document.getElementById(id);
            if (ta) {
                api.watch(ta);
            }
        });
        return api;
    };

    /**
     * The buffer the on-screen keys act on. Pressing a key moves focus to the
     * button, so the last watched buffer to hold focus is the honest answer.
     */
    api.active = function () {
        const el = document.activeElement;
        if (el && watched.indexOf(el) !== -1) {
            return el;
        }
        return lastFocused;
    };

    api.undo = function (ta) {
        const target = ta || api.active();
        if (!target) {
            return null;
        }
        const snapshot = historyFor(target).undo();
        return snapshot ? apply(target, snapshot) : null;
    };

    api.redo = function (ta) {
        const target = ta || api.active();
        if (!target) {
            return null;
        }
        const snapshot = historyFor(target).redo();
        return snapshot ? apply(target, snapshot) : null;
    };

    /** The history behind a buffer, for a status line or a test. */
    api.historyOf = historyFor;

    return api;
})();
