'use strict';

/**
 * The page: a board on the left, the game written out on the right.
 *
 * Everything that can be worked out without a screen has been - the rules are
 * in `chess.js`, the game in `game.js`, the geometry in `board.js` - so what
 * is left here is drawing and listening. `render` is the whole of the first:
 * it is called after anything at all changes and it redraws from the state,
 * rather than each handler patching the part of the page it knows about.
 *
 * The squares are a canvas and the pieces are an SVG over it. The canvas is
 * repainted on every change and never keeps anything; the SVG keeps the pieces
 * as elements, which is what lets one be dragged and lets the browser scale the
 * glyphs rather than us redrawing them at every size.
 */
const app = {
    state: null,
    flipped: false,
    mode: 'play',                  // play | edit | setup
    selected: null,                // the square a piece was picked up from
    hint: null,                    // what the engine last suggested
    timer: null,                   // the play-through
    brush: 'K',                    // the piece set-up is putting down
    setup: null,                   // { pieces, turn } while setting up
    side: 0,                       // the board, in pixels
    message: ''
};

const STORE = 'chestnut.pgn';

const page = {};
const find = function (id) { return document.getElementById(id); };

/* ---------- start ---------- */

function start() {
    for (const id of ['main', 'message', 'actions', 'board', 'squares', 'pieces', 'palette', 'palette_pieces',
        'variation', 'movetext', 'editbar', 'speed', 'level', 'turn', 'notation',
        'first', 'back', 'play', 'step', 'last', 'analyze', 'flip', 'setup', 'edit', 'puzzle',
        'new_game', 'load', 'save', 'file', 'setup_done', 'setup_clear', 'setup_standard',
        'up', 'down', 'add', 'del', 'note', 'main_line', 'reveal']) {
        page[id] = find(id);
    }

    app.state = restore() || game.create();

    wire();
    buildPalette();
    resize();
    watch();
    say(app.state.puzzle ? 'Puzzle. ' + turnName(app.state.current.fen) + ' to play.'
        : 'New game. White to play.');
    render();
}

/* ---------- the message bar ---------- */

function say(text) {
    app.message = text;
    if (page.message) page.message.textContent = text;
}

function turnName(fen) {
    return chess.turnOf(fen) === 'white' ? 'White' : 'Black';
}

/** What the position itself has to say, once a move has been made on it. */
function report(node) {
    const position = chess.read(node.fen);
    if (position.mate) return 'Checkmate. ' + (position.turn === 'white' ? 'Black' : 'White') + ' wins.';
    if (position.stalemate) return 'Stalemate. The game is drawn.';
    if (position.check) return turnName(node.fen) + ' is in check.';
    return turnName(node.fen) + ' to play.';
}

/* ---------- drawing ---------- */

function render() {
    drawSquares();
    drawPieces();
    drawNotation();
    drawControls();
}

function drawSquares() {
    const canvas = page.squares;
    const side = app.side;
    if (!side || !canvas.getContext) return;

    const ratio = window.devicePixelRatio || 1;
    canvas.width = side * ratio;
    canvas.height = side * ratio;
    const paint = canvas.getContext('2d');
    paint.setTransform(ratio, 0, 0, ratio, 0, 0);

    const style = getComputedStyle(document.documentElement);
    const colour = function (name) { return style.getPropertyValue(name).trim(); };
    const field = board.field(side);

    paint.clearRect(0, 0, side, side);
    paint.fillStyle = colour('--board-frame');
    paint.fillRect(0, 0, side, side);

    for (const square of chess.squares) {
        const rect = board.rect(square, side, app.flipped);
        paint.fillStyle = colour(board.isLight(square) ? '--light-square' : '--dark-square');
        paint.fillRect(rect.x, rect.y, rect.size + 0.5, rect.size + 0.5);
    }

    // What can be reached from the square that is held, drawn under the
    // pieces: a dot on an empty square, a ring around a piece to be taken.
    if (app.selected && app.mode !== 'setup') {
        const position = chess.read(app.state.current.fen);
        const rect = board.rect(app.selected, side, app.flipped);
        paint.fillStyle = colour('--held');
        paint.fillRect(rect.x, rect.y, rect.size, rect.size);

        paint.fillStyle = colour('--target');
        paint.strokeStyle = colour('--target');
        paint.lineWidth = Math.max(2, field.cell * 0.06);
        for (const to of chess.destinations(position, app.selected)) {
            const middle = board.centre(to, side, app.flipped);
            paint.beginPath();
            if (position.pieces[to]) {
                paint.arc(middle.x, middle.y, field.cell * 0.42, 0, Math.PI * 2);
                paint.stroke();
            } else {
                paint.arc(middle.x, middle.y, field.cell * 0.14, 0, Math.PI * 2);
                paint.fill();
            }
        }
    }

    // The move that led to the position on the board, so a game being
    // stepped through says where it just went.
    const node = app.state.current;
    if (node.from && app.mode !== 'setup') {
        paint.fillStyle = colour('--played');
        for (const square of [node.from, node.to]) {
            const rect = board.rect(square, side, app.flipped);
            paint.fillRect(rect.x, rect.y, rect.size, rect.size);
        }
    }

    paint.fillStyle = colour('--muted');
    paint.font = Math.round(field.margin * 0.8) + 'px system-ui, sans-serif';
    paint.textAlign = 'center';
    paint.textBaseline = 'middle';
    for (const label of board.labels(side, app.flipped)) {
        paint.fillText(label.text, label.x, label.y);
    }

    if (app.hint) drawArrow(paint, app.hint);
}

function drawArrow(paint, move) {
    const style = getComputedStyle(document.documentElement);
    const line = board.arrow(move.from, move.to, app.side, app.flipped);
    paint.strokeStyle = style.getPropertyValue('--hint').trim();
    paint.fillStyle = paint.strokeStyle;
    paint.lineWidth = line.width;
    paint.lineCap = 'round';
    paint.beginPath();
    paint.moveTo(line.x1, line.y1);
    paint.lineTo(line.x2, line.y2);
    paint.stroke();

    const angle = Math.atan2(line.y2 - line.y1, line.x2 - line.x1);
    paint.beginPath();
    paint.moveTo(line.x2 + Math.cos(angle) * line.head, line.y2 + Math.sin(angle) * line.head);
    paint.lineTo(line.x2 + Math.cos(angle + 2.5) * line.head, line.y2 + Math.sin(angle + 2.5) * line.head);
    paint.lineTo(line.x2 + Math.cos(angle - 2.5) * line.head, line.y2 + Math.sin(angle - 2.5) * line.head);
    paint.closePath();
    paint.fill();
}

function drawPieces() {
    const svg = page.pieces;
    const side = app.side;
    if (!side) return;
    svg.setAttribute('viewBox', '0 0 ' + side + ' ' + side);

    const pieces = app.mode === 'setup' ? app.setup.pieces : chess.pieces(app.state.current.fen);
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    const cell = board.field(side).cell;
    for (const square of chess.squares) {
        const piece = pieces[square];
        if (!piece) continue;
        const middle = board.centre(square, side, app.flipped);
        const glyph = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        glyph.setAttribute('x', middle.x);
        glyph.setAttribute('y', middle.y);
        glyph.setAttribute('class', 'piece ' + chess.colourOf(piece));
        glyph.setAttribute('font-size', cell * 0.82);
        glyph.setAttribute('data-square', square);
        glyph.textContent = board.glyph(piece);
        svg.appendChild(glyph);
    }
}

function drawNotation() {
    const state = app.state;
    const hidden = state.puzzle && app.mode !== 'edit';
    const text = game.text(state, { hidden: hidden });
    page.movetext.value = text;

    const lines = game.lines(state);
    page.variation.innerHTML = '';
    for (const line of lines) {
        const option = document.createElement('option');
        option.value = String(line.node.id);
        option.textContent = line.label;
        page.variation.appendChild(option);
    }
    page.variation.value = String(state.line.id);
    page.variation.disabled = lines.length < 2;

    // The caret marks the move the board is showing: a read-only text area
    // has no other way to point at one of its lines.
    const line = game.moves(state.line);
    const at = line.indexOf(state.current);
    if (at >= 0 && !hidden) {
        const rows = text.split('\n');
        let start = 0;
        for (let index = 0; index < at; index++) start += rows[index].length + 1;
        page.movetext.setSelectionRange(start, start + (rows[at] || '').length);
    }
}

function drawControls() {
    page.play.textContent = app.timer ? '❚❚' : '▶';
    page.play.setAttribute('aria-pressed', app.timer ? 'true' : 'false');
    page.edit.setAttribute('aria-pressed', app.mode === 'edit' ? 'true' : 'false');
    page.setup.setAttribute('aria-pressed', app.mode === 'setup' ? 'true' : 'false');
    page.puzzle.setAttribute('aria-pressed', app.state.puzzle ? 'true' : 'false');
    page.editbar.hidden = app.mode !== 'edit';
    page.palette.hidden = app.mode !== 'setup';
    page.reveal.hidden = !app.state.puzzle || app.mode === 'edit';
    document.body.classList.toggle('setting-up', app.mode === 'setup');
}

/* ---------- size ---------- */

/**
 * The board is a square as tall as the row it sits in, and the move list is
 * given the same height - which is the layout asked for, and the reason the
 * pixel size is worked out here rather than left to the stylesheet: the canvas
 * needs a number.
 *
 * The row is measured rather than guessed at, because the header is what is
 * left over from: its buttons wrap onto a second line on a narrow window, and
 * the board has to give that line back. `watch` is what notices - a window
 * resize is not the only way the row changes size, and a board sized against a
 * row that has since shrunk is a board drawn over the buttons.
 */
function resize() {
    const room = page.main.getBoundingClientRect();
    if (!room.width || !room.height) return;              // not laid out yet
    const wide = room.width > room.height * 1.25;

    // In set-up the palette sits under the board and wants its share of the row.
    const palette = app.mode === 'setup' ? (page.palette.getBoundingClientRect().height || 0) + 8 : 0;
    const tall = room.height - palette;
    // Side by side the move list wants a column beside the board; stacked, it
    // wants a few lines under it.
    const side = wide
        ? Math.min(tall, room.width - 260)
        : Math.min(room.width, tall - 180);

    const wanted = Math.max(120, Math.floor(side));
    if (wanted === app.side) return;                      // nothing moved

    app.side = wanted;
    page.board.style.width = app.side + 'px';
    page.board.style.height = app.side + 'px';
    page.notation.style.height = wide ? app.side + 'px' : 'auto';
    page.squares.style.width = app.side + 'px';
    page.squares.style.height = app.side + 'px';
    render();
}

/** Follow the row the board sits in, however it came to change size. */
function watch() {
    window.addEventListener('resize', resize);
    if (typeof ResizeObserver === 'function') new ResizeObserver(resize).observe(page.main);
}

/* ---------- the board ---------- */

function squareUnder(event) {
    const box = page.board.getBoundingClientRect();
    return board.at(event.clientX - box.left, event.clientY - box.top, app.side, app.flipped);
}

function onBoard(event) {
    const square = squareUnder(event);
    if (!square) return;
    event.preventDefault();

    if (app.mode === 'setup') {
        if (app.brush) app.setup.pieces[square] = app.brush;
        else delete app.setup.pieces[square];
        render();
        return;
    }

    const position = chess.read(app.state.current.fen);
    if (app.selected && chess.legal(position, app.selected, square)) {
        playMove(app.selected, square);
        app.selected = null;
    } else if (position.moves[square]) {
        app.selected = app.selected === square ? null : square;
    } else {
        app.selected = null;
    }
    render();
}

/**
 * A move made on the board joins the game where it stands: as the next move
 * when there is none, and as a variation when there is one and it is not
 * this. Nothing is ever overwritten by a piece being pushed.
 */
function playMove(from, to) {
    const state = app.state;
    const parent = state.current;
    let promotion = null;
    if (chess.promotionOf(chess.read(parent.fen), from, to)) promotion = askPromotion();

    const before = parent.children.length;
    const node = game.play(state, parent, from, to, promotion);
    if (!node) { say('That is not a legal move.'); return; }

    stop();
    app.hint = null;
    if (state.line === parent || game.moves(state.line).indexOf(node) === -1) state.line = node;
    const branched = before > 0 && parent.children.length > before;
    say((branched ? 'A variation: ' : '') + game.numbered(node) + ' ' + node.san + '. ' + report(node));
    keep();
    render();
}

function askPromotion() {
    const answer = (window.prompt('Promote to Q, R, B or N?', 'Q') || 'Q').trim().toUpperCase();
    return chess.PROMOTIONS.indexOf(answer) === -1 ? 'Q' : answer;
}

/* ---------- stepping and playing through ---------- */

function step(forward) {
    const state = app.state;
    const line = game.moves(state.line);
    const at = line.indexOf(state.current);
    const next = forward ? (at === -1 ? line[0] : line[at + 1]) : state.current.parent;
    if (!next) { if (forward) stop(); return false; }

    state.current = next;
    app.selected = null;
    app.hint = null;
    say(next.san ? game.numbered(next) + ' ' + next.san + (next.comment ? '  ' + next.comment : '') + '. ' + report(next)
        : 'The starting position. ' + turnName(next.fen) + ' to play.');
    render();
    return true;
}

function toEnd(end) {
    const state = app.state;
    const line = game.moves(state.line);
    state.current = end ? (line[line.length - 1] || state.root) : state.root;
    app.selected = null;
    app.hint = null;
    say(end ? 'The end of the line. ' + report(state.current) : 'The starting position.');
    render();
}

function playThrough() {
    if (app.timer) { stop(); return; }
    const beat = Number(page.speed.value) || 1000;
    app.timer = window.setInterval(function () { if (!step(true)) stop(); }, beat);
    drawControls();
    step(true);
}

function stop() {
    if (app.timer) window.clearInterval(app.timer);
    app.timer = null;
    drawControls();
}

/* ---------- the move list ---------- */

function onMovetext() {
    if (app.state.puzzle && app.mode !== 'edit') return;
    const row = game.rowAt(page.movetext.value, page.movetext.selectionStart);
    const node = game.moves(app.state.line)[row];
    if (!node || node === app.state.current) return;
    stop();
    app.state.current = node;
    app.selected = null;
    app.hint = null;
    say(game.numbered(node) + ' ' + node.san + '. ' + report(node));
    render();
}

function onVariation() {
    const wanted = Number(page.variation.value);
    const line = game.lines(app.state).filter(function (one) { return one.node.id === wanted; })[0];
    if (!line) return;
    stop();
    app.state.line = line.node;
    app.state.current = line.node;
    say(page.variation.options[page.variation.selectedIndex].textContent + '.');
    render();
}

/* ---------- editing ---------- */

function edited(result, what) {
    if (!result) { say('That edit would not stand on the board.'); return; }
    const also = result.reply ? 1 : 0;             // the reply went too, to keep the colours right
    const rest = result.dropped - also;
    say(what + (also ? ' and the reply to it' : '') + '. ' + (rest
        ? rest + ' later move' + (rest === 1 ? '' : 's') + ' would not play and were dropped.'
        : 'The rest of the line still plays.'));
    keep();
    render();
}

function onAdd() {
    const answer = window.prompt('Move to add, in notation (e4, Nf3, O-O):', '');
    if (!answer) return;
    const node = game.playSan(app.state, app.state.current, answer.trim());
    if (!node) { say('There is no move ' + answer.trim() + ' in this position.'); return; }
    app.state.line = node;
    say('Added ' + game.numbered(node) + ' ' + node.san + '. ' + report(node));
    keep();
    render();
}

function onDelete() {
    const node = app.state.current;
    if (!node.parent) { say('The starting position is not a move.'); return; }
    edited(game.remove(app.state, node), 'Took out ' + node.san);
}

function onNote() {
    const node = app.state.current;
    if (!node.parent) { say('Notes go against a move.'); return; }
    const answer = window.prompt('A note against ' + node.san + ':', node.comment || '');
    if (answer === null) return;
    game.annotate(app.state, node, answer);
    say(answer.trim() ? 'Noted against ' + node.san + '.' : 'The note on ' + node.san + ' is gone.');
    keep();
    render();
}

function onMainLine() {
    const node = app.state.current;
    if (!node.parent || node.parent.children[0] === node) { say('This is already the main line here.'); return; }
    game.promote(app.state, node);
    app.state.line = node;
    say(node.san + ' is the main line now.');
    keep();
    render();
}

/* ---------- set-up ---------- */

function buildPalette() {
    page.palette_pieces.innerHTML = '';
    for (const piece of board.PALETTE.concat([''])) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'brush' + (piece && chess.colourOf(piece) === 'white' ? ' white' : ' black');
        button.textContent = piece ? board.glyph(piece) : '␡';
        button.title = piece ? piece : 'Clear a square';
        button.setAttribute('aria-label', piece ? piece : 'Clear a square');
        button.addEventListener('click', function () {
            app.brush = piece;
            for (const other of page.palette_pieces.children) other.classList.remove('held');
            button.classList.add('held');
        });
        if (piece === app.brush) button.classList.add('held');
        page.palette_pieces.appendChild(button);
    }
}

function enterSetup() {
    stop();
    app.mode = 'setup';
    app.selected = null;
    app.hint = null;
    app.setup = { pieces: chess.pieces(app.state.current.fen), turn: chess.turnOf(app.state.current.fen) };
    page.turn.value = app.setup.turn;
    say('Set the board: pick a piece, then a square. The game starts again from what you leave.');
    render();
    resize();                       // the palette wants its share of the row
}

function leaveSetup(keepIt) {
    if (!keepIt) {
        app.mode = 'play';
        app.setup = null;
        say('The board is as it was.');
        render();
        resize();
        return;
    }

    const fen = chess.compose(app.setup.pieces, page.turn.value);
    if (!chess.playable(fen)) { say('A game needs one king of each colour.'); return; }

    const tags = Object.assign({}, app.state.tags);
    const puzzle = app.state.puzzle;
    app.state = game.create(fen, tags);
    app.state.puzzle = puzzle;
    app.mode = 'play';
    app.setup = null;
    say('The board is set. ' + turnName(fen) + ' to play' + (puzzle ? ', and this is the puzzle.' : '.'));
    keep();
    render();
    resize();
}

/* ---------- the engine's opinion ---------- */

function analyze() {
    const fen = app.state.current.fen;
    say('Thinking...');
    // Let the message land before the engine takes the thread.
    window.setTimeout(function () {
        const best = chess.best(fen, Number(page.level.value));
        app.hint = best;
        if (!best) say('Nothing to find: the game is over in this position.');
        else say('The engine would play ' + best.san + ' for ' + turnName(fen).toLowerCase() +
            '. Play it on the board to take it.');
        render();
    }, 20);
}

/* ---------- puzzles ---------- */

function togglePuzzle() {
    app.state.puzzle = !app.state.puzzle;
    app.state.current = app.state.puzzle ? app.state.root : app.state.current;
    say(app.state.puzzle
        ? 'Puzzle. The moves are hidden - solve it on the board, or reveal them one at a time.'
        : 'Not a puzzle any more: the whole line is shown.');
    keep();
    render();
}

function reveal() {
    step(true);
}

/* ---------- files and keeping ---------- */

function keep() {
    try { window.localStorage.setItem(STORE, game.toPgn(app.state)); } catch (error) { /* private mode */ }
}

function restore() {
    let text;
    try { text = window.localStorage.getItem(STORE); } catch (error) { return null; }
    if (!text) return null;
    try { return game.fromPgn(text).state; } catch (error) { return null; }
}

function save() {
    const text = game.toPgn(app.state);
    const blob = new Blob([text], { type: 'application/x-chess-pgn' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = (app.state.tags.Event || 'chestnut').replace(/\W+/g, '-').toLowerCase() + '.pgn';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(function () { URL.revokeObjectURL(link.href); }, 1000);
    say('Saved as ' + link.download + '.');
}

function load(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function () {
        let read;
        try { read = game.fromPgn(String(reader.result)); } catch (error) { read = null; }
        if (!read || !game.moves(read.state.root).length) {
            say('Nothing in ' + file.name + ' read as a game.');
            return;
        }
        stop();
        app.state = read.state;
        app.mode = 'play';
        app.hint = null;
        app.selected = null;
        const moves = game.moves(app.state.root).length;
        say(file.name + ': ' + moves + ' move' + (moves === 1 ? '' : 's') +
            (read.dropped ? ', and ' + read.dropped + ' that would not play' : '') + '.');
        keep();
        render();
    };
    reader.readAsText(file);
}

function newGame() {
    stop();
    app.state = game.create();
    app.mode = 'play';
    app.selected = null;
    app.hint = null;
    say('New game. White to play.');
    keep();
    render();
}

/* ---------- listening ---------- */

function wire() {
    page.board.addEventListener('pointerdown', onBoard);
    page.movetext.addEventListener('click', onMovetext);
    page.movetext.addEventListener('keyup', onMovetext);
    page.variation.addEventListener('change', onVariation);

    page.first.addEventListener('click', function () { stop(); toEnd(false); });
    page.back.addEventListener('click', function () { stop(); step(false); });
    page.play.addEventListener('click', playThrough);
    page.step.addEventListener('click', function () { stop(); step(true); });
    page.last.addEventListener('click', function () { stop(); toEnd(true); });
    page.analyze.addEventListener('click', analyze);
    page.flip.addEventListener('click', function () { app.flipped = !app.flipped; render(); });
    page.puzzle.addEventListener('click', togglePuzzle);
    page.reveal.addEventListener('click', reveal);
    page.new_game.addEventListener('click', newGame);
    page.save.addEventListener('click', save);
    page.load.addEventListener('click', function () { page.file.click(); });
    page.file.addEventListener('change', function () { load(page.file.files[0]); page.file.value = ''; });

    page.edit.addEventListener('click', function () {
        if (app.mode === 'setup') leaveSetup(false);
        app.mode = app.mode === 'edit' ? 'play' : 'edit';
        say(app.mode === 'edit'
            ? 'Editing: pick a move in the list, then move it, take it out or note it.'
            : 'Done editing.');
        render();
    });
    page.setup.addEventListener('click', function () {
        if (app.mode === 'setup') leaveSetup(false); else enterSetup();
    });
    page.setup_done.addEventListener('click', function () { leaveSetup(true); });
    page.setup_clear.addEventListener('click', function () {
        app.setup.pieces = {};
        say('An empty board. Put down a king of each colour at least.');
        render();
    });
    page.setup_standard.addEventListener('click', function () {
        app.setup.pieces = chess.pieces(chess.START_FEN);
        page.turn.value = 'white';
        render();
    });
    page.turn.addEventListener('change', function () { app.setup.turn = page.turn.value; });

    page.up.addEventListener('click', function () {
        const node = app.state.current;
        edited(node.parent ? game.shift(app.state, node, -1) : null, 'Moved ' + node.san + ' up');
    });
    page.down.addEventListener('click', function () {
        const node = app.state.current;
        edited(node.parent ? game.shift(app.state, node, 1) : null, 'Moved ' + node.san + ' down');
    });
    page.add.addEventListener('click', onAdd);
    page.del.addEventListener('click', onDelete);
    page.note.addEventListener('click', onNote);
    page.main_line.addEventListener('click', onMainLine);

    // The move list takes its own keys - the caret is how it points at a move -
    // so the page only listens for these when nothing else has the focus.
    document.addEventListener('keydown', function (event) {
        const tag = event.target.tagName;
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
        if (event.key === 'ArrowRight') { stop(); step(true); }
        else if (event.key === 'ArrowLeft') { stop(); step(false); }
        else if (event.key === 'Home') { stop(); toEnd(false); }
        else if (event.key === 'End') { stop(); toEnd(true); }
        else if (event.key === ' ') { event.preventDefault(); playThrough(); }
        else if (event.key === 'f') { app.flipped = !app.flipped; render(); }
    });
}

if (!document.createElement('canvas').getContext || !chess.lib) {
    window.location.replace('./error.html');
} else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
} else {
    start();
}

if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
        navigator.serviceWorker.register('./sw.js').catch(function () { /* offline is a bonus */ });
    });
}
