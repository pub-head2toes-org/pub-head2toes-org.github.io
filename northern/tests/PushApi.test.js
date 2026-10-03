'use strict';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import nodeCrypto from 'node:crypto';
import { REPO_ROOT, tmpDbPaths, seedSchema } from './helpers/db.js';
import { loadPals, agreementKey, plain } from './helpers/palsPage.js';
import sjclClass from '../src/h2t/sjclClass.js';
import PushApi, { AUTHOR, CONFIG_PATH, MAX_PAYLOAD, PROOF_WINDOW, encryptPush, generateKeys, providerOf,
    readKeys, vapidHeader } from '../src/h2t/PushApi.js';

const sjcl = new sjclClass().get();
const { Model, Seal } = loadPals();
const subtle = globalThis.crypto.subtle;
const b64u = bytes => Buffer.from(bytes).toString('base64url');

/** A Northern identity exactly as reg/session.js drafts one, with a live cookie. */
function identity(name) {
    const keys = sjcl.ecc.ecdsa.generateKeys(256, 0);
    const pub = sjcl.codec.base64.fromBits(keys.pub.get().x.concat(keys.pub.get().y));
    const priv = sjcl.codec.base64.fromBits(keys.sec.get());
    const signed = `${pub}.${Date.now()}`;
    const ssid = `${signed}.${sjcl.codec.base64.fromBits(keys.sec.sign(sjcl.hash.sha256.hash(signed), 0))}`;
    return { name, pub, priv, ssid };
}
const alice = identity('alice');
const bob = identity('bob');
const carol = identity('carol');

/** What a browser holds for a push subscription: the key pair and secret behind p256dh and auth. */
async function device() {
    const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const p256dh = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
    const auth = globalThis.crypto.getRandomValues(new Uint8Array(16));
    return {
        privateKey: pair.privateKey, p256dh, auth,
        subscription: endpoint => ({ endpoint, expirationTime: null, keys: { p256dh: b64u(p256dh), auth: b64u(auth) } })
    };
}

// RFC 8291, the browser's half: how a user agent opens a push, in WebCrypto.
// Written apart from PushApi.encryptPush, so one checks the other.
const utf8 = text => new TextEncoder().encode(text);
const join = (...parts) => Buffer.concat(parts.map(p => Buffer.from(p)));
async function hkdf(salt, ikm, info, length) {
    const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}
async function openPush(body, privateKey, receiver, auth) {
    const salt = body.subarray(0, 16);
    const sender = body.subarray(21, 21 + body[20]);
    const from = await subtle.importKey('raw', sender, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const secret = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: from }, privateKey, 256));
    const ikm = await hkdf(auth, secret, join(utf8('WebPush: info\0'), receiver, sender), 32);
    const key = await subtle.importKey('raw', await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16), 'AES-GCM', false, ['decrypt']);
    const iv = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);
    const padded = Buffer.from(await subtle.decrypt({ name: 'AES-GCM', iv }, key, body.subarray(21 + body[20])));
    return padded.subarray(0, padded.lastIndexOf(2));
}

const keys = readKeys(JSON.stringify(generateKeys()));

describe('PushApi - the crypto', () => {
    it('encrypts a push exactly as RFC 8291 Appendix A does', () => {
        const body = encryptPush(Buffer.from('When I grow up, I want to be a watermelon'), {
            p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
            auth: 'BTBZMqHH6r4Tts7J_aSIgg'
        }, { ephemeral: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url') });

        assert.strictEqual(b64u(body), 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
    });

    it('encrypts a push the browser\'s side opens, and a full one fits in 4096 bytes', async () => {
        const phone = await device();
        const plaintext = Buffer.alloc(MAX_PAYLOAD, 'x');
        const body = encryptPush(plaintext, phone.subscription('https://fcm.googleapis.com/fcm/send/x').keys);

        assert.strictEqual(body.length, 4096);
        assert.deepStrictEqual(await openPush(body, phone.privateKey, phone.p256dh, phone.auth), plaintext);
    });

    it('signs a VAPID token for the push service\'s origin, with its own public key', () => {
        const header = vapidHeader('https://fcm.googleapis.com/fcm/send/abc', keys, 'https://pals.example', 1000);
        const [, token, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header);
        const [head, claims, signature] = token.split('.');
        const point = Buffer.from(k, 'base64url');
        const verifier = nodeCrypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: b64u(point.subarray(1, 33)), y: b64u(point.subarray(33)) } });

        assert.strictEqual(k, keys.publicKey);
        assert.deepStrictEqual(JSON.parse(Buffer.from(claims, 'base64url')), { aud: 'https://fcm.googleapis.com', exp: 1000 + 12 * 3600, sub: 'https://pals.example' });
        assert.strictEqual(nodeCrypto.verify('sha256', Buffer.from(`${head}.${claims}`), { key: verifier, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')), true);
    });

    it('takes a config only when its two keys are a pair', () => {
        const other = generateKeys();
        assert.throws(() => readKeys(JSON.stringify({ ...generateKeys(), privateKey: other.privateKey })), /not the public half/);
        assert.throws(() => readKeys('{"publicKey":"AAAA","privateKey":"AAAA"}'), /65-byte/);
        assert.throws(() => readKeys('not json'));
    });

    it('knows the push services by host name, and nothing that only looks like one', () => {
        const known = {
            'https://fcm.googleapis.com/fcm/send/abc': 'google',
            'https://updates.push.services.mozilla.com/wpush/v2/abc': 'mozilla',
            'https://web.push.apple.com/QGx': 'apple',
            'https://wns2-by3p.notify.windows.com/w/?token=x': 'microsoft'
        };
        const unknown = ['http://fcm.googleapis.com/fcm/send/abc', 'https://fcm.googleapis.com.evil.example/x',
            'https://evilfcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'https://user@fcm.googleapis.com/x',
            'https://127.0.0.1/x', 'https://localhost/x', 'not a url', ''];

        for (const [endpoint, provider] of Object.entries(known)) {
            assert.strictEqual(providerOf(endpoint), provider, endpoint);
            assert.strictEqual(Model.providerOf(endpoint), provider, 'and the page agrees: ' + endpoint);
        }
        for (const endpoint of unknown) {
            assert.strictEqual(providerOf(endpoint), '', endpoint);
            assert.strictEqual(Model.providerOf(endpoint), '', 'and the page agrees: ' + endpoint);
        }
    });
});

// ---------------------------------------------------------------------------
// Through Server.js, on a throwaway database
// ---------------------------------------------------------------------------

async function freePort() {
    const probe = net.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address();
    await new Promise(resolve => probe.close(resolve));
    return port;
}

async function startServer(name) {
    process.chdir(REPO_ROOT);
    const { default: Server } = await import('../src/h2t/Server.js');
    const paths = tmpDbPaths(name);
    await seedSchema(paths.absolute);
    const port = await freePort();
    const server = new Server(port, paths.relativeToSrcH2t, await freePort());
    await new Promise(resolve => server.httpServer.once('listening', resolve));
    server.push.log = () => {};
    return {
        server, port, file: paths.absolute,
        async stop() {
            server.httpServer.closeAllConnections();
            server.sslServer.closeAllConnections();
            await new Promise(resolve => server.httpServer.close(resolve));
            await new Promise(resolve => server.sslServer.close(resolve));
            fs.rmSync(paths.absolute, { force: true });
        }
    };
}

/** A request with full control of the headers - Host included, which fetch will not set. */
function request(port, method, path, { body, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method, path, headers }, res => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { text += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text,
                json: () => JSON.parse(text) }));
        });
        req.on('error', reject);
        if (body !== undefined) req.write(body);
        req.end();
    });
}

describe('PushApi - through the server', () => {
    let node;
    let pushed;
    let answer;
    const json = { 'content-type': 'application/json' };
    const as = who => ({ ...json, cookie: `ssid=${who.ssid}` });
    // A part as the page sends it: sealed in the browser, opaque here.
    const wire = { sealed: 'A'.repeat(100), id: 'w1', part: 1, parts: 1 };
    const call = (method, path, body, headers = json) =>
        request(node.port, method, path, { body: body === undefined ? undefined : JSON.stringify(body), headers });

    before(async () => {
        node = await startServer('pushapi.test.db');
        // The push services, as the server reaches them.
        pushed = [];
        answer = () => ({ status: 201 });
        node.server.push.fetch = async (url, options) => {
            pushed.push({ url, ...options });
            return answer(url, options);
        };
    });

    after(() => node.stop());

    it('makes the VAPID keys on first use, files them out of everybody\'s reach, and keeps them', async () => {
        const first = await call('GET', '/push/api/config/pub');
        const second = await call('GET', '/push/api/config/pub');
        const { publicKey } = first.json();

        assert.strictEqual(first.status, 200);
        assert.strictEqual(Buffer.from(publicKey, 'base64url').length, 65);
        assert.strictEqual(second.json().publicKey, publicKey);

        const row = await node.server.db.getConfig(CONFIG_PATH);
        assert.strictEqual(row.author, AUTHOR);
        assert.notStrictEqual(row.public, 'public');
        assert.strictEqual(readKeys(row.value).publicKey, publicKey);
    });

    it('never hands the config row to a request, however it asks', async () => {
        await call('GET', '/push/api/config/pub');
        const row = await node.server.db.getConfig(CONFIG_PATH);
        const attempts = [
            ['/push/api/config', {}],
            ['/push/api/config', as(alice)],
            ['/push?searchPlus=/api/%25', {}],
            ['/push?searchPlus=/api/%25', as(alice)],
            [`/push?searchPlus=/api/%25&isGroup=${encodeURIComponent(AUTHOR)}`, {}],
            ['/push?searchPlus=/api/%25&isGroup=public', {}],
            ['/push/?keyword=%25privateKey%25', as(alice)]
        ];
        for (const [path, headers] of attempts) {
            const response = await request(node.port, 'GET', path, { headers });
            assert.ok(!response.text.includes(readKeys(row.value).privateKey), path);
        }
        const overwrite = await request(node.port, 'PUT', CONFIG_PATH, { body: '{}', headers: as(alice) });
        assert.notStrictEqual(overwrite.status, 200, 'nor lets one overwrite it');
        assert.strictEqual((await node.server.db.getConfig(CONFIG_PATH)).value, row.value);
    });

    it('refuses to send for anybody without a signed session, and says so as JSON', async () => {
        const phone = await device();
        const body = { to: bob.pub, subscription: phone.subscription('https://fcm.googleapis.com/fcm/send/b'), ...wire };

        const none = await call('POST', '/push/api/send', body);
        const forged = await call('POST', '/push/api/send', body, { ...json, cookie: `ssid=${alice.pub}.1.c2ln` });
        assert.deepStrictEqual([none.status, forged.status], [401, 401]);
        assert.strictEqual(none.json().error, 'Unauthorized');
        assert.strictEqual(pushed.length, 0);
    });

    it('takes only JSON, and only from its own origin - a form on another site cannot send as the visitor', async () => {
        const phone = await device();
        const body = JSON.stringify({ to: bob.pub, subscription: phone.subscription('https://fcm.googleapis.com/fcm/send/b'), ...wire });
        const cookie = `ssid=${alice.ssid}`;

        const form = await request(node.port, 'POST', '/push/api/send', { body, headers: { cookie, 'content-type': 'text/plain' } });
        const elsewhere = await request(node.port, 'POST', '/push/api/send', { body, headers: { ...as(alice), origin: 'https://evil.example' } });
        const here = await request(node.port, 'POST', '/push/api/send', { body, headers: { ...as(alice), origin: `http://127.0.0.1:${node.port}` } });

        assert.deepStrictEqual([form.status, elsewhere.status, here.status], [415, 403, 200]);
    });

    it('pushes only to a known push service, as the endpoint names it', async () => {
        const phone = await device();
        const send = endpoint => call('POST', '/push/api/send',
            { to: bob.pub, subscription: phone.subscription(endpoint), ...wire }, as(alice));
        const before = pushed.length;

        assert.strictEqual((await send('https://127.0.0.1:9443/admin')).status, 400);
        assert.strictEqual((await send('https://fcm.googleapis.com.evil.example/x')).status, 400);
        const mismatch = await call('POST', '/push/api/send',
            { to: bob.pub, subscription: phone.subscription('https://fcm.googleapis.com/fcm/send/b'), provider: 'apple', ...wire }, as(alice));
        assert.strictEqual(mismatch.status, 400);
        assert.match(mismatch.json().message, /google, not apple/);
        assert.strictEqual(pushed.length, before, 'and none of those went out');
    });

    it('holds a payload to what one push can carry, and a part the page makes always fits', async () => {
        const phone = await device();
        const send = (sealed, extra = {}) => call('POST', '/push/api/send',
            { to: bob.pub, subscription: phone.subscription('https://fcm.googleapis.com/fcm/send/b'), ...wire, sealed, ...extra }, as(alice));

        assert.strictEqual((await send('A'.repeat(3751))).status, 200, 'all a push holds');
        assert.strictEqual((await send('A'.repeat(3752))).status, 413, 'one more than a push holds');
        assert.strictEqual((await send('A'.repeat(3801))).status, 400, 'more than any seal');
        assert.strictEqual((await send('not base64url!'.repeat(10))).status, 400);
        assert.strictEqual((await send('A'.repeat(100), { id: 'no spaces' })).status, 400);
        assert.strictEqual((await send('A'.repeat(100), { part: 3, parts: 2 })).status, 400);

        // The worst case the page can make: parts of 2600 bytes, the longest id, 100 parts.
        const key = await agreementKey(alice);
        const parts = plain(Model.split('🍉'.repeat(2000)));
        for (const [i, text] of parts.entries()) {
            const w = { id: 'x'.repeat(40), part: i + 1, parts: 100 };
            const sealed = await Seal.seal(key, alice.pub, bob.pub, w, { ts: Date.now(), body: text });
            assert.strictEqual((await send(sealed, w)).status, 200, 'part ' + (i + 1));
        }
        assert.strictEqual((await request(node.port, 'POST', '/push/api/send', { body: 'x'.repeat(20000), headers: as(alice) })).status, 413);
    });

    it('relays a message sealed in the browser: the server cannot read it, and the sender is who the cookie says', async () => {
        const phone = await device();
        const { publicKey } = (await call('GET', '/push/api/config/pub')).json();
        const [aliceKey, bobKey, carolKey] = await Promise.all([alice, bob, carol].map(agreementKey));
        const w = { id: 'abc123', part: 1, parts: 2 };
        const sealed = await Seal.seal(aliceKey, alice.pub, bob.pub, w, { ts: 42, body: '[Family] dinner at 8' });
        pushed.length = 0;

        const sent = await call('POST', '/push/api/send', {
            to: bob.pub, from: carol.pub, provider: 'google', subscription: phone.subscription('https://fcm.googleapis.com/fcm/send/bob-phone'),
            sealed, ...w
        }, as(alice));
        assert.strictEqual(sent.status, 200);
        assert.deepStrictEqual({ ...sent.json(), ts: 0 }, { status: 'OK', id: 'abc123', part: 1, parts: 2, ts: 0, provider: 'google' });

        // What reached the push service: an aes128gcm body for bob's phone, signed for by the server's key.
        const [push] = pushed;
        assert.strictEqual(push.url, 'https://fcm.googleapis.com/fcm/send/bob-phone');
        assert.strictEqual(push.headers['Content-Encoding'], 'aes128gcm');
        assert.ok(push.headers.Authorization.endsWith(`, k=${publicKey}`));
        assert.ok(Number(push.headers.TTL) > 0);

        // What bob's service worker gets. Chrome hands a payload to the worker
        // as UTF-8 text and nulls one that is not, so it must be text.
        const text = new TextDecoder('utf-8', { fatal: true }).decode(await openPush(push.body, phone.privateKey, phone.p256dh, phone.auth));
        const outer = JSON.parse(text);
        assert.deepStrictEqual({ ...outer, sealed: '' }, { v: 2, from: alice.pub, to: bob.pub, id: 'abc123', part: 1, parts: 2, sealed: '' },
            'from is the cookie\'s key, not the "from" the client claimed');
        assert.strictEqual(outer.sealed, sealed, 'and the seal went through untouched');
        assert.ok(!Buffer.from(sealed, 'base64url').toString('latin1').includes('dinner'));

        const opened = plain(await Seal.open(bobKey, outer));
        assert.deepStrictEqual(opened, { v: 2, from: alice.pub, to: bob.pub, id: 'abc123', part: 1, parts: 2, ts: 42, body: '[Family] dinner at 8' });

        await assert.rejects(Seal.open(carolKey, { ...outer, to: carol.pub }), 'carol cannot open it');
        await assert.rejects(Seal.open(aliceKey, outer), 'nor can its sender, as if it were for her');
        await assert.rejects(Seal.open(bobKey, { ...outer, from: carol.pub }), 'a server that names another sender gets nothing that opens');
        await assert.rejects(Seal.open(aliceKey, { ...outer, from: bob.pub, to: alice.pub }), 'nor can it bounce the message back to alice as bob\'s');
        await assert.rejects(Seal.open(bobKey, { ...outer, part: 2 }), 'nor move it to another part');
        await assert.rejects(Seal.open(bobKey, { ...outer, id: 'other' }), 'or another message');
    });

    // A send as the page makes it once the cookie has expired: proven with the
    // key reg/keystore.js keeps, against the server's VAPID key (UPDATE_3).
    const proven = async (who, body, at = Date.now()) => {
        const { publicKey } = (await call('GET', '/push/api/config/pub')).json();
        return { ...body, ...plain(await Seal.prove(await agreementKey(who), who.pub, publicKey, body, at)) };
    };

    it('sends with no cookie on a proof made in the browser with the kept key, as the key that made it', async () => {
        const phone = await device();
        const w = { id: 'p1', part: 1, parts: 1 };
        const sealed = await Seal.seal(await agreementKey(alice), alice.pub, bob.pub, w, { ts: 7, body: 'after midnight' });
        const body = await proven(alice, { to: bob.pub, subscription: phone.subscription('https://fcm.googleapis.com/fcm/send/bob-phone'), sealed, ...w });
        pushed.length = 0;

        const response = await call('POST', '/push/api/send', body);
        assert.strictEqual(response.status, 200);
        const outer = JSON.parse((await openPush(pushed[0].body, phone.privateKey, phone.p256dh, phone.auth)).toString('utf8'));
        assert.strictEqual(outer.from, alice.pub);
        assert.strictEqual(plain(await Seal.open(await agreementKey(bob), outer)).body, 'after midnight');

        const withCookie = await call('POST', '/push/api/send', body, as(carol));
        assert.strictEqual(withCookie.status, 200);
        assert.strictEqual(JSON.parse((await openPush(pushed[1].body, phone.privateKey, phone.p256dh, phone.auth)).toString('utf8')).from, alice.pub,
            'a proof names the sender, whoever\'s cookie comes with it');
    });

    it('refuses a proof made with another key, for another push, or at another time - and a live cookie does not rescue it', async () => {
        const phone = await device();
        const body = { to: bob.pub, subscription: phone.subscription('https://fcm.googleapis.com/fcm/send/b'), ...wire };
        const good = await proven(alice, body);
        const before = pushed.length;
        const attempts = {
            'carol\'s proof, claiming alice': { ...(await proven(carol, body)), from: alice.pub },
            'another receiver': { ...good, to: carol.pub },
            'another device': { ...good, subscription: phone.subscription('https://fcm.googleapis.com/fcm/send/c') },
            'another seal': { ...good, sealed: 'B'.repeat(100) },
            'another part': { ...good, part: 1, parts: 2 },
            'another time': { ...good, at: good.at + 1 },
            'too old': await proven(alice, body, Date.now() - PROOF_WINDOW - 60000),
            'from the future': await proven(alice, body, Date.now() + PROOF_WINDOW + 60000),
            'no proof in it': { ...good, proof: '' },
            'a from that is no point': { ...good, from: 'A'.repeat(86) + '==' }
        };
        for (const [what, attempt] of Object.entries(attempts)) {
            const response = await call('POST', '/push/api/send', attempt, as(alice));
            assert.strictEqual(response.status, 401, what);
            assert.strictEqual(response.json().error, 'Unauthorized', what);
        }
        assert.strictEqual(pushed.length, before, 'and none of those went out');
    });

    it('has no way left to open a message on the server', async () => {
        const response = await call('POST', '/push/api/open', { sealed: 'A'.repeat(100) }, as(bob));
        assert.strictEqual(response.status, 404);
    });

    it('says what the push service said: gone, slow down, or failed', async () => {
        const phone = await device();
        const send = () => call('POST', '/push/api/send',
            { to: bob.pub, subscription: phone.subscription('https://fcm.googleapis.com/fcm/send/b'), ...wire }, as(alice));
        try {
            answer = () => ({ status: 410 });
            assert.strictEqual((await send()).status, 410);
            answer = () => ({ status: 429 });
            assert.strictEqual((await send()).status, 429);
            answer = () => ({ status: 500 });
            assert.strictEqual((await send()).status, 502);
            answer = () => { throw new Error('ENOTFOUND'); };
            assert.strictEqual((await send()).status, 502);
        } finally {
            answer = () => ({ status: 201 });
        }
    });

    it('cannot be had by downloading the database file, however the path is spelled', async () => {
        await call('GET', '/push/api/config/pub');
        const { privateKey } = readKeys((await node.server.db.getConfig(CONFIG_PATH)).value);
        const db = '/fs/get/../../tests/.tmp/pushapi.test.db';
        for (const path of [db, db.replace('/fs/get/', '/static/'), '/mp4/get/../northern/tests/.tmp/pushapi.test.db']) {
            const response = await request(node.port, 'GET', path);
            assert.strictEqual(response.status, 404, path);
            assert.deepStrictEqual(response.json(), { error: 'no such file' }, path);
            assert.ok(!response.text.includes(privateKey));
        }
    });

    it('answers 404 for a route it does not have, and keeps it from the database', async () => {
        assert.strictEqual((await call('GET', '/push/api/nothing')).status, 404);
        assert.strictEqual((await call('POST', '/push/api/config', {}, as(alice))).status, 404);
    });
});

describe('PushApi - a config row somebody else wrote', () => {
    let node;
    before(async () => {
        node = await startServer('pushapi-squat.test.db');
        await new Promise(resolve => node.server.db.insert(CONFIG_PATH, 'json', JSON.stringify(generateKeys()), alice.pub, alice.pub, resolve));
    });
    after(() => node.stop());

    it('is not used: keys whose private half a user knows would let them push as the server', async () => {
        const response = await request(node.port, 'GET', '/push/api/config/pub');
        assert.strictEqual(response.status, 503);
        assert.strictEqual(response.json().error, 'NotConfigured');
    });
});

describe('Server - the pals host name', () => {
    let node;
    const at = (host, path) => request(node.port, 'GET', path, { headers: { host } });

    before(async () => {
        node = await startServer('palshost.test.db');
        await request(node.port, 'POST', '/pals/mallory/page?isPublic=true', {
            body: '<script>indexedDB.deleteDatabase("pals")</script>', headers: { cookie: `ssid=${carol.ssid}` }
        });
    });
    after(() => node.stop());

    it('serves a database row sandboxed, so a page anybody wrote runs no script as Pals', async () => {
        const row = await at('pals.example', '/pals/mallory/page');

        assert.strictEqual(row.headers['content-type'], 'text/html');
        assert.strictEqual(row.headers['content-security-policy'], 'sandbox');
        assert.strictEqual(row.headers['x-content-type-options'], 'nosniff');
    });

    it('serves Pals itself and the sign-in pages as they are', async () => {
        for (const path of ['/fs/get/pwa/pals/index.html', '/fs/get/pwa/pals/welcome.html', '/fs/get/pwa/pals/sw.js', '/fs/get/reg/Reg.html']) {
            const response = await at('pals.example', path);
            assert.strictEqual(response.status, 200, path);
            assert.strictEqual(response.headers['content-security-policy'], undefined, path);
        }
    });

    it('sandboxes every other page, the other apps and Pals\' examples included, however the path is spelled', async () => {
        for (const path of ['/fs/get/home.html', '/fs/get/pwa/pals/example/OpenChannel/index.html', '/fs/get/pwa/pals/../bandage/index.html']) {
            assert.strictEqual((await at('pals.example', path)).headers['content-security-policy'], 'sandbox', path);
        }
    });

    it('opens on Pals, and leaves every other host name as it was', async () => {
        assert.strictEqual((await at('pals.example', '/')).headers.location, '/fs/get/pwa/pals/index.html');
        assert.strictEqual((await at('eastblue.example', '/')).headers.location, '/fs/get/home.html');
        const row = await at('eastblue.example', '/pals/mallory/page');
        assert.strictEqual(row.headers['content-security-policy'], undefined);
    });
});
