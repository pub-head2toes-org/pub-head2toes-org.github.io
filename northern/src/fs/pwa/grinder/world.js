'use strict';

/**
 * The world, and the window the screen shows of it.
 *
 * The world is a fifth larger than the screen in both directions, so there is
 * always a little of it off the edge to fly into. The camera keeps the rocket
 * in the middle of the screen wherever it can, and that is what makes the
 * world slide the other way when the rocket moves: the rocket stays where it
 * is on the glass and the ground travels under it.
 *
 * The dots are what make that visible. An empty black field gives the eye
 * nothing to measure against and the rocket would seem to be standing still
 * however hard it flew - so the world is sprinkled with them once, at the
 * start, and they never move again. Everything that appears to move is the
 * camera.
 *
 * Nothing here draws and nothing here has a clock. These are the numbers
 * `render.js` paints with and the numbers `game.js` moves things by, kept in
 * one place so the two cannot come to disagree about where the edge is.
 */
const world = {};

world.GROWTH = 0.2;              // how much larger than the screen the world is, each way
world.DENSITY = 13000;           // one dot per this many square pixels - sparse, as asked
world.DOT_MIN = 1;               // the smallest a dot is drawn
world.DOT_MAX = 2.6;             // and the largest

/** The colours a dot may be. Random, but out of a set that carries on black. */
world.DOT_COLOURS = [
    '#ff6b6b', '#ffd166', '#06d6a0', '#4cc9f0',
    '#b388ff', '#f7f7ff', '#ff9f1c', '#8de969'
];

/** Keeps a number inside a range, and copes with a range of no width at all. */
world.confine = function (value, low, high) {
    if (high < low) return low;
    return value < low ? low : (value > high ? high : value);
};

/**
 * A world for a screen of this size, sprinkled with dots.
 *
 * `random` is taken rather than reached for so that a test can hand over a
 * sequence it knows and read the sky back.
 */
world.create = function (viewWidth, viewHeight, random) {
    const state = {
        view: { width: viewWidth, height: viewHeight },
        width: 0,
        height: 0,
        camera: { x: 0, y: 0 },
        dots: []
    };
    world.resize(state, viewWidth, viewHeight, random);
    world.look(state, world.centre(state));
    return state;
};

/**
 * The screen has changed size - a window dragged, a phone turned.
 *
 * The dots are carried over in proportion rather than thrown away and drawn
 * again: the sky the player has been flying through stays the sky they are
 * flying through. Only the few the new size has room for beyond the old are
 * new, and the ones it no longer has room for go.
 */
world.resize = function (state, viewWidth, viewHeight, random) {
    const roll = random || Math.random;
    const width = Math.round(viewWidth * (1 + world.GROWTH));
    const height = Math.round(viewHeight * (1 + world.GROWTH));
    const wide = state.width ? width / state.width : 1;
    const tall = state.height ? height / state.height : 1;

    state.view.width = viewWidth;
    state.view.height = viewHeight;
    state.width = width;
    state.height = height;
    for (const dot of state.dots) { dot.x *= wide; dot.y *= tall; }

    const wanted = Math.max(1, Math.round((width * height) / world.DENSITY));
    while (state.dots.length > wanted) state.dots.pop();
    while (state.dots.length < wanted) state.dots.push(world.dot(state, roll));

    state.camera.x = world.confine(state.camera.x, 0, width - viewWidth);
    state.camera.y = world.confine(state.camera.y, 0, height - viewHeight);
    return state;
};

/** One dot: somewhere in the world, some size, some colour. */
world.dot = function (state, random) {
    const roll = random || Math.random;
    return {
        x: roll() * state.width,
        y: roll() * state.height,
        size: world.DOT_MIN + roll() * (world.DOT_MAX - world.DOT_MIN),
        colour: world.DOT_COLOURS[Math.floor(roll() * world.DOT_COLOURS.length) % world.DOT_COLOURS.length]
    };
};

/** The middle of the world - where the rocket starts. */
world.centre = function (state) {
    return { x: state.width / 2, y: state.height / 2 };
};

/**
 * Points the camera at something.
 *
 * It is centred on the point and then held inside the world, so the screen
 * never shows anything that is not there. The whole travel it has is the fifth
 * the world is larger than the screen, which is the scroll.
 */
world.look = function (state, focus) {
    state.camera.x = world.confine(focus.x - state.view.width / 2, 0, state.width - state.view.width);
    state.camera.y = world.confine(focus.y - state.view.height / 2, 0, state.height - state.view.height);
    return state.camera;
};

/** Where a point in the world falls on the screen. */
world.screen = function (state, point) {
    return { x: point.x - state.camera.x, y: point.y - state.camera.y };
};

/**
 * Holds a body inside the world and says which walls it was pushed off, which
 * is what a foe needs to know to bounce and the rocket needs to know not to.
 */
world.keep = function (state, body, radius) {
    const hit = { x: false, y: false };
    if (body.x < radius) { body.x = radius; hit.x = true; }
    if (body.x > state.width - radius) { body.x = state.width - radius; hit.x = true; }
    if (body.y < radius) { body.y = radius; hit.y = true; }
    if (body.y > state.height - radius) { body.y = state.height - radius; hit.y = true; }
    return hit;
};

/** True once a point is off the world by more than the margin - a spent shot. */
world.beyond = function (state, point, margin) {
    const slack = margin || 0;
    return point.x < -slack || point.y < -slack
        || point.x > state.width + slack || point.y > state.height + slack;
};

/** A random point in the world, no nearer the edge than the margin. */
world.spot = function (state, random, margin) {
    const roll = random || Math.random;
    const edge = margin || 0;
    return {
        x: edge + roll() * Math.max(0, state.width - edge * 2),
        y: edge + roll() * Math.max(0, state.height - edge * 2)
    };
};

/** How far one point is from another. Everything that collides asks this. */
world.between = function (one, other) {
    return Math.hypot(one.x - other.x, one.y - other.y);
};
