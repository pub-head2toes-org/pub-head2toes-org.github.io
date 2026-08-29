'use strict';

/**
 * The board, as geometry.
 *
 * Squares in, pixels out. Nothing here draws anything: `chestnut.js` takes
 * these numbers to a canvas for the squares and to an SVG for the pieces, and
 * because both are given the same arithmetic they cannot drift apart by a
 * pixel however the board is resized or flipped.
 *
 * Everything is measured from one number - the side of the board - so the
 * board is whatever size the window leaves it, and there is no table of
 * measurements anywhere to keep in step.
 */
const board = {};

board.SIZE = 8;
board.MARGIN = 0.05;             // of the board side, for the file and rank labels

/**
 * The pieces are Unicode. The solid glyphs are used for both colours - the
 * outlined ones are hollow, so a white piece drawn from one would show the
 * square through its body - and White is told apart by fill and outline rather
 * than by a different shape.
 *
 * Every glyph carries U+FE0E after it, the variation selector that asks for the
 * text form. Without it a font is free to answer with the emoji form, which is
 * a picture: it comes out three dimensional, in its own colours, and takes no
 * notice of the fill it is given - so White's pawn and Black's arrive the same
 * colour. The selector is what keeps these letters rather than pictures.
 */
board.TEXT = '\uFE0E';        // ask for the text form, not the emoji one
board.GLYPHS = {
    k: '♚' + board.TEXT, q: '♛' + board.TEXT, r: '♜' + board.TEXT,
    b: '♝' + board.TEXT, n: '♞' + board.TEXT, p: '♟' + board.TEXT
};

/** The glyph for a piece, White's or Black's - the shape is the same either way. */
board.glyph = function (piece) {
    return board.GLYPHS[String(piece).toLowerCase()] || '';
};

/**
 * The pieces a player may put on the board in set-up, in pairs: king and king,
 * queen and queen. Laid out two to a row that puts White down one side and
 * Black down the other, with the same piece on both sides of every row.
 */
board.PALETTE = ['K', 'k', 'Q', 'q', 'R', 'r', 'B', 'b', 'N', 'n', 'P', 'p'];

/** The playing area: the board less the margin the labels sit in. */
board.field = function (side) {
    const margin = Math.round(side * board.MARGIN);
    return { left: margin, top: margin, side: side - margin * 2, cell: (side - margin * 2) / 8, margin: margin };
};

/** Where a square sits on screen, in columns and rows from the top left. */
board.place = function (square, flipped) {
    const file = chess.file(square);
    const rank = chess.rank(square);
    return flipped
        ? { column: 7 - file, row: rank }
        : { column: file, row: 7 - rank };
};

/** The box a square occupies, in pixels. */
board.rect = function (square, side, flipped) {
    const field = board.field(side);
    const place = board.place(square, flipped);
    return {
        x: field.left + place.column * field.cell,
        y: field.top + place.row * field.cell,
        size: field.cell
    };
};

/** The middle of a square - where a piece and the head of an arrow go. */
board.centre = function (square, side, flipped) {
    const rect = board.rect(square, side, flipped);
    return { x: rect.x + rect.size / 2, y: rect.y + rect.size / 2 };
};

/** The square under a point, or null when the point is off the field. */
board.at = function (x, y, side, flipped) {
    const field = board.field(side);
    const column = Math.floor((x - field.left) / field.cell);
    const row = Math.floor((y - field.top) / field.cell);
    if (column < 0 || column > 7 || row < 0 || row > 7) return null;
    return flipped
        ? chess.square(7 - column, row)
        : chess.square(column, 7 - row);
};

/** True for the pale squares. A1 is dark, which is the whole rule. */
board.isLight = function (square) {
    return (chess.file(square) + chess.rank(square)) % 2 === 1;
};

/**
 * The file and rank labels with the point to draw each at: along the bottom
 * and up the left, turning with the board.
 */
board.labels = function (side, flipped) {
    const field = board.field(side);
    const labels = [];
    for (let index = 0; index < 8; index++) {
        const file = flipped ? 7 - index : index;
        const rank = flipped ? index : 7 - index;
        labels.push({
            text: chess.FILES[file].toLowerCase(),
            x: field.left + index * field.cell + field.cell / 2,
            y: field.top + field.side + field.margin / 2
        });
        labels.push({
            text: chess.RANKS[rank],
            x: field.left / 2,
            y: field.top + index * field.cell + field.cell / 2
        });
    }
    return labels;
};

/**
 * An arrow from one square to another, for what the engine suggests.
 *
 * It stops short of the middle of the target square so the head sits on the
 * square rather than on top of the piece standing there.
 */
board.arrow = function (from, to, side, flipped) {
    const start = board.centre(from, side, flipped);
    const end = board.centre(to, side, flipped);
    const cell = board.field(side).cell;
    const run = Math.hypot(end.x - start.x, end.y - start.y) || 1;
    const back = Math.min(cell * 0.32, run / 2);
    return {
        x1: start.x,
        y1: start.y,
        x2: end.x - (end.x - start.x) / run * back,
        y2: end.y - (end.y - start.y) / run * back,
        width: Math.max(2, cell * 0.11),
        head: cell * 0.34
    };
};
