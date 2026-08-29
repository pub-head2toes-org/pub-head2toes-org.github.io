'use strict';

/**
 * Portable Game Notation, as text and nothing else.
 *
 * This file knows the shape of a PGN - a header of tags, then a movetext of
 * numbered moves, comments in braces and variations in brackets - and knows
 * nothing about whether any of it is legal. `game.js` is what walks these
 * tokens over a board and finds out.
 *
 * Keeping the two apart means a PGN with one bad move still reads: the parse
 * yields tokens either way, and the game says how far it got.
 */
const pgn = {};

pgn.RESULTS = ['1-0', '0-1', '1/2-1/2', '*'];

/**
 * A move token as this file hands it on:
 *
 *   { san, comment, nags: [], variations: [ [token, ...], ... ] }
 *
 * A variation is a movetext in its own right, so the structure nests as deep
 * as the file does.
 */

/* ---------- reading ---------- */

/** Tags, movetext and result, out of a whole PGN file. */
pgn.parse = function (text) {
    const source = String(text || '').replace(/\r\n?/g, '\n');
    const tags = {};
    let cursor = 0;

    const header = /\[\s*([A-Za-z0-9_]+)\s+"((?:[^"\\]|\\.)*)"\s*\]/g;
    let match;
    while ((match = header.exec(source))) {
        // Only the run of tags at the top is a header; a bracket further down
        // belongs to the movetext.
        if (source.slice(cursor, match.index).trim()) break;
        tags[match[1]] = match[2].replace(/\\(["\\])/g, '$1');
        cursor = header.lastIndex;
    }

    const movetext = source.slice(cursor);
    const read = pgn.movetext(movetext);
    return {
        tags: tags,
        intro: read.intro,
        moves: read.moves,
        result: read.result || tags.Result || '*'
    };
};

/**
 * The movetext: a flat list of moves, each carrying its own comment and any
 * variations that were written after it.
 *
 * Move numbers are read and thrown away. They say nothing a position does not
 * already say, and a hand-edited file gets them wrong long before it gets a
 * move wrong.
 */
pgn.movetext = function (text) {
    const source = String(text || '');
    const moves = [];
    let intro = '';
    let result = '';
    let index = 0;

    const stack = [moves];
    const top = function () { return stack[stack.length - 1]; };
    const last = function () { const list = top(); return list[list.length - 1] || null; };

    while (index < source.length) {
        const sign = source[index];

        if (/\s/.test(sign)) { index++; continue; }

        if (sign === '{') {
            const end = source.indexOf('}', index);
            const body = source.slice(index + 1, end === -1 ? source.length : end).trim();
            const move = last();
            if (move) move.comment = move.comment ? move.comment + ' ' + body : body;
            else if (stack.length === 1) intro = intro ? intro + ' ' + body : body;
            index = end === -1 ? source.length : end + 1;
            continue;
        }

        if (sign === ';') {                       // a comment to the end of the line
            const end = source.indexOf('\n', index);
            const body = source.slice(index + 1, end === -1 ? source.length : end).trim();
            const move = last();
            if (move) move.comment = move.comment ? move.comment + ' ' + body : body;
            index = end === -1 ? source.length : end;
            continue;
        }

        if (sign === '(') {                       // a variation on the move just read
            const move = last();
            const branch = [];
            if (move) move.variations.push(branch);
            stack.push(branch);
            index++;
            continue;
        }

        if (sign === ')') {
            if (stack.length > 1) stack.pop();
            index++;
            continue;
        }

        if (sign === '$') {                       // a numeric annotation glyph
            const glyph = /^\$\d+/.exec(source.slice(index))[0];
            const move = last();
            if (move) move.nags.push(glyph);
            index += glyph.length;
            continue;
        }

        if (/[0-9]/.test(sign)) {
            const ahead = source.slice(index);
            const end = /^(1-0|0-1|1\/2-1\/2)/.exec(ahead);
            if (end) {
                if (stack.length === 1) result = end[0];
                index += end[0].length;
                continue;
            }
            const number = /^\d+\s*\.*/.exec(ahead)[0];
            index += number.length;
            continue;
        }

        if (sign === '*') {
            if (stack.length === 1) result = '*';
            index++;
            continue;
        }

        const move = /^[A-Za-z][A-Za-z0-9=\-+#!?]*/.exec(source.slice(index));
        if (move) {
            top().push({ san: move[0], comment: '', nags: [], variations: [] });
            index += move[0].length;
            continue;
        }

        index++;                                   // anything else is not ours
    }

    return { moves: moves, intro: intro, result: result };
};

/* ---------- writing ---------- */

/**
 * A whole PGN file: the seven tag roster first, in the order the standard
 * gives it, then whatever else was set, then the movetext.
 */
pgn.write = function (tags, moves, options) {
    const settings = options || {};
    const roster = ['Event', 'Site', 'Date', 'Round', 'White', 'Black', 'Result'];
    const written = {};
    let head = '';

    for (const name of roster) {
        written[name] = true;
        head += pgn.tag(name, tags[name] !== undefined ? tags[name] : pgn.blank(name));
    }
    for (const name in tags) {
        if (!written[name] && tags[name] !== undefined && tags[name] !== '') {
            head += pgn.tag(name, tags[name]);
        }
    }

    const body = pgn.moves(moves, settings.firstNumber || 1, settings.firstIsBlack || false);
    const result = tags.Result || '*';
    return head + '\n' + pgn.wrap((body ? body + ' ' : '') + result) + '\n';
};

/** What the standard puts in a tag nobody filled in. */
pgn.blank = function (name) {
    if (name === 'Date') return '????.??.??';
    if (name === 'Result') return '*';
    if (name === 'Round') return '-';
    return '?';
};

pgn.tag = function (name, value) {
    return '[' + name + ' "' + String(value).replace(/([\\"])/g, '\\$1') + '"]\n';
};

/**
 * The movetext of a line, variations and all.
 *
 * Black's move takes a number too whenever the line does not run straight on
 * from White's - after a comment, after a variation, or at the head of a line
 * that starts on a Black move - which is what `4... Nf6` means.
 */
pgn.moves = function (moves, firstNumber, firstIsBlack) {
    let number = firstNumber || 1;
    let black = !!firstIsBlack;
    let text = '';
    let broken = true;

    for (const move of moves || []) {
        const prefix = black ? (broken ? number + '... ' : '') : number + '. ';
        text += (text ? ' ' : '') + prefix + move.san;
        broken = false;

        for (const nag of move.nags || []) text += ' ' + nag;
        if (move.comment) { text += ' {' + move.comment.replace(/[{}]/g, '') + '}'; broken = true; }

        for (const variation of move.variations || []) {
            text += ' (' + pgn.moves(variation, number, black) + ')';
            broken = true;
        }

        if (black) number++;
        black = !black;
    }
    return text;
};

/** PGN lines stop at 80 columns, and never inside a token. */
pgn.wrap = function (text, width) {
    const limit = width || 80;
    const lines = [];
    let line = '';
    for (const word of String(text).split(/\s+/).filter(Boolean)) {
        if (line && line.length + 1 + word.length > limit) { lines.push(line); line = word; }
        else line = line ? line + ' ' + word : word;
    }
    if (line) lines.push(line);
    return lines.join('\n');
};
