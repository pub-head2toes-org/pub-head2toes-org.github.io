'use strict';

/**
 * The 25 keys, as numbers.
 *
 * Nothing here touches the DOM or the synth: a key is a MIDI note with a name,
 * a colour and a place on a unit-wide keyboard. `bandage.js` is what puts it on
 * a screen and `webaudio-tinysynth.js` is what makes it a sound.
 *
 * 25 keys is two octaves, C to C: 15 white and 10 black. That only holds if the
 * bottom key is a C, so `normalize` makes sure it is.
 */
const keys = {};

keys.COUNT = 25;                 // C to C, two octaves
keys.DEFAULT_LOWEST = 48;        // C3, so middle C (60) sits in the middle
keys.MIN_LOWEST = 12;            // C0
keys.MAX_LOWEST = 96;            // C7, whose top key is C9 - still inside MIDI
keys.BLACK_WIDTH = 0.62;         // of a white key, as a real piano roughly is
keys.BLACK_HEIGHT = 0.465;       // of the board: short enough to leave the white keys room

keys.NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
keys.BLACK = [1, 3, 6, 8, 10];

/** True for the raised keys: C#, D#, F#, G#, A#. */
keys.isBlack = function (midi) {
    return keys.BLACK.indexOf(((midi % 12) + 12) % 12) !== -1;
};

/** Scientific pitch, the naming a piano player expects: 60 is C4. */
keys.name = function (midi) {
    return keys.NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
};

/** The nearest C at or below `midi`, held inside the range the board can reach. */
keys.normalize = function (midi) {
    const wanted = typeof midi === 'number' && isFinite(midi) ? midi : keys.DEFAULT_LOWEST;
    const onC = Math.floor(wanted / 12) * 12;
    return Math.min(keys.MAX_LOWEST, Math.max(keys.MIN_LOWEST, onC));
};

/** Moves the board by whole octaves, and says so even when it could not move. */
keys.shift = function (lowest, octaves) {
    return keys.normalize(keys.normalize(lowest) + (octaves * 12));
};

/**
 * The 25 keys from `lowest` up, each with where it sits on a board one unit wide
 * and one unit tall. White keys divide the width evenly; a black key straddles
 * the line between the two white keys it sits between, which is what makes the
 * gaps in the black row fall in the right places without any special casing.
 *
 * The height is here rather than in the stylesheet so that the one file that
 * knows the geometry knows all of it - the hit testing in the tests reads the
 * same number the page is drawn from.
 */
keys.layout = function (lowest) {
    const bottom = keys.normalize(lowest);
    const notes = [];
    for (let i = 0; i < keys.COUNT; i++) {
        notes.push(bottom + i);
    }

    const whiteCount = notes.filter(midi => !keys.isBlack(midi)).length;
    const whiteWidth = 1 / whiteCount;
    const blackWidth = whiteWidth * keys.BLACK_WIDTH;

    let whitesSoFar = 0;
    return notes.map((midi, index) => {
        const black = keys.isBlack(midi);
        const key = {
            midi: midi,
            index: index,
            name: keys.name(midi),
            black: black,
            width: black ? blackWidth : whiteWidth,
            height: black ? keys.BLACK_HEIGHT : 1,
            left: black
                ? (whitesSoFar * whiteWidth) - (blackWidth / 2)
                : whitesSoFar * whiteWidth
        };
        if (!black) {
            whitesSoFar++;
        }
        return key;
    });
};

/**
 * A computer keyboard laid out like a tracker's: the bottom row is the lower
 * octave, the number/QWERTY row the upper one, black keys on the row above.
 * Values are offsets from the bottom key, so they follow the octave shift.
 */
keys.QWERTY = {
    z: 0, s: 1, x: 2, d: 3, c: 4, v: 5, g: 6, b: 7, h: 8, n: 9, j: 10, m: 11,
    q: 12, 2: 13, w: 14, 3: 15, e: 16, r: 17, 5: 18, t: 19, 6: 20, y: 21, 7: 22, u: 23, i: 24
};

/** The note a typed key plays, or null when that key is not part of the board. */
keys.fromTyped = function (character, lowest) {
    const offset = keys.QWERTY[String(character).toLowerCase()];
    if (offset === undefined) {
        return null;
    }
    return keys.normalize(lowest) + offset;
};

/** The voices on offer, as {program, name} - General MIDI program numbers. */
keys.VOICES = [
    { program: 0, name: 'Grand Piano' },
    { program: 4, name: 'Electric Piano' },
    { program: 11, name: 'Vibraphone' },
    { program: 16, name: 'Drawbar Organ' },
    { program: 19, name: 'Church Organ' },
    { program: 24, name: 'Nylon Guitar' },
    { program: 32, name: 'Acoustic Bass' },
    { program: 48, name: 'Strings' },
    { program: 56, name: 'Trumpet' },
    { program: 73, name: 'Flute' },
    { program: 80, name: 'Square Lead' },
    { program: 88, name: 'New Age Pad' }
];

if (typeof module === 'object' && module.exports) {
    module.exports = keys;
}
