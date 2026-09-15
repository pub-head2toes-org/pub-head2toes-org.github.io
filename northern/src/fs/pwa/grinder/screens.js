'use strict';

/**
 * The screens, as writing on the canvas.
 *
 * Every one of them is a card: a list of lines, each with a size against the
 * others and a colour, and that is all a screen is. The card is worked out
 * first and painted second, so what a screen says can be read back without a
 * canvas anywhere near it - which is how they are tested.
 *
 * Nothing here is laid out in pixels. A card is measured against the window it
 * is going into and the one size that fits is used for all of it, so the same
 * card fills a television and fits on a phone without a second set of numbers
 * for either.
 *
 * There is no menu to walk. The cards come round on their own - the welcome
 * and the high scores, and after a game the game over card with them - and
 * Start is the only thing to press.
 */
const screens = {};

screens.DWELL = 6000;        // ms a card is left up before the next one
screens.BLINK = 600;         // ms on, ms off, for anything that blinks
screens.ATTRACT = ['welcome', 'scores'];
screens.AFTER = ['over', 'welcome', 'scores'];
screens.TOP = 5;             // a score this high in the table is asked for initials
screens.MARGIN = 0.9;        // of the window a card may take across
screens.TALL = 0.86;         // and down
screens.BIGGEST = 7;         // pixels to the dot, however much room there is

screens.INK = '#e8f1ff';
screens.LIVE = '#4cc9f0';
screens.DIM = '#8ba0c4';
screens.WARN = '#ff8c1a';

screens.LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
screens.BLANK = '---';

/** The card a screen shows, by name. */
screens.card = function (name, app) {
    if (name === 'scores') return screens.scores(app.table || []);
    if (name === 'over') return screens.over(app.last || {});
    if (name === 'initials') return screens.initials(app.entry || {});
    if (name === 'paused') return screens.paused();
    return screens.welcome(app);
};

/**
 * The last line of the welcome, which is about whatever is in the player's
 * hands: the keys when there is no pad, and when there is a pad, the pad -
 * naming its buttons as they are pressed. A pad the browser does not report as
 * a standard one sends its buttons at numbers of its own, and then L3 is not
 * ten and the torpedoes answer to nothing; holding a button here says what is
 * really being sent, which is the difference between a bug and a pad.
 */
screens.hands = function (app) {
    if (!app || !app.pad) return 'KEYS  WASD ARROWS SPACE SHIFT B';
    const pressing = app.pressing || [];
    if (!pressing.length) return 'PAD CONNECTED';
    return 'PAD  ' + pressing.map(index => input.NAMES[index] || index).join(' ');
};

/**
 * Two columns, one line each.
 *
 * Every line comes back the same length, padded with spaces, because a card is
 * centred a line at a time: lines of different lengths centre at different
 * left edges, and two columns that do that are not columns at all. In a matrix
 * font a space is exactly a column wide, so this is all the layout there is.
 */
screens.columns = function (rows, gap) {
    const widest = Math.max(...rows.map(row => row[0].length));
    const lines = rows.map(row => row[0].padEnd(widest + (gap || 3)) + row[1]);
    const longest = Math.max(...lines.map(line => line.length));
    return lines.map(line => line.padEnd(longest));
};

/**
 * The welcome: what the game is called, what presses what, and what the shapes
 * are worth.
 */
screens.welcome = function (app) {
    const controls = screens.columns([
        ['LEFT STICK', 'FLY'],
        ['RIGHT STICK', 'TURN'],
        ['R2', 'LASER'],
        ['L2', 'TORPEDO'],
        ['B', 'EMP BOMB']
    ]);
    const worth = screens.columns([
        ['TRIANGLE', '  5'],
        ['SQUARE', ' 10'],
        ['CIRCLE', '100']
    ]);
    const colours = [foes.KIND.triangle.colour, foes.KIND.square.colour, foes.KIND.circle.colour];

    return {
        lines: [
            { text: 'GRINDER', size: 3, colour: screens.INK },
            { text: 'PRESS START', size: 1, colour: screens.LIVE, blink: true, space: 1 }
        ].concat(
            controls.map((line, index) => ({
                text: line, size: 1, colour: screens.DIM, space: index === 0 ? 1 : 0
            })),
            worth.map((line, index) => ({
                text: line, size: 1, colour: colours[index], space: index === 0 ? 1 : 0
            })),
            [{ text: screens.hands(app), size: 1, colour: screens.DIM, space: 1 }]
        )
    };
};

/** The table. Ten rows of a place, three letters and a score, in columns. */
screens.scores = function (table) {
    const lines = [{ text: 'HIGH SCORES', size: 2, colour: screens.INK }];

    if (!table.length) {
        lines.push({ text: 'NONE YET', size: 1, colour: screens.DIM, space: 1 });
    } else {
        table.forEach(function (row, index) {
            lines.push({
                text: screens.row(index + 1, row),
                size: 1,
                colour: index === 0 ? screens.LIVE : screens.DIM,
                space: index === 0 ? 1 : 0
            });
        });
    }
    lines.push({ text: 'PRESS START', size: 1, colour: screens.LIVE, blink: true, space: 1 });
    return { lines: lines };
};

/** One row of the table, in columns a matrix font can keep straight. */
screens.row = function (place, row) {
    const at = String(place).padStart(2, ' ');
    const who = (row.who || screens.BLANK).padEnd(3, ' ');
    return at + '  ' + who + String(row.score).padStart(8, ' ');
};

/** The end of a game: what it came to, and where that put it. */
screens.over = function (last) {
    return {
        lines: [
            { text: 'GAME OVER', size: 3, colour: screens.WARN },
            { text: 'SCORE ' + (last.score || 0), size: 2, colour: screens.INK, space: 1 },
            { text: screens.said(last), size: 1, colour: screens.DIM },
            { text: 'PRESS START', size: 1, colour: screens.LIVE, blink: true, space: 1 }
        ]
    };
};

/** Where a score came, in words. */
screens.said = function (last) {
    if (last.place === 1) return 'A NEW BEST';
    if (last.place) return 'NUMBER ' + last.place + ' OF ' + last.of;
    return 'NOT ONE FOR THE TABLE';
};

/**
 * Three letters, for a score in the top five.
 *
 * The letters and the mark under them are the same length, so centring the two
 * lines puts the mark under the letter it belongs to. That is the whole of the
 * layout: no measuring, no second set of coordinates.
 */
screens.initials = function (entry) {
    const letters = (entry.letters || ['A', 'A', 'A']);
    const spelt = letters.join(' ');
    const caret = spelt.split('').map(function (ignored, index) {
        return index === (entry.at || 0) * 2 ? '^' : ' ';
    }).join('');

    return {
        lines: [
            { text: 'TOP FIVE', size: 2, colour: screens.LIVE },
            { text: 'SCORE ' + (entry.score || 0), size: 1, colour: screens.INK, space: 1 },
            { text: spelt, size: 4, colour: screens.INK, space: 1 },
            { text: caret, size: 4, colour: screens.LIVE },
            { text: 'STICK PICKS   A SETS', size: 1, colour: screens.DIM, space: 1 },
            { text: 'START WHEN DONE', size: 1, colour: screens.DIM }
        ]
    };
};

/** Held. */
screens.paused = function () {
    return {
        lines: [
            { text: 'HELD', size: 3, colour: screens.INK },
            { text: 'START TO FLY ON', size: 1, colour: screens.LIVE, space: 1 }
        ]
    };
};

/**
 * The one size that fits: the widest line inside the window across, the whole
 * card inside it down, whichever of the two is the tighter.
 */
screens.fit = function (card, view) {
    let widest = 1;
    let tall = 0;
    for (const line of card.lines) {
        widest = Math.max(widest, String(line.text).length * line.size);
        tall += (line.space || 0) * text.LINE + line.size * text.LINE;
    }
    const across = (view.width * screens.MARGIN) / (widest * text.CELL);
    const down = (view.height * screens.TALL) / (tall * text.CELL);
    return Math.max(1, Math.min(across, down, screens.BIGGEST));
};

/** How tall a card comes out at a size, in pixels. */
screens.tall = function (card, unit) {
    let tall = 0;
    for (const line of card.lines) tall += ((line.space || 0) + line.size) * text.LINE * text.CELL * unit;
    return tall;
};

/** A card, centred in the window. */
screens.paint = function (paint, card, view, time) {
    const unit = screens.fit(card, view);
    const lit = Math.floor((time || 0) / screens.BLINK) % 2 === 0;
    let y = (view.height - screens.tall(card, unit)) / 2;

    paint.shadowBlur = 0;
    for (const line of card.lines) {
        y += (line.space || 0) * text.LINE * text.CELL * unit;
        if (!line.blink || lit) {
            text.centre(paint, line.text, view.width / 2, y, line.size * unit, line.colour || screens.INK);
        }
        y += line.size * text.LINE * text.CELL * unit;
    }
};

/** The field, dimmed, so a card over it can be read. */
screens.wash = function (paint, view, alpha) {
    paint.shadowBlur = 0;
    paint.globalAlpha = alpha;
    paint.fillStyle = '#05060a';
    paint.fillRect(0, 0, view.width, view.height);
    paint.globalAlpha = 1;
};

/**
 * The score, the best there has been and what is left in the rack, along the
 * top of the field while the game is being played.
 */
screens.hud = function (paint, state, best, view) {
    const unit = Math.max(1, Math.min(3, Math.round(view.width / 420)));
    const edge = text.CELL * unit;          // a letter's width of air around it

    paint.shadowBlur = 0;
    text.draw(paint, 'SCORE ' + state.score, edge, edge, unit, screens.INK);
    const right = 'BEST ' + Math.max(best, state.score) + '  EMP ' + state.bombs;
    text.draw(paint, right, view.width - edge - text.width(right, unit), edge, unit, screens.DIM);
};
