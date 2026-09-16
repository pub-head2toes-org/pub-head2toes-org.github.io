'use strict';

/**
 * The comet shower: what comes between one level and the next.
 *
 * A shower is a lull with teeth. No wave arrives while it is running and
 * nothing new can be shot down, because a comet cannot be shot down - it is
 * weather, not a foe, and it is in a different list from the foes for exactly
 * that reason. What there is to do is fly, and the only way through is out of
 * the way.
 *
 * All the comets of one shower travel the same heading, drawn once when the
 * shower begins, and they come in off one edge and go out of the other: they
 * are the only things in this game that leave the world rather than bouncing
 * off it. Each is five white circles, the largest at the front, each sitting
 * part of the way along the one before it, so the tail reads as a streak
 * rather than as five separate dots.
 *
 * Nothing here draws and nothing here reads a clock of its own.
 */
const comets = {};

comets.PARTS = 5;            // circles to a comet, head first
comets.HEAD = 0.75;          // the leading circle's diameter, as a share of the rocket
comets.TAPER = 0.8;          // each circle against the one in front of it
comets.OVERLAP = 0.62;       // how far back the next circle sits, in radii of this one
comets.SLOW = 2;             // slowest, in the rocket's own top speed
comets.FAST = 3;             // and fastest
comets.SPAN = 10000;         // ms the first shower lasts
comets.LONGER = 5000;        // ms every shower after it adds to that
comets.SOON = 260;           // ms between one comet and the next, at the least
comets.LATER = 820;          // and at the most - sparse, as asked
comets.COLOUR = '#f7f7ff';
comets.EDGE = 4;             // rockets' sizes of room a comet is launched and swept up beyond

/**
 * A shower, numbered from one.
 *
 * Each one lasts five seconds longer than the last, so the tenth is a minute
 * of flying and the first is ten seconds of it. The heading is drawn here and
 * every comet of the shower is given it, which is what makes them parallel.
 */
comets.shower = function (number, random) {
    const roll = random || Math.random;
    const span = comets.SPAN + Math.max(0, number - 1) * comets.LONGER;
    return {
        number: Math.max(1, number),
        angle: roll() * Math.PI * 2,
        span: span,
        left: span,
        next: 0                  // the first one comes at once
    };
};

/** How long until the next comet of a shower. */
comets.gap = function (random) {
    const roll = random || Math.random;
    return comets.SOON + roll() * (comets.LATER - comets.SOON);
};

/**
 * How far out of the middle of the world a comet is launched, and forgotten.
 *
 * Past the corner of it, so a comet is already at speed by the time it is on
 * screen and is only swept up once the whole of it is off the far side. The one
 * number serves both ends of the flight, which is what keeps a comet from being
 * thrown away in the same breath it was launched in.
 */
comets.reach = function (field, scale) {
    return Math.hypot(field.width, field.height) / 2 + scale * comets.EDGE;
};

/**
 * One comet, launched from outside the world.
 *
 * It starts on the line the shower's heading comes in on and somewhere at
 * random along that line, which is what scatters a shower that is otherwise all
 * one direction.
 */
comets.create = function (field, angle, scale, speed, random) {
    const roll = random || Math.random;
    const reach = comets.reach(field, scale);
    const across = (roll() * 2 - 1) * reach;
    return {
        x: field.width / 2 - Math.cos(angle) * reach - Math.sin(angle) * across,
        y: field.height / 2 - Math.sin(angle) * reach + Math.cos(angle) * across,
        angle: angle,
        speed: speed * (comets.SLOW + roll() * (comets.FAST - comets.SLOW)),
        size: scale * comets.HEAD
    };
};

/** One step of a comet's flight. It steers nothing and it bounces off nothing. */
comets.step = function (comet, seconds) {
    comet.x += Math.cos(comet.angle) * comet.speed * seconds;
    comet.y += Math.sin(comet.angle) * comet.speed * seconds;
    return comet;
};

/**
 * True once a comet is far enough past the world to be forgotten - measured out
 * of the middle, as it was launched, so the far side is as generous as the near
 * one whichever way the shower happens to be running.
 */
comets.gone = function (field, comet, scale) {
    const out = Math.hypot(comet.x - field.width / 2, comet.y - field.height / 2);
    return out > comets.reach(field, scale || comet.size) + comets.length(comet);
};

/**
 * The circles a comet is made of: where each sits and how big it is.
 *
 * The head leads and each one after it is smaller and sits back along the
 * heading, overlapping the one in front. This is what is drawn and it is also
 * what the rocket is tested against - the streak is as solid as the head.
 */
comets.spots = function (comet) {
    const spots = [];
    const back = { x: -Math.cos(comet.angle), y: -Math.sin(comet.angle) };
    let radius = comet.size / 2;
    let at = 0;

    for (let part = 0; part < comets.PARTS; part++) {
        spots.push({ x: comet.x + back.x * at, y: comet.y + back.y * at, radius: radius });
        at += radius * comets.OVERLAP * 2;
        radius *= comets.TAPER;
    }
    return spots;
};

/** Head to tail, for knowing when the whole of it is out of the world. */
comets.length = function (comet) {
    const spots = comets.spots(comet);
    const last = spots[spots.length - 1];
    return Math.hypot(last.x - comet.x, last.y - comet.y) + last.radius;
};
