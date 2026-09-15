'use strict';

/**
 * The game itself: the rocket, the waves, the shots and the score.
 *
 * One object holds the lot and `game.step` takes it from one frame to the
 * next, given how long the frame was and what the player asked for. It touches
 * no DOM and reads no clock of its own - the time comes in as an argument - so
 * a test can play a whole game in a loop and read the score off the end of it.
 *
 * The rocket flies where the left stick points, whichever way it happens to be
 * facing: the sticks do two separate jobs and the flying one is not steering.
 * Where it is facing is the right stick's business, and the guns' - they fire
 * out of the nose along that heading, and so aiming is turning.
 *
 * There are no lives. One triangle caught on the wing and the game is over,
 * which is the only reason the bombs are worth anything.
 */
const game = {};

game.ROCKET = {
    size: 30,                // nose to tail
    speed: 520,              // fast, as asked
    spin: 14,                // rad/s - the fastest it will turn about its centre
    nose: 0.5                // where the little red triangle sits, along the length
};

game.SPAWN = 900;            // ms of quiet at the start, before the first fleet
game.REACH = 4000;           // how long a laser is drawn when it is touching nothing
game.AGAIN = 2000;           // ms a wave waits when the field is already full

/** A game, ready to play, over a world of this size. */
game.create = function (viewWidth, viewHeight, random) {
    const roll = random || Math.random;
    const state = {
        random: roll,
        world: world.create(viewWidth, viewHeight, roll),
        rocket: null,
        foes: [],
        shots: [],
        beam: null,
        flashes: [],
        cooling: { laser: 0, torpedo: 0 },
        waves: {},
        arriving: [],
        bombs: weapons.EMP,
        score: 0,
        time: 0,
        over: false
    };

    const middle = world.centre(state.world);
    state.rocket = { x: middle.x, y: middle.y, angle: -Math.PI / 2, size: game.ROCKET.size };
    world.look(state.world, state.rocket);

    // The first fleet of triangles is on its way in from the start; the other
    // two kinds keep to their own clocks. A minute of an empty sky waiting for
    // the first circle would be a minute of nothing to do.
    state.waves[foes.TRIANGLE] = game.SPAWN;
    state.waves[foes.SQUARE] = foes.KIND.square.every;
    state.waves[foes.CIRCLE] = foes.KIND.circle.every;
    return state;
};

/** The screen changed size. The world changes with it and the rocket stays in it. */
game.resize = function (state, viewWidth, viewHeight) {
    world.resize(state.world, viewWidth, viewHeight, state.random);
    world.keep(state.world, state.rocket, state.rocket.size / 2);
    world.look(state.world, state.rocket);
};

/** The point of the little red triangle - where both guns fire from. */
game.nose = function (rocket) {
    const reach = rocket.size * game.ROCKET.nose;
    return { x: rocket.x + Math.cos(rocket.angle) * reach, y: rocket.y + Math.sin(rocket.angle) * reach };
};

/**
 * One frame.
 *
 * `seconds` is however long the last frame took, which the caller has already
 * held to something sane - a tab left in the background for a minute must not
 * come back and move everything a minute's worth in one step.
 */
game.step = function (state, seconds, intent) {
    if (state.over) return state;
    state.time += seconds * 1000;

    game.fly(state, seconds, intent);
    game.aim(state, seconds, intent);
    game.fire(state, seconds, intent);
    game.bomb(state, intent);
    game.arrive(state, seconds);
    game.move(state, seconds);
    game.collide(state);
    game.fade(state, seconds);

    world.look(state.world, state.rocket);
    return state;
};

/** The left stick: straight movement, no momentum, no turning. */
game.fly = function (state, seconds, intent) {
    const step = game.ROCKET.speed * seconds;
    state.rocket.x += intent.move.x * step;
    state.rocket.y += intent.move.y * step;
    world.keep(state.world, state.rocket, state.rocket.size / 2);
};

/**
 * The right stick: the rocket turns about its own centre towards where the
 * stick is pushed, as fast as it is allowed to turn and no faster. Let the
 * stick go and it holds the heading it had - a gun that snapped back to
 * forwards would be no use.
 */
game.aim = function (state, seconds, intent) {
    const push = Math.hypot(intent.aim.x, intent.aim.y);
    if (push === 0) return;
    const wanted = Math.atan2(intent.aim.y, intent.aim.x);
    state.rocket.angle = foes.towards(state.rocket.angle, wanted, game.ROCKET.spin * seconds);
};

/**
 * Both guns.
 *
 * The laser is a standing line: while the trigger is down and the gun is not
 * cooling there is a beam, and the beam is re-aimed out of the nose every
 * frame because the rocket has turned since the last one. The frame it meets
 * something is the hit, and then it is gone until the wait has passed.
 *
 * The torpedoes are the ordinary kind: one object away per wait.
 */
game.fire = function (state, seconds, intent) {
    const passed = seconds * 1000;
    state.cooling.laser = Math.max(0, state.cooling.laser - passed);
    state.cooling.torpedo = Math.max(0, state.cooling.torpedo - passed);

    const nose = game.nose(state.rocket);

    if (!intent.laser) {
        state.beam = null;
    } else if (!state.beam && state.cooling.laser === 0) {
        state.beam = { from: nose, to: nose, angle: state.rocket.angle };
    }

    if (state.beam) {
        state.beam.from = nose;
        state.beam.angle = state.rocket.angle;
        const hit = weapons.strike(nose, state.rocket.angle, game.REACH, state.foes);
        if (hit) {
            game.wound(state, hit.target);
            state.beam = null;
            state.cooling.laser = weapons.every(weapons.LASER.every, state.score);
        } else {
            state.beam.to = {
                x: nose.x + Math.cos(state.rocket.angle) * game.REACH,
                y: nose.y + Math.sin(state.rocket.angle) * game.REACH
            };
        }
    }

    if (intent.torpedo && state.cooling.torpedo === 0) {
        state.shots.push(weapons.torpedo(nose, state.rocket.angle));
        state.cooling.torpedo = weapons.every(weapons.TORPEDO.every, state.score);
    }

    const flying = [];
    for (const shot of state.shots) {
        weapons.fly(shot, seconds);
        const target = weapons.struck(shot, state.foes);
        if (target) { game.wound(state, target); continue; }
        if (!world.beyond(state.world, shot, weapons.TORPEDO.length)) flying.push(shot);
    }
    state.shots = flying;
};

/**
 * The bomb: everything on the screen at once, and it counts - a bomb dropped
 * on a full screen is the biggest score in the game, which is what makes
 * holding the last one worth doing.
 */
game.bomb = function (state, intent) {
    if (!intent.emp || state.bombs <= 0 || state.foes.length === 0) return;
    state.bombs -= 1;
    for (const foe of state.foes.slice()) {
        foe.dead = true;
        game.reward(state, foe);
    }
    state.foes = [];
    state.beam = null;
    state.flashes.push({ x: state.rocket.x, y: state.rocket.y, life: weapons.FLASH, full: weapons.FLASH });
};

/** A hit lands: the foe takes it, and if that was the last of it, the score has it. */
game.wound = function (state, foe) {
    if (foes.hit(foe)) {
        game.reward(state, foe);
        state.foes = state.foes.filter(one => one !== foe);
    }
};

game.reward = function (state, foe) {
    state.score += foes.score(foe);
};

/**
 * The waves.
 *
 * Each kind has its own clock; when one runs out, that kind's wave is worked
 * out as a list of arrivals and the clock is set again - shorter than last
 * time, because the score has moved on. The arrivals that are not due yet wait
 * in `arriving`, which is what lets five squares pop one after another out of
 * a single wave.
 */
game.arrive = function (state, seconds) {
    const passed = seconds * 1000;

    // A player who shoots nothing would otherwise be sent wave on wave until
    // the field could not be drawn. A full field puts the next wave off rather
    // than dropping it: the clocks go on running, there is simply nowhere to
    // put another ten.
    const full = state.foes.length + state.arriving.length >= foes.CROWD;

    for (const kind of Object.keys(state.waves)) {
        state.waves[kind] -= passed;
        if (state.waves[kind] > 0) continue;
        if (full) { state.waves[kind] = game.AGAIN; continue; }
        for (const arrival of foes.wave(kind, state.world, game.ROCKET.size, state.random, state.rocket)) {
            state.arriving.push(arrival);
        }
        state.waves[kind] = foes.every(kind, state.score);
    }

    const waiting = [];
    for (const arrival of state.arriving) {
        arrival.after -= passed;
        if (arrival.after > 0) { waiting.push(arrival); continue; }
        state.foes.push(foes.create(arrival.kind, arrival.x, arrival.y, arrival.angle, game.ROCKET.size, state.random));
    }
    state.arriving = waiting;
};

/** Everything already out there takes its step, at the speed the score has set. */
game.move = function (state, seconds) {
    const field = { world: state.world, rocket: state.rocket, pace: foes.pace(state.score), random: state.random };
    for (const foe of state.foes) foes.step(foe, seconds, field);
};

/** Anything touching the rocket ends it. */
game.collide = function (state) {
    const reach = state.rocket.size * 0.42;
    for (const foe of state.foes) {
        if (world.between(foe, state.rocket) < reach + foes.radius(foe)) {
            state.over = true;
            state.beam = null;
            state.flashes.push({ x: state.rocket.x, y: state.rocket.y, life: weapons.FLASH, full: weapons.FLASH });
            return;
        }
    }
};

/** The EMP rings, on their way out. */
game.fade = function (state, seconds) {
    const passed = seconds * 1000;
    state.flashes = state.flashes.filter(flash => (flash.life -= passed) > 0);
};
