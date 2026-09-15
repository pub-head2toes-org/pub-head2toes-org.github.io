'use strict';

/**
 * The page: the screens, the loop, and the wiring between the pad and the game.
 *
 * Everything the player sees that is not the game itself is a plain HTML
 * section lying over the canvas - the welcome, the table of scores, the game
 * over. They are shown and hidden; nothing is built at run time, so what the
 * markup says is what there is.
 *
 * There is one loop and it never stops. It runs on the menus too, because the
 * pad is read in it: a menu that only listened for clicks would be a menu you
 * had to put the pad down to get out of.
 */

const app = {
    screen: 'welcome',
    state: null,
    reader: input.create(),
    keys: new Set(),
    density: 1,
    last: 0,
    paused: false,
    ending: 0,
    best: 0,
    page: {}
};

app.END = 700;               // ms the wreck is left on screen before the score goes up
app.LONGEST = 0.05;          // the longest step the game is ever moved by, in seconds

/** Every element the page talks to, found once. */
function collect() {
    for (const id of ['field', 'hud', 'score', 'best', 'bombs', 'paused', 'welcome', 'scores',
        'over', 'table', 'final', 'place', 'play', 'high', 'home', 'again', 'back', 'pad']) {
        app.page[id] = document.getElementById(id);
    }
}

/** The canvas, and the world under it, made to fit the window. */
function fit() {
    const width = Math.max(320, window.innerWidth);
    const height = Math.max(320, window.innerHeight);
    app.density = render.fit(app.page.field, width, height, window.devicePixelRatio || 1);
    if (app.state) game.resize(app.state, width, height);
}

/** Which screen is up. The canvas is always there, behind whichever it is. */
function show(screen) {
    app.screen = screen;
    for (const name of ['welcome', 'scores', 'over']) {
        app.page[name].hidden = name !== screen;
    }
    app.page.hud.hidden = screen !== 'playing';
    app.page.paused.hidden = true;
    if (screen !== 'playing') app.paused = false;
    focusFirst();
}

/** The buttons on the screen that is up, in the order a stick walks them. */
function buttons() {
    const screen = app.page[app.screen];
    return screen && !screen.hidden ? Array.from(screen.querySelectorAll('button')) : [];
}

function focusFirst() {
    const found = buttons();
    if (found.length) found[0].focus();
}

/** The stick walks the buttons; A presses the one it is standing on. */
function walk(way) {
    const found = buttons();
    if (!found.length) return;
    const at = found.indexOf(document.activeElement);
    const next = at < 0 ? 0 : (at + way + found.length) % found.length;
    found[next].focus();
}

/** A new game. */
function play() {
    app.state = game.create(Math.max(320, window.innerWidth), Math.max(320, window.innerHeight));
    app.ending = 0;
    app.paused = false;
    // Read once, here. The HUD shows it on every frame, and reading and parsing
    // the table sixty times a second to draw a number that cannot change until
    // the game is over would be sixty times too many.
    app.best = scores.best(store());
    say();
    show('playing');
    app.page.field.focus();
}

/** The score and the rack, written out only when they have changed. */
function say() {
    const state = app.state;
    if (!state) return;
    const score = String(state.score);
    if (app.page.score.textContent !== score) app.page.score.textContent = score;
    const bombs = '◆'.repeat(state.bombs) + '◇'.repeat(Math.max(0, weapons.EMP - state.bombs));
    if (app.page.bombs.textContent !== bombs) app.page.bombs.textContent = bombs;
    const best = String(Math.max(app.best, state.score));
    if (app.page.best.textContent !== best) app.page.best.textContent = best;
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

/** The table of scores, as rows. */
function table() {
    const kept = scores.read(store());
    app.page.table.innerHTML = '';
    if (!kept.length) {
        const empty = document.createElement('p');
        empty.className = 'empty';
        empty.textContent = 'No scores yet. The grinder is waiting.';
        app.page.table.appendChild(empty);
        return kept;
    }
    const list = document.createElement('ol');
    for (const row of kept) {
        const item = document.createElement('li');
        const score = document.createElement('span');
        score.className = 'points';
        score.textContent = String(row.score);
        const when = document.createElement('span');
        when.className = 'when';
        when.textContent = row.at ? String(row.at).slice(0, 10) : '';
        item.appendChild(score);
        item.appendChild(when);
        list.appendChild(item);
    }
    app.page.table.appendChild(list);
    return kept;
}

/** The end: the score goes in the table and the game over screen says where. */
function over() {
    const score = app.state.score;
    const kept = scores.add(store(), score, new Date().toISOString());
    const place = scores.place(kept, score);

    app.page.final.textContent = String(score);
    app.page.place.textContent = place === 1 ? 'A new best.'
        : place ? 'Number ' + place + ' of ' + kept.length + '.'
        : 'Not one for the table.';
    show('over');
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

    const seconds = Math.min(app.LONGEST, (now - app.last) / 1000 || 0);
    app.last = now;

    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const intent = input.read(app.reader, pads, app.keys);
    if (app.page.pad.hidden === intent.pad) app.page.pad.hidden = !intent.pad;

    if (app.screen === 'playing') {
        if (intent.start || (intent.pad && intent.back)) hold(!app.paused);
        if (!app.paused && !app.state.over) game.step(app.state, seconds, intent);
        else if (app.state.over) game.fade(app.state, seconds);
        say();
        if (app.state.over && (app.ending += seconds * 1000) > app.END) over();
    } else if (intent.pad) {
        if (intent.up) walk(-1);
        if (intent.down) walk(1);
        if (intent.confirm && document.activeElement && document.activeElement.click) document.activeElement.click();
        if (intent.back && app.screen !== 'welcome') show('welcome');
    }

    if (app.state) render.frame(paint(), app.state, app.density);
}

/** Held, or let go again. */
function hold(paused) {
    app.paused = paused;
    app.page.paused.hidden = !paused;
}

function paint() {
    if (!app.brush) app.brush = app.page.field.getContext('2d');
    return app.brush;
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
        if (app.screen === 'playing' && [' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) {
            event.preventDefault();
        }
        if (key === 'escape' && !again && app.screen === 'playing') hold(!app.paused);
    });
    window.addEventListener('keyup', function (event) { app.keys.delete(event.key.toLowerCase()); });
    window.addEventListener('blur', function () { app.keys.clear(); if (app.screen === 'playing') hold(true); });
    document.addEventListener('visibilitychange', function () {
        if (document.hidden && app.screen === 'playing') hold(true);
    });
}

function start() {
    collect();
    fit();
    // A world to look at behind the welcome screen: the same dots the game is
    // played over, with the rocket sitting in the middle of them.
    app.state = game.create(Math.max(320, window.innerWidth), Math.max(320, window.innerHeight));
    show('welcome');

    app.page.play.addEventListener('click', play);
    app.page.again.addEventListener('click', play);
    app.page.high.addEventListener('click', function () { table(); show('scores'); });
    app.page.back.addEventListener('click', function () { show('welcome'); });
    app.page.home.addEventListener('click', function () { show('welcome'); });
    app.page.paused.addEventListener('click', function () { hold(false); });

    window.addEventListener('resize', fit);
    window.addEventListener('orientationchange', fit);
    window.addEventListener('gamepadconnected', function () { app.page.pad.hidden = false; });
    watchKeys();

    window.requestAnimationFrame(function (now) { app.last = now; loop(now); });
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
