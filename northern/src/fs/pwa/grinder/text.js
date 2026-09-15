'use strict';

/**
 * Writing, on the canvas.
 *
 * Every word in this game is drawn out of `font8x8`: eight rows of eight dots
 * a letter, each lit dot a little square with a gap around it, which is what
 * makes it read as a matrix board rather than as type. There is no HTML text
 * anywhere in the game and no font to load - the letters are as offline as the
 * rocket is.
 *
 * A run of lit dots in a row is drawn as one rectangle rather than one per
 * dot. A screen of writing is a few thousand dots and every one of them would
 * otherwise be its own call, sixty times a second, to say the same thing.
 */
const text = {};

text.CELL = 8;               // the font is eight dots by eight
text.GAP = 0.16;             // of a dot, left dark, so the dots read as dots
text.LINE = 1.6;             // line height, in cells

/** The eight rows of a character, or the blank if the font has not got it. */
text.glyph = function (character) {
    const code = String(character).charCodeAt(0);
    return font8x8[code] || font8x8[32];
};

/** How wide a line comes out, in pixels, at this many pixels to the dot. */
text.width = function (line, size) {
    return String(line).length * text.CELL * size;
};

/** And how tall one line is, with the space under it. */
text.height = function (size) {
    return text.CELL * size * text.LINE;
};

/**
 * One line, its top left corner at x and y.
 *
 * The low bit of each row is the leftmost dot, which is how the table is
 * written; a row is walked once and each run of lit dots drawn as a single
 * rectangle.
 */
text.draw = function (paint, line, x, y, size, colour) {
    const dot = size * (1 - text.GAP);
    paint.fillStyle = colour;

    const letters = String(line);
    for (let at = 0; at < letters.length; at++) {
        const rows = text.glyph(letters[at]);
        const left = x + at * text.CELL * size;
        for (let row = 0; row < rows.length; row++) {
            const bits = rows[row];
            if (!bits) continue;
            let run = 0;
            for (let column = 0; column <= text.CELL; column++) {
                const lit = column < text.CELL && (bits & (1 << column));
                if (lit) { run += 1; continue; }
                if (run) {
                    paint.fillRect(left + (column - run) * size, y + row * size, (run - 1) * size + dot, dot);
                    run = 0;
                }
            }
        }
    }
    return text.width(letters, size);
};

/** The same, centred on a point rather than started at one. */
text.centre = function (paint, line, middle, y, size, colour) {
    return text.draw(paint, line, Math.round(middle - text.width(line, size) / 2), y, size, colour);
};
