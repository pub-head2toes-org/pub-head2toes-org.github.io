'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const PWA_DIR = path.join(import.meta.dirname, '..', 'src', 'fs', 'pwa', 'lol');
const read = name => fs.readFileSync(path.join(PWA_DIR, name), 'utf8');
const PAGE = 'https://localhost:9443/fs/get/pwa/lol/index.html?organizer=You&participants=You';
const LIST_URL = 'https://localhost:9443/fs/get/pwa/lol/objects/objects.json';

// The sizes of the images in objects/, as a browser would load them.
const SIZES = { 'tree.png': [180, 240], 'blossom.png': [180, 230], 'rock.png': [140, 100], 'tower.png': [140, 280], 'building.png': [360, 320], 'hotel-sign.png': [240, 100] };
const base = src => src.split(/[?#]/)[0].split('/').pop();

/** lol.js as the page loads it, before the lobby: its globals, nothing drawn yet. */
function loadLol({ fetch, sizes = SIZES } = {}) {
    class Image {
        get src() { return this._src; }
        set src(value) {
            this._src = value;
            const size = sizes[base(value)];
            Object.assign(this, size ? { complete: true, naturalWidth: size[0], naturalHeight: size[1] } : { complete: false, naturalWidth: 0 });
        }
    }
    const warnings = [];
    const context = {
        console: { log() {}, error() {}, warn: (...args) => warnings.push(args) },
        URL, Image, fetch,
        location: { href: PAGE },
        document: { addEventListener() {} },
        performance: { now: () => 0 },
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(read('lol.js'), context);
    context.state = vm.runInContext('state', context);
    context.warnings = warnings;
    return context;
}

/** The canvas the main view draws on, set to show the map 1:1 around `me`. */
function onScreen(lol, players, objects) {
    const ops = [];
    const ctx = new Proxy({}, {
        get: (target, key) => key in target ? target[key] : () => {},
        set: (target, key, value) => { target[key] = value; return true; },
    });
    ctx.drawImage = (img) => ops.push(img === lol.state.mapImg ? 'map' : `object ${base(img.src)}`);
    for (const [fn, label] of [['drawAvatar', 'avatar'], ['drawAvatarLabel', 'label']]) {
        const original = lol[fn];
        lol[fn] = (...args) => { ops.push(`${label} ${args[4]}`); return original(...args); };
    }
    const outline = lol.drawHiddenOutline;
    lol.drawHiddenOutline = (...args) => { ops.push('outline'); return outline(...args); };

    Object.assign(lol.state, {
        canvas: { width: 800, height: 600 }, ctx, zoomSpan: 800,
        mapReady: true, mapW: 5087, mapH: 4916, player: 'You', players,
        objects: lol.parseObjects(objects, LIST_URL),
    });
    lol.render();
    return ops;
}

const player = (x, y) => ({ x, y, targetX: x, targetY: y, dir: 'down', walking: false });

describe('LoL map objects', () => {
    it('reads the objects file: sorted by Y, images relative to the file, one image per file', () => {
        const lol = loadLol();
        const objects = lol.parseObjects({ objects: [
            { id: 'low', src: 'tree.png', x: 100, y: 900 },
            { id: 'high', src: 'tree.png', x: 120, y: 100 },
            { id: 'mid', src: '../maps/rock.png', x: 140, y: 500, w: 70, h: 50 },
        ] }, LIST_URL);

        assert.deepStrictEqual(Array.from(objects, o => [o.id, o.z]), [['high', 100], ['mid', 500], ['low', 900]]);
        assert.strictEqual(objects[0].img.src, 'https://localhost:9443/fs/get/pwa/lol/objects/tree.png');
        assert.strictEqual(objects[1].img.src, 'https://localhost:9443/fs/get/pwa/lol/maps/rock.png');
        assert.strictEqual(objects[0].img, objects[2].img);
    });

    it('stands an object on its x/y: the bottom-center of its image, at its own size unless told', () => {
        const lol = loadLol();
        const [tree, small] = lol.parseObjects([
            { src: 'tree.png', x: 500, y: 1000 },
            { src: 'tree.png', x: 500, y: 2000, w: 90, h: 120 },
        ], LIST_URL);

        assert.deepStrictEqual({ ...lol.objectRect(tree) }, { left: 410, top: 760, w: 180, h: 240 });
        assert.deepStrictEqual({ ...lol.objectRect(small) }, { left: 455, top: 1880, w: 90, h: 120 });
    });

    it('waits for an image before it takes up room on the map', () => {
        const lol = loadLol({ sizes: {} });
        const [tree] = lol.parseObjects([{ src: 'tree.png', x: 500, y: 1000 }], LIST_URL);

        assert.strictEqual(lol.objectRect(tree), null);
        assert.strictEqual(lol.spriteLayer(player(500, 900), [tree]).behind.length, 0);
    });

    it('skips entries it cannot place, and says so', () => {
        const lol = loadLol();
        const objects = lol.parseObjects({ objects: [
            { src: 'tree.png', x: 1, y: 2 }, { src: 'tree.png', x: '1', y: 2 }, { x: 1, y: 2 }, null,
        ] }, LIST_URL);

        assert.strictEqual(objects.length, 1);
        assert.strictEqual(lol.warnings.length, 3);
    });

    it('fetches the list next to the page, past the HTTP cache, into state', async () => {
        const calls = [];
        const lol = loadLol({ fetch: async (url, options) => {
            calls.push([url, options.cache]);
            return { ok: true, json: async () => ({ objects: [{ src: 'rock.png', x: 10, y: 20 }] }) };
        } });

        await lol.loadObjects();

        assert.deepStrictEqual(calls, [[LIST_URL, 'no-cache']]);
        assert.strictEqual(lol.state.objects.length, 1);
        assert.strictEqual(lol.state.objects[0].img.src, 'https://localhost:9443/fs/get/pwa/lol/objects/rock.png');
    });

    it('plays on without objects when the list is missing', async () => {
        const lol = loadLol({ fetch: async () => ({ ok: false, status: 404 }) });

        await lol.loadObjects();

        assert.strictEqual(lol.state.objects.length, 0);
        assert.match(String(lol.warnings[0]), /map objects not loaded/);
    });

    it('ships a list whose every object stands on the map and has its image', () => {
        const lol = loadLol();
        const list = JSON.parse(read('objects/objects.json'));
        const objects = lol.parseObjects(list, LIST_URL);

        assert.strictEqual(objects.length, list.objects.length);
        for (const o of objects) {
            assert.ok(fs.existsSync(path.join(PWA_DIR, 'objects', base(o.img.src))), o.img.src);
            assert.ok(o.x >= 0 && o.x <= 5087 && o.y >= 0 && o.y <= 4916, o.id);
        }
        // Some within sight of where everybody starts (300, 4616).
        assert.ok(objects.some(o => Math.hypot(o.x - 300, o.y - 4616) < 600));
    });
});

describe('LoL sprite in front of or behind an object', () => {
    const tree = { src: 'tree.png', x: 520, y: 4520 }; // covers x 430..610, y 4280..4520

    it('is behind an object it collides with while its feet are above the object\'s base', () => {
        const lol = loadLol();
        const objects = lol.parseObjects([tree], LIST_URL);

        const layer = lol.spriteLayer(player(520, 4450), objects);

        assert.strictEqual(layer.z, 4450 + 36);
        assert.deepStrictEqual(Array.from(layer.behind, o => o.x), [520]);
    });

    it('is in front once its feet are below the base', () => {
        const lol = loadLol();
        const objects = lol.parseObjects([tree], LIST_URL);

        assert.strictEqual(lol.spriteLayer(player(520, 4500), objects).behind.length, 0);
        assert.strictEqual(lol.spriteLayer(player(520, 4520 - 36), objects).behind.length, 0, 'feet on the base');
    });

    it('is not behind an object it does not touch, wherever it stands', () => {
        const lol = loadLol();
        const objects = lol.parseObjects([tree], LIST_URL);

        assert.strictEqual(lol.spriteLayer(player(300, 4400), objects).behind.length, 0);
        assert.strictEqual(lol.spriteLayer(player(520, 4200), objects).behind.length, 0);
    });

    it('draws the map, then objects and avatars from the top of the map down, then the names', () => {
        const lol = loadLol();
        const ops = onScreen(lol, { You: player(520, 4450), Winnie: player(700, 4300) }, [
            tree,
            { src: 'rock.png', x: 420, y: 4380 },
            { src: 'tower.png', x: 860, y: 4600 },
        ]);

        assert.deepStrictEqual(ops, [
            'map',
            'avatar Winnie',      // feet at 4336
            'object rock.png',    // base 4380
            'avatar You',         // feet at 4486
            'object tree.png',    // base 4520: over You
            'object tower.png',   // base 4600
            'outline',            // You, hidden behind the tree
            'label You',
            'label Winnie',
        ]);
    });

    it('moves the player\'s own avatar in front as it walks below the object', () => {
        const lol = loadLol();
        const ops = onScreen(lol, { You: player(520, 4500) }, [tree]);

        assert.deepStrictEqual(ops, ['map', 'object tree.png', 'avatar You', 'label You']);
    });

    it('leaves out objects off the screen', () => {
        const lol = loadLol();
        const ops = onScreen(lol, { You: player(520, 4500) }, [tree, { src: 'tower.png', x: 3000, y: 1000 }]);

        assert.ok(!ops.includes('object tower.png'));
    });
});

describe('LoL obstacles', () => {
    // Footprint x 835..1165, y 870..1000; an avatar's center stays out of x 799..1201, y 834..1036.
    const building = { id: 'house', src: 'building.png', x: 1000, y: 1000, type: 'obstacle', footprint: { w: 330, h: 130 } };
    const MAP = [5087, 4916];

    function walking(objects, fetch = async () => {}) {
        const lol = loadLol({ fetch });
        Object.assign(lol.state, { mapW: MAP[0], mapH: MAP[1], sseLink: '/sub/joint/lol-test', player: 'You', players: {} });
        lol.state.objects = lol.parseObjects(objects, LIST_URL);
        return lol;
    }

    /** Walk `name` to its target a frame at a time, checking it never sets foot on a footprint. */
    function walk(lol, name, rects, frames = 3000) {
        const p = lol.state.players[name];
        let now = 0;
        for (let i = 0; i < frames && p.walking; i++) {
            lol.stepParticipant(name, 1 / 60, now += 1000 / 60);
            for (const r of rects) assert.ok(!lol.insideRect(p.x, p.y, r), `${name} at ${p.x},${p.y} walked into an obstacle`);
        }
        return p;
    }

    it('reads an obstacle and its footprint; any other object can be walked through', () => {
        const lol = loadLol();
        const [tree, house] = lol.parseObjects([building, { src: 'tree.png', x: 0, y: 0 }], LIST_URL);

        assert.strictEqual(house.obstacle, true);
        assert.deepStrictEqual({ ...lol.footprintRect(house) }, { left: 835, top: 870, w: 330, h: 130 });
        assert.strictEqual(tree.obstacle, false);
        assert.strictEqual(lol.footprintRect(tree), null);
    });

    it('takes the bottom third of the image as the footprint when none is given', () => {
        const lol = loadLol();
        const [house] = lol.parseObjects([{ src: 'building.png', x: 1000, y: 1000, type: 'obstacle' }], LIST_URL);

        assert.deepStrictEqual({ ...lol.footprintRect(house) }, { left: 820, top: 1000 - 320 * (1 / 3), w: 360, h: 320 * (1 / 3) });
        const [loading] = loadLol({ sizes: {} }).parseObjects([{ src: 'building.png', x: 1, y: 1, type: 'obstacle' }], LIST_URL);
        assert.strictEqual(lol.footprintRect(loading), null, 'not before its image is in');
    });

    it('walks straight when nothing is in the way', () => {
        const lol = loadLol();
        const rects = lol.blockedRects(lol.parseObjects([building], LIST_URL));

        assert.deepStrictEqual(Array.from(lol.planPath(700, 700, 1300, 700, rects, ...MAP), p => [...p]), [[1300, 700]]);
    });

    it('plans a way around a building, by its corners, ending on the target', () => {
        const lol = loadLol();
        const rects = lol.blockedRects(lol.parseObjects([building], LIST_URL));

        const route = Array.from(lol.planPath(700, 950, 1300, 950, rects, ...MAP), p => [...p]);

        assert.deepStrictEqual(route, [[797, 1038], [1203, 1038], [1300, 950]], 'round the nearer, bottom side');
        let [x, y] = [700, 950];
        for (const [nx, ny] of route) {
            assert.ok(!lol.segmentHitsRect(x, y, nx, ny, rects[0]), `${x},${y} -> ${nx},${ny}`);
            [x, y] = [nx, ny];
        }
    });

    it('takes a click on a building to the nearest spot beside it', () => {
        const lol = loadLol();
        const rects = lol.blockedRects(lol.parseObjects([building], LIST_URL));

        const route = Array.from(lol.planPath(1000, 1200, 1000, 990, rects, ...MAP), p => [...p]);

        assert.deepStrictEqual(route, [[1000, 1038]]);
    });

    it('stays put when there is no way through', () => {
        const lol = loadLol();
        const wall = { src: 'building.png', x: MAP[0] / 2, y: 2000, type: 'obstacle', footprint: { w: MAP[0], h: 100 } };
        const rects = lol.blockedRects(lol.parseObjects([wall], LIST_URL));

        assert.strictEqual(lol.planPath(1000, 1000, 1000, 3000, rects, ...MAP), null);
    });

    it('walks the player round a building to where they clicked, and says so on arrival', () => {
        const sent = [];
        const lol = walking([building], async (url, options) => { sent.push(JSON.parse(options.body)); });
        lol.state.players.You = { ...player(700, 950), targetX: 1300, targetY: 950, walking: true, lastBroadcastTs: 0 };

        const p = walk(lol, 'You', lol.blockedRects(lol.state.objects));

        assert.deepStrictEqual([p.x, p.y, p.walking], [1300, 950, false]);
        assert.deepStrictEqual(sent.at(-1), { type: 'move', from: 'You', ts: sent.at(-1).ts, x: 1300, y: 950, dir: 'right', walking: false });
    });

    it('walks a bot round it too: bots.js only sets the target', () => {
        const lol = walking([building]);
        lol.state.players.Winnie = { ...player(1000, 700), isBot: true, lastBroadcastTs: 0 };
        Object.assign(lol.state.players.Winnie, { targetX: 1000, targetY: 1300, walking: true });

        const p = walk(lol, 'Winnie', lol.blockedRects(lol.state.objects));

        assert.deepStrictEqual([p.x, p.y], [1000, 1300]);
    });

    it('plans again when the target changes on the way', () => {
        const lol = walking([building]);
        const p = lol.state.players.You = { ...player(700, 950), targetX: 1300, targetY: 950, walking: true, lastBroadcastTs: 0 };
        for (let i = 0; i < 30; i++) lol.stepParticipant('You', 1 / 60, i * 16);

        Object.assign(p, { targetX: 600, targetY: 600 });
        walk(lol, 'You', lol.blockedRects(lol.state.objects));

        assert.deepStrictEqual([p.x, p.y, p.walking], [600, 600, false]);
    });

    it('steps out first when it finds itself on an obstacle', () => {
        const lol = walking([building]);
        const p = lol.state.players.You = { ...player(1000, 1020), targetX: 1000, targetY: 1300, walking: true, lastBroadcastTs: 0 };

        lol.stepParticipant('You', 1 / 60, 16);

        assert.ok(p.y > 1020 && p.x === 1000, 'out the near, bottom side');
        walk(lol, 'You', []);
        assert.deepStrictEqual([p.x, p.y], [1000, 1300]);
    });

    it('ships obstacles that leave the start, and the way out of it, free', () => {
        const lol = loadLol();
        const objects = lol.parseObjects(JSON.parse(read('objects/objects.json')), LIST_URL);
        const rects = lol.blockedRects(objects);

        assert.ok(objects.some(o => o.obstacle && base(o.img.src) === 'building.png'));
        assert.ok(!rects.some(r => lol.insideRect(300, 4616, r)), 'the start');
        assert.ok(lol.planPath(300, 4616, 2500, 2500, rects, ...MAP), 'to the middle of the map');
        for (const o of objects.filter(o => o.obstacle)) {
            assert.ok(lol.footprintRect(o).w <= lol.objectRect(o).w, `${o.id}: no wider than its image`);
        }
    });
});

describe('LoL covers', () => {
    // Covers x 400..640, y 900..1000.
    const sign = { id: 'sign', src: 'hotel-sign.png', x: 520, y: 1000, type: 'cover' };

    it('reads a cover: on top of players, but neither walked around nor an obstacle', () => {
        const lol = loadLol();
        const [cover] = lol.parseObjects([sign], LIST_URL);

        assert.deepStrictEqual([cover.cover, cover.obstacle], [true, false]);
        assert.strictEqual(lol.footprintRect(cover), null);
        assert.strictEqual(lol.blockedRects([cover]).length, 0);
    });

    it('is over a player who collides with it, wherever their feet are', () => {
        const lol = loadLol();
        const objects = lol.parseObjects([sign], LIST_URL);

        assert.strictEqual(lol.spriteLayer(player(520, 900), objects).behind.length, 1, 'above its base');
        assert.strictEqual(lol.spriteLayer(player(520, 1020), objects).behind.length, 1, 'below its base');
        assert.strictEqual(lol.spriteLayer(player(520, 1100), objects).behind.length, 0, 'not touching it');
    });

    it('draws covers over every object and avatar, and the names over the covers', () => {
        const lol = loadLol();
        const ops = onScreen(lol, { You: player(520, 1020), Winnie: player(700, 1150) }, [
            sign,
            { src: 'tree.png', x: 800, y: 1200 },
        ]);

        assert.deepStrictEqual(ops, [
            'map',
            'avatar You',         // feet at 1056: below the sign's base, yet under it
            'avatar Winnie',      // feet at 1186
            'object tree.png',    // base 1200
            'object hotel-sign.png',
            'outline',            // You, hidden by the sign
            'label You',
            'label Winnie',
        ]);
    });

    it('ships a HOTEL sign on the roof of the building by the start', () => {
        const lol = loadLol();
        const objects = lol.parseObjects(JSON.parse(read('objects/objects.json')), LIST_URL);
        const hotel = objects.find(o => o.id === 'hotel-sign');
        const building = objects.find(o => o.id === 'start-building');

        assert.strictEqual(hotel.cover, true);
        const [s, b] = [lol.objectRect(hotel), lol.objectRect(building)];
        assert.ok(s.left >= b.left && s.left + s.w <= b.left + b.w && s.top + s.h > b.top && hotel.y < building.y);
    });
});

describe('LoL versions', () => {
    it('tags every script and the stylesheet with the service worker\'s version', () => {
        const version = /CACHE_NAME = 'lol-v(\d+)'/.exec(read('sw.js'))[1];
        const html = read('index.html');
        const tags = [...html.matchAll(/(?:src|href)="\.\/[\w.]+\.(?:js|css)(\?v=(\d+))?"/g)].map(m => m[2]);

        assert.ok(tags.length >= 3);
        assert.deepStrictEqual(tags, tags.map(() => version));
    });

    it('precaches every image the shipped objects list uses', () => {
        const sw = read('sw.js');
        for (const src of new Set(JSON.parse(read('objects/objects.json')).objects.map(o => o.src))) {
            assert.ok(sw.includes(`'./objects/${src}'`), src);
        }
    });
});
