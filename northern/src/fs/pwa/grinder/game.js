'use strict';

/**
 * The game itself: the rocket, the levels, the waves, the shots and the score.
 *
 * One object holds the lot and `game.step` takes it from one frame to the
 * next, given how long the frame was and what the player asked for. It touches
 * no DOM and reads no clock of its own - the time comes in as an argument - so
 * a test can play a whole game in a loop and read the score off the end of it.
 *
 * The rocket flies where the left stick points, whichever way it happens to be
 * facing: the sticks do two separate jobs and the flying one is not steering.
 * Where it is facing is the right stick's business, and the guns' - they fire
 * out of the nose along that heading, and so aiming is turning. It has weight
 * now: the stick asks for a speed and the rocket takes a moment to find it, and
 * a moment more to lose it again when the stick is let go.
 *
 * Every thousand points is a level, and between one level and the next there is
 * a comet shower - a stretch with no waves in it and nothing that can be shot,
 * only weather to fly through. The second level brings the snake, the third has
 * every broken circle leave a mine behind it.
 *
 * There are no lives. One triangle caught on the wing and the game is over,
 * which is the only reason the bombs are worth anything.
 */
const game = {};

game.ROCKET = {
    size: 30,                // nose to tail
    speed: 520,              // fast, as asked
    thrust: 1400,            // px/s/s onto the speed the stick is asking for
    coast: 1050,             // px/s/s back off it when the stick is let go
    spin: 14,                // rad/s - the fastest it will turn about its centre
    nose: 0.5                // where the little red triangle sits, along the length
};

game.SPAWN = 900;            // ms of quiet at the start, before the first fleet
game.REACH = 4000;           // how long a laser is drawn when it is touching nothing
game.AGAIN = 2000;           // ms a wave waits when the field is already full
game.LEVEL = 1000;           // points to the next level
game.OPENING = 1500;         // ms a level's new kind waits before its first wave
game.MINES = 3;              // the level from which a broken circle leaves a mine
game.SWEEP = 940;            // px an EMP's ring reaches - across any screen there is
game.WRECK = '#ffffff';      // the rocket's own colour, for the dust it leaves

/** What each level adds to the sky. The rest of a level is the score's doing. */
game.OPENS = {
    2: [foes.SNAKE]
};

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
        grains: [],          // what is left of the shapes that have gone
        comets: [],
        shower: null,        // the one running, between two levels
        showers: 0,          // how many there have been, since each is longer
        level: 1,
        cooling: { laser: 0, torpedo: 0 },
        waves: {},
        arriving: [],
        bombs: weapons.EMP,
        score: 0,
        time: 0,
        over: false
    };

    const middle = world.centre(state.world);
    state.rocket = { x: middle.x, y: middle.y, angle: -Math.PI / 2, size: game.ROCKET.size, vx: 0, vy: 0 };
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
    game.stage(state, seconds);
    game.arrive(state, seconds);
    game.move(state, seconds);
    game.rain(state, seconds);
    game.collide(state);
    game.fade(state, seconds);

    world.look(state.world, state.rocket);
    return state;
};

/**
 * The left stick: straight movement, no turning - but not weightless.
 *
 * The stick asks for a velocity and the rocket goes after it at `thrust`, so
 * there is a moment of winding up at the start of a run and, when the stick
 * comes back to the middle, a shorter glide at `coast` before it is still. That
 * glide is the whole feel of the thing: it is what makes a dodge cost something
 * to begin and something to end, and what makes flying into a corner a decision
 * rather than a keypress.
 */
game.fly = function (state, seconds, intent) {
    const rocket = state.rocket;
    const top = game.ROCKET.speed;
    const asked = Math.hypot(intent.move.x, intent.move.y) > 0;
    const rate = (asked ? game.ROCKET.thrust : game.ROCKET.coast) * seconds;

    rocket.vx = game.ease(rocket.vx, intent.move.x * top, rate);
    rocket.vy = game.ease(rocket.vy, intent.move.y * top, rate);
    rocket.x += rocket.vx * seconds;
    rocket.y += rocket.vy * seconds;

    // A wall takes the speed out of it in that direction rather than leaving it
    // pressed against the edge with a velocity it will never spend.
    const wall = world.keep(state.world, rocket, rocket.size / 2);
    if (wall.x) rocket.vx = 0;
    if (wall.y) rocket.vy = 0;
};

/** A number moved towards another by at most so much. */
game.ease = function (value, wanted, most) {
    const gap = wanted - value;
    if (gap > most) return value + most;
    if (gap < -most) return value - most;
    return wanted;
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
            game.wound(state, hit.target, hit.part);
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
        const hit = weapons.struck(shot, state.foes);
        if (hit) { game.wound(state, hit.target, hit.part); continue; }
        if (!world.beyond(state.world, shot, weapons.TORPEDO.length)) flying.push(shot);
    }
    state.shots = flying;
};

/**
 * The bomb: everything on the screen at once, and it counts - a bomb dropped
 * on a full screen is the biggest score in the game, which is what makes
 * holding the last one worth doing.
 *
 * An egg is left where it is. An egg is not an obstacle, it is five seconds of
 * five hundred points, and a bomb that docked the player fifty for one they
 * could not have known was there would be a trap rather than a rule. Nothing
 * else survives, and nothing a bomb clears leaves anything behind it - no egg
 * off a snake, no mine out of a circle.
 */
game.bomb = function (state, intent) {
    const caught = state.foes.filter(foe => foe.kind !== foes.EGG);
    if (!intent.emp || state.bombs <= 0 || caught.length === 0) return;
    state.bombs -= 1;
    for (const foe of caught) {
        foe.dead = true;
        game.reward(state, foe);
        game.crumble(state, foe);
    }
    state.foes = state.foes.filter(foe => !foe.dead);
    state.beam = null;
    game.ring(state, state.rocket, game.SWEEP);
};

/**
 * A hit lands: the foe takes it, and if that was the last of it, the score has
 * it and whatever it leaves behind is left behind.
 *
 * A hit anywhere in a snake's tail comes back here as nothing having happened,
 * which is right - the triangle lit up, the shot was spent, and the snake is no
 * shorter for it.
 */
game.wound = function (state, foe, part) {
    const was = foes.spots(foe);
    const dead = foes.hit(foe, part);

    // Whatever the hit actually took off it comes to pieces - the whole shape
    // when that was the last of it, and otherwise the two triangles a snake just
    // lost off the end of its tail. A hit that took nothing leaves nothing.
    game.crumble(state, foe, dead ? was : game.taken(was, foes.spots(foe)));
    if (!dead) return;

    game.reward(state, foe);
    if (foe.kind === foes.SNAKE) state.foes.push(foes.egg(foe, game.ROCKET.size, state.random));
    if (foe.kind === foes.CIRCLE && state.level >= game.MINES) {
        state.foes.push(foes.mine(foe, game.ROCKET.size, state.random));
    }
    state.foes = state.foes.filter(one => one !== foe);
};

/**
 * What something was worth.
 *
 * An egg is the one that can cost: five hundred for catching one, fifty off for
 * shooting it, and the score is not let below nothing - the guns' rate and the
 * foes' speed are both read off it and a negative score would read as a fresh
 * game with a fresh sky.
 */
game.reward = function (state, foe) {
    const worth = foe.kind === foes.EGG ? foes.EGG_SHOT : foes.score(foe);
    state.score = Math.max(0, state.score + worth);
};

/** An egg flown into rather than shot: the whole five hundred, and no cap on it. */
game.collect = function (state, egg) {
    egg.dead = true;
    state.score += foes.score(egg);
    game.crumble(state, egg);
    state.foes = state.foes.filter(one => one !== egg);
};

/**
 * A shape comes to pieces where it stood.
 *
 * Everything in this game is a stroke, so there is no inside to blow out - what
 * there is is an outline, and the outline becomes dust in the shape's own
 * colour. A snake bursts along every part of itself rather than at the head,
 * because the whole of it is what was on the screen.
 *
 * `where` is taken rather than read off the foe so it can be where the foe was
 * before the hit landed: by the time a shape is dead it has nothing left to
 * measure, and a snake that has just lost two triangles is already two
 * triangles shorter than the thing the player saw hit.
 */
game.crumble = function (state, foe, where) {
    const colour = foes.KIND[foe.kind].colour;
    for (const spot of (where || foes.spots(foe))) {
        if (spot.radius <= 0) continue;
        state.grains = state.grains.concat(
            dust.burst(spot.x, spot.y, spot.radius, colour, game.ROCKET.size, state.random));
    }
};

/** The parts of a shape that were there before a hit and are not there after. */
game.taken = function (was, now) {
    const left = new Set(now.map(spot => spot.part));
    return was.filter(spot => !left.has(spot.part));
};

/** A ring on its way out, drawn to the reach it is given. */
game.ring = function (state, at, reach) {
    state.flashes.push({ x: at.x, y: at.y, life: weapons.FLASH, full: weapons.FLASH, reach: reach });
};

/**
 * The levels, and the comet shower between them.
 *
 * A thousand points ends a level. What follows is not the next level but the
 * shower: the waves stop arriving, their clocks stop with them, and the only
 * thing crossing the sky is weather that cannot be shot. When it passes, the
 * level goes up and whatever that level brings starts arriving.
 *
 * The comets already in the air are left to fly out of the world rather than
 * taken off the screen with the shower that sent them: a comet that vanished in
 * front of the player would read as a fault, and the last of them are gone
 * within a second either way.
 */
game.stage = function (state, seconds) {
    if (state.shower) {
        state.shower.left -= seconds * 1000;
        if (state.shower.left > 0) return;
        state.shower = null;
        state.level += 1;
        game.opens(state);
        return;
    }
    if (state.score >= state.level * game.LEVEL) {
        state.showers += 1;
        state.shower = comets.shower(state.showers, state.random);
    }
};

/** What a new level adds to the sky, set to arrive soon rather than in a minute. */
game.opens = function (state) {
    for (const kind of game.OPENS[state.level] || []) {
        if (!(kind in state.waves)) state.waves[kind] = game.OPENING;
    }
};

/**
 * The waves.
 *
 * Each kind has its own clock; when one runs out, that kind's wave is worked
 * out as a list of arrivals and the clock is set again - shorter than last
 * time, because the score has moved on. The arrivals that are not due yet wait
 * in `arriving`, which is what lets five squares pop one after another out of
 * a single wave.
 *
 * Nothing arrives during a shower, and nothing counts down towards arriving
 * either: a shower is a held breath and it would be no rest at all if the
 * clocks came out of it all expired at once.
 */
game.arrive = function (state, seconds) {
    if (state.shower) return;
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

/**
 * Everything already out there takes its step, at the speed the score has set.
 *
 * A mine whose fuse has run out goes off here rather than in `foes.js`, because
 * a blast is about everything else on the field and a foe knows nothing about
 * the field. An egg whose five seconds are up simply goes, unpaid for: it was
 * not shot and it was not caught.
 */
game.move = function (state, seconds) {
    const field = { world: state.world, rocket: state.rocket, pace: foes.pace(state.score), random: state.random };
    for (const foe of state.foes.slice()) {
        if (foe.dead) continue;
        foes.step(foe, seconds, field);
        if (foe.kind === foes.MINE && foe.fuse <= 0) game.blast(state, foe);
    }
    state.foes = state.foes.filter(foe => !foe.dead);
};

/**
 * A mine goes off.
 *
 * Five rockets' lengths of the field is cleared of everything, and the rocket
 * with it if it is inside. Nothing the blast clears is scored: the player did
 * not do it, the mine did, and a mine that paid out would be a gift rather than
 * a thing to run from. Mines caught in it go without going off themselves,
 * which is what keeps one blast from becoming a chain of them.
 */
game.blast = function (state, mine) {
    const reach = state.rocket.size * foes.MINE_BLAST;
    mine.dead = true;
    game.crumble(state, mine);
    game.ring(state, mine, reach);

    for (const foe of state.foes) {
        if (foe === mine || foe.dead) continue;
        if (world.between(foe, mine) > reach) continue;
        foe.dead = true;
        game.crumble(state, foe);
    }
    if (world.between(state.rocket, mine) <= reach) game.wreck(state);
};

/**
 * The comets.
 *
 * They are in their own list, not among the foes, because nothing can shoot
 * them: keeping them out of `state.foes` is what makes that true everywhere
 * rather than a check in both guns. They leave the world instead of bouncing
 * off it, and once one is clear of it, it is forgotten.
 */
game.rain = function (state, seconds) {
    const shower = state.shower;
    if (shower) {
        shower.next -= seconds * 1000;
        if (shower.next <= 0) {
            state.comets.push(comets.create(
                state.world, shower.angle, game.ROCKET.size, game.ROCKET.speed, state.random));
            shower.next = comets.gap(state.random);
        }
    }

    const flying = [];
    for (const comet of state.comets) {
        comets.step(comet, seconds);
        if (!comets.gone(state.world, comet, game.ROCKET.size)) flying.push(comet);
    }
    state.comets = flying;
};

/**
 * Anything touching the rocket ends it - except an egg, which is caught.
 *
 * A foe is asked for every place it can be run into, so a snake's tail is as
 * solid as its head even though a shot into it does nothing.
 */
game.collide = function (state) {
    const reach = state.rocket.size * 0.42;

    for (const foe of state.foes.slice()) {
        if (foe.dead) continue;
        if (!game.touching(state.rocket, reach, foes.spots(foe))) continue;
        if (!foes.lethal(foe)) { game.collect(state, foe); continue; }
        return game.wreck(state);
    }
    for (const comet of state.comets) {
        if (game.touching(state.rocket, reach, comets.spots(comet))) return game.wreck(state);
    }
};

/** Whether any of a shape's circles overlaps the rocket. */
game.touching = function (rocket, reach, spots) {
    for (const spot of spots) {
        if (spot.radius <= 0) continue;
        if (world.between(spot, rocket) < reach + spot.radius) return true;
    }
    return false;
};

/** The end of it. */
game.wreck = function (state) {
    if (state.over) return state;
    state.over = true;
    state.beam = null;
    game.ring(state, state.rocket, game.SWEEP);
    state.grains = state.grains.concat(
        dust.burst(state.rocket.x, state.rocket.y, state.rocket.size / 2, game.WRECK, game.ROCKET.size, state.random));
    return state;
};

/** The rings on their way out, and the dust on its way down. */
game.fade = function (state, seconds) {
    const passed = seconds * 1000;
    state.flashes = state.flashes.filter(flash => (flash.life -= passed) > 0);
    state.grains = dust.settle(state.grains, seconds);
};
