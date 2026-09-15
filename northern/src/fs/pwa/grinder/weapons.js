'use strict';

/**
 * The guns.
 *
 * Both fire out of the point of the little red triangle at the rocket's nose,
 * along whatever the rocket is pointing at, and both work their way down to a
 * shot every twenty milliseconds as the score climbs - the laser from a shot a
 * second, the torpedoes from two. What they do once they have left is the
 * difference.
 *
 * The laser is a line, not a thing in flight. It is drawn from the nose to the
 * first foe in its path - or off the edge of the world when there is none -
 * and it stays there for as long as it is touching nothing. The frame it
 * touches something, that is the hit: the line goes out and the gun is cooling
 * until the wait has passed. So a laser held on an empty sky is one long beam
 * and no shots at all, and a laser held on a crowd is a hit every cooling
 * period.
 *
 * A torpedo is the other way about: each one is its own object with a place, a
 * heading and a speed, and once it is away the rocket has nothing more to do
 * with it. It is tested against the foes over the line it crossed this frame
 * rather than where it landed, because at seven hundred pixels a second it can
 * cross a triangle between two frames without ever being inside one.
 */
const weapons = {};

weapons.LASER = { every: 1000, colour: '#ff2d2d', width: 2.5 };
weapons.TORPEDO = { every: 500, colour: '#ff8c1a', speed: 720, length: 16, width: 5 };
weapons.FLOOR = 20;          // ms - as fast as either gun will ever fire
weapons.HALVING = 1000;      // points that halve the wait between shots
weapons.EMP = 2;             // bombs in the rack at the start
weapons.FLASH = 600;         // ms an EMP's ring takes to cross the screen

/**
 * The wait between shots, for a score: a second to begin with, halved every
 * thousand points, and never shorter than the floor.
 */
weapons.every = function (base, score) {
    return Math.max(weapons.FLOOR, base * Math.pow(0.5, Math.max(0, score) / weapons.HALVING));
};

/**
 * How far along a line a circle is first met, or -1 for not at all.
 *
 * One piece of arithmetic for both guns: the laser asks it over a very long
 * line and takes the nearest answer, a torpedo asks it over the hand's breadth
 * it moved this frame. Both are then hitting the same shapes by the same rule.
 */
weapons.reach = function (from, dx, dy, length, centre, radius) {
    const ox = from.x - centre.x;
    const oy = from.y - centre.y;
    const half = ox * dx + oy * dy;
    const outside = ox * ox + oy * oy - radius * radius;
    const under = half * half - outside;
    if (under < 0) return -1;

    const root = Math.sqrt(under);
    let at = -half - root;
    if (at < 0) at = -half + root;
    if (at < 0 || at > length) return -1;
    return at;
};

/**
 * The first foe a beam from here meets, with the point it met it at. Nothing
 * in the way gives back null and the beam is drawn its full length.
 */
weapons.strike = function (from, angle, length, targets) {
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    let best = null;

    for (const target of targets) {
        if (target.dead) continue;
        const at = weapons.reach(from, dx, dy, length, target, foes.radius(target));
        if (at < 0) continue;
        if (!best || at < best.at) best = { target: target, at: at };
    }
    if (!best) return null;
    return { target: best.target, at: best.at, x: from.x + dx * best.at, y: from.y + dy * best.at };
};

/** A torpedo, away. It remembers where it was as well as where it is. */
weapons.torpedo = function (from, angle) {
    return {
        x: from.x, y: from.y,
        was: { x: from.x, y: from.y },
        angle: angle,
        speed: weapons.TORPEDO.speed,
        spent: false
    };
};

/** One step of a torpedo's flight. */
weapons.fly = function (shot, seconds) {
    shot.was.x = shot.x;
    shot.was.y = shot.y;
    shot.x += Math.cos(shot.angle) * shot.speed * seconds;
    shot.y += Math.sin(shot.angle) * shot.speed * seconds;
    return shot;
};

/**
 * The first foe a torpedo went through this frame, over the line from where it
 * was to where it is, so nothing is passed through unnoticed.
 */
weapons.struck = function (shot, targets) {
    const dx = shot.x - shot.was.x;
    const dy = shot.y - shot.was.y;
    const length = Math.hypot(dx, dy);
    if (length === 0) return null;
    const hit = weapons.strike(shot.was, Math.atan2(dy, dx), length, targets);
    return hit ? hit.target : null;
};
