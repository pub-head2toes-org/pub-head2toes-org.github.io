'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const PWA_DIR = path.join(import.meta.dirname, '..', 'src', 'fs', 'pwa', 'zine');
const read = name => fs.readFileSync(path.join(PWA_DIR, name), 'utf8');
const ORIGIN = 'https://localhost:9443';
const PAGE_PATH = '/fs/get/pwa/zine/index.html';
const base = src => src.split(/[?#]/)[0].split('/').pop();
const plain = value => JSON.parse(JSON.stringify(value));

// The sizes of the images, as a browser would load them.
function imageSize(src) {
    const name = base(src);
    if (name === 'current.png') return [5087, 4916];
    const file = path.join(PWA_DIR, 'objects', name);
    if (!fs.existsSync(file)) return null;
    const png = fs.readFileSync(file);
    return [png.readUInt32BE(16), png.readUInt32BE(20)];
}

/** As the browser has them: called bare, never as a method of something else. */
function strict(fn) {
    return function (...args) {
        if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
        return fn(...args);
    };
}

function fakeElement(id) {
    const classes = new Set(id === 'game_view' ? ['hidden'] : []);
    return {
        id, textContent: '', hidden: id === 'lobby_error', disabled: false, value: '', listeners: {},
        width: 800, height: 600,
        classList: {
            add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c),
            toggle: (c, on) => (on ?? !classes.has(c)) ? classes.add(c) : classes.delete(c),
        },
        addEventListener(type, fn) { this.listeners[type] = fn; },
        focus() {},
        getContext: () => new Proxy({}, { get: (t, k) => k in t ? t[k] : () => {}, set: (t, k, v) => { t[k] = v; return true; } }),
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    };
}

/**
 * zine.js on a page: the DOM, the Northern session, the channel and the clock
 * it needs, each a fake that remembers what was done with it.
 */
function loadZine({ search = '', signedIn = true, name = 'Ana', pub = 'PUB-ANA' } = {}) {
    const elements = {};
    const element = id => elements[id] || (elements[id] = fakeElement(id));
    const body = fakeElement('body');
    body.classList.add('view-lobby');
    const timers = [];
    const sent = [];
    const fetches = [];
    const sources = [];
    const page = { replaced: null, href: `${ORIGIN}${PAGE_PATH}${search}`, now: 1_000_000 };

    class Image {
        get src() { return this._src; }
        set src(value) {
            this._src = value;
            const size = imageSize(value);
            Object.assign(this, size ? { complete: true, naturalWidth: size[0], naturalHeight: size[1] } : { complete: false, naturalWidth: 0 });
        }
    }
    class EventSource { constructor(url) { this.url = url; sources.push(this); } }

    const location = {
        pathname: PAGE_PATH, search, hash: '',
        get href() { return page.href; },
        set href(value) { page.href = value; },
        replace: value => { page.replaced = value; },
    };
    const context = {
        console: { log() {}, warn() {}, error() {} },
        URL, URLSearchParams, Image, EventSource, location,
        navigator: {},
        innerWidth: 800, innerHeight: 600,
        session: {
            signedIn: () => signedIn, pub: () => pub, userName: () => name,
        },
        document: { body, getElementById: element, addEventListener() {} },
        performance: { now: () => 0 },
        setTimeout: strict((fn, ms) => timers.push({ fn, ms })),
        setInterval: strict(() => 0),
        requestAnimationFrame: strict(() => 0),
        fetch: strict(async (url, options = {}) => {
            fetches.push([url, options]);
            if (options.method === 'PUT') sent.push(JSON.parse(options.body));
            return { ok: false, status: 404 };
        }),
        addEventListener() {},
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(read('zine.js'), context);
    // Date.now is the sandbox's own: pin it, so the lot's ranking is the test's to set.
    vm.runInContext(`Date.now = () => ${page.now}`, context);
    context.state = vm.runInContext('state', context);
    return Object.assign(context, { element, body, timers, sent, fetches, sources, page });
}

/** Every timer due so far, then whatever they set going. */
async function runTimers(zine) {
    while (zine.timers.length) zine.timers.shift().fn();
    await new Promise(resolve => setImmediate(resolve));
}

/** Somebody else in the issue, as their heartbeat says. */
const envelope = (from, extra = {}) => ({ type: 'move', from, name: from, issue: 'current', since: 1, x: 500, y: 500, dir: 'down', walking: false, ...extra });

function crowd(zine, count, since = 1) {
    for (let i = 0; i < count; i++) zine.handleEnvelope(envelope(`PUB-${String(i).padStart(3, '0')}`, { since }), zine.page.now);
}

describe('Zine settings', () => {
    it('needs no organizer, participants or sse_link: the current issue on /sub/joint/zine', () => {
        const zine = loadZine();

        assert.deepStrictEqual(plain(zine.readSettings({})), { issue: 'current', sseLink: '/sub/joint/zine' });
        assert.strictEqual(zine.mapSrc('current'), './maps/current.png');
        assert.strictEqual(zine.objectsSrc('current'), './objects/current.json');
    });

    it('takes the issue, and a channel when one is given', () => {
        const zine = loadZine();

        assert.deepStrictEqual(plain(zine.readSettings({ issue: 'spring-2027', sse_link: '/sub/joint/other' })),
            { issue: 'spring-2027', sseLink: '/sub/joint/other' });
    });

    it('turns away an issue that is not a plain file name', () => {
        const zine = loadZine();

        for (const issue of ['../lol/objects', 'a/b', 'a.b', 'x'.repeat(65)]) {
            assert.strictEqual(zine.readSettings({ issue }), null, issue);
        }
    });
});

describe('Zine lobby', () => {
    it('sends whoever is not signed in to Northern to sign in, and back here after', () => {
        const zine = loadZine({ signedIn: false, search: '?issue=current' });

        zine.initLobby();

        assert.strictEqual(zine.page.replaced, '/fs/get/reg/Reg.html#/fs/get/pwa/zine/index.html?issue=current');
        assert.strictEqual(zine.sources.length, 0);
    });

    it('sends an issue that cannot be a file name to the error page', () => {
        const zine = loadZine({ search: '?issue=../secret' });

        zine.initLobby();

        assert.strictEqual(zine.page.href, './error.html');
    });

    it('joins as the name signed in with, keyed by the Northern public key', async () => {
        const zine = loadZine({ search: '?issue=current' });
        zine.initLobby();
        assert.strictEqual(zine.element('lobby_player').textContent, 'Ana');
        assert.strictEqual(zine.sources[0].url, '/sub/joint/zine');

        zine.element('enter_btn').listeners.click();
        zine.sources[0].onopen();
        await runTimers(zine);

        assert.strictEqual(zine.state.joined, true);
        assert.ok(zine.element('lobby_view').classList.contains('hidden'));
        assert.strictEqual(zine.element('hud_player').textContent, 'Ana');
        assert.ok(!zine.sent.some(e => e.type === 'join'), 'not before the floor is in');

        zine.state.mapImg.onload();
        const join = zine.sent.find(e => e.type === 'join');
        assert.deepStrictEqual(join, { type: 'join', from: 'PUB-ANA', name: 'Ana', issue: 'current', since: zine.page.now, ts: zine.page.now, x: 300, y: 4916 - 300 });
        assert.ok(zine.sent.some(e => e.type === 'state_request'));
        assert.strictEqual(zine.state.players['PUB-ANA'].name, 'Ana');
    });

    it('draws everybody under the name they signed in with, not their key', async () => {
        const zine = loadZine();
        zine.initLobby();
        zine.element('enter_btn').listeners.click();
        zine.sources[0].onopen();
        await runTimers(zine);
        zine.state.mapImg.onload();
        zine.handleEnvelope(envelope('PUB-BO', { name: 'Bo', x: 400, y: 4500 }), zine.page.now);
        const labels = [];
        const original = zine.drawAvatarLabel;
        zine.drawAvatarLabel = (...args) => { labels.push(args[4]); return original(...args); };

        zine.tick(16);

        assert.deepStrictEqual(labels.sort(), ['Ana', 'Bo']);
    });

    it('does not join before it has listened long enough to count who is in', async () => {
        const zine = loadZine();
        zine.initLobby();

        zine.element('enter_btn').listeners.click();
        await new Promise(resolve => setImmediate(resolve));

        assert.strictEqual(zine.state.joined, false);
        assert.strictEqual(zine.element('enter_btn').disabled, true);
    });

    it('reports "Lot full" when 100 are in already, and stays in the lobby', async () => {
        const zine = loadZine();
        zine.initLobby();
        crowd(zine, 100);

        zine.element('enter_btn').listeners.click();
        zine.sources[0].onopen();
        await runTimers(zine);

        assert.strictEqual(zine.state.joined, false);
        assert.strictEqual(zine.element('lobby_error').textContent, 'Lot full');
        assert.strictEqual(zine.element('lobby_error').hidden, false);
        assert.strictEqual(zine.element('enter_btn').disabled, false);
        assert.ok(!zine.sent.some(e => e.type === 'join'));
    });

    it('lets the 100th in', async () => {
        const zine = loadZine();
        zine.initLobby();
        crowd(zine, 99);

        zine.element('enter_btn').listeners.click();
        zine.sources[0].onopen();
        await runTimers(zine);

        assert.strictEqual(zine.state.joined, true);
    });

    it('shows how many are in the issue', () => {
        const zine = loadZine();
        zine.initLobby();
        crowd(zine, 3);

        zine.updateRoster(zine.page.now);

        assert.strictEqual(zine.element('lobby_count').textContent, '3 / 100');
    });
});

describe('Zine roster and the lot', () => {
    it('grows with everybody heard in the issue, and nobody from another issue', () => {
        const zine = loadZine();
        zine.initLobby();

        zine.handleEnvelope(envelope('PUB-BO', { name: 'Bo' }), 10);
        zine.handleEnvelope(envelope('PUB-CY', { issue: 'spring' }), 10);

        assert.deepStrictEqual(Object.keys(zine.state.roster), ['PUB-BO']);
        assert.strictEqual(zine.state.players['PUB-BO'].name, 'Bo');
    });

    it('forgets whoever has gone quiet, and whoever said they left', () => {
        const zine = loadZine();
        zine.initLobby();
        zine.handleEnvelope(envelope('PUB-BO'), 0);
        zine.handleEnvelope(envelope('PUB-CY'), 2500);
        zine.handleEnvelope(envelope('PUB-DI'), 2500);

        zine.handleEnvelope({ type: 'leave', from: 'PUB-DI', issue: 'current' }, 2600);
        zine.updateRoster(3500);

        assert.deepStrictEqual(Object.keys(zine.state.roster), ['PUB-CY']);
        assert.deepStrictEqual(Object.keys(zine.state.players), ['PUB-CY']);
    });

    it('ignores its own envelopes coming back', () => {
        const zine = loadZine();
        zine.initLobby();

        zine.handleEnvelope(envelope('PUB-ANA'), 10);

        assert.deepStrictEqual(Object.keys(zine.state.roster), []);
    });

    it('settles a race for the last place by who joined first', async () => {
        const zine = loadZine();
        zine.initLobby();
        crowd(zine, 99, 1);
        zine.element('enter_btn').listeners.click();
        zine.sources[0].onopen();
        await runTimers(zine);
        assert.strictEqual(zine.state.joined, true);

        // Somebody else saw room at the same moment, but joined a moment earlier.
        zine.handleEnvelope(envelope('PUB-ZED', { since: zine.state.since - 5 }), zine.page.now);
        zine.updateRoster(zine.page.now);

        assert.strictEqual(zine.state.joined, false);
        assert.strictEqual(zine.element('lobby_error').textContent, 'Lot full');
        assert.ok(!zine.element('lobby_view').classList.contains('hidden'));
        assert.strictEqual(zine.sent.at(-1).type, 'leave');
        assert.ok(!zine.state.players['PUB-ANA']);
    });

    it('stays when the other one joined later', async () => {
        const zine = loadZine();
        zine.initLobby();
        crowd(zine, 99, 1);
        zine.element('enter_btn').listeners.click();
        zine.sources[0].onopen();
        await runTimers(zine);

        zine.handleEnvelope(envelope('PUB-ZED', { since: zine.state.since + 5 }), zine.page.now);
        zine.updateRoster(zine.page.now);

        assert.strictEqual(zine.state.joined, true);
    });

    it('puts the key first in a tie on time', () => {
        const zine = loadZine({ pub: 'PUB-M' });
        Object.assign(zine.state, { joined: true, since: 5, me: { id: 'PUB-M', name: 'M' } });
        crowd(zine, 99, 1);

        zine.handleEnvelope(envelope('PUB-N', { since: 5 }), 0);
        assert.strictEqual(zine.overLimit(), false, 'M before N');
        zine.handleEnvelope(envelope('PUB-L', { since: 5 }), 0);
        assert.strictEqual(zine.overLimit(), true, 'L before M');
    });

    it('labels chat with the name signed in with', () => {
        const zine = loadZine();
        zine.initLobby();

        zine.handleEnvelope({ type: 'chat', from: 'PUB-BO', name: 'Bo', issue: 'current', since: 1, m: 'hi' }, 0);

        assert.strictEqual(zine.element('chat_board').value, 'Bo: hi\n');
    });
});

describe('Zine issue "current"', () => {
    const list = JSON.parse(read('objects/current.json'));

    function issue() {
        const zine = loadZine();
        const objects = zine.parseObjects(list, `${ORIGIN}/fs/get/pwa/zine/objects/current.json`);
        return { zine, objects, rects: zine.blockedRects(objects) };
    }

    it('has a floor the size of LoL\'s map', () => {
        const png = fs.readFileSync(path.join(PWA_DIR, 'maps', 'current.png'));
        const jpg = fs.readFileSync(path.join(PWA_DIR, '..', 'lol', 'maps', 'dota_map.jpg'));
        // The JPEG's size, from its start-of-frame marker.
        let i = 2;
        while (!(jpg[i] === 0xff && jpg[i + 1] >= 0xc0 && jpg[i + 1] <= 0xc2)) i += 2 + jpg.readUInt16BE(i + 2);

        assert.strictEqual(png.toString('latin1', 1, 4), 'PNG');
        assert.deepStrictEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [jpg.readUInt16BE(i + 7), jpg.readUInt16BE(i + 5)]);
    });

    it('lays small and large picture frames on the floor, to be walked around', () => {
        const { zine, objects } = issue();
        const frames = objects.filter(o => o.obstacle);
        const area = o => zine.footprintRect(o).w * zine.footprintRect(o).h;

        assert.ok(frames.every(o => base(o.img.src).startsWith('frame-')));
        assert.ok(frames.some(o => area(o) < 50_000), 'small');
        assert.ok(frames.some(o => area(o) > 250_000), 'large');
        // Flat on the floor: the footprint is the whole picture, so nobody is ever behind one.
        for (const o of frames) assert.deepStrictEqual({ ...zine.footprintRect(o) }, { ...zine.objectRect(o) }, o.id);
    });

    it('hangs direction signs over everybody', () => {
        const { objects } = issue();
        const signs = objects.filter(o => o.cover);

        assert.ok(signs.length >= 3);
        assert.ok(signs.every(o => base(o.img.src).startsWith('sign-')));
        assert.ok(signs.some(o => base(o.img.src) === 'sign-exit.png'));
    });

    it('has every image it names, inside the walls', () => {
        const { zine, objects } = issue();

        assert.strictEqual(objects.length, list.objects.length);
        for (const o of objects) {
            const r = zine.objectRect(o);
            assert.ok(r, `${o.id}: ${o.img.src}`);
            assert.ok(r.left >= 44 && r.top >= 44 && r.left + r.w <= 5087 - 44 && r.top + r.h <= 4916 - 44, o.id);
        }
    });

    it('leaves the door free, and a way from it to every frame', () => {
        const { zine, objects, rects } = issue();

        assert.ok(!rects.some(r => zine.insideRect(300, 4616, r)));
        for (const o of objects.filter(o => o.obstacle)) {
            const f = zine.footprintRect(o);
            const route = zine.planPath(300, 4616, f.left + f.w / 2, f.top + f.h + 60, rects, 5087, 4916);
            assert.ok(route, `to ${o.id}`);
        }
    });
});

describe('Zine versions', () => {
    it('tags every script and the stylesheet with the service worker\'s version', () => {
        const version = /CACHE_NAME = 'zine-v(\d+)'/.exec(read('sw.js'))[1];
        const tags = [...read('index.html').matchAll(/(?:src|href)="[./\w-]+\.(?:js|css)(\?v=(\d+))?"/g)].map(m => m[2]);

        assert.ok(tags.length >= 7);
        assert.deepStrictEqual(tags, tags.map(() => version));
    });

    it('loads the Northern session before zine.js, and no bots', () => {
        const html = read('index.html');

        assert.ok(html.indexOf('reg/session.js') < html.indexOf('zine.js'));
        assert.ok(!html.includes('bots.js'));
    });
});
