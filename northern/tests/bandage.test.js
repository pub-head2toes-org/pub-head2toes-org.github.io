'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { loadBandage } from './helpers/bandagePage.js';

const PWA = path.join(import.meta.dirname, '..', 'src', 'fs', 'pwa', 'bandage');
const read = name => fs.readFileSync(path.join(PWA, name), 'utf8');

/**
 * keys.js, loops.js and smf.js touch no DOM and no synth, so they need nothing
 * but a `module` to hand themselves to. They are run here rather than in a `vm`
 * context so that the arrays they build are this realm's arrays and can be
 * compared with the ones a test writes down.
 */
function load(file, name) {
    const box = { exports: {} };
    new Function('module', `${read(file)}\nmodule.exports = ${name};`)(box);
    return box.exports;
}

const keys = load('keys.js', 'keys');
const loops = load('loops.js', 'loops');
const smf = load('smf.js', 'smf');

describe('the 25 keys', () => {
    it('is two octaves, C to C', () => {
        const layout = keys.layout(48);

        assert.strictEqual(layout.length, 25);
        assert.strictEqual(layout[0].name, 'C3');
        assert.strictEqual(layout[24].name, 'C5');
    });

    it('is 15 white and 10 black, whatever octave it sits in', () => {
        for (const lowest of [12, 24, 36, 48, 60, 72, 84, 96]) {
            const layout = keys.layout(lowest);
            const white = layout.filter(key => !key.black);

            assert.strictEqual(white.length, 15, `15 white keys from ${lowest}`);
            assert.strictEqual(layout.length - white.length, 10);
        }
    });

    it('starts on a C even when asked to start elsewhere', () => {
        assert.strictEqual(keys.layout(50)[0].name, 'C3', 'D3 rounds down to C3');
        assert.strictEqual(keys.layout(59)[0].name, 'C3', 'B3 too');
        assert.strictEqual(keys.layout(61)[0].name, 'C4');
    });

    it('names notes the way a player reads them: 60 is middle C', () => {
        assert.strictEqual(keys.name(60), 'C4');
        assert.strictEqual(keys.name(61), 'C#4');
        assert.strictEqual(keys.name(48), 'C3');
        assert.strictEqual(keys.name(71), 'B4');
    });

    it('knows which notes are the raised ones', () => {
        const black = [61, 63, 66, 68, 70].every(keys.isBlack);
        const white = [60, 62, 64, 65, 67, 69, 71].some(keys.isBlack);

        assert.ok(black, 'the five sharps are black');
        assert.ok(!white, 'the seven naturals are not');
    });
});

describe('where the keys sit', () => {
    const layout = keys.layout(48);
    const white = layout.filter(key => !key.black);
    const black = layout.filter(key => key.black);

    it('fills the width exactly with the white keys, edge to edge', () => {
        assert.strictEqual(white[0].left, 0);

        const last = white[white.length - 1];
        assert.ok(Math.abs((last.left + last.width) - 1) < 1e-9, 'the last one ends at 1');
    });

    it('lays the white keys out evenly, with no gaps between them', () => {
        for (let i = 1; i < white.length; i++) {
            assert.ok(Math.abs(white[i].left - (white[i - 1].left + white[i - 1].width)) < 1e-9,
                `white key ${i} starts where ${i - 1} ends`);
            assert.ok(Math.abs(white[i].width - white[0].width) < 1e-9, 'and is the same width');
        }
    });

    // This is what puts the gap where E-F and B-C meet, with no special casing
    it('centres each black key on the line between two white keys', () => {
        const whiteWidth = white[0].width;

        black.forEach(key => {
            const centre = key.left + (key.width / 2);
            const boundary = Math.round(centre / whiteWidth) * whiteWidth;

            assert.ok(Math.abs(centre - boundary) < 1e-9,
                `${key.name} sits on a white key boundary`);
        });
    });

    it('leaves no black key where a piano has none', () => {
        const whiteWidth = white[0].width;
        const onLine = Array.from(black, key =>
            Math.round((key.left + key.width / 2) / whiteWidth));

        // From C: after white keys 1,2 then 4,5,6 - the gaps are E-F and B-C
        assert.deepStrictEqual(onLine, [1, 2, 4, 5, 6, 8, 9, 11, 12, 13]);
    });

    it('makes the black keys narrower than the white ones', () => {
        assert.ok(black[0].width < white[0].width);
        assert.ok(black[0].width > white[0].width / 2, 'but not by too much');
    });

    it('makes the black keys shorter, leaving the white ones room to be played', () => {
        assert.strictEqual(white[0].height, 1, 'a white key is the whole board');
        assert.strictEqual(black[0].height, keys.BLACK_HEIGHT);
        assert.ok(black[0].height < white[0].height / 1.5,
            `a black key is ${black[0].height} of the board`);
    });
});

describe('the octave shift', () => {
    it('moves a whole octave at a time', () => {
        assert.strictEqual(keys.name(keys.shift(48, 1)), 'C4');
        assert.strictEqual(keys.name(keys.shift(48, -1)), 'C2');
        assert.strictEqual(keys.name(keys.shift(48, 2)), 'C5');
    });

    it('stops at the ends rather than running off the keyboard', () => {
        assert.strictEqual(keys.shift(keys.MAX_LOWEST, 5), keys.MAX_LOWEST);
        assert.strictEqual(keys.shift(keys.MIN_LOWEST, -5), keys.MIN_LOWEST);
    });

    it('keeps every reachable range inside MIDI', () => {
        const top = keys.MAX_LOWEST + keys.COUNT - 1;

        assert.ok(keys.MIN_LOWEST >= 0);
        assert.ok(top <= 127, `the top key is ${top}`);
    });
});

describe('the typing keyboard', () => {
    it('plays two octaves off the two rows', () => {
        assert.strictEqual(keys.fromTyped('z', 48), 48, 'z is the bottom C');
        assert.strictEqual(keys.fromTyped('m', 48), 59, 'm is the B below');
        assert.strictEqual(keys.fromTyped('q', 48), 60, 'q is the octave up');
        assert.strictEqual(keys.fromTyped('i', 48), 72, 'i is the top C');
    });

    it('puts the sharps on the row above their naturals', () => {
        assert.strictEqual(keys.fromTyped('s', 48), 49, 'C# over z-x');
        assert.strictEqual(keys.fromTyped('d', 48), 51);
        assert.strictEqual(keys.fromTyped('2', 48), 61);
    });

    it('covers all 25 keys and no more', () => {
        const offsets = Object.values(keys.QWERTY).sort((a, b) => a - b);

        assert.strictEqual(offsets.length, 25);
        assert.deepStrictEqual(offsets, [...Array(25).keys()]);
    });

    it('ignores a key that is not part of the board', () => {
        assert.strictEqual(keys.fromTyped('p', 48), null);
        assert.strictEqual(keys.fromTyped('Enter', 48), null);
        assert.strictEqual(keys.fromTyped(' ', 48), null);
    });

    it('follows the octave shift', () => {
        assert.strictEqual(keys.fromTyped('z', 60), 60);
        assert.strictEqual(keys.fromTyped('i', 60), 84);
    });

    it('takes a capital the same as a small letter', () => {
        assert.strictEqual(keys.fromTyped('Z', 48), keys.fromTyped('z', 48));
    });
});

describe('the voices', () => {
    it('are General MIDI programs, in range', () => {
        assert.ok(keys.VOICES.length >= 8);
        keys.VOICES.forEach(voice => {
            assert.ok(Number.isInteger(voice.program) && voice.program >= 0 && voice.program <= 127,
                `${voice.name} is program ${voice.program}`);
            assert.ok(voice.name.length > 0);
        });
    });

    it('opens on a piano, which is what the app is', () => {
        assert.strictEqual(keys.VOICES[0].program, 0);
    });
});

// A PWA that misses a file offline is not a PWA
describe('the bandage PWA shell', () => {
    const manifest = JSON.parse(read('manifest.json'));
    const index = read('index.html');
    const sw = read('sw.js');

    it('ships every file the page asks for', () => {
        const referenced = [...index.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map(m => m[1]);

        assert.ok(referenced.length >= 4, `found ${referenced.join(', ')}`);
        referenced.forEach(file => {
            assert.ok(fs.existsSync(path.join(PWA, file)), `${file} exists`);
        });
    });

    it('caches every one of them for offline use', () => {
        const referenced = [...index.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map(m => m[1]);

        referenced.forEach(file => {
            assert.match(sw, new RegExp(`'\\./${file.replace('.', '\\.')}'`),
                `${file} is in the service worker cache list`);
        });
    });

    it('caches nothing it does not have', () => {
        const cached = [...sw.matchAll(/'\.\/([^']+)'/g)].map(m => m[1]);

        assert.ok(cached.length > 0);
        cached.forEach(file => {
            assert.ok(fs.existsSync(path.join(PWA, file)), `${file} exists to be cached`);
        });
    });

    it('is installable: name, start url, display and both icons', () => {
        assert.strictEqual(manifest.name, 'Bandage');
        assert.strictEqual(manifest.start_url, './index.html');
        assert.ok(['standalone', 'fullscreen'].includes(manifest.display));
        assert.deepStrictEqual(manifest.icons.map(icon => icon.sizes), ['192x192', '512x512']);

        manifest.icons.forEach(icon => {
            const file = path.join(PWA, icon.src.replace('./', ''));
            assert.ok(fs.existsSync(file), `${icon.src} exists`);
            assert.strictEqual(fs.readFileSync(file).subarray(1, 4).toString(), 'PNG');
        });
    });

    it('registers the service worker and vendors the synth, so it works offline', () => {
        assert.match(read('bandage.js'), /navigator\.serviceWorker\.register\('\.\/sw\.js'\)/);
        assert.match(index, /src="\.\/webaudio-tinysynth\.js"/);
        assert.ok(!/https?:\/\//.test(index.replace(/<!--[\s\S]*?-->/g, '')),
            'nothing is loaded off the network');
    });

    it('loads the arithmetic before the wiring that uses it', () => {
        const order = ['webaudio-tinysynth.js', 'keys.js', 'loops.js', 'smf.js',
            'bandage.js', 'recorder.js']
            .map(file => index.indexOf(`<script src="./${file}">`));

        assert.ok(order.every(at => at !== -1));
        assert.deepStrictEqual(order, [...order].sort((a, b) => a - b));
    });

    // The prompt's one layout rule. What sits in the panel has changed; the
    // third of the screen it is allowed is what must not.
    it('still gives the upper third to the panel, and no more', () => {
        const css = read('styles.css');

        assert.match(index, /<section id="stage"/);
        assert.match(css, /#stage\s*{[^}]*flex:\s*0 0 33\.3333%/);
    });

    it('names the app at the far end of the control strip', () => {
        const css = read('styles.css');
        const toolbar = index.match(/<div id="toolbar">[\s\S]*?\n    <\/div>/)[0];

        assert.match(toolbar, /<h1 id="brand">Bandage<\/h1>/);
        assert.ok(toolbar.indexOf('id="brand"') > toolbar.indexOf('id="voice_select"'),
            'after the selections it sits beside');
        assert.match(css, /#brand\s*{[^}]*margin:\s*0 0 0 auto/, 'pushed to the right');
        assert.match(css, /#brand\s*{[^}]*text-transform:\s*uppercase/);
    });

    // Two controls a thumb reaches for constantly, and the two worst to miss:
    // the same width, from the same number.
    it('puts the editor step buttons first, wide, and a full width apart', () => {
        const css = read('styles.css');
        const head = index.match(/<div id="editor_head">[\s\S]*?\n      <\/div>/)[0];

        assert.ok(head.indexOf('id="edit_left"') < head.indexOf('id="edit_insert"'),
            'at the left of the bar, ahead of the edit buttons');
        assert.match(css, /\.stepper button\s*{[^}]*width:\s*var\(--thumb\)/);
        assert.match(css, /\.stepper\s*{[^}]*gap:\s*var\(--thumb\)/,
            'the space between them is as wide as they are');
    });

    it('gives the octave pair that same width, and the head room to be tall', () => {
        const css = read('styles.css');

        assert.match(css, /\.octave button\s*{[^}]*min-width:\s*var\(--thumb\)/);
        assert.match(css, /#editor_head button\s*{[^}]*min-height:/);
        assert.match(css, /#editor_head\s*{[^}]*flex-wrap:\s*wrap/,
            'so a narrow phone gets a second row instead of squeezed buttons');
    });

    // Five scripts, one global scope. `loops.js` grew a private `hold` once and
    // silently took over the `hold` in `bandage.js` that holds a key down.
    it('gives no two scripts the same name at the top level', () => {
        const scripts = ['keys.js', 'loops.js', 'smf.js', 'bandage.js', 'recorder.js'];
        const seen = new Map();

        scripts.forEach((script) => {
            const names = [...read(script).matchAll(/^(?:function|const|let|var) +([\w$]+)/gm)];
            names.forEach(([, name]) => {
                assert.ok(!seen.has(name),
                    `${name} is declared in both ${seen.get(name)} and ${script}`);
                seen.set(name, script);
            });
        });
        assert.ok(seen.size > 20, `only found ${seen.size} names to check`);
    });

    it('leaves the loop table to be built, so one number decides how many', () => {
        const stage = index.match(/<section id="stage"[\s\S]*?<\/section>/)[0];

        assert.match(stage, /<table id="loop_table">/);
        assert.ok(!/<th|<td/.test(stage), 'and writes none of its cells out by hand');
    });
});

// The app itself, driven through a stub DOM: the wiring, not just the numbers
describe('the bandage keyboard on a page', () => {
    it('draws 25 keys, each carrying its note', () => {
        const page = loadBandage();

        assert.strictEqual(page.keys().length, 25);
        assert.deepStrictEqual(
            [page.keys()[0].dataset.midi, page.keys()[24].dataset.midi], ['48', '72']);
        assert.strictEqual(page.keys().filter(key => key.classes.has('white')).length, 15);
        assert.strictEqual(page.keys().filter(key => key.classes.has('black')).length, 10);
    });

    it('draws the black keys short and the white keys full height', () => {
        const page = loadBandage();
        const black = page.keys().filter(key => key.classes.has('black'));
        const white = page.keys().filter(key => key.classes.has('white'));

        assert.strictEqual(white[0].style.height, '100%');
        assert.strictEqual(black[0].style.height, `${keys.BLACK_HEIGHT * 100}%`);
    });

    // Two places to change the same number was one too many
    it('takes every key measurement from keys.layout, not the stylesheet', () => {
        const css = read('styles.css');
        const rules = css.match(/\.key\.(white|black)\s*{[^}]*}/g) || [];

        assert.strictEqual(rules.length, 2);
        rules.forEach(rule => assert.ok(!/height\s*:/.test(rule), `no height in ${rule.split('{')[0]}`));
    });

    it('places them across the whole width, in percentages', () => {
        const page = loadBandage();
        const white = page.keys().filter(key => key.classes.has('white'));

        assert.strictEqual(white[0].style.left, '0%');
        const last = white[14];
        assert.ok(Math.abs(parseFloat(last.style.left) + parseFloat(last.style.width) - 100) < 1e-9);
    });

    it('marks middle C, so a player can find it', () => {
        const page = loadBandage();
        const anchor = page.keys().filter(key => key.classes.has('anchor'));

        assert.strictEqual(anchor.length, 1);
        assert.strictEqual(anchor[0].dataset.midi, '60');
    });

    it('sounds a note while a key is held, and stops it on release', () => {
        const page = loadBandage();

        page.press(60);
        assert.deepStrictEqual(page.sounding(), [60]);
        assert.deepStrictEqual(page.down(), [60]);
        assert.deepStrictEqual(page.played[0],
            { on: 60, velocity: 100, ch: 0, at: undefined }, 'the hands play on channel 0');

        page.lift();
        assert.deepStrictEqual(page.sounding(), []);
        assert.deepStrictEqual(page.down(), []);
        assert.deepStrictEqual(page.played[1], { off: 60, ch: 0, at: undefined });
    });

    it('hits the black key when the touch is on the black key', () => {
        const page = loadBandage();

        page.press(61);                       // C#4 overlaps C4 and D4

        assert.deepStrictEqual(page.sounding(), [61]);
    });

    it('plays chords: one finger per note', () => {
        const page = loadBandage();

        page.press(60, 1);
        page.press(64, 2);
        page.press(67, 3);
        assert.deepStrictEqual(page.sounding(), [60, 64, 67]);

        page.lift(2);
        assert.deepStrictEqual(page.sounding(), [60, 67], 'and one finger up lifts one note');
    });

    // Sliding across the keys is a glissando, not a drag
    it('follows a finger from key to key', () => {
        const page = loadBandage();

        page.press(60);
        page.slideTo(62);

        assert.deepStrictEqual(page.sounding(), [62]);
        assert.deepStrictEqual(
            page.played.map(call => call.on !== undefined ? call.on : -call.off),
            [60, 62, -60]);
    });

    it('lets the note go when the finger slides off the board', () => {
        const page = loadBandage();
        page.press(60);

        page.board.dispatch('pointermove', { pointerId: 1, clientX: -50, clientY: 10 });

        assert.deepStrictEqual(page.sounding(), []);
    });

    it('plays from the typing keyboard too', () => {
        const page = loadBandage();

        page.typeDown('z');
        page.typeDown('q');
        assert.deepStrictEqual(page.sounding(), [48, 60]);

        page.typeUp('z');
        assert.deepStrictEqual(page.sounding(), [60]);
    });

    it('ignores a repeat while a typed key is held down', () => {
        const page = loadBandage();

        page.typeDown('z');
        page.window.dispatch('keydown', { key: 'z', repeat: true });

        assert.strictEqual(page.played.filter(call => call.on === 48).length, 1);
    });

    // A finger and a typed key on the same note: the note ends with the last of them
    it('keeps a note alive while anything is still holding it', () => {
        const page = loadBandage();

        page.press(60);
        page.typeDown('q');
        page.lift();

        assert.deepStrictEqual(page.sounding(), [60], 'the typed key still holds it');
        page.typeUp('q');
        assert.deepStrictEqual(page.sounding(), []);
    });
});

describe('the bandage controls', () => {
    it('holds notes on after release while sustain is on', () => {
        const page = loadBandage();
        page.click('sustain');

        page.press(60);
        page.lift();
        assert.deepStrictEqual(page.sounding(), [60], 'the latch took it over');

        page.click('sustain');
        assert.deepStrictEqual(page.sounding(), [], 'and lets go when sustain does');
    });

    it('says which way sustain is set', () => {
        const page = loadBandage();
        assert.strictEqual(page.element('sustain').getAttribute('aria-pressed'), 'false');

        page.click('sustain');

        assert.strictEqual(page.element('sustain').getAttribute('aria-pressed'), 'true');
        assert.strictEqual(page.element('sustain').textContent, 'On');
    });

    it('shifts the whole board an octave and says so', () => {
        const page = loadBandage();

        page.click('octave_up');

        assert.strictEqual(page.keys()[0].dataset.midi, '60');
        assert.strictEqual(page.element('range_label').textContent, 'C4–C6');
    });

    it('stops what is ringing before the keys move under it', () => {
        const page = loadBandage();
        page.press(60);

        page.click('octave_up');

        assert.deepStrictEqual(page.sounding(), []);
        assert.ok(page.played.some(call => call.allOff), 'everything was silenced');
    });

    it('will not shift past the end of the keyboard', () => {
        const page = loadBandage();
        for (let i = 0; i < 12; i++) {
            page.click('octave_up');
        }

        assert.strictEqual(page.keys()[0].dataset.midi, String(keys.MAX_LOWEST));
        assert.strictEqual(page.keys().length, 25, 'and still has 25 keys');
    });

    it('offers the voices and switches the synth program', () => {
        const page = loadBandage();
        assert.strictEqual(page.element('voice_select').children.length, keys.VOICES.length);

        page.element('voice_select').dispatch('change', { target: { value: '48' } });

        assert.strictEqual(page.app.synth.programs[0], 48);
    });

    it('starts on the piano at the volume the slider shows', () => {
        const page = loadBandage();

        assert.strictEqual(page.app.synth.programs[0], 0);
        assert.strictEqual(page.app.synth.volume, 0.6);
    });

    it('sets the volume from the slider', () => {
        const page = loadBandage();

        page.element('volume').dispatch('input', { target: { value: '25' } });

        assert.strictEqual(page.app.synth.volume, 0.25);
    });

    it('names what is playing, and says nothing when nothing is', () => {
        const page = loadBandage();

        page.press(60, 1);
        page.press(64, 2);
        assert.strictEqual(page.element('readout').textContent, 'C4 E4');

        page.lift(1);
        page.lift(2);
        assert.strictEqual(page.element('readout').textContent, '—');
    });

    // A note left ringing while the phone is elsewhere is the worst bug a piano has
    it('goes quiet when the page is hidden', () => {
        const page = loadBandage();
        page.press(60);

        page.document.hidden = true;
        page.document.dispatch('visibilitychange');

        assert.deepStrictEqual(page.sounding(), []);
        assert.deepStrictEqual(page.down(), [], 'and no key is left looking pressed');
    });

    it('sends the player to the error page when there is no Web Audio', () => {
        const page = loadBandage({ audio: false });

        assert.strictEqual(page.window.location.href, './error.html');
        assert.strictEqual(page.keys().length, 0, 'and builds nothing');
    });
});

// The loops as numbers: what a step is, and what an edit does to a strip
describe('the eight loops', () => {
    it('are eight, each with four notes at once, on channels 1 to 8', () => {
        assert.strictEqual(loops.COUNT, 8);
        assert.strictEqual(loops.ROWS, 4);
        assert.deepStrictEqual(
            [...Array(loops.COUNT).keys()].map(loops.channel), [1, 2, 3, 4, 5, 6, 7, 8],
            'and never on channel 0, which is the hands');
    });

    // Channel 9 plays a kit, not a pitch: a ninth loop would come out as drums
    it('stops short of the drum channel', () => {
        assert.ok(loops.channel(loops.COUNT - 1) < 9,
            `the last loop is on channel ${loops.channel(loops.COUNT - 1)}`);
    });

    it('starts blank: eight loops with nothing in them', () => {
        const made = loops.blank();

        assert.strictEqual(made.length, loops.COUNT);
        made.forEach(loop => assert.deepStrictEqual(loop.steps, []));
    });

    it('makes a step an eighth note, so the tempo means what it says', () => {
        assert.strictEqual(loops.stepSeconds(120), 0.25, '120bpm: two steps to a beat');
        assert.strictEqual(loops.stepSeconds(60), 0.5);
        assert.strictEqual(loops.stepSeconds(240), 0.125);
    });

    it('holds the tempo inside what a player can use', () => {
        assert.strictEqual(loops.stepSeconds(1), loops.stepSeconds(loops.MIN_BPM));
        assert.strictEqual(loops.stepSeconds(9000), loops.stepSeconds(loops.MAX_BPM));
        assert.strictEqual(loops.stepSeconds('nonsense'), loops.stepSeconds(loops.DEFAULT_BPM));
    });

    it('puts a note on the nearest step, not the one just gone', () => {
        assert.strictEqual(loops.quantise(0.00, 120), 0);
        assert.strictEqual(loops.quantise(0.10, 120), 0, 'a shade late is still on the beat');
        assert.strictEqual(loops.quantise(0.14, 120), 1, 'past halfway it belongs to the next');
        assert.strictEqual(loops.quantise(0.50, 120), 2);
        assert.strictEqual(loops.quantise(-0.05, 120), 0, 'and nothing lands before the start');
    });

    it('fills the rows of a step in order, so a chord needs no bookkeeping', () => {
        let steps = [];
        [60, 64, 67].forEach(note => { steps = loops.setNote(steps, 0, null, note); });

        assert.deepStrictEqual(steps[0], [60, 64, 67, null]);
    });

    it('takes four notes at once and no more', () => {
        let steps = [];
        [60, 62, 64, 65, 67].forEach(note => { steps = loops.setNote(steps, 0, null, note); });

        assert.deepStrictEqual(steps[0], [60, 62, 64, 65], 'the fifth has nowhere to go');
    });

    it('does not sound the same note twice in one step', () => {
        let steps = loops.setNote([], 0, null, 60);
        steps = loops.setNote(steps, 0, null, 60);

        assert.deepStrictEqual(steps[0], [60, null, null, null]);
    });

    it('fills the gap with rests when a note lands past the end', () => {
        const steps = loops.setNote([], 3, null, 60);

        assert.strictEqual(steps.length, 4);
        assert.ok(steps.slice(0, 3).every(loops.isRest), 'the three before it are rests');
    });

    // A rest takes up room: it is how the rhythm is written
    it('inserts and deletes an empty step, moving what follows', () => {
        let steps = loops.setNote(loops.setNote([], 0, null, 60), 1, null, 64);

        steps = loops.insertStep(steps, 1);
        assert.deepStrictEqual(steps.map(step => step[0]), [60, null, 64]);

        steps = loops.deleteStep(steps, 1);
        assert.deepStrictEqual(steps.map(step => step[0]), [60, 64]);
    });

    // A held note is struck once and tied across the rest of what it covered
    it('writes a held note as one strike and then ties', () => {
        const steps = loops.holdNote([], 1, 3, 60);

        assert.deepStrictEqual(steps.map(step => step[0]),
            [null, 60, loops.tie(60), loops.tie(60)]);
    });

    it('gives a press and release inside one step a single step, and no tie', () => {
        const one = loops.holdNote([], 2, 2, 60);

        assert.strictEqual(one.length, 3);
        assert.strictEqual(one[2][0], 60, 'struck, not tied');
        assert.strictEqual(loops.holdNote([], 2, 0, 60).length, 3, 'and never runs backwards');
    });

    it('lays a held note beside the chord already in those steps', () => {
        let steps = loops.setNote([], 0, null, 60);
        steps = loops.holdNote(steps, 0, 1, 67);

        assert.deepStrictEqual(steps[0], [60, 67, null, null]);
        assert.deepStrictEqual(steps[1], [loops.tie(67), null, null, null]);
    });

    it('sorts a step low to high, so a chord reads the same in every column', () => {
        const ragged = loops.setNote(loops.setNote([], 0, null, 67), 0, null, 60);

        assert.deepStrictEqual(loops.tidy(ragged)[0], [60, 67, null, null]);
        assert.deepStrictEqual(loops.tidy([loops.emptyStep()])[0], loops.emptyStep());
    });

    it('clears one cell without disturbing the rest of the chord', () => {
        let steps = loops.setNote(loops.setNote([], 0, null, 60), 0, null, 64);

        steps = loops.clearCell(steps, 0, 0);

        assert.deepStrictEqual(steps[0], [null, 64, null, null]);
    });

    it('leaves the strip it was given alone, which is what makes undo cheap', () => {
        const before = loops.setNote([], 0, null, 60);

        loops.setNote(before, 0, null, 64);
        loops.insertStep(before, 0);
        loops.deleteStep(before, 0);

        assert.deepStrictEqual(before[0], [60, null, null, null]);
    });

    it('rounds a recording up to a whole bar, so loops come round together', () => {
        const three = loops.setNote([], 2, null, 60);

        assert.strictEqual(loops.padToBar(three).length, loops.BAR);
        assert.strictEqual(loops.padToBar(loops.extend([], loops.BAR)).length, loops.BAR * 2);
        assert.strictEqual(loops.padToBar([]).length, 0, 'but an empty loop stays empty');
    });

    it('trims the silence off the end, so a loop is no longer than it sounds', () => {
        const padded = loops.extend(loops.setNote([], 1, null, 60), 9);

        assert.strictEqual(padded.length, 10);
        assert.strictEqual(loops.trim(padded).length, 2);
    });

    it('reads every loop off one clock, wrapping at its own length', () => {
        const loop = { steps: loops.setNote(loops.setNote([], 0, null, 60), 2, null, 64) };

        assert.deepStrictEqual(loops.notesAt(loop, 0), [60]);
        assert.deepStrictEqual(loops.notesAt(loop, 1), []);
        assert.deepStrictEqual(loops.notesAt(loop, 2), [64]);
        assert.deepStrictEqual(loops.notesAt(loop, 3), [60], 'and comes round');
        assert.deepStrictEqual(loops.notesAt({ steps: [] }, 7), [], 'an empty loop is silent');
    });

    // A part punched in halfway through has to play back where it was played
    it('turns a strip so the step recorded at a punch-in becomes step 0', () => {
        const steps = loops.setNote([], 0, null, 60);
        const turned = loops.rotate(loops.extend(steps, 3), 2);

        assert.deepStrictEqual(turned.map(step => step[0]), [null, null, 60, null]);
        assert.deepStrictEqual(loops.rotate(turned, -2).map(step => step[0]), [60, null, null, null]);
        assert.deepStrictEqual(loops.rotate([], 3), [], 'and an empty strip cannot turn');
    });
});

describe('a note held over several steps', () => {
    const tied = (...values) => values.map(value =>
        [value, null, null, null]);

    it('marks a tie by the pitch it carries, so it can never lose it', () => {
        assert.strictEqual(loops.pitch(loops.tie(60)), 60);
        assert.ok(loops.isTie(loops.tie(60)));
        assert.ok(!loops.isTie(60), 'a note struck is not a note held');
        assert.strictEqual(loops.pitch(null), null);
    });

    it('reads a strike and its ties as one run of that length', () => {
        const runs = loops.runs(tied(60, loops.tie(60), loops.tie(60)));

        assert.deepStrictEqual(runs, [{ midi: 60, at: 0, length: 3 }]);
    });

    // Without the tie these two strips would be the same, which was the bug
    it('keeps a note played twice apart from a note held twice as long', () => {
        assert.deepStrictEqual(loops.runs(tied(60, 60)),
            [{ midi: 60, at: 0, length: 1 }, { midi: 60, at: 1, length: 1 }]);
        assert.deepStrictEqual(loops.runs(tied(60, loops.tie(60))),
            [{ midi: 60, at: 0, length: 2 }]);
    });

    it('carries a run round the end of the loop, where a part can land', () => {
        const wrapped = tied(loops.tie(60), loops.tie(60), null, 60);

        assert.deepStrictEqual(loops.runs(wrapped, true), [{ midi: 60, at: 3, length: 3 }]);
    });

    it('leaves the run at the end of a file where the file ends', () => {
        const wrapped = tied(loops.tie(60), loops.tie(60), null, 60);

        assert.deepStrictEqual(loops.runs(wrapped),
            [{ midi: 60, at: 0, length: 2 }, { midi: 60, at: 3, length: 1 }]);
    });

    // Deleting the step a note was struck on must not make the rest inaudible
    it('strikes a tie that has nothing left to carry on', () => {
        assert.deepStrictEqual(loops.runs(tied(loops.tie(60), loops.tie(60))),
            [{ midi: 60, at: 0, length: 2 }]);
        assert.deepStrictEqual(loops.runs(tied(loops.tie(60)), true),
            [{ midi: 60, at: 0, length: 1 }]);
    });

    it('takes several runs at once, in the order they start', () => {
        const chord = [[60, 67, null, null], [loops.tie(60), null, null, null]];

        assert.deepStrictEqual(loops.runs(chord), [
            { midi: 60, at: 0, length: 2 },
            { midi: 67, at: 0, length: 1 }
        ]);
    });

    it('has nothing to say about an empty strip', () => {
        assert.deepStrictEqual(loops.runs([]), []);
        assert.deepStrictEqual(loops.runs([loops.emptyStep()]), []);
    });

    it('ties a step to what was ringing in the one before it', () => {
        const chord = loops.setNote(loops.setNote([], 0, null, 60), 0, null, 67);

        const held = loops.tieStep(chord, 1);

        assert.deepStrictEqual(held[1], [loops.tie(60), loops.tie(67), null, null]);
        assert.deepStrictEqual(loops.tieStep(chord, 0), chord, 'and step 0 has nothing before it');
    });
});

describe('taking an edit back', () => {
    it('steps back to what was there before, and forward again', () => {
        const first = loops.setNote([], 0, null, 60);
        const stack = loops.history(first);
        const second = loops.setNote(first, 1, null, 64);

        stack.record(second);
        assert.deepStrictEqual(stack.undo().length, 1);
        assert.deepStrictEqual(stack.redo().length, 2);
        assert.strictEqual(stack.redo(), null, 'and there is nothing past the last one');
    });

    it('has nothing to take back to begin with', () => {
        const stack = loops.history([]);

        assert.ok(!stack.canUndo());
        assert.ok(!stack.canRedo());
        assert.strictEqual(stack.undo(), null);
    });

    it('ignores an edit that changed nothing', () => {
        const steps = loops.setNote([], 0, null, 60);
        const stack = loops.history(steps);

        stack.record(loops.copy(steps));

        assert.strictEqual(stack.size(), 1);
    });

    it('drops what was redone away once something else is done instead', () => {
        const stack = loops.history([]);
        stack.record(loops.setNote([], 0, null, 60));
        stack.undo();

        stack.record(loops.setNote([], 0, null, 67));

        assert.ok(!stack.canRedo());
        assert.deepStrictEqual(stack.current()[0][0], 67);
    });

    it('hands back a copy, so what is undone to cannot be written over', () => {
        const stack = loops.history(loops.setNote([], 0, null, 60));
        stack.record(loops.setNote([], 0, null, 64));

        const back = stack.undo();
        back[0][0] = 99;

        assert.strictEqual(stack.current()[0][0], 60);
    });

    it('forgets the oldest edits rather than growing without end', () => {
        const stack = loops.history([]);
        for (let i = 0; i < loops.HISTORY_LIMIT + 20; i++) {
            stack.record(loops.setNote([], i, null, 60));
        }

        assert.strictEqual(stack.size(), loops.HISTORY_LIMIT);
    });
});

// The file the loops are saved as: a real MIDI file, not a private format
describe('the loops as a Standard MIDI File', () => {
    const written = smf.encode(loops.blank(), 120, loops);

    it('writes a header any MIDI reader knows', () => {
        assert.strictEqual(String.fromCharCode(...written.slice(0, 4)), 'MThd');
        assert.deepStrictEqual([...written.slice(8, 10)], [0, 1], 'format 1');
        assert.deepStrictEqual([...written.slice(10, 12)], [0, loops.COUNT + 1],
            'a tempo track and one per loop');
        assert.strictEqual(String.fromCharCode(...written.slice(14, 18)), 'MTrk');
    });

    it('writes deltas seven bits at a time, as the format says', () => {
        assert.deepStrictEqual(smf.varLength(0), [0x00]);
        assert.deepStrictEqual(smf.varLength(127), [0x7f]);
        assert.deepStrictEqual(smf.varLength(128), [0x81, 0x00]);
        assert.deepStrictEqual(smf.varLength(8192), [0xc0, 0x00]);
    });

    it('closes every track with End of Track', () => {
        const ends = [...written].filter((byte, i) =>
            byte === 0xff && written[i + 1] === 0x2f && written[i + 2] === 0x00);

        assert.strictEqual(ends.length, loops.COUNT + 1);
    });

    // A held note is one note in the file, the length it was played
    it('writes a run as one note of that length, not a note per step', () => {
        const all = loops.blank();
        all[0].steps = loops.holdNote([], 0, 3, 60);
        const bytes = [...smf.encode(all, 120, loops)];

        const ons = bytes.filter((byte, i) =>
            byte === 0x91 && bytes[i + 1] === 60 && bytes[i + 2] === 100);
        assert.strictEqual(ons.length, 1, 'struck once');
    });

    it('puts each loop on its own channel with its own instrument', () => {
        const all = loops.blank();
        all[2].program = 48;
        all[2].steps = loops.setNote([], 0, null, 60);
        const bytes = [...smf.encode(all, 120, loops)];

        assert.ok(bytes.some((byte, i) => byte === 0xc3 && bytes[i + 1] === 48),
            'loop 3 announces program 48 on channel 3');
    });
});

describe('the recorder', () => {
    /** Records `notes` at the times given, in seconds from pressing Record. */
    function record(page, index, notes) {
        page.click(`record_${index}`);
        let at = 0;
        notes.forEach(([when, midi]) => {
            page.advance(when - at);
            at = when;
            page.press(midi);
            page.lift();
        });
        page.advance(0.05);
        page.click(`record_${index}`);
    }

    it('writes what was played onto the steps it was played on', () => {
        const page = loadBandage();

        record(page, 0, [[0, 60], [0.5, 64], [0.75, 67]]);

        assert.deepStrictEqual(page.strip(0),
            ['C4', '.', 'E4', 'G4', '.', '.', '.', '.']);
    });

    // What a key held down for four steps has to come back as
    it('keeps the length of a note, not just the moment it was struck', () => {
        const page = loadBandage();

        page.click('record_0');
        page.hold(60, 1.0);                      // a whole second: four steps at 120bpm
        page.advance(0.05);
        page.click('record_0');

        assert.deepStrictEqual(page.strip(0).slice(0, 5),
            ['C4', '~C4', '~C4', '~C4', '.'], 'struck once, then tied');
    });

    it('gives a short tap one step and no more', () => {
        const page = loadBandage();

        page.click('record_0');
        page.hold(60, 0.05);
        page.advance(0.05);
        page.click('record_0');

        assert.deepStrictEqual(page.strip(0).slice(0, 2), ['C4', '.']);
    });

    it('holds two notes of different lengths at once', () => {
        const page = loadBandage();

        page.click('record_0');
        page.press(60, 1);
        page.press(67, 2);
        page.advance(0.5);
        page.lift(2);                            // G4 goes after two steps
        page.advance(0.5);
        page.lift(1);                            // C4 after four
        page.advance(0.05);
        page.click('record_0');

        assert.deepStrictEqual(page.strip(0).slice(0, 5),
            ['C4 G4', '~C4 ~G4', '~C4', '~C4', '.']);
    });

    // The point of the tie: one attack, held, not three attacks in a row
    it('sustains a held note rather than striking it again on every step', () => {
        const page = loadBandage();
        page.click('record_0');
        page.hold(60, 0.75);                     // three steps at 120bpm
        page.advance(0.05);
        page.click('record_0');
        page.played.length = 0;

        page.advance(2.0);                       // one bar

        const struck = page.played.filter(call => call.on === 60 && call.ch === 1);
        const stopped = page.played.filter(call => call.off === 60 && call.ch === 1);
        const rings = (3 - 1 + loops.GATE) * loops.stepSeconds(120);
        assert.strictEqual(struck.length, 1, 'struck once in the bar');
        assert.ok(Math.abs((stopped[0].at - struck[0].at) - rings) < 1e-9,
            `rings for the three steps it was held, not ${stopped[0].at - struck[0].at}s`);
    });

    it('still strikes a note played twice over, which is not the same thing', () => {
        const page = loadBandage();

        page.click('record_0');
        page.hold(60, 0.05);
        page.advance(0.25);
        page.hold(60, 0.05);                     // the same note again, a step later
        page.advance(0.05);
        page.click('record_0');
        assert.deepStrictEqual(page.strip(0).slice(0, 2), ['C4', 'C4'], 'two strikes');

        page.played.length = 0;
        page.advance(2.0);

        assert.strictEqual(page.played.filter(call => call.on === 60 && call.ch === 1).length, 2);
    });

    it('ends a note that was still down when recording stopped', () => {
        const page = loadBandage();

        page.click('record_0');
        page.press(60);
        page.advance(0.75);
        page.click('record_0');                  // the key is still held
        page.lift();

        assert.deepStrictEqual(page.strip(0).slice(0, 4), ['C4', '~C4', '~C4', '.']);
    });

    it('takes a chord as one step', () => {
        const page = loadBandage();
        page.click('record_0');
        page.press(60, 1);
        page.press(64, 2);
        page.press(67, 3);
        page.advance(0.05);
        page.click('record_0');

        assert.strictEqual(page.strip(0)[0], 'C4 E4 G4');
    });

    it('rounds the loop up to a whole bar and starts it playing', () => {
        const page = loadBandage();

        record(page, 0, [[0, 60]]);

        assert.strictEqual(page.strip(0).length, page.loops().BAR);
        assert.ok(page.rec.running.has(0), 'a part just played is a part you want to hear');
        assert.strictEqual(page.element('play_0').getAttribute('aria-pressed'), 'true');
    });

    it('plays the loop on its own channel, leaving the hands theirs', () => {
        const page = loadBandage();
        record(page, 0, [[0, 60], [0.5, 64]]);
        page.played.length = 0;

        page.advance(2.0);                       // one bar at 120bpm
        page.press(72);                          // and the player joins in

        assert.deepStrictEqual([...new Set(page.loopNotes(1))], [60, 64], 'the loop, on channel 1');
        assert.deepStrictEqual(page.loopNotes(0), [72], 'the hands, on channel 0');
    });

    it('stamps every note with the time it is to sound, not the time it was sent', () => {
        const page = loadBandage();
        record(page, 0, [[0, 60]]);
        page.played.length = 0;

        page.advance(4.0);
        const starts = page.played.filter(call => call.on === 60).map(call => call.at);

        assert.ok(starts.length >= 2, `the loop came round: ${starts.length} times`);
        assert.ok(starts.every(at => typeof at === 'number'));
        // Two bars of eight eighth notes at 120bpm is two seconds
        assert.ok(Math.abs((starts[1] - starts[0]) - 2) < 1e-9, 'exactly a bar apart');
    });

    it('takes the voice on the selector as the loop instrument', () => {
        const page = loadBandage();
        page.element('voice_select').dispatch('change', { target: { value: '32' } });
        page.element('voice_select').value = '32';

        record(page, 0, [[0, 60]]);

        assert.strictEqual(page.rec.loops[0].program, 32);
        assert.strictEqual(page.app.synth.programs[1], 32, 'and sets it on the loop channel');
    });

    // Overdubbing: the parts already down are the beat you come in on
    it('keeps the other loops going while a new one is recorded', () => {
        const page = loadBandage();
        record(page, 0, [[0, 60]]);
        page.played.length = 0;

        page.click('record_1');
        page.advance(3.0);

        assert.deepStrictEqual([...new Set(page.loopNotes(1))], [60], 'loop 1 never stopped');
        assert.strictEqual(page.rec.recording, 1);
    });

    it('comes in on the bar when there is already something playing', () => {
        const page = loadBandage();
        record(page, 0, [[0, 60]]);

        page.advance(0.4);                       // land mid-bar
        page.click('record_1');

        assert.strictEqual(page.rec.originTick % page.loops().BAR, 0);
        assert.ok(page.rec.originTick > 0, 'it waits for the next one');
    });

    it('plays a part back against what it was played against', () => {
        const page = loadBandage();
        const BAR = page.loops().BAR;
        record(page, 0, [[0, 60]]);              // a note on beat one of loop 1

        page.advance(0.4);
        page.click('record_1');                  // punched in mid-bar, so it waits
        page.advance((page.rec.origin - page.clock.time) + 0.5);   // two steps into the bar
        page.press(72);
        page.lift();
        page.advance(0.05);
        page.click('record_1');

        assert.strictEqual(page.strip(1).length, BAR);
        assert.strictEqual(page.strip(1)[2], 'C5', 'two steps in, where it was played');
    });

    it('will not play a loop with nothing in it', () => {
        const page = loadBandage();

        page.click('play_0');

        assert.ok(!page.rec.running.has(0));
        assert.strictEqual(page.element('play_0').getAttribute('aria-pressed'), 'false');
    });

    it('stops a loop, and the clock with it when it was the last one', () => {
        const page = loadBandage();
        record(page, 0, [[0, 60]]);

        page.click('play_0');
        page.played.length = 0;
        page.advance(4.0);

        assert.deepStrictEqual(page.loopNotes(1), [], 'nothing more from loop 1');
        assert.strictEqual(page.rec.timer, null, 'and no timer left running');
    });

    // The board moving under the hands has nothing to do with a loop playing
    it('keeps playing when the octave moves', () => {
        const page = loadBandage();
        record(page, 0, [[0, 60]]);
        page.played.length = 0;

        page.click('octave_up');
        page.advance(2.0);

        assert.ok(page.rec.running.has(0));
        assert.deepStrictEqual([...new Set(page.loopNotes(1))], [60]);
    });

    // The eighth loop has to be as real as the first
    it('records and plays the last loop as well as the first', () => {
        const page = loadBandage();
        const last = page.loops().COUNT - 1;

        record(page, last, [[0, 60], [0.5, 64]]);
        page.played.length = 0;
        page.advance(2.0);

        assert.ok(page.rec.running.has(last));
        assert.deepStrictEqual([...new Set(page.loopNotes(last + 1))], [60, 64],
            `loop ${last + 1} sounds on channel ${last + 1}`);
    });

    it('keeps eight loops apart, each on its own channel', () => {
        const page = loadBandage();
        const model = page.loops();
        for (let i = 0; i < model.COUNT; i++) {
            page.rec.loops[i].steps = model.setNote([], 0, null, 60 + i);
            page.rec.loops[i].program = i;
            page.click(`play_${i}`);
        }
        page.played.length = 0;

        page.advance(0.5);

        for (let i = 0; i < model.COUNT; i++) {
            assert.deepStrictEqual([...new Set(page.loopNotes(i + 1))], [60 + i],
                `channel ${i + 1} plays only its own note`);
        }
        assert.deepStrictEqual(page.loopNotes(9), [], 'and nothing lands on the drums');
    });

    it('says what the transport is doing', () => {
        const page = loadBandage();
        assert.strictEqual(page.element('transport').textContent, 'Stopped');

        page.click('record_0');
        assert.match(page.element('transport').textContent, /Recording loop 1/);
    });

    // A loop still ringing while the phone is elsewhere is the same bug as a key
    it('goes quiet with the keyboard when the page is hidden', () => {
        const page = loadBandage();
        record(page, 0, [[0, 60]]);

        page.document.hidden = true;
        page.document.dispatch('visibilitychange');
        page.played.length = 0;
        page.advance(4.0);

        assert.strictEqual(page.rec.running.size, 0);
        assert.strictEqual(page.rec.timer, null);
        assert.deepStrictEqual(page.loopNotes(1), []);
    });
});

describe('the loop table', () => {
    it('draws a column for every loop, under the three functions', () => {
        const page = loadBandage();
        const table = page.element('loop_table');
        const [head, body] = table.children.slice(-2);

        assert.strictEqual(head.children[0].children.length, loops.COUNT + 1,
            'a label column and one per loop');
        assert.deepStrictEqual(
            head.children[0].children.slice(1).map(cell => cell.textContent),
            [...Array(loops.COUNT).keys()].map(i => String(i + 1)));
        assert.deepStrictEqual(body.children.map(row => row.children[0].textContent),
            ['Play', 'Record', 'Edit']);
    });

    it('gives every button a name a screen reader can read out', () => {
        const page = loadBandage();

        assert.strictEqual(page.element('play_7').getAttribute('aria-label'), 'Play loop 8');
        assert.strictEqual(page.element('record_0').getAttribute('aria-label'), 'Record loop 1');
        assert.strictEqual(page.element('edit_3').getAttribute('aria-label'), 'Edit loop 4');
    });

    it('grows with loops.COUNT rather than with the markup', () => {
        const page = loadBandage();
        const buttons = ['play', 'record', 'edit']
            .map(what => page.rec.elements[what].length);

        assert.deepStrictEqual(buttons, [loops.COUNT, loops.COUNT, loops.COUNT]);
    });
});

describe('the loop editor', () => {
    it('shows four rows of notes and a window of the sequence', () => {
        const page = loadBandage();

        page.click('edit_0');

        assert.strictEqual(page.element('editor').hidden, false);
        assert.strictEqual(page.grid().length, 4, 'four notes at once');
        assert.strictEqual(page.grid()[0].length, 8, 'eight steps across');
        assert.strictEqual(page.cursorAt(), 0);
    });

    it('writes the keys played into the step under the cursor', () => {
        const page = loadBandage();
        page.click('edit_0');

        page.press(60, 1);
        page.press(64, 2);
        page.lift(1);
        page.lift(2);

        assert.strictEqual(page.strip(0)[0], 'C4 E4');
        assert.strictEqual(page.cursorAt(), 1, 'and moves on when the chord is let go');
    });

    it('overwrites the step rather than adding to it', () => {
        const page = loadBandage();
        page.click('edit_0');
        page.press(60); page.lift();
        page.click('edit_left');

        page.press(67); page.lift();

        assert.strictEqual(page.strip(0)[0], 'G4', 'C4 is gone, not beside it');
    });

    it('moves along the sequence and scrolls once the window runs out', () => {
        const page = loadBandage();
        page.click('edit_0');

        for (let i = 0; i < 9; i++) {
            page.click('edit_right');
        }

        assert.strictEqual(page.cursorAt(), 7, 'the cursor stays in view');
        assert.strictEqual(Number(page.grid()[0].length), 8);
        assert.match(page.element('editor_title').textContent, /10\//);
    });

    it('will not run off the front of the sequence', () => {
        const page = loadBandage();
        page.click('edit_0');

        page.click('edit_left');
        page.click('edit_left');

        assert.strictEqual(page.cursorAt(), 0);
    });

    it('inserts and deletes an empty step where the cursor is', () => {
        const page = loadBandage();
        page.click('edit_0');
        page.press(60); page.lift();             // C4 at step 0, cursor now 1
        page.click('edit_left');

        page.click('edit_insert');
        assert.deepStrictEqual(page.strip(0), ['.', 'C4']);

        page.click('edit_delete');
        assert.deepStrictEqual(page.strip(0), ['C4']);
    });

    it('makes the loop one step longer when the insert is at the end', () => {
        const page = loadBandage();
        page.click('edit_0');
        page.press(60); page.lift();             // C4 at step 0, cursor now 1

        page.click('edit_insert');
        page.click('edit_right');
        page.click('edit_insert');

        assert.deepStrictEqual(page.strip(0), ['C4', '.', '.']);
    });

    it('moves the cursor to a tapped cell, and leaves the notes where they are', () => {
        const page = loadBandage();
        page.click('edit_0');
        page.press(60, 1); page.press(64, 2); page.lift(1); page.lift(2);
        page.press(67); page.lift();

        page.clickCell(0, 1);                    // the second row of the first step

        assert.strictEqual(page.cursorAt(), 0);
        assert.strictEqual(page.strip(0)[0], 'C4 E4');
    });

    it('takes an edit back, and puts it back again', () => {
        const page = loadBandage();
        page.click('edit_0');
        page.press(60); page.lift();
        page.press(64); page.lift();

        page.click('edit_undo');
        assert.deepStrictEqual(page.strip(0), ['C4']);

        page.click('edit_undo');
        assert.deepStrictEqual(page.strip(0), []);

        page.click('edit_redo');
        page.click('edit_redo');
        assert.deepStrictEqual(page.strip(0), ['C4', 'E4']);
    });

    it('holds a note through the next step when Tie is pressed', () => {
        const page = loadBandage();
        page.click('edit_0');
        page.press(60, 1); page.press(64, 2); page.lift(1); page.lift(2);

        page.click('edit_tie');
        page.click('edit_tie');

        assert.deepStrictEqual(page.strip(0), ['C4 E4', '~C4 ~E4', '~C4 ~E4']);
        assert.strictEqual(page.cursorAt(), 3, 'and moves on, so a note grows by tapping');
    });

    it('will not tie the first step, which has nothing before it', () => {
        const page = loadBandage();
        page.click('edit_0');

        page.click('edit_tie');

        assert.deepStrictEqual(page.strip(0), []);
    });

    it('draws a tie as the note carrying on, not as its name again', () => {
        const page = loadBandage();
        page.click('edit_0');
        page.press(60); page.lift();
        page.click('edit_tie');

        assert.deepStrictEqual(page.grid()[0].slice(0, 3), ['C4', '—', '·']);
    });

    it('takes a tie back like any other edit', () => {
        const page = loadBandage();
        page.click('edit_0');
        page.press(60); page.lift();
        page.click('edit_tie');

        page.click('edit_undo');

        assert.deepStrictEqual(page.strip(0), ['C4']);
    });

    it('has nothing to undo when it opens', () => {
        const page = loadBandage();

        page.click('edit_0');

        assert.strictEqual(page.element('edit_undo').disabled, true);
        assert.strictEqual(page.element('edit_redo').disabled, true);
    });

    it('closes, and the keys go back to being keys', () => {
        const page = loadBandage();
        page.click('edit_0');

        page.click('edit_close');
        page.press(60); page.lift();

        assert.strictEqual(page.element('editor').hidden, true);
        assert.deepStrictEqual(page.strip(0), [], 'nothing was written');
    });

    it('ends a recording rather than editing under it', () => {
        const page = loadBandage();
        page.click('record_0');

        page.click('edit_0');

        assert.strictEqual(page.rec.recording, null);
        assert.strictEqual(page.rec.editing, 0);
    });
});

// The round trip that matters: our writer, the library's reader, our reader
describe('saving and loading the loops', () => {
    function roundTrip(page) {
        page.click('loop_save');
        const bytes = page.saved[page.saved.length - 1].parts[0];
        page.element('loop_file').dispatch('change', { target: { files: [bytes], value: '' } });
        return bytes;
    }

    it('writes a file the library itself can read back', () => {
        const page = loadBandage();
        page.click('edit_0');
        page.press(60, 1); page.press(64, 2); page.lift(1); page.lift(2);
        page.press(67); page.lift();
        page.click('edit_close');
        const before = page.strip(0);

        roundTrip(page);

        assert.deepStrictEqual(page.strip(0), before);
    });

    it('keeps the rests at the end, which are what a loop\'s length is', () => {
        const page = loadBandage();
        page.click('edit_0');
        page.press(60); page.lift();
        for (let i = 0; i < 5; i++) {
            page.click('edit_insert');           // five rests after the note
        }
        page.click('edit_close');
        assert.strictEqual(page.strip(0).length, 6);

        roundTrip(page);

        assert.strictEqual(page.strip(0).length, 6, 'and not trimmed back to one');
    });

    it('brings a held note back held, and a repeated note repeated', () => {
        const page = loadBandage();
        const model = page.loops();
        page.rec.loops[0].steps = model.holdNote([], 0, 2, 60);         // one long note
        page.rec.loops[1].steps = model.setNote(model.setNote([], 0, null, 60), 1, null, 60);
        const before = [page.strip(0), page.strip(1)];

        roundTrip(page);

        assert.deepStrictEqual(page.strip(0), before[0]);
        assert.deepStrictEqual(page.strip(0), ['C4', '~C4', '~C4']);
        assert.deepStrictEqual(page.strip(1), ['C4', 'C4'], 'and the two strikes stay two');
    });

    // A file saved when there were four loops still opens now there are eight
    it('takes a file with fewer loops in it than the app has', () => {
        const page = loadBandage();
        const model = page.loops();
        const four = model.blank().slice(0, 4);
        four[1].program = 32;
        four[1].steps = model.setNote([], 1, null, 36);
        const bytes = page.smf().encode(four, 120, model);

        page.element('loop_file').dispatch('change', { target: { files: [bytes], value: '' } });

        assert.strictEqual(page.rec.loops.length, model.COUNT);
        assert.deepStrictEqual(page.strip(1), ['.', 'C2']);
        assert.strictEqual(page.rec.loops[1].program, 32);
        page.rec.loops.slice(4).forEach((loop, i) =>
            assert.strictEqual(loop.steps.length, 0, `loop ${i + 5} is simply empty`));
    });

    it('brings back every loop, its instrument and the tempo', () => {
        const page = loadBandage();
        page.element('tempo').dispatch('input', { target: { value: '96' } });
        page.rec.loops[3].program = 73;
        page.rec.loops[3].steps = page.loops().setNote([], 1, null, 55);

        roundTrip(page);

        assert.strictEqual(page.app.bpm, 96);
        assert.strictEqual(page.rec.loops[3].program, 73);
        assert.deepStrictEqual(page.strip(3), ['.', 'G3']);
        assert.strictEqual(page.app.synth.programs[4], 73, 'the channel is set up again');
    });

    it('puts the app back together after the library resets the synth', () => {
        const page = loadBandage();
        page.element('volume').value = '25';
        page.element('volume').dispatch('input', { target: { value: '25' } });

        roundTrip(page);

        assert.strictEqual(page.app.synth.volume, 0.25);
        assert.strictEqual(page.app.synth.programs[0], 0, 'the hands keep their voice');
    });
});

describe('a whole song, rather than eight loops', () => {
    /** What the library's parser leaves behind, without needing a file. */
    function song(events, timebase = 480) {
        return { timebase: timebase, tempo: 120, ev: events };
    }
    const on = (t, ch, note) => ({ t: t, m: [0x90 | ch, note, 100] });
    const off = (t, ch, note) => ({ t: t, m: [0x80 | ch, note, 0] });

    it('puts the parts of somebody else`s song on one length', () => {
        // Two parts of different lengths, and nothing saying where either ends
        const read = smf.decode(song([
            on(0, 1, 60), off(480, 1, 60),          // channel 1, a bar long
            on(0, 2, 67), off(1920, 2, 67)          // channel 2, four times that
        ]), loops);

        const lengths = read.loops.map(loop => loop.steps.length);
        assert.ok(read.whole, 'nothing marked its end, so it is a song');
        assert.strictEqual(lengths[0], lengths[1], `parts came back ${lengths[0]} and ${lengths[1]}`);
        assert.ok(lengths[0] > 0);
    });

    // Left at their own lengths they each come round at a different moment
    it('leaves our own loops at the lengths they were saved with', () => {
        const page = loadBandage();
        page.click('edit_0');
        page.press(60); page.lift();
        page.click('edit_close');
        page.click('edit_1');
        for (let i = 0; i < 5; i++) { page.press(64); page.lift(); }
        page.click('edit_close');

        page.click('loop_save');
        const bytes = page.saved[page.saved.length - 1].parts[0];
        page.element('loop_file').dispatch('change', { target: { files: [bytes], value: '' } });

        assert.notStrictEqual(page.rec.loops[0].steps.length, page.rec.loops[1].steps.length,
            'a one note loop and a five note loop are not the same length');
    });

    // The parser multiplies the file's division by four, so a timebase of 480
    // is 480 ticks to a whole note - four beats, two seconds at 120bpm.
    // A real song, if one has been left in the folder: five minutes of Clocks
    // across 29 tracks and 15 channels is nothing like what this app writes.
    const sample = path.join(PWA, 'Clocks.mid');
    it('takes a real song without its parts coming apart', { skip: !fs.existsSync(sample) }, () => {
        const page = loadBandage();
        const bytes = new Uint8Array(fs.readFileSync(sample));

        page.element('loop_file').dispatch('change', { target: { files: [bytes], value: '' } });

        const lengths = page.rec.loops.map(loop => loop.steps.length);
        assert.strictEqual(new Set(lengths).size, 1, `came back as ${lengths.join(' ')}`);
        assert.ok(lengths[0] > 100, 'and it is a song, not a bar');
        assert.strictEqual(page.song().shown, true, 'and can be played whole');
    });

    it('reads a tempo map rather than one tempo', () => {
        const clock = smf.clock(song([
            { t: 0, m: [0xff51, 120] },
            { t: 480, m: [0xff51, 240] },           // twice the speed, one bar in
            on(960, 1, 60)
        ]));

        assert.ok(Math.abs(clock.at(480) - 2) < 1e-9, `the first bar took ${clock.at(480)}s`);
        assert.ok(Math.abs(clock.at(960) - 3) < 1e-9, `the second took ${clock.at(960) - 2}s`);
        assert.ok(Math.abs(clock.seconds - 3) < 1e-9);
    });

    it('reads the clock in minutes and seconds', () => {
        assert.strictEqual(smf.mmss(0), '0:00');
        assert.strictEqual(smf.mmss(7.9), '0:07');
        assert.strictEqual(smf.mmss(309.6), '5:09');
    });

    it('builds a strip note by note the way an edit does, without the copies', () => {
        const written = loops.writer();
        written.hold(0, 2, 60).hold(1, 1, 64);

        let edited = loops.holdNote([], 0, 2, 60);
        edited = loops.holdNote(edited, 1, 1, 64);

        assert.deepStrictEqual(written.steps(), edited);
    });
});

describe('the song bar', () => {
    /** Saves what is in the loops and loads it back as a file. */
    function reload(page) {
        page.click('loop_save');
        const bytes = page.saved[page.saved.length - 1].parts[0];
        page.element('loop_file').dispatch('change', { target: { files: [bytes], value: '' } });
    }

    function withALoop() {
        const page = loadBandage();
        page.click('edit_0');
        page.press(60); page.lift();
        page.press(64); page.lift();
        page.click('edit_close');
        return page;
    }

    it('stays out of the way until a file has been read', () => {
        const page = loadBandage();

        assert.strictEqual(page.song().shown, false);
    });

    it('shows how long the file is once one is', () => {
        const page = withALoop();
        reload(page);

        assert.strictEqual(page.song().shown, true);
        assert.match(page.song().time, /^0:00 \/ \d+:\d\d$/);
    });

    it('hands a whole song to the library`s own player', () => {
        const page = withALoop();
        reload(page);

        page.click('song_play');

        assert.deepStrictEqual(page.songLog().slice(-1), ['play']);
        assert.strictEqual(page.song().playing, true);
    });

    it('stops the loops when the song starts: one transport at a time', () => {
        const page = withALoop();
        reload(page);
        page.click('play_0');
        assert.strictEqual(page.rec.running.size, 1);

        page.click('song_play');

        assert.strictEqual(page.rec.running.size, 0);
        assert.strictEqual(page.rec.timer, null, 'and the loop clock is off');
    });

    it('stops the song when a loop starts, the other way about', () => {
        const page = withALoop();
        reload(page);
        page.click('song_play');

        page.click('play_0');

        assert.strictEqual(page.song().playing, false);
        assert.deepStrictEqual(page.songLog().slice(-1), ['stop']);
    });

    it('moves along while it plays, and says where it is', () => {
        const page = withALoop();
        reload(page);
        page.click('song_play');

        page.advance(1.2);

        assert.ok(page.song().at > 0, `the seek bar is at ${page.song().at}`);
    });

    it('puts the voices back when the song stops', () => {
        const page = withALoop();
        const voice = page.element('voice_select');
        voice.value = '19';
        voice.dispatch('change', { target: voice });
        reload(page);
        page.click('song_play');
        // What a song does on its way past: its own program on every channel
        page.app.synth.setProgram(0, 99);
        page.app.synth.setProgram(1, 99);

        page.click('song_play');

        assert.strictEqual(page.app.synth.programs[0], 19, 'the keys keep the voice chosen for them');
        assert.strictEqual(page.app.synth.programs[1], page.rec.loops[0].program,
            'and the loop the one it was recorded with');
        assert.strictEqual(page.song().playing, false);
    });

    it('tidies up by itself when the song reaches its end', () => {
        const page = withALoop();
        reload(page);
        page.click('song_play');
        page.app.synth.setProgram(0, 99);

        page.advance(60);

        assert.strictEqual(page.song().playing, false);
        assert.strictEqual(page.rec.songTimer, null, 'the watcher is off');
        assert.strictEqual(page.app.synth.programs[0], 0,
            'and the keys have their voice back, without anyone pressing stop');
    });

    it('seeks when the finger comes off the bar, not while it is on it', () => {
        const page = withALoop();
        reload(page);
        const seek = page.element('song_seek');

        seek.value = '500';
        seek.dispatch('input', { target: seek });
        assert.ok(!page.songLog().some(line => line.startsWith('locate')), 'nothing yet');

        seek.dispatch('change', { target: seek });
        assert.ok(page.songLog().some(line => line.startsWith('locate')), 'now it moves');
    });
});

describe('playing every loop at once', () => {
    function twoLoops() {
        const page = loadBandage();
        [0, 3].forEach((index) => {
            page.click(`edit_${index}`);
            page.press(60 + index); page.lift();
            page.click('edit_close');
        });
        return page;
    }

    it('has nothing to start when every loop is empty', () => {
        const page = loadBandage();

        assert.strictEqual(page.element('loop_all').disabled, true);
    });

    it('starts every loop with something in it, from one press', () => {
        const page = twoLoops();

        page.click('loop_all');

        assert.deepStrictEqual([...page.rec.running].sort(), [0, 3]);
        assert.strictEqual(page.element('loop_all').textContent, 'Stop all');
    });

    it('starts them together, at the top of the pattern', () => {
        const page = twoLoops();

        page.click('loop_all');

        // Both loops hold one note, on step 0: from a standstill they sound at
        // the same moment rather than wherever a clock had already got to.
        const first = channel => page.played
            .filter(call => call.on !== undefined && call.ch === channel)[0];
        assert.ok(first(1) && first(4), 'both loops sounded');
        assert.strictEqual(first(1).at, first(4).at);
    });

    it('stops everything on the second press', () => {
        const page = twoLoops();
        page.click('loop_all');

        page.click('loop_all');

        assert.strictEqual(page.rec.running.size, 0);
        assert.strictEqual(page.rec.timer, null);
        assert.strictEqual(page.element('loop_all').textContent, 'Play all');
    });

    it('stops a recording too, which is the only way it could be left running', () => {
        const page = twoLoops();
        page.click('record_1');

        page.click('loop_all');

        assert.strictEqual(page.rec.recording, null);
    });
});
