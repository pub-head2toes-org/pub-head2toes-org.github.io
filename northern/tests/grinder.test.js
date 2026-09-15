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
const { world, foes, weapons, input, scores, game, render, text, screens } = (function () {
    const source = [
        read('font.js'), read('text.js'), read('world.js'), read('foes.js'), read('weapons.js'),
        read('input.js'), read('scores.js'), read('game.js'), read('render.js'), read('screens.js'),
        'return { world, foes, weapons, input, scores, game, render, text, screens };'
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
        assert.strictEqual(foes.KIND.circle.score, 100);
    });

    it('measure themselves against the rocket: a triangle half of it, a circle all of it', () => {
        const triangle = foes.create(foes.TRIANGLE, 0, 0, 0, 40, rolling(0.5));
        const circle = foes.create(foes.CIRCLE, 0, 0, 0, 40, rolling(0.5));

        assert.strictEqual(triangle.full, 20);
        assert.strictEqual(circle.full, 40);
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
        assert.strictEqual(circle.size, 30, 'a quarter off');
        assert.strictEqual(foes.hit(circle), false);
        assert.strictEqual(foes.hit(circle), false);
        assert.strictEqual(circle.size, 10);
        assert.strictEqual(foes.hit(circle), true, 'the fourth is the last');
        assert.strictEqual(circle.dead, true);
    });

    it('a circle mends itself, slowly, after it has been hit', () => {
        const field = { world: world.create(1000, 600, rolling(0.5)), pace: 1, random: rolling(0.5) };
        const circle = foes.create(foes.CIRCLE, 500, 300, 0, 40, rolling(0.5));
        circle.size = circle.full;
        foes.hit(circle);

        foes.step(circle, 1, field);

        assert.ok(circle.size > 30, 'growing back');
        assert.ok(circle.size < 40, 'but not all at once');
    });

    it('takes the mending back off it when the next hit lands before a whole quarter is back', () => {
        const field = { world: world.create(1000, 600, rolling(0.5)), pace: 1, random: rolling(0.5) };
        const circle = foes.create(foes.CIRCLE, 500, 300, 0, 40, rolling(0.5));
        circle.size = circle.full;
        foes.hit(circle);                       // 30 left
        foes.step(circle, 1, field);            // a third of a quarter back

        foes.hit(circle);

        assert.ok(Math.abs(circle.size - 20) < 0.001, 'the mending and a quarter, both gone');
    });

    it('lets it keep a quarter it has had the time to mend in full', () => {
        const field = { world: world.create(1000, 600, rolling(0.5)), pace: 1, random: rolling(0.5) };
        const circle = foes.create(foes.CIRCLE, 500, 300, 0, 40, rolling(0.5));
        circle.size = circle.full;
        foes.hit(circle);                       // 30 left
        foes.step(circle, foes.MEND / 1000, field);   // a whole quarter back, and earned

        assert.ok(Math.abs(circle.size - 40) < 0.001);
        foes.hit(circle);
        assert.ok(Math.abs(circle.size - 30) < 0.001, 'only the quarter this time');
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

describe('the guns', () => {
    it('start the laser at a shot a second and the torpedoes at two, as asked', () => {
        assert.strictEqual(weapons.LASER.every, 1000);
        assert.strictEqual(weapons.TORPEDO.every, 500);
    });

    it('halve the wait every thousand points, and stop at twenty milliseconds', () => {
        assert.strictEqual(weapons.every(1000, 0), 1000);
        assert.strictEqual(weapons.every(1000, 1000), 500);
        assert.strictEqual(weapons.every(1000, 2000), 250);
        assert.strictEqual(weapons.every(1000, 1000000), weapons.FLOOR);
    });

    it('stops a beam at the nearest thing in its path and lets the rest be', () => {
        const near = foes.create(foes.CIRCLE, 200, 0, 0, 40, rolling(0.5));
        const far = foes.create(foes.CIRCLE, 400, 0, 0, 40, rolling(0.5));
        const beside = foes.create(foes.CIRCLE, 300, 300, 0, 40, rolling(0.5));
        for (const one of [near, far, beside]) one.size = one.full;

        const hit = weapons.strike({ x: 0, y: 0 }, 0, 4000, [beside, far, near]);

        assert.strictEqual(hit.target, near);
        assert.ok(Math.abs(hit.at - 180) < 0.001, 'at the near edge of it, not its middle');
        assert.strictEqual(weapons.strike({ x: 0, y: 0 }, Math.PI, 4000, [near, far]), null, 'nothing behind');
    });

    it('hits with a torpedo that crossed a foe between two frames', () => {
        const foe = foes.create(foes.TRIANGLE, 100, 0, 0, 40, rolling(0.5));
        foe.size = foe.full;                    // ten across, and a torpedo moves further than that
        const shot = weapons.torpedo({ x: 0, y: 0 }, 0);

        weapons.fly(shot, 1);                   // straight past it, in one step

        assert.ok(shot.x > 200, 'well beyond it');
        assert.strictEqual(weapons.struck(shot, [foe]), foe, 'and still counted');
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
            game.step(state, 1 / 60, input.idle());
        }

        assert.ok(state.foes.length <= foes.CROWD, state.foes.length + ' on the field');
        assert.ok(state.foes.length >= foes.CROWD - 10, 'and it is the cap that stopped it, not a quiet sky');
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

describe('the painting', () => {
    /** A canvas that takes every call and remembers it. */
    const brush = () => {
        const paint = { calls: [], setTransform: () => {}, save: () => {}, restore: () => {} };
        for (const name of ['fillRect', 'strokeRect', 'beginPath', 'arc', 'fill', 'stroke', 'moveTo',
            'lineTo', 'closePath', 'translate', 'rotate', 'rect']) {
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
        assert.strictEqual(television, screens.BIGGEST, 'and no dot is ever bigger than this');
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
