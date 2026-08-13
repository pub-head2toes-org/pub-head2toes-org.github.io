'use strict';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { REPO_ROOT, tmpDbPaths, seedSchema } from './helpers/db.js';

// Server reads server.key / server.crt relative to the working directory.
process.chdir(REPO_ROOT);

const { default: Server } = await import('../src/h2t/Server.js');

let server;
let base;
let httpPort;
let dbFile;

/** Asks the OS for a free port so a running instance of the app does not clash. */
async function freePort() {
    const probe = net.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address();
    await new Promise(resolve => probe.close(resolve));
    return port;
}

// Any ssid is enough to get past the "must be registered" redirect; an invalid
// one simply resolves to the 'public' author.
const ANON = { cookie: 'ssid=not-a-real-signature' };

const get = (p, headers = {}) => fetch(`${base}${p}`, { headers, redirect: 'manual' });
const post = (p, body, headers = ANON) => fetch(`${base}${p}`, { method: 'POST', body, headers, redirect: 'manual' });
const put = (p, body, headers = ANON) => fetch(`${base}${p}`, { method: 'PUT', body, headers, redirect: 'manual' });

before(async () => {
    const paths = tmpDbPaths('server.test.db');
    dbFile = paths.absolute;
    await seedSchema(dbFile);

    httpPort = await freePort();
    server = new Server(httpPort, paths.relativeToSrcH2t, await freePort());
    base = `http://127.0.0.1:${httpPort}`;

    await new Promise(resolve => server.httpServer.once('listening', resolve));
});

after(async () => {
    server.httpServer.closeAllConnections();
    server.sslServer.closeAllConnections();
    await new Promise(resolve => server.httpServer.close(resolve));
    await new Promise(resolve => server.sslServer.close(resolve));
    fs.rmSync(dbFile, { force: true });
});

// Feature A2: both listeners come up on the configured ports
describe('Server listeners', () => {
    it('listens for plain HTTP', () => {
        assert.strictEqual(server.httpServer.listening, true);
    });

    it('listens for HTTPS with the configured key pair', () => {
        assert.strictEqual(server.sslServer.listening, true);
    });
});

// Feature B1: entry point redirect
describe('GET /', () => {
    it('redirects the bare root to the home page on the file system', async () => {
        const res = await get('/');

        assert.strictEqual(res.status, 302);
        assert.strictEqual(res.headers.get('location'), '/fs/get/home.html');
    });

    it('does not redirect when the root carries a search query', async () => {
        const res = await get('/?search=%25');

        assert.strictEqual(res.status, 200);
        assert.ok(Array.isArray(await res.json()));
    });
});

// Feature B2: writes require a session cookie
describe('registration gate', () => {
    it('redirects an unauthenticated POST to the registration page, keeping the path in the fragment', async () => {
        const res = await fetch(`${base}/notes/1`, { method: 'POST', body: 'x', redirect: 'manual' });

        assert.strictEqual(res.status, 302);
        assert.strictEqual(res.headers.get('location'), '/fs/get/reg/Reg.html#/notes/1');
    });

    it('redirects an unauthenticated PUT as well', async () => {
        const res = await fetch(`${base}/notes/1`, { method: 'PUT', body: 'x', redirect: 'manual' });

        assert.strictEqual(res.status, 302);
    });

    it('leaves GET requests open to anonymous callers', async () => {
        const res = await fetch(`${base}/notes/does-not-exist`, { redirect: 'manual' });

        assert.strictEqual(res.status, 200);
    });

    it('exempts the registration pages themselves so a user can sign up', async () => {
        const res = await fetch(`${base}/fs/get/reg/Reg.html`, { redirect: 'manual' });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.headers.get('content-type'), 'text/html');
    });
});

// Features B3/D4: the core key/value contract
describe('POST then GET a key', () => {
    it('stores the request body under the request path', async () => {
        const created = await post('/notes/hello', JSON.stringify({ hi: true }));
        assert.deepStrictEqual(await created.json(), { status: 'OK', path: '/notes/hello' });

        const read = await get('/notes/hello');
        assert.strictEqual(read.status, 200);
        assert.deepStrictEqual(await read.json(), { hi: true });
    });

    it('derives the content type from the key extension', async () => {
        await post('/pages/demo.html', '<h1>demo</h1>');
        const res = await get('/pages/demo.html');

        assert.strictEqual(res.headers.get('content-type'), 'text/html');
        assert.strictEqual(await res.text(), '<h1>demo</h1>');
    });

    it('serves a stored .js key as javascript, so the DB doubles as a web server', async () => {
        await post('/pages/app.js', 'export const a = 1;');
        const res = await get('/pages/app.js');

        assert.strictEqual(res.headers.get('content-type'), 'application/javascript');
    });

    it('answers an unknown key with an unavailable marker', async () => {
        const res = await get('/notes/nothing');

        assert.deepStrictEqual(await res.json(), { unavailable: '/notes/nothing', author: 'public' });
    });

    it('files anonymous writes under the public author', async () => {
        await post('/notes/anon', 'body');
        const res = await get('/notes/anon?searchPlus=%25');

        const [row] = await res.json();
        assert.strictEqual(row.author, 'public');
    });
});

// Feature F4: group selection through the query string
describe('group scoping', () => {
    it('publishes to everybody with ?isPublic=true', async () => {
        await post('/notes/open?isPublic=true', 'open');
        const [row] = await (await get('/notes/open?searchPlus=%25')).json();

        assert.strictEqual(row.public, 'public');
    });

    it('publishes to a named group with ?isGroup=', async () => {
        await post('/notes/team?isGroup=friends', 'team');
        const [row] = await (await get('/notes/team?searchPlus=%25&isGroup=friends')).json();

        assert.strictEqual(row.public, 'friends');
    });

    // Group isolation only bites for signed authors: an anonymous write is filed
    // under the shared 'public' author, which the ACL treats as "everybody"
    // (see REFACTORING.md #5). Isolation between real authors is covered in
    // SqliteDB.test.js.
    it('still shows an anonymous group row to everyone, because its author is "public"', async () => {
        const res = await get('/notes/team?isGroup=strangers');

        assert.strictEqual(await res.text(), 'team');
    });
});

// Feature B3/D3: updates
describe('PUT a key', () => {
    it('replaces the stored value', async () => {
        await post('/notes/edit', 'first');
        const res = await put('/notes/edit', 'second');
        assert.strictEqual(res.status, 200);

        // The write is fire and forget, so give it a moment to land.
        await new Promise(r => setTimeout(r, 200));
        assert.strictEqual(await (await get('/notes/edit')).text(), 'second');
    });

    it('acknowledges with an empty body', { todo: 'db.update() returns undefined, so nothing is serialised (REFACTORING.md #4)' }, async () => {
        await post('/notes/edit2', 'first');
        const res = await put('/notes/edit2', 'second');

        assert.deepStrictEqual(await res.json(), { status: 'OK', path: '/notes/edit2' });
    });
});

// Feature D2 over HTTP: re-POSTing a key keeps the previous value as a version
describe('versioning over HTTP', () => {
    it('moves a re-posted value to <path>/<counter>', async () => {
        await post('/notes/versioned', 'v1');
        await post('/notes/versioned', 'v2');
        await new Promise(r => setTimeout(r, 300));

        assert.strictEqual(await (await get('/notes/versioned')).text(), 'v1');
        assert.strictEqual(await (await get('/notes/versioned/0')).text(), 'v2');
    });
});

// Feature G1: ActivityPub style deletes are acknowledged but not stored
describe('/pub/ namespace', () => {
    it('acknowledges a Delete activity without storing it', async () => {
        const res = await post('/pub/inbox', JSON.stringify({ type: 'Delete', actor: 'x' }));
        assert.deepStrictEqual(await res.json(), { status: 'OK' });

        assert.ok((await (await get('/pub/inbox')).json()).unavailable);
    });

    it('stores any other activity normally', async () => {
        await post('/pub/note', JSON.stringify({ type: 'Create' }));

        assert.deepStrictEqual(await (await get('/pub/note')).json(), { type: 'Create' });
    });
});

// Features E1/E2/E3: publish-subscribe over server sent events
describe('SSE pub/sub', () => {
    /**
     * Opens a long lived event stream on a socket of its own - fetch keeps the
     * connection in a pool, which deadlocks once a body is never finished.
     */
    function subscribe(key) {
        const frames = [];
        const waiting = [];
        const conn = {
            close: () => conn.request.destroy(),
            next: () => frames.length
                ? Promise.resolve(frames.shift())
                : new Promise(resolve => waiting.push(resolve))
        };

        return new Promise((resolve, reject) => {
            conn.request = http.request(
                { host: '127.0.0.1', port: httpPort, path: `/sub/${key}`, method: 'GET' },
                res => {
                    conn.contentType = res.headers['content-type'];
                    conn.statusCode = res.statusCode;
                    res.setEncoding('utf8');
                    res.on('data', chunk => waiting.length ? waiting.shift()(chunk) : frames.push(chunk));
                    resolve(conn);
                });
            conn.request.on('error', reject);
            conn.request.end();
        });
    }

    it('opens an event stream and greets the subscriber', async () => {
        const sse = await subscribe('room-open');
        try {
            assert.strictEqual(sse.statusCode, 200);
            assert.strictEqual(sse.contentType, 'text/event-stream');
            assert.strictEqual(await sse.next(), 'data: {"status":"OK"}\n\n');
        } finally {
            sse.close();
        }
    });

    it('delivers a PUT on /sub/<key> to the subscribers of that key', async () => {
        const sse = await subscribe('room-chat');
        try {
            await sse.next(); // handshake
            await put('/sub/room-chat', 'hello room');

            assert.strictEqual(await sse.next(), 'data: hello room\n\n');
        } finally {
            sse.close();
        }
    });

    it('fans a message out to several subscribers of the same key', async () => {
        const a = await subscribe('room-many');
        const b = await subscribe('room-many');
        try {
            await a.next();
            await b.next();
            await put('/sub/room-many', 'broadcast');

            assert.strictEqual(await a.next(), 'data: broadcast\n\n');
            assert.strictEqual(await b.next(), 'data: broadcast\n\n');
        } finally {
            a.close();
            b.close();
        }
    });

    it('does not deliver a message to a different key', async () => {
        const sse = await subscribe('room-quiet');
        try {
            await sse.next();
            await put('/sub/room-loud', 'not for you');

            const raced = await Promise.race([
                sse.next(),
                new Promise(resolve => setTimeout(() => resolve('nothing'), 150))
            ]);
            assert.strictEqual(raced, 'nothing');
        } finally {
            sse.close();
        }
    });

    it('answers the publisher with a count', async () => {
        // NB: the count is Object.keys(sub).length, i.e. the number of keys with
        // subscribers, not the number of receivers (see REFACTORING.md #7).
        const sse = await subscribe('room-count');
        try {
            await sse.next();
            const body = await (await put('/sub/room-count', 'x')).json();

            assert.strictEqual(typeof body.clients, 'number');
            assert.ok(body.clients >= 1);
        } finally {
            sse.close();
        }
    });

    it('does not persist what it broadcasts', async () => {
        const sse = await subscribe('room-ephemeral');
        try {
            await sse.next();
            await put('/sub/room-ephemeral', 'transient');

            assert.ok((await (await get('/notes/room-ephemeral')).json()).unavailable);
        } finally {
            sse.close();
        }
    });

    it('broadcasts a PUT on a plain key to its subscribers as well', async () => {
        // renderSub strips the /sub prefix, so subscribing to /sub/notes/live
        // registers under /notes/live - the key a normal PUT publishes to.
        const sse = await subscribe('notes/live');
        try {
            await sse.next();
            await put('/notes/live', 'live value');

            assert.strictEqual(await sse.next(), 'data: live value\n\n');
        } finally {
            sse.close();
        }
    });
});

// Features B6/B7: static assets
describe('file system namespace', () => {
    it('serves /fs/get/<file> from src/fs', async () => {
        const res = await get('/fs/get/s.css');

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.headers.get('content-type'), 'text/css');
        assert.strictEqual(await res.text(), fs.readFileSync(path.join(REPO_ROOT, 'src/fs/s.css'), 'utf8'));
    });

    it('serves the console and editor page', async () => {
        const res = await get('/fs/get/keyboard.html');

        assert.strictEqual(res.headers.get('content-type'), 'text/html');
        assert.match(await res.text(), /keyboard/i);
    });

    it('serves binary assets unmangled', async () => {
        const res = await get('/fs/get/pwa/lol/icon-192.png');
        const body = Buffer.from(await res.arrayBuffer());

        assert.strictEqual(res.headers.get('content-type'), 'image/png');
        assert.deepStrictEqual(body, fs.readFileSync(path.join(REPO_ROOT, 'src/fs/pwa/lol/icon-192.png')));
    });

    it('serves /static/<file> from src/static', async () => {
        const res = await get('/static/prj-cat-128x128.png');

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.headers.get('content-type'), 'image/png');
    });

    it('answers a missing file with a JSON error instead of crashing', async () => {
        const res = await get('/fs/get/no-such-file.html');

        assert.strictEqual(res.status, 200);
        assert.match(await res.text(), /ENOENT|errno/);
    });
});

// Feature B9: search over HTTP
describe('search over HTTP', () => {
    before(async () => {
        await post('/search/a', 'alpha');
        await post('/search/b', 'bravo');
    });

    it('?search= returns matching keys without their values', async () => {
        const rows = await (await get('/search/?search=%25')).json();

        assert.deepStrictEqual(rows.map(r => r.path), ['/search/b', '/search/a']);
        assert.ok(rows.every(r => !('value' in r)));
    });

    it('?searchPlus= returns the values as well', async () => {
        const rows = await (await get('/search/?searchPlus=%25')).json();

        assert.strictEqual(rows.find(r => r.path === '/search/a').value, 'alpha');
    });

    it('?keyword= filters on the value', async () => {
        const rows = await (await get('/search/?keyword=%25bravo%25')).json();

        assert.deepStrictEqual(rows.map(r => r.path), ['/search/b']);
    });

    it('?offset= pages through the results', async () => {
        const rows = await (await get('/search/?search=%25&offset=1')).json();

        assert.deepStrictEqual(rows.map(r => r.path), ['/search/a']);
    });
});

// Feature H1: counters
describe('metrics counters', () => {
    it('creates a counter on its first PUT', async () => {
        const res = await put('/metrics/counter/fresh', '');
        assert.strictEqual((await res.json()).status, 'OK');

        await new Promise(r => setTimeout(r, 150));
        assert.strictEqual(await (await get('/metrics/counter/fresh')).text(), '1');
    });

    it('keeps the node alive after counting a brand new key', async () => {
        await put('/metrics/counter/fresh2', '');
        await new Promise(r => setTimeout(r, 150));

        assert.strictEqual(server.httpServer.listening, true);
        assert.strictEqual((await get('/')).status, 302);
    });

    it('increments an existing counter key', async () => {
        await post('/metrics/counter/visits', '0');
        const res = await put('/metrics/counter/visits', '');
        assert.strictEqual((await res.json()).status, 'OK');

        await new Promise(r => setTimeout(r, 150));
        assert.strictEqual(await (await get('/metrics/counter/visits')).text(), '1');
    });

    it('serves a counter key as its plain number', async () => {
        const res = await get('/metrics/counter/visits');

        assert.strictEqual(res.headers.get('content-type'), 'text/html');
        assert.match(await res.text(), /^\d+$/);
    });
});

// The replica ingest endpoint has been removed: it was an unauthenticated write
// over GET, for a replication feature that does not work (REFACTORING.md #9).
describe('GET /db/insert', () => {
    it('no longer writes, and reads as an ordinary key', async () => {
        const res = await get('/db/insert?path=/replica/a&type=txt&value=hi');

        assert.deepStrictEqual(await res.json(), { unavailable: '/db/insert', author: 'public' });
    });

    it('leaves the key it used to write untouched', async () => {
        await get('/db/insert?path=/replica/b&type=txt&value=hi');

        assert.ok((await (await get('/replica/b')).json()).unavailable);
    });
});
