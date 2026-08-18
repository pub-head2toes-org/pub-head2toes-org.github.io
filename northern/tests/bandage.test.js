'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { loadBandage } from './helpers/bandagePage.js';

const PWA = path.join(import.meta.dirname, '..', 'src', 'fs', 'pwa', 'bandage');
const read = name => fs.readFileSync(path.join(PWA, name), 'utf8');

/** keys.js touches no DOM and no synth, so it runs in a bare context. */
function load() {
    const context = vm.createContext({});
    vm.runInContext(read('keys.js'), context, { filename: 'keys.js' });
    return vm.runInContext('keys', context);
}

const keys = load();

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

    it('loads keys.js before the app that uses it', () => {
        const order = ['webaudio-tinysynth.js', 'keys.js', 'bandage.js']
            .map(file => index.indexOf(`<script src="./${file}">`));

        assert.ok(order.every(at => at !== -1));
        assert.deepStrictEqual(order, [...order].sort((a, b) => a - b));
    });

    // The prompt's one layout rule
    it('reserves the upper third of the screen', () => {
        const css = read('styles.css');

        assert.match(index, /<section id="stage"/);
        assert.match(css, /#stage\s*{[^}]*flex:\s*0 0 33\.3333%/);
        const stage = index.match(/<section id="stage"[\s\S]*?<\/section>/)[0];
        assert.ok(!/<(button|input|select|canvas)/.test(stage),
            'and puts nothing in it that the player could reach for');
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
        assert.deepStrictEqual(page.played[0], { on: 60, velocity: 100 });

        page.lift();
        assert.deepStrictEqual(page.sounding(), []);
        assert.deepStrictEqual(page.down(), []);
        assert.deepStrictEqual(page.played[1], { off: 60 });
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
        assert.deepStrictEqual(page.played.map(Object.values).flat(), [60, 100, 62, 100, 60]);
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
