'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { loadGrinder } from './helpers/grinderPage.js';

const PWA = path.join(import.meta.dirname, '..', 'src', 'fs', 'pwa', 'grinder');
const read = name => fs.readFileSync(path.join(PWA, name), 'utf8');

/**
 * Everything but `grinder.js` touches no DOM: they are the world, the foes,
 * the guns, the pad, the table of scores, the game and the painting. They do
 * lean on each other by name the way the page loads them, so they are loaded
 * together, in order, into one function body - which is the same one shared
 * scope the script tags give them in the browser.
 *
 * `grinder.js` is the page, and is tested through the stub DOM at the end.
 */
const { world, dust, foes, comets, weapons, input, scores, game, render, text, screens } = (function () {
    const source = [
        read('font.js'), read('text.js'), read('world.js'), read('dust.js'), read('foes.js'),
        read('comets.js'), read('weapons.js'), read('input.js'), read('scores.js'), read('game.js'),
        read('render.js'), read('screens.js'),
        'return { world, dust, foes, comets, weapons, input, scores, game, render, text, screens };'
    ].join('\n');
    return new Function(source)();
})();

/** A random that is not random: the same numbers every run, so a test can read them. */
function rolling(...numbers) {
    let at = 0;
    return () => numbers[at++ % numbers.length];
}

/** A game over a world of a known size, with the dice fixed. */
function playing(random) {
    return game.create(1000, 600, random || rolling(0.5));
}

/** Nothing asked for, with whatever this test is asking for laid over it. */
function asking(wants) {
    return Object.assign(input.idle(), wants);
}

/** Steps a game for so many seconds, in frames of a sixtieth. */
function steps(state, seconds, intent) {
    const frames = Math.round(seconds * 60);
    for (let at = 0; at < frames; at++) game.step(state, 1 / 60, intent || input.idle());
    return state;
}

/** A field for one foe to be stepped over, with the dice fixed. */
function around(random) {
    return {
        world: world.create(1000, 600, rolling(0.5)),
        rocket: null,
        pace: 1,
        random: random || rolling(0.5)
    };
}

/** Steps one foe for so many seconds, in frames of a sixtieth. */
function creeps(foe, seconds, field) {
    const frames = Math.round(seconds * 60);
    for (let at = 0; at < frames; at++) foes.step(foe, 1 / 60, field);
    return foe;
}

/** A snake, out of its reveal and with a tail behind it. */
function snaking(field, seconds) {
    const snake = foes.create(foes.SNAKE, 400, 300, 0, game.ROCKET.size, rolling(0.5));
    creeps(snake, (foes.WAKE + foes.SPROUT * (foes.TAIL + 1)) / 1000 + (seconds || 0), field);
    return snake;
}

describe('the world, and the window onto it', () => {
    it('is a fifth larger than the screen, both ways', () => {
        const field = world.create(1000, 600, rolling(0.5));

        assert.strictEqual(field.width, 1200);
        assert.strictEqual(field.height, 720);
    });

    it('centres the camera on what it is pointed at, and stops at the edge', () => {
        const field = world.create(1000, 600, rolling(0.5));

        world.look(field, world.centre(field));
        assert.deepStrictEqual(field.camera, { x: 100, y: 60 });

        world.look(field, { x: 0, y: 0 });
        assert.deepStrictEqual(field.camera, { x: 0, y: 0 }, 'never off the near edge');

        world.look(field, { x: 9999, y: 9999 });
        assert.deepStrictEqual(field.camera, { x: 200, y: 120 }, 'nor off the far one');
    });

    it('sprinkles the dots over the whole world and nowhere else', () => {
        const field = world.create(1000, 600, Math.random);

        assert.ok(field.dots.length > 20, 'a sky with something in it');
        for (const dot of field.dots) {
            assert.ok(dot.x >= 0 && dot.x <= field.width, 'inside, across');
            assert.ok(dot.y >= 0 && dot.y <= field.height, 'inside, down');
            assert.ok(world.DOT_COLOURS.includes(dot.colour), 'a colour it may be');
        }
    });

    it('carries the dots over when the screen changes size rather than drawing a new sky', () => {
        const field = world.create(1000, 600, Math.random);
        const first = field.dots[0];
        const was = { x: first.x, y: first.y };

        world.resize(field, 2000, 1200, Math.random);

        assert.strictEqual(field.dots[0], first, 'the same dot');
        assert.ok(Math.abs(field.dots[0].x - was.x * 2) < 0.001, 'in the same place, in proportion');
        assert.ok(Math.abs(field.dots[0].y - was.y * 2) < 0.001);
        assert.ok(field.dots.length > 20);
    });

    it('holds a body inside itself and says which wall it was pushed off', () => {
        const field = world.create(1000, 600, rolling(0.5));
        const body = { x: -40, y: 300 };

        const wall = world.keep(field, body, 10);

        assert.deepStrictEqual(wall, { x: true, y: false });
        assert.strictEqual(body.x, 10);
    });
});

describe('the foes', () => {
    it('are worth what the game says they are worth', () => {
        assert.strictEqual(foes.KIND.triangle.score, 5);
        assert.strictEqual(foes.KIND.square.score, 10);
        assert.strictEqual(foes.KIND.mine.score, 50);
        assert.strictEqual(foes.KIND.circle.score, 100);
        assert.strictEqual(foes.KIND.snake.score, 250);
        assert.strictEqual(foes.KIND.egg.score, 500);
    });

    it('measure themselves against the rocket: a triangle all of it, a circle twice it', () => {
        const triangle = foes.create(foes.TRIANGLE, 0, 0, 0, 40, rolling(0.5));
        const circle = foes.create(foes.CIRCLE, 0, 0, 0, 40, rolling(0.5));

        assert.strictEqual(triangle.full, 40);
        assert.strictEqual(circle.full, 80);
    });

    it('come in as a dot and grow to full size as they move', () => {
        const field = { world: world.create(1000, 600, rolling(0.5)), pace: 1, random: rolling(0.5) };
        const foe = foes.create(foes.TRIANGLE, 500, 300, 0, 40, rolling(0.5));

        assert.strictEqual(foe.size, foes.SEED, 'a dot, to begin with');
        foes.step(foe, foes.GROW / 2000, field);
        assert.ok(foe.size > foes.SEED && foe.size < foe.full, 'on its way up');
        assert.ok(foe.x > 500, 'and moving while it grows');

        foes.step(foe, foes.GROW / 1000, field);
        assert.strictEqual(foe.size, foe.full, 'and no further than full');
    });

    it('a square is simply there, at full size', () => {
        const square = foes.create(foes.SQUARE, 0, 0, 0, 40, rolling(0.5));
        assert.strictEqual(square.size, square.full);
    });

    it('takes one hit to break a triangle or a square', () => {
        const triangle = foes.create(foes.TRIANGLE, 0, 0, 0, 40, rolling(0.5));
        assert.strictEqual(foes.hit(triangle), true);
        assert.strictEqual(triangle.dead, true);
    });

    it('takes four to break a circle, a quarter of it at a time', () => {
        const circle = foes.create(foes.CIRCLE, 0, 0, 0, 40, rolling(0.5));
        circle.size = circle.full;

        assert.strictEqual(foes.hit(circle), false);
        assert.strictEqual(circle.size, 60, 'a quarter off');
        assert.strictEqual(foes.hit(circle), false);
        assert.strictEqual(foes.hit(circle), false);
        assert.strictEqual(circle.size, 20);
        assert.strictEqual(foes.hit(circle), true, 'the fourth is the last');
        assert.strictEqual(circle.dead, true);
    });

    it('a circle mends itself, slowly, after it has been hit', () => {
        const field = { world: world.create(1000, 600, rolling(0.5)), pace: 1, random: rolling(0.5) };
        const circle = foes.create(foes.CIRCLE, 500, 300, 0, 40, rolling(0.5));
        circle.size = circle.full;
        foes.hit(circle);

        foes.step(circle, 1, field);

        assert.ok(circle.size > 60, 'growing back');
        assert.ok(circle.size < 80, 'but not all at once');
    });

    it('takes the mending back off it when the next hit lands before a whole quarter is back', () => {
        const field = { world: world.create(1000, 600, rolling(0.5)), pace: 1, random: rolling(0.5) };
        const circle = foes.create(foes.CIRCLE, 500, 300, 0, 40, rolling(0.5));
        circle.size = circle.full;
        foes.hit(circle);                       // 60 left
        foes.step(circle, 1, field);            // a third of a quarter back

        foes.hit(circle);

        assert.ok(Math.abs(circle.size - 40) < 0.001, 'the mending and a quarter, both gone');
    });

    it('lets it keep a quarter it has had the time to mend in full', () => {
        const field = { world: world.create(1000, 600, rolling(0.5)), pace: 1, random: rolling(0.5) };
        const circle = foes.create(foes.CIRCLE, 500, 300, 0, 40, rolling(0.5));
        circle.size = circle.full;
        foes.hit(circle);                       // 60 left
        foes.step(circle, foes.MEND / 1000, field);   // a whole quarter back, and earned

        assert.ok(Math.abs(circle.size - 80) < 0.001);
        foes.hit(circle);
        assert.ok(Math.abs(circle.size - 60) < 0.001, 'only the quarter this time');
    });

    it('leans a square towards the rocket and lets a triangle wander', () => {
        const field = {
            world: world.create(1000, 600, rolling(0.5)),
            rocket: { x: 500, y: 0 },
            pace: 1,
            random: rolling(0.5)               // dead centre: no sway of its own
        };
        const square = foes.create(foes.SQUARE, 500, 300, Math.PI / 2, 40, rolling(0.5));
        const triangle = foes.create(foes.TRIANGLE, 500, 300, Math.PI / 2, 40, rolling(0.5));

        foes.step(square, 1, field);
        foes.step(triangle, 1, field);

        assert.ok(square.angle < Math.PI / 2, 'turned towards the rocket above it');
        assert.ok(Math.abs(square.angle - Math.PI / 2) <= foes.LEAN + 1e-9, 'and no faster than it may turn');
        assert.strictEqual(triangle.angle, Math.PI / 2, 'the triangle takes no notice of the rocket');
    });

    it('bounces off the edge of the world rather than leaving the game', () => {
        const field = { world: world.create(1000, 600, rolling(0.5)), pace: 1, random: rolling(0.5) };
        const circle = foes.create(foes.CIRCLE, 1150, 300, 0, 40, rolling(0.5));
        circle.size = circle.full;

        foes.step(circle, 1, field);

        assert.ok(circle.x <= field.world.width, 'still in the world');
        assert.ok(Math.abs(circle.angle - Math.PI) < 1e-9, 'and turned back into it');
    });

    it('moves everything faster as the score climbs, up to a point', () => {
        assert.strictEqual(foes.pace(0), 1);
        assert.ok(foes.pace(4000) > foes.pace(0));
        assert.strictEqual(foes.pace(1000000), foes.PACE_CAP);
    });

    it('brings the waves closer together as the score climbs, but never past a third', () => {
        assert.strictEqual(foes.every(foes.TRIANGLE, 0), 20000);
        assert.ok(foes.every(foes.TRIANGLE, 6000) < 20000);
        assert.strictEqual(foes.every(foes.TRIANGLE, 1000000), 20000 / 3);
    });

    it('sends the triangles as a fleet of ten out of one spot, all at once', () => {
        const field = world.create(1000, 600, rolling(0.5));
        const wave = foes.wave(foes.TRIANGLE, field, 30, Math.random);

        assert.strictEqual(wave.length, 10);
        assert.ok(wave.every(one => one.after === 0), 'together');
        const spread = Math.max(...wave.map(one => world.between(one, wave[0])));
        assert.ok(spread <= foes.KIND.triangle.spread * 3, 'out of the one spot');
    });

    it('pops the squares five at a time, each one a little after the last', () => {
        const field = world.create(1000, 600, rolling(0.5));
        const wave = foes.wave(foes.SQUARE, field, 30, Math.random);

        assert.strictEqual(wave.length, 5);
        assert.deepStrictEqual(wave.map(one => one.after), [0, 260, 520, 780, 1040]);
    });

    it('sends the circles one at a time', () => {
        const field = world.create(1000, 600, rolling(0.5));
        assert.strictEqual(foes.wave(foes.CIRCLE, field, 30, Math.random).length, 1);
    });

    it('never lands a wave in the rocket\'s lap', () => {
        const field = world.create(1000, 600, rolling(0.5));
        const rocket = world.centre(field);

        for (let again = 0; again < 40; again++) {
            for (const arrival of foes.wave(foes.TRIANGLE, field, 30, Math.random, rocket)) {
                assert.ok(world.between(arrival, rocket) >= 30 * foes.SAFE - 1e-6,
                    'arrived at ' + Math.round(world.between(arrival, rocket)));
            }
        }
    });
});

describe('the snake, and the egg it leaves', () => {
    it('shows the head first, alone and standing still', () => {
        const field = around();
        const snake = foes.create(foes.SNAKE, 400, 300, 0, game.ROCKET.size, rolling(0.5));

        assert.strictEqual(foes.shown(snake), 0, 'no tail yet');
        assert.strictEqual(foes.spots(snake).length, 1, 'and nothing to hit but the head');

        creeps(snake, foes.WAKE / 1000 * 0.8, field);
        assert.deepStrictEqual({ x: snake.x, y: snake.y }, { x: 400, y: 300 }, 'and it has not set off');
    });

    it('sets off, and then shows its tail one triangle at a time', () => {
        const field = around();
        const snake = foes.create(foes.SNAKE, 400, 300, 0, game.ROCKET.size, rolling(0.5));

        creeps(snake, (foes.WAKE + foes.SPROUT * 3.5) / 1000, field);

        assert.ok(snake.x > 400, 'moving');
        assert.strictEqual(foes.shown(snake), 3, 'three of the ten out');
        assert.strictEqual(foes.spots(snake).length, 4, 'the head and three');

        creeps(snake, foes.SPROUT * foes.TAIL / 1000, field);
        assert.strictEqual(foes.shown(snake), foes.TAIL, 'and no more than the ten');
    });

    it('lays the tail along the path the head flew, overlapping', () => {
        const snake = snaking(around());
        const spots = foes.spots(snake);
        const span = snake.narrow * foes.TAIL_GAP;

        assert.strictEqual(spots.length, foes.TAIL + 1);
        for (let at = 1; at < spots.length; at++) {
            const gap = world.between(spots[at], spots[at - 1]);
            assert.ok(Math.abs(gap - span) < 0.5, 'evenly spaced, and from the head itself: ' + gap);
            assert.ok(gap < snake.narrow, 'and overlapping the one in front of it');
        }
        assert.ok(spots[1].radius < spots[0].radius, 'a tail triangle is smaller than the head');
    });

    it('weaves either side of its course, and now and then flies a whole loop', () => {
        const field = around(Math.random);
        const snake = snaking(field);
        const swung = [];

        for (let at = 0; at < 60 * 12; at++) {
            foes.step(snake, 1 / 60, field);
            swung.push(snake.angle - snake.course);
        }

        assert.ok(swung.some(off => off > 0.4), 'swung one way');
        assert.ok(swung.some(off => off < -0.4), 'and the other');
        assert.ok(swung.some(off => Math.abs(off) > foes.WEAVE * 1.5),
            'and came further round than a weave ever does - a loop');
    });

    it('takes no damage from a hit in the tail, and says it landed', () => {
        const snake = snaking(around());

        assert.strictEqual(foes.hit(snake, 4), false, 'nothing happens to it');
        assert.strictEqual(snake.tail, foes.TAIL, 'and it is no shorter');
        assert.strictEqual(snake.hits, foes.KIND.snake.hits);
        assert.strictEqual(snake.parts[4].lit, foes.MARK, 'the triangle lights from the inside');

        creeps(snake, foes.MARK / 1000 + 0.1, around());
        assert.strictEqual(snake.parts[4].lit, 0, 'and goes out again');
    });

    it('loses two triangles to every hit in the head, and the last one ends it', () => {
        const snake = snaking(around());

        for (let hit = 1; hit < foes.KIND.snake.hits; hit++) {
            assert.strictEqual(foes.hit(snake, -1), false, 'hit ' + hit);
            assert.strictEqual(snake.tail, foes.TAIL - foes.SHED * hit);
            assert.strictEqual(foes.shown(snake), snake.tail, 'and the tail is that much shorter');
        }

        assert.strictEqual(foes.hit(snake, -1), true, 'no tail left, and the head goes');
        assert.strictEqual(snake.tail, 0);
        assert.strictEqual(foes.spots(snake).length, 1);
    });

    it('leaves an egg flying the head\'s own pattern', () => {
        const snake = snaking(around());
        snake.phase = 1.25;
        snake.course = 0.5;

        const egg = foes.egg(snake, game.ROCKET.size);

        assert.strictEqual(egg.kind, foes.EGG);
        assert.deepStrictEqual({ x: egg.x, y: egg.y }, { x: snake.x, y: snake.y });
        assert.strictEqual(egg.course, 0.5, 'the same course');
        assert.strictEqual(egg.phase, 1.25, 'at the same point in the same weave');
        assert.strictEqual(egg.speed, snake.speed);
        assert.strictEqual(egg.life, foes.EGG_LIFE);
    });

    it('lets the egg go after five seconds, unshot and unpaid for', () => {
        const field = around();
        const egg = foes.egg(snaking(field), game.ROCKET.size);

        creeps(egg, foes.EGG_LIFE / 1000 - 0.5, field);
        assert.strictEqual(egg.dead, false, 'still there with half a second to go');

        creeps(egg, 0.6, field);
        assert.strictEqual(egg.dead, true);
        assert.strictEqual(egg.spent, true, 'gone of its own accord, not shot');
    });

    it('is the one thing on the field that is not lethal to fly into', () => {
        const field = around();
        assert.strictEqual(foes.lethal(foes.egg(snaking(field), game.ROCKET.size)), false);
        assert.strictEqual(foes.lethal(foes.create(foes.MINE, 0, 0, 0, 30, rolling(0.5))), true);
        assert.strictEqual(foes.lethal(foes.create(foes.TRIANGLE, 0, 0, 0, 30, rolling(0.5))), true);
    });
});

describe('the seeking mine', () => {
    it('is twice a circle, and armed for five seconds', () => {
        const mine = foes.create(foes.MINE, 100, 100, 0, game.ROCKET.size, rolling(0.5));

        assert.strictEqual(foes.KIND.mine.speed, foes.KIND.circle.speed * 2);
        assert.strictEqual(mine.fuse, foes.MINE_FUSE);
        assert.strictEqual(mine.hits, 1, 'and one shot is the end of it');
    });

    it('turns onto the rocket wherever the rocket goes', () => {
        /** How far off the rocket a mine is pointing, right now. */
        const off = mine => {
            const at = Math.atan2(field.rocket.y - mine.y, field.rocket.x - mine.x);
            return Math.abs(foes.towards(mine.angle, at, Math.PI) - mine.angle);
        };
        const field = around();
        field.rocket = { x: 1000, y: 360 };
        const mine = foes.create(foes.MINE, 200, 360, -Math.PI / 2, game.ROCKET.size, rolling(0.5));

        assert.ok(off(mine) > Math.PI / 2 - 0.01, 'it starts off pointing away from it');
        creeps(mine, 0.9, field);
        assert.ok(off(mine) < 0.05, 'and comes round onto it: ' + off(mine));

        // One that starts out pointing the wrong way entirely comes round too,
        // which is the whole of a mine: there is no heading it cannot answer.
        field.rocket = { x: 120, y: 80 };
        const other = foes.create(foes.MINE, 900, 600, 0, game.ROCKET.size, rolling(0.5));
        const away = world.between(other, field.rocket);
        creeps(other, 1.4, field);

        assert.ok(off(other) < 0.05, 'round onto it from the far corner: ' + off(other));
        assert.ok(world.between(other, field.rocket) < away, 'and closing on it');
    });

    it('circles a rocket it is already on top of rather than pointing at it', () => {
        const field = around();
        field.rocket = { x: 600, y: 360 };
        const mine = foes.create(foes.MINE, 660, 360, -Math.PI / 2, game.ROCKET.size, rolling(0.5));

        // Its turning circle is its speed over its turn rate, which at this
        // range is wider than the range itself. That is why a mine is outlasted
        // or shot rather than dodged for five whole seconds.
        creeps(mine, 1, field);
        assert.ok(world.between(mine, field.rocket) > 30, 'still circling it');
        assert.ok(foes.KIND.mine.speed / foes.MINE_TURN > 100, 'the circle it turns in is a wide one');
    });

    it('speeds up with the score, like everything else out there', () => {
        const slow = around();
        const fast = around();
        fast.pace = foes.pace(20000);
        slow.rocket = fast.rocket = { x: 900, y: 300 };

        const crawling = creeps(foes.create(foes.MINE, 100, 300, 0, game.ROCKET.size, rolling(0.5)), 0.5, slow);
        const flying = creeps(foes.create(foes.MINE, 100, 300, 0, game.ROCKET.size, rolling(0.5)), 0.5, fast);

        assert.ok(flying.x > crawling.x + 100, 'the score is the difficulty, for a mine too');
        assert.ok(fast.pace > 2);
    });

    it('shifts tall, round and wide as it comes', () => {
        const field = around();
        field.rocket = { x: 500, y: 300 };
        const mine = foes.create(foes.MINE, 200, 300, 0, game.ROCKET.size, rolling(0.5));
        mine.shift = 0;
        const shapes = [];

        for (let at = 0; at < 60; at++) {
            foes.step(mine, foes.MINE_SHIFT / 1000 / 60, field);
            shapes.push(Math.cos(mine.shift / foes.MINE_SHIFT * Math.PI * 2));
        }

        assert.ok(Math.max(...shapes) > 0.9, 'tall');
        assert.ok(Math.min(...shapes) < -0.9, 'and wide');
        assert.ok(shapes.some(one => Math.abs(one) < 0.1), 'and round on the way between');
    });
});

describe('the comet shower', () => {
    it('lasts ten seconds, and five more with every one after it', () => {
        assert.strictEqual(comets.shower(1, rolling(0.5)).span, 10000);
        assert.strictEqual(comets.shower(2, rolling(0.5)).span, 15000);
        assert.strictEqual(comets.shower(5, rolling(0.5)).span, 30000);
        assert.strictEqual(comets.shower(1, rolling(0.5)).left, 10000, 'and it starts full');
    });

    it('sends every comet of one shower the same way', () => {
        const field = world.create(1000, 600, rolling(0.5));
        const shower = comets.shower(1, Math.random);
        const flight = [];

        for (let at = 0; at < 20; at++) {
            flight.push(comets.create(field, shower.angle, 30, 520, Math.random));
        }

        assert.ok(flight.every(one => one.angle === shower.angle), 'all parallel');
        const places = new Set(flight.map(one => Math.round(one.x) + ':' + Math.round(one.y)));
        assert.ok(places.size > 15, 'and each from its own place along the line');
    });

    it('starts each one outside the world and flies it clean out of the other side', () => {
        const field = world.create(1000, 600, rolling(0.5));
        const comet = comets.create(field, 0, 30, 520, rolling(0.5));

        assert.ok(world.beyond(field, comet, 0), 'it comes in from outside');
        assert.ok(comet.speed >= 520 * comets.SLOW && comet.speed <= 520 * comets.FAST, 'two to three rockets');
        assert.strictEqual(comets.gone(field, comet, 30), false, 'but not yet gone');

        for (let at = 0; at < 60 * 10 && !comets.gone(field, comet, 30); at++) comets.step(comet, 1 / 60);
        assert.strictEqual(comets.gone(field, comet, 30), true, 'and out the far side it goes');
    });

    it('is five circles, the largest leading and each lapping the one in front', () => {
        const comet = comets.create(world.create(1000, 600, rolling(0.5)), 0, 30, 520, rolling(0.5));
        const spots = comets.spots(comet);

        assert.strictEqual(spots.length, comets.PARTS);
        assert.deepStrictEqual({ x: spots[0].x, y: spots[0].y }, { x: comet.x, y: comet.y }, 'the head leads');
        for (let at = 1; at < spots.length; at++) {
            assert.ok(spots[at].radius < spots[at - 1].radius, 'each smaller than the last');
            const gap = Math.hypot(spots[at].x - spots[at - 1].x, spots[at].y - spots[at - 1].y);
            assert.ok(gap < spots[at - 1].radius + spots[at].radius, 'and overlapping it');
            assert.ok(spots[at].x < spots[at - 1].x, 'and behind it');
        }
    });
});

describe('the guns', () => {
    it('start the laser at a shot a second and the torpedoes at two, as asked', () => {
        assert.strictEqual(weapons.LASER.every, 1000);
        assert.strictEqual(weapons.TORPEDO.every, 500);
    });

    it('halve the wait every three thousand points, and stop at twenty milliseconds', () => {
        assert.strictEqual(weapons.every(1000, 0), 1000);
        assert.strictEqual(weapons.every(1000, 3000), 500);
        assert.strictEqual(weapons.every(1000, 6000), 250);
        assert.strictEqual(weapons.every(1000, 1000000), weapons.FLOOR);

        // The climb is a third of what it was: a gun used to be at the floor
        // before the second level and had nothing left to give after it.
        assert.ok(weapons.every(1000, 1000) > 750, 'a level in, and barely faster');
    });

    it('stops a beam at the nearest thing in its path and lets the rest be', () => {
        const near = foes.create(foes.CIRCLE, 200, 0, 0, 40, rolling(0.5));
        const far = foes.create(foes.CIRCLE, 400, 0, 0, 40, rolling(0.5));
        const beside = foes.create(foes.CIRCLE, 300, 300, 0, 40, rolling(0.5));
        for (const one of [near, far, beside]) one.size = one.full;

        const hit = weapons.strike({ x: 0, y: 0 }, 0, 4000, [beside, far, near]);

        assert.strictEqual(hit.target, near);
        assert.ok(Math.abs(hit.at - 160) < 0.001, 'at the near edge of it, not its middle');
        assert.strictEqual(weapons.strike({ x: 0, y: 0 }, Math.PI, 4000, [near, far]), null, 'nothing behind');
    });

    it('hits with a torpedo that crossed a foe between two frames', () => {
        const foe = foes.create(foes.TRIANGLE, 100, 0, 0, 40, rolling(0.5));
        foe.size = foe.full;                    // forty across, and a torpedo moves further than that
        const shot = weapons.torpedo({ x: 0, y: 0 }, 0);

        weapons.fly(shot, 1);                   // straight past it, in one step

        assert.ok(shot.x > 200, 'well beyond it');
        assert.strictEqual(weapons.struck(shot, [foe]).target, foe, 'and still counted');
    });

    it('lets a torpedo that went nowhere near alone', () => {
        const foe = foes.create(foes.TRIANGLE, 100, 300, 0, 40, rolling(0.5));
        const shot = weapons.torpedo({ x: 0, y: 0 }, 0);
        weapons.fly(shot, 1);

        assert.strictEqual(weapons.struck(shot, [foe]), null);
    });
});

describe('the pad, and the keys that stand in for it', () => {
    const padding = (axes, buttons) => [{
        connected: true,
        axes: axes,
        buttons: Array.from({ length: 17 }, (ignored, index) => ({ pressed: !!buttons[index], value: buttons[index] ? 1 : 0 }))
    }];

    it('takes the slack out of the middle of a stick', () => {
        const state = input.create();

        const still = input.read(state, padding([0.1, 0.1, 0, 0], {}), new Set());
        assert.deepStrictEqual(still.move, { x: 0, y: 0 }, 'a thumb resting is not a push');

        const pushed = input.read(state, padding([1, 0, 0, 0], {}), new Set());
        assert.ok(Math.abs(pushed.move.x - 1) < 1e-9, 'and all the way is all the way');
    });

    it('reads R2 as the laser, L2 as the torpedoes and B as the bomb', () => {
        const state = input.create();

        const intent = input.read(state, padding([0, 0, 0, 0], { 7: true, 6: true, 1: true }), new Set());

        assert.strictEqual(intent.laser, true);
        assert.strictEqual(intent.torpedo, true);
        assert.strictEqual(intent.emp, true);
    });

    it('leaves the stick clicks alone now that the torpedoes are on a trigger', () => {
        const state = input.create();

        for (const stick of [10, 11]) {
            const intent = input.read(state, padding([0, 0, 0, 0], { [stick]: true }), new Set());
            assert.strictEqual(intent.torpedo, false, 'button ' + stick);
            assert.strictEqual(intent.laser, false);
        }
    });

    it('takes a trigger half pulled as a trigger pulled, since both guns are on one', () => {
        const state = input.create();
        const squeezed = value => [{
            connected: true,
            axes: [0, 0, 0, 0],
            buttons: Array.from({ length: 17 }, (ignored, index) => ({
                pressed: false, value: index === 6 ? value : 0
            }))
        }];

        assert.strictEqual(input.read(state, squeezed(0.1), new Set()).torpedo, false, 'a finger resting on it');
        assert.strictEqual(input.read(state, squeezed(0.9), new Set()).torpedo, true);
    });

    it('gives the four ways as presses, off either stick or the cross', () => {
        const state = input.create();

        assert.strictEqual(input.read(state, padding([0, 0, 0, -1], {}), new Set()).up, true);
        assert.strictEqual(input.read(state, padding([0, 0, 0, -1], {}), new Set()).up, false, 'held is not pressed again');
        assert.strictEqual(input.read(state, padding([0, 0, 0, 0], { 15: true }), new Set()).right, true);
        assert.strictEqual(input.read(state, padding([1, 0, 0, 0], {}), new Set()).right, false, 'the stick was already over');
    });

    it('says which buttons are down, by the names on a pad', () => {
        const state = input.create();

        const intent = input.read(state, padding([0, 0, 0, 0], { 7: true, 11: true }), new Set());

        assert.deepStrictEqual(intent.pressing, [7, 11]);
        assert.deepStrictEqual(intent.pressing.map(index => input.NAMES[index]), ['R2', 'R3']);
    });

    it('gives the bomb once however long the button is leant on', () => {
        const state = input.create();
        const held = padding([0, 0, 0, 0], { 1: true });

        assert.strictEqual(input.read(state, held, new Set()).emp, true);
        assert.strictEqual(input.read(state, held, new Set()).emp, false, 'still down is not pressed again');
        input.read(state, padding([0, 0, 0, 0], {}), new Set());
        assert.strictEqual(input.read(state, held, new Set()).emp, true, 'up and down again is');
    });

    it('holds the trigger down for as long as it is held', () => {
        const state = input.create();
        const held = padding([0, 0, 0, 0], { 7: true });

        assert.strictEqual(input.read(state, held, new Set()).laser, true);
        assert.strictEqual(input.read(state, held, new Set()).laser, true);
    });

    it('says the same things on a keyboard, and no faster on the diagonal', () => {
        const state = input.create();

        const intent = input.read(state, [], new Set(['w', 'd', ' ', 'b']));

        assert.ok(Math.abs(Math.hypot(intent.move.x, intent.move.y) - 1) < 1e-9, 'a diagonal is not a short cut');
        assert.ok(intent.move.x > 0 && intent.move.y < 0, 'up and to the right');
        assert.strictEqual(intent.laser, true);
        assert.strictEqual(intent.emp, true);
        assert.strictEqual(intent.pad, false, 'and it knows no pad was used');
    });
});

describe('the table of scores', () => {
    const pocket = (start) => {
        const kept = new Map(start ? [['grinder.scores', JSON.stringify(start)]] : []);
        return {
            getItem: key => (kept.has(key) ? kept.get(key) : null),
            setItem: (key, value) => kept.set(key, String(value))
        };
    };

    it('keeps the best ten, best first', () => {
        const store = pocket();
        for (const score of [10, 900, 30, 400, 50, 600, 70, 800, 90, 1000, 5]) scores.add(store, score, '2026-09-14');

        const table = scores.read(store);

        assert.strictEqual(table.length, scores.KEEP);
        assert.strictEqual(table[0].score, 1000);
        assert.strictEqual(scores.best(store), 1000);
        assert.ok(!table.some(one => one.score === 5), 'and the worst of eleven falls off');
    });

    it('does not keep a score of nothing', () => {
        const store = pocket();
        assert.deepStrictEqual(scores.add(store, 0, '2026-09-14'), []);
    });

    it('says where a score came', () => {
        const table = scores.add(pocket([{ score: 50, at: '' }, { score: 10, at: '' }]), 30, '2026-09-14');

        assert.strictEqual(scores.place(table, 50), 1);
        assert.strictEqual(scores.place(table, 30), 2);
        assert.strictEqual(scores.place(table, 999), 0);
    });

    it('reads a store full of nonsense as an empty table rather than failing', () => {
        const broken = { getItem: () => '{{{', setItem() {} };
        assert.deepStrictEqual(scores.read(broken), []);

        const refusing = { getItem: () => '[]', setItem() { throw new Error('no room'); } };
        assert.doesNotThrow(() => scores.add(refusing, 100, '2026-09-14'));
    });
});

describe('a game', () => {
    it('puts the rocket in the middle of the world with the camera on it', () => {
        const state = playing();

        assert.deepStrictEqual({ x: state.rocket.x, y: state.rocket.y }, { x: 600, y: 360 });
        assert.deepStrictEqual(state.world.camera, { x: 100, y: 60 });
        assert.strictEqual(state.bombs, weapons.EMP);
        assert.strictEqual(state.score, 0);
    });

    it('flies where the left stick points, whichever way the rocket is facing', () => {
        const state = playing();
        state.rocket.angle = Math.PI;                    // pointing the other way entirely

        game.step(state, 1, asking({ move: { x: 1, y: 0 } }));

        assert.ok(Math.abs(state.rocket.x - (600 + game.ROCKET.speed)) < 1e-9, 'a second at full speed');
        assert.strictEqual(state.rocket.angle, Math.PI, 'and not turned by the flying');
    });

    it('scrolls the world the other way as it flies, and stops at the edge', () => {
        const state = playing();

        steps(state, 5, asking({ move: { x: 1, y: 0 } }));

        assert.strictEqual(state.rocket.x, state.world.width - state.rocket.size / 2, 'held in the world');
        assert.strictEqual(state.world.camera.x, state.world.width - state.world.view.width, 'the scroll, run out');
    });

    it('turns about its centre towards the right stick, no faster than it may', () => {
        const state = playing();
        state.rocket.angle = 0;

        game.step(state, 0.1, asking({ aim: { x: -1, y: 0 } }));

        assert.ok(Math.abs(state.rocket.angle) <= game.ROCKET.spin * 0.1 + 1e-9, 'a tenth of a second of turning');
        assert.deepStrictEqual({ x: state.rocket.x, y: state.rocket.y }, { x: 600, y: 360 }, 'and it stayed put');

        const turned = state.rocket.angle;
        game.step(state, 0.1, input.idle());
        assert.strictEqual(state.rocket.angle, turned, 'a stick let go leaves the heading where it was');
    });

    it('fires the laser out of the nose, scores the hit, and then cools off', () => {
        const state = playing();
        state.rocket.angle = 0;
        state.foes = [foes.create(foes.TRIANGLE, state.rocket.x + 200, state.rocket.y, 0, game.ROCKET.size, rolling(0.5))];
        state.foes[0].size = state.foes[0].full;

        game.step(state, 1 / 60, asking({ laser: true }));

        assert.strictEqual(state.score, 5);
        assert.strictEqual(state.foes.length, 0, 'and it is gone');
        assert.strictEqual(state.beam, null, 'the line goes out with the hit');
        assert.ok(state.cooling.laser > 0, 'and the gun is cooling');
    });

    it('leaves the beam standing while it is touching nothing', () => {
        const state = playing();
        state.rocket.angle = 0;

        steps(state, 0.5, asking({ laser: true }));

        assert.ok(state.beam, 'still drawn');
        assert.strictEqual(state.score, 0);
        assert.ok(state.beam.from.x > state.rocket.x, 'and starting at the nose, not the middle');
    });

    it('sends a torpedo per wait, and scores what it goes through', () => {
        const state = playing();
        state.rocket.angle = 0;
        state.foes = [foes.create(foes.SQUARE, state.rocket.x + 300, state.rocket.y, 0, game.ROCKET.size, rolling(0.5))];

        game.step(state, 1 / 60, asking({ torpedo: true }));
        assert.strictEqual(state.shots.length, 1, 'one away');
        game.step(state, 1 / 60, asking({ torpedo: true }));
        assert.strictEqual(state.shots.length, 1, 'and no more until the wait has passed');

        steps(state, 0.5, asking({ torpedo: false }));
        assert.strictEqual(state.score, 10);
    });

    it('fires faster once the score is up', () => {
        const state = playing();
        state.score = 2000;
        state.rocket.angle = 0;

        steps(state, 1, asking({ torpedo: true }));

        assert.ok(state.shots.length > 1, 'four a second at two thousand points, not one');
    });

    it('clears the screen with a bomb, counts what it cleared, and has only two', () => {
        const state = playing();
        for (let at = 0; at < 4; at++) {
            state.foes.push(foes.create(foes.TRIANGLE, 100 + at * 50, 100, 0, game.ROCKET.size, rolling(0.5)));
        }

        game.step(state, 1 / 60, asking({ emp: true }));

        assert.strictEqual(state.foes.length, 0);
        assert.strictEqual(state.score, 20, 'five a triangle, bomb or no bomb');
        assert.strictEqual(state.bombs, 1);
        assert.strictEqual(state.flashes.length, 1, 'and a ring to show for it');

        state.foes.push(foes.create(foes.TRIANGLE, 100, 100, 0, game.ROCKET.size, rolling(0.5)));
        game.step(state, 1 / 60, asking({ emp: true }));
        assert.strictEqual(state.bombs, 0);
        state.foes.push(foes.create(foes.TRIANGLE, 100, 100, 0, game.ROCKET.size, rolling(0.5)));
        game.step(state, 1 / 60, asking({ emp: true }));
        assert.strictEqual(state.foes.length, 1, 'the rack is empty and the screen stays full');
    });

    it('does not spend a bomb on an empty sky', () => {
        const state = playing();

        game.step(state, 1 / 60, asking({ emp: true }));

        assert.strictEqual(state.bombs, weapons.EMP);
    });

    it('ends the moment anything touches the rocket', () => {
        const state = playing();
        const foe = foes.create(foes.TRIANGLE, state.rocket.x, state.rocket.y, 0, game.ROCKET.size, rolling(0.5));
        foe.size = foe.full;
        state.foes = [foe];

        game.step(state, 1 / 60, input.idle());

        assert.strictEqual(state.over, true);

        const score = state.score;
        game.step(state, 1, asking({ move: { x: 1, y: 0 } }));
        assert.strictEqual(state.score, score, 'and nothing moves after it');
    });

    it('opens with a fleet of triangles and keeps the other kinds to their own clocks', () => {
        const state = playing(Math.random);

        steps(state, 1.5, input.idle());
        assert.strictEqual(state.foes.length, 10, 'ten triangles, at the start');
        assert.ok(state.foes.every(foe => foe.kind === foes.TRIANGLE));

        // A rocket that never moves is caught sooner or later, and the clocks
        // stop with it. What is being read here is the clocks, so it is kept
        // flying by main force.
        for (let frame = 0; frame < 60 * 30; frame++) {
            state.over = false;
            game.step(state, 1 / 60, input.idle());
        }

        assert.ok(state.foes.some(foe => foe.kind === foes.SQUARE), 'squares by the half minute');
        assert.ok(state.time > 31000);
    });

    it('puts a wave off rather than filling the field past drawing', () => {
        const state = playing(Math.random);
        state.score = 30000;                    // waves at their fastest

        for (let frame = 0; frame < 60 * 180; frame++) {
            state.over = false;                 // nothing is shot and nothing may end it
            state.score = 30000;
            // The levels this score has already earned, so the field is being
            // filled rather than held for one comet shower after another.
            state.level = 1 + state.score / game.LEVEL;
            game.step(state, 1 / 60, input.idle());
        }

        // The cap is read before a wave is let out rather than during one, so a
        // fleet of ten can carry the field over it by as much as its own size.
        assert.ok(state.foes.length <= foes.CROWD + foes.KIND.triangle.fleet,
            state.foes.length + ' on the field');
        assert.ok(state.foes.length >= foes.CROWD - 10, 'and it is the cap that stopped it, not a quiet sky');
    });


    it('carries every kind through a long game without losing its footing', () => {
        const state = playing(Math.random);
        state.level = game.MINES;                 // mines out of the circles, from the off
        const snake = foes.create(foes.SNAKE, 200, 200, 0, game.ROCKET.size, state.random);
        state.foes = [
            snake,
            foes.egg(snake, game.ROCKET.size, state.random),
            foes.create(foes.MINE, 1000, 600, 0, game.ROCKET.size, state.random),
            foes.create(foes.CIRCLE, 700, 200, 1, game.ROCKET.size, state.random),
            foes.create(foes.SQUARE, 300, 650, 2, game.ROCKET.size, state.random),
            foes.create(foes.TRIANGLE, 900, 100, 3, game.ROCKET.size, state.random)
        ];

        for (let frame = 0; frame < 60 * 60; frame++) {
            state.over = false;                   // nothing may end it; we are watching the works
            game.step(state, 1 / 60, asking({
                laser: true,
                torpedo: true,
                aim: { x: Math.cos(frame / 23), y: Math.sin(frame / 23) },
                move: { x: Math.cos(frame / 51), y: Math.sin(frame / 47) }
            }));

            assert.ok(Number.isFinite(state.rocket.x + state.rocket.y + state.score),
                'a number went astray at frame ' + frame);
            assert.ok(state.foes.every(foe => foes.spots(foe).every(
                spot => Number.isFinite(spot.x + spot.y + spot.radius))), 'at frame ' + frame);
            assert.ok(state.grains.length < 4000, 'the dust settles: ' + state.grains.length);
        }

        assert.ok(state.score > 0, 'and a game was played');
    });

    it('takes a level through its shower and out into the next one', () => {
        const state = playing(Math.random);
        state.score = game.LEVEL;
        let showered = false;

        for (let frame = 0; frame < 60 * 40; frame++) {
            state.over = false;
            if (state.shower) showered = true;
            game.step(state, 1 / 60, asking({ laser: true, aim: { x: 1, y: 0 } }));
        }

        assert.ok(showered, 'the shower ran');
        assert.ok(state.level >= 2, 'and the level turned over after it');
        assert.ok(foes.SNAKE in state.waves, 'and the snake is on the clock now');
    });

    it('keeps the rocket in the world when the screen is made smaller', () => {
        const state = playing();
        steps(state, 5, asking({ move: { x: 1, y: 1 } }));

        game.resize(state, 400, 300);

        assert.ok(state.rocket.x <= state.world.width, 'still on the board');
        assert.ok(state.rocket.y <= state.world.height);
        assert.strictEqual(state.world.width, 480);
    });
});

describe('the rocket\'s weight', () => {
    /** A game with no waves in it, so the rocket is the only thing moving. */
    const quiet = () => {
        const state = playing();
        state.waves = {};
        return state;
    };

    it('takes a moment to get going rather than leaving at full speed', () => {
        const state = quiet();
        const from = state.rocket.x;

        game.step(state, 1 / 60, asking({ move: { x: 1, y: 0 } }));

        const first = state.rocket.x - from;
        assert.ok(first > 0, 'it moved');
        assert.ok(first < game.ROCKET.speed / 60 / 4, 'but nothing like a whole frame of full speed');
        assert.ok(state.rocket.vx > 0 && state.rocket.vx < game.ROCKET.speed, 'still winding up');
    });

    it('reaches its full speed, and no more, once it is up to it', () => {
        const state = quiet();

        steps(state, game.ROCKET.speed / game.ROCKET.thrust + 0.2, asking({ move: { x: 0, y: -1 } }));

        assert.ok(Math.abs(state.rocket.vy + game.ROCKET.speed) < 1e-9, 'flat out');
        const was = state.rocket.y;
        steps(state, 0.1, asking({ move: { x: 0, y: -1 } }));
        assert.ok(Math.abs((was - state.rocket.y) - game.ROCKET.speed * 0.1) < 1, 'and no faster than that');
    });

    it('glides to a stop when the stick is let go rather than stopping dead', () => {
        const state = quiet();
        steps(state, 0.5, asking({ move: { x: 1, y: 0 } }));
        const flying = state.rocket.x;

        game.step(state, 1 / 60, input.idle());
        assert.ok(state.rocket.x > flying, 'still travelling with the stick in the middle');
        assert.ok(state.rocket.vx > 0 && state.rocket.vx < game.ROCKET.speed, 'and slowing');

        steps(state, game.ROCKET.speed / game.ROCKET.coast + 0.1, input.idle());
        assert.strictEqual(state.rocket.vx, 0, 'and then still');
        const stopped = state.rocket.x;
        steps(state, 0.5, input.idle());
        assert.strictEqual(state.rocket.x, stopped, 'and it stays still');
    });

    it('takes the speed out of it against a wall rather than pressing it there', () => {
        const state = quiet();

        steps(state, 5, asking({ move: { x: 1, y: 0 } }));

        assert.strictEqual(state.rocket.x, state.world.width - state.rocket.size / 2, 'held in the world');
        assert.strictEqual(state.rocket.vx, 0, 'and with nothing left pushing into the wall');
    });
});

describe('what is left of a shape', () => {
    it('comes to pieces as dust off the outline, in its own colour', () => {
        const state = playing();
        state.waves = {};
        const triangle = foes.create(foes.TRIANGLE, 300, 300, 0, game.ROCKET.size, state.random);
        triangle.size = triangle.full;
        state.foes = [triangle];

        game.wound(state, triangle, -1);

        assert.ok(state.grains.length >= dust.LEAST, state.grains.length + ' grains');
        assert.ok(state.grains.every(grain => grain.colour === foes.KIND.triangle.colour));
        const out = state.grains.map(grain => world.between(grain, { x: 300, y: 300 }));
        assert.ok(Math.abs(Math.max(...out) - foes.radius(triangle)) < 1e-6, 'off the line it was drawn on');
        assert.ok(Math.abs(Math.min(...out) - foes.radius(triangle)) < 1e-6, 'all the way round it');
    });

    it('throws the dust outwards, slowing, and then it is gone', () => {
        const grains = dust.burst(0, 0, 20, '#ffffff', 30, rolling(0.5));
        const grain = grains[0];
        const speed = Math.hypot(grain.vx, grain.vy);

        dust.step(grain, 0.1);

        assert.ok(world.between(grain, { x: 0, y: 0 }) > 20, 'further out than the outline');
        assert.ok(Math.hypot(grain.vx, grain.vy) < speed, 'and slowing as it goes');
        assert.deepStrictEqual(dust.settle(grains, dust.LIFE / 1000 * 2), [], 'and swept up when spent');
    });

    it('takes a bigger shape to more of it', () => {
        const small = dust.burst(0, 0, 5, '#fff', 30, rolling(0.5));
        const large = dust.burst(0, 0, 60, '#fff', 30, rolling(0.5));

        assert.ok(large.length > small.length);
        assert.ok(large.length <= dust.MOST && small.length >= dust.LEAST);
    });

    it('leaves the rocket as dust too, and then settles', () => {
        const state = playing();
        state.foes = [foes.create(foes.TRIANGLE, state.rocket.x, state.rocket.y, 0, game.ROCKET.size, state.random)];
        state.foes[0].size = state.foes[0].full;

        game.collide(state);
        assert.strictEqual(state.over, true);
        assert.ok(state.grains.length >= dust.LEAST, 'the wreck');

        game.fade(state, dust.LIFE / 1000 * 2);
        assert.deepStrictEqual(state.grains, []);
    });
});

describe('the levels, and the shower between them', () => {
    it('opens on the first level with no shower running', () => {
        const state = playing();
        assert.strictEqual(state.level, 1);
        assert.strictEqual(state.shower, null);
        assert.deepStrictEqual(state.comets, []);
    });

    it('ends a level with a shower and the shower with the next level', () => {
        const state = playing();
        state.score = game.LEVEL;

        game.stage(state, 1 / 60);
        assert.ok(state.shower, 'a thousand points, and the shower comes first');
        assert.strictEqual(state.shower.span, comets.SPAN);
        assert.strictEqual(state.level, 1, 'the level has not turned over yet');

        for (let at = 0; at < 60 * 11; at++) game.stage(state, 1 / 60);
        assert.strictEqual(state.shower, null, 'ten seconds, and it passes');
        assert.strictEqual(state.level, 2);
        assert.strictEqual(state.waves[foes.SNAKE], game.OPENING, 'and the snake is on its way in');
    });

    it('makes every shower five seconds longer than the one before it', () => {
        const state = playing();
        const spans = [];

        for (let level = 1; level <= 4; level++) {
            state.score = game.LEVEL * level;
            game.stage(state, 1 / 60);
            spans.push(state.shower.span);
            while (state.shower) game.stage(state, 1);
        }

        assert.deepStrictEqual(spans, [10000, 15000, 20000, 25000]);
        assert.strictEqual(state.level, 5);
    });

    it('holds the waves, and their clocks, for as long as a shower runs', () => {
        const state = playing();
        state.shower = comets.shower(1, state.random);
        const waiting = state.waves[foes.TRIANGLE];

        game.arrive(state, 2);

        assert.strictEqual(state.waves[foes.TRIANGLE], waiting, 'the clock did not run');
        assert.deepStrictEqual(state.foes, [], 'and nothing arrived');
    });

    it('rains comets while it runs, and they are not among the foes', () => {
        const state = playing();
        state.shower = comets.shower(1, state.random);

        steps(state, 0);                        // nothing; the shower is driven below
        game.rain(state, 1 / 60);
        assert.strictEqual(state.comets.length, 1, 'the first comes at once');
        assert.deepStrictEqual(state.foes, [], 'and no gun can reach it, because no gun looks here');

        // They are swept up as fast as they arrive once the first has crossed,
        // so what is counted is how many were ever in the sky at once.
        let sky = state.comets.length;
        for (let at = 0; at < 60 * 3; at++) {
            game.rain(state, 1 / 60);
            sky = Math.max(sky, state.comets.length);
        }
        assert.ok(sky >= 3, 'and more behind it: ' + sky);
        assert.ok(state.comets.length > 0, 'still coming');
        assert.ok(state.comets.every(one => one.angle === state.shower.angle), 'all the same way');
    });

    it('lets a laser straight through a comet', () => {
        const state = playing();
        state.rocket.angle = 0;
        state.comets = [{ x: state.rocket.x + 200, y: state.rocket.y, angle: 0, speed: 0, size: 60 }];

        game.fire(state, 1 / 60, asking({ laser: true }));

        assert.strictEqual(state.score, 0);
        assert.ok(state.beam, 'the beam stands, having touched nothing');
        assert.ok(state.beam.to.x > state.rocket.x + 1000, 'and runs its whole length');
    });

    it('ends the game on a comet, all the same', () => {
        const state = playing();
        state.comets = [{ x: state.rocket.x + 10, y: state.rocket.y, angle: 0, speed: 0, size: 40 }];

        game.collide(state);

        assert.strictEqual(state.over, true);
    });

    it('lets the last comets fly out rather than taking them off the screen', () => {
        const state = playing();
        state.score = game.LEVEL;
        game.stage(state, 1 / 60);
        game.rain(state, 1 / 60);
        assert.ok(state.comets.length > 0);

        while (state.shower) game.stage(state, 1);
        assert.ok(state.comets.length > 0, 'the shower is over and they are still in the air');

        for (let at = 0; at < 60 * 3; at++) game.rain(state, 1 / 60);
        assert.deepStrictEqual(state.comets, [], 'and a moment later the sky is clear');
    });
});

describe('a snake, an egg and a mine in the game', () => {
    /** A snake on the field, out of its reveal, with its whole tail out. */
    const laid = state => {
        const snake = foes.create(foes.SNAKE, 300, 300, 0, game.ROCKET.size, state.random);
        snake.waking = 0;
        snake.grown = foes.SPROUT * (foes.TAIL + 1);
        state.foes = [snake];
        return snake;
    };

    it('scores nothing for the tail and everything for the head', () => {
        const state = playing();
        state.waves = {};
        const snake = laid(state);

        game.wound(state, snake, 4);
        assert.strictEqual(state.score, 0, 'a hit in the tail is worth nothing');
        assert.strictEqual(state.foes.length, 1, 'and costs it nothing');
        assert.strictEqual(state.grains.length, 0, 'and nothing came off it');

        game.wound(state, snake, -1);
        assert.strictEqual(state.score, 0, 'a head that is still alive is worth nothing yet');
        const shed = state.grains.length;
        assert.ok(shed >= dust.LEAST * foes.SHED, 'but the two triangles it lost came to pieces');

        for (let hit = 1; hit < foes.KIND.snake.hits; hit++) game.wound(state, snake, -1);

        assert.strictEqual(state.score, foes.KIND.snake.score);
        assert.ok(state.grains.length > shed * 2, 'and the last of it went with the head');
    });

    it('leaves an egg where the head was', () => {
        const state = playing();
        state.waves = {};
        const snake = laid(state);
        for (let hit = 0; hit < foes.KIND.snake.hits; hit++) game.wound(state, snake, -1);

        assert.strictEqual(state.foes.length, 1);
        assert.strictEqual(state.foes[0].kind, foes.EGG);
        assert.deepStrictEqual(
            { x: state.foes[0].x, y: state.foes[0].y }, { x: snake.x, y: snake.y });
    });

    it('pays five hundred for an egg flown into', () => {
        const state = playing();
        state.waves = {};
        const egg = foes.egg(laid(state), game.ROCKET.size, state.random);
        egg.x = state.rocket.x;
        egg.y = state.rocket.y;
        state.foes = [egg];

        game.collide(state);

        assert.strictEqual(state.score, 500);
        assert.strictEqual(state.over, false, 'an egg is a prize, not an obstacle');
        assert.deepStrictEqual(state.foes, []);
    });

    it('takes fifty for one shot, and never takes the score below nothing', () => {
        const state = playing();
        state.waves = {};
        state.score = 60;
        const egg = foes.egg(laid(state), game.ROCKET.size, state.random);
        state.foes = [egg];

        game.wound(state, egg, -1);
        assert.strictEqual(state.score, 10, 'fifty off');

        const another = foes.egg(laid(state), game.ROCKET.size, state.random);
        state.foes = [another];
        game.wound(state, another, -1);
        assert.strictEqual(state.score, 0, 'and no further down than nothing');
    });

    it('lets an egg go unpaid for when its five seconds run out', () => {
        const state = playing();
        state.waves = {};
        const egg = foes.egg(laid(state), game.ROCKET.size, state.random);
        state.foes = [egg];
        state.rocket.x = 20;                    // well away from it

        steps(state, foes.EGG_LIFE / 1000 + 0.2);

        assert.deepStrictEqual(state.foes, [], 'gone');
        assert.strictEqual(state.score, 0, 'and it was never anybody\'s');
    });

    it('leaves a mine out of a broken circle, but not before the third level', () => {
        const state = playing();
        state.waves = {};
        state.level = game.MINES - 1;

        const early = foes.create(foes.CIRCLE, 400, 300, 0, game.ROCKET.size, state.random);
        early.size = early.full;
        state.foes = [early];
        for (let hit = 0; hit < foes.KIND.circle.hits; hit++) game.wound(state, early, -1);
        assert.deepStrictEqual(state.foes, [], 'the second level leaves nothing behind');

        state.level = game.MINES;
        const late = foes.create(foes.CIRCLE, 400, 300, 0, game.ROCKET.size, state.random);
        late.size = late.full;
        state.foes = [late];
        for (let hit = 0; hit < foes.KIND.circle.hits; hit++) game.wound(state, late, -1);

        assert.strictEqual(state.foes.length, 1);
        assert.strictEqual(state.foes[0].kind, foes.MINE);
        assert.deepStrictEqual({ x: state.foes[0].x, y: state.foes[0].y }, { x: 400, y: 300 });
    });

    it('goes off after its fuse, clears the field around it, and pays nothing for it', () => {
        const state = playing();
        state.waves = {};
        state.rocket.x = 1000;
        state.rocket.y = 300;
        const reach = game.ROCKET.size * foes.MINE_BLAST;

        const mine = foes.create(foes.MINE, 300, 300, Math.PI, game.ROCKET.size, state.random);
        mine.fuse = 10;
        const near = foes.create(foes.SQUARE, 340, 300, 0, game.ROCKET.size, state.random);
        const far = foes.create(foes.SQUARE, 300 + reach + 80, 300, 0, game.ROCKET.size, state.random);
        state.foes = [mine, near, far];

        game.move(state, 1 / 60);

        assert.deepStrictEqual(state.foes, [far], 'everything inside it, and nothing outside');
        assert.strictEqual(state.score, 0, 'the mine did it, not the player');
        assert.strictEqual(state.over, false, 'and the rocket was well clear');
        assert.strictEqual(state.flashes.length, 1);
        assert.strictEqual(state.flashes[0].reach, reach, 'the ring is the blast, drawn');
    });

    it('takes the rocket with it when the rocket is inside the blast', () => {
        const state = playing();
        state.waves = {};
        const mine = foes.create(foes.MINE, state.rocket.x + 60, state.rocket.y, 0, game.ROCKET.size, state.random);
        mine.fuse = 10;
        state.foes = [mine];

        game.move(state, 1 / 60);

        assert.strictEqual(state.over, true);
    });

    it('can be shot instead, and then it takes nothing with it', () => {
        const state = playing();
        state.waves = {};
        const mine = foes.create(foes.MINE, 300, 300, 0, game.ROCKET.size, state.random);
        const beside = foes.create(foes.SQUARE, 330, 300, 0, game.ROCKET.size, state.random);
        state.foes = [mine, beside];

        game.wound(state, mine, -1);

        assert.deepStrictEqual(state.foes, [beside], 'the square beside it is untouched');
        assert.strictEqual(state.score, foes.KIND.mine.score);
        assert.deepStrictEqual(state.flashes, [], 'and there was no blast');
    });

    it('leaves an egg out of the bomb\'s way, and clears everything else', () => {
        const state = playing();
        state.waves = {};
        const egg = foes.egg(laid(state), game.ROCKET.size, state.random);
        const square = foes.create(foes.SQUARE, 500, 300, 0, game.ROCKET.size, state.random);
        state.foes = [egg, square];

        game.bomb(state, asking({ emp: true }));

        assert.deepStrictEqual(state.foes, [egg]);
        assert.strictEqual(state.score, foes.KIND.square.score, 'and the egg cost nothing either way');
        assert.strictEqual(state.bombs, weapons.EMP - 1);
    });
});

describe('the painting', () => {
    /** A canvas that takes every call and remembers it. */
    const brush = (without) => {
        const paint = { calls: [], setTransform: () => {}, save: () => {}, restore: () => {} };
        for (const name of ['fillRect', 'strokeRect', 'beginPath', 'arc', 'ellipse', 'fill', 'stroke',
            'moveTo', 'lineTo', 'closePath', 'translate', 'rotate', 'scale', 'rect']) {
            if (name === without) continue;
            paint[name] = (...args) => paint.calls.push({ name, args });
        }
        paint.setTransform = (...args) => paint.calls.push({ name: 'setTransform', args });
        paint.save = () => paint.calls.push({ name: 'save', args: [] });
        paint.restore = () => paint.calls.push({ name: 'restore', args: [] });
        return paint;
    };

    it('sizes the canvas in pixels for the drawing and in CSS for the page', () => {
        const canvas = { style: {} };

        const density = render.fit(canvas, 1000, 600, 3);

        assert.strictEqual(density, 2, 'past two there is nothing left to see');
        assert.strictEqual(canvas.width, 2000);
        assert.strictEqual(canvas.height, 1200);
        assert.strictEqual(canvas.style.width, '1000px');
    });

    it('draws the lot without asking the state a thing it has not got', () => {
        const state = playing();
        state.foes = [
            foes.create(foes.TRIANGLE, 100, 100, 0, game.ROCKET.size, rolling(0.5)),
            foes.create(foes.SQUARE, 200, 200, 1, game.ROCKET.size, rolling(0.5)),
            foes.create(foes.CIRCLE, 300, 300, 2, game.ROCKET.size, rolling(0.5))
        ];
        state.shots = [weapons.torpedo({ x: 10, y: 10 }, 0)];
        state.beam = { from: { x: 0, y: 0 }, to: { x: 50, y: 50 }, angle: 0 };
        state.flashes = [{ x: 5, y: 5, life: 300, full: 600 }];
        const paint = brush();

        render.frame(paint, state, 2);

        assert.ok(paint.calls.some(call => call.name === 'arc'), 'the circle, and the ring');
        assert.ok(paint.calls.some(call => call.name === 'rect'), 'the square');
        assert.ok(paint.calls.filter(call => call.name === 'stroke').length > 4);
        assert.strictEqual(paint.calls.filter(call => call.name === 'save').length,
            paint.calls.filter(call => call.name === 'restore').length, 'and it puts the canvas back');
    });

    it('draws the new kinds too, and the weather and the dust with them', () => {
        const state = playing();
        const snake = foes.create(foes.SNAKE, 200, 200, 0, game.ROCKET.size, rolling(0.5));
        snake.waking = 0;
        snake.grown = foes.SPROUT * (foes.TAIL + 1);
        snake.parts[2].lit = foes.MARK;
        state.foes = [
            snake,
            foes.egg(snake, game.ROCKET.size, rolling(0.5)),
            foes.create(foes.MINE, 400, 400, 0, game.ROCKET.size, rolling(0.5))
        ];
        state.comets = [comets.create(state.world, 0, game.ROCKET.size, 520, rolling(0.5))];
        state.grains = dust.burst(300, 300, 12, '#ffffff', game.ROCKET.size, rolling(0.5));
        const paint = brush();

        render.frame(paint, state, 2);

        const ellipses = paint.calls.filter(call => call.name === 'ellipse');
        assert.strictEqual(ellipses.length, 2, 'the egg and the mine');
        assert.ok(paint.calls.filter(call => call.name === 'arc').length >= comets.PARTS, 'the comet');
        assert.ok(paint.calls.filter(call => call.name === 'fillRect').length >= state.grains.length, 'the dust');
        assert.strictEqual(paint.calls.filter(call => call.name === 'fill').length, 2,
            'the rocket\'s nose, and the one tail triangle that was just shot');
        assert.strictEqual(paint.calls.filter(call => call.name === 'save').length,
            paint.calls.filter(call => call.name === 'restore').length, 'and it puts the canvas back');
    });

    it('draws the snake from the far end of the tail forwards, so the body laps over itself', () => {
        const snake = foes.create(foes.SNAKE, 200, 200, 0, game.ROCKET.size, rolling(0.5));
        snake.waking = 0;
        snake.grown = foes.SPROUT * (foes.TAIL + 1);
        snake.parts.forEach((part, at) => { part.x = 200 - at * 10; part.y = 200; });
        const paint = brush();

        render.snake(paint, snake, foes.KIND.snake);

        const put = paint.calls.filter(call => call.name === 'translate').map(call => call.args[0]);
        assert.strictEqual(put.length, foes.TAIL + 1);
        assert.strictEqual(put[0], 200 - (foes.TAIL - 1) * 10, 'the far end of the tail first');
        assert.strictEqual(put[put.length - 1], 200, 'and the head last, over the lot of it');
    });

    it('draws an oval as a scaled circle on a canvas with no ellipse', () => {
        const paint = brush('ellipse');

        render.oval(paint, 10, 20, 8, 4, 0);

        assert.ok(paint.calls.some(call => call.name === 'scale'), 'the long way round');
        assert.ok(paint.calls.some(call => call.name === 'arc'));
    });

    it('grows a ring to the reach it was given, so a blast is drawn its own size', () => {
        const paint = brush();

        render.flash(paint, { x: 0, y: 0, life: 1, full: 600, reach: 150 });

        const ring = paint.calls.find(call => call.name === 'arc');
        assert.ok(ring.args[2] <= 150 && ring.args[2] > 140, 'at nearly its whole reach: ' + ring.args[2]);
    });
});

describe('the writing', () => {
    /** A canvas that remembers the rectangles, which is all the font draws. */
    const brush = () => {
        const paint = { fillStyle: '', shadowBlur: 0, rects: [] };
        paint.fillRect = (x, y, w, h) => paint.rects.push({ x, y, w, h, fill: paint.fillStyle });
        return paint;
    };

    it('reads the font the way the table is written: the low bit at the left', () => {
        const rows = text.glyph('A');
        const lit = row => {
            let out = '';
            for (let column = 0; column < 8; column++) out += (rows[row] & (1 << column)) ? '#' : '.';
            return out;
        };

        assert.strictEqual(lit(0), '..##....');
        assert.strictEqual(lit(2), '##..##..');
        assert.strictEqual(lit(4), '######..');
    });

    it('falls back to the blank for anything the font has not got', () => {
        assert.deepStrictEqual(text.glyph('\u00e9'), text.glyph(' '));
    });

    it('measures a line as eight dots to the letter', () => {
        assert.strictEqual(text.width('ABC', 1), 24);
        assert.strictEqual(text.width('ABC', 4), 96);
    });

    it('draws a run of dots as one rectangle rather than one each', () => {
        const paint = brush();

        text.draw(paint, 'A', 0, 0, 2, '#fff');

        const top = paint.rects.filter(rect => rect.y === 0);
        assert.strictEqual(top.length, 1, 'the two dots at the top of an A are one run');
        assert.strictEqual(top[0].x, 4, 'starting at the third column');
        assert.ok(top[0].w > 2 && top[0].w <= 4, 'two dots wide, less the gap');
        assert.ok(paint.rects.every(rect => rect.fill === '#fff'));
    });

    it('centres a line on a point', () => {
        const paint = brush();

        text.centre(paint, 'AB', 100, 0, 1, '#fff');

        assert.ok(paint.rects.every(rect => rect.x >= 92 && rect.x <= 108), 'sixteen dots wide, about 100');
    });
});

describe('the cards', () => {
    const lines = card => card.lines.map(line => line.text);

    it('says on the welcome what presses what, both guns on the triggers', () => {
        const said = lines(screens.welcome());

        assert.strictEqual(said[0], 'GRINDER');
        assert.ok(said.some(line => /^L2\s+TORPEDO/.test(line)), said.join(' | '));
        assert.ok(said.some(line => /^R2\s+LASER/.test(line)));
        assert.ok(said.includes('PRESS START'), 'and Start is the only thing to press');
        assert.ok(!said.some(line => /HIGH SCORES/.test(line)), 'no button to the table any more');
    });

    it('pads its columns to one length so centred lines line up', () => {
        const rows = screens.columns([['LEFT STICK', 'FLY'], ['B', 'EMP BOMB']]);

        assert.strictEqual(rows[0].length, rows[1].length);
        assert.strictEqual(rows[1].indexOf('EMP'), rows[0].indexOf('FLY'), 'the right column starts in one place');
    });

    it('writes the table with the initials that were spelt for it', () => {
        const said = lines(screens.scores([{ score: 4321, who: 'NEB' }, { score: 10, who: '' }]));

        assert.match(said[1], /1 +NEB +4321/);
        assert.match(said[2], /2 +--- +10/, 'and dashes for a score that was never asked');
    });

    it('says the table is empty when it is', () => {
        assert.ok(lines(screens.scores([])).includes('NONE YET'));
    });

    it('says what a game came to and where it put it', () => {
        assert.ok(lines(screens.over({ score: 900, place: 1, of: 3 })).includes('A NEW BEST'));
        assert.ok(lines(screens.over({ score: 900, place: 2, of: 3 })).includes('NUMBER 2 OF 3'));
        assert.ok(lines(screens.over({ score: 90, place: 0 })).includes('NOT ONE FOR THE TABLE'));
    });

    it('puts the mark under the letter being spelt', () => {
        const said = lines(screens.initials({ letters: ['N', 'E', 'B'], at: 1, score: 40 }));
        const letters = said[2];
        const caret = said[3];

        assert.strictEqual(letters, 'N E B');
        assert.strictEqual(caret.length, letters.length, 'the same length, so centring aligns them');
        assert.strictEqual(caret.indexOf('^'), 2, 'under the middle letter');
    });


    it('says on the welcome what every shape is worth, new ones and old', () => {
        const said = lines(screens.welcome());

        assert.ok(said.some(line => /^TRIANGLE\s+5\s*$/.test(line)), said.join(' | '));
        assert.ok(said.some(line => /^MINE\s+50\s*$/.test(line)));
        assert.ok(said.some(line => /^SNAKE HEAD\s+250\s*$/.test(line)));
        assert.ok(said.some(line => /^EGG CAUGHT\s+500\s*$/.test(line)));
    });

    it('says on the welcome that there are levels, and weather between them', () => {
        const said = lines(screens.welcome());

        assert.ok(said.includes('A LEVEL EVERY ' + game.LEVEL + ' POINTS'), said.join(' | '));
        assert.ok(said.some(line => /COMET SHOWER/.test(line)));
    });

    it('counts a shower down to the second', () => {
        assert.strictEqual(screens.shower({ left: 10000 }), 'COMET SHOWER 10');
        assert.strictEqual(screens.shower({ left: 4200 }), 'COMET SHOWER 5');
        assert.strictEqual(screens.shower({ left: -20 }), 'COMET SHOWER 0', 'and never past nothing');
    });


    it('writes the score, the level, and a shower while one is running', () => {
        const said = [];
        const drawing = text.draw;
        const centring = text.centre;
        text.draw = (paint, line) => said.push(line);
        text.centre = (paint, line) => said.push(line);

        try {
            const state = playing();
            state.score = 1200;
            state.level = 2;

            screens.hud({ shadowBlur: 0 }, state, 8000, { width: 1000, height: 600 });
            assert.ok(said.includes('SCORE 1200'), said.join(' | '));
            assert.ok(said.includes('LEVEL 2'));
            assert.ok(said.some(line => /BEST 8000/.test(line) && /EMP 2/.test(line)));
            assert.ok(!said.some(line => /COMET/.test(line)), 'and nothing about weather in fair weather');

            said.length = 0;
            state.shower = comets.shower(1, state.random);
            screens.hud({ shadowBlur: 0 }, state, 8000, { width: 1000, height: 600 });
            assert.ok(said.includes('COMET SHOWER 10'), said.join(' | '));
        } finally {
            text.draw = drawing;
            text.centre = centring;
        }
    });

    it('tells the keys apart from the pad on the last line of the welcome', () => {
        assert.match(screens.hands({ pad: false }), /KEYS/);
        assert.strictEqual(screens.hands({ pad: true, pressing: [] }), 'PAD CONNECTED');
        assert.strictEqual(screens.hands({ pad: true, pressing: [6, 7] }), 'PAD  L2 R2');
    });

    it('sizes a card to the window it is going into, and never past the biggest', () => {
        const card = screens.welcome();

        const phone = screens.fit(card, { width: 400, height: 800 });
        const television = screens.fit(card, { width: 3840, height: 2160 });

        assert.ok(phone >= 1 && phone < 3, 'small enough to fit across a phone: ' + phone);
        assert.ok(screens.tall(card, phone) <= 800, 'and down it');
        assert.ok(television > phone && television <= screens.BIGGEST, 'and larger where there is room');
        // The welcome is twenty lines long and a television runs out of height
        // before it runs out of cap; a short card is what the cap is for.
        assert.strictEqual(screens.fit(screens.paused(), { width: 3840, height: 2160 }), screens.BIGGEST);
    });
});

describe('the page', () => {
    it('opens on the welcome card, over the world it is played in', () => {
        const page = loadGrinder();

        assert.strictEqual(page.app.screen, 'welcome');
        assert.deepStrictEqual(Array.from(page.app.rotation), ['welcome', 'scores']);
        page.frame();
        assert.ok(page.paint().calls.length > 100, 'the dots, and the writing over them');
    });

    it('sends a browser with no canvas to the error page', () => {
        const page = loadGrinder({ canvas: false });

        assert.strictEqual(page.window.location.href, './error.html');
        assert.strictEqual(page.app.state, null, 'and starts nothing');
    });

    it('turns the cards over by itself, and there is no button to press', () => {
        const page = loadGrinder({ scores: [{ score: 300, at: '2026-09-14', who: 'NEB' }] });

        page.run(1000);
        assert.strictEqual(page.app.screen, 'welcome');

        page.run(6000);
        assert.strictEqual(page.app.screen, 'scores', 'the table comes round on its own');
        assert.ok(page.card().some(line => /NEB/.test(line)), 'and it has been read out of the store');

        page.run(6100);
        assert.strictEqual(page.app.screen, 'welcome', 'and back again');
    });

    it('starts a game on Start', () => {
        const page = loadGrinder();

        page.press(9);

        assert.strictEqual(page.app.screen, 'playing');
        assert.strictEqual(page.app.state.score, 0);
        assert.strictEqual(page.app.state.bombs, 2);
    });

    it('starts one from the keyboard too, since a keyboard has no Start', () => {
        for (const key of ['enter', ' ']) {
            const page = loadGrinder();
            page.frame();

            page.key.down(key);
            page.frame();

            assert.strictEqual(page.app.screen, 'playing', 'on ' + JSON.stringify(key));
        }
    });

    it('starts one from the game over card too', () => {
        const page = loadGrinder({
            scores: [50000, 40000, 30000, 20000, 10000].map(score => ({ score, at: '', who: 'ZZZ' }))
        });
        page.press(9);
        page.app.state.score = 10;
        page.app.state.over = true;
        page.run(1000);
        assert.strictEqual(page.app.screen, 'over', 'no initials for sixth place');

        page.press(9);

        assert.strictEqual(page.app.screen, 'playing');
        assert.strictEqual(page.app.state.score, 0);
    });

    it('asks three letters of a score in the top five, and keeps them', () => {
        const page = loadGrinder();
        page.press(9);
        page.app.state.score = 4321;
        page.app.state.over = true;
        page.run(1000);

        assert.strictEqual(page.app.screen, 'initials');
        assert.strictEqual(page.app.entry.letters.join(''), 'AAA');

        page.press(13);                     // down: A to B
        page.press(15);                     // right, to the second letter
        page.press(13); page.press(13);     // down twice: A to C
        page.press(9);                      // Start: done with it

        assert.strictEqual(page.app.screen, 'over');
        assert.strictEqual(page.stored().length, 1);
        assert.strictEqual(page.stored()[0].score, 4321);
        assert.strictEqual(page.stored()[0].who, 'BCA');
        assert.ok(page.card().includes('A NEW BEST'));
    });

    it('asks nothing of a score too low for the top five', () => {
        const page = loadGrinder({
            scores: [500, 400, 300, 200, 100].map(score => ({ score, at: '', who: 'ZZZ' }))
        });
        page.press(9);
        page.app.state.score = 50;
        page.app.state.over = true;

        page.run(1000);

        assert.strictEqual(page.app.screen, 'over');
        assert.strictEqual(page.stored().length, 6);
        assert.strictEqual(page.stored()[5].who, '---');
    });

    it('lets the letters be typed as well as spelt on the stick', () => {
        const page = loadGrinder();
        page.press(9);
        page.app.state.score = 4321;
        page.app.state.over = true;
        page.run(1000);

        for (const key of ['n', 'e', 'b']) { page.key.down(key); page.key.up(key); }
        page.frame();

        assert.strictEqual(page.app.entry.letters.join(''), 'NEB');
    });

    it('turns the game over card, the welcome and the table over after a game', () => {
        const page = loadGrinder({
            scores: [50000, 40000, 30000, 20000, 10000].map(score => ({ score, at: '', who: 'ZZZ' }))
        });
        page.press(9);
        page.app.state.score = 10;
        page.app.state.over = true;
        page.run(1000);

        assert.strictEqual(page.app.screen, 'over');
        page.run(6100);
        assert.strictEqual(page.app.screen, 'welcome');
        page.run(6100);
        assert.strictEqual(page.app.screen, 'scores');
        page.run(6100);
        assert.strictEqual(page.app.screen, 'over', 'and round again');
    });

    it('holds the game on Escape and lets it go again', () => {
        const page = loadGrinder();
        page.press(9);
        page.frame();
        const was = page.app.state.time;

        page.key.down('escape');
        page.run(200);
        assert.strictEqual(page.app.paused, true);
        assert.strictEqual(page.app.state.time, was, 'and the clock stops with it');
        assert.ok(page.of('screens').paused().lines.some(line => line.text === 'HELD'),
            'and the card over it says so');

        // A frame between the two, as there would be in a browser: the key must
        // be seen to come up before it can be seen to go down again.
        page.key.up('escape');
        page.run(50);
        page.key.down('escape');
        page.run(200);
        assert.strictEqual(page.app.paused, false);
        assert.ok(page.app.state.time > was);
    });

    it('holds the game when the window is left', () => {
        const page = loadGrinder();
        page.press(9);

        page.window.dispatch('blur');

        assert.strictEqual(page.app.paused, true);
    });

    it('keeps the game to the window when the window changes size', () => {
        const page = loadGrinder();
        page.press(9);

        page.window.innerWidth = 500;
        page.window.innerHeight = 400;
        page.window.dispatch('resize');

        assert.strictEqual(page.app.state.world.width, 600);
        assert.strictEqual(page.field.width, 1000, 'at twice the density of the screen');
    });

    it('flies the rocket from the pad, once a game is on', () => {
        const page = loadGrinder();
        page.press(9);
        const was = page.app.state.rocket.x;

        page.pad([1, 0, 0, 0], {});
        page.run(500);

        assert.ok(page.app.state.rocket.x > was, 'the left stick flew it');
    });

    it('plays a comet shower and the level after it, and draws the lot', () => {
        const page = loadGrinder();
        page.press(9);
        page.app.state.foes.length = 0;
        page.app.state.waves = {};
        page.app.state.score = page.of('game').LEVEL;

        page.run(1000);
        assert.ok(page.app.state.shower, 'the shower is on');
        assert.ok(page.app.state.comets.length > 0, 'with weather in it');
        const drawn = page.paint().calls.length;
        assert.ok(drawn > 100, 'and it is being drawn');

        // Comets drawn to nothing, so the shower can be sat out rather than
        // flown: what is under test here is the turn of the level, not a dodge.
        page.of('game').ROCKET.size = 0;
        page.run(11000);
        assert.strictEqual(page.app.screen, 'playing');
        assert.strictEqual(page.app.state.shower, null);
        assert.strictEqual(page.app.state.level, 2);
        page.run(3000);
        assert.strictEqual(page.app.state.comets.length, 0, 'and the last of them fly out after it');
    });

    it('fires torpedoes off L2', () => {
        const page = loadGrinder();
        page.press(9);
        page.app.state.foes.length = 0;
        page.pad([0, 0, 0, 0], { 6: true });

        const fired = new Set();
        for (let frame = 0; frame < 120; frame++) {
            page.frame(16);
            page.app.state.shots.forEach(shot => fired.add(shot));
        }

        assert.ok(fired.size >= 3, 'two a second at the start, not ' + fired.size);
    });
});
