'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import nodeCrypto from 'node:crypto';
import { REPO_ROOT, TMP_DIR, tmpDbPaths, seedSchema } from './helpers/db.js';
import sjclClass from '../src/h2t/sjclClass.js';
import Render from '../src/h2t/Render.js';
import Crypto from '../src/h2t/Crypto.js';
import TempApi, { EXPIRY, MAX_FILE } from '../src/h2t/TempApi.js';

const sjcl = new sjclClass().get();

/** A Northern identity exactly as reg/session.js drafts one, with a live cookie. */
function identity(name) {
    const keys = sjcl.ecc.ecdsa.generateKeys(256, 0);
    const pub = sjcl.codec.base64.fromBits(keys.pub.get().x.concat(keys.pub.get().y));
    const signed = `${pub}.${Date.now()}`;
    const ssid = `${signed}.${sjcl.codec.base64.fromBits(keys.sec.sign(sjcl.hash.sha256.hash(signed), 0))}`;
    return { name, pub, ssid };
}
const alice = identity('alice');

async function freePort() {
    const probe = net.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address();
    await new Promise(resolve => probe.close(resolve));
    return port;
}

/** A request with full control of the headers - Host and Content-Length included. */
function request(port, method, path, { body, headers = {} } = {}) {
    // As fetch sends a Blob or an ArrayBuffer: with its length.
    if (body !== undefined && !('content-length' in headers) && !('transfer-encoding' in headers)) {
        headers = { ...headers, 'content-length': String(Buffer.byteLength(body)) };
    }
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method, path, headers }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const buffer = Buffer.concat(chunks);
                resolve({ status: res.statusCode, headers: res.headers, buffer, json: () => JSON.parse(buffer.toString()) });
            });
        });
        req.on('error', reject);
        if (body !== undefined) req.write(body);
        req.end();
    });
}

const bytes = (n, fill = 'x') => Buffer.alloc(n, fill);
const octets = { 'content-type': 'application/octet-stream' };
const as = who => ({ ...octets, cookie: `ssid=${who.ssid}` });
const until = async (check, what) => {
    for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(check(), what);
};

// ---------------------------------------------------------------------------
// Through Server.js, on a throwaway database: UPLOAD sits next to it
// ---------------------------------------------------------------------------

describe('TempApi - through the server', () => {
    let server;
    let port;
    let dbFile;
    const uploadDir = path.join(TMP_DIR, 'UPLOAD');
    const upload = (body, headers = as(alice)) => request(port, 'POST', '/temp/api/upload', { body, headers });
    const download = id => request(port, 'GET', '/temp/api/download/' + id);

    before(async () => {
        process.chdir(REPO_ROOT);
        fs.rmSync(uploadDir, { recursive: true, force: true });
        const { default: Server } = await import('../src/h2t/Server.js');
        const paths = tmpDbPaths('tempapi.test.db');
        dbFile = paths.absolute;
        await seedSchema(dbFile);
        port = await freePort();
        server = new Server(port, paths.relativeToSrcH2t, await freePort());
        await new Promise(resolve => server.httpServer.once('listening', resolve));
        server.temp.log = () => {};
    });

    after(async () => {
        server.httpServer.closeAllConnections();
        server.sslServer.closeAllConnections();
        await new Promise(resolve => server.httpServer.close(resolve));
        await new Promise(resolve => server.sslServer.close(resolve));
        fs.rmSync(dbFile, { force: true });
        fs.rmSync(uploadDir, { recursive: true, force: true });
    });

    it('keeps an upload in UPLOAD next to the database, under a random name it answers with', async () => {
        const jpeg = nodeCrypto.randomBytes(5000);
        const response = await upload(jpeg, { ...as(alice), 'content-type': 'image/jpeg' });
        const { status, id, size } = response.json();

        assert.strictEqual(response.status, 200);
        assert.deepStrictEqual([status, size], ['OK', 5000]);
        assert.match(id, /^[A-Za-z0-9_-]{43}$/);
        assert.deepStrictEqual(fs.readFileSync(path.join(uploadDir, id)), jpeg);
        assert.notStrictEqual((await upload(jpeg)).json().id, id, 'and every upload gets a name of its own');
    });

    it('hands the file back to anybody with its name, as bytes nobody runs, and marks it for deletion', async () => {
        const sealed = nodeCrypto.randomBytes(3000);
        const { id } = (await upload(sealed)).json();

        const first = await download(id);
        assert.strictEqual(first.status, 200);
        assert.deepStrictEqual(first.buffer, sealed);
        assert.strictEqual(first.headers['content-type'], 'application/octet-stream');
        assert.strictEqual(first.headers['content-disposition'], 'attachment');
        assert.strictEqual(first.headers['x-content-type-options'], 'nosniff');

        await until(() => fs.existsSync(path.join(uploadDir, id + '.del')), 'marked once downloaded');
        assert.ok(!fs.existsSync(path.join(uploadDir, id)));
        const again = await download(id);
        assert.deepStrictEqual([again.status, again.buffer], [200, sealed], 'and it is there until it is purged');
    });

    it('serves nothing a name does not exactly match', async () => {
        const { id } = (await upload(bytes(10))).json();
        fs.writeFileSync(path.join(TMP_DIR, 'secret.txt'), 'secret');
        try {
            for (const wrong of ['A'.repeat(43), id.slice(1), id + 'A', id + '.del', id + '.part',
                '..%2Fsecret.txt', '..%2F..%2Ftempapi.test.db', '%2E%2E%2Fsecret.txt']) {
                const response = await download(wrong);
                assert.strictEqual(response.status, 404, wrong);
                assert.strictEqual(response.json().error, 'NotFound', wrong);
            }
            assert.strictEqual((await request(port, 'GET', '/temp/api/upload')).status, 404);
            assert.strictEqual((await request(port, 'POST', '/temp/api/download/' + id, { headers: as(alice) })).status, 404);
        } finally {
            fs.rmSync(path.join(TMP_DIR, 'secret.txt'), { force: true });
        }
    });

    it('takes uploads only with a signed session, and only from its own origin', async () => {
        const forged = { ...octets, cookie: `ssid=${alice.pub}.1.c2ln` };
        const none = await upload(bytes(10), octets);
        const fake = await upload(bytes(10), forged);
        const form = await upload(bytes(10), { ...as(alice), 'content-type': 'text/plain' });
        const multipart = await upload(bytes(10), { ...as(alice), 'content-type': 'multipart/form-data; boundary=x' });
        const elsewhere = await upload(bytes(10), { ...as(alice), origin: 'https://evil.example' });
        const here = await upload(bytes(10), { ...as(alice), origin: `http://127.0.0.1:${port}` });

        assert.deepStrictEqual([none, fake, form, multipart, elsewhere, here].map(r => r.status), [401, 401, 415, 415, 403, 200]);
        assert.strictEqual(none.json().error, 'Unauthorized', 'as JSON, not a redirect to Reg.html');
    });

    it('turns away a file over 50MB before reading it, and one with no size or no bytes', async () => {
        const tooBig = await new Promise((resolve, reject) => {
            const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/temp/api/upload',
                headers: { ...as(alice), 'content-length': String(MAX_FILE + 1) } }, res => {
                res.resume();
                res.on('end', () => resolve(res.statusCode));
            });
            req.on('error', reject);
            req.write(bytes(1000));
            // The rest never comes: the answer must not wait for it.
        });
        assert.strictEqual(tooBig, 413);

        const chunked = await upload(bytes(10), { ...as(alice), 'transfer-encoding': 'chunked' });
        const empty = await upload(undefined, { ...as(alice), 'content-length': '0' });
        assert.deepStrictEqual([chunked.status, empty.status], [411, 400]);
    });

    it('takes a file of exactly 50MB', async () => {
        const response = await upload(bytes(MAX_FILE));
        assert.strictEqual(response.status, 200);
        assert.strictEqual(fs.statSync(path.join(uploadDir, response.json().id)).size, MAX_FILE);
    });
});

// ---------------------------------------------------------------------------
// Making room: a small space, a clock the test turns
// ---------------------------------------------------------------------------

describe('TempApi - making room', () => {
    let api;
    let http0;
    let port;
    let clock;
    let dir;
    const upload = n => request(port, 'POST', '/temp/api/upload', { body: bytes(n), headers: as(alice) });
    const download = id => request(port, 'GET', '/temp/api/download/' + id);
    const held = () => fs.readdirSync(dir).sort();

    // A space of 1000 bytes, files of at most 300.
    const start = async (options = {}) => {
        api = new TempApi(dir, { render: new Render(), verifySsid: ssid => new Crypto().verifySsid(ssid),
            now: () => clock, log: () => {}, maxSpace: 1000, maxFile: 300, ...options });
        http0 = http.createServer((req, res) => {
            const cookie = /(?:^|;\s*)ssid=([^;]*)/.exec(req.headers.cookie || '');
            api.handle(req, res, cookie ? cookie[1] : '');
        });
        await new Promise(resolve => http0.listen(0, '127.0.0.1', resolve));
        port = http0.address().port;
    };
    const stop = async () => {
        http0.closeAllConnections();
        await new Promise(resolve => http0.close(resolve));
    };
    /** Uploads one file at the next tick of the clock, and answers its id. */
    const put = async n => {
        clock += 1000;
        const response = await upload(n);
        assert.strictEqual(response.status, 200, `upload of ${n}`);
        return response.json().id;
    };
    const take = async id => {
        assert.strictEqual((await download(id)).status, 200);
        await until(() => api.files.get(id).marked && fs.existsSync(path.join(dir, id + '.del')), 'marked');
    };

    beforeEach(async () => {
        if (http0) await stop();
        dir = path.join(TMP_DIR, 'temp-room');
        fs.rmSync(dir, { recursive: true, force: true });
        clock = Date.UTC(2026, 9, 1);
        await start();
    });

    after(async () => {
        await stop();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('keeps downloaded files while 30% or more is free, and purges them all once less is', async () => {
        const a = await put(200);
        const b = await put(200);
        await take(a);
        await take(b);
        const c = await put(200);
        const d = await put(100);
        assert.strictEqual(held().length, 4, '700 of 1000 held: 30% free, nothing purged');

        const e = await put(50);
        assert.deepStrictEqual(held(), [c, d, e].sort(), 'less than 30% free: the marked ones went');
        assert.strictEqual((await download(a)).status, 404);
    });

    it('purges marked files first when an upload would fill the space to 90%', async () => {
        const a = await put(300);
        const b = await put(300);
        await take(a);
        const c = await put(300);
        assert.deepStrictEqual(held(), [b, c].sort(), '600 + 300 is 90%: a, downloaded, made way');
    });

    it('marks a file nobody downloaded after a month, and keeps it until space is short', async () => {
        const a = await put(300);
        clock += EXPIRY;
        const b = await put(100);
        assert.deepStrictEqual(held(), [a + '.del', b].sort());
        assert.strictEqual((await download(a)).status, 200, 'still there to download');

        const c = await put(300);
        const d = await put(100);
        assert.deepStrictEqual(held(), [b, c, d].sort(), '800 held, less than 30% free: the month-old one went');
    });

    it('lets the oldest files nobody downloaded go, only as far as needed to keep 10% free', async () => {
        const a = await put(200);
        const b = await put(200);
        const c = await put(300);
        const d = await put(200);
        assert.strictEqual(held().length, 4, '900 held, none marked');

        const e = await put(300);
        assert.deepStrictEqual(held(), [c, d, e].sort(), 'a then b, the oldest, made way; c did not have to');
    });

    it('lets marked files go before any file nobody has downloaded', async () => {
        const a = await put(300);
        const b = await put(300);
        await take(b);
        const c = await put(200);
        const d = await put(300);
        assert.deepStrictEqual(held(), [a, c, d].sort());
    });

    it('says so when the space is full of uploads still on their way in', async () => {
        api.reserved = 900;
        const response = await upload(200);
        assert.strictEqual(response.status, 507);
        assert.strictEqual(response.json().error, 'InsufficientStorage');
        api.reserved = 0;
    });

    it('keeps no part of an upload that is cut short, and frees what it reserved', async () => {
        await new Promise(resolve => {
            const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/temp/api/upload',
                headers: { ...as(alice), 'content-length': '300' } });
            req.on('error', () => {});
            req.write(bytes(100), () => { setTimeout(() => { req.destroy(); resolve(); }, 50); });
        });
        await until(() => api.reserved === 0, 'reservation released');
        assert.deepStrictEqual(held(), []);
        assert.strictEqual(api.files.size, 0);
    });

    it('picks up what is held, and what is marked, after a restart; a leftover partial upload is dropped', async () => {
        const a = await put(100);
        const b = await put(100);
        await take(b);
        fs.writeFileSync(path.join(dir, 'x'.repeat(43) + '.part'), 'half');
        fs.writeFileSync(path.join(dir, 'notes.txt'), 'not ours');
        await stop();
        await start();

        assert.strictEqual((await download(a)).status, 200);
        assert.strictEqual((await download(b)).status, 200);
        assert.deepStrictEqual([...api.files.keys()].sort(), [a, b].sort());
        assert.strictEqual(api.files.get(b).marked, true);
        assert.ok(!fs.existsSync(path.join(dir, 'x'.repeat(43) + '.part')));
        assert.strictEqual(api.used(), 200, 'and a stranger in the folder counts for nothing');
    });
});
