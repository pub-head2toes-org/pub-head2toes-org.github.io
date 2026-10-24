'use strict';

/**
 * Video calls among pals - two, or up to four in a mesh (UPDATE_10): how this
 * device reaches the others (STUN and TURN), the signals a call is set up
 * with, and how much video each connection sends. Brought over from
 * InPerson (../inPerson/PLAN.md, "Porting calls to Pals"), where it was tried
 * live first.
 *
 * No DOM, no storage and no network - `pals.js` is the wiring, `call.js`
 * drives WebRTC, and this is the part that can be tested as data
 * (`tests/palsCalls.test.js`). The service worker loads it too.
 */
const PalsCalls = (function () {

    const api = {};

    // A call is set up over Northern's /sub/ channel of its own random id.
    api.CHANNEL = '/sub/pals-call-';
    // A ring older than this has been missed - the caller has given up by then.
    api.RING_MS = 60 * 1000;
    // How long the caller waits for an answer.
    api.ANSWER_MS = 45 * 1000;
    // How long the one who answered waits for the caller's offer.
    api.OFFER_MS = 20 * 1000;
    // Anybody's STUN server will do to learn this device's public address; Cloudflare's is free.
    api.DEFAULT_STUN = 'stun:stun.cloudflare.com:3478';
    // What a Pals too old to know calls files in place of a ring, and of a cancelled one.
    api.RING_TEXT = 'Video call - this Pals needs updating to answer it: reload it.';
    api.MISSED_TEXT = 'Missed video call';
    // A call has four people at most: whoever rang, and three more (UPDATE_10).
    api.MAX = 4;

    // ---- reaching the other device: STUN and TURN ----------------------------
    //
    // Nothing to set: a call takes TURN credentials that expire from Northern
    // (/turn/api/ice - coturn's REST secret or Cloudflare's TURN service, set
    // up on the server) and Cloudflare's STUN server. TURN is the fallback
    // when the two devices cannot reach each other; a call goes direct when
    // they can.

    const ICE_URL = /^(stun|stuns|turn|turns):[^\s,]+$/;

    /**
     * The RTCConfiguration for a call: STUN, and the servers /turn/api/ice
     * answered - none when Northern gave none, and the call tries without.
     */
    api.rtcConfig = function (fromNorthern) {
        const servers = [{ urls: [api.DEFAULT_STUN] }];
        ((fromNorthern && fromNorthern.iceServers) || []).forEach(function (s) {
            const list = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter(u => typeof u === 'string' && ICE_URL.test(u));
            if (list.length) {
                servers.push(s.username ? { urls: list, username: String(s.username), credential: String(s.credential || '') } : { urls: list });
            }
        });
        return { iceServers: servers, iceTransportPolicy: 'all' };
    };

    /** Whether this device takes part in calls, as Settings keeps it: off until switched on. */
    api.enabled = stored => !!(stored && stored.enabled === true);

    // ---- the signals a call is set up with -----------------------------------
    //
    // Each is sealed end to end with PalsSeal (seal.js) as a message is,
    // from the caller's key to the pal's pinned one, so Northern relays them
    // and can neither read nor change them. The signal travels as the seal's
    // `signal`, never as the text of a message. The ring and a cancel go as a
    // push, to the pal's /pals/ device; the rest over the call's /sub/ channel.
    //
    //   ring      caller -> callee (push)     somebody is calling - and who else is in the call
    //   cancel    caller -> callee (push)     they gave up: the call was missed
    //   ready     callee -> caller            answered, and listening on the channel
    //                                         (in a call of more, to everybody in it)
    //   decline   callee -> caller            not now (or busy)
    //   offer     caller -> callee            the caller's SDP
    //   answer    callee -> caller            the callee's SDP
    //   ice       both                        one ICE candidate
    //   bye       both                        hung up

    api.KINDS = ['ring', 'cancel', 'ready', 'decline', 'offer', 'answer', 'ice', 'bye'];
    const CALL_ID = /^[A-Za-z0-9_-]{22}$/;
    const SDP_MAX = 64 * 1024;
    // A Northern key, as PalsModel.isPub takes it: 64 bytes of base64.
    const PUB = /^[A-Za-z0-9+/]{86}==$/;
    const NAME_MAX = 64;

    api.isCallId = id => typeof id === 'string' && CALL_ID.test(id);

    /**
     * Who else a ring says is in the call, besides the one ringing and the
     * one rung: `[{pub, name}]`, two at most - or null when it is not that.
     * The names are what the caller calls them; a pal is shown by the name
     * given here.
     */
    function readWith(list) {
        if (!Array.isArray(list) || list.length > api.MAX - 2) {
            return null;
        }
        const out = [];
        for (const w of list) {
            if (!w || typeof w !== 'object' || typeof w.pub !== 'string' || !PUB.test(w.pub) ||
                typeof w.name !== 'string' || out.some(o => o.pub === w.pub)) {
                return null;
            }
            out.push({ pub: w.pub, name: w.name.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX) });
        }
        return out;
    }

    /** Where a call's signals go: Northern's /sub/ channel of the call's id. */
    api.channel = call => api.CHANNEL + call;

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
        if (s.t === 'ring' && s.with !== undefined) {
            const others = readWith(s.with);
            if (!others) {
                return null;
            }
            if (others.length) {
                out.with = others;
            }
        }
        if (s.t === 'ring' && typeof s.group === 'string' && s.group.trim()) {
            out.group = s.group.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
        }
        return out;
    };

    /** How a call stands, as the call layer says it - plain text, never markup. `name` may be several, joined. */
    api.stateText = function (state, name) {
        return {
            calling: 'Calling ' + name + '…',
            ringing: 'Ringing ' + name + '…',
            connecting: 'Connecting to ' + name + '…',
            connected: 'In a call with ' + name,
            reconnecting: 'The line to ' + name + ' dropped - reconnecting…'
        }[state] || '';
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
                rings[s.signal.call] = { from: s.from, call: s.signal.call, ts: s.signal.ts,
                                         with: s.signal.with || [], group: s.signal.group || '' };
            }
        });
        const fresh = r => now - r.ts < api.RING_MS && r.ts - now < api.RING_MS;
        const all = Object.keys(rings).map(k => rings[k]).sort((a, b) => b.ts - a.ts);
        const ringing = all.find(r => fresh(r) && !cancelled[r.call]) || null;
        return { ringing: ringing, missed: all.filter(r => r !== ringing).sort((a, b) => a.ts - b.ts) };
    };

    /** Names as a call says them: "bob", "bob and carol", "bob, carol and dave". */
    api.names = function (list) {
        return list.length < 2 ? (list[0] || '') : list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
    };

    // ---- how much video a connection sends (UPDATE_10) -----------------------
    //
    // The camera is asked for 720p once; each connection then sends its own
    // size, set on its sender while the call goes on - no new offer. A browser
    // encodes for every connection on its own, so in a call of four a phone
    // encodes three times: smaller is what makes it possible. A tile in the
    // 2x2 grid is about 185 x 330 CSS pixels, which 360p fills.

    api.CAMERA = { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } };

    const SIZES = {
        two: { side: 720, maxBitrate: 1500000, maxFramerate: 30 },
        grid: { side: 360, maxBitrate: 500000, maxFramerate: 24 },
        large: { side: 720, maxBitrate: 1200000, maxFramerate: 30 },
        small: { side: 180, maxBitrate: 150000, maxFramerate: 15 }
    };

    /**
     * What one connection sends, as an RTCRtpEncodingParameters: for a call
     * of `count` people, to somebody who shows this device `size` - 'grid',
     * or 'large' or 'small' once they have made somebody large. `shortSide`
     * is the camera's, in pixels; it is scaled down, never up.
     */
    api.videoFor = function (count, size, shortSide) {
        const s = count <= 2 ? SIZES.two : SIZES[size] || SIZES.grid;
        const side = Number(shortSide) > 0 ? Number(shortSide) : 720;
        return {
            maxBitrate: s.maxBitrate,
            maxFramerate: s.maxFramerate,
            scaleResolutionDownBy: Math.max(1, Math.round(side / s.side * 100) / 100)
        };
    };

    return api;
})();
