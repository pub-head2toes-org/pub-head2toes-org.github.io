'use strict';

/**
 * The rules, as text.
 *
 * Every function here takes a FEN string and gives back a FEN string or a piece
 * of notation. Nothing is kept between calls: a position is its FEN, and that
 * is the whole state of the game as far as this file is concerned. It is the
 * slower way round - the engine rebuilds its board on each call - but a chess
 * board is 64 squares, and it buys a model that can be stored, compared,
 * replayed and rewound without a single mutable object anywhere.
 *
 * `js-chess-engine` (MIT, vendored beside this file) knows which moves are
 * legal. It does not know algebraic notation, which is what a game is written
 * in, so `chess.san` and `chess.parse` are ours.
 *
 * No DOM, no engine global assumed at load time: `chess.use` lets the tests
 * hand the library in.
 */
const chess = {};

chess.START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
chess.EMPTY_FEN = '8/8/8/8/8/8/8/8 w - - 0 1';

chess.FILES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
chess.RANKS = ['1', '2', '3', '4', '5', '6', '7', '8'];
chess.PROMOTIONS = ['Q', 'R', 'B', 'N'];

/**
 * The vendored bundle is UMD and names its global with a dash, which is not a
 * legal identifier - hence the bracket lookup as well as the plain one.
 */
chess.lib = (function () {
    const global = typeof globalThis !== 'undefined' ? globalThis : {};
    if (typeof jsChessEngine !== 'undefined') return jsChessEngine;
    return global.jsChessEngine || global['js-chess-engine'] || null;
})();

/** Hand in the engine when it is not a global - the tests do this. */
chess.use = function (lib) {
    chess.lib = lib;
    return chess;
};

/* ---------- squares ---------- */

/** 'E4' -> 4, counting files from zero. */
chess.file = function (square) {
    return chess.FILES.indexOf(square[0].toUpperCase());
};

/** 'E4' -> 3, counting ranks from zero at White's end. */
chess.rank = function (square) {
    return chess.RANKS.indexOf(square[1]);
};

/** (4, 3) -> 'E4'. Off the board is null, so callers can test one thing. */
chess.square = function (file, rank) {
    if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
    return chess.FILES[file] + chess.RANKS[rank];
};

/** The engine speaks in upper case ('E4'), notation in lower ('e4'). */
chess.up = function (square) { return square ? square.toUpperCase() : square; };
chess.down = function (square) { return square ? square.toLowerCase() : square; };

/** Every square, A1 first, as the engine names them. */
chess.squares = (function () {
    const all = [];
    for (let rank = 0; rank < 8; rank++) {
        for (let file = 0; file < 8; file++) all.push(chess.FILES[file] + chess.RANKS[rank]);
    }
    return all;
})();

/** True for 'K', 'p', 'Q'... and false for anything else. */
chess.isPiece = function (piece) {
    return typeof piece === 'string' && /^[kqrbnp]$/i.test(piece);
};

/** A piece's colour, by its case: 'K' is White's, 'k' is Black's. */
chess.colourOf = function (piece) {
    return piece === piece.toUpperCase() ? 'white' : 'black';
};

/* ---------- positions ---------- */

/**
 * A position, read out of its FEN.
 *
 * `moves` is every legal move for the side to play, keyed by the square it
 * starts on. `check`, `mate` and `stalemate` are worked out here rather than
 * taken from the engine's own flags, which it only fills in on some paths.
 */
chess.read = function (fen) {
    const state = new chess.lib.Game(fen).exportJson();
    const moves = {};
    let any = false;
    for (const from in state.moves) {
        if (state.moves[from] && state.moves[from].length) {
            moves[from] = state.moves[from].slice();
            any = true;
        }
    }
    return {
        fen: fen,
        pieces: Object.assign({}, state.pieces),
        turn: state.turn,
        moves: moves,
        enPassant: state.enPassant || null,
        halfMove: state.halfMove,
        fullMove: state.fullMove,
        check: !!state.check,
        mate: !!state.check && !any,
        stalemate: !state.check && !any,
        finished: !any
    };
};

/** True when the side to play may go from one square to the other. */
chess.legal = function (position, from, to) {
    const list = position.moves[chess.up(from)];
    return !!list && list.indexOf(chess.up(to)) !== -1;
};

/** The squares the piece standing here may go to - [] when it may not move. */
chess.destinations = function (position, from) {
    return (position.moves[chess.up(from)] || []).slice();
};

/**
 * Play a move and get back what was played: the notation and the position it
 * leads to. Illegal moves are null rather than an exception - a game being
 * edited is full of moves that no longer work, and each one is a fact to act
 * on, not a failure.
 *
 * The engine promotes to a queen and offers no say in it. When something else
 * was asked for, the piece is simply put on the square afterwards, which is
 * the same board by any other route.
 */
chess.move = function (fen, from, to, promotion) {
    const before = chess.read(fen);
    from = chess.up(from);
    to = chess.up(to);
    if (!chess.legal(before, from, to)) return null;

    const promo = chess.promotionOf(before, from, to) ? (promotion || 'Q').toUpperCase() : null;
    const game = new chess.lib.Game(fen);
    game.move(from, to);
    if (promo && promo !== 'Q') {
        game.setPiece(to, before.turn === 'white' ? promo : promo.toLowerCase());
    }
    const after = game.exportFEN();

    return {
        from: from,
        to: to,
        promotion: promo,
        san: chess.san(before, from, to, promo, chess.read(after)),
        fen: after,
        capture: !!before.pieces[to] || chess.isEnPassant(before, from, to)
    };
};

/** True when this move takes a pawn to the far rank and a piece must be named. */
chess.promotionOf = function (position, from, to) {
    const piece = position.pieces[chess.up(from)];
    if (!piece || piece.toUpperCase() !== 'P') return false;
    return chess.up(to)[1] === (position.turn === 'white' ? '8' : '1');
};

/** A pawn stepping sideways onto the empty square behind another pawn. */
chess.isEnPassant = function (position, from, to) {
    const piece = position.pieces[chess.up(from)];
    return !!piece && piece.toUpperCase() === 'P' && chess.up(to) === chess.up(position.enPassant);
};

/* ---------- notation ---------- */

/**
 * The move as a player writes it: Nf3, exd5, O-O, e8=N+, Rxd8#.
 *
 * `after` is optional - without it the check and mate marks are left off, which
 * is what `chess.parse` wants when it is comparing what it was given against
 * the moves that are available.
 */
chess.san = function (position, from, to, promotion, after) {
    from = chess.up(from);
    to = chess.up(to);
    const piece = (position.pieces[from] || '').toUpperCase();
    let text;

    if (piece === 'K' && Math.abs(chess.file(to) - chess.file(from)) === 2) {
        text = chess.file(to) > chess.file(from) ? 'O-O' : 'O-O-O';
    } else if (piece === 'P') {
        const capture = !!position.pieces[to] || chess.isEnPassant(position, from, to);
        text = (capture ? chess.down(from[0]) + 'x' : '') + chess.down(to) +
            (promotion ? '=' + promotion.toUpperCase() : '');
    } else {
        text = piece + chess.disambiguate(position, from, to) +
            (position.pieces[to] ? 'x' : '') + chess.down(to);
    }

    if (after) {
        if (after.mate) text += '#';
        else if (after.check) text += '+';
    }
    return text;
};

/**
 * The least that has to be said about where the piece came from: nothing when
 * it is the only one that can get there, else its file, else its rank, else
 * the whole square. Two knights on the same file need the rank; three - which
 * takes a promotion - can need both.
 */
chess.disambiguate = function (position, from, to) {
    const piece = (position.pieces[from] || '').toUpperCase();
    const rivals = Object.keys(position.moves).filter(function (square) {
        return square !== from &&
            (position.pieces[square] || '').toUpperCase() === piece &&
            position.moves[square].indexOf(to) !== -1;
    });
    if (!rivals.length) return '';

    const sameFile = rivals.some(function (square) { return square[0] === from[0]; });
    const sameRank = rivals.some(function (square) { return square[1] === from[1]; });
    if (!sameFile) return chess.down(from[0]);
    if (!sameRank) return from[1];
    return chess.down(from);
};

/**
 * Notation back into a move, by writing out every legal move and looking for
 * the one that reads the same. Slower than picking the text apart, and right
 * about every wrinkle - disambiguation, en passant, castling, promotion - for
 * free, because the writer and the reader are then the same code.
 *
 * The check and mate marks are ignored on the way in: a PGN that says `Nf3+`
 * where the move gives no check should still be read as `Nf3`.
 */
chess.parse = function (fen, text) {
    const position = typeof fen === 'string' ? chess.read(fen) : fen;
    const wanted = chess.normalize(text);
    if (!wanted) return null;

    for (const from in position.moves) {
        for (const to of position.moves[from]) {
            const promotions = chess.promotionOf(position, from, to) ? chess.PROMOTIONS : [null];
            for (const promotion of promotions) {
                if (chess.normalize(chess.san(position, from, to, promotion)) === wanted) {
                    return { from: from, to: to, promotion: promotion };
                }
            }
        }
    }
    return null;
};

/**
 * Notation stripped to what identifies the move: no check or mate mark, no
 * annotation glyph, no capture-square shorthand, zeroes for castling written
 * as the letter O.
 */
chess.normalize = function (text) {
    if (typeof text !== 'string') return '';
    return text
        .replace(/[+#?!]+/g, '')
        .replace(/[0O]-[0O]-[0O]/i, 'O-O-O')
        .replace(/^[0O]-[0O]$/i, 'O-O')
        .replace(/\s+/g, '')
        .replace(/e\.p\.$/i, '');
};

/* ---------- the engine's own opinion ---------- */

/**
 * What the engine would play here, at a level from 0 to 3, or null when the
 * game is over and there is nothing to suggest.
 */
chess.best = function (fen, level) {
    const position = chess.read(fen);
    if (position.finished) return null;
    try {
        const played = new chess.lib.Game(fen).aiMove(level === undefined ? 2 : level);
        const from = Object.keys(played)[0];
        return chess.move(fen, from, played[from]);
    } catch (error) {
        return null;
    }
};

/* ---------- building a position by hand ---------- */

/**
 * A FEN written from a board that was set up rather than played into.
 *
 * Castling is granted only where the king and rook are still on their squares:
 * a puzzle position that happens to have a king on e1 should not come with the
 * right to castle into a corner the position never earned. Everything else - en
 * passant, the clocks - starts empty, because a set-up board has no past.
 */
chess.compose = function (pieces, turn) {
    let board = '';
    for (let rank = 7; rank >= 0; rank--) {
        let empty = 0;
        for (let file = 0; file < 8; file++) {
            const piece = pieces[chess.square(file, rank)];
            if (piece) {
                if (empty) { board += empty; empty = 0; }
                board += piece;
            } else empty++;
        }
        if (empty) board += empty;
        if (rank) board += '/';
    }

    let castling = '';
    if (pieces.E1 === 'K') {
        if (pieces.H1 === 'R') castling += 'K';
        if (pieces.A1 === 'R') castling += 'Q';
    }
    if (pieces.E8 === 'k') {
        if (pieces.H8 === 'r') castling += 'k';
        if (pieces.A8 === 'r') castling += 'q';
    }

    return board + ' ' + (turn === 'black' ? 'b' : 'w') + ' ' + (castling || '-') + ' - 0 1';
};

/** The pieces of a FEN, keyed by square, without asking the engine. */
chess.pieces = function (fen) {
    const pieces = {};
    const rows = fen.split(' ')[0].split('/');
    for (let row = 0; row < rows.length; row++) {
        let file = 0;
        for (const sign of rows[row]) {
            if (/[1-8]/.test(sign)) file += Number(sign);
            else pieces[chess.square(file++, 7 - row)] = sign;
        }
    }
    return pieces;
};

/** Whose turn it is, straight out of the FEN. */
chess.turnOf = function (fen) {
    return fen.split(' ')[1] === 'b' ? 'black' : 'white';
};

/** The move number a FEN sits at, for numbering a line that starts mid-game. */
chess.moveNumberOf = function (fen) {
    const number = parseInt(fen.split(' ')[5], 10);
    return isNaN(number) ? 1 : number;
};

/** A king of each colour, and no more than one of each: less is not a game. */
chess.playable = function (fen) {
    const pieces = chess.pieces(fen);
    const values = Object.keys(pieces).map(function (square) { return pieces[square]; });
    return values.filter(function (p) { return p === 'K'; }).length === 1 &&
        values.filter(function (p) { return p === 'k'; }).length === 1;
};
