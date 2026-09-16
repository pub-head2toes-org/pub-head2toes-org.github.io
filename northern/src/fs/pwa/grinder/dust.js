'use strict';

/**
 * What is left of a shape: pixel dust.
 *
 * Everything in this game is drawn as a stroke - a triangle is three lines, a
 * circle is one - so a shape that is hit has no inside to blow apart. What it
 * has is an outline, and an outline can come to pieces: a ring of little
 * squares in the shape's own colour thrown outwards off the line it was drawn
 * on, slowing as they go and fading as they slow.
 *
 * A grain is four numbers and a clock. Nothing here draws and nothing here
 * reads a clock of its own - `game.js` steps them and `render.js` paints them -
 * so a test can burst a shape and count what came off it.
 */
const dust = {};

dust.GRAINS = 9;             // grains off a shape the size of the rocket
dust.LEAST = 5;              // and never fewer than this, however small the shape
dust.MOST = 40;              // nor more than this, however large
dust.LIFE = 520;             // ms a grain lasts
dust.SPARE = 0.45;           // how much of that one grain may differ from the next
dust.THROWN = 210;           // px/s a grain leaves the outline at
dust.SPRAY = 0.5;            // how much of that speed is random, either way
dust.DRAG = 2.4;             // per second - what takes the throw back out of it
dust.GRAIN = 2.4;            // px a grain is drawn, at the rocket's size
dust.FINE = 1;               // and the smallest it is ever drawn

/**
 * A shape comes to pieces.
 *
 * The grains start on the outline rather than in the middle, because that is
 * where the shape was: a circle the size of the rocket bursts as a ring the
 * size of the rocket and not as a dot in the centre of one. Each one goes
 * outwards along the radius it started on.
 */
dust.burst = function (x, y, radius, colour, scale, random) {
    const roll = random || Math.random;
    const wide = Math.max(1, radius * 2);
    const many = Math.round(dust.GRAINS * wide / Math.max(1, scale || wide));
    const count = Math.max(dust.LEAST, Math.min(dust.MOST, many));
    const grains = [];

    for (let index = 0; index < count; index++) {
        // Spread round the ring rather than drawn at random, so no shape ever
        // bursts with a gap in it, with a nudge each so no two look alike.
        const angle = (index + roll() * 0.8) / count * Math.PI * 2;
        const speed = dust.THROWN * (1 + (roll() * 2 - 1) * dust.SPRAY);
        const life = dust.LIFE * (1 + (roll() * 2 - 1) * dust.SPARE);
        grains.push({
            x: x + Math.cos(angle) * radius,
            y: y + Math.sin(angle) * radius,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            size: Math.max(dust.FINE, dust.GRAIN * Math.min(1, wide / Math.max(1, scale || wide)) * (0.6 + roll() * 0.8)),
            life: life,
            full: life,
            colour: colour
        });
    }
    return grains;
};

/** One step of one grain: out, slowing, and a little nearer gone. */
dust.step = function (grain, seconds) {
    const slow = Math.max(0, 1 - dust.DRAG * seconds);
    grain.x += grain.vx * seconds;
    grain.y += grain.vy * seconds;
    grain.vx *= slow;
    grain.vy *= slow;
    grain.life -= seconds * 1000;
    return grain;
};

/** Every grain a step on, and the spent ones swept up. */
dust.settle = function (grains, seconds) {
    const left = [];
    for (const grain of grains) {
        dust.step(grain, seconds);
        if (grain.life > 0) left.push(grain);
    }
    return left;
};
