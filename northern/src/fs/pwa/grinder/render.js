'use strict';

/**
 * The painting.
 *
 * One pass over the state, back to front: the dots, the shots, the foes, the
 * rocket, whatever an EMP left ringing. Nothing here decides anything - it is
 * handed a state that has already been moved and only says what it looks like.
 *
 * The whole scene is drawn in world coordinates with the canvas shifted by the
 * camera, so not one of these functions has to take the scroll into account.
 * That shift is also the only place the screen and the world meet, which is
 * what keeps `world.js` free of pixels.
 *
 * Everything is drawn as lines rather than filled shapes, lit by a shadow of
 * its own colour. It is a cheap trick and it is the whole look of the thing:
 * a vector screen, where a shape is bright at its edge and dark in the middle.
 * The three exceptions all mean something by it: the red triangle in the
 * rocket's nose is filled so the heading reads at a glance, a struck triangle of
 * a snake's tail is filled for a moment to say the shot landed and did nothing,
 * and dust is filled because a grain of dust has no outline.
 */
const render = {};

render.GLOW = 10;
render.ROCKET = '#ffffff';
render.TIP = '#ff2d2d';
render.LIT = 0.55;           // how bright the inside of a struck tail triangle goes

/**
 * Matches the canvas to the screen, at the density of the screen.
 *
 * The canvas is sized twice: in pixels for the drawing and in CSS for the
 * layout. Miss the first and a retina screen draws a soft picture at a quarter
 * of the resolution it has; miss the second and the element is the wrong size
 * on the page altogether.
 */
render.fit = function (canvas, width, height, ratio) {
    const density = Math.min(ratio || 1, 2);      // past two there is nothing left to see
    canvas.width = Math.round(width * density);
    canvas.height = Math.round(height * density);
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    return density;
};

/** The frame. */
render.frame = function (paint, state, density) {
    const view = state.world.view;

    paint.setTransform(density, 0, 0, density, 0, 0);
    paint.fillStyle = '#05060a';
    paint.fillRect(0, 0, view.width, view.height);

    paint.save();
    paint.translate(-state.world.camera.x, -state.world.camera.y);

    render.dots(paint, state.world);
    render.edge(paint, state.world);
    for (const grain of state.grains) render.grain(paint, grain);
    for (const shot of state.shots) render.shot(paint, shot);
    if (state.beam) render.beam(paint, state.beam);
    for (const foe of state.foes) render.foe(paint, foe);
    for (const comet of state.comets) render.comet(paint, comet);
    if (!state.over) render.rocket(paint, state.rocket);
    for (const flash of state.flashes) render.flash(paint, flash);

    paint.restore();
    paint.setTransform(1, 0, 0, 1, 0, 0);
};

/** The sprinkle. Squares rather than circles: a hundred arcs a frame add up. */
render.dots = function (paint, field) {
    paint.shadowBlur = 0;
    for (const dot of field.dots) {
        paint.fillStyle = dot.colour;
        paint.fillRect(dot.x, dot.y, dot.size, dot.size);
    }
};

/** The edge of the world, so it is plain where the flying stops. */
render.edge = function (paint, field) {
    paint.shadowBlur = 0;
    paint.strokeStyle = 'rgba(80, 120, 200, 0.35)';
    paint.lineWidth = 2;
    paint.strokeRect(1, 1, field.width - 2, field.height - 2);
};

/** A torpedo: a short bold line, lying along the way it is going. */
render.shot = function (paint, shot) {
    const half = weapons.TORPEDO.length / 2;
    const dx = Math.cos(shot.angle) * half;
    const dy = Math.sin(shot.angle) * half;
    render.glow(paint, weapons.TORPEDO.colour, weapons.TORPEDO.width);
    paint.beginPath();
    paint.moveTo(shot.x - dx, shot.y - dy);
    paint.lineTo(shot.x + dx, shot.y + dy);
    paint.stroke();
};

/** The laser: nose to whatever stopped it. */
render.beam = function (paint, beam) {
    render.glow(paint, weapons.LASER.colour, weapons.LASER.width);
    paint.beginPath();
    paint.moveTo(beam.from.x, beam.from.y);
    paint.lineTo(beam.to.x, beam.to.y);
    paint.stroke();
};

/** A foe, in the shape it is named for. */
render.foe = function (paint, foe) {
    const shape = foes.KIND[foe.kind];
    const radius = foes.radius(foe);
    if (radius <= 0) return;

    if (foe.kind === foes.SNAKE) return render.snake(paint, foe, shape);
    if (foe.kind === foes.EGG) return render.egg(paint, foe, shape);
    if (foe.kind === foes.MINE) return render.mine(paint, foe, shape);

    render.glow(paint, shape.colour, 2);
    if (foe.kind === foes.CIRCLE) {
        paint.beginPath();
        paint.arc(foe.x, foe.y, radius, 0, Math.PI * 2);
        paint.stroke();
        return;
    }

    paint.save();
    paint.translate(foe.x, foe.y);
    if (foe.kind === foes.TRIANGLE) {
        // The point is the heading: a triangle goes where it is looking.
        paint.rotate(foe.angle);
        render.arrow(paint, radius);
    } else {
        // A square travels on a diagonal, so the corner leads and the sides
        // are turned a further eighth of a turn out of the way.
        paint.rotate(foe.spin + Math.PI / 4);
        paint.beginPath();
        paint.rect(-radius * 0.72, -radius * 0.72, radius * 1.44, radius * 1.44);
    }
    paint.stroke();
    paint.restore();
};

/** The triangle both a foe and a snake's tail are made of, pointing along zero. */
render.arrow = function (paint, radius) {
    paint.beginPath();
    paint.moveTo(radius, 0);
    paint.lineTo(-radius * 0.8, radius * 0.75);
    paint.lineTo(-radius * 0.8, -radius * 0.75);
    paint.closePath();
};

/**
 * A snake: the head, and behind it the tail it has shown so far.
 *
 * The tail is drawn from the far end forwards so the nearer triangle laps over
 * the one behind it and the overlap reads as one body rather than as a row of
 * arrowheads. A triangle that has just been shot is filled as well as stroked -
 * that is the whole answer a tail gives to a hit, and without it the player has
 * no way of telling a shot that did nothing from a shot that missed.
 */
render.snake = function (paint, snake, shape) {
    const parts = foes.spots(snake);

    for (let at = parts.length - 1; at >= 1; at--) {
        const part = snake.parts[parts[at].part];
        render.glow(paint, shape.colour, 2);
        paint.save();
        paint.translate(part.x, part.y);
        paint.rotate(part.angle);
        render.arrow(paint, parts[at].radius);
        if (part.lit > 0) {
            paint.globalAlpha = render.LIT * (part.lit / foes.MARK);
            paint.fillStyle = shape.colour;
            paint.fill();
            paint.globalAlpha = 1;
        }
        paint.stroke();
        paint.restore();
    }

    render.glow(paint, shape.colour, 2.4);
    paint.save();
    paint.translate(snake.x, snake.y);
    paint.rotate(snake.angle);
    render.arrow(paint, foes.radius(snake));
    paint.stroke();
    paint.restore();
};

/** An egg: a green oval, lying along the way it is going. */
render.egg = function (paint, egg, shape) {
    const radius = foes.radius(egg);
    render.glow(paint, shape.colour, 2);
    render.oval(paint, egg.x, egg.y, radius, radius * 0.66, egg.angle);
    paint.stroke();
};

/**
 * A mine: a red oval that will not hold still.
 *
 * It shifts tall, round, wide and back once every `MINE_SHIFT`, which is the
 * one thing on the field that is animated for its own sake - a mine that looked
 * like a foe would be shot at like a foe, and this one is to be run from. The
 * oval stands square to the world rather than to its heading, so tall is tall
 * whichever way it happens to be chasing.
 */
render.mine = function (paint, mine, shape) {
    const radius = foes.radius(mine);
    const shift = Math.cos(mine.shift / foes.MINE_SHIFT * Math.PI * 2) * 0.42;
    render.glow(paint, shape.colour, 2.2);
    render.oval(paint, mine.x, mine.y, radius * (1 - shift), radius * (1 + shift), 0);
    paint.stroke();
};

/**
 * An oval, on browsers with `ellipse` and on the ones without.
 *
 * `ellipse` has been everywhere for years, but a canvas is the whole of this
 * game and a missing method would be a missing foe, so the fall-back is a
 * circle scaled the two ways - which is the same shape by another road.
 */
render.oval = function (paint, x, y, wide, tall, angle) {
    paint.beginPath();
    if (paint.ellipse) {
        paint.ellipse(x, y, wide, tall, angle || 0, 0, Math.PI * 2);
        return;
    }
    paint.save();
    paint.translate(x, y);
    paint.rotate(angle || 0);
    paint.scale(wide / tall, 1);
    paint.arc(0, 0, tall, 0, Math.PI * 2);
    paint.restore();
};

/**
 * A comet: five white circles, the largest leading, each sitting part of the
 * way along the one in front so the five read as a streak. The tail is drawn
 * first and the head last, and each is a little fainter towards the back.
 */
render.comet = function (paint, comet) {
    const spots = comets.spots(comet);
    for (let at = spots.length - 1; at >= 0; at--) {
        render.glow(paint, comets.COLOUR, 2);
        paint.globalAlpha = 1 - at / (spots.length + 1) * 0.65;
        paint.beginPath();
        paint.arc(spots[at].x, spots[at].y, spots[at].radius, 0, Math.PI * 2);
        paint.stroke();
    }
    paint.globalAlpha = 1;
};

/** One grain of what a shape came to: a little square, fading as it slows. */
render.grain = function (paint, grain) {
    paint.shadowBlur = 0;
    paint.globalAlpha = Math.max(0, Math.min(1, grain.life / grain.full));
    paint.fillStyle = grain.colour;
    paint.fillRect(grain.x - grain.size / 2, grain.y - grain.size / 2, grain.size, grain.size);
    paint.globalAlpha = 1;
};

/**
 * The rocket: a white triangle with a small red one sitting in its nose, which
 * is the end the guns fire out of and the end the right stick is turning. The
 * red one is filled rather than drawn in outline - at this size an outline of
 * an outline is a smudge, and the point of it is to say at a glance which way
 * the rocket is looking.
 */
render.rocket = function (paint, rocket) {
    const half = rocket.size / 2;

    paint.save();
    paint.translate(rocket.x, rocket.y);
    paint.rotate(rocket.angle);

    render.glow(paint, render.ROCKET, 2);
    paint.beginPath();
    paint.moveTo(half, 0);
    paint.lineTo(-half, half * 0.72);
    paint.lineTo(-half, -half * 0.72);
    paint.closePath();
    paint.stroke();

    render.glow(paint, render.TIP, 2);
    paint.fillStyle = render.TIP;
    paint.beginPath();
    paint.moveTo(half, 0);
    paint.lineTo(half * 0.35, half * 0.28);
    paint.lineTo(half * 0.35, -half * 0.28);
    paint.closePath();
    paint.fill();
    paint.stroke();

    paint.restore();
};

/**
 * A ring on its way out: the pulse of an EMP, a mine going off, or the rocket
 * with it.
 *
 * The ring carries the reach it is to grow to rather than taking one from here,
 * because a mine's blast has a radius the player is being told about - five
 * rockets' lengths, and the ring is the telling - while an EMP's is simply
 * bigger than any screen.
 */
render.flash = function (paint, flash) {
    const gone = 1 - flash.life / flash.full;
    const reach = flash.reach || 940;
    render.glow(paint, '#9fe8ff', Math.max(1, 6 * (1 - gone)));
    paint.globalAlpha = Math.max(0, 1 - gone);
    paint.beginPath();
    paint.arc(flash.x, flash.y, Math.min(reach, 40 + gone * reach), 0, Math.PI * 2);
    paint.stroke();
    paint.globalAlpha = 1;
};

/** A colour to draw in, lit by itself. */
render.glow = function (paint, colour, width) {
    paint.strokeStyle = colour;
    paint.lineWidth = width;
    paint.lineJoin = 'round';
    paint.lineCap = 'round';
    paint.shadowColor = colour;
    paint.shadowBlur = render.GLOW;
};
