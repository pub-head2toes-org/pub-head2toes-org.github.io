'use strict';

/**
 * The foes: what each kind is, how it appears, how it moves and what a hit
 * does to it.
 *
 * All three are the same object with a different entry in `foes.KIND` - one
 * position, one heading, one size, one count of hits left. What tells them
 * apart is the steering: a triangle wanders, a square leans towards the
 * rocket, a circle holds its course and takes four hits to break.
 *
 * Sizes are given as a share of the rocket, not in pixels, because that is how
 * the game reads: a triangle is half the rocket and a circle is the size of
 * it, at any screen size. The rocket's own size is passed in - nothing here
 * knows the rocket otherwise.
 */
const foes = {};

foes.TRIANGLE = 'triangle';
foes.SQUARE = 'square';
foes.CIRCLE = 'circle';

foes.KIND = {
    triangle: {
        colour: '#ffd94a',
        speed: 150,          // medium
        share: 0.5,          // half the rocket
        score: 5,
        fleet: 10,           // a fleet, all out of the one spot
        gap: 0,              // and all at once
        every: 20000,
        hits: 1,
        grows: true,
        spread: 26           // how far apart a fleet stands when it arrives
    },
    square: {
        colour: '#2ee06a',
        speed: 90,           // slow
        share: 0.6,
        score: 10,
        fleet: 5,
        gap: 260,            // each one pops on its own, a little after the last
        every: 30000,
        hits: 1,
        grows: false,        // a square is simply there
        spread: 0
    },
    circle: {
        colour: '#ff8c1a',
        speed: 260,          // fast
        share: 1,            // the size of the rocket
        score: 100,
        fleet: 1,
        gap: 0,
        every: 60000,
        hits: 4,             // a quarter of it off at a time
        grows: true,
        spread: 0
    }
};

foes.GROW = 1200;            // ms from a dot to full size
foes.SEED = 2;               // the dot it starts as, in pixels
foes.SWAY = 1.6;             // rad/s a triangle may wander off its course
foes.DRIFT = 0.15;           // how far a triangle's speed may stray from its kind's
foes.LEAN = 0.5;             // rad/s a square turns towards the rocket
foes.MEND = 3000;            // ms a circle takes to grow a quarter back
foes.PACE = 4000;            // points that add one whole speed again
foes.PACE_CAP = 2.5;         // and as fast as it will ever get
foes.PRESS = 6000;           // points that halve the wait between waves
foes.PRESS_FLOOR = 3;        // but never more than this many times as often
foes.CROWD = 90;             // shapes on the field at once before a wave is put off
foes.SAFE = 6;               // rockets' lengths a wave must arrive clear of the rocket
foes.TRIES = 12;             // how many spots are looked at before one is pushed away

/** How much faster than its kind everything moves, for a score. */
foes.pace = function (score) {
    return Math.min(foes.PACE_CAP, 1 + Math.max(0, score) / foes.PACE);
};

/**
 * The wait between waves of a kind, for a score. Waves come closer together as
 * the score climbs, the way the guns fire faster, but only down to a third of
 * where they started - past that the screen is a wall and there is no game in
 * it.
 */
foes.every = function (kind, score) {
    const base = foes.KIND[kind].every;
    return Math.max(base / foes.PRESS_FLOOR, base * Math.pow(0.5, Math.max(0, score) / foes.PRESS));
};

/**
 * One foe, standing where it was put.
 *
 * `scale` is the rocket's size: a foe's full size is its kind's share of it.
 * The ones that grow start as a dot and are still dangerous on the way up -
 * they move from their first step, as asked.
 */
foes.create = function (kind, x, y, angle, scale, random) {
    const roll = random || Math.random;
    const shape = foes.KIND[kind];
    const full = shape.share * scale;
    const stray = 1 + (roll() * 2 - 1) * foes.DRIFT;
    return {
        kind: kind,
        x: x,
        y: y,
        angle: angle,
        full: full,
        size: shape.grows ? foes.SEED : full,
        speed: shape.speed * (kind === foes.TRIANGLE ? stray : 1),
        base: shape.speed,
        hits: shape.hits,
        mended: 0,           // how much of a circle has grown back since its last hit
        spin: roll() * Math.PI * 2,   // a square is drawn corner-first, so it needs one
        dead: false
    };
};

/** What a foe is worth. */
foes.score = function (foe) {
    return foes.KIND[foe.kind].score;
};

/** What it takes up, for a hit or a collision. */
foes.radius = function (foe) {
    return foe.size / 2;
};

/**
 * A hit lands.
 *
 * A triangle or a square goes. A circle loses a quarter of its full diameter,
 * and with it whatever it had grown back since it was last hit - so mending
 * counts for nothing unless a whole quarter is mended before the next shot
 * arrives. Four clean hits and there is nothing left of it.
 */
foes.hit = function (foe) {
    foe.hits -= 1;
    if (foe.kind === foes.CIRCLE) {
        foe.size -= foe.mended + foe.full / 4;
        foe.mended = 0;
        if (foe.size <= 0.5 || foe.hits <= 0) { foe.size = 0; foe.dead = true; }
    } else if (foe.hits <= 0) {
        foe.dead = true;
    }
    return foe.dead;
};

/**
 * One step of a foe's life: it grows if it is still growing, steers by the
 * habit of its kind, moves, and bounces off the edge of the world rather than
 * wandering out of the game.
 */
foes.step = function (foe, seconds, field) {
    const roll = field.random || Math.random;
    const shape = foes.KIND[foe.kind];

    if (shape.grows && foe.hits === shape.hits && foe.size < foe.full) {
        foe.size = Math.min(foe.full, foe.size + foe.full * (seconds * 1000) / foes.GROW);
    } else if (foe.kind === foes.CIRCLE && foe.size < foe.full) {
        const mend = foe.full * (seconds * 1000) / (foes.MEND * 4);
        foe.size = Math.min(foe.full, foe.size + mend);
        foe.mended += mend;
        // A whole quarter back is a quarter earned: the next hit cannot take it.
        if (foe.mended >= foe.full / 4) foe.mended = 0;
    }

    if (foe.kind === foes.TRIANGLE) {
        foe.angle += (roll() * 2 - 1) * foes.SWAY * seconds;
        foe.speed += (roll() * 2 - 1) * foe.base * seconds;
        foe.speed = world.confine(foe.speed, foe.base * (1 - foes.DRIFT), foe.base * (1 + foes.DRIFT));
    } else if (foe.kind === foes.SQUARE && field.rocket) {
        foe.angle = foes.towards(foe.angle, Math.atan2(field.rocket.y - foe.y, field.rocket.x - foe.x), foes.LEAN * seconds);
        foe.spin = foe.angle;      // the leading corner is the one it is heading with
    }

    const step = foe.speed * (field.pace || 1) * seconds;
    foe.x += Math.cos(foe.angle) * step;
    foe.y += Math.sin(foe.angle) * step;

    const wall = world.keep(field.world, foe, foes.radius(foe));
    if (wall.x) foe.angle = Math.PI - foe.angle;
    if (wall.y) foe.angle = -foe.angle;
    return foe;
};

/** A heading turned towards another by at most so much - the short way round. */
foes.towards = function (angle, wanted, most) {
    let turn = (wanted - angle + Math.PI * 3) % (Math.PI * 2) - Math.PI;
    if (turn > most) turn = most;
    if (turn < -most) turn = -most;
    return angle + turn;
};

/**
 * Holds a spot inside the world, and out of the rocket's lap.
 *
 * A fleet of ten that appears where the rocket is standing is not a wave, it
 * is a verdict. Anything too close is pushed out to arm's length, and if the
 * way out of the world leads through a wall the push is tried around the
 * circle until one of the eight ways round has the room. The rocket may still
 * fly into what arrives; that is the game.
 */
foes.nudge = function (state, spot, scale, away) {
    const margin = scale * 1.5;
    const safe = scale * foes.SAFE;
    const hold = one => ({
        x: world.confine(one.x, margin, state.width - margin),
        y: world.confine(one.y, margin, state.height - margin)
    });
    if (!away || world.between(spot, away) >= safe) return hold(spot);

    const from = Math.atan2(spot.y - away.y, spot.x - away.x) || 0;
    let best = hold(spot);
    for (let turn = 0; turn < 8; turn++) {
        const angle = from + turn * Math.PI / 4;
        const out = hold({ x: away.x + Math.cos(angle) * safe, y: away.y + Math.sin(angle) * safe });
        if (world.between(out, away) >= safe - 1e-9) return out;
        if (world.between(out, away) > world.between(best, away)) best = out;
    }
    return best;          // a world with nowhere far enough in it: the best there is
};

/** A spot to arrive at: drawn at random, and drawn again while it is too close. */
foes.clear = function (state, scale, roll, away) {
    const margin = scale * 1.5;
    const safe = scale * foes.SAFE;
    let spot = world.spot(state, roll, margin);
    for (let tries = 0; away && tries < foes.TRIES && world.between(spot, away) < safe; tries++) {
        spot = world.spot(state, roll, margin);
    }
    return foes.nudge(state, spot, scale, away);
};

/**
 * A wave, as a list of arrivals: what to make, where, and how long from now.
 *
 * A triangle fleet comes out of the one spot together, scattered a little so
 * ten of them are not the one dot, each on its own heading. A square fleet is
 * five separate pops, each somewhere else and each a moment after the last. A
 * circle is one, alone.
 */
foes.wave = function (kind, state, scale, random, away) {
    const roll = random || Math.random;
    const shape = foes.KIND[kind];
    const arrivals = [];
    const together = foes.clear(state, scale, roll, away);

    for (let index = 0; index < shape.fleet; index++) {
        // A fleet stands a little apart, and that scatter is put through the
        // same guard as the spot it was scattered from - a fleet of ten is ten
        // arrivals, and any one of them could otherwise land on the rocket.
        const spot = shape.gap ? foes.clear(state, scale, roll, away) : foes.nudge(state, {
            x: together.x + (roll() * 2 - 1) * shape.spread,
            y: together.y + (roll() * 2 - 1) * shape.spread
        }, scale, away);
        arrivals.push({
            kind: kind,
            x: spot.x,
            y: spot.y,
            angle: roll() * Math.PI * 2,
            after: index * shape.gap
        });
    }
    return arrivals;
};
