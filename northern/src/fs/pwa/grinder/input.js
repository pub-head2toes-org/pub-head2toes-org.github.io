'use strict';

/**
 * What the player is asking for, whichever thing they are asking with.
 *
 * The pad is the game's control - the left stick flies, the right stick spins
 * the rocket, R2 is the laser, R3 the torpedoes and B the bomb - and the
 * keyboard says the same things for anyone reading this on a laptop with no
 * pad in the drawer. Both end in one object, so nothing downstream of here
 * knows or cares which was used.
 *
 * Two of those are held and two are pressed. Firing is held: the trigger is
 * down and the gun goes on firing at whatever rate the score has earned. The
 * bomb and the menu keys are pressed - what they give back is the moment the
 * button went down, once, however long it is leant on afterwards, because two
 * of the three bombs going on one thumb press is not a game.
 */
const input = {};

input.DEAD = 0.22;           // how far a stick must go before it is meant
input.TRIGGER = 0.3;         // how far an analogue trigger is a press

/**
 * The standard pad, by the numbers the browser gives its buttons.
 *
 * R3 is the right stick pressed in - the same stick the rocket is aimed with.
 * Pushing a stick straight down without leaning on it takes a firm thumb, and
 * a thumb that leans swings the aim as it fires, so the torpedoes answer to R1
 * as well: the same gun, on a button that can be pressed without letting go of
 * the aim. R2 is the laser, as asked.
 */
input.PAD = {
    confirm: 0,              // A / cross
    emp: 1,                  // B / circle - the bomb
    laser: 7,                // R2
    torpedo: [11, 5],        // R3, and R1 beside it
    back: 8,
    start: 9,
    up: 12, down: 13, left: 14, right: 15
};

/** What the buttons are called, for the readout on the welcome screen. */
input.NAMES = {
    0: 'A', 1: 'B', 2: 'X', 3: 'Y', 4: 'L1', 5: 'R1', 6: 'L2', 7: 'R2',
    8: 'Back', 9: 'Start', 10: 'L3', 11: 'R3', 12: 'Up', 13: 'Down', 14: 'Left', 15: 'Right'
};

/** The keys that stand in for it. */
input.KEYS = {
    move: { w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0] },
    aim: { arrowup: [0, -1], arrowdown: [0, 1], arrowleft: [-1, 0], arrowright: [1, 0] },
    laser: [' ', 'j'],
    torpedo: ['shift', 'k'],
    emp: ['b'],
    confirm: ['enter'],
    back: ['escape']
};

/** Somewhere to remember which buttons were down last time round. */
input.create = function () {
    return { held: {}, intent: input.idle() };
};

/** Nothing asked for. */
input.idle = function () {
    return {
        move: { x: 0, y: 0 },
        aim: { x: 0, y: 0 },
        laser: false,
        torpedo: false,
        emp: false,
        confirm: false,
        back: false,
        start: false,
        up: false,
        down: false,
        pad: false,
        pressing: []
    };
};

/** A stick, with the slack near the middle taken out of it. */
input.stick = function (x, y) {
    const length = Math.hypot(x, y);
    if (length < input.DEAD) return { x: 0, y: 0, length: 0 };
    // Measured from the edge of the dead zone, so the first push off it is a
    // nudge rather than a jump to a fifth of full speed.
    const scale = Math.min(1, (length - input.DEAD) / (1 - input.DEAD)) / length;
    return { x: x * scale, y: y * scale, length: Math.min(1, (length - input.DEAD) / (1 - input.DEAD)) };
};

/** Whether any of the buttons a control answers to is down. */
input.any = function (pad, which) {
    const list = Array.isArray(which) ? which : [which];
    return list.some(index => input.down(pad, index));
};

/** Whether a pad button is down, trigger or not. */
input.down = function (pad, index) {
    const button = pad && pad.buttons && pad.buttons[index];
    if (!button) return false;
    if (typeof button === 'number') return button > input.TRIGGER;
    return !!button.pressed || (button.value || 0) > input.TRIGGER;
};

/**
 * Reads the pad and the keys into one intent.
 *
 * `pads` is whatever `navigator.getGamepads()` handed over - the first one
 * that is connected is the player's - and `keys` is the set of keys currently
 * down, lower cased. Either may be empty.
 */
input.read = function (state, pads, keys) {
    // `getGamepads()` gives a list with empty slots in it, and in some browsers
    // it is not an array at all, so it is copied into one before it is read.
    const list = pads ? Array.prototype.slice.call(pads) : [];
    const pad = list.find(one => one && one.connected !== false) || null;
    const held = keys || new Set();
    const axes = (pad && pad.axes) || [];
    const intent = input.idle();
    intent.pad = !!pad;
    // What is down right now, for the readout: a pad that sends its buttons at
    // numbers of its own is a pad this mapping does not fit, and the only way
    // to see that is to be told what it is sending.
    intent.pressing = pad ? pad.buttons.map((button, index) => (input.down(pad, index) ? index : -1))
        .filter(index => index >= 0) : [];

    const move = input.stick(axes[0] || 0, axes[1] || 0);
    const aim = input.stick(axes[2] || 0, axes[3] || 0);
    intent.move = { x: move.x, y: move.y };
    intent.aim = { x: aim.x, y: aim.y };

    for (const [key, way] of Object.entries(input.KEYS.move)) {
        if (held.has(key)) { intent.move.x += way[0]; intent.move.y += way[1]; }
    }
    for (const [key, way] of Object.entries(input.KEYS.aim)) {
        if (held.has(key)) { intent.aim.x += way[0]; intent.aim.y += way[1]; }
    }
    // Two keys at once give a diagonal of root two, which would be a faster way
    // to fly than any one direction. The stick never exceeds one, so nor does this.
    intent.move = input.cap(intent.move);
    intent.aim = input.cap(intent.aim);

    intent.laser = input.any(pad, input.PAD.laser) || input.KEYS.laser.some(key => held.has(key));
    intent.torpedo = input.any(pad, input.PAD.torpedo) || input.KEYS.torpedo.some(key => held.has(key));

    // The pressed ones: down now, not down when we last looked.
    intent.emp = input.pressed(state, 'emp', input.any(pad, input.PAD.emp) || input.KEYS.emp.some(key => held.has(key)));
    intent.confirm = input.pressed(state, 'confirm', input.any(pad, input.PAD.confirm) || input.KEYS.confirm.some(key => held.has(key)));
    intent.back = input.pressed(state, 'back', input.any(pad, input.PAD.back) || input.KEYS.back.some(key => held.has(key)));
    intent.start = input.pressed(state, 'start', input.any(pad, input.PAD.start));
    intent.up = input.pressed(state, 'up', input.any(pad, input.PAD.up) || aim.y < -0.6 || move.y < -0.6);
    intent.down = input.pressed(state, 'down', input.any(pad, input.PAD.down) || aim.y > 0.6 || move.y > 0.6);

    state.intent = intent;
    return intent;
};

/** A vector held to a length of one. */
input.cap = function (way) {
    const length = Math.hypot(way.x, way.y);
    if (length <= 1 || length === 0) return way;
    return { x: way.x / length, y: way.y / length };
};

/** True on the frame a button goes down, and not again until it comes up. */
input.pressed = function (state, name, down) {
    const was = !!state.held[name];
    state.held[name] = down;
    return down && !was;
};
