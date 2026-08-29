'use strict';

/**
 * The game: a tree of moves over the rules in `chess.js`.
 *
 * A node is one played move and the position it made. The root is the position
 * the game starts from and holds no move. A node's first child is what was
 * played next; any further children are variations - other things that could
 * have been played instead. That single rule covers the main line, the
 * variations, and the difference between them, which is only ever an order.
 *
 * Every node carries its own FEN. It costs a string per move and it means any
 * move in any variation can be shown without replaying the game to reach it -
 * which is what stepping backwards through a list has to do on every press.
 *
 * Editing a line is where a move list stops being a list: take a move out of
 * the middle and everything after it may have become impossible. So the edits
 * here - remove, shift - rewrite the tail by playing it again, move by move,
 * and stop at the first move that no longer works. Nothing is silently kept
 * that the board would not allow.
 *
 * No DOM. `chestnut.js` is what draws this.
 */
const game = {};

/** A fresh game from a position - the standard array unless told otherwise. */
game.create = function (fen, tags) {
    const start = fen || chess.START_FEN;
    const state = {
        nextId: 1,
        root: { id: 0, san: null, from: null, to: null, promotion: null, fen: start, comment: '', parent: null, children: [] },
        start: start,
        tags: Object.assign({ Event: 'Chestnut', Result: '*' }, tags || {}),
        puzzle: false
    };
    state.current = state.root;
    state.line = state.root;                 // the branch the move list is showing
    return state;
};

/* ---------- walking ---------- */

/** Root first, the given node last. */
game.path = function (node) {
    const path = [];
    for (let step = node; step; step = step.parent) path.unshift(step);
    return path;
};

/** How many moves deep a node sits. The root is 0. */
game.ply = function (node) {
    let ply = 0;
    for (let step = node; step.parent; step = step.parent) ply++;
    return ply;
};

/**
 * The move list a node belongs to: the moves played to reach it, then the
 * first-child line onwards from it. This is what the text area shows.
 */
game.moves = function (node) {
    const line = game.path(node).slice(1);        // the root holds no move
    let step = node;
    while (step.children.length) {
        step = step.children[0];
        line.push(step);
    }
    return line;
};

/** The position before this move, or null at the head of the game. */
game.previous = function (node) {
    return node.parent || null;
};

/** The move after this one along the line it is being read on. */
game.next = function (node) {
    return node.children[0] || null;
};

/**
 * Every line the game can be read along: the main one, then each variation,
 * named by the move it starts from. This is the select above the move list.
 */
game.lines = function (state) {
    const lines = [{ node: state.root, label: 'Main line' }];
    let count = 1;

    const walk = function (node) {
        for (let index = 0; index < node.children.length; index++) {
            const child = node.children[index];
            if (index > 0) {
                count++;
                lines.push({
                    node: child,
                    label: 'Variation ' + count + ' - ' + game.numbered(child) + ' ' + child.san
                });
            }
            walk(child);
        }
    };
    walk(state.root);
    return lines;
};

/** '4.' before a White move, '4...' before a Black one. */
game.numbered = function (node) {
    const number = chess.moveNumberOf(node.parent ? node.parent.fen : node.fen);
    return chess.turnOf(node.parent ? node.parent.fen : node.fen) === 'white' ? number + '.' : number + '...';
};

/* ---------- playing ---------- */

/**
 * Play a move from a node. A move already there is stepped into rather than
 * played twice; anything else joins as a variation, which is what happens when
 * a player takes hold of a piece halfway down a game somebody wrote.
 */
game.play = function (state, node, from, to, promotion) {
    const parent = node || state.current;
    const played = chess.move(parent.fen, from, to, promotion);
    if (!played) return null;

    const existing = parent.children.filter(function (child) {
        return child.from === played.from && child.to === played.to && child.promotion === played.promotion;
    })[0];
    if (existing) {
        state.current = existing;
        return existing;
    }

    const child = {
        id: state.nextId++,
        san: played.san,
        from: played.from,
        to: played.to,
        promotion: played.promotion,
        fen: played.fen,
        comment: '',
        parent: parent,
        children: []
    };
    parent.children.push(child);
    state.current = child;
    return child;
};

/** The same, given notation rather than two squares. */
game.playSan = function (state, node, san) {
    const parent = node || state.current;
    const move = chess.parse(parent.fen, san);
    if (!move) return null;
    return game.play(state, parent, move.from, move.to, move.promotion);
};

/* ---------- editing ---------- */

/**
 * Take a move out and keep as much of what followed it as will still play.
 *
 * A move list is not a list of independent things: take one ply out and every
 * move after it changes hands. So the tail is tried twice - once as it stands,
 * and once without the reply that followed the deleted move, which puts the
 * colours back where they were - and whichever keeps more of the line is the
 * one that is kept. Taking 1...e5 out of a Ruy Lopez that way leaves 1.e4 Nc6
 * 2.Bb5 rather than nothing at all.
 *
 * What survived and what did not is returned, so the message bar can say what
 * the edit cost. Variations hanging off the rewritten tail do not survive it.
 */
game.remove = function (state, node) {
    if (!node || !node.parent) return null;
    const parent = node.parent;
    const index = parent.children.indexOf(node);
    const line = game.moves(node);
    const tail = line.slice(line.indexOf(node) + 1).map(game.step);

    const alone = game.trial(parent.fen, tail);
    const withoutReply = tail.length ? game.trial(parent.fen, tail.slice(1)) : 0;
    const dropReply = withoutReply > alone;
    const steps = dropReply ? tail.slice(1) : tail;

    parent.children.splice(index, 1);
    const kept = game.graft(state, parent, steps, index);
    state.current = parent.children[index] || parent;
    game.reline(state);
    return { kept: kept, dropped: tail.length - kept, reply: dropReply };
};

/**
 * Move a move up or down the list, and play the rest of the line again.
 *
 * Up and down mean past the same player's move before or after it - White's
 * moves swap with White's - because swapping two moves in a row would hand one
 * of them to the wrong player and could never stand: 1.e4 e5 2.Nf3 with the
 * knight moved up one line is 1.e4 Nf3, which is nothing. Two lines up it is
 * 1.Nf3 e5 2.e4, which is a game.
 *
 * Where the swap does not stand, nothing is changed and null comes back.
 */
game.shift = function (state, node, direction) {
    const line = game.moves(node);
    const at = line.indexOf(node);
    const other = at + (direction < 0 ? -2 : 2);
    if (at === -1 || other < 0 || other >= line.length) return null;

    const first = line[Math.min(at, other)];
    const anchor = first.parent;
    const index = anchor.children.indexOf(first);
    const steps = line.slice(line.indexOf(first)).map(game.step);
    const swap = steps[0]; steps[0] = steps[2]; steps[2] = swap;

    if (game.trial(anchor.fen, steps.slice(0, 3)) < 3) return null;   // the swap itself does not stand

    anchor.children.splice(index, 1);
    const kept = game.graft(state, anchor, steps, index);
    // The move that was asked for has changed places: it is the first of the
    // three now if it went up, the last if it went down.
    state.current = game.at(anchor, index, direction < 0 ? 1 : 3) || anchor;
    game.reline(state);
    return { kept: kept, dropped: steps.length - kept };
};

/**
 * A move as an edit carries it: the notation, and the note written against it.
 * Rewriting a line builds new moves, and a note belongs to the move rather than
 * to the place in the list it happened to be in.
 */
game.step = function (node) {
    return { san: node.san, comment: node.comment };
};

/** How many of a run of moves play from a position. Nothing is kept. */
game.trial = function (fen, steps) {
    let where = fen;
    let played = 0;
    for (const step of steps) {
        const move = chess.parse(where, step.san);
        if (!move) break;
        where = chess.move(where, move.from, move.to, move.promotion).fen;
        played++;
    }
    return played;
};

/** Hang a run of moves off a node, as far as it stays legal. */
game.graft = function (state, parent, steps, index) {
    let node = parent;
    let kept = 0;
    for (const step of steps) {
        const before = node.children.length;
        const child = game.playSan(state, node, step.san);
        if (!child) break;
        if (node === parent && index !== undefined && node.children.length > before) {
            parent.children.splice(parent.children.indexOf(child), 1);   // back where the branch was
            parent.children.splice(index, 0, child);
        }
        child.comment = step.comment || child.comment;
        node = child;
        kept++;
    }
    return kept;
};

/** The node `depth` moves down from a node's child at `index`. */
game.at = function (parent, index, depth) {
    let node = parent.children[index];
    for (let step = 1; node && step < depth; step++) node = node.children[0];
    return node || null;
};

/** A note against a move. An empty string takes it off again. */
game.annotate = function (state, node, text) {
    if (!node) return null;
    node.comment = String(text || '').replace(/[{}]/g, '').trim();
    return node;
};

/**
 * Make a variation the main line at its branch point - the way a player says
 * "this is the game, that was the try".
 */
game.promote = function (state, node) {
    if (!node || !node.parent) return null;
    const siblings = node.parent.children;
    siblings.splice(siblings.indexOf(node), 1);
    siblings.unshift(node);
    game.reline(state);
    return node;
};

/** Keep the shown line pointing at something that is still in the tree. */
game.reline = function (state) {
    const alive = function (node) {
        for (let step = node; step; step = step.parent) if (step === state.root) return true;
        return false;
    };
    if (!alive(state.current)) state.current = state.root;
    if (!alive(state.line)) state.line = state.root;
};

/* ---------- the move list as text ---------- */

/**
 * One ply to a line, numbered as a player writes it, with any note after it.
 *
 * One move per line is what makes the read-only text area usable as a list:
 * a line is a move, so the caret lands on one thing and only one thing.
 *
 * `hidden` blanks the moves after the current one - a puzzle is a position and
 * a solution, and showing the solution is the one thing a puzzle must not do
 * until it is asked.
 */
game.text = function (state, options) {
    const settings = options || {};
    const line = game.moves(settings.node || state.line);
    const rows = [];
    const upto = settings.hidden ? game.path(state.current).length - 1 : Infinity;

    for (let index = 0; index < line.length; index++) {
        const node = line[index];
        const label = game.numbered(node);
        if (index >= upto) rows.push(label + ' ?');
        else rows.push(label + ' ' + node.san + (node.comment ? '  {' + node.comment + '}' : '') +
            (node.parent.children.length > 1 ? '  (+' + (node.parent.children.length - 1) + ')' : ''));
    }
    return rows.join('\n');
};

/** Which move a caret at this offset in `game.text` is sitting on. */
game.rowAt = function (text, offset) {
    return String(text).slice(0, offset).split('\n').length - 1;
};

/* ---------- files ---------- */

/** The game as a PGN file, variations, comments and starting position and all. */
game.toPgn = function (state) {
    const tags = Object.assign({}, state.tags);
    if (state.start !== chess.START_FEN) {
        tags.SetUp = '1';
        tags.FEN = state.start;
    }
    if (state.puzzle) tags.Puzzle = '1';

    // The moves of a position's own line. A variation is written against the
    // move it replaces, which is why the alternatives to a move are read off
    // the position before it rather than off the move itself.
    const tokens = function (node) {
        const list = [];
        for (let where = node; where.children.length; where = where.children[0]) {
            const child = where.children[0];
            const token = { san: child.san, comment: child.comment, nags: [], variations: [] };
            for (let other = 1; other < where.children.length; other++) {
                token.variations.push(branch(where.children[other]));
            }
            list.push(token);
        }
        return list;
    };

    // A variation is a movetext that starts at a move rather than at a
    // position: its own first move, then whatever that move leads to.
    const branch = function (node) {
        return [{ san: node.san, comment: node.comment, nags: [], variations: [] }].concat(tokens(node));
    };

    return pgn.write(tags, tokens(state.root), {
        firstNumber: chess.moveNumberOf(state.start),
        firstIsBlack: chess.turnOf(state.start) === 'black'
    });
};

/**
 * A PGN file back into a game.
 *
 * Whatever will not play is left out and counted rather than thrown: a file
 * with one impossible move in a side line is still a game worth opening.
 */
game.fromPgn = function (text) {
    const read = pgn.parse(text);
    const start = read.tags.FEN && chess.playable(read.tags.FEN) ? read.tags.FEN : chess.START_FEN;
    const state = game.create(start, read.tags);
    state.puzzle = read.tags.Puzzle === '1';
    state.tags.Result = read.result;
    if (read.intro) state.root.comment = read.intro;

    let dropped = 0;
    const walk = function (node, tokens) {
        let where = node;
        for (const token of tokens) {
            const played = game.playSan(state, where, token.san);
            if (!played) { dropped++; break; }
            played.comment = token.comment || '';
            // Alternatives to the move just played, so they join `where` after
            // it and stay behind it in the list of children.
            for (const variation of token.variations) walk(where, variation);
            where = played;
        }
    };
    walk(state.root, read.moves);

    state.current = state.root;
    state.line = state.root;
    return { state: state, dropped: dropped };
};
