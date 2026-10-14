'use strict';

/**
 * Video calls between two pals: how this device reaches the other one (STUN
 * and TURN), and the signals a call is set up with. Brought over from
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

    /** How a call stands, as the call layer says it - plain text, never markup. */
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
