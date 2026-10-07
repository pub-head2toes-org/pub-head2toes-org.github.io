'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { mountRama, fakeIndexedDB, fakeClock, read, settle, PWA_DIR, PAGE } from './helpers/ramaPage.js';
import { REPO_ROOT } from './helpers/db.js';

/** model.js and views.js need no DOM: they run in a context of their own. */
function loadRama(clock) {
    const context = { console, ...(clock ? { Date: clock.Date } : {}) };
    vm.createContext(context);
    for (const file of ['model.js', 'views.js']) {
        vm.runInContext(read(file), context, { filename: file });
    }
    return { Model: vm.runInContext('RamaModel', context), Views: vm.runInContext('RamaViews', context) };
}

const { Model, Views } = loadRama();
/** Objects made inside the vm have another Object.prototype; this brings them home. */
const plain = value => JSON.parse(JSON.stringify(value));

const alice = { pub: 'A'.repeat(86) + '==', name: 'alice' };
const bob = { pub: 'B'.repeat(86) + '==', name: 'bob' };
const signedIn = (who = alice) => ({ localStorage: { pub: who.pub, pub_name: who.name }, cookie: `ssid=${who.pub}.1.sig` });

const NOW = Date.UTC(2026, 9, 6, 9, 0);
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A note as the page keeps it. */
const note = (id, at, extra = {}) => ({ ...plain(Model.note(alice.pub, id, at, 7, 'audio/webm;codecs=opus')), ...extra });

// ---------------------------------------------------------------------------
// model.js
// ---------------------------------------------------------------------------

describe('Rama model - notes', () => {
    it('sends a visitor with no session to registration, carrying the way back', () => {
        assert.strictEqual(Model.regUrl(PAGE, '', '#note=x'), `/fs/get/reg/Reg.html#${PAGE}#note=x`);
        assert.strictEqual(Model.noteFromHash('#note=mfz-0a1b2c'), 'mfz-0a1b2c');
        for (const hash of ['', '#', '#note=', '#note=<x>', '#other=1']) {
            assert.strictEqual(Model.noteFromHash(hash), '', hash);
        }
    });

    it('records in the first format the browser can make, or leaves it to the browser', () => {
        assert.strictEqual(Model.mimeFor(type => type === 'audio/mp4'), 'audio/mp4', 'Safari');
        assert.strictEqual(Model.mimeFor(type => type.startsWith('audio/webm')), 'audio/webm;codecs=opus', 'Chrome');
        assert.strictEqual(Model.mimeFor(() => false), '');
    });

    it('makes ids that sort by when they were made', () => {
        const ids = [NOW, NOW + 1, NOW + DAY].map((at, i) => Model.newId(at, () => [0.9, 0.1, 0.5][i]));
        assert.deepStrictEqual([...ids].sort(), ids);
        assert.ok(ids.every(id => /^[a-z0-9]+-[a-z0-9]{6}$/.test(id)), ids.join(' '));
        assert.notStrictEqual(Model.newId(NOW, () => 0.1), Model.newId(NOW, () => 0.2));
    });

    it('starts a recording with nothing written about it', () => {
        assert.deepStrictEqual(plain(Model.note(alice.pub, 'x', NOW, 3.25, 'audio/mp4')), {
            id: 'x', owner: alice.pub, at: NOW, duration: 3.25, mime: 'audio/mp4', buzz: '', type: '', essay: '', remind: null
        });
    });

    it('reads back what it stored, and nothing that is not a note', () => {
        const kept = note('x', NOW, { buzz: 'milk', remind: NOW + HOUR });
        assert.deepStrictEqual(plain(Model.clean(kept)), kept);
        for (const junk of [null, 'x', {}, { ...kept, id: '' }, { ...kept, owner: 1 }, { ...kept, at: 'today' }, { ...kept, at: NaN }]) {
            assert.strictEqual(Model.clean(junk), null, JSON.stringify(junk));
        }
        const odd = Model.clean({ ...kept, buzz: 'b'.repeat(500), type: 7, remind: 'soon', duration: -1 });
        assert.strictEqual(odd.buzz.length, Model.BUZZ_MAX);
        assert.strictEqual(odd.type, '');
        assert.strictEqual(odd.remind, null);
        assert.strictEqual(odd.duration, 0);
    });

    it('takes what the overlay holds: buzz on one line, the type as it is spelled, the essay as written', () => {
        const edited = Model.edit(note('x', NOW), {
            buzz: '  buy\n milk  ', type: ' todo ', essay: 'line one\n\n  line two  \n\n', remind: ''
        }, Model.TYPES, NOW);
        assert.strictEqual(edited.buzz, 'buy milk');
        assert.strictEqual(edited.type, 'TODO', 'matched to the type there is, case aside');
        assert.strictEqual(edited.essay, 'line one\n\n  line two');
        assert.strictEqual(edited.remind, null);
        assert.strictEqual(Model.edit(note('x', NOW), { type: 'Poem' }, Model.TYPES, NOW).type, 'Poem', 'a new type as typed');
    });

    it('sets a reminder for later, keeps one that has passed, and refuses one moved into the past', () => {
        const later = Model.localInput(NOW + DAY);
        const set = Model.edit(note('x', NOW), { remind: later }, [], NOW);
        assert.strictEqual(set.remind, Model.fromLocalInput(later));

        // The day comes, and the user edits the buzz: the reminder stays.
        assert.strictEqual(Model.edit(set, { buzz: 'x', remind: later }, [], NOW + 2 * DAY).remind, set.remind);
        assert.throws(() => Model.edit(set, { remind: Model.localInput(NOW - HOUR) }, [], NOW), /passed/);
        assert.throws(() => Model.edit(set, { remind: 'tomorrow' }, [], NOW), /not a date/);
        assert.strictEqual(Model.edit(set, { remind: '' }, [], NOW).remind, null, 'cleared');
    });
});

describe('Rama model - types', () => {
    it('starts with TODO, Recipe and HOWTO, and grows with what the user typed', () => {
        assert.deepStrictEqual(plain(Model.types([], [])), ['TODO', 'Recipe', 'HOWTO']);
        assert.deepStrictEqual(plain(Model.types(['Poem', 'recipe'], [note('x', NOW, { type: 'Idea' }), note('y', NOW, { type: 'poem' })])),
            ['TODO', 'Recipe', 'HOWTO', 'Poem', 'Idea'], 'once each, case aside, the first spelling kept');
        assert.ok(Model.isNewType('Poem', Model.TYPES));
        assert.ok(!Model.isNewType('howto', Model.TYPES));
        assert.ok(!Model.isNewType('', Model.TYPES));
    });

    it('suggests the types that start with what is typed, then those that have it inside', () => {
        const types = ['TODO', 'Recipe', 'HOWTO', 'Prep', 'Ideas'];
        assert.deepStrictEqual(plain(Model.suggest(types, '')), types);
        assert.deepStrictEqual(plain(Model.suggest(types, 're')), ['Recipe', 'Prep']);
        assert.deepStrictEqual(plain(Model.suggest(types, 'e')), ['Recipe', 'Prep', 'Ideas']);
        assert.deepStrictEqual(plain(Model.suggest(types, 'O')), ['TODO', 'HOWTO']);
        assert.deepStrictEqual(plain(Model.suggest(types, 'p')), ['Prep', 'Recipe']);
        assert.deepStrictEqual(plain(Model.suggest(types, 'zz')), []);
    });
});

describe('Rama model - search and the lists', () => {
    const notes = [
        note('a', NOW - 2 * DAY, { buzz: 'Pancakes', type: 'Recipe', essay: 'flour, eggs and milk' }),
        note('b', NOW - DAY, { buzz: 'Call the plumber', type: 'TODO', remind: NOW + 3 * HOUR }),
        note('c', NOW - HOUR, { buzz: 'Fix the bike', type: 'HOWTO', essay: 'Chain off: shift down first', remind: NOW - HOUR }),
        note('d', NOW, { remind: NOW + HOUR })
    ];
    const ids = list => list.map(n => n.id);

    it('looks through the buzz, the type, the essay and the times, every word somewhere', () => {
        const find = query => ids(Model.recordings(notes, query));
        assert.deepStrictEqual(find('milk'), ['a'], 'the essay');
        assert.deepStrictEqual(find('todo'), ['b'], 'the type, case aside');
        assert.deepStrictEqual(find('the'), ['c', 'b'], 'the buzz');
        assert.deepStrictEqual(find('bike shift'), ['c'], 'every word, from any of them');
        assert.deepStrictEqual(find('bike milk'), []);
        assert.deepStrictEqual(find(Model.stamp(NOW - 2 * DAY).slice(0, 10)), ['a'], 'the day it was recorded');
        assert.deepStrictEqual(find(Model.stamp(NOW + 3 * HOUR)), ['b'], 'the reminder');
        assert.deepStrictEqual(find('   '), ['d', 'c', 'b', 'a']);
    });

    it('lists the recordings last recorded first', () => {
        assert.deepStrictEqual(ids(Model.recordings(notes, '')), ['d', 'c', 'b', 'a']);
    });

    it('lists the reminders still to come soonest first, then those that passed, latest first', () => {
        const more = notes.concat(note('e', NOW, { remind: NOW - DAY }));
        assert.deepStrictEqual(ids(Model.reminders(more, '', NOW)), ['d', 'b', 'c', 'e']);
        assert.deepStrictEqual(ids(Model.reminders(more, 'plumber', NOW)), ['b']);
    });

    it('finds the reminders that are due and not shown, and when the next one comes', () => {
        assert.deepStrictEqual(ids(Model.due(notes, {}, NOW)), ['c']);
        assert.deepStrictEqual(ids(Model.due(notes, { c: NOW - HOUR }, NOW)), [], 'shown already');
        assert.deepStrictEqual(ids(Model.due(notes, { c: NOW - 2 * HOUR }, NOW)), ['c'], 'moved since it was shown');
        assert.deepStrictEqual(ids(Model.due(notes, {}, NOW + 3 * HOUR)), ['c', 'd', 'b']);
        assert.strictEqual(Model.next(notes, NOW), NOW + HOUR);
        assert.strictEqual(Model.next(notes, NOW + HOUR), NOW + 3 * HOUR);
        assert.strictEqual(Model.next(notes, NOW + 3 * HOUR), null);
    });

    it('reminds with the buzz under the type, or names the recording', () => {
        assert.deepStrictEqual(plain(Model.notice(notes[1])), {
            title: 'Rama: TODO',
            options: { body: 'Call the plumber', tag: 'rama-b', icon: './icon-192.png', data: { id: 'b' } }
        });
        assert.strictEqual(Model.notice(notes[3]).title, 'Rama');
        assert.strictEqual(Model.notice(notes[3]).options.body, 'Your recording of ' + Model.stamp(NOW));
    });
});

describe('Rama model - time', () => {
    it('writes a time as people read it, and as datetime-local takes it, in the device\'s zone', () => {
        const at = new Date(2026, 0, 2, 3, 4).getTime();
        assert.strictEqual(Model.stamp(at), '2026-01-02 03:04');
        assert.strictEqual(Model.localInput(at), '2026-01-02T03:04');
        assert.strictEqual(Model.fromLocalInput('2026-01-02T03:04'), at);
        assert.strictEqual(Model.fromLocalInput('2026-01-02T03:04:00'), at, 'with seconds, as some browsers give it');
    });

    it('refuses what is not a date and a time', () => {
        for (const text of ['', '2026-02-30T10:00', '2026-13-01T10:00', '2026-01-01', 'soon', '2026-01-01T25:00']) {
            assert.strictEqual(Model.fromLocalInput(text), null, text);
        }
    });

    it('shows how long a recording is', () => {
        assert.deepStrictEqual([0, 7.9, 65, 754, 3723, -3, NaN].map(Model.clock), ['0:00', '0:07', '1:05', '12:34', '1:02:03', '0:00', '0:00']);
    });
});

// ---------------------------------------------------------------------------
// views.js
// ---------------------------------------------------------------------------

describe('Rama views', () => {
    it('lists a recording as when, its buzz, its type, a bell if it reminds, and how long - never letting text become markup', () => {
        const html = Views.recordings([note('x', NOW, { buzz: '<b>milk</b> & "eggs"', type: '<i>', remind: NOW + HOUR })], '');
        assert.ok(html.includes('data-id="x"'));
        assert.ok(html.includes(Model.stamp(NOW)));
        assert.ok(html.includes('&lt;b&gt;milk&lt;/b&gt; &amp; &quot;eggs&quot;'));
        assert.ok(html.includes('<span class="type">&lt;i&gt;</span>'));
        assert.ok(html.includes('class="bell"'));
        assert.ok(html.includes('<span class="length">0:07</span>'));
        assert.ok(!html.includes('<b>') && !html.includes('<i>'));

        const bare = Views.recordings([note('y', NOW)], '');
        assert.ok(bare.includes('No buzz yet') && !bare.includes('class="bell"') && !bare.includes('class="type"'));
    });

    it('lists a reminder by when it comes, and marks one that has passed', () => {
        const html = Views.reminders([note('a', NOW, { remind: NOW + HOUR }), note('b', NOW, { remind: NOW - HOUR })], '', NOW);
        assert.ok(html.indexOf(Model.stamp(NOW + HOUR)) < html.indexOf(Model.stamp(NOW - HOUR)));
        assert.match(html, /class="row" data-id="a"/);
        assert.match(html, /class="row past" data-id="b"/);
    });

    it('says why a list is empty: nothing yet, or nothing that matches', () => {
        assert.match(Views.recordings([], ''), /No recordings yet/);
        assert.match(Views.reminders([], ' ', NOW), /No reminders yet/);
        assert.match(Views.recordings([], '<x>'), /Nothing matches \u201c&lt;x&gt;\u201d/);
    });

    it('offers the types, the one the arrow keys are on selected', () => {
        const html = Views.suggestions(['TODO', 'A"B'], 1);
        assert.match(html, /id="type_option_0" class="suggestion" data-type="TODO" aria-selected="false">TODO</);
        assert.match(html, /id="type_option_1" class="suggestion" data-type="A&quot;B" aria-selected="true">A&quot;B</);
    });
});

// ---------------------------------------------------------------------------
// The shell: index.html, sw.js, the manifest
// ---------------------------------------------------------------------------

describe('Rama shell', () => {
    const index = read('index.html');
    const sw = read('sw.js');
    const css = read('styles.css');
    const scriptsOf = html => [...html.matchAll(/<script[^>]*src=["']([^"'?]+)(\?[^"']*)?["']/g)].map(m => m[1]);
    const cached = [...sw.matchAll(/'(\.{1,2}\/[^']+)'/g)].map(m => m[1]);

    it('has the recorder on top, a Record button in its middle and a corner to peel', () => {
        const record = index.slice(index.indexOf('<section class="page record'), index.indexOf('<section class="page browse'));
        assert.match(record, /class="page record front"/);
        assert.match(record, /class="peel" id="peel_top"/);
        assert.match(record, /<div class="stage">\s*<button type="button" class="record" id="record"/);
        assert.match(css, /\.stage\s*{[^}]*place-content:\s*center/);
        assert.match(css, /\.peel\s*{[^}]*top:\s*0;\s*right:\s*0;/, 'in the top right corner');
    });

    it('has under it a corner to peel back, the search, then the reminders above the recordings', () => {
        const browse = index.slice(index.indexOf('id="page_browse"'), index.indexOf('id="status"'));
        assert.match(index, /id="page_browse"[^>]*\binert>/, 'out of reach while it is underneath');
        const order = ['id="peel_back"', 'id="search"', 'id="reminders"', 'id="recordings"'].map(mark => browse.indexOf(mark));
        assert.ok(order.every(at => at !== -1));
        assert.deepStrictEqual(order, [...order].sort((a, b) => a - b));
        assert.match(css, /\.box\s*{[^}]*overflow-y:\s*auto/, 'both lists scroll');
    });

    it('has the overlay: the timestamp and Play, then Buzz, Type, Reminder, Essay, and Update and Close', () => {
        const dialog = index.slice(index.indexOf('<dialog id="dlg_note"'), index.indexOf('</dialog>'));
        const order = ['id="note_stamp"', 'id="note_play"', 'id="note_seek"', 'id="note_buzz"', 'id="note_type"', 'id="note_types"',
            'id="note_remind"', 'id="note_essay"'].map(mark => dialog.indexOf(mark));
        assert.ok(order.every(at => at !== -1), 'every field is there');
        assert.deepStrictEqual(order, [...order].sort((a, b) => a - b), 'in the order the prompt gives');
        assert.match(dialog, /id="note_seek" type="range"|type="range" id="note_seek"/);
        assert.match(dialog, /type="datetime-local" id="note_remind"/);
        assert.match(dialog, /<button type="submit" class="primary" id="note_update">Update<\/button>/);
        assert.match(dialog, /id="note_close">Close<\/button>/);
    });

    it('peels for as long in the stylesheet as the page waits for it', () => {
        const ms = Number(/const PEEL_MS = (\d+);/.exec(read('rama.js'))[1]);
        assert.strictEqual(css.match(/--peel:\s*(\d+)ms/)[1], String(ms));
        assert.match(css, /\.page\.peeling\s*{[^}]*animation:\s*peel var\(--peel\)/);
        assert.match(css, /prefers-reduced-motion: reduce\)\s*{\s*\.page\.peeling\s*{\s*animation:\s*none/);
    });

    it('loads every script it ships, in order, and caches every script it loads', () => {
        const shipped = fs.readdirSync(PWA_DIR).filter(f => f.endsWith('.js') && f !== 'sw.js');
        const loaded = scriptsOf(index);
        for (const file of shipped) {
            assert.ok(loaded.includes('./' + file), `${file} is not loaded`);
        }
        for (const src of loaded) {
            assert.ok(fs.existsSync(path.join(PWA_DIR, src)), `${src} does not exist`);
            assert.ok(cached.includes(src), `${src} is not cached by sw.js`);
        }
        for (const url of cached) {
            assert.ok(fs.existsSync(path.join(PWA_DIR, url)), `sw.js caches a file that does not exist: ${url}`);
        }
        const at = name => loaded.indexOf(name);
        assert.ok(at('../../reg/session.js') < at('./model.js'));
        assert.ok(at('./model.js') < at('./store.js') && at('./store.js') < at('./remind.js') && at('./views.js') < at('./rama.js'));
        assert.strictEqual(loaded[loaded.length - 1], './rama.js');
    });

    it('has a manifest whose icons exist', () => {
        const manifest = JSON.parse(read('manifest.json'));
        assert.strictEqual(manifest.name, 'Rama');
        assert.strictEqual(manifest.display, 'standalone');
        for (const icon of manifest.icons) {
            const png = fs.readFileSync(path.join(PWA_DIR, icon.src));
            assert.strictEqual(png.subarray(1, 4).toString(), 'PNG');
            assert.strictEqual(png.readUInt32BE(16), Number(icon.sizes.split('x')[0]), `${icon.src} is the size it claims`);
        }
    });

    /** sw.js run with a worker's globals stubbed; returns its listeners and what it did. */
    function worker({ online = true, idb = {}, now = NOW, caches: names = [] } = {}) {
        const listeners = {};
        const did = { fetched: [], notified: [], posted: [], windowsOpened: [], focused: 0, deleted: [] };
        const here = 'https://northern.example/fs/get/pwa/rama/';
        const cache = {
            addAll: urls => { did.precached = urls; return Promise.resolve(); },
            put: () => Promise.resolve()
        };
        const indexedDB = fakeIndexedDB(idb);
        const clock = fakeClock(now);
        const context = {
            URL, Promise, JSON, Math, indexedDB, Date: clock.Date,
            Request: function Request(url, options) { this.url = url; Object.assign(this, options); },
            caches: {
                open: () => Promise.resolve(cache),
                keys: () => Promise.resolve(names),
                delete: name => { did.deleted.push(name); return Promise.resolve(true); },
                match: request => Promise.resolve({ fromCache: request.url })
            },
            fetch: request => {
                did.fetched.push(request.url);
                return online ? Promise.resolve({ status: 200, type: 'basic', clone: () => ({}) }) : Promise.reject(new Error('offline'));
            },
            self: {
                location: { href: here + 'sw.js' },
                addEventListener: (name, fn) => { listeners[name] = fn; },
                skipWaiting() {},
                clients: {
                    claim() {},
                    matchAll: () => Promise.resolve(did.windows || []),
                    openWindow: url => { did.windowsOpened.push(url); return Promise.resolve(); }
                },
                registration: { showNotification: (title, options) => { did.notified.push({ title, ...plain(options) }); return Promise.resolve(); } }
            }
        };
        const source = file => file.startsWith('../../reg/')
            ? fs.readFileSync(path.join(REPO_ROOT, 'src/fs/reg', file.slice('../../reg/'.length)), 'utf8')
            : read(file.replace('./', ''));
        context.importScripts = (...files) => files.forEach(file => vm.runInContext(source(file), context, { filename: file }));
        vm.createContext(context);
        vm.runInContext(sw, context, { filename: 'sw.js' });
        did.global = name => vm.runInContext(name, context);
        did.window = url => ({ url, postMessage: data => did.posted.push(data), focus: () => { did.focused += 1; return Promise.resolve(); } });
        did.fired = () => Object.fromEntries(indexedDB.stores.fired || new Map());
        const fire = async (name, event = {}) => {
            let answered;
            const waits = [];
            listeners[name]({ ...event, waitUntil: p => waits.push(p), respondWith: p => { answered = p; } });
            await Promise.all(waits);
            return answered;
        };
        return { did, fire, here };
    }

    it('names its cache after the version the page shows, and asks for every file by it', () => {
        const { did } = worker();
        const version = did.global('RAMA_VERSION');
        assert.ok(Number.isInteger(version) && version >= 1);
        assert.strictEqual(did.global('CACHE_NAME'), `rama-v${version}`);
        const assets = [...index.matchAll(/<(?:script[^>]*src|link rel="stylesheet"[^>]*href)="(\.{1,2}\/[^"]+)"/g)].map(m => m[1]);
        assert.ok(assets.length > 5);
        for (const url of assets) {
            assert.ok(url.endsWith(`?v=${version}`), `${url} is not asked for as v${version}`);
        }
    });

    it('fills its cache past the browser\'s, and is checked for updates past it too', async () => {
        const { did, fire } = worker();
        await fire('install');
        assert.ok(did.precached.length > 10);
        assert.ok(did.precached.every(request => request.cache === 'reload'));
        assert.match(read('rama.js'), /register\('\.\/sw\.js', \{ updateViaCache: 'none' \}\)/);
    });

    // Caches belong to the origin, which Rama shares with the other apps on it.
    it('clears its own old caches, and leaves the other apps\' alone', async () => {
        const { did, fire } = worker({ caches: ['rama-v0', 'rama-v1', 'pals-v9', 'bandage-v3'] });
        await fire('activate');
        assert.deepStrictEqual(did.deleted, did.global('CACHE_NAME') === 'rama-v1' ? ['rama-v0'] : ['rama-v0', 'rama-v1']);
    });

    it('keeps the cache off everything that is not the page\'s own files, and answers from it offline', async () => {
        const { did, fire, here } = worker();
        const get = url => fire('fetch', { request: { method: 'GET', url } });
        for (const url of ['https://northern.example/fs/get/pwa/pals/index.html', 'https://northern.example/push/api/config/pub']) {
            assert.strictEqual(await get(url), undefined, url);
        }
        assert.ok(await get(here + 'index.html'));
        assert.ok(await get('https://northern.example/fs/get/reg/session.js?v=1'));
        assert.strictEqual(did.fetched.length, 2);

        const offline = worker({ online: false });
        assert.deepStrictEqual(await offline.fire('fetch', { request: { method: 'GET', url: here + 'rama.js' } }), { fromCache: here + 'rama.js' });
    });

    it('shows what came due while no page was open, when the browser wakes it - once', async () => {
        const notes = { a: note('a', NOW - DAY, { buzz: 'Milk', type: 'TODO', remind: NOW - MINUTE }),
            b: note('b', NOW - DAY, { remind: NOW + HOUR }),
            c: { ...note('c', NOW - DAY, { buzz: 'Bob\'s', remind: NOW - HOUR }), owner: bob.pub } };
        const { did, fire } = worker({ idb: { notes } });

        await fire('periodicsync', { tag: 'something-else' }).catch(() => {});
        assert.deepStrictEqual(did.notified, []);

        await fire('periodicsync', { tag: 'rama-reminders' });
        assert.deepStrictEqual(did.notified.map(n => [n.title, n.body, n.tag]),
            [['Rama', 'Bob\'s', 'rama-c'], ['Rama: TODO', 'Milk', 'rama-a']], 'everybody\'s on this device, oldest first');
        assert.deepStrictEqual(did.fired(), { a: NOW - MINUTE, c: NOW - HOUR });

        await fire('periodicsync', { tag: 'rama-reminders' });
        assert.strictEqual(did.notified.length, 2, 'not twice');
    });

    it('opens the recording a clicked reminder is for: in the open page, or a new one', async () => {
        const click = data => ({ notification: { data, close() {} } });
        const { did, fire, here } = worker();
        did.windows = [did.window('https://northern.example/fs/get/pwa/pals/index.html'), did.window(here + 'index.html#x')];
        await fire('notificationclick', click({ id: 'abc' }));
        assert.strictEqual(did.focused, 1);
        assert.deepStrictEqual(plain(did.posted), [{ type: 'rama:open', id: 'abc' }]);
        assert.deepStrictEqual(did.windowsOpened, []);

        did.windows = [];
        await fire('notificationclick', click({ id: 'abc' }));
        assert.deepStrictEqual(did.windowsOpened, [here + 'index.html#note=abc']);
    });
});

// ---------------------------------------------------------------------------
// The page: rama.js in a DOM stub
// ---------------------------------------------------------------------------

describe('Rama page', () => {
    const open = async (options = {}) => {
        const page = mountRama({ ...signedIn(), now: NOW, ...options });
        await page.settle();
        return page;
    };
    const PEEL = 650;
    /** Peels the recorder off, to the lists. */
    const peel = async page => {
        page.click('peel_top');
        page.advance(PEEL);
        await page.settle();
    };
    const record = async (page, seconds = 3) => {
        page.click('record');
        await page.settle();
        page.advance(seconds * 1000);
        page.click('record');
        await page.settle();
    };
    const seeded = (...notes) => ({ idb: { notes: Object.fromEntries(notes.map(n => [n.id, n])),
        audio: Object.fromEntries(notes.map(n => [n.id, { type: n.mime, bytes: new TextEncoder().encode('sound of ' + n.id).buffer }])) } });

    it('sends a visitor who is not signed in to Reg.html, with the way back', async () => {
        for (const options of [{}, { localStorage: { pub: 'notloggedin' }, cookie: `ssid=${alice.pub}.1.sig` },
            { localStorage: { pub: alice.pub }, cookie: '' }, { localStorage: { pub: alice.pub }, cookie: `ssid=${bob.pub}.1.sig` }]) {
            const page = mountRama({ ...options, hash: '#note=x' });
            await page.settle();
            assert.strictEqual(page.location.replaced, `/fs/get/reg/Reg.html#${PAGE}#note=x`, JSON.stringify(options));
            assert.strictEqual(page.html('recordings'), '', 'and draws nothing');
            assert.strictEqual(page.mic.asked, 0);
        }
    });

    it('goes to Reg.html when the cookie expires while the page is open, once it is looked at again', async () => {
        const page = await open();
        page.show();
        assert.strictEqual(page.location.replaced, null);
        page.document.cookie = '';
        page.show();
        assert.strictEqual(page.location.replaced, `/fs/get/reg/Reg.html#${PAGE}`);
    });

    it('does not record once the cookie has expired, and goes to sign in instead', async () => {
        const page = await open();
        page.document.cookie = '';
        page.click('record');
        await page.settle();
        assert.strictEqual(page.mic.asked, 0);
        assert.strictEqual(page.location.replaced, `/fs/get/reg/Reg.html#${PAGE}`);
    });

    it('shows who is signed in and the version, and registers its service worker', async () => {
        const page = await open();
        assert.strictEqual(page.element('user').textContent, 'alice');
        assert.strictEqual(page.element('version').textContent, 'v' + page.global('RAMA_VERSION'));
        assert.deepStrictEqual(page.worker.registered.map(r => [r.url, r.updateViaCache]), [['./sw.js', 'none']]);
        assert.ok(page.has('page_record', 'front') && !page.has('page_browse', 'front'));
    });

    it('records on Record, shows Stop and the time while it does, and keeps it on Stop', async () => {
        const page = await open();
        page.click('record');
        await page.settle();

        assert.strictEqual(page.mic.asked, 1);
        assert.strictEqual(page.mic.recorders[0].mimeType, 'audio/webm;codecs=opus');
        assert.ok(page.has('record', 'recording'));
        assert.strictEqual(page.element('record').getAttribute('aria-pressed'), 'true');
        assert.strictEqual(page.element('record_label').textContent, 'Stop');
        page.advance(65 * 1000);
        assert.strictEqual(page.element('elapsed').textContent, '1:05');

        page.click('record');
        await page.settle();
        assert.ok(!page.has('record', 'recording'));
        assert.strictEqual(page.element('record_label').textContent, 'Record');
        assert.strictEqual(page.mic.stopped, 1, 'the microphone is let go');

        const notes = page.all('notes');
        assert.strictEqual(notes.length, 1);
        assert.deepStrictEqual({ ...notes[0], id: 'x' }, { ...plain(Model.note(alice.pub, 'x', NOW, 65, 'audio/webm;codecs=opus')) });
        const sound = page.stored('audio', notes[0].id);
        assert.strictEqual(sound.type, 'audio/webm;codecs=opus');
        assert.strictEqual(new TextDecoder().decode(sound.bytes), 'sound');
        assert.match(page.element('status').textContent, /Saved/);
    });

    it('says why it cannot record: the microphone refused, or no recorder at all - and records nothing', async () => {
        const refused = await open({ microphone: { allow: false } });
        refused.click('record');
        await refused.settle();
        assert.match(refused.element('status').textContent, /needs the microphone/);
        assert.strictEqual(refused.element('record_label').textContent, '');
        assert.deepStrictEqual(refused.all('notes'), []);

        const none = await open({ recorder: false });
        none.click('record');
        await none.settle();
        assert.match(none.element('status').textContent, /cannot record here/);

        const silent = await open({ microphone: { bytes: '' } });
        await record(silent);
        assert.match(silent.element('status').textContent, /Nothing was recorded/);
        assert.deepStrictEqual(silent.all('notes'), []);
    });

    it('peels the recorder off to the lists, and the lists off back to the recorder', async () => {
        const page = await open();
        page.click('peel_top');
        assert.ok(page.has('page_record', 'peeling'), 'the top page lifts');
        assert.strictEqual(page.element('page_browse').inert, false, 'and the one under it is live as it shows');
        page.click('peel_top');
        page.advance(PEEL - 1);
        assert.ok(page.has('page_record', 'front'), 'not before it is off');

        page.advance(1);
        assert.ok(page.has('page_browse', 'front') && !page.has('page_record', 'front') && !page.has('page_record', 'peeling'));
        assert.strictEqual(page.element('page_record').inert, true);
        assert.strictEqual(page.element('search').focused, 1);

        page.click('peel_back');
        assert.ok(page.has('page_browse', 'peeling'));
        page.advance(PEEL);
        assert.ok(page.has('page_record', 'front') && !page.has('page_browse', 'front'));
        assert.strictEqual(page.element('page_browse').inert, true);
    });

    it('lists what it recorded, the last first, and only the signed in user\'s', async () => {
        const others = { ...note('z', NOW - HOUR, { buzz: 'Bob\'s secret' }), owner: bob.pub };
        const page = await open(seeded(note('old', NOW - DAY, { buzz: 'Old one' }), others));
        await record(page, 2);
        await peel(page);

        const rows = page.rows('recordings');
        assert.strictEqual(rows.length, 2);
        assert.match(rows[0].text, /No buzz yet .*0:02/);
        assert.match(rows[1].text, /Old one/);
        assert.ok(!page.html('recordings').includes('secret'));
        assert.match(page.html('reminders'), /No reminders yet/);
    });

    it('filters both lists as the search is typed', async () => {
        const page = await open(seeded(
            note('a', NOW - DAY, { buzz: 'Pancakes', type: 'Recipe', essay: 'flour and milk', remind: NOW + DAY }),
            note('b', NOW - HOUR, { buzz: 'Plumber', type: 'TODO', remind: NOW + HOUR }),
            note('c', NOW, { buzz: 'Bike chain', type: 'HOWTO' })));
        await peel(page);
        const ids = list => page.rows(list).map(r => r.id);
        assert.deepStrictEqual(ids('reminders'), ['b', 'a']);
        assert.deepStrictEqual(ids('recordings'), ['c', 'b', 'a']);

        page.type('search', 'MILK');
        assert.deepStrictEqual(ids('reminders'), ['a']);
        assert.deepStrictEqual(ids('recordings'), ['a']);
        page.type('search', 'howto');
        assert.deepStrictEqual(ids('reminders'), []);
        assert.match(page.html('reminders'), /Nothing matches/);
        assert.deepStrictEqual(ids('recordings'), ['c']);
        page.type('search', '');
        assert.deepStrictEqual(ids('recordings'), ['c', 'b', 'a']);
    });

    it('opens a recording from either list: its time, its sound to play, and what was written', async () => {
        const kept = note('a', NOW - DAY, { buzz: 'Pancakes', type: 'Recipe', essay: 'flour', remind: NOW + HOUR });
        const page = await open(seeded(kept));
        await peel(page);
        page.pick('reminders', 'a');
        await page.settle();

        assert.strictEqual(page.element('dlg_note').open, true);
        assert.strictEqual(page.element('note_stamp').textContent, Model.stamp(NOW - DAY));
        assert.deepStrictEqual(['note_buzz', 'note_type', 'note_remind', 'note_essay'].map(id => page.element(id).value),
            ['Pancakes', 'Recipe', Model.localInput(NOW + HOUR), 'flour']);
        assert.strictEqual(page.element('note_play').disabled, false);
        assert.strictEqual(page.audio.src, 'blob:1');
        assert.strictEqual(await page.urls.made.get('blob:1').text(), 'sound of a');
        assert.strictEqual(page.element('note_seek').max, '7');
        assert.strictEqual(page.element('note_time').textContent, '0:00 / 0:07');

        page.click('note_close');
        assert.strictEqual(page.element('dlg_note').open, false);
        assert.deepStrictEqual(page.urls.revoked, ['blob:1'], 'the sound is let go');
        page.pick('recordings', 'a');
        await page.settle();
        assert.strictEqual(page.element('dlg_note').open, true);
    });

    it('plays and pauses on one button, and goes where the slider is put', async () => {
        const page = await open(seeded(note('a', NOW - DAY)));
        await peel(page);
        page.pick('recordings', 'a');
        await page.settle();

        page.click('note_play');
        assert.strictEqual(page.audio.paused, false);
        assert.strictEqual(page.element('note_play').textContent, 'Pause');
        page.audio.currentTime = 3.2;
        page.audio.fire('timeupdate');
        assert.strictEqual(page.element('note_seek').value, '3.2');
        assert.strictEqual(page.element('note_time').textContent, '0:03 / 0:07');

        page.click('note_play');
        assert.strictEqual(page.audio.paused, true);
        assert.strictEqual(page.element('note_play').textContent, 'Play');

        page.type('note_seek', '5.5');
        assert.strictEqual(page.audio.currentTime, 5.5);
        assert.strictEqual(page.element('note_time').textContent, '0:05 / 0:07');

        // Once the browser knows how long it really is, that is the length.
        page.audio.duration = 9.4;
        page.audio.fire('loadedmetadata');
        assert.strictEqual(page.element('note_seek').max, '9.4');

        page.click('note_close');
        assert.strictEqual(page.audio.src, '');
    });

    it('says so when the sound of a recording is not in this browser', async () => {
        const page = await open({ idb: { notes: { a: note('a', NOW) } } });
        await peel(page);
        page.pick('recordings', 'a');
        await page.settle();
        assert.strictEqual(page.element('note_play').disabled, true);
        assert.match(page.element('note_error').textContent, /not in this browser/);
    });

    it('updates the buzz, type, reminder and essay, and lists the recording by them', async () => {
        const page = await open(seeded(note('a', NOW - DAY)));
        await peel(page);
        page.pick('recordings', 'a');
        await page.settle();
        page.element('note_buzz').value = 'Call the plumber';
        page.element('note_type').value = 'todo';
        page.element('note_remind').value = Model.localInput(NOW + 2 * HOUR);
        page.element('note_essay').value = 'The tap\nin the kitchen';
        page.submit();
        await page.settle();

        const saved = page.stored('notes', 'a');
        assert.deepStrictEqual([saved.buzz, saved.type, saved.remind, saved.essay],
            ['Call the plumber', 'TODO', Model.fromLocalInput(Model.localInput(NOW + 2 * HOUR)), 'The tap\nin the kitchen']);
        assert.strictEqual(page.element('dlg_note').open, false);
        assert.strictEqual(page.element('status').textContent, 'Updated.');
        assert.match(page.rows('reminders')[0].text, /Call the plumber TODO/);
        assert.match(page.rows('recordings')[0].text, /Call the plumber TODO/);
        assert.strictEqual(page.stored('meta', alice.pub), undefined, 'TODO is no new type');
        assert.ok(page.worker.periodic.length > 0 && page.worker.periodic.every(p => p.tag === 'rama-reminders'), 'the worker is to be woken for it');
    });

    it('asks the browser to wake the worker once the user lets Rama notify, and not before', async () => {
        const page = await open({ ...seeded(note('a', NOW - DAY)), permission: 'default', answer: 'granted' });
        assert.deepStrictEqual(page.worker.periodic, []);
        await peel(page);
        page.pick('recordings', 'a');
        await page.settle();
        page.element('note_remind').value = Model.localInput(NOW + HOUR);
        page.submit();
        await page.settle();
        assert.strictEqual(page.asked.length, 1);
        assert.deepStrictEqual(page.worker.periodic.map(p => [p.tag, p.minInterval]), [['rama-reminders', 15 * MINUTE]]);
    });

    it('refuses a reminder moved into the past, and keeps the overlay open to fix it', async () => {
        const page = await open(seeded(note('a', NOW - DAY)));
        await peel(page);
        page.pick('recordings', 'a');
        await page.settle();
        page.element('note_remind').value = Model.localInput(NOW - HOUR);
        page.submit();
        await page.settle();
        assert.match(page.element('note_error').textContent, /passed/);
        assert.strictEqual(page.element('dlg_note').open, true);
        assert.strictEqual(page.stored('notes', 'a').remind, null);
    });

    it('asks to notify when a reminder is set, and says so when it may not', async () => {
        const page = await open({ ...seeded(note('a', NOW - DAY)), permission: 'default', answer: 'denied' });
        await peel(page);
        page.pick('recordings', 'a');
        await page.settle();
        page.element('note_buzz').value = 'no reminder';
        page.submit();
        await page.settle();
        assert.strictEqual(page.asked.length, 0, 'not without a reminder');

        page.pick('recordings', 'a');
        await page.settle();
        page.element('note_remind').value = Model.localInput(NOW + HOUR);
        page.submit();
        await page.settle();
        assert.strictEqual(page.asked.length, 1);
        assert.match(page.element('status').textContent, /in the list only/);
        assert.ok(page.stored('notes', 'a').remind, 'kept all the same');
        assert.deepStrictEqual(page.worker.periodic, []);
    });

    it('suggests types as they are typed, and picks one by click or by the arrow keys and Enter', async () => {
        const page = await open(seeded(note('a', NOW - DAY), note('b', NOW - HOUR, { type: 'Poem' })));
        await peel(page);
        page.pick('recordings', 'a');
        await page.settle();
        const offered = () => page.element('note_types').hidden ? [] : [...page.html('note_types').matchAll(/data-type="([^"]+)"/g)].map(m => m[1]);

        page.element('note_type').fire('focus');
        assert.deepStrictEqual(offered(), ['TODO', 'Recipe', 'HOWTO', 'Poem'], 'the three, and those the user made');
        assert.strictEqual(page.element('note_type').getAttribute('aria-expanded'), 'true');

        page.type('note_type', 'p');
        assert.deepStrictEqual(offered(), ['Poem', 'Recipe'], 'starting with it, then having it');
        page.choose('Poem');
        assert.strictEqual(page.element('note_type').value, 'Poem');
        assert.deepStrictEqual(offered(), []);

        page.type('note_type', 're');
        assert.deepStrictEqual(offered(), ['Recipe']);
        assert.strictEqual(page.key('note_type', 'ArrowDown').prevented, true);
        assert.match(page.html('note_types'), /data-type="Recipe" aria-selected="true"/);
        assert.strictEqual(page.element('note_type').getAttribute('aria-activedescendant'), 'type_option_0');
        assert.strictEqual(page.key('note_type', 'Enter').prevented, true, 'Enter picks, it does not submit');
        assert.strictEqual(page.element('note_type').value, 'Recipe');

        page.type('note_type', 'h');
        assert.strictEqual(page.key('note_type', 'Escape').prevented, true, 'Escape closes the list, not the overlay');
        assert.deepStrictEqual(offered(), []);
        assert.strictEqual(page.key('note_type', 'Enter').prevented, false, 'with the list closed, Enter submits');
    });

    it('adds a new type to the suggestions, for this recording and every other', async () => {
        const page = await open(seeded(note('a', NOW - DAY), note('b', NOW - HOUR)));
        await peel(page);
        page.pick('recordings', 'a');
        await page.settle();
        page.element('note_type').value = 'Shopping';
        page.submit();
        await page.settle();
        assert.deepStrictEqual(page.stored('meta', alice.pub), { types: ['Shopping'] });

        page.pick('recordings', 'b');
        await page.settle();
        page.type('note_type', 'sh');
        assert.match(page.html('note_types'), /data-type="Shopping"/);

        // It stays a type when no recording has it any more, and after a reload.
        page.element('note_type').value = '';
        page.submit();
        await page.settle();
        const again = await open({ indexedDB: page.indexedDB });
        await peel(again);
        again.pick('recordings', 'a');
        await again.settle();
        again.element('note_type').value = '';
        again.submit();
        await again.settle();
        again.pick('recordings', 'b');
        await again.settle();
        again.type('note_type', 'sh');
        assert.match(again.html('note_types'), /data-type="Shopping"/);
    });

    it('reminds when the time comes: a notification through the service worker, and a line on the page - once', async () => {
        const page = await open(seeded(note('a', NOW - DAY, { buzz: 'Plumber', type: 'TODO', remind: NOW + HOUR })));
        page.advance(HOUR - 1);
        await page.settle();
        assert.deepStrictEqual(page.worker.notified, []);

        page.advance(1);
        await page.settle();
        assert.deepStrictEqual(page.worker.notified.map(n => [n.title, n.body, n.tag, plain(n.data)]),
            [['Rama: TODO', 'Plumber', 'rama-a', { id: 'a' }]]);
        assert.strictEqual(page.element('status').textContent, 'Reminder: Plumber');
        assert.strictEqual(page.stored('fired', 'a'), NOW + HOUR);

        page.show();
        await page.settle();
        assert.strictEqual(page.worker.notified.length, 1, 'not again');
        await peel(page);
        assert.match(page.html('reminders'), /class="row past" data-id="a"/);
    });

    it('shows on opening what came due while it was closed, unless the worker did already', async () => {
        const due = note('a', NOW - DAY, { buzz: 'Missed', remind: NOW - HOUR });
        const page = await open(seeded(due, note('b', NOW - DAY, { buzz: 'Shown', remind: NOW - 2 * HOUR })));
        assert.deepStrictEqual(page.worker.notified.map(n => n.body), ['Shown', 'Missed']);

        const shown = await open({ ...seeded(due), idb: { ...seeded(due).idb, fired: { a: NOW - HOUR } } });
        assert.deepStrictEqual(shown.worker.notified, []);
    });

    it('waits for a reminder further off than a timer can, in steps', async () => {
        const far = NOW + 40 * DAY;
        const page = await open(seeded(note('a', NOW, { buzz: 'Far', remind: far })));
        assert.ok(page.clock.timers.some(t => t.at === NOW + 2147483647), 'a step no longer than setTimeout takes');
        page.advance(40 * DAY - 1);
        await page.settle();
        assert.deepStrictEqual(page.worker.notified, []);
        page.advance(1);
        await page.settle();
        assert.deepStrictEqual(page.worker.notified.map(n => n.body), ['Far']);
    });

    it('notifies from the page itself when no service worker is there', async () => {
        const page = await open({ ...seeded(note('a', NOW, { buzz: 'Here', remind: NOW - MINUTE })), worker: { registered: false } });
        assert.deepStrictEqual(page.worker.notified.map(n => [n.body, n.page]), [['Here', true]]);
    });

    it('opens the recording a reminder was clicked for: on load from the address, or when the worker says so', async () => {
        const page = await open({ ...seeded(note('a', NOW - DAY, { buzz: 'Plumber' })), hash: '#note=a' });
        assert.ok(page.has('page_browse', 'front'), 'the lists at once, no peel');
        assert.strictEqual(page.element('dlg_note').open, true);
        assert.strictEqual(page.element('note_buzz').value, 'Plumber');

        const other = await open(seeded(note('a', NOW - DAY, { buzz: 'Plumber' })));
        other.message({ type: 'rama:open', id: 'nope' });
        assert.strictEqual(other.element('dlg_note').open, false);
        other.message({ type: 'rama:open', id: 'a' });
        await other.settle();
        assert.ok(other.has('page_browse', 'front'));
        assert.strictEqual(other.element('dlg_note').open, true);
    });
});
