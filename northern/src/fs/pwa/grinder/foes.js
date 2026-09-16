'use strict';

/**
 * The foes: what each kind is, how it appears, how it moves and what a hit
 * does to it.
 *
 * Most of them are the same object with a different entry in `foes.KIND` - one
 * position, one heading, one size, one count of hits left. What tells them
 * apart is the steering: a triangle wanders, a square leans towards the rocket,
 * a circle holds its course and takes four hits to break, a mine turns onto the
 * rocket and cannot be shaken.
 *
 * The snake is the one that is not a single shape. It is a head and a line of
 * triangles sitting on the path the head has just flown, and it is hit part by
 * part: the tail only lights up, and the head is the only thing on it that can
 * be hurt. That is why everything that can be hit is asked for `foes.spots`
 * rather than for a centre and a radius - one foe may be twelve places at once
 * and the guns need not know which kind it was.
 *
 * Sizes are given as a share of the rocket, not in pixels, because that is how
 * the game reads: a triangle is the size of the rocket and a circle is twice
 * it, at any screen size. The rocket's own size is passed in - nothing here
 * knows the rocket otherwise.
 */
const foes = {};

foes.TRIANGLE = 'triangle';
foes.SQUARE = 'square';
foes.CIRCLE = 'circle';
foes.SNAKE = 'snake';
foes.EGG = 'egg';
foes.MINE = 'mine';

foes.TAIL = 10;              // triangles behind a snake's head
foes.SHED = 2;               // and how many a hit on the head takes off it

foes.KIND = {
    triangle: {
        colour: '#ffd94a',
        speed: 150,          // medium
        share: 1,            // the size of the rocket
        score: 5,
        fleet: 10,           // a fleet, all out of the one spot
        gap: 0,              // and all at once
        every: 20000,
        hits: 1,
        grows: true,
        spread: 52           // how far apart a fleet stands when it arrives
    },
    square: {
        colour: '#2ee06a',
        speed: 90,           // slow
        share: 1.2,
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
        share: 2,            // twice the rocket
        score: 100,
        fleet: 1,
        gap: 0,
        every: 60000,
        hits: 4,             // a quarter of it off at a time
        grows: true,
        spread: 0
    },
    snake: {
        colour: '#ff2d2d',
        speed: 190,
        share: 1.15,         // the head; the tail is smaller again
        score: 250,
        fleet: 1,
        gap: 0,
        every: 45000,
        hits: foes.TAIL / foes.SHED,   // every one of them landed on the head
        grows: false,        // it has a reveal of its own
        spread: 0
    },
    egg: {
        colour: '#2ee06a',
        speed: 190,          // whatever the head it came out of was doing
        share: 0.85,
        score: 500,          // caught, that is; shooting one costs
        fleet: 0,            // never arrives in a wave - a snake leaves it
        gap: 0,
        every: 0,
        hits: 1,
        grows: false,
        spread: 0
    },
    mine: {
        colour: '#ff2d2d',
        speed: 520,          // twice a circle's
        share: 0.75,
        score: 50,
        fleet: 0,            // never arrives in a wave - a broken circle leaves it
        gap: 0,
        every: 0,
        hits: 1,
        grows: false,
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
foes.CROWD = 60;             // shapes on the field at once before a wave is put off
foes.SAFE = 6;               // rockets' lengths a wave must arrive clear of the rocket
foes.TRIES = 12;             // how many spots are looked at before one is pushed away

foes.WAKE = 900;             // ms a snake's head is shown alone before it sets off
foes.SPROUT = 150;           // ms between one triangle of the tail and the next
foes.TAIL_SHARE = 0.68;      // a tail triangle, against the head
foes.TAIL_GAP = 0.55;        // how far apart they sit, in their own widths - they overlap
foes.STEP = 4;               // px between the crumbs the head drops for the tail to sit on
foes.WEAVE = 0.85;           // rad either side of its course the head swings
foes.WEAVE_RATE = 2.1;       // rad/s that swing runs at
foes.LOOP_SPIN = 3.4;        // rad/s while it is looping - one whole turn, then out of it
foes.LOOP_SOON = 1800;       // ms between one loop and the next, at the least
foes.LOOP_LATER = 5600;      // and at the most
foes.MARK = 220;             // ms a struck tail triangle is lit from the inside
foes.EGG_LIFE = 5000;        // ms an egg is left before it is gone
foes.EGG_SHOT = -50;         // what shooting one costs, against the 500 for catching it
foes.MINE_FUSE = 5000;       // ms a mine runs before it goes off
foes.MINE_BLAST = 5;         // rockets' sizes the blast clears, and kills inside
foes.MINE_TURN = 2.4;        // rad/s a mine turns onto the rocket
foes.MINE_SHIFT = 1300;      // ms for one whole tall-round-wide-round shape shift

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
    const foe = {
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

    if (kind === foes.SNAKE) foes.hatch(foe, scale, roll);
    if (kind === foes.EGG) foes.lay(foe, roll);
    if (kind === foes.MINE) foes.arm(foe, roll);
    return foe;
};

/** The weaving a snake's head and the egg it leaves both fly by. */
foes.wind = function (foe, random) {
    const roll = random || Math.random;
    foe.course = foe.angle;
    foe.phase = roll() * Math.PI * 2;
    foe.looping = 0;                              // ms of loop left to fly
    foe.turning = roll() < 0.5 ? 1 : -1;          // and which way round it goes
    foe.since = 0;
    foe.until = foes.LOOP_SOON + roll() * (foes.LOOP_LATER - foes.LOOP_SOON);
    return foe;
};

/** A snake, head only, not yet moving, with a tail it has not shown. */
foes.hatch = function (foe, scale, random) {
    foes.wind(foe, random);
    foe.waking = foes.WAKE;
    foe.grown = 0;
    foe.tail = foes.TAIL;
    foe.narrow = foe.full * foes.TAIL_SHARE;      // a tail triangle's size
    foe.parts = Array.from({ length: foes.TAIL }, () => ({ x: foe.x, y: foe.y, angle: foe.angle, lit: 0 }));
    foe.path = [{ x: foe.x, y: foe.y }];
    return foe;
};

/** An egg, on its five seconds, flying as whatever laid it was flying. */
foes.lay = function (foe, random) {
    foes.wind(foe, random);
    foe.life = foes.EGG_LIFE;
    foe.spent = false;       // true only when the five seconds ran out rather than a shot
    return foe;
};

/** A mine, live, on its five seconds. */
foes.arm = function (foe, random) {
    const roll = random || Math.random;
    foe.fuse = foes.MINE_FUSE;
    foe.shift = roll() * foes.MINE_SHIFT;         // where in its shape shift it starts
    return foe;
};

/**
 * The egg a snake's head leaves when it goes: the same flight, a new shape.
 *
 * The weave is carried over whole rather than started again, so the egg picks up
 * exactly where the head left off - the same course, the same point in the same
 * swing, the same loop if it was in the middle of one. That is what "flies the
 * pattern the head used to" has to mean if it is to be visible.
 */
foes.egg = function (snake, scale, random) {
    const egg = foes.create(foes.EGG, snake.x, snake.y, snake.angle, scale, random);
    egg.course = snake.course;
    egg.phase = snake.phase;
    egg.looping = snake.looping;
    egg.turning = snake.turning;
    egg.since = snake.since;
    egg.until = snake.until;
    egg.speed = snake.speed;
    return egg;
};

/** The mine a broken circle leaves behind it. */
foes.mine = function (circle, scale, random) {
    const roll = random || Math.random;
    return foes.create(foes.MINE, circle.x, circle.y, roll() * Math.PI * 2, scale, roll);
};

/** What a foe is worth: what catching an egg is worth, for an egg. */
foes.score = function (foe) {
    return foes.KIND[foe.kind].score;
};

/** What it takes up. For a snake this is the head - the tail has its own. */
foes.radius = function (foe) {
    return foe.size / 2;
};

/**
 * Every place a foe can be hit or run into, as a circle with a name.
 *
 * `part` is -1 for a whole shape and for a snake's head, and the index of the
 * triangle for a snake's tail, which is all `foes.hit` needs to tell a hit that
 * hurts from one that only lights up.
 */
foes.spots = function (foe) {
    if (foe.kind !== foes.SNAKE) return [{ x: foe.x, y: foe.y, radius: foes.radius(foe), part: -1 }];

    const spots = [{ x: foe.x, y: foe.y, radius: foes.radius(foe), part: -1 }];
    const shown = foes.shown(foe);
    for (let at = 0; at < shown; at++) {
        const part = foe.parts[at];
        spots.push({ x: part.x, y: part.y, radius: foe.narrow / 2, part: at });
    }
    return spots;
};

/** How much of a snake's tail is out: what it has, or what it has shown so far. */
foes.shown = function (snake) {
    if (snake.waking > 0) return 0;
    return Math.max(0, Math.min(snake.tail, Math.floor(snake.grown / foes.SPROUT)));
};

/**
 * A hit lands.
 *
 * A triangle, a square, an egg or a mine goes. A circle loses a quarter of its
 * full diameter, and with it whatever it had grown back since it was last hit -
 * so mending counts for nothing unless a whole quarter is mended before the
 * next shot arrives. Four clean hits and there is nothing left of it.
 *
 * A snake is the one that reads the part. Anywhere in the tail and the triangle
 * lights from the inside for a moment and that is all - no damage, and the shot
 * is still spent. In the head it takes two triangles off the end of the tail,
 * and the hit that takes the last two is the one the head does not survive.
 */
foes.hit = function (foe, part) {
    if (foe.kind === foes.SNAKE) {
        if (part >= 0) {
            const struck = foe.parts[part];
            if (struck) struck.lit = foes.MARK;
            return false;
        }
        foe.hits -= 1;
        foe.tail -= foes.SHED;
        if (foe.tail <= 0) { foe.tail = 0; foe.dead = true; }
        return foe.dead;
    }

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

/** Whether running into it ends the game. Everything but the egg, which is a prize. */
foes.lethal = function (foe) {
    return foe.kind !== foes.EGG;
};

/**
 * One step of a foe's life: it grows if it is still growing, steers by the
 * habit of its kind, moves, and bounces off the edge of the world rather than
 * wandering out of the game.
 */
foes.step = function (foe, seconds, field) {
    const roll = field.random || Math.random;
    const shape = foes.KIND[foe.kind];
    const passed = seconds * 1000;

    if (shape.grows && foe.hits === shape.hits && foe.size < foe.full) {
        foe.size = Math.min(foe.full, foe.size + foe.full * passed / foes.GROW);
    } else if (foe.kind === foes.CIRCLE && foe.size < foe.full) {
        const mend = foe.full * passed / (foes.MEND * 4);
        foe.size = Math.min(foe.full, foe.size + mend);
        foe.mended += mend;
        // A whole quarter back is a quarter earned: the next hit cannot take it.
        if (foe.mended >= foe.full / 4) foe.mended = 0;
    }

    if (foe.kind === foes.SNAKE) return foes.crawl(foe, seconds, field, roll);
    if (foe.kind === foes.EGG) return foes.roll(foe, seconds, field, roll);
    if (foe.kind === foes.MINE) return foes.seek(foe, seconds, field);

    if (foe.kind === foes.TRIANGLE) {
        foe.angle += (roll() * 2 - 1) * foes.SWAY * seconds;
        foe.speed += (roll() * 2 - 1) * foe.base * seconds;
        foe.speed = world.confine(foe.speed, foe.base * (1 - foes.DRIFT), foe.base * (1 + foes.DRIFT));
    } else if (foe.kind === foes.SQUARE && field.rocket) {
        foe.angle = foes.towards(foe.angle, Math.atan2(field.rocket.y - foe.y, field.rocket.x - foe.x), foes.LEAN * seconds);
        foe.spin = foe.angle;      // the leading corner is the one it is heading with
    }

    foes.travel(foe, seconds, field);
    return foe;
};

/** Move by the heading, and bounce off the wall rather than leaving the world. */
foes.travel = function (foe, seconds, field) {
    const step = foe.speed * (field.pace || 1) * seconds;
    foe.x += Math.cos(foe.angle) * step;
    foe.y += Math.sin(foe.angle) * step;

    const wall = world.keep(field.world, foe, foes.radius(foe));
    if (wall.x) foe.angle = Math.PI - foe.angle;
    if (wall.y) foe.angle = -foe.angle;
    return wall;
};

/**
 * The weave: a heading that swings either side of a course, and now and then
 * drops the swing for one whole loop.
 *
 * The loop lasts exactly as long as a turn at `LOOP_SPIN` takes, so it comes
 * out of it pointing the way it went in, and the gap until the next one is
 * drawn fresh each time - which is the "randomly spaced" of it.
 */
foes.swing = function (foe, seconds, random) {
    const roll = random || Math.random;
    const passed = seconds * 1000;

    if (foe.looping > 0) {
        foe.looping -= passed;
        foe.angle += foes.LOOP_SPIN * foe.turning * seconds;
        if (foe.looping <= 0) { foe.looping = 0; foe.course = foe.angle; }
        return foe.angle;
    }

    foe.phase += foes.WEAVE_RATE * seconds;
    foe.angle = foe.course + Math.sin(foe.phase) * foes.WEAVE;
    foe.since += passed;
    if (foe.since >= foe.until) {
        foe.since = 0;
        foe.until = foes.LOOP_SOON + roll() * (foes.LOOP_LATER - foes.LOOP_SOON);
        foe.looping = Math.PI * 2 / foes.LOOP_SPIN * 1000;
        foe.turning = roll() < 0.5 ? 1 : -1;
    }
    return foe.angle;
};

/**
 * A snake.
 *
 * The head waits its moment, alone, and then sets off weaving and dropping
 * crumbs behind it. The tail is not steered at all: each triangle is put where
 * the head was a fixed distance ago, so the whole of it follows the exact path
 * the head flew, which is what makes a snake read as one animal.
 */
foes.crawl = function (foe, seconds, field, random) {
    const passed = seconds * 1000;
    for (const part of foe.parts) if (part.lit > 0) part.lit = Math.max(0, part.lit - passed);

    if (foe.waking > 0) { foe.waking -= passed; return foe; }
    foe.grown += passed;

    foes.swing(foe, seconds, random);
    const wall = foes.travel(foe, seconds, field);
    if (wall.x || wall.y) foe.course = foe.angle;      // turned by the wall, and it keeps the turn

    foes.crumbs(foe);
    foes.trail(foe);
    return foe;
};

/**
 * The crumbs the head drops for the tail to sit on.
 *
 * The first of them is always exactly where the head is now, and the ones behind
 * it are dropped every `STEP` pixels of flying. Keeping a live first crumb is
 * what lets the tail measure its spacing from the head itself rather than from
 * the last crumb it happened to drop - without it the whole tail sits up to a
 * crumb further back than it should, and how far depends on how fast the snake
 * is going.
 */
foes.crumbs = function (foe) {
    const path = foe.path;
    if (path.length < 2) path.push({ x: foe.x, y: foe.y });
    const last = path[1];
    if (Math.hypot(foe.x - last.x, foe.y - last.y) >= foes.STEP) {
        path.splice(1, 0, { x: foe.x, y: foe.y });
    }
    path[0] = { x: foe.x, y: foe.y };

    const span = foe.narrow * foes.TAIL_GAP;
    const wanted = Math.ceil((foes.TAIL + 1) * span / foes.STEP) + 2;
    while (path.length > wanted) path.pop();
    return path;
};

/** The tail put on the path, one triangle per span back from the head. */
foes.trail = function (foe) {
    const span = foe.narrow * foes.TAIL_GAP;
    for (let at = 0; at < foe.parts.length; at++) {
        const on = foes.along(foe.path, span * (at + 1));
        if (!on) continue;
        foe.parts[at].x = on.x;
        foe.parts[at].y = on.y;
        foe.parts[at].angle = on.angle;
    }
    return foe.parts;
};

/**
 * A point so far back along a path, and the way the path was going there.
 *
 * The path is newest-first, so walking it forwards is walking backwards along
 * the flight. A path shorter than the distance asked for gives back its far
 * end, which is what a snake that has only just set off needs: the whole tail
 * sits on the head until there is a path to lie along.
 */
foes.along = function (path, distance) {
    if (!path.length) return null;
    let left = distance;
    for (let at = 0; at < path.length - 1; at++) {
        const one = path[at];
        const next = path[at + 1];
        const span = Math.hypot(next.x - one.x, next.y - one.y);
        if (span <= 0) continue;
        if (left <= span) {
            const part = left / span;
            return {
                x: one.x + (next.x - one.x) * part,
                y: one.y + (next.y - one.y) * part,
                angle: Math.atan2(one.y - next.y, one.x - next.x)
            };
        }
        left -= span;
    }
    const end = path[path.length - 1];
    const before = path[Math.max(0, path.length - 2)];
    return { x: end.x, y: end.y, angle: Math.atan2(before.y - end.y, before.x - end.x) };
};

/** An egg: the head's flight exactly, and five seconds of it. */
foes.roll = function (foe, seconds, field, random) {
    foes.swing(foe, seconds, random);
    const wall = foes.travel(foe, seconds, field);
    if (wall.x || wall.y) foe.course = foe.angle;

    foe.life -= seconds * 1000;
    if (foe.life <= 0) { foe.life = 0; foe.dead = true; foe.spent = true; }
    return foe;
};

/**
 * A mine: it turns onto the rocket every frame and it is faster than the rocket
 * once the score has lifted it, so it is not outrun. What it is, is outlasted -
 * or shot. Its five seconds are counted here; the blast is `game.js`'s, because
 * a blast is about everything else on the field.
 */
foes.seek = function (foe, seconds, field) {
    const passed = seconds * 1000;
    foe.shift = (foe.shift + passed) % foes.MINE_SHIFT;
    foe.fuse -= passed;

    if (field.rocket) {
        foe.angle = foes.towards(foe.angle, Math.atan2(field.rocket.y - foe.y, field.rocket.x - foe.x), foes.MINE_TURN * seconds);
    }
    const step = foe.speed * (field.pace || 1) * seconds;
    foe.x += Math.cos(foe.angle) * step;
    foe.y += Math.sin(foe.angle) * step;
    world.keep(field.world, foe, foes.radius(foe));    // held in, but not turned - it is chasing
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
 * circle is one, alone, and so is a snake.
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
