'use strict';

/**
 * The page: the cards, the loop, and the wiring between the pad and the game.
 *
 * There is nothing on this page but a canvas. Every word the game says is drawn
 * on it out of the matrix font - the welcome, the table, the game over, the
 * score along the top - so there is no HTML to keep in step with the game and
 * nothing that can be styled out of place.
 *
 * There is no menu either. Between games the cards come round on their own, a
 * few seconds each, and Start is the only thing to press. The one screen that
 * waits for the player is the three letters asked for by a score in the top
 * five, and that is spelt out on the stick.
 */

const app = {
    screen: 'welcome',       // welcome, scores, over, initials, playing
    rotation: screens.ATTRACT,
    at: 0,
    dwell: screens.DWELL,
    state: null,
    reader: input.create(),
    keys: new Set(),
    table: [],
    pad: false,              // whether a pad is in the player's hands
    pressing: [],            // and what is down on it, for the welcome card
    last: null,              // what the game just finished came to
    entry: null,             // the three letters, while they are being spelt
    density: 1,
    last_frame: 0,
    clock: 0,                // ms since the page was opened, for anything blinking
    paused: false,
    ending: 0,
    best: 0,
    field: null
};

app.END = 700;               // ms the wreck is left on screen before the card comes up
app.LONGEST = 0.05;          // the longest step the game is ever moved by, in seconds

/** The canvas, and the world under it, made to fit the window. */
function fit() {
    const width = Math.max(320, window.innerWidth);
    const height = Math.max(320, window.innerHeight);
    app.density = render.fit(app.field, width, height, window.devicePixelRatio || 1);
    if (app.state) game.resize(app.state, width, height);
}

/** The size of the window, which is the size of everything. */
function view() {
    return app.state ? app.state.world.view
        : { width: Math.max(320, window.innerWidth), height: Math.max(320, window.innerHeight) };
}

/** The store the scores live in, or a pocket one when the browser has none. */
function store() {
    try {
        if (window.localStorage) return window.localStorage;
    } catch (ignored) {
        // Site data turned off. The table then lasts as long as the page does.
    }
    if (!app.pocket) {
        const kept = {};
        app.pocket = {
            getItem: key => (key in kept ? kept[key] : null),
            setItem: (key, value) => { kept[key] = String(value); }
        };
    }
    return app.pocket;
}

/**
 * Puts a card up, and sets the clock that will take it down again.
 *
 * The rotation is what comes round between games: the welcome and the table
 * before the first one, and the game over card with them after it. `playing`
 * and `initials` are not in any rotation - one is the game and the other is
 * waiting on the player - so they simply sit there until something happens.
 */
function turn(rotation, at) {
    app.rotation = rotation;
    app.at = ((at || 0) % rotation.length + rotation.length) % rotation.length;
    app.screen = rotation[app.at];
    app.dwell = screens.DWELL;
    if (app.screen === 'scores') app.table = scores.read(store());
}

/** The next card in the rotation. */
function next() {
    turn(app.rotation, app.at + 1);
}

/** A new game. */
function play() {
    app.state = game.create(Math.max(320, window.innerWidth), Math.max(320, window.innerHeight));
    app.screen = 'playing';
    app.ending = 0;
    app.paused = false;
    app.entry = null;
    // Read once, here: the HUD draws it on every frame and it cannot change
    // until this game is over.
    app.best = scores.best(store());
}

/**
 * The end of a game.
 *
 * A score good enough for the top five is asked for three letters before it
 * goes in the table; anything else goes in as it stands and the game over card
 * comes straight up.
 */
function finish() {
    const score = app.state.score;
    const place = scores.would(scores.read(store()), score);

    if (place && place <= screens.TOP) {
        app.screen = 'initials';
        app.entry = { letters: ['A', 'A', 'A'], at: 0, score: score, place: place };
        return;
    }
    record(score, null);
}

/** The score goes in the table, and the game over card says where it came. */
function record(score, who) {
    const table = scores.add(store(), score, new Date().toISOString(), who);
    app.table = table;
    app.last = { score: score, place: scores.place(table, score), of: table.length };
    app.entry = null;
    turn(screens.AFTER, 0);
}

/**
 * Spelling the three letters.
 *
 * Up and down turn the letter, left and right walk between them, A sets one
 * and moves on - and A on the last of the three is done with it, the way a
 * cabinet has always done it. Start is done with it wherever the mark is.
 */
function spell(intent) {
    const entry = app.entry;
    if (intent.up || intent.down) {
        const at = screens.LETTERS.indexOf(entry.letters[entry.at]);
        const step = intent.up ? -1 : 1;
        const next_letter = (at + step + screens.LETTERS.length) % screens.LETTERS.length;
        entry.letters[entry.at] = screens.LETTERS[next_letter];
    }
    if (intent.left) entry.at = Math.max(0, entry.at - 1);
    if (intent.right) entry.at = Math.min(2, entry.at + 1);

    if (intent.start || (intent.confirm && entry.at === 2)) {
        record(entry.score, entry.letters.join(''));
    } else if (intent.confirm) {
        entry.at += 1;
    }
}

/** A letter typed rather than spelt out on a stick. */
function typed(key) {
    if (!app.entry) return false;
    if (key === 'backspace') {
        app.entry.at = Math.max(0, app.entry.at - 1);
        return true;
    }
    if (key.length !== 1 || screens.LETTERS.indexOf(key.toUpperCase()) < 0) return false;
    app.entry.letters[app.entry.at] = key.toUpperCase();
    if (app.entry.at < 2) app.entry.at += 1;
    return true;
}

/**
 * One turn of the loop.
 *
 * The pad is read whatever is on the screen. When a game is being played the
 * step is clamped: a tab left in the background comes back with a gap of
 * minutes in it, and moving everything by minutes in one step would put the
 * rocket through a wall and every foe on top of it.
 */
function loop(now) {
    window.requestAnimationFrame(loop);

    const seconds = Math.min(app.LONGEST, (now - app.last_frame) / 1000 || 0);
    app.last_frame = now;
    app.clock += seconds * 1000;

    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const intent = input.read(app.reader, pads, app.keys);
    app.pad = intent.pad;
    app.pressing = intent.pressing;

    if (app.screen === 'playing') {
        // Start on the pad, Back on the pad, Escape on the keyboard: all three
        // arrive here as one press and are answered in one place. Answering
        // Escape in the key listener as well would hold the game and let it go
        // again in the same breath.
        if (intent.start || intent.back) hold(!app.paused);
        if (!app.paused && !app.state.over) game.step(app.state, seconds, intent);
        else if (app.state.over) game.fade(app.state, seconds);
        if (app.state.over && (app.ending += seconds * 1000) > app.END) finish();
    } else if (app.screen === 'initials') {
        spell(intent);
    } else {
        if (intent.start || intent.confirm) play();
        else if ((app.dwell -= seconds * 1000) <= 0) next();
    }

    draw();
}

/** The field, and whatever is written over it. */
function draw() {
    const paint = brush();
    const size = view();

    if (app.state) render.frame(paint, app.state, app.density);
    paint.setTransform(app.density, 0, 0, app.density, 0, 0);

    if (app.screen === 'playing') {
        screens.hud(paint, app.state, app.best, size);
        if (app.paused) {
            screens.wash(paint, size, 0.72);
            screens.paint(paint, screens.paused(), size, app.clock);
        }
    } else {
        screens.wash(paint, size, 0.86);
        screens.paint(paint, screens.card(app.screen, app), size, app.clock);
    }
    paint.setTransform(1, 0, 0, 1, 0, 0);
}

/** Held, or let go again. */
function hold(paused) {
    app.paused = paused;
}

function brush() {
    if (!app.paint) app.paint = app.field.getContext('2d');
    return app.paint;
}

/** The keys, held in a set: the same shape the pad's buttons arrive in. */
function watchKeys() {
    window.addEventListener('keydown', function (event) {
        const key = event.key.toLowerCase();
        // A key held down repeats, and a repeating Escape would hold the game
        // and let it go again forty times a second.
        const again = app.keys.has(key) || event.repeat;
        app.keys.add(key);
        // The game is played on these, and a page that scrolls under the player
        // while they fly is a page that has taken the controls away.
        if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) event.preventDefault();
        if (app.screen === 'initials' && !again) typed(key);
    });
    window.addEventListener('keyup', function (event) { app.keys.delete(event.key.toLowerCase()); });
    window.addEventListener('blur', function () { app.keys.clear(); if (app.screen === 'playing') hold(true); });
    document.addEventListener('visibilitychange', function () {
        if (document.hidden && app.screen === 'playing') hold(true);
    });
}

function start() {
    app.field = document.getElementById('field');
    fit();
    // A world to look at behind the cards: the same dots the game is played
    // over, with the rocket sitting in the middle of them, dimmed by the wash
    // the card is written on.
    app.state = game.create(Math.max(320, window.innerWidth), Math.max(320, window.innerHeight));
    turn(screens.ATTRACT, 0);

    window.addEventListener('resize', fit);
    window.addEventListener('orientationchange', fit);
    watchKeys();

    window.requestAnimationFrame(function (now) { app.last_frame = now; loop(now); });
}

if (!document.createElement('canvas').getContext) {
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
