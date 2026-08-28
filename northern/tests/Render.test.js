'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs';
import Render from '../src/h2t/Render.js';
import MockRes from './helpers/mockRes.js';

const render = new Render();
const REPO_ROOT = path.join(import.meta.dirname, '..');

// Feature C1: content type is derived from the path extension
describe('Render.getType', () => {
    it('returns the extension of the path', () => {
        assert.strictEqual(render.getType('/fs/get/home.html'), 'html');
        assert.strictEqual(render.getType('/fs/get/js/keyboard.js'), 'js');
        assert.strictEqual(render.getType('/static/prj-cat.png'), 'png');
    });

    it('falls back to txt when there is no extension', () => {
        assert.strictEqual(render.getType('/notes/2026/summer'), 'txt');
        assert.strictEqual(render.getType('/'), 'txt');
    });

    it('uses the last extension of a multi-dot path', () => {
        assert.strictEqual(render.getType('/fs/get/style.css.old'), 'old');
        assert.strictEqual(render.getType('/a.b.json'), 'json');
    });
});

// Feature C2: type -> Content-Type mapping
describe('Render.renderData content types', () => {
    const cases = [
        ['html', '<h1>hi</h1>', 'text/html'],
        ['md', '# hi', 'text/html'],
        ['txt', 'hi', 'text/html'],
        ['tsv', 'a\tb', 'text/html'],
        ['xml', '<rss/>', 'text/xml'],
        ['json', '{"a":1}', 'application/json'],
        ['js', 'var a=1', 'application/javascript'],
        ['css', 'body{}', 'text/css'],
        ['png', Buffer.from([0x89, 0x50]), 'image/png'],
        ['jpg', Buffer.from([0xff, 0xd8]), 'image/jpeg'],
        ['jpeg', Buffer.from([0xff, 0xd8]), 'image/jpeg'],
        ['zip', Buffer.from([0x50, 0x4b]), 'application/zip']
    ];

    for (const [type, value, contentType] of cases) {
        it(`serves ${type} as ${contentType}`, async () => {
            const res = new MockRes();
            render.renderData({ type, value }, res);
            await res.done;

            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.contentType, contentType);
            assert.deepStrictEqual(res.buffer, Buffer.isBuffer(value) ? value : Buffer.from(value));
        });
    }

    it('serves a counter row as its numeric value', async () => {
        const res = new MockRes();
        render.renderData({ type: 'counter', counter: 42 }, res);
        await res.done;

        assert.strictEqual(res.contentType, 'text/html');
        assert.strictEqual(res.body, '42');
    });

    it('falls back to a JSON dump for unknown types', async () => {
        const res = new MockRes();
        render.renderData({ unavailable: '/missing', author: 'public' }, res);
        await res.done;

        assert.strictEqual(res.contentType, 'application/json');
        assert.deepStrictEqual(res.json, { unavailable: '/missing', author: 'public' });
    });

    // Feature C3: audio is streamed from disk with a Content-Length
    it('streams mp3 from filePath with a Content-Length', async () => {
        const filePath = path.join(REPO_ROOT, 'src/fs/games/Am.mp3');
        const res = new MockRes();
        render.renderData({ type: 'mp3', filePath }, res);
        await res.done;

        assert.strictEqual(res.contentType, 'audio/mpeg');
        assert.strictEqual(res.headers['Content-Length'], fs.statSync(filePath).size);
        assert.strictEqual(res.buffer.length, fs.statSync(filePath).size);
    });

    it('streams m4a from filePath as audio/mp4', async () => {
        const filePath = path.join(REPO_ROOT, 'src/fs/games/Am.m4a');
        const res = new MockRes();
        render.renderData({ type: 'm4a', filePath }, res);
        await res.done;

        assert.strictEqual(res.contentType, 'audio/mp4');
        assert.strictEqual(res.buffer.length, fs.statSync(filePath).size);
    });
});

describe('Render.renderJSON / renderSearchResults', () => {
    it('renderJSON writes a JSON body', async () => {
        const res = new MockRes();
        render.renderJSON({ status: 'OK', path: '/a' }, res);
        await res.done;

        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.contentType, 'application/json');
        assert.deepStrictEqual(res.json, { status: 'OK', path: '/a' });
    });

    it('renderSearchResults writes the row array as JSON', async () => {
        const rows = [{ path: '/a' }, { path: '/b' }];
        const res = new MockRes();
        render.renderSearchResults(rows, res);
        await res.done;

        assert.deepStrictEqual(res.json, rows);
    });
});

// Feature B6/B7: read-only serving from the file system
describe('Render.renderFromFS / renderStatic', () => {
    it('serves /fs/get/<file> from src/fs with the right type', async () => {
        const res = new MockRes();
        render.renderFromFS('/fs/get/s.css', res);
        await res.done;

        assert.strictEqual(res.contentType, 'text/css');
        assert.strictEqual(res.body, fs.readFileSync(path.join(REPO_ROOT, 'src/fs/s.css'), 'utf8'));
    });

    it('serves nested paths such as /fs/get/js/keyboard.js', async () => {
        const res = new MockRes();
        render.renderFromFS('/fs/get/js/keyboard.js', res);
        await res.done;

        assert.strictEqual(res.contentType, 'application/javascript');
        assert.match(res.body, /Keyboard/);
    });

    it('serves binary files from /fs/get byte for byte', async () => {
        const res = new MockRes();
        render.renderFromFS('/fs/get/pwa/lol/icon-192.png', res);
        await res.done;

        assert.strictEqual(res.contentType, 'image/png');
        assert.deepStrictEqual(res.buffer, fs.readFileSync(path.join(REPO_ROOT, 'src/fs/pwa/lol/icon-192.png')));
    });

    it('serves /static/<file> from src/static', async () => {
        const res = new MockRes();
        render.renderStatic('/static/prj-cat-128x128.png', res);
        await res.done;

        assert.strictEqual(res.contentType, 'image/png');
        assert.deepStrictEqual(res.buffer, fs.readFileSync(path.join(REPO_ROOT, 'src/static/prj-cat-128x128.png')));
    });

    it('throws on a missing file rather than answering 404', () => {
        const res = new MockRes();
        assert.throws(() => render.renderFromFS('/fs/get/does-not-exist.html', res), /ENOENT/);
    });

    it('rejects path traversal outside src/fs', { todo: 'no path sanitising - arbitrary file read (REFACTORING.md #1)' }, () => {
        const res = new MockRes();
        assert.throws(() => render.renderFromFS('/fs/get/../../package.json', res));
    });
});

// Feature B8: byte-range streaming for video
describe('Render.renderMP4', () => {
    // renderMP4 resolves against the *parent* of the repo (see REFACTORING.md #1),
    // so the fixture is addressed relative to that root.
    const mp4Root = path.join(REPO_ROOT, '..');
    const fixture = path.relative(mp4Root, path.join(REPO_ROOT, 'tests/fixtures'));
    const mp4Path = `/mp4/get/../${fixture}/sample.mp4`;
    const srtPath = `/mp4/get/../${fixture}/sample.srt`;
    const mp4Size = fs.statSync(path.join(REPO_ROOT, 'tests/fixtures/sample.mp4')).size;

    it('serves the whole file as 206 when no Range header is sent', async () => {
        const res = new MockRes();
        render.renderMP4(mp4Path, { headers: {} }, res);
        await res.done;

        assert.strictEqual(res.statusCode, 206);
        assert.strictEqual(res.headers['Content-Type'], 'video/mp4');
        assert.strictEqual(res.headers['Accept-Ranges'], 'bytes');
        assert.strictEqual(res.headers['Content-Range'], `bytes 0-${mp4Size - 1}/${mp4Size}`);
        assert.strictEqual(res.headers['Content-Length'], mp4Size);
        assert.strictEqual(res.buffer.length, mp4Size);
    });

    it('honours a closed byte range', async () => {
        const res = new MockRes();
        render.renderMP4(mp4Path, { headers: { range: 'bytes=10-19' } }, res);
        await res.done;

        assert.strictEqual(res.statusCode, 206);
        assert.strictEqual(res.headers['Content-Range'], `bytes 10-19/${mp4Size}`);
        assert.strictEqual(res.headers['Content-Length'], 10);
        assert.strictEqual(res.buffer.length, 10);
        assert.strictEqual(res.buffer[0], 10);
    });

    it('honours an open ended byte range', async () => {
        const res = new MockRes();
        render.renderMP4(mp4Path, { headers: { range: 'bytes=990-' } }, res);
        await res.done;

        assert.strictEqual(res.headers['Content-Range'], `bytes 990-${mp4Size - 1}/${mp4Size}`);
        assert.strictEqual(res.buffer.length, 10);
    });

    it('streams non-mp4 files as plain text without ranges', async () => {
        const res = new MockRes();
        render.renderMP4(srtPath, { headers: {} }, res);
        await res.done;

        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.headers['Content-Type'], 'text/plain; charset=utf-8');
        assert.match(res.body, /hello/);
    });
});

// Feature E1/E4: server sent event subscriptions
describe('Render.renderSub', () => {
    it('registers a client under the key and opens the stream', async () => {
        const sub = {};
        const req = new EventEmitter();
        const res = new MockRes();

        render.renderSub(sub, '/sub/room1', req, res);

        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.contentType, 'text/event-stream');
        assert.strictEqual(res.headers['Cache-Control'], 'no-cache');
        assert.strictEqual(res.body, 'data: {"status":"OK"}\n\n');
        assert.deepStrictEqual(Object.keys(sub), ['/room1']);
        assert.strictEqual(sub['/room1'].length, 1);
        assert.strictEqual(sub['/room1'][0].response, res);
    });

    it('appends further clients to the same key', () => {
        const sub = {};
        render.renderSub(sub, '/sub/room1', new EventEmitter(), new MockRes());
        render.renderSub(sub, '/sub/room1', new EventEmitter(), new MockRes());

        assert.strictEqual(sub['/room1'].length, 2);
    });

    it('keeps separate lists per key', () => {
        const sub = {};
        render.renderSub(sub, '/sub/a', new EventEmitter(), new MockRes());
        render.renderSub(sub, '/sub/b', new EventEmitter(), new MockRes());

        assert.deepStrictEqual(Object.keys(sub).sort(), ['/a', '/b']);
    });

    it('drops the client when the request closes', () => {
        const sub = {};
        const req = new EventEmitter();
        render.renderSub(sub, '/sub/room1', req, new MockRes());
        assert.strictEqual(sub['/room1'].length, 1);

        req.emit('close');
        assert.strictEqual(sub['/room1'].length, 0);
    });
});

// Feature B9: GET dispatch between plain reads and the three search modes
describe('Render.render query dispatch', () => {
    const fakeDb = () => {
        const calls = [];
        return {
            calls,
            get: (...args) => { calls.push(['get', ...args.slice(0, -1)]); args.at(-1)({ type: 'txt', value: 'v' }); },
            search: (...args) => { calls.push(['search', ...args.slice(0, -1)]); args.at(-1)([{ path: '/a' }]); },
            searchPlus: (...args) => { calls.push(['searchPlus', ...args.slice(0, -1)]); args.at(-1)([{ path: '/a' }]); },
            keyword: (...args) => { calls.push(['keyword', ...args.slice(0, -1)]); args.at(-1)([{ path: '/a' }]); }
        };
    };

    it('reads a single key when there is no query', async () => {
        const db = fakeDb();
        const res = new MockRes();
        render.render(db, 'alice', 'public', '/notes/1', {}, res);
        await res.done;

        assert.deepStrictEqual(db.calls, [['get', '/notes/1', 'alice', 'public']]);
        assert.strictEqual(res.body, 'v');
    });

    it('appends ?search to the path as the LIKE pattern', async () => {
        const db = fakeDb();
        const res = new MockRes();
        render.render(db, 'alice', 'public', '/notes/', { search: '%' }, res);
        await res.done;

        assert.deepStrictEqual(db.calls, [['search', '/notes/%', 'alice', 0, 'public']]);
        assert.deepStrictEqual(res.json, [{ path: '/a' }]);
    });

    it('parses ?offset for paging', async () => {
        const db = fakeDb();
        const res = new MockRes();
        render.render(db, 'alice', 'public', '/notes/', { search: '%', offset: '100' }, res);
        await res.done;

        assert.deepStrictEqual(db.calls, [['search', '/notes/%', 'alice', 100, 'public']]);
    });

    it('routes ?searchPlus to the value returning search', async () => {
        const db = fakeDb();
        const res = new MockRes();
        render.render(db, 'alice', 'grp', '/notes/', { searchPlus: '%' }, res);
        await res.done;

        assert.deepStrictEqual(db.calls, [['searchPlus', '/notes/%', 'alice', 0, 'grp']]);
    });

    it('routes ?keyword to the full text search, keeping path and keyword apart', async () => {
        const db = fakeDb();
        const res = new MockRes();
        render.render(db, 'alice', 'grp', '/notes/', { keyword: '%todo%', offset: '20' }, res);
        await res.done;

        assert.deepStrictEqual(db.calls, [['keyword', '/notes/', '%todo%', 'alice', 20, 'grp']]);
    });

    it('prefers search over searchPlus and keyword when several are given', async () => {
        const db = fakeDb();
        const res = new MockRes();
        render.render(db, 'alice', 'grp', '/n/', { search: '%', searchPlus: '%', keyword: 'x' }, res);
        await res.done;

        assert.strictEqual(db.calls[0][0], 'search');
        assert.strictEqual(db.calls.length, 1);
    });
});
