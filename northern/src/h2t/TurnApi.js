'use strict';

import crypto from 'node:crypto';

// A Northern public key: 64 bytes, x then y, in standard base64.
const PUB = /^[A-Za-z0-9+/]{86}==$/;
// A STUN or TURN address as RTCPeerConnection takes it.
const ICE_URL = /^(stun|stuns|turn|turns):[^\s,]+$/;
// How long credentials last unless NORTHERN_TURN_TTL says otherwise: longer
// than any call, as Cloudflare advises.
export const DEFAULT_TTL = 12 * 3600;
// How many times a minute one user may ask, unless NORTHERN_TURN_RATE says
// otherwise. A call asks once at each end, so this is a few calls a minute -
// and not a script running up a relay bill that is paid by the gigabyte.
export const DEFAULT_RATE = 6;
const MINUTE = 60 * 1000;
const CLOUDFLARE = 'https://rtc.live.cloudflare.com/v1/turn/keys/';

export class TurnError extends Error {
    constructor(status, code, message, retryAfter){
        super(message);
        this.status = status;
        this.code = code;
        this.retryAfter = retryAfter;
    }
}
const fail = (status, code, message) => { throw new TurnError(status, code, message); };
const fail429 = wait => { throw new TurnError(429, 'TooManyRequests', `too many requests for TURN credentials; try again in ${wait} s`, wait); };

const list = text => String(text || '').split(/[\s,]+/).filter(Boolean);

/**
 * Where TURN credentials come from, as the environment says:
 *
 *   NORTHERN_TURN=coturn       NORTHERN_TURN_URLS     turn:/turns: addresses, comma separated
 *                              NORTHERN_TURN_SECRET   coturn's static-auth-secret
 *                              NORTHERN_TURN_STUN     stun: addresses (optional)
 *   NORTHERN_TURN=cloudflare   NORTHERN_TURN_KEY_ID   the TURN key's id
 *                              NORTHERN_TURN_KEY_TOKEN  its API token
 *   NORTHERN_TURN_TTL          seconds a credential lasts (both; default 12 hours)
 *   NORTHERN_TURN_RATE         requests a user may make a minute (both; default 6)
 *
 * The secrets stay on the server: a browser only ever gets credentials that
 * expire. Null when nothing is configured; throws what is wrong otherwise.
 */
export function configFrom (env = {}){
    const kind = String(env.NORTHERN_TURN || '').trim().toLowerCase();
    if (!kind){
        return null;
    }
    const ttl = env.NORTHERN_TURN_TTL === undefined ? DEFAULT_TTL : Number(env.NORTHERN_TURN_TTL);
    if (!Number.isInteger(ttl) || ttl < 60 || ttl > 7 * 24 * 3600){
        throw new Error('NORTHERN_TURN_TTL must be whole seconds, 60 to a week');
    }
    const rate = env.NORTHERN_TURN_RATE === undefined ? DEFAULT_RATE : Number(env.NORTHERN_TURN_RATE);
    if (!Number.isInteger(rate) || rate < 1 || rate > 600){
        throw new Error('NORTHERN_TURN_RATE must be a whole number of requests a minute, 1 to 600');
    }
    if (kind === 'coturn'){
        const urls = list(env.NORTHERN_TURN_URLS);
        const stun = list(env.NORTHERN_TURN_STUN);
        if (!urls.length || !urls.every(u => /^turns?:/.test(u) && ICE_URL.test(u))){
            throw new Error('NORTHERN_TURN_URLS must be turn: or turns: addresses, comma separated');
        }
        if (!stun.every(u => /^stuns?:/.test(u) && ICE_URL.test(u))){
            throw new Error('NORTHERN_TURN_STUN must be stun: addresses, comma separated');
        }
        if (String(env.NORTHERN_TURN_SECRET || '').length < 16){
            throw new Error('NORTHERN_TURN_SECRET must be coturn\'s static-auth-secret, 16 characters at least');
        }
        return { kind, urls, stun, secret: String(env.NORTHERN_TURN_SECRET), ttl, rate };
    }
    if (kind === 'cloudflare'){
        const keyId = String(env.NORTHERN_TURN_KEY_ID || '');
        const token = String(env.NORTHERN_TURN_KEY_TOKEN || '');
        if (!/^[A-Za-z0-9_-]{8,128}$/.test(keyId) || !token){
            throw new Error('NORTHERN_TURN_KEY_ID and NORTHERN_TURN_KEY_TOKEN must be the TURN key\'s id and API token');
        }
        return { kind, keyId, token, ttl, rate };
    }
    throw new Error('NORTHERN_TURN must be coturn or cloudflare');
}

/**
 * coturn's TURN REST API credentials (`use-auth-secret`): the user name is
 * the time they expire, in seconds, a colon and who they are for; the
 * password is HMAC-SHA1 of the user name under the shared secret, in base64.
 * coturn makes the same from the secret, so it stores nothing per user.
 */
export function coturnCredentials (secret, user, expires){
    const username = expires + ':' + user;
    return { username, credential: crypto.createHmac('sha1', secret).update(username).digest('base64') };
}

/**
 * Cloudflare's answer, made safe to hand on: only stun:/turn: addresses, and
 * none on port 53, which browsers block - a TURN address there only times out.
 */
export function cleanIceServers (servers){
    if (!Array.isArray(servers)){
        return [];
    }
    return servers.map(server => {
        const urls = (Array.isArray(server && server.urls) ? server.urls : [server && server.urls])
            .filter(u => typeof u === 'string' && ICE_URL.test(u) && !/:53(\?|$)/.test(u));
        const clean = { urls };
        if (typeof server.username === 'string' && typeof server.credential === 'string'){
            clean.username = server.username;
            clean.credential = server.credential;
        }
        return clean;
    }).filter(server => server.urls.length);
}

/**
 * TURN credentials for video calls - Pals' and InPerson's - mounted at /turn/api/.
 *
 *   GET /turn/api/ice   `{iceServers, ttl, provider}`, ready for
 *                       `new RTCPeerConnection({iceServers})`
 *
 * Only for a signed-in user: a TURN server relays whatever it is given, so
 * credentials handed to anybody would make it everybody's relay. The relay
 * only ever sees the call encrypted (DTLS-SRTP), whichever provider it is.
 *
 * And only so often: NORTHERN_TURN_RATE requests a minute per user, counted
 * in this process's memory - Northern runs one (Cluster.js). Past it, 429
 * with Retry-After; the page then tries the call without TURN.
 */
export default class TurnApi {
    constructor({ render, verifySsid, env = process.env, fetch = (...args) => globalThis.fetch(...args),
                  now = () => Date.now(), log = console.log } = {}){
        this.render = render;
        this.verifySsid = verifySsid;
        this.env = env;
        this.fetch = fetch;
        this.now = now;
        this.log = log;
        // When each user asked, over the last minute: key -> times, oldest first.
        this.asked = new Map();
        // When each user refused was last logged: once a minute each, not once a request.
        this.warned = new Map();
        this.swept = 0;
    }

    /** True for the paths this API owns, so Server can branch on it. */
    static owns (pathname){
        return pathname === '/turn/api' || pathname.startsWith('/turn/api/');
    }

    async handle (req, res, ssid){
        try {
            const path = new URL(req.url, 'http://x').pathname.replace(/\/+$/, '');
            if (req.method !== 'GET' || path !== '/turn/api/ice'){
                fail(404, 'NotFound', 'no such TURN API route');
            }
            const data = await this.ice(this.session(ssid));
            res.setHeader('Cache-Control', 'no-store');
            this.render.renderJSON(data, res);
        } catch (err) {
            if (err instanceof TurnError){
                if (err.retryAfter){
                    res.setHeader('Retry-After', String(err.retryAfter));
                }
                this.render.renderJSON({ error: err.code, message: err.message }, res, err.status);
                return;
            }
            this.log('turn: unhandled error:', err && err.stack ? err.stack : err);
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
     * At most `rate` requests in any minute for one user. Whoever has not
     * asked for a minute is forgotten, so the map holds only the users of the
     * last minute.
     */
    limit (pub, rate){
        const now = this.now();
        if (now - this.swept >= MINUTE){
            this.swept = now;
            for (const [key, times] of this.asked){
                if (now - times[times.length - 1] >= MINUTE){
                    this.asked.delete(key);
                }
            }
            for (const [key, at] of this.warned){
                if (now - at >= MINUTE){
                    this.warned.delete(key);
                }
            }
        }
        const recent = (this.asked.get(pub) || []).filter(t => now - t < MINUTE);
        if (recent.length >= rate){
            this.asked.set(pub, recent);
            const wait = Math.max(1, Math.ceil((recent[0] + MINUTE - now) / 1000));
            if (!(now - (this.warned.get(pub) || -Infinity) < MINUTE)){
                this.warned.set(pub, now);
                this.log('turn: ' + pub.slice(0, 12) + ' asked more than ' + rate + ' times in a minute; refusing for ' + wait + ' s');
            }
            fail429(wait);
        }
        recent.push(now);
        this.asked.set(pub, recent);
    }

    /** The configuration, read afresh so a fixed environment needs no new code - only a restart. */
    config (){
        try {
            return configFrom(this.env);
        } catch (err) {
            this.log('turn: ' + err.message);
            fail(503, 'NotConfigured', 'TURN is not configured right on this node');
        }
    }

    async ice (pub){
        const config = this.config();
        if (!config){
            fail(503, 'NotConfigured', 'this node gives no TURN credentials; set a STUN or TURN server on the device instead');
        }
        this.limit(pub, config.rate);
        if (config.kind === 'coturn'){
            // Who the credentials are for, as coturn logs it: the head of the key, never all of it.
            const user = pub.slice(0, 12).replace(/\+/g, '-').replace(/\//g, '_');
            const expires = Math.floor(this.now() / 1000) + config.ttl;
            const servers = [{ urls: config.urls, ...coturnCredentials(config.secret, user, expires) }];
            if (config.stun.length){
                servers.unshift({ urls: config.stun });
            }
            return { iceServers: servers, ttl: config.ttl, provider: 'coturn' };
        }
        let response;
        try {
            response = await this.fetch(CLOUDFLARE + config.keyId + '/credentials/generate-ice-servers', {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + config.token, 'Content-Type': 'application/json' },
                body: JSON.stringify({ ttl: config.ttl }),
                redirect: 'manual',
                signal: AbortSignal.timeout(10000)
            });
        } catch (err) {
            this.log('turn: Cloudflare is out of reach: ' + err.message);
            fail(502, 'TurnFailed', 'Cloudflare\'s TURN service is out of reach');
        }
        if (response.status !== 200 && response.status !== 201){
            this.log('turn: Cloudflare answered ' + response.status);
            fail(502, 'TurnFailed', 'Cloudflare\'s TURN service answered ' + response.status);
        }
        let body;
        try {
            body = await response.json();
        } catch (err) {
            body = null;
        }
        const servers = cleanIceServers(body && body.iceServers);
        if (!servers.some(s => s.username)){
            fail(502, 'TurnFailed', 'Cloudflare\'s TURN service gave no credentials');
        }
        return { iceServers: servers, ttl: config.ttl, provider: 'cloudflare' };
    }
}
