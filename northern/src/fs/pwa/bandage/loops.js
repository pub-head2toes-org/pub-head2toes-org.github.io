'use strict';

/**
 * The four loops, as numbers.
 *
 * Nothing here touches the DOM or the synth - the same split `keys.js` uses.
 * A loop is a list of *steps*; a step is up to four notes sounding at once, or
 * none at all, which is a rest. That is exactly what the editor draws: four
 * rows, one column per step.
 *
 *     steps[0]  steps[1]  steps[2]  steps[3]
 *     [ C4 ]    [    ]    [ E4 ]    [ G4 ]     <- row 0
 *     [ E4 ]    [    ]    [    ]    [ B4 ]     <- row 1
 *     [ G4 ]    [    ]    [    ]    [    ]     <- row 2
 *     [    ]    [    ]    [    ]    [    ]     <- row 3
 *
 * A step is a fixed slice of time, so a rest is a real thing that takes up
 * room. That is why the editor has to be able to insert and delete an empty
 * one: it is how the rhythm is written.
 */
const loops = {};

loops.COUNT = 4;                 // four loop channels
loops.ROWS = 4;                  // up to four notes at once, per loop
loops.BAR = 8;                   // steps to a bar: four beats of two eighths
loops.DEFAULT_BPM = 120;
loops.MIN_BPM = 40;
loops.MAX_BPM = 240;
loops.GATE = 0.9;                // of a step: a note stops just before the next
loops.VELOCITY = 100;

/**
 * The MIDI channel a loop plays on. Channel 0 is the player's hands and is
 * never touched, so a loop starting can never cut off a note being held.
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

/** An empty step: four rows, all silent. */
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

/** The four of them, as the app starts with. */
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

/**
 * Puts a note in a step. `row` of null finds the first free row, which is what
 * a chord wants: play three keys, they fill rows 0, 1 and 2. A step already
 * holding four notes takes no more.
 */
loops.setNote = function (steps, index, row, midi) {
    if (index < 0) {
        return loops.copy(steps);
    }
    const grown = loops.extend(steps, index);
    const step = grown[index];

    if (midi === null) {
        if (row !== null && row >= 0 && row < loops.ROWS) {
            step[row] = null;
        }
        return grown;
    }
    if (step.indexOf(midi) !== -1) {
        return grown;                       // already sounding in this step
    }

    const at = row === null || row === undefined ? step.indexOf(null) : row;
    if (at < 0 || at >= loops.ROWS) {
        return grown;                       // all four rows are taken
    }
    step[at] = midi;
    return grown;
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
 * Rounds a strip up to a whole bar, so four loops of different lengths still
 * come round together instead of drifting apart.
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
    return step ? step.filter(note => note !== null).sort((a, b) => a - b) : [];
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
