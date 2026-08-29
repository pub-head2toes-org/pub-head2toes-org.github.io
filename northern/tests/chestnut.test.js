'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { loadChestnut } from './helpers/chestnutPage.js';

const PWA = path.join(import.meta.dirname, '..', 'src', 'fs', 'pwa', 'chestnut');
const read = name => fs.readFileSync(path.join(PWA, name), 'utf8');

/**
 * chess.js, board.js, pgn.js and game.js touch no DOM. They do lean on each
 * other by name the way the page loads them, so they are loaded together, in
 * order, into one function body - which is the same one shared scope the four
 * script tags give them in the browser.
 *
 * The engine is the vendored bundle: what the app runs against is what these
 * tests run against, and there is no second copy of the rules to disagree with.
 * It is a UMD bundle, so it is handed a `module` and takes itself from there.
 *
 * Not a `vm` context, on purpose: the arrays these functions build are then
 * this realm's arrays, and can be compared with the ones a test writes down.
 */
const { chess, board, pgn, game } = (function () {
    const box = { exports: {} };
    const source = [
        read('js-chess-engine.js'),
        'var jsChessEngine = module.exports;',
        read('chess.js'),
        read('board.js'),
        read('pgn.js'),
        read('game.js'),
        'chess.use(jsChessEngine);',
        'return { chess: chess, board: board, pgn: pgn, game: game };'
    ].join('\n');
    return new Function('module', 'exports', source)(box, box.exports);
})();

/** Play a line of notation from the start and give back the game. */
function played(...sans) {
    const state = game.create();
    for (const san of sans) {
        const node = game.playSan(state, state.current, san);
        assert.ok(node, `${san} should be playable`);
    }
    return state;
}

describe('the rules, as text', () => {
    it('plays a move and says what it was', () => {
        const move = chess.move(chess.START_FEN, 'E2', 'E4');

        assert.strictEqual(move.san, 'e4');
        assert.strictEqual(move.fen, 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1');
    });

    it('refuses a move that is not there, and says so with a null', () => {
        assert.strictEqual(chess.move(chess.START_FEN, 'E2', 'E5'), null);
        assert.strictEqual(chess.move(chess.START_FEN, 'E7', 'E5'), null, 'not Black to play');
    });

    it('writes castling as O-O and O-O-O', () => {
        const short = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';

        assert.strictEqual(chess.move(short, 'E1', 'G1').san, 'O-O');
        assert.strictEqual(chess.move(short, 'E1', 'C1').san, 'O-O-O');
    });

    it('says only as much about where a piece came from as it has to', () => {
        const twoKnights = '8/8/8/3N1N2/8/8/7k/K7 w - - 0 1';
        assert.strictEqual(chess.move(twoKnights, 'D5', 'E7').san, 'Nde7', 'the file tells them apart');

        const onAFile = '8/8/8/3N4/8/3N4/7k/K7 w - - 0 1';
        assert.strictEqual(chess.move(onAFile, 'D5', 'B4').san, 'N5b4', 'same file, so the rank does');

        const alone = '8/8/8/3N4/8/8/7k/K7 w - - 0 1';
        assert.strictEqual(chess.move(alone, 'D5', 'E7').san, 'Ne7', 'nothing to say when it is the only one');
    });

    it('marks a capture, a check and a mate', () => {
        const capture = chess.move('8/8/8/3p4/4N3/8/7k/K7 w - - 0 1', 'E4', 'D6');
        assert.strictEqual(capture.san, 'Nd6');

        const check = chess.move('7k/8/8/8/8/8/8/K5R1 w - - 0 1', 'G1', 'G8');
        assert.strictEqual(check.san, 'Rg8+', 'check only - the king takes the rook');

        const ladder = chess.move('7k/1R6/R7/8/8/8/8/K7 w - - 0 1', 'A6', 'A8');
        assert.strictEqual(ladder.san, 'Ra8#');

        const mate = chess.move('rnbqkbnr/ppppp2p/8/5pp1/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 3', 'D1', 'H5');
        assert.strictEqual(mate.san, 'Qh5#', 'the fool is mated');
    });

    it('takes en passant, and writes it as a pawn capture', () => {
        const move = chess.move('rnbqkbnr/pp1ppppp/8/8/3pP3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1', 'D4', 'E3');

        assert.strictEqual(move.san, 'exe3'.replace('exe3', 'dxe3'));
        assert.ok(!chess.pieces(move.fen).E4, 'the pawn that ran past is gone');
    });

    it('promotes to what was asked for, not always to a queen', () => {
        const start = '8/P6k/8/8/8/8/7K/8 w - - 0 1';

        assert.strictEqual(chess.move(start, 'A7', 'A8').san, 'a8=Q', 'a queen unless told otherwise');
        assert.strictEqual(chess.move(start, 'A7', 'A8', 'N').san, 'a8=N');
        assert.strictEqual(chess.pieces(chess.move(start, 'A7', 'A8', 'N').fen).A8, 'N');
    });

    it('reads notation back into the move it names', () => {
        assert.deepStrictEqual(chess.parse(chess.START_FEN, 'Nf3'), { from: 'G1', to: 'F3', promotion: null });
        assert.deepStrictEqual(chess.parse('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', '0-0'),
            { from: 'E1', to: 'G1', promotion: null });
        assert.deepStrictEqual(chess.parse('8/P6k/8/8/8/8/7K/8 w - - 0 1', 'a8=N+'),
            { from: 'A7', to: 'A8', promotion: 'N' });
        assert.strictEqual(chess.parse(chess.START_FEN, 'Nf6'), null, 'not White to play');
    });

    it('knows a position with no moves left from one with a move to make', () => {
        const mate = chess.read('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3');
        assert.ok(mate.mate);
        assert.ok(mate.finished);

        const drawn = chess.read('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
        assert.ok(drawn.stalemate);
        assert.ok(!drawn.check);
    });

    it('builds a FEN from a board that was set up by hand', () => {
        const pieces = { E1: 'K', E8: 'k', A1: 'R', D4: 'P' };

        assert.strictEqual(chess.compose(pieces, 'black'), '4k3/8/8/8/3P4/8/8/R3K3 b Q - 0 1');
        assert.strictEqual(chess.compose({ E1: 'K', E8: 'k' }, 'white'), '4k3/8/8/8/8/8/8/4K3 w - - 0 1',
            'no rooks, so no right to castle');
        assert.ok(!chess.playable('4k3/8/8/8/8/8/8/8 w - - 0 1'), 'one king is not a game');
    });

    it('has an opinion of its own about what to play', () => {
        const best = chess.best(chess.START_FEN, 1);

        assert.ok(best && best.san, 'the engine suggests something');
        assert.ok(chess.move(chess.START_FEN, best.from, best.to), 'and it is legal');
        assert.strictEqual(chess.best('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1', 1), null, 'nothing to suggest in a stalemate');
    });
});

describe('the board, as geometry', () => {
    it('puts A1 at the bottom left, and at the top right when flipped', () => {
        const side = 400;
        const a1 = board.rect('A1', side, false);
        const flipped = board.rect('A1', side, true);

        assert.ok(a1.x < side / 2 && a1.y > side / 2);
        assert.ok(flipped.x > side / 2 && flipped.y < side / 2);
    });

    it('finds the square under a point, both ways up', () => {
        const side = 400;
        for (const square of ['A1', 'E4', 'H8', 'D7']) {
            const middle = board.centre(square, side, false);
            assert.strictEqual(board.at(middle.x, middle.y, side, false), square);

            const other = board.centre(square, side, true);
            assert.strictEqual(board.at(other.x, other.y, side, true), square, `${square} flipped`);
        }
    });

    it('has nothing outside the field', () => {
        assert.strictEqual(board.at(1, 1, 400, false), null, 'the margin is not a square');
        assert.strictEqual(board.at(399, 399, 400, false), null);
    });

    it('colours the squares the way a board is: A1 dark, H1 light', () => {
        assert.ok(!board.isLight('A1'));
        assert.ok(board.isLight('H1'));
        assert.ok(board.isLight('A8'));
    });

    it('stops the arrow short of the middle of the square it points at', () => {
        const arrow = board.arrow('E2', 'E4', 400, false);
        const end = board.centre('E4', 400, false);

        assert.ok(Math.abs(arrow.y2 - end.y) > 1, 'short of the centre');
        assert.ok(arrow.y2 < arrow.y1, 'and pointing up the board');
    });
});

describe('a game as a tree of moves', () => {
    it('keeps the position of every move, so any of them can be shown at once', () => {
        const state = played('e4', 'e5', 'Nf3');
        const line = game.moves(state.root);

        assert.deepStrictEqual(line.map(node => node.san), ['e4', 'e5', 'Nf3']);
        assert.strictEqual(chess.turnOf(line[0].fen), 'black');
        assert.strictEqual(chess.pieces(line[2].fen).F3, 'N');
    });

    it('makes a second move from the same position a variation, not an overwrite', () => {
        const state = played('e4', 'e5');
        const after = state.root.children[0];
        game.play(state, after, 'C7', 'C5');

        assert.deepStrictEqual(after.children.map(node => node.san), ['e5', 'c5']);
        assert.deepStrictEqual(game.moves(state.root).map(node => node.san), ['e4', 'e5'], 'the main line is untouched');
        assert.strictEqual(game.lines(state).length, 2);
    });

    it('steps into a move that is already there rather than playing it twice', () => {
        const state = played('e4', 'e5');
        const again = game.play(state, state.root, 'E2', 'E4');

        assert.strictEqual(again, state.root.children[0]);
        assert.strictEqual(state.root.children.length, 1);
    });

    it('makes a variation the main line when asked', () => {
        const state = played('e4', 'e5');
        const sicilian = game.play(state, state.root.children[0], 'C7', 'C5');
        game.promote(state, sicilian);

        assert.deepStrictEqual(game.moves(state.root).map(node => node.san), ['e4', 'c5']);
    });

    it('takes a move out and keeps the line by taking the reply with it', () => {
        const state = played('e4', 'e5', 'Nf3', 'Nc6', 'Bb5');
        const pawn = game.moves(state.root)[1];                 // 1...e5

        const result = game.remove(state, pawn);

        assert.ok(result.reply, 'Nf3 went with it, so the colours still alternate');
        assert.strictEqual(result.kept, 2);
        assert.deepStrictEqual(game.moves(state.root).map(node => node.san), ['e4', 'Nc6', 'Bb5']);
    });

    it('takes the last move out and leaves the rest alone', () => {
        const state = played('e4', 'e5', 'Nf3');
        const result = game.remove(state, game.moves(state.root)[2]);

        assert.strictEqual(result.dropped, 0);
        assert.deepStrictEqual(game.moves(state.root).map(node => node.san), ['e4', 'e5']);
    });

    it('drops what will not play after an edit, and counts it', () => {
        const state = played('e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Bxc6');
        const knight = game.moves(state.root)[3];               // 1...Nc6, the piece taken later

        const result = game.remove(state, knight);

        assert.strictEqual(result.kept, 1, 'a6 still stands once Bb5 has gone with the knight');
        assert.strictEqual(result.dropped, 2, 'Bb5 went with it and Bxc6 has nothing to take');
        assert.deepStrictEqual(game.moves(state.root).map(node => node.san), ['e4', 'e5', 'Nf3', 'a6']);
    });

    it('moves a move past the same player\'s move before it', () => {
        const state = played('e4', 'e5', 'Nf3', 'Nc6', 'Bb5');
        const bishop = game.moves(state.root)[4];               // 3.Bb5, White's third

        const result = game.shift(state, bishop, -1);

        assert.ok(result);
        assert.deepStrictEqual(game.moves(state.root).map(node => node.san), ['e4', 'e5', 'Bb5', 'Nc6', 'Nf3']);
        assert.strictEqual(state.current.san, 'Bb5', 'and the move that was asked for is where it went');
    });

    it('changes nothing when a swap would not stand', () => {
        const state = played('d4', 'd5', 'Bf4');
        const bishop = game.moves(state.root)[2];               // the bishop cannot come out before the pawn

        assert.strictEqual(game.shift(state, bishop, -1), null);
        assert.deepStrictEqual(game.moves(state.root).map(node => node.san), ['d4', 'd5', 'Bf4']);
    });

    it('will not move a player\'s first move up, or their last one down', () => {
        const state = played('e4', 'e5', 'Nf3', 'Nc6');
        const line = game.moves(state.root);

        assert.strictEqual(game.shift(state, line[0], -1), null);
        assert.strictEqual(game.shift(state, line[1], -1), null);
        assert.strictEqual(game.shift(state, line[2], 1), null);
        assert.strictEqual(game.shift(state, line[3], 1), null);
    });

    it('holds a note against a move', () => {
        const state = played('e4');
        game.annotate(state, state.root.children[0], 'the best by test {and nothing else}');

        assert.strictEqual(state.root.children[0].comment, 'the best by test and nothing else',
            'braces would close the comment in a PGN, so they do not survive');
    });
});

describe('the game written out', () => {
    it('is one move to a line, numbered as a player writes it', () => {
        const state = played('e4', 'e5', 'Nf3');
        state.current = state.root;

        assert.strictEqual(game.text(state), '1. e4\n1... e5\n2. Nf3');
    });

    it('says where a note and a variation are without showing them', () => {
        const state = played('e4', 'e5');
        game.play(state, state.root.children[0], 'C7', 'C5');
        game.annotate(state, state.root.children[0], 'the king pawn');

        assert.strictEqual(game.text(state, { node: state.root }), '1. e4  {the king pawn}\n1... e5  (+1)',
            'the mark is on the move that has another in its place, not on the one before it');
    });

    it('hides what a puzzle has not given away yet', () => {
        const state = played('e4', 'e5', 'Nf3');
        state.current = state.root.children[0];                 // one move revealed

        assert.strictEqual(game.text(state, { hidden: true }), '1. e4\n1... ?\n2. ?');
    });

    it('finds the move a caret is sitting on', () => {
        const text = '1. e4\n1... e5\n2. Nf3';

        assert.strictEqual(game.rowAt(text, 0), 0);
        assert.strictEqual(game.rowAt(text, 8), 1);
        assert.strictEqual(game.rowAt(text, text.length), 2);
    });
});

describe('PGN, in and out', () => {
    it('reads the header and the moves', () => {
        const read = pgn.parse('[Event "A game"]\n[White "Nobody"]\n\n1. e4 e5 2. Nf3 1-0\n');

        assert.strictEqual(read.tags.Event, 'A game');
        assert.strictEqual(read.result, '1-0');
        assert.deepStrictEqual(read.moves.map(move => move.san), ['e4', 'e5', 'Nf3']);
    });

    it('hangs a comment and a variation on the move they follow', () => {
        const read = pgn.parse('1. e4 {a good start} e5 (1... c5 {the Sicilian}) 2. Nf3 *');

        assert.strictEqual(read.moves[0].comment, 'a good start');
        assert.strictEqual(read.moves[1].variations.length, 1);
        assert.deepStrictEqual(read.moves[1].variations[0].map(move => move.san), ['c5']);
        assert.strictEqual(read.moves[1].variations[0][0].comment, 'the Sicilian');
    });

    it('numbers a Black move again whenever the line broke', () => {
        const moves = [
            { san: 'e4', comment: '', nags: [], variations: [] },
            { san: 'e5', comment: 'a comment', nags: [], variations: [] },
            { san: 'Nf3', comment: '', nags: [], variations: [] },
            { san: 'Nc6', comment: '', nags: [], variations: [] }
        ];

        assert.strictEqual(pgn.moves(moves, 1, false), '1. e4 e5 {a comment} 2. Nf3 Nc6',
            'nothing broke before e5, so it needs no number of its own');

        moves[0].comment = 'the king pawn';
        assert.strictEqual(pgn.moves(moves, 1, false),
            '1. e4 {the king pawn} 1... e5 {a comment} 2. Nf3 Nc6', 'a comment breaks the line, so e5 is numbered');
    });

    it('takes a game out and reads the same game back in', () => {
        const state = played('e4', 'e5', 'Nf3', 'Nc6');
        game.play(state, game.moves(state.root)[1], 'B1', 'C3');       // 2.Nc3 instead of 2.Nf3
        game.annotate(state, game.moves(state.root)[0], 'the king pawn');

        const text = game.toPgn(state);
        const back = game.fromPgn(text).state;

        assert.strictEqual(back.dropped, undefined);
        assert.deepStrictEqual(game.moves(back.root).map(node => node.san), ['e4', 'e5', 'Nf3', 'Nc6']);
        assert.strictEqual(game.moves(back.root)[0].comment, 'the king pawn');
        assert.strictEqual(game.lines(back).length, 2, 'the variation came back too');
        assert.strictEqual(game.toPgn(back), text, 'and writing it again gives the same file');
    });

    it('carries the position a game was set up from', () => {
        const puzzle = game.create('4k3/8/8/8/8/8/4P3/4K3 w - - 0 1');
        puzzle.puzzle = true;
        game.playSan(puzzle, puzzle.current, 'e4');

        const text = game.toPgn(puzzle);
        assert.match(text, /\[SetUp "1"\]/);
        assert.match(text, /\[Puzzle "1"\]/);

        const back = game.fromPgn(text).state;
        assert.strictEqual(back.start, '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1');
        assert.ok(back.puzzle);
        assert.deepStrictEqual(game.moves(back.root).map(node => node.san), ['e4']);
    });

    it('numbers a line that starts on a Black move from where it starts', () => {
        const state = game.create('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 12');
        game.playSan(state, state.current, 'e5');

        assert.match(game.toPgn(state), /12\.\.\. e5/);
    });

    it('keeps a game that has one move in it that will not play', () => {
        const read = game.fromPgn('1. e4 e5 2. Qh8 3. Nf3');

        assert.strictEqual(read.dropped, 1);
        assert.deepStrictEqual(game.moves(read.state.root).map(node => node.san), ['e4', 'e5']);
    });
});

describe('the page', () => {
    it('opens on a full board, with the message bar saying whose move it is', () => {
        const page = loadChestnut();

        assert.strictEqual(Object.keys(page.drawn()).length, 32);
        assert.strictEqual(page.drawn().E1, page.board.glyph('K'), 'the king is drawn on e1');
        assert.match(page.message(), /White to play/);
        assert.deepStrictEqual(page.list(), []);
    });

    it('writes a move made on the board into the list', () => {
        const page = loadChestnut();

        page.move('E2', 'E4');

        assert.deepStrictEqual(page.list(), ['1. e4']);
        assert.match(page.message(), /1\. e4\. Black to play/);
        assert.ok(!page.drawn().E2 && page.drawn().E4, 'and the piece moved with it');
    });

    it('does nothing with a move that is not legal', () => {
        const page = loadChestnut();

        page.move('E2', 'E5');

        assert.deepStrictEqual(page.list(), []);
    });

    it('steps through a game and back again', () => {
        const page = loadChestnut({ pgn: '[Event "A game"]\n\n1. e4 e5 2. Nf3 *\n' });

        assert.deepStrictEqual(page.list(), ['1. e4', '1... e5', '2. Nf3']);
        assert.strictEqual(page.drawn().E4, undefined, 'it opens at the starting position');

        page.click('step');
        assert.ok(page.drawn().E4, 'one move on');

        page.click('last');
        assert.ok(page.drawn().F3);

        page.click('back');
        assert.strictEqual(page.drawn().F3, undefined);

        page.click('first');
        assert.strictEqual(page.drawn().E4, undefined);
    });

    it('plays the game through on a timer, and stops at the end', () => {
        const page = loadChestnut({ pgn: '1. e4 e5 *' });

        page.click('play');
        assert.ok(page.playing());
        assert.ok(page.drawn().E4, 'the first move goes at once');

        page.tick();
        assert.ok(page.drawn().E5);

        page.tick();
        assert.ok(!page.playing(), 'nothing left to play');
    });

    it('goes to the move a tap in the list lands on', () => {
        const page = loadChestnut({ pgn: '1. e4 e5 2. Nf3 *' });

        page.pick(1);

        assert.ok(page.drawn().E5, 'the board is at 1...e5');
        assert.strictEqual(page.drawn().F3, undefined);
    });

    it('makes a variation of a move played over one that is already there', () => {
        const page = loadChestnut({ pgn: '1. e4 e5 *' });

        page.click('step');                     // at 1.e4, with 1...e5 written after it
        page.move('C7', 'C5');

        assert.match(page.message(), /A variation/);
        assert.strictEqual(page.variations().length, 2);
        assert.deepStrictEqual(page.list(), ['1. e4', '1... c5  (+1)'],
            'the mark says there is another move in its place');

        page.choose('variation', '0');
        assert.deepStrictEqual(page.list(), ['1. e4', '1... e5  (+1)'], 'the main line still reads as it did');
    });

    it('turns the board round without changing the game', () => {
        const page = loadChestnut();
        const before = page.drawnAt('E1');

        page.click('flip');
        const after = page.drawnAt('E1');

        assert.ok(after.y < before.y, 'White is at the top now');
        assert.strictEqual(Object.keys(page.drawn()).length, 32);
    });

    it('edits the list: a note, a move up, a move out', () => {
        const page = loadChestnut({ pgn: '1. e4 e5 2. Nf3 Nc6 3. Bb5 *' });

        page.click('edit');
        page.pick(4);                            // 3.Bb5
        page.answers('the Spanish');
        page.click('note');
        assert.match(page.list()[4], /\{the Spanish\}/);

        page.click('up');
        assert.deepStrictEqual(page.list().map(row => row.split(' ').pop().replace(/[{}]/g, '')),
            ['e4', 'e5', 'Spanish', 'Nc6', 'Nf3'], 'the bishop came out before the knight');

        page.pick(0);
        page.click('del');
        assert.match(page.message(), /Took out e4/);
        assert.ok(!page.list().some(row => / e4$/.test(row)));
    });

    it('adds a move by notation, and says when there is no such move', () => {
        const page = loadChestnut();

        page.click('edit');
        page.answers('d4');
        page.click('add');
        assert.deepStrictEqual(page.list(), ['1. d4']);

        page.answers('Qh8');
        page.click('add');
        assert.match(page.message(), /no move Qh8/);
        assert.deepStrictEqual(page.list(), ['1. d4']);
    });

    it('sets a position up and starts the game again from it', () => {
        const page = loadChestnut({ pgn: '1. e4 *' });

        page.click('setup');
        page.click('setup_clear');
        assert.deepStrictEqual(page.drawn(), {}, 'an empty board to build on');

        page.click('setup_done');
        assert.match(page.message(), /one king of each colour/);

        const brushes = page.element('palette_pieces').children;
        brushes.find(brush => brush.getAttribute('aria-label') === 'K').click();
        page.press('E1');
        brushes.find(brush => brush.getAttribute('aria-label') === 'k').click();
        page.press('E8');
        brushes.find(brush => brush.getAttribute('aria-label') === 'P').click();
        page.press('E2');

        page.click('setup_done');

        assert.match(page.message(), /The board is set/);
        assert.deepStrictEqual(page.drawn(),
            { E1: page.board.glyph('K'), E2: page.board.glyph('P'), E8: page.board.glyph('k') });
        assert.deepStrictEqual(page.list(), [], 'and the moves that were played are not the new game');

        page.move('E2', 'E4');
        assert.deepStrictEqual(page.list(), ['1. e4']);
    });

    it('keeps a puzzle to itself until it is asked', () => {
        const page = loadChestnut({ pgn: '1. e4 e5 2. Nf3 *' });

        page.click('puzzle');
        assert.deepStrictEqual(page.list(), ['1. ?', '1... ?', '2. ?']);

        page.click('reveal');
        assert.deepStrictEqual(page.list(), ['1. e4', '1... ?', '2. ?']);

        page.click('edit');
        assert.deepStrictEqual(page.list(), ['1. e4', '1... e5', '2. Nf3'], 'editing a puzzle shows it');
    });

    it('asks the engine what it would play', () => {
        const page = loadChestnut();

        page.click('analyze');

        assert.match(page.message(), /The engine would play/);
        assert.ok(page.app.hint, 'and points at it on the board');
        assert.ok(page.chess.move(page.app.state.current.fen, page.app.hint.from, page.app.hint.to));
    });

    it('saves the game as a PGN and reads one back', () => {
        const page = loadChestnut();
        page.move('E2', 'E4');
        page.move('E7', 'E5');

        page.click('save');
        const text = page.saved[0].text;
        assert.match(text, /1\. e4 e5/);

        page.click('new_game');
        assert.deepStrictEqual(page.list(), []);

        page.upload(text, 'ruy.pgn');
        assert.deepStrictEqual(page.list(), ['1. e4', '1... e5']);
        assert.match(page.message(), /ruy\.pgn: 2 moves/);
    });

    it('says when a file has nothing in it that plays', () => {
        const page = loadChestnut();

        page.upload('this is not a game', 'notes.txt');

        assert.match(page.message(), /Nothing in notes\.txt/);
    });

    it('keeps the game between visits', () => {
        const first = loadChestnut();
        first.move('D2', 'D4');

        const second = loadChestnut({ pgn: first.stored() });

        assert.deepStrictEqual(second.list(), ['1. d4']);
    });

    it('takes the arrow keys as well as the buttons', () => {
        const page = loadChestnut({ pgn: '1. e4 e5 *' });

        page.type('ArrowRight');
        assert.ok(page.drawn().E4);

        page.type('ArrowLeft');
        assert.strictEqual(page.drawn().E4, undefined);

        page.type('End');
        assert.ok(page.drawn().E5);
    });
});

describe('the board in the room it is given', () => {
    it('is a square that fits the row, and gives the move list the same height', () => {
        const page = loadChestnut();

        assert.deepStrictEqual(page.boardBox(), { width: 600, height: 600 }, 'as tall as the row');
        assert.strictEqual(page.element('notation').style.height, '600px');
    });

    it('gives the room back when the header takes another line', () => {
        const page = loadChestnut();

        // The buttons wrapped onto a second row, so the row below is shorter.
        page.resizeTo(1000, 420);

        assert.ok(page.boardBox().height <= 420, 'the board is inside the row, not over the header');
        assert.strictEqual(page.boardBox().height, 420);
    });

    it('stacks under the buttons on a tall window, leaving the list room below', () => {
        const page = loadChestnut({ room: { width: 420, height: 800 } });

        assert.ok(page.boardBox().width <= 420);
        assert.ok(page.boardBox().height <= 800 - 180, 'the move list is not pushed off the bottom');
    });
});
