'use strict';

/**
 * What InPerson knows: who can be called, how this device reaches the other
 * one (STUN and TURN), and the signals a call is set up with.
 *
 * No DOM, no storage and no network - `inperson.js` and `welcome.js` are the
 * wiring, `call.js` drives WebRTC, and this is the part that can be tested as
 * data (`tests/inPerson.test.js`). The service worker loads it too.
 *
 * A person is identified by their Northern public key, as `session.pub()`
 * gives it: 64 bytes, x then y, in standard base64 - as in Pals.
 */
const InPersonModel = (function () {

    const api = {};

    api.TAG = 5;
    api.NAME_MAX = 40;
    api.UNKNOWN = 'UNKNOWN';
    api.REG = '/fs/get/reg/Reg.html';
    // Where every device set up for calls is listed: /inperson/<username>/<key>.
    api.DIRECTORY = '/inperson/';
    // Where Pals lists its devices; Pals adds pals from it, and the contacts come from it too.
    api.PALS_DIRECTORY = '/pals/';
    // A call is set up over Northern's /sub/ channel of its own random id.
    api.CHANNEL = '/sub/inperson-';
    // A ring older than this has been missed - the caller has given up by then.
    api.RING_MS = 60 * 1000;
    // How long the caller waits for an answer.
    api.ANSWER_MS = 45 * 1000;
    // How long the one who answered waits for the caller's offer.
    api.OFFER_MS = 20 * 1000;
    // Anybody's STUN server will do to learn this device's public address; Cloudflare's is free.
    api.DEFAULT_STUN = 'stun:stun.cloudflare.com:3478';

    // ---- keys and names --------------------------------------------------

    const STD = /^[A-Za-z0-9+/]{86}==$/;
    const URL_SAFE = /^[A-Za-z0-9_-]{86}$/;

    api.isPub = text => typeof text === 'string' && STD.test(text);
    api.tag = pub => String(pub || '').slice(0, api.TAG);
    api.label = (name, pub) => (name || api.UNKNOWN) + ' (' + api.tag(pub) + ')';

    /** A key as it goes in a path: base64url, as Pals writes it. */
    api.urlKey = pub => String(pub || '').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    api.pubFromUrlKey = key => URL_SAFE.test(key) ? key.replace(/-/g, '+').replace(/_/g, '/') + '==' : '';

    api.cleanName = function (name) {
        return String(name === undefined || name === null ? '' : name)
            .replace(/\s+/g, ' ').trim().slice(0, api.NAME_MAX);
    };

    /** Where a visitor with no session goes, carrying the way back. */
    api.regUrl = (pathname, search, hash) => api.REG + '#' + pathname + (search || '') + (hash || '');

    /** When, as a status line says it: 13:07, local time. */
    api.clock = function (ts) {
        const d = new Date(ts);
        if (isNaN(d.getTime())) {
            return '';
        }
        return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    };

    // ---- the directories ---------------------------------------------------

    /** Who runs which push service - the table Pals and src/h2t/PushApi.js have. */
    const PROVIDERS = {
        google: [/^fcm\.googleapis\.com$/],
        mozilla: [/^updates\.push\.services\.mozilla\.com$/, /^[a-z0-9-]+\.push\.services\.mozilla\.com$/],
        apple: [/^web\.push\.apple\.com$/, /^[a-z0-9-]+\.push\.apple\.com$/],
        microsoft: [/^[a-z0-9-]+\.notify\.windows\.com$/]
    };

    api.providerOf = function (endpoint) {
        const found = /^https:\/\/([a-z0-9.-]+)\//i.exec(String(endpoint || ''));
        if (!found) {
            return '';
        }
        const host = found[1].toLowerCase();
        return Object.keys(PROVIDERS).find(id => PROVIDERS[id].some(re => re.test(host))) || '';
    };

    /** A name as one path segment: no `/`, and no `.`, which Northern reads as a file type. */
    const segment = name => encodeURIComponent(name).replace(/\./g, '%2E');

    api.devicePath = function (name, pub) {
        return api.DIRECTORY + segment(api.cleanName(name) || api.UNKNOWN) + '/' + api.urlKey(pub);
    };

    /** What welcome.html files at `devicePath`: enough to ring this device. The shape of Pals' row. */
    api.deviceRecord = function (me, subscription, ts) {
        const sub = subscription || {};
        const keys = sub.keys || {};
        return {
            pub: me.pub,
            username: api.cleanName(me.name) || api.UNKNOWN,
            provider: api.providerOf(sub.endpoint),
            subscription: { endpoint: String(sub.endpoint || ''), keys: { p256dh: String(keys.p256dh || ''), auth: String(keys.auth || '') } },
            ts: ts
        };
    };

    /**
     * Search rows from `/pals/` or `/inperson/` (`prefix`) as a list of
     * devices, newest per key. A row counts only when the key in its path
     * wrote it - anybody may post under either - and its record names that key.
     */
    api.directory = function (rows, prefix) {
        const row = new RegExp('^' + (prefix || api.DIRECTORY).replace(/\//g, '\\/') + '([^/]+)\\/([A-Za-z0-9_-]{86})$');
        const newest = {};
        (Array.isArray(rows) ? rows : []).forEach(function (r) {
            const path = r && row.exec(r.path);
            const pub = path && api.pubFromUrlKey(path[2]);
            if (!pub || r.author !== pub) {
                return;
            }
            let record;
            try {
                record = JSON.parse(r.value);
            } catch (e) {
                return;
            }
            const sub = record && record.subscription;
            if (!record || record.pub !== pub || !sub || !sub.endpoint || !sub.keys) {
                return;
            }
            const entry = {
                pub: pub,
                name: api.cleanName(record.username) || api.UNKNOWN,
                provider: String(record.provider || ''),
                subscription: { endpoint: String(sub.endpoint), keys: { p256dh: String(sub.keys.p256dh || ''), auth: String(sub.keys.auth || '') } },
                ts: Number(record.ts) || 0
            };
            if (!newest[pub] || entry.ts > newest[pub].ts) {
                newest[pub] = entry;
            }
        });
        return Object.keys(newest).map(k => newest[k]);
    };

    /**
     * The contacts: everybody Pals lists - the list Pals adds pals from - and
     * everybody set up for calls, less the user. `device` is where to ring
     * them, or null when they have not set InPerson up yet. The name is the
     * newest either list has.
     */
    api.contacts = function (palsEntries, callEntries, me) {
        const byPub = {};
        const note = function (entry, device) {
            if (!entry || !api.isPub(entry.pub) || (me && entry.pub === me.pub)) {
                return;
            }
            const known = byPub[entry.pub];
            if (!known) {
                byPub[entry.pub] = { pub: entry.pub, name: entry.name, ts: entry.ts, device: device ? entry : null };
                return;
            }
            if (entry.ts > known.ts) {
                known.name = entry.name;
                known.ts = entry.ts;
            }
            if (device) {
                known.device = entry;
            }
        };
        (palsEntries || []).forEach(e => note(e, false));
        (callEntries || []).forEach(e => note(e, true));
        return Object.keys(byPub).map(k => byPub[k])
            .sort((a, b) => a.name.localeCompare(b.name) || a.pub.localeCompare(b.pub));
    };

    /** What a contact is called, from the list the page keeps for the service worker. */
    api.nameOf = function (contacts, pub) {
        const found = (contacts || []).find(c => c && c.pub === pub);
        return found ? found.name : '';
    };

    // ---- reaching the other device: STUN and TURN ----------------------------

    /**
     * How this device looks for a way to the other one (welcome.html):
     *
     *   stun       a STUN server only: enough when either side can be reached
     *              directly - most home networks, not every mobile one
     *   turn       a TURN server of the user's own - coturn with a fixed user
     *              name and password (lt-cred-mech) - plus STUN
     *   northern   Northern hands out TURN credentials that expire
     *              (/turn/api/ice): coturn's REST secret or Cloudflare's TURN
     *              service, configured on the server - plus STUN
     *
     * `relayOnly` sends everything through TURN, to try the TURN server out.
     */
    api.MODES = ['stun', 'turn', 'northern'];

    api.defaultConfig = function () {
        return { mode: 'stun', stun: api.DEFAULT_STUN, turnUrls: '', username: '', credential: '', relayOnly: false };
    };

    const ICE_URL = /^(stun|stuns|turn|turns):[^\s,]+$/;
    const urls = text => String(text || '').split(/[\s,]+/).filter(Boolean);

    /** What the form holds, checked. Throws what is wrong, in words for the user. */
    api.cleanConfig = function (input) {
        const i = input || {};
        const mode = api.MODES.indexOf(i.mode) === -1 ? 'stun' : i.mode;
        const stun = urls(i.stun);
        const turn = urls(i.turnUrls);
        if (!stun.every(u => /^stuns?:/.test(u) && ICE_URL.test(u))) {
            throw new Error('a STUN server is written stun:host:port, like ' + api.DEFAULT_STUN);
        }
        if (mode === 'turn') {
            if (!turn.length || !turn.every(u => /^turns?:/.test(u) && ICE_URL.test(u))) {
                throw new Error('a TURN server is written turn:host:3478 or turns:host:5349');
            }
            if (!String(i.username || '') || !String(i.credential || '')) {
                throw new Error('a TURN server needs the user name and password set on it');
            }
        }
        if (i.relayOnly && mode === 'stun') {
            throw new Error('only through TURN needs a TURN server');
        }
        return {
            mode: mode,
            stun: stun.join(', '),
            turnUrls: mode === 'turn' ? turn.join(', ') : '',
            username: mode === 'turn' ? String(i.username) : '',
            credential: mode === 'turn' ? String(i.credential) : '',
            relayOnly: !!i.relayOnly
        };
    };

    /** A stored configuration read back, or the default one. */
    api.loadConfig = function (stored) {
        try {
            return stored ? api.cleanConfig(stored) : api.defaultConfig();
        } catch (e) {
            return api.defaultConfig();
        }
    };

    /**
     * The RTCConfiguration for a call. `fromNorthern` is what /turn/api/ice
     * answered, for the `northern` mode.
     */
    api.rtcConfig = function (config, fromNorthern) {
        const c = config || api.defaultConfig();
        const servers = [];
        const stun = urls(c.stun);
        if (stun.length) {
            servers.push({ urls: stun });
        }
        if (c.mode === 'turn') {
            servers.push({ urls: urls(c.turnUrls), username: c.username, credential: c.credential });
        }
        if (c.mode === 'northern') {
            ((fromNorthern && fromNorthern.iceServers) || []).forEach(function (s) {
                const list = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter(u => typeof u === 'string' && ICE_URL.test(u));
                if (list.length) {
                    servers.push(s.username ? { urls: list, username: String(s.username), credential: String(s.credential || '') } : { urls: list });
                }
            });
        }
        return { iceServers: servers, iceTransportPolicy: c.relayOnly ? 'relay' : 'all' };
    };

    /**
     * What a check of the configuration found, from the candidates the
     * browser gathered: `host` (this device), `srflx` (its public address, from
     * STUN) and `relay` (an address on the TURN server).
     */
    api.candidateTypes = function (candidates) {
        const found = { host: 0, srflx: 0, prflx: 0, relay: 0 };
        (candidates || []).forEach(function (c) {
            const type = / typ (host|srflx|prflx|relay)\b/.exec(String(c || ''));
            if (type) {
                found[type[1]] += 1;
            }
        });
        return found;
    };

    /** The same, in words. */
    api.checkReport = function (config, found) {
        const lines = [];
        const c = config || api.defaultConfig();
        if (found.relay) {
            lines.push('TURN works: calls can always get through, relayed if they must.');
        } else if (c.mode !== 'stun') {
            lines.push('TURN did not answer: check its address, the user name and password, and that its ports are open.');
        }
        if (found.srflx) {
            lines.push('STUN works: this device knows its public address.');
        } else if (!c.relayOnly && urls(c.stun).length) {
            lines.push('STUN did not answer: this network may block it.');
        }
        if (!found.srflx && !found.relay) {
            lines.push(c.relayOnly ? '' : found.host ? 'Only this network\'s own addresses were found: a call reaches only a device on the same network.' : 'Nothing was found: this browser may not allow WebRTC here.');
        }
        return lines.filter(Boolean).join(' ');
    };

    // ---- the signals a call is set up with -----------------------------------
    //
    // Each is sealed end to end with PalsSeal (../pals/seal.js), from the
    // caller's Northern key to the other one's, so Northern relays them and
    // can neither read nor change them. The ring and a cancel go as a push;
    // the rest over the call's /sub/ channel.
    //
    //   ring      caller -> callee (push)     somebody is calling
    //   cancel    caller -> callee (push)     they gave up: the call was missed
    //   ready     callee -> caller            answered, and listening on the channel
    //   decline   callee -> caller            not now (or busy)
    //   offer     caller -> callee            the caller's SDP
    //   answer    callee -> caller            the callee's SDP
    //   ice       both                        one ICE candidate
    //   bye       both                        hung up

    api.KINDS = ['ring', 'cancel', 'ready', 'decline', 'offer', 'answer', 'ice', 'bye'];
    const CALL_ID = /^[A-Za-z0-9_-]{22}$/;
    const SDP_MAX = 64 * 1024;

    api.isCallId = id => typeof id === 'string' && CALL_ID.test(id);

    /** Where a call's signals go: Northern's /sub/ channel of the call's id. */
    api.channel = call => api.CHANNEL + call;

    /** The call a notification opens the page on: #call=<id>. */
    api.callFromHash = function (hash) {
        const found = /^#call=([A-Za-z0-9_-]{22})$/.exec(String(hash || ''));
        return found ? found[1] : '';
    };

    /** A signal, as the text that is sealed. */
    api.signal = function (t, call, ts, extra) {
        if (api.KINDS.indexOf(t) === -1 || !api.isCallId(call)) {
            throw new Error('not a signal');
        }
        return JSON.stringify(Object.assign({ t: t, call: call, ts: ts }, extra || {}));
    };

    /**
     * An opened text read back as a signal - for `call`, when given - or
     * null when it is not one. Nothing in it is taken on trust: it is checked
     * before WebRTC sees it.
     */
    api.readSignal = function (text, call) {
        let s;
        try {
            s = JSON.parse(String(text || ''));
        } catch (e) {
            return null;
        }
        if (!s || typeof s !== 'object' || api.KINDS.indexOf(s.t) === -1 || !api.isCallId(s.call) ||
            (call && s.call !== call) || !Number.isFinite(s.ts)) {
            return null;
        }
        const out = { t: s.t, call: s.call, ts: s.ts };
        if (s.t === 'offer' || s.t === 'answer') {
            if (typeof s.sdp !== 'string' || !s.sdp || s.sdp.length > SDP_MAX) {
                return null;
            }
            out.sdp = s.sdp;
        }
        if (s.t === 'ice') {
            const c = s.candidate;
            if (!c || typeof c !== 'object' || typeof c.candidate !== 'string' || c.candidate.length > 2048) {
                return null;
            }
            out.candidate = { candidate: c.candidate };
            if (typeof c.sdpMid === 'string') {
                out.candidate.sdpMid = c.sdpMid;
            }
            if (Number.isInteger(c.sdpMLineIndex)) {
                out.candidate.sdpMLineIndex = c.sdpMLineIndex;
            }
        }
        if (s.t === 'decline' && s.busy === true) {
            out.busy = true;
        }
        return out;
    };

    /**
     * What came by push, sorted out: the call ringing now - the newest ring
     * still fresh, neither cancelled nor already seen - and the calls missed.
     * `signals` are `{from, signal}`; `seen` the call ids already dealt with.
     */
    api.incoming = function (signals, now, seen) {
        const done = seen || [];
        const cancelled = {};
        (signals || []).forEach(s => { if (s.signal.t === 'cancel') cancelled[s.signal.call] = true; });
        const rings = {};
        (signals || []).forEach(function (s) {
            if (s.signal.t === 'ring' && done.indexOf(s.signal.call) === -1 && !rings[s.signal.call]) {
                rings[s.signal.call] = { from: s.from, call: s.signal.call, ts: s.signal.ts };
            }
        });
        const fresh = r => now - r.ts < api.RING_MS && r.ts - now < api.RING_MS;
        const all = Object.keys(rings).map(k => rings[k]).sort((a, b) => b.ts - a.ts);
        const ringing = all.find(r => fresh(r) && !cancelled[r.call]) || null;
        return { ringing: ringing, missed: all.filter(r => r !== ringing).sort((a, b) => a.ts - b.ts) };
    };

    return api;
})();
