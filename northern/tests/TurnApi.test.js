'use strict';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import nodeCrypto from 'node:crypto';
import { REPO_ROOT, tmpDbPaths, seedSchema } from './helpers/db.js';
import TurnApi, { DEFAULT_TTL, cleanIceServers, configFrom, coturnCredentials } from '../src/h2t/TurnApi.js';

const PUB = 'A+/' + 'B'.repeat(83) + '==';
const SECRET = 'a-shared-secret-of-some-length';
const COTURN = {
    NORTHERN_TURN: 'coturn', NORTHERN_TURN_SECRET: SECRET,
    NORTHERN_TURN_URLS: 'turn:turn.example.org:3478?transport=udp, turns:turn.example.org:5349?transport=tcp',
    NORTHERN_TURN_STUN: 'stun:turn.example.org:3478'
};
const CLOUDFLARE = { NORTHERN_TURN: 'cloudflare', NORTHERN_TURN_KEY_ID: 'key-id-1234', NORTHERN_TURN_KEY_TOKEN: 'token' };

/** What Render.renderJSON and the response do, kept. */
function response() {
    const res = { status: 0, headers: {}, body: null };
    return {
        res,
        render: { renderJSON: (data, r, status = 200) => { res.status = status; res.body = data; } },
        target: { setHeader: (k, v) => { res.headers[k] = v; } }
    };
}

function api(env, { fetch, now = () => 1_700_000_000_000 } = {}) {
    const out = response();
    const logged = [];
    const turn = new TurnApi({ render: out.render, env, fetch, now, log: (...a) => logged.push(a.join(' ')),
        verifySsid: ssid => ssid === 'good' ? { sValid: true, pubB64: PUB } : { sValid: false } });
    const ask = async (ssid = 'good', url = '/turn/api/ice', method = 'GET') => {
        await turn.handle({ url, method }, out.target, ssid);
        return out.res;
    };
    return { ask, logged };
}

describe('TurnApi - configuration', () => {
    it('reads coturn and Cloudflare from the environment, and nothing when nothing is set', () => {
        assert.strictEqual(configFrom({}), null);
        assert.deepStrictEqual(configFrom(COTURN), { kind: 'coturn', secret: SECRET, ttl: DEFAULT_TTL,
            urls: ['turn:turn.example.org:3478?transport=udp', 'turns:turn.example.org:5349?transport=tcp'],
            stun: ['stun:turn.example.org:3478'] });
        assert.deepStrictEqual(configFrom({ ...CLOUDFLARE, NORTHERN_TURN_TTL: '3600' }),
            { kind: 'cloudflare', keyId: 'key-id-1234', token: 'token', ttl: 3600 });
    });

    it('refuses a configuration that would not work', () => {
        assert.throws(() => configFrom({ NORTHERN_TURN: 'xirsys' }), /coturn or cloudflare/);
        assert.throws(() => configFrom({ ...COTURN, NORTHERN_TURN_SECRET: 'short' }), /static-auth-secret/);
        assert.throws(() => configFrom({ ...COTURN, NORTHERN_TURN_URLS: 'stun:x:1' }), /turn: or turns:/);
        assert.throws(() => configFrom({ ...COTURN, NORTHERN_TURN_STUN: 'turn:x:1' }), /stun: addresses/);
        assert.throws(() => configFrom({ ...CLOUDFLARE, NORTHERN_TURN_KEY_TOKEN: '' }), /API token/);
        assert.throws(() => configFrom({ ...CLOUDFLARE, NORTHERN_TURN_TTL: '10' }), /60 to a week/);
    });

    it('makes coturn\'s REST credentials: expiry:user, and HMAC-SHA1 of it in base64', () => {
        const made = coturnCredentials('north', 'alice', 1700000000);
        assert.strictEqual(made.username, '1700000000:alice');
        // The same, made the way coturn's documentation writes it down.
        const expected = nodeCrypto.createHmac('sha1', Buffer.from('north')).update(Buffer.from('1700000000:alice')).digest().toString('base64');
        assert.strictEqual(made.credential, expected);
    });

    it('hands on Cloudflare\'s servers without port 53, which browsers block', () => {
        assert.deepStrictEqual(cleanIceServers([
            { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
            { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp', 'http://x'],
              username: 'u', credential: 'c' },
            { urls: 'stun:only.example:53' },
            null
        ].filter(Boolean)), [
            { urls: ['stun:stun.cloudflare.com:3478'] },
            { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'u', credential: 'c' }
        ]);
    });
});

describe('TurnApi - /turn/api/ice', () => {
    it('is only for somebody signed in', async () => {
        const { ask } = api(COTURN);
        assert.deepStrictEqual(await ask(''), { status: 401, headers: {}, body: { error: 'Unauthorized', message: 'sign in to Northern first' } });
        assert.strictEqual((await ask('forged')).status, 401);
        assert.strictEqual((await ask('good', '/turn/api/other')).status, 404);
        assert.strictEqual((await ask('good', '/turn/api/ice', 'POST')).status, 404);
    });

    it('says so when the node gives no TURN credentials, or is set up wrong', async () => {
        assert.strictEqual((await api({}).ask()).status, 503);
        const wrong = api({ NORTHERN_TURN: 'coturn' });
        const res = await wrong.ask();
        assert.strictEqual(res.status, 503);
        assert.ok(!JSON.stringify(res.body).includes('SECRET'), 'what is wrong goes to the log, not the browser');
        assert.match(wrong.logged[0], /NORTHERN_TURN_URLS/);
    });

    it('answers coturn credentials that expire, made for the head of the caller\'s key', async () => {
        const res = await api(COTURN).ask();
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.headers['Cache-Control'], 'no-store');
        const [stun, turn] = res.body.iceServers;
        assert.deepStrictEqual(stun, { urls: ['stun:turn.example.org:3478'] });
        assert.strictEqual(turn.username, `${1_700_000_000 + DEFAULT_TTL}:A-_BBBBBBBBB`);
        assert.strictEqual(turn.credential, coturnCredentials(SECRET, 'A-_BBBBBBBBB', 1_700_000_000 + DEFAULT_TTL).credential);
        assert.deepStrictEqual([res.body.ttl, res.body.provider], [DEFAULT_TTL, 'coturn']);
        assert.ok(!JSON.stringify(res.body).includes(SECRET));
    });

    it('asks Cloudflare with the key\'s token, and hands on what it answers', async () => {
        const asked = [];
        const fetch = async (url, options) => {
            asked.push({ url, ...options });
            return { status: 201, json: async () => ({ iceServers: [
                { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
                { urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'cf-user', credential: 'cf-pass' }
            ] }) };
        };
        const res = await api(CLOUDFLARE, { fetch }).ask();
        assert.strictEqual(asked[0].url, 'https://rtc.live.cloudflare.com/v1/turn/keys/key-id-1234/credentials/generate-ice-servers');
        assert.strictEqual(asked[0].method, 'POST');
        assert.strictEqual(asked[0].headers.Authorization, 'Bearer token');
        assert.deepStrictEqual(JSON.parse(asked[0].body), { ttl: DEFAULT_TTL });
        assert.deepStrictEqual(res.body, { provider: 'cloudflare', ttl: DEFAULT_TTL, iceServers: [
            { urls: ['stun:stun.cloudflare.com:3478'] },
            { urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'cf-user', credential: 'cf-pass' }
        ] });
        assert.ok(!JSON.stringify(res.body).includes('token'));
    });

    it('reports Cloudflare out of reach, refusing, or giving nothing, as 502', async () => {
        const answers = [
            async () => { throw new Error('ECONNREFUSED'); },
            async () => ({ status: 401, json: async () => ({}) }),
            async () => ({ status: 201, json: async () => ({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }] }) }),
            async () => ({ status: 201, json: async () => { throw new SyntaxError('not JSON'); } })
        ];
        for (const fetch of answers) {
            const res = await api(CLOUDFLARE, { fetch }).ask();
            assert.strictEqual(res.status, 502);
            assert.strictEqual(res.body.error, 'TurnFailed');
        }
    });
});

// ---------------------------------------------------------------------------
// Through the server: the route, and the inperson host name
// ---------------------------------------------------------------------------

async function freePort() {
    const probe = net.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address();
    await new Promise(resolve => probe.close(resolve));
    return port;
}

function request(port, method, path, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method, path, headers }, res => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { text += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
        });
        req.on('error', reject);
        req.end();
    });
}

describe('Server - /turn/api/ and the inperson host name', () => {
    let server;
    let port;
    let file;
    const at = (host, path) => request(port, 'GET', path, { host });

    before(async () => {
        process.chdir(REPO_ROOT);
        const { default: Server } = await import('../src/h2t/Server.js');
        const paths = tmpDbPaths('turnapi.test.db');
        file = paths.absolute;
        await seedSchema(paths.absolute);
        port = await freePort();
        server = new Server(port, paths.relativeToSrcH2t, await freePort());
        await new Promise(resolve => server.httpServer.once('listening', resolve));
    });

    after(async () => {
        server.httpServer.closeAllConnections();
        server.sslServer.closeAllConnections();
        await new Promise(resolve => server.httpServer.close(resolve));
        await new Promise(resolve => server.sslServer.close(resolve));
        fs.rmSync(file, { force: true });
    });

    it('mounts the TURN API, which wants a session before anything else', async () => {
        const res = await request(port, 'GET', '/turn/api/ice');
        assert.strictEqual(res.status, 401);
        assert.strictEqual(JSON.parse(res.text).error, 'Unauthorized');
    });

    it('opens on InPerson, and runs only InPerson and the sign-in pages as themselves', async () => {
        assert.strictEqual((await at('inperson.example', '/')).headers.location, '/fs/get/pwa/inPerson/index.html');
        for (const path of ['/fs/get/pwa/inPerson/index.html', '/fs/get/pwa/inPerson/welcome.html', '/fs/get/pwa/inPerson/sw.js', '/fs/get/reg/Reg.html']) {
            const res = await at('inperson.example', path);
            assert.strictEqual(res.status, 200, path);
            assert.strictEqual(res.headers['content-security-policy'], undefined, path);
            assert.strictEqual(res.headers['x-content-type-options'], 'nosniff', path);
        }
        for (const path of ['/fs/get/home.html', '/fs/get/pwa/pals/index.html', '/fs/get/pwa/inPerson/example/coturn/turnserver.conf',
            '/fs/get/pwa/inPerson/../pals/index.html', '/inperson/mallory/page']) {
            assert.strictEqual((await at('inperson.example', path)).headers['content-security-policy'], 'sandbox', path);
        }
    });

    it('keeps the pals host as it was: InPerson does not run there', async () => {
        assert.strictEqual((await at('pals.example', '/')).headers.location, '/fs/get/pwa/pals/index.html');
        assert.strictEqual((await at('pals.example', '/fs/get/pwa/pals/index.html')).headers['content-security-policy'], undefined);
        assert.strictEqual((await at('pals.example', '/fs/get/pwa/inPerson/index.html')).headers['content-security-policy'], 'sandbox');
        assert.strictEqual((await at('eastblue.example', '/fs/get/pwa/inPerson/index.html')).headers['content-security-policy'], undefined);
    });
});
