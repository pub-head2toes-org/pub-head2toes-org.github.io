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
 */
const render = {};

render.GLOW = 10;
render.ROCKET = '#ffffff';
render.TIP = '#ff2d2d';

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
    for (const shot of state.shots) render.shot(paint, shot);
    if (state.beam) render.beam(paint, state.beam);
    for (const foe of state.foes) render.foe(paint, foe);
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
        paint.beginPath();
        paint.moveTo(radius, 0);
        paint.lineTo(-radius * 0.8, radius * 0.75);
        paint.lineTo(-radius * 0.8, -radius * 0.75);
        paint.closePath();
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

/** The pulse of an EMP, or the rocket going up - a ring on its way out. */
render.flash = function (paint, flash) {
    const gone = 1 - flash.life / flash.full;
    render.glow(paint, '#9fe8ff', Math.max(1, 6 * (1 - gone)));
    paint.globalAlpha = Math.max(0, 1 - gone);
    paint.beginPath();
    paint.arc(flash.x, flash.y, 40 + gone * 900, 0, Math.PI * 2);
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
