'use strict';

/**
 * The eight loops, as numbers.
 *
 * Nothing here touches the DOM or the synth - the same split `keys.js` uses.
 * A loop is a list of *steps*; a step is up to six notes sounding at once, or
 * none at all, which is a rest. That is exactly what the editor draws: six
 * rows, one column per step.
 *
 *     steps[0]  steps[1]  steps[2]  steps[3]
 *     [ C4 ]    [    ]    [ E4 ]    [ G4 ]     <- row 0
 *     [ E4 ]    [    ]    [    ]    [ B4 ]     <- row 1
 *     [ G4 ]    [    ]    [    ]    [    ]     <- row 2
 *     [    ]    [    ]    [    ]    [    ]     <- row 3
 *     [    ]    [    ]    [    ]    [    ]     <- row 4
 *     [    ]    [    ]    [    ]    [    ]     <- row 5
 *
 * A step is a fixed slice of time, so a rest is a real thing that takes up
 * room. That is why the editor has to be able to insert and delete an empty
 * one: it is how the rhythm is written.
 *
 * A slot holds one of three things: nothing, a note struck, or a *tie* - the
 * note before it going on ringing. A tie is written as the pitch made negative,
 * so a slot stays a number and every strip stays an array of them:
 *
 *     [ 60, -60, -60, null ]   C4 struck, held for three steps, then silence
 *     [ 60,  60,  60, null ]   C4 struck three times over
 *
 * Which is the whole point of having a tie at all: without one, those two are
 * the same strip, and a note held down comes back as a stutter.
 */
const loops = {};

loops.COUNT = 8;                 // eight loop channels - see loops.channel
/*
 * Six, rather than the four the grid started with. Four is what a hand plays
 * and what the editor draws comfortably; it is not what a file holds. A real
 * song's parts run to five and six notes in a step - `Clocks.mid` has 912 steps
 * wanting more than four and 16 wanting more than five - and a step with every
 * row taken drops the note rather than making room, so the part came back
 * missing chord tones. Six is where that file stops asking for more.
 */
loops.ROWS = 6;                  // up to six notes at once, per loop
loops.BAR = 8;                   // steps to a bar: four beats of two eighths
loops.DEFAULT_BPM = 120;
loops.MIN_BPM = 40;
loops.MAX_BPM = 240;
loops.GATE = 0.9;                // of a step: a note stops just before the next
loops.VELOCITY = 100;

/**
 * The MIDI channel a loop plays on. Channel 0 is the player's hands and is
 * never touched, so a loop starting can never cut off a note being held.
 *
 * This is what puts the ceiling at eight: channel 9 is the drum channel, which
 * `tinysynth` sets up in `reset` and which plays a kit rather than a pitch. A
 * ninth loop would land on it and come out as percussion.
 */
loops.channel = function (index) {
    return index + 1;
};

/** A step is an eighth note, so a beat is two of them. */
loops.stepSeconds = function (bpm) {
    const tempo = Math.min(loops.MAX_BPM, Math.max(loops.MIN_BPM,
        typeof bpm === 'number' && isFinite(bpm) ? bpm : loops.DEFAULT_BPM));
    return 30 / tempo;
};

/** The step a note played `elapsed` seconds in belongs to: the nearest one. */
loops.quantise = function (elapsed, bpm) {
    const step = Math.round(elapsed / loops.stepSeconds(bpm));
    return step > 0 ? step : 0;
};

/**
 * A slot's value as the note before it, still ringing. Pitch 0 cannot be tied -
 * negative zero is zero - but the board never goes near it: C0 is 12.
 */
loops.tie = function (midi) {
    return -midi;
};

/** Whether a slot is a note going on rather than a note struck. */
loops.isTie = function (value) {
    return typeof value === 'number' && value < 0;
};

/** The note in a slot, struck or tied; null stays null. */
loops.pitch = function (value) {
    return value === null || value === undefined ? null : Math.abs(value);
};

/** Whether a step holds this note at all, struck or carried on. */
loops.has = function (step, midi) {
    return (step || []).some(value => value !== null && loops.pitch(value) === midi);
};

/** Whether this note is struck anywhere in the strip. A tie needs one. */
loops.isStruck = function (steps, midi) {
    return (steps || []).some(step => (step || []).some(value =>
        value !== null && !loops.isTie(value) && loops.pitch(value) === midi));
};

/** An empty step: six rows, all silent. */
loops.emptyStep = function () {
    return new Array(loops.ROWS).fill(null);
};

/** Whether a step is a rest - nothing in any of its rows. */
loops.isRest = function (step) {
    return !step || step.every(note => note === null);
};

/** One loop: a strip of steps, all played on the one instrument. */
loops.create = function (program) {
    return {
        steps: [],
        program: typeof program === 'number' ? program : 0
    };
};

/** The eight of them, as the app starts with. */
loops.blank = function () {
    const made = [];
    for (let i = 0; i < loops.COUNT; i++) {
        made.push(loops.create(0));
    }
    return made;
};

/* -------------------------------------------------------------------- edits
 *
 * Every edit returns a new step array and leaves the one it was given alone.
 * That is what makes undo a matter of keeping the old array rather than
 * working out how to reverse the change.
 */

/** A copy, deep enough that the steps of the original are never written to. */
loops.copy = function (steps) {
    return (steps || []).map(step => (step || loops.emptyStep()).slice());
};

/** Grows the strip so that `index` exists, filling the gap with rests. */
loops.extend = function (steps, index) {
    const grown = loops.copy(steps);
    while (grown.length <= index) {
        grown.push(loops.emptyStep());
    }
    return grown;
};

/*
 * The rules for writing a note are here, working on a strip in place, and the
 * edits above are those rules with a copy taken first. Two callers need them
 * without the copy: reading a file is thousands of notes into a strip thousands
 * of steps long, and copying the whole strip once per note made loading a song
 * quadratic - seconds of a frozen page for a five minute file.
 */

/*
 * These four are private to this file, but every script on the page shares one
 * global scope - `bandage.js` has a `hold` of its own, for a key being held -
 * so their names say which of the two they belong to.
 */

/** Grows a strip in place so that `index` exists, filling the gap with rests. */
function stripGrow(strip, index) {
    while (strip.length <= index) {
        strip.push(loops.emptyStep());
    }
    return strip;
}

/** `setNote`, in place. */
function stripPut(strip, index, row, midi) {
    if (index < 0) {
        return strip;
    }
    stripGrow(strip, index);
    const step = strip[index];

    if (midi === null) {
        if (row !== null && row >= 0 && row < loops.ROWS) {
            step[row] = null;
        }
        return strip;
    }
    if (loops.has(step, midi)) {
        return strip;                       // already sounding in this step
    }

    const at = row === null || row === undefined ? step.indexOf(null) : row;
    if (at < 0 || at >= loops.ROWS) {
        return strip;                       // every row is taken
    }
    step[at] = midi;
    return strip;
}

/**
 * A row that is free in every step from `first` to `last`, or null if no one
 * row is. See `stripHold` for why a run wants the same row all the way along.
 */
function stripRoom(strip, first, last) {
    for (let row = 0; row < loops.ROWS; row++) {
        let free = true;
        for (let at = first; at <= last && free; at++) {
            free = strip[at][row] === null;
        }
        if (free) {
            return row;
        }
    }
    return null;
}

/**
 * `holdNote`, in place.
 *
 * The row is chosen once, for the whole run, rather than left to `stripPut` to
 * find a step at a time. Rows are slots and not voices, so either way the same
 * notes sound - but a run written a step at a time takes whatever row happens
 * to be free in each, and a note held over several steps ends up scattered
 * across the grid. The editor draws a tie as a bare dash, so a tie that has
 * wandered out of its own row reads as a note whose head has gone missing.
 *
 * When no single row is free the whole way, it falls back to a step at a time:
 * a scattered run is still better than a note that was never written down.
 *
 * A step with every row already taken cannot hold the strike, so the run
 * starts on the first step that can take it. Otherwise the note would come back
 * as a tie carrying on from a strike that was never written - which `runs`
 * sounds anyway, but which the grid draws as a dash with nothing above it.
 */
function stripHold(strip, from, to, midi) {
    const first = Math.max(0, from);
    const last = Math.max(first, to);
    stripGrow(strip, last);
    const row = stripRoom(strip, first, last);
    stripPut(strip, first, row, midi);

    let struck = loops.has(strip[first], midi);
    for (let at = first + 1; at <= last; at++) {
        stripPut(strip, at, row, struck ? loops.tie(midi) : midi);
        struck = struck || loops.has(strip[at], midi);
    }
    return strip;
}

/**
 * Puts a note in a step. `row` of null finds the first free row, which is what
 * a chord wants: play three keys, they fill rows 0, 1 and 2. A step already
 * holding `ROWS` notes takes no more.
 */
loops.setNote = function (steps, index, row, midi) {
    return stripPut(loops.copy(steps), index, row, midi);
};

/**
 * A note held down across a run of steps: struck on the first, tied across the
 * rest. `from` and `to` are both inclusive; a press and release inside one step
 * is one step and no tie at all.
 */
loops.holdNote = function (steps, from, to, midi) {
    return stripHold(loops.copy(steps), from, to, midi);
};

/**
 * A strip being built up note by note, for whoever is reading a file rather
 * than editing. Same rules, no copy per note. `steps` hands over the strip
 * itself, so the writer is finished with once it has been asked for.
 */
loops.writer = function () {
    const strip = [];
    return {
        hold: function (from, to, midi) {
            stripHold(strip, from, to, midi);
            return this;
        },
        steps: function () {
            return strip;
        }
    };
};

/**
 * The notes of a strip as runs: each a pitch, the step it is struck on, and the
 * number of steps it rings for. This is the one place that knows what a tie
 * means, and both the player and the file writer read it.
 *
 *     [ 60, -60, -60, 64 ]  ->  {60, at 0, 3 steps}, {64, at 3, 1 step}
 *
 * `wrapped` lets a run carry on past the end of the strip into the start of it,
 * which is what a loop does. The file writer leaves it off: a file has an end.
 *
 * A tie with nothing to carry on - the step it belonged to was deleted, say -
 * is struck instead of being dropped, so an edit can never silence a note
 * without showing that it has. Read straight, the first step is always the head
 * of whatever it holds; it is only when runs may wrap that a ring of ties with
 * no strike anywhere in it could otherwise carry on forever and never sound.
 */
loops.runs = function (steps, wrapped) {
    const strip = steps || [];
    const length = strip.length;
    if (length === 0) {
        return [];
    }
    const stepAt = i => strip[((i % length) + length) % length];
    const tiesOn = (i, midi) => stepAt(i).some(value =>
        loops.isTie(value) && loops.pitch(value) === midi);

    const found = [];
    strip.forEach((step, index) => {
        (step || []).forEach((value) => {
            if (value === null) {
                return;
            }
            const midi = loops.pitch(value);
            const carriedOn = loops.isTie(value)
                && loops.has(stepAt(index - 1), midi)
                && (index > 0 || (wrapped && loops.isStruck(strip, midi)));
            if (carriedOn) {
                return;                     // it belongs to the run before it
            }
            let span = 1;
            while (span < length
                    && (wrapped || (index + span) < length)
                    && tiesOn(index + span, midi)) {
                span++;
            }
            found.push({ midi: midi, at: index, length: span });
        });
    });
    return found.sort((a, b) => (a.at - b.at) || (a.midi - b.midi));
};

/** Empties one cell, which is how a note is taken back out of the grid. */
loops.clearCell = function (steps, index, row) {
    return loops.setNote(steps, index, row, null);
};

/**
 * Opens a rest at `index`, pushing everything from there on to the right. Past
 * the end of the strip it simply makes it that much longer - one step longer,
 * not one step past wherever the cursor had wandered to.
 */
loops.insertStep = function (steps, index) {
    const copied = loops.copy(steps);
    const at = Math.max(0, index);
    while (copied.length < at) {
        copied.push(loops.emptyStep());
    }
    copied.splice(at, 0, loops.emptyStep());
    return copied;
};

/** Takes the step at `index` out, closing the gap behind it. */
loops.deleteStep = function (steps, index) {
    const copied = loops.copy(steps);
    if (index >= 0 && index < copied.length) {
        copied.splice(index, 1);
    }
    return copied;
};

/**
 * Sorts the notes within each step low to high, rests to the bottom.
 *
 * Rows are slots, not voices, so this changes nothing about what is heard. It
 * is what stops a recording from looking ragged: notes are written into a step
 * as the keys are let go, and a chord released out of order would otherwise
 * leave the same two notes swapped between one column and the next.
 */
loops.tidy = function (steps) {
    return loops.copy(steps).map((step) => {
        const notes = step.filter(note => note !== null)
            .sort((a, b) => loops.pitch(a) - loops.pitch(b));
        while (notes.length < loops.ROWS) {
            notes.push(null);
        }
        return notes;
    });
};

/**
 * Rounds a strip up to a whole bar, so loops of different lengths still come
 * round together instead of drifting apart.
 */
loops.padToBar = function (steps) {
    const copied = loops.copy(steps);
    if (copied.length === 0) {
        return copied;
    }
    const bars = Math.ceil(copied.length / loops.BAR);
    while (copied.length < bars * loops.BAR) {
        copied.push(loops.emptyStep());
    }
    return copied;
};

/**
 * Turns a strip so that the step recorded at `by` becomes step 0.
 *
 * A loop punched in halfway through a bar was played against what the other
 * loops were doing at that moment, and has to play back against the same thing.
 * Rather than carry an offset around for every loop to remember, the strip is
 * turned once when the recording ends and everything after that is indexed off
 * the one clock from zero.
 */
loops.rotate = function (steps, by) {
    const copied = loops.copy(steps);
    if (copied.length === 0) {
        return copied;
    }
    const turn = ((by % copied.length) + copied.length) % copied.length;
    const turned = [];
    for (let i = 0; i < copied.length; i++) {
        turned.push(copied[(((i - turn) % copied.length) + copied.length) % copied.length]);
    }
    return turned;
};

/** Trims the rests off the end, so a strip is not longer than it sounds. */
loops.trim = function (steps) {
    const copied = loops.copy(steps);
    while (copied.length > 0 && loops.isRest(copied[copied.length - 1])) {
        copied.pop();
    }
    return copied;
};

/**
 * What loop `loop` sounds on the `tick`th step of the clock. Every loop reads
 * off one counter, wrapping at its own length: that is what keeps four of them
 * in step with one number instead of four transports.
 */
loops.stepAt = function (loop, tick) {
    const steps = loop && loop.steps;
    if (!steps || steps.length === 0) {
        return null;
    }
    const at = ((tick % steps.length) + steps.length) % steps.length;
    return steps[at];
};

/** The notes sounding at that point, low to high - handy for a readout. */
loops.notesAt = function (loop, tick) {
    const step = loops.stepAt(loop, tick);
    return step
        ? step.filter(note => note !== null).map(loops.pitch).sort((a, b) => a - b)
        : [];
};

/**
 * Ties the cursor step to the one before it: everything ringing there goes on
 * ringing here. This is the editor's way of making a note longer.
 */
loops.tieStep = function (steps, index) {
    if (index <= 0) {
        return loops.copy(steps);
    }
    const grown = loops.extend(steps, index);
    const before = grown[index - 1];
    grown[index] = loops.emptyStep();
    before.filter(value => value !== null)
        .forEach((value, row) => { grown[index][row] = loops.tie(loops.pitch(value)); });
    return grown;
};

/* ------------------------------------------------------------------ history
 *
 * The same shape as `src/fs/js/history.js`, which does this for a textarea:
 * the list holds the *current* state at `index`, so undo steps back one entry.
 * It is written again here rather than imported because that file is about
 * text and selections, and lives outside the folder `sw.js` caches - a PWA
 * that reaches out of its own directory is a PWA that breaks offline.
 */

loops.HISTORY_LIMIT = 50;

loops.history = function (initial) {
    const entries = [loops.copy(initial)];
    let index = 0;
    const api = {};

    /** Takes the strip as it is now. A change that changed nothing is ignored. */
    api.record = function (steps) {
        const entry = loops.copy(steps);
        if (loops.same(entries[index], entry)) {
            return api;
        }
        entries.length = index + 1;          // anything redone away is gone
        entries.push(entry);
        index = entries.length - 1;
        if (entries.length > loops.HISTORY_LIMIT) {
            entries.shift();
            index = index - 1;
        }
        return api;
    };

    /** The previous strip, or null when there is nothing left to take back. */
    api.undo = function () {
        if (index === 0) {
            return null;
        }
        index = index - 1;
        return loops.copy(entries[index]);
    };

    api.redo = function () {
        if (index >= entries.length - 1) {
            return null;
        }
        index = index + 1;
        return loops.copy(entries[index]);
    };

    api.current = function () { return loops.copy(entries[index]); };
    api.canUndo = function () { return index > 0; };
    api.canRedo = function () { return index < entries.length - 1; };
    api.size = function () { return entries.length; };
    api.position = function () { return index; };

    return api;
};

/** Whether two strips hold the same notes in the same places. */
loops.same = function (left, right) {
    const a = left || [];
    const b = right || [];
    if (a.length !== b.length) {
        return false;
    }
    return a.every((step, i) => step.every((note, row) => note === b[i][row]));
};

if (typeof module === 'object' && module.exports) {
    module.exports = loops;
}
