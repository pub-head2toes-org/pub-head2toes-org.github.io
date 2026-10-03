'use strict';

import crypto from 'node:crypto';

export const CONFIG_PATH = '/push/api/config';
// The author of the config row. A verified cookie makes the author a public
// key, and no cookie makes it 'public', so no request can ever write, update
// or read a row under this name.
export const AUTHOR = 'northern:push';
// The largest plaintext one push carries: a 4096-byte aes128gcm body less its
// 86-byte header, the padding delimiter and the 16-byte tag (RFC 8291 §4).
// The payload is JSON text (see send).
export const MAX_PAYLOAD = 3993;
// A request body is a message and a subscription; nothing honest comes close.
export const MAX_BODY = 16384;
// How long a push service keeps a message for a device that is away.
export const TTL = 4 * 7 * 24 * 3600;
// The payload version: 2 is sealed in the browsers (UPDATE_2).
const VERSION = 2;
// How far a send proof's clock may be from the server's (UPDATE_3).
export const PROOF_WINDOW = 5 * 60 * 1000;
const PROOF = /^[A-Za-z0-9_-]{43}$/;

/**
 * Who may be asked to deliver a push. The relay POSTs to an address a client
 * gives it, so without this list it would be an open proxy into anywhere the
 * server can reach.
 */
export const PROVIDERS = {
    google: [/^fcm\.googleapis\.com$/],
    mozilla: [/^updates\.push\.services\.mozilla\.com$/, /^[a-z0-9-]+\.push\.services\.mozilla\.com$/],
    apple: [/^web\.push\.apple\.com$/, /^[a-z0-9-]+\.push\.apple\.com$/],
    microsoft: [/^[a-z0-9-]+\.notify\.windows\.com$/]
};

// A Northern public key: 64 bytes, x then y, in standard base64.
const PUB = /^[A-Za-z0-9+/]{86}==$/;
const ID = /^[A-Za-z0-9_-]{1,40}$/;
const SEALED = /^[A-Za-z0-9_-]{60,3800}$/;

export class PushError extends Error {
    constructor(status, code, message){
        super(message);
        this.status = status;
        this.code = code;
    }
}
const fail = (status, code, message) => { throw new PushError(status, code, message); };

const b64u = buffer => Buffer.from(buffer).toString('base64url');
const fromB64u = text => Buffer.from(String(text || ''), 'base64url');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/** The provider an endpoint belongs to, or '' when it is nobody's on the list. */
export function providerOf (endpoint, providers = PROVIDERS){
    let url;
    try {
        url = new URL(endpoint);
    } catch (e) {
        return '';
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.port){
        return '';
    }
    for (const [id, hosts] of Object.entries(providers)){
        if (hosts.some(host => host.test(url.hostname))){
            return id;
        }
    }
    return '';
}

/**
 * A new VAPID key pair, as the config row keeps it: the public key as the
 * 65-byte point a browser takes for `applicationServerKey`, the private key as
 * its 32 bytes - both base64url.
 */
export function generateKeys (){
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = privateKey.export({ format: 'jwk' });
    return {
        publicKey: b64u(Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)])),
        privateKey: jwk.d
    };
}

/** The keys out of a config row's value, checked; throws what is wrong. */
export function readKeys (value){
    const config = JSON.parse(value);
    const pub = fromB64u(config.publicKey);
    const d = fromB64u(config.privateKey);
    if (pub.length !== 65 || pub[0] !== 4 || d.length !== 32){
        throw new Error('publicKey must be a 65-byte P-256 point and privateKey 32 bytes, base64url');
    }
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.setPrivateKey(d);
    if (!ecdh.getPublicKey().equals(pub)){
        throw new Error('publicKey is not the public half of privateKey');
    }
    return { publicKey: config.publicKey, privateKey: config.privateKey, subject: config.subject || '' };
}

/**
 * RFC 8291: a push message body encrypted to a browser's subscription, in the
 * aes128gcm content coding of RFC 8188 - one record, no padding.
 * `ephemeral` and `salt` are for the RFC's test vector; leave them out.
 */
export function encryptPush (plaintext, subscriptionKeys, { ephemeral, salt = crypto.randomBytes(16) } = {}){
    const uaPublic = fromB64u(subscriptionKeys.p256dh);
    const auth = fromB64u(subscriptionKeys.auth);
    if (uaPublic.length !== 65 || uaPublic[0] !== 4 || auth.length !== 16){
        fail(400, 'BadRequest', 'the subscription keys are not a P-256 point and a 16-byte secret');
    }
    const ecdh = crypto.createECDH('prime256v1');
    if (ephemeral){
        ecdh.setPrivateKey(fromB64u(ephemeral));
    } else {
        ecdh.generateKeys();
    }
    const asPublic = ecdh.getPublicKey();
    let secret;
    try {
        secret = ecdh.computeSecret(uaPublic);
    } catch (e) {
        fail(400, 'BadRequest', 'the subscription key is not a point on P-256');
    }

    const ikm = hmac(hmac(auth, secret), Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
    const prk = hmac(salt, ikm);
    const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
    const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);

    const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
    const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
    const header = Buffer.alloc(21);
    salt.copy(header, 0);
    header.writeUInt32BE(4096, 16);
    header[20] = asPublic.length;
    return Buffer.concat([header, asPublic, body]);
}

/** The `Authorization` header a push service wants from an application server (RFC 8292). */
export function vapidHeader (endpoint, keys, subject, nowSeconds){
    const pub = fromB64u(keys.publicKey);
    const key = crypto.createPrivateKey({ format: 'jwk', key: {
        kty: 'EC', crv: 'P-256', d: keys.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33))
    } });
    const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const claims = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: nowSeconds + 12 * 3600, sub: subject }));
    const signature = crypto.sign('sha256', Buffer.from(head + '.' + claims), { key, dsaEncoding: 'ieee-p1363' });
    return `vapid t=${head}.${claims}.${b64u(signature)}, k=${keys.publicKey}`;
}

/**
 * What a send proof must be for this request (UPDATE_3): HMAC-SHA256 over
 * every field that decides what is pushed where, with a key made by HKDF from
 * ECDH(VAPID private key, `from`). seal.js makes the same in the browser,
 * from the other end of the agreement. Throws when `from` is not a point.
 */
export function sendProof (keys, { from, to, id, part, parts, at, sealed, subscription }){
    const point = Buffer.concat([Buffer.from([4]), Buffer.from(from, 'base64')]);
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.setPrivateKey(fromB64u(keys.privateKey));
    const secret = ecdh.computeSecret(point);
    const info = Buffer.concat([Buffer.from('Pals send v1\0'), point, fromB64u(keys.publicKey)]);
    const key = Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.alloc(0), info, 32));
    const endpoint = subscription && subscription.endpoint;
    return hmac(key, Buffer.from(['Pals send', 1, from, to, id, part, parts, at, endpoint, sealed].join('\0'), 'utf8'));
}

/**
 * The push relay for Pals, mounted at /push/api/.
 *
 *   GET  /push/api/config/pub   the VAPID public key, for pushManager.subscribe
 *   POST /push/api/send         push a sealed message to a pal's device
 *
 * Messages are sealed and opened in the browsers (UPDATE_2): what passes
 * through here is opaque, and nothing of it is stored. The VAPID key pair - a
 * row in abcd, made on first use - only proves to the push service that the
 * push comes from this server; it protects no content. Who sent a message is
 * the key the caller's session cookie is signed with - or, once that has
 * expired, the key a send proof is made with - and the seal opens only with
 * that sender's key, so the server cannot name anybody else.
 */
export default class PushApi {
    constructor(db, { render, verifySsid, fetch = (...args) => globalThis.fetch(...args),
                      now = () => Date.now(), log = console.log, providers = PROVIDERS } = {}){
        this.db = db;
        this.render = render;
        this.verifySsid = verifySsid;
        this.fetch = fetch;
        this.now = now;
        this.log = log;
        this.providers = providers;
        this.ready = null;
    }

    /** True for the paths this API owns, so Server can branch on it. */
    static owns (pathname){
        return pathname === '/push/api' || pathname.startsWith('/push/api/');
    }

    /**
     * The VAPID keys: read from the config row, or made and filed there the
     * first time. A failure is not remembered, so a fixed row is picked up on
     * the next request.
     */
    keys (){
        if (!this.ready){
            this.ready = this.loadKeys().catch(err => {
                this.ready = null;
                throw err;
            });
        }
        return this.ready;
    }

    async loadKeys (){
        let row = await this.db.getConfig(CONFIG_PATH);
        if (!row){
            const made = generateKeys();
            try {
                // The public column is a secret nobody is told, so that no
                // ?isGroup= on a search can ever name it.
                await this.db.runSql('INSERT INTO abcd VALUES (?,?,?,?,?,?)', [CONFIG_PATH, 'json',
                    JSON.stringify(made), 0, AUTHOR, crypto.randomBytes(32).toString('base64url')]);
                this.log('push: made the VAPID keys and filed them at ' + CONFIG_PATH);
            } catch (err) {
                // Another request filed them first; theirs are the ones.
            }
            row = await this.db.getConfig(CONFIG_PATH);
        }
        if (!row || row.author !== AUTHOR || row.public === 'public'){
            // Somebody wrote the path before the server did. Their keys would be
            // keys they know the private half of.
            this.log(`push: ${CONFIG_PATH} was not written by the server; not using it`);
            fail(503, 'NotConfigured', 'push is not configured on this node');
        }
        try {
            return readKeys(row.value);
        } catch (err) {
            this.log(`push: ${CONFIG_PATH} is not usable: ${err.message}`);
            fail(503, 'NotConfigured', 'push is not configured on this node');
        }
    }

    async handle (req, res, ssid){
        try {
            const path = new URL(req.url, 'http://x').pathname.replace(/\/+$/, '');
            let data;
            if (req.method === 'GET' && path === '/push/api/config/pub'){
                data = { publicKey: (await this.keys()).publicKey };
            } else if (req.method === 'POST' && path === '/push/api/send'){
                const body = await this.readJson(req);
                data = await this.send(body, body.proof === undefined ? this.session(ssid) : await this.proven(body), req);
            } else {
                fail(404, 'NotFound', 'no such push API route');
            }
            this.render.renderJSON(data, res);
        } catch (err) {
            if (err instanceof PushError){
                this.render.renderJSON({ error: err.code, message: err.message }, res, err.status);
                return;
            }
            this.log('push: unhandled error:', err && err.stack ? err.stack : err);
            this.render.renderJSON({ error: 'ServerError', message: 'the request could not be completed' }, res, 500);
        }
    }

    /** The caller's public key, from a cookie whose signature checks out. */
    session (ssid){
        const checked = ssid ? this.verifySsid(String(ssid)) : null;
        if (!checked || !checked.sValid || !PUB.test(checked.pubB64)){
            fail(401, 'Unauthorized', 'sign in to Northern first');
        }
        return checked.pubB64;
    }

    /**
     * The caller's public key, from a send proof (UPDATE_3): an HMAC over the
     * request, keyed by ECDH between the sender's Northern key and the
     * server's VAPID key. The browser makes it with the key reg/keystore.js
     * keeps - ECDH only, it cannot sign a cookie - so Pals keeps sending after
     * the day-long cookie has expired. Only the holder of `from`'s private key,
     * or the server, can make it. A proof decides on its own: a live cookie
     * does not rescue one that fails.
     */
    async proven (body){
        const { from, at, proof } = body;
        if (typeof from !== 'string' || !PUB.test(from) || typeof proof !== 'string' || !PROOF.test(proof) || !Number.isInteger(at)){
            fail(401, 'Unauthorized', 'the send proof is not one: "from", "at" and "proof" are needed');
        }
        if (Math.abs(this.now() - at) > PROOF_WINDOW){
            fail(401, 'Unauthorized', 'the send proof is out of date; check this device\'s clock');
        }
        const keys = await this.keys();
        let expected;
        try {
            expected = sendProof(keys, body);
        } catch (e) {
            fail(401, 'Unauthorized', 'the send proof does not check out');
        }
        if (!crypto.timingSafeEqual(expected, fromB64u(proof))){
            fail(401, 'Unauthorized', 'the send proof does not check out');
        }
        return from;
    }

    /**
     * The body as JSON. It must say it is JSON: a form on another site can
     * post text/plain with the visitor's cookie attached, but cannot send
     * application/json without a preflight this server never grants.
     */
    readJson (req){
        if (!/^application\/json\b/i.test(req.headers['content-type'] || '')){
            return Promise.reject(new PushError(415, 'UnsupportedMediaType', 'send application/json'));
        }
        const origin = req.headers.origin;
        if (origin && origin !== 'null'){
            let host;
            try {
                host = new URL(origin).host;
            } catch (e) {
                host = '';
            }
            if (host !== req.headers.host){
                return Promise.reject(new PushError(403, 'Forbidden', 'cross-origin requests are not accepted'));
            }
        }
        return new Promise((resolve, reject) => {
            const chunks = [];
            let size = 0;
            // Past the limit the rest is read and dropped, so the answer still
            // reaches the client.
            req.on('data', chunk => {
                size += chunk.length;
                if (size <= MAX_BODY){
                    chunks.push(chunk);
                }
            });
            req.on('end', () => {
                if (size > MAX_BODY){
                    reject(new PushError(413, 'TooLarge', 'the request is larger than ' + MAX_BODY + ' bytes'));
                    return;
                }
                try {
                    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    if (!body || typeof body !== 'object' || Array.isArray(body)){
                        throw new Error('not an object');
                    }
                    resolve(body);
                } catch (e) {
                    reject(new PushError(400, 'BadRequest', 'the body is not a JSON object'));
                }
            });
            req.on('error', reject);
        });
    }

    /**
     * Pushes one sealed message - or one part of one - to the device behind
     * `subscription`: `{to, subscription, provider?, sealed, id, part, parts}`,
     * and `{from, at, proof}` when it comes with a send proof.
     * The push carries `{v, from, to, id, part, parts, sealed}` as JSON text,
     * `from` being the caller's verified key. A browser hands a push payload
     * to its service worker as UTF-8 text and nulls one that is not, so it is
     * text, and plain ASCII.
     */
    async send (body, from, req){
        const to = body.to;
        if (typeof to !== 'string' || !PUB.test(to)){
            fail(400, 'BadRequest', '"to" must be the pal\'s Northern public key');
        }
        const sealed = body.sealed;
        if (typeof sealed !== 'string' || !SEALED.test(sealed)){
            fail(400, 'BadRequest', '"sealed" must be a message sealed in the browser, base64url');
        }
        const subscription = body.subscription;
        const endpoint = subscription && typeof subscription.endpoint === 'string' ? subscription.endpoint : '';
        if (!endpoint || !subscription.keys){
            fail(400, 'BadRequest', '"subscription" must be a push subscription, as PushSubscription.toJSON() gives it');
        }
        const provider = providerOf(endpoint, this.providers);
        if (!provider){
            fail(400, 'BadRequest', 'that endpoint does not belong to a known push service');
        }
        if (body.provider !== undefined && body.provider !== provider){
            fail(400, 'BadRequest', `the endpoint belongs to ${provider}, not ${body.provider}`);
        }
        const { part, parts, id } = body;
        if (!Number.isInteger(parts) || !Number.isInteger(part) || parts < 1 || parts > 100 || part < 1 || part > parts){
            fail(400, 'BadRequest', '"part" and "parts" must be whole numbers, 1 <= part <= parts <= 100');
        }
        if (typeof id !== 'string' || !ID.test(id)){
            fail(400, 'BadRequest', '"id" must be 1 to 40 letters, digits, - or _');
        }

        const keys = await this.keys();
        const ts = this.now();
        const payload = Buffer.from(JSON.stringify({ v: VERSION, from, to, id, part, parts, sealed }), 'ascii');
        if (payload.length > MAX_PAYLOAD){
            fail(413, 'TooLarge', 'that message does not fit in one push; send it in smaller parts');
        }

        const subject = keys.subject || 'https://' + String(req.headers.host || 'localhost').replace(/[^A-Za-z0-9.:-]/g, '');
        let response;
        try {
            response = await this.fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/octet-stream',
                    'Content-Encoding': 'aes128gcm',
                    'TTL': String(TTL),
                    'Urgency': 'high',
                    'Authorization': vapidHeader(endpoint, keys, subject, Math.floor(ts / 1000))
                },
                body: encryptPush(payload, subscription.keys),
                redirect: 'manual',
                signal: AbortSignal.timeout(10000)
            });
        } catch (err) {
            this.log('push: ' + provider + ' is out of reach: ' + err.message);
            fail(502, 'PushFailed', `the ${provider} push service is out of reach`);
        }
        if (response.status === 404 || response.status === 410){
            fail(410, 'Gone', 'the pal\'s device is no longer subscribed; they need to open Pals again');
        }
        if (response.status === 429){
            fail(429, 'TooManyRequests', `the ${provider} push service asks to slow down`);
        }
        if (response.status < 200 || response.status > 299){
            this.log(`push: ${provider} answered ${response.status}`);
            fail(502, 'PushFailed', `the ${provider} push service answered ${response.status}`);
        }
        return { status: 'OK', id, part, parts, ts, provider };
    }
}
